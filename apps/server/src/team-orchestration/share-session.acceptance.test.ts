import { rmSync } from 'node:fs';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { AccountService } from '../account/service.ts';
import { ProjectInvitationCloudFixture } from '../project-collaboration-cloud.test-utils.ts';
import { makeRepo, runGit, startTestApp, type TestApp } from '../test-utils.ts';

// Real HTTP, SQLite, Git and GroupService; only the account/cloud boundary uses
// an explicit disposable fixture. Sharing must never start a provider run.
it('shares the current conversation without choosing or publishing a leader first', async () => {
  const user = { id: '22000000-0000-4000-8000-000000000011', email: 'example-lead@example.invalid' };
  const cloud = new ProjectInvitationCloudFixture();
  const repo = makeRepo();
  const groupRepo = makeRepo();
  let app: TestApp | undefined;
  try {
    await cloud.initialize([user]);
    const nativeSnapshot = AccountService.prototype.snapshot;
    vi.spyOn(AccountService.prototype, 'snapshot').mockImplementation(function (this: AccountService) {
      return { ...nativeSnapshot.call(this), configured: true, status: 'signed-in',
        user: { ...user, name: 'Example lead' } };
    });
    vi.spyOn(AccountService.prototype, 'withAuthenticatedClient').mockImplementation((async function<T>(
      work: (client: SupabaseClient, account: User) => Promise<T>,
    ) {
      return work(cloud.client(user.id), { ...user, aud: 'authenticated', created_at: '2026-01-01T00:00:00Z',
        email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: {}, user_metadata: { full_name: 'Example lead' } } as User);
    }) as AccountService['withAuthenticatedClient']);
    app = await startTestApp({ env: {}, exampleWorkspace: false, projectCollaboration: { emailSender: {
      async status() { return { configured: true }; },
      async send() { return { status: 'sent' as const, message: 'Example fixture; no email sent.' }; },
    } } });
    runGit(repo, 'remote', 'add', 'origin', 'https://github.com/example/current-session.git');
    const project = await app.api('POST', '/api/projects', { name: 'Example shared conversation', path: repo });
    expect(project.status).toBe(201);
    const session = await app.api('POST', '/api/sessions', { projectId: project.json.id, name: 'Current conversation',
      provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' });
    expect(session.status).toBe(201);
    const history = app.app.store.insertMessage({ sessionId: session.json.id, role: 'user', content: 'Keep this conversation.' });
    const invite = await app.api('POST', `/api/projects/${project.json.id}/collaboration/invitations`, { email: 'example-member@example.invalid' });
    expect(invite.status, JSON.stringify(invite.json)).toBe(200);
    const base = `/api/projects/${project.json.id}`;
    const share = await app.api('POST', `${base}/team-orchestration/share-session`, {
      sessionId: session.json.id, permissionLevel: 'supervised',
    });
    expect(share.status, JSON.stringify(share.json)).toBe(200);
    expect(share.json.teamSession).toMatchObject({ sessionId: session.json.id, title: 'Current conversation' });
    expect(share.json.settings).toMatchObject({ leaderOrchestration: true, permissionLevel: 'supervised' });
    const groupId = share.json.teamSession.groupId;
    const group = await app.api('GET', `/api/groups/${groupId}`);
    expect(group.status, JSON.stringify(group.json)).toBe(200);
    expect(group.json.group.anchorSessionId).toBe(session.json.id);
    expect(group.json.members).toHaveLength(1);
    expect(group.json.members[0]).toMatchObject({ sessionId: session.json.id, role: 'orchestrator' });
    expect(group.json.group.orchestratorMemberId).toBe(group.json.members[0].id);
    const structure = await app.api('GET', `${base}/team-structure`);
    expect(structure.json.members).toContainEqual(expect.objectContaining({ sessionId: session.json.id,
      agentId: share.json.settings.orchestratorAgentId, local: true, role: 'orchestrator' }));
    const repeat = await app.api('POST', `${base}/team-orchestration/share-session`, {
      sessionId: session.json.id, permissionLevel: 'supervised', expectedVersion: share.json.settings.version,
    });
    expect(repeat.status, JSON.stringify(repeat.json)).toBe(200);
    expect(repeat.json.teamSession.groupId).toBe(groupId);
    expect(repeat.json.settings.version).toBe(share.json.settings.version);
    const changed = await app.api('PATCH', `${base}/team-orchestration`, {
      permissionLevel: 'full-access', expectedVersion: repeat.json.settings.version,
    });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    expect(changed.json.teamSession.groupId).toBe(groupId);
    expect(changed.json.settings.permissionLevel).toBe('full-access');
    const another = await app.api('POST', '/api/sessions', { projectId: project.json.id, name: 'A different private conversation',
      provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' });
    expect(another.status).toBe(201);
    const replace = await app.api('POST', `${base}/team-orchestration/share-session`, {
      sessionId: another.json.id, permissionLevel: 'full-access', expectedVersion: changed.json.settings.version,
    });
    expect(replace.status, JSON.stringify(replace.json)).toBe(409);
    expect((await app.api('GET', `${base}/team-structure`)).json.teamSession.groupId).toBe(groupId);
    const boot = await app.api('GET', '/api/bootstrap');
    expect(boot.json.sessions).toHaveLength(2);
    expect(boot.json.groups).toHaveLength(1);
    expect(boot.json.messages).toContainEqual(expect.objectContaining({ id: history.id, content: 'Keep this conversation.' }));

    // The visible entry of a local group can differ from its configured leader.
    // Sharing that entry must retain the real group and its established members.
    runGit(groupRepo, 'remote', 'add', 'origin', 'https://github.com/example/existing-local-group.git');
    const groupedProject = await app.api('POST', '/api/projects', { name: 'Example local group', path: groupRepo });
    const anchor = await app.api('POST', '/api/sessions', { projectId: groupedProject.json.id, name: 'Existing local conversation',
      provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' });
    const configuration = { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised' };
    const localGroup = await app.api('POST', '/api/groups', { sessionId: anchor.json.id, mode: 'orchestrated',
      agent: { configuration, handle: 'barista' }, orchestrator: configuration });
    expect(localGroup.status, JSON.stringify(localGroup.json)).toBe(201);
    const lead = localGroup.json.members.find((member: { id: string }) => member.id === localGroup.json.group.orchestratorMemberId);
    expect(lead.sessionId).not.toBe(anchor.json.id);
    const groupBase = `/api/projects/${groupedProject.json.id}`;
    expect((await app.api('POST', `${groupBase}/collaboration/invitations`, { email: 'another-member@example.invalid' })).status).toBe(200);
    const adopt = await app.api('POST', `${groupBase}/team-orchestration/share-session`, {
      sessionId: anchor.json.id, permissionLevel: 'supervised',
    });
    expect(adopt.status, JSON.stringify(adopt.json)).toBe(200);
    expect(adopt.json.teamSession).toMatchObject({ groupId: localGroup.json.group.id, sessionId: anchor.json.id });
    const retained = await app.api('GET', `/api/groups/${localGroup.json.group.id}`);
    expect(retained.json.members.filter((member: { removedAt: string | null }) => !member.removedAt).map((member: { id: string }) => member.id).sort())
      .toEqual(localGroup.json.members.map((member: { id: string }) => member.id).sort());
    expect(retained.json.group.orchestratorMemberId).toBe(lead.id);
    expect(adopt.json.members).toContainEqual(expect.objectContaining({ sessionId: lead.sessionId,
      agentId: adopt.json.settings.orchestratorAgentId, role: 'orchestrator' }));
    expect(app.fake.runs).toHaveLength(0);
    expect(cloud.errors).toEqual([]);
  } finally {
    await app?.cleanup();
    vi.restoreAllMocks();
    await cloud.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(groupRepo, { recursive: true, force: true });
  }
}, 30_000);
