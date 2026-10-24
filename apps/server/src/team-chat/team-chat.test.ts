import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { openDatabase } from '../db.ts';
import { Store } from '../store.ts';
import { SessionRuntime } from '../runtime.ts';
import { TaskService } from '../tasks.ts';
import { FakeProviders, makeRepo } from '../test-utils.ts';
import type { AccountService } from '../account/service.ts';
import type { DistributedWorkspaceService } from '../distributed/service.ts';
import type { ProjectCollaborationService } from '../project-collaboration/service.ts';
import { TeamChatMessageSchema } from '../../../../packages/contracts/src/team-chat.ts';
import { TeamChatService } from './service.ts';

const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const TEAM = '20000000-0000-4000-8000-000000000001';
const SHARED = '30000000-0000-4000-8000-000000000001';
const DEVICE = '40000000-0000-4000-8000-000000000001';
const PEER = '40000000-0000-4000-8000-000000000002';
const PROJECT = 'project-chat-test';

function cloudClient(): SupabaseClient {
  return {
    from(table: string) {
      const filters = new Map<string, unknown>();
      const builder: any = {
        select() { return builder; },
        eq(key: string, value: unknown) { filters.set(key, value); return builder; },
        is() { return builder; },
        in(key: string, value: unknown) { filters.set(key, value); return builder; },
        limit() { return builder; },
        maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) { return Promise.resolve({ data: rows(), error: null }).then(resolve, reject); },
      };
      const rows = () => {
        const id = filters.get('id');
        const userId = filters.get('user_id');
        if (table === 'mingle_devices') return id === PEER ? [{ id: PEER, owner_id: ACCOUNT }] : id === DEVICE ? [{ id: DEVICE, owner_id: ACCOUNT }] : [];
        if (table === 'mingle_projects') return filters.get('id') === SHARED && filters.get('team_id') === TEAM ? [{ id: SHARED }] : [];
        if (table === 'mingle_members') {
          const allowed = [ACCOUNT];
          if (Array.isArray(userId)) return (userId as string[]).filter((value) => allowed.includes(value)).map((value) => ({ user_id: value }));
          return typeof userId === 'string' && allowed.includes(userId) ? [{ user_id: userId }] : [];
        }
        return [];
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

function fixture(withAgent = false) {
  const store = new Store(openDatabase(':memory:'));
  const projectPath = makeRepo();
  const project = store.insertProject({ id: PROJECT, name: 'Shared', path: projectPath });
  store.db.exec(`CREATE TABLE mingle_project_collaboration_sources (local_project_id TEXT,owner_id TEXT,team_id TEXT,shared_project_id TEXT);
    CREATE TABLE mingle_project_collaboration_joins (local_project_id TEXT,account_id TEXT,team_id TEXT,shared_project_id TEXT,device_id TEXT);
    INSERT INTO mingle_project_collaboration_sources VALUES ('${PROJECT}','${ACCOUNT}','${TEAM}','${SHARED}');`);
  const session = withAgent ? store.insertSession({ projectId: project.id, name: 'Local agent', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: false, worktreePath: projectPath, branch: null }) : null;
  let receive: ((envelope: any) => Promise<void>) | null = null;
  const outgoing: Array<{ teamId: string; toDeviceId: string; kind: string; payload: unknown; idempotencyKey: string }> = [];
  let allowPeer = true;
  const transportSnapshot = () => ({
    deviceId: DEVICE, status: 'ready' as const, error: null,
    devices: [
      { id: DEVICE, teamId: TEAM, ownerId: ACCOUNT, name: 'Local', revokedAt: null, status: 'online' },
      { id: PEER, teamId: TEAM, ownerId: ACCOUNT, name: 'Peer', revokedAt: null, status: 'online' },
    ],
    links: [{ teamId: TEAM, deviceId: DEVICE, peerDeviceId: PEER, peerFingerprint: 'SHA-256:peer', createdAt: new Date().toISOString(), mutual: true }],
  });
  const transport = {
    snapshot: () => transportSnapshot(),
    sync: async () => undefined,
    send: async (entry: typeof outgoing[number]) => { outgoing.push(entry); return `envelope-${outgoing.length}`; },
    onMessage: (handler: (envelope: any) => Promise<void>) => { receive = handler; return () => { receive = null; }; },
  };
  const fake = new FakeProviders();
  const runtime = new SessionRuntime(store, { broadcast() {} } as any, fake, new TaskService(store), () => undefined,
    { abortGraceMs: 250, flushIntervalMs: 10 });
  const collaboration = {
    async snapshot() {
      return {
        project: { teamId: TEAM, sharedProjectId: SHARED, name: 'Shared', repositoryUrl: 'https://example.test/team.git' },
        members: [{ accountId: ACCOUNT, displayName: 'Ada', email: null, role: 'leader', status: 'active' }],
        agents: session ? [{ id: session.id, name: session.name, accountId: ACCOUNT, deviceId: DEVICE,
          projectId: PROJECT, sessionId: session.id, provider: session.provider, model: session.model, state: 'idle' }] : [],
        invitations: [], email: { configured: false },
      };
    },
  };
  const account = {
    async withAuthenticatedClient<T>(work: (client: SupabaseClient, user: User) => Promise<T>) {
      return work(cloudClient(), { id: ACCOUNT, email: 'ada@example.test', aud: 'authenticated', created_at: '2026-01-01T00:00:00Z', app_metadata: {}, user_metadata: { full_name: 'Ada' } } as unknown as User);
    },
  };
  const distributed = {
    transport,
    async authorizeTeam({ peerDeviceId }: { teamId: string; peerDeviceId?: string }) {
      if (!allowPeer || (peerDeviceId && peerDeviceId !== PEER)) throw new Error('inactive peer membership');
    },
  };
  const service = new TeamChatService({ store, account: account as unknown as AccountService,
    distributed: distributed as unknown as DistributedWorkspaceService, runtime: runtime as any,
    collaboration: collaboration as unknown as ProjectCollaborationService });
  return {
    store, project, session, service, outgoing, runtimeCalls: fake.runs,
    receive: (envelope: any) => {
      if (!receive) throw new Error('No team chat transport listener');
      return receive(envelope);
    },
    setPeerAllowed(value: boolean) { allowPeer = value; },
    async close() { await service.close(); await runtime.shutdown(); store.db.close(); rmSync(projectPath, { recursive: true, force: true }); },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const untilAt = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= untilAt) throw new Error('Timed out waiting for team-chat state.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it('fans out authenticated human messages, deduplicates by message ID, and rejects a revoked sender link', async () => {
  const f = fixture();
  try {
    const message = await f.service.send(PROJECT, { body: 'Shared note', mentions: [] });
    expect(message).toMatchObject({ author: { kind: 'human', accountId: ACCOUNT, displayName: 'Ada' }, deliveryState: 'sent' });
    expect(f.outgoing).toHaveLength(1);
    expect(f.outgoing[0]).toMatchObject({ kind: 'teamchat.message', toDeviceId: PEER });

    const received = { ...message, deliveryState: 'sent' as const };
    const envelope = { id: randomUUID(), teamId: TEAM, fromDeviceId: PEER, toDeviceId: DEVICE, kind: 'teamchat.message', payload: received };
    await f.receive(envelope);
    await f.receive({ ...envelope, id: randomUUID() });
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM team_chat_messages WHERE id=?').get(message.id)).toEqual({ n: 1 });

    f.setPeerAllowed(false);
    const forged = TeamChatMessageSchema.parse({ ...received, id: randomUUID(), body: 'revoked sender message' });
    await expect(f.receive({ ...envelope, id: randomUUID(), payload: forged })).rejects.toThrow(/inactive peer/);
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM team_chat_messages WHERE body=?').get('revoked sender message')).toEqual({ n: 0 });
  } finally { await f.close(); }
});

it('backfills bounded message batches and runs local agent mentions through the normal runtime adapter', async () => {
  const f = fixture(true);
  try {
    const author = JSON.stringify({ kind: 'human', accountId: ACCOUNT, displayName: 'Ada' });
    const insert = f.store.db.prepare(`INSERT INTO team_chat_messages
      (id,team_id,shared_project_id,author_json,body,mentions_json,created_at,delivery_state,run_state)
      VALUES (?,?,?,?,?,?,?,'sent',NULL)`);
    for (let index = 0; index < 205; index++) {
      const id = `backfill-${String(index).padStart(3, '0')}`;
      insert.run(id, TEAM, SHARED, author, `History ${index}`, '[]', new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString());
    }
    await f.receive({ id: randomUUID(), teamId: TEAM, fromDeviceId: PEER, toDeviceId: DEVICE, kind: 'teamchat.sync.request',
      payload: { sharedProjectId: SHARED, requestId: randomUUID(), since: null } });
    const reply = f.outgoing.find((entry) => entry.kind === 'teamchat.sync.response');
    expect(reply).toBeTruthy();
    const response = reply!.payload as { messages: unknown[] };
    expect(response.messages).toHaveLength(200);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(180 * 1024);

    const agentId = f.session!.id;
    const humanMessage = await f.service.send(PROJECT, { body: 'Please check this for the team.', mentions: [agentId] });
    expect(humanMessage.runState).toBe('running');
    await until(() => {
      const rows = f.store.db.prepare('SELECT author_json FROM team_chat_messages').all() as Array<{ author_json: string }>;
      const parent = f.store.db.prepare('SELECT run_state FROM team_chat_messages WHERE id=?').get(humanMessage.id) as { run_state: string | null } | undefined;
      return rows.some((row) => JSON.parse(row.author_json).kind === 'agent') && parent?.run_state === 'completed';
    });
    expect(f.runtimeCalls).toHaveLength(1);
    expect(f.runtimeCalls[0]).toMatchObject({ session: { id: agentId } });
    expect(f.runtimeCalls[0]!.prompt).toContain('Please check this for the team.');
    expect(f.runtimeCalls[0]!.prompt).toContain('untrusted conversation context');
    const messages = f.store.db.prepare('SELECT author_json,body,run_state FROM team_chat_messages ORDER BY created_at,id').all() as Array<{ author_json: string; body: string; run_state: string | null }>;
    expect(messages.some((row) => JSON.parse(row.author_json).kind === 'agent' && row.body === 'ok')).toBe(true);
    expect(messages.find((row) => JSON.parse(row.author_json).kind === 'human' && row.body === 'Please check this for the team.')?.run_state).toBe('completed');
  } finally { await f.close(); }
});
