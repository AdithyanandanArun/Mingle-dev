import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { openDatabase } from '../db.ts';
import { Store } from '../store.ts';
import { WorkspaceService } from '../workspace.ts';
import { ProviderService } from '../provider-service.ts';
import { FakeProviders, makeRepo, runGit } from '../test-utils.ts';
import { normalizeRepositoryUrl, ProjectCollaborationService } from './service.ts';

const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const TEAM = '20000000-0000-4000-8000-000000000001';
const SHARED_PROJECT = '30000000-0000-4000-8000-000000000001';
const DEVICE = '40000000-0000-4000-8000-000000000001';
const FINGERPRINT = `SHA-256:${'a'.repeat(64)}`;
const TOKENS = { first: 'a'.repeat(43), second: 'b'.repeat(43) };
const INVITATIONS = {
  first: '50000000-0000-4000-8000-000000000001',
  second: '50000000-0000-4000-8000-000000000002',
};

it('canonicalizes supported GitHub SSH remotes without losing repository path case', () => {
  const https = normalizeRepositoryUrl('https://GITHUB.com/Owner/Repo.git');
  assert.deepEqual(normalizeRepositoryUrl('git@github.com:Owner/Repo.git'), https);
  assert.deepEqual(normalizeRepositoryUrl('ssh://git@github.com/Owner/Repo.git'), https);
  assert.notEqual(
    normalizeRepositoryUrl('https://git.example.test/Owner/Repo.git').identity,
    normalizeRepositoryUrl('https://git.example.test/owner/Repo.git').identity,
    'case-sensitive repository paths cannot be mistaken for another checkout',
  );
  assert.throws(() => normalizeRepositoryUrl('git@gitlab.example.test:Owner/Repo.git'));
  assert.throws(() => normalizeRepositoryUrl('https://user:secret@example.test/Owner/Repo.git'));
});

