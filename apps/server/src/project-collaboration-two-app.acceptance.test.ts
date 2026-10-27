import { rmSync } from 'node:fs';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { AccountService } from './account/service.ts';
import { makeRepo, runGit, startTestApp, tmpDir, waitFor, type TestApp } from './test-utils.ts';
import { ProjectInvitationCloudFixture } from './project-collaboration-cloud.test-utils.ts';

it.each([false, true])('invites and joins through two real HTTP applications, PostgreSQL policies and encrypted transport (Realtime fixture: %s)', async (realtime) => {
  const users = [
    { id: '21000000-0000-4000-8000-000000000001', email: 'leader@example.test' },
    { id: '21000000-0000-4000-8000-000000000002', email: 'teammate@example.test' },
  ];
  const cloud = new ProjectInvitationCloudFixture({ realtime, wakeDelayMs: 25 });
  const accounts = new Map<string, typeof users[number]>();
  const apps: TestApp[] = [], repos: string[] = [];
  let invitationToken = '';
  try {
    await cloud.initialize(users);
    const nativeSnapshot = AccountService.prototype.snapshot;
    vi.spyOn(AccountService.prototype, 'snapshot').mockImplementation(function (this: AccountService) {
      const state = nativeSnapshot.call(this);
      const user = accounts.get(Reflect.get(this, 'dataDir'));
      return user ? { ...state, configured: true, status: 'signed-in', user: { id: user.id, email: user.email, name: 'Example account' } } : state;
    });
    vi.spyOn(AccountService.prototype, 'withAuthenticatedClient').mockImplementation((async function<T>(this: AccountService, work: (client: SupabaseClient, user: User) => Promise<T>) {
      const user = accounts.get(Reflect.get(this, 'dataDir'));
      if (!user) throw new Error('Explicit fixture account required');
      return work(cloud.client(user.id), { ...user, aud: 'authenticated', created_at: '2026-01-01T00:00:00Z', email_confirmed_at: '2026-01-01T00:00:00Z', is_anonymous: false, app_metadata: { providers: ['google'] }, user_metadata: { full_name: 'Example account' } } as User);
    }) as AccountService['withAuthenticatedClient']);
    const emailSender = {
      async status() { return { configured: true }; },
      async send(_client: SupabaseClient, input: { token: string }) { invitationToken = input.token; return { status: 'sent' as const, message: 'Example sender accepted the fixture invitation; no real email was sent.' }; },
    };
    for (const user of users) {
      const dataDir = tmpDir('mingle-project-join-app-');
      accounts.set(dataDir, user);
      apps.push(await startTestApp({ dataDir, env: {}, exampleWorkspace: false, projectCollaboration: { emailSender } }));
      const repo = makeRepo();
      repos.push(repo);
      runGit(repo, 'remote', 'add', 'origin', 'https://github.com/example/collaboration-acceptance.git');
    }
    const [leader, teammate] = apps as [TestApp, TestApp];
    const projectIds: string[] = [];
    for (let i = 0; i < apps.length; i++) {
      const created = await apps[i]!.api('POST', '/api/projects', { name: 'Example shared project', path: repos[i] });
      expect(created.status).toBe(201);
      projectIds.push(created.json.id);
    }
    const privateAgent = await leader.api('POST', '/api/sessions', { projectId: projectIds[0], name: 'Private leader session', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', policy: 'supervised' });
    expect(privateAgent.status, JSON.stringify(privateAgent.json)).toBe(201);
    const invitation = await leader.api('POST', `/api/projects/${projectIds[0]}/collaboration/invitations`, { email: users[1]!.email });
    expect(invitation.status, JSON.stringify(invitation.json)).toBe(200);
    expect(invitation.json.delivery.status).toBe('sent');
    expect(invitationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await leader.api('POST', '/api/project-invitations/preview', { token: invitationToken })).status).toBe(404);
    const preview = await teammate.api('POST', '/api/project-invitations/preview', { token: invitationToken });
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    expect(preview.json.repositoryUrl).toContain('collaboration-acceptance');
    const join = { token: invitationToken, localProjectId: projectIds[1], agents: [
      { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', policy: 'supervised' },
      { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised' },
    ] };
    // Subscribe the registered host before the member publishes. No real cloud,
    // email or model inference is involved in this explicitly local fixture.
    if (realtime) await leader.app.distributed.transport.sync();
    const joined = await Promise.all([teammate.api('POST', '/api/project-invitations/join', join), teammate.api('POST', '/api/project-invitations/join', join)]);
    for (const result of joined) expect(result.status, JSON.stringify(result.json)).toBe(200);
    expect(joined[0]!.json.sessionId).toBe(joined[1]!.json.sessionId);
    expect(joined[0]!.json.sessionIds).toHaveLength(2);
    expect(joined[0]!.json.sessionIds).toEqual(joined[1]!.json.sessionIds);
    expect(teammate.app.store.listSessions(projectIds[1])).toHaveLength(2);
    if (!realtime) {
      // Model a lost acknowledgement after PostgreSQL accepted the envelope.
      teammate.app.store.db.prepare("UPDATE mingle_transport_outbox SET status='queued',next_attempt_at=0 WHERE kind='execution.agents'").run();
      await teammate.app.distributed.transport.sync();
      expect(teammate.app.store.db.prepare('SELECT status FROM mingle_transport_outbox').all()).toEqual([{ status: 'delivered' }]);
      expect((await cloud.pg.query('SELECT id FROM public.mingle_envelopes')).rows).toHaveLength(1);
      await leader.app.distributed.transport.sync();
    } else {
      await waitFor(() => leader.app.store.db.prepare('SELECT id FROM mingle_remote_agents WHERE session_id=? AND revoked_at IS NULL').get(joined[0]!.json.sessionId));
      // Before a canonical group is configured, the open Teammates dialog still
      // needs the project-scoped event that drives its live roster refresh.
      const initialInvalidation = await waitFor(() => leader.app.store.listEvents({ projectId: projectIds[0] })
        .find((event) => event.type === 'team.structure.updated'));
      const renamedAt = performance.now();
      const renamed = await teammate.api('PATCH', `/api/sessions/${joined[0]!.json.sessionId}`, { name: 'Example Codex 1 renamed' });
      expect(renamed.status, JSON.stringify(renamed.json)).toBe(200);
      await waitFor(() => leader.app.store.db.prepare('SELECT id FROM mingle_remote_agents WHERE session_id=? AND name=? AND revoked_at IS NULL')
        .get(joined[0]!.json.sessionId, 'Example Codex 1 renamed'));
      await waitFor(() => leader.app.store.listEvents({ projectId: projectIds[0], after: initialInvalidation.id })
        .some((event) => event.type === 'team.structure.updated'));
      const elapsed = performance.now() - renamedAt;
      expect(elapsed, `Local two-app metadata propagation took ${Math.round(elapsed)}ms`).toBeLessThan(1_000);
      expect(cloud.wakeTimings.some((timing) => timing.deliveredAt !== null)).toBe(true);
      console.info(`Example two-app metadata propagation: ${Math.round(elapsed)}ms (25ms simulated wake delay; no internet latency measured)`);
    }
    const roster = await leader.api('GET', `/api/projects/${projectIds[0]}/collaboration`);
    expect(roster.status, JSON.stringify(roster.json)).toBe(200);
    expect(roster.json.agents.some((agent: { accountId: string }) => agent.accountId === users[1]!.id), JSON.stringify({
      roster: roster.json,
      outgoing: teammate.app.store.db.prepare('SELECT kind,status,error FROM mingle_transport_outbox').all(),
      incoming: leader.app.store.db.prepare('SELECT kind,status,error FROM mingle_transport_inbox').all(),
      cloudErrors: cloud.errors,
    })).toBe(true);
    expect(roster.json.members.some((member: { accountId: string }) => member.accountId === users[1]!.id)).toBe(true);
    expect(roster.json.agents.some((agent: { sessionId: string }) => agent.sessionId === privateAgent.json.id)).toBe(false);
    const inviteeRoster = await teammate.api('GET', `/api/projects/${projectIds[1]}/collaboration`);
    expect(inviteeRoster.status, JSON.stringify(inviteeRoster.json)).toBe(200);
    expect(inviteeRoster.json.project?.sharedProjectId).toBe(joined[0]!.json.sharedProjectId);
    expect(inviteeRoster.json.members).toHaveLength(2);
    expect(inviteeRoster.json.agents.some((agent: { sessionId: string }) => agent.sessionId === joined[0]!.json.sessionId)).toBe(true);
    const links = await cloud.pg.query('SELECT * FROM public.mingle_device_links');
    expect(links.rows).toHaveLength(2);
    expect(apps.every(app => app.fake.runs.length === 0)).toBe(true);
    const retryWithDifferentAgent = await teammate.api('POST', '/api/project-invitations/join', { ...join, agents: [{ ...join.agents[0]!, effort: 'low' }, join.agents[1]] });
    expect(retryWithDifferentAgent.status).toBe(409);
    expect(teammate.app.store.listSessions(projectIds[1])).toHaveLength(2);
  } finally {
    while (apps.length) await apps.pop()!.cleanup();
    vi.restoreAllMocks();
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
    await cloud.close();
  }
}, 60_000);