it('serializes matching joins, resumes after roster failure without duplicate sessions, and preserves other published agents', async () => {
  const repo = makeRepo();
  runGit(repo, 'remote', 'add', 'origin', 'https://github.com/example/project.git');
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'mingle-collaboration-data-'));
  const store = new Store(openDatabase(':memory:'));
  const project = store.insertProject({ name: 'Shared project', path: repo });
  store.updateSettings({ defaultIsolated: false });
  const fakeProviders = new FakeProviders();
  const providers = new ProviderService(fakeProviders, () => store.getSettings(), () => undefined);
  const workspace = new WorkspaceService(store, dataDir, { isActive: () => false }, () => providers.cached());
  const preexistingSession = await workspace.createSession({ projectId: project.id, name: 'Existing published agent',
    provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: false });
  const privateSession = await workspace.createSession({ projectId: project.id, name: 'Private local session',
    provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: false });
  const user = {
    id: ACCOUNT, email: 'invitee@example.test', email_confirmed_at: new Date().toISOString(),
    user_metadata: { full_name: 'Invitee' }, identities: [{ provider: 'google' }], is_anonymous: false,
  } as unknown as User;
  const bindings: Array<{ teamId: string; sharedProjectId: string; localProjectId: string; ownerId: string; deviceId: string }> = [];
  const published = new Map<string, { id: string; name: string; ownerId: string; deviceId: string; sessionId: string; sharedProjectId: string }>();
  published.set(preexistingSession.id, { id: `agent-${preexistingSession.id}`, name: preexistingSession.name, ownerId: ACCOUNT,
    deviceId: DEVICE, sessionId: preexistingSession.id, sharedProjectId: SHARED_PROJECT });
  const accepted = new Set<string>();
  let failNextPublish = true;
  let createCount = 0;
  const client = {
    async rpc(name: string, args: Record<string, string>) {
      if (name === 'preview_mingle_project_invitation' || name === 'accept_mingle_project_invitation') {
        const tokenHash = args.p_token_hash!;
        const kind = createHash('sha256').update(TOKENS.first).digest('hex') === tokenHash ? 'first' : 'second';
        const alreadyAccepted = accepted.has(kind);
        if (name === 'accept_mingle_project_invitation') accepted.add(kind);
        return { data: {
          invitation_id: INVITATIONS[kind], team_id: TEAM, shared_project_id: SHARED_PROJECT,
          project_name: 'Shared project', repository_url: 'https://github.com/example/project.git',
          email: 'invitee@example.test', role: 'member', expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          already_accepted: name === 'accept_mingle_project_invitation' && alreadyAccepted,
        }, error: null };
      }
      if (name === 'complete_mingle_project_invitation_enrollment') return { data: true, error: null };
      return { data: null, error: { code: 'PGRST202' } };
    },
  } as unknown as SupabaseClient;
  const tableRows: Record<string, { single: unknown; rows: unknown }> = {
    mingle_projects: { single: { id: SHARED_PROJECT, team_id: TEAM, name: 'Shared project', repository_url: 'https://github.com/example/project.git' },
      rows: [{ id: SHARED_PROJECT, team_id: TEAM, name: 'Shared project', repository_url: 'https://github.com/example/project.git' }] },
    mingle_members: { single: { role: 'member' }, rows: [{ team_id: TEAM, user_id: ACCOUNT, role: 'member', created_at: new Date().toISOString() }] },
    mingle_project_member_profiles: { single: null, rows: [{ team_id: TEAM, user_id: ACCOUNT, email: 'invitee@example.test', display_name: 'Invitee' }] },
    mingle_project_invitations: { single: null, rows: [] },
  };
  (client as unknown as { from: (table: string) => unknown }).from = (table) => {
    const values = tableRows[table] ?? { single: null, rows: [] };
    const builder: Record<string, unknown> = {
      select: () => builder, eq: () => builder, is: () => builder, order: () => builder, limit: () => builder,
      maybeSingle: async () => ({ data: values.single, error: null }),
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve({ data: values.rows, error: null }).then(resolve, reject),
    };
    return builder;
  };
  const account = {
    withAuthenticatedClient: async <T>(callback: (client: SupabaseClient, user: User) => Promise<T>) => callback(client, user),
  };
  const distributed = {
    teams: { withClient: async <T>(callback: (client: SupabaseClient, user: User) => Promise<T>) => callback(client, user) },
    transport: {
      register: async () => ({ id: DEVICE, fingerprint: FINGERPRINT }),
      snapshot: () => ({ deviceId: DEVICE, devices: [], links: [], outbox: [], status: 'ready', error: null }),
      sync: async () => undefined,
    },
    bindProject: async ({ teamId, sharedProjectId, localProjectId }: { teamId: string; sharedProjectId: string; localProjectId: string }) => {
      if (!bindings.some((row) => row.teamId === teamId && row.sharedProjectId === sharedProjectId && row.deviceId === DEVICE)) {
        bindings.push({ teamId, sharedProjectId, localProjectId, ownerId: ACCOUNT, deviceId: DEVICE });
      }
    },
    execution: {
      snapshot: async () => ({
        bindings: structuredClone(bindings),
        agents: [...published.values()].map((row) => ({ ...row, presence: 'idle' })),
      }),
      publishAgents: async ({ teamId, sharedProjectId, sessionIds }: { teamId: string; sharedProjectId: string; sessionIds: string[] }) => {
        createCount++;
        if (failNextPublish) { failNextPublish = false; throw new Error('Injected remote roster write failure'); }
        published.clear();
        for (const sessionId of sessionIds) published.set(sessionId, {
          id: `agent-${sessionId}`, name: store.getSession(sessionId)?.name ?? 'Agent',
          ownerId: ACCOUNT, deviceId: DEVICE, sessionId, sharedProjectId,
        });
        return [];
      },
    },
  };
  const service = new ProjectCollaborationService({
    store, account: account as never, distributed: distributed as never, workspace, providers,
    emailSender: { status: async () => ({ configured: false, message: 'Sender not configured in fixture.' }),
      send: async () => ({ status: 'not_configured', message: 'test' }) },
  });
  try {
    const firstInput = { token: TOKENS.first, localProjectId: project.id,
      agents: [
        { provider: 'claude' as const, model: 'claude-sonnet-5-5', effort: 'medium', policy: 'supervised' as const },
        { provider: 'claude' as const, model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised' as const },
      ] };
    const [first, duplicate] = await Promise.allSettled([
      service.joinInvitation(firstInput), service.joinInvitation(firstInput),
    ]);
    assert.equal(first.status, 'rejected');
    assert.equal(duplicate.status, 'rejected');
    assert.equal(store.listSessions(project.id).length, 4, 'concurrent matching join attempts create the requested agents once alongside existing local sessions');
    assert.equal(fakeProviders.runs.length, 0, 'onboarding never invokes a provider model');

    const recovered = await service.joinInvitation(firstInput);
    assert.equal(recovered.alreadyJoined, true, 'retry after the failed roster write resumes the existing join');
    assert.equal(store.listSessions(project.id).length, 4, 'retry after a partial failure reuses each deterministic agent session');
    const firstSessionId = recovered.sessionId;
    assert.equal(recovered.sessionIds.length, 2);
    assert.equal(store.getSession(recovered.sessionIds[0]!)?.effort, 'medium');
    assert.equal(store.getSession(recovered.sessionIds[1]!)?.effort, 'high');

    const secondInput = { ...firstInput, token: TOKENS.second };
    const second = await service.joinInvitation(secondInput);
    assert.equal(second.sessionId, firstSessionId, 'a reissued invitation reuses the account/device/project initial agent');
    assert.deepEqual(second.sessionIds, recovered.sessionIds, 'a reissued invitation returns the same ordered session IDs');
    assert.equal(store.listSessions(project.id).length, 4, 'a new invitation does not duplicate the project agents');
    assert.deepEqual([...published.values()].map((agent) => agent.sessionId).sort(), [preexistingSession.id, ...recovered.sessionIds].sort(),
      'publication preserves the device’s other explicitly published sessions');
    assert.equal(createCount, 2, 'the partial publication and its retry each wrote the preserved local roster');
    const snapshot = await service.snapshot(project.id);
    assert.equal(snapshot.project?.teamId, TEAM, 'a teammate resolves the invitation-bound local project snapshot');
    assert.deepEqual(snapshot.agents.map((agent) => agent.sessionId).sort(), [preexistingSession.id, ...recovered.sessionIds].sort());
    assert.equal(snapshot.agents.some((agent) => agent.sessionId === privateSession.id), false,
      'private local sessions do not appear as shared agents until explicitly published');
    await assert.rejects(service.createInvitation(project.id, { email: 'new@example.test', role: 'member' }),
      (error: unknown) => error instanceof Error && 'status' in error && error.status === 403,
      'a joined teammate cannot bootstrap a second team or invite more people');
    assert.equal(store.db.prepare('SELECT 1 FROM mingle_project_collaboration_sources WHERE local_project_id=?').get(project.id), undefined,
      'joining does not create a leader/source-team mapping for the invitee');
  } finally {
    await service.close();
    store.db.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
