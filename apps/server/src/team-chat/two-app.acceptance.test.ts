import { rmSync } from 'node:fs';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { TEAM_CONSENT_DISCLAIMER_VERSION } from '@mingle/contracts';
import { AccountService } from '../account/service.ts';
import { makeRepo, runGit, startTestApp, tmpDir, waitFor, type TestApp } from '../test-utils.ts';
import { ProjectInvitationCloudFixture } from '../project-collaboration-cloud.test-utils.ts';

it('shares imported session history and team messages over HTTP and the encrypted two-device mailbox without inference', async () => {
  const users = [
    { id: '21000000-0000-4000-8000-000000000011', email: 'leader@example.test' },
    { id: '21000000-0000-4000-8000-000000000012', email: 'teammate@example.test' },
  ];
  const cloud = new ProjectInvitationCloudFixture();
  const accounts = new Map<string, typeof users[number]>();
  const apps: TestApp[] = [];
  const repositories: string[] = [];
  let invitationToken = '';
  try {
    await cloud.initialize(users);
    const nativeSnapshot = AccountService.prototype.snapshot;
    vi.spyOn(AccountService.prototype, 'snapshot').mockImplementation(function (this: AccountService) {
      const state = nativeSnapshot.call(this);
      const user = accounts.get(Reflect.get(this, 'dataDir'));
      return user ? { ...state, configured: true, status: 'signed-in', user: { id: user.id, email: user.email, name: 'Example teammate' } } : state;
    });
    vi.spyOn(AccountService.prototype, 'withAuthenticatedClient').mockImplementation((async function<T>(this: AccountService, work: (client: SupabaseClient, user: User) => Promise<T>) {
      const user = accounts.get(Reflect.get(this, 'dataDir'));
      if (!user) throw new Error('Explicit fixture account required');
      return work(cloud.client(user.id), { ...user, aud: 'authenticated', created_at: '2026-01-01T00:00:00Z', email_confirmed_at: '2026-01-01T00:00:00Z', is_anonymous: false,
        app_metadata: { providers: ['google'] }, user_metadata: { full_name: user.id === users[0]!.id ? 'Leader Ada' : 'Teammate Sam' } } as User);
    }) as AccountService['withAuthenticatedClient']);
    const emailSender = {
      async status() { return { configured: true }; },
      async send(_client: SupabaseClient, input: { token: string }) { invitationToken = input.token; return { status: 'sent' as const, message: 'Fixture mail accepted; no real email was sent.' }; },
    };
    for (const user of users) {
      const dataDir = tmpDir('mingle-team-chat-app-');
      accounts.set(dataDir, user);
      apps.push(await startTestApp({ dataDir, env: {}, exampleWorkspace: false, projectCollaboration: { emailSender } }));
      const repo = makeRepo();
      repositories.push(repo);
      runGit(repo, 'remote', 'add', 'origin', 'https://github.com/example/team-chat-acceptance.git');
    }
    const [leader, teammate] = apps as [TestApp, TestApp];
    const projects: string[] = [];
    for (let index = 0; index < apps.length; index++) {
      const created = await apps[index]!.api('POST', '/api/projects', { name: 'Team chat acceptance', path: repositories[index] });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      projects.push(created.json.id);
    }
    const sessionResponse = await leader.api('POST', '/api/sessions', { projectId: projects[0], name: 'History to share', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' });
    expect(sessionResponse.status, JSON.stringify(sessionResponse.json)).toBe(201);
    const sessionId = sessionResponse.json.id as string;
    leader.app.store.insertMessage({ sessionId, role: 'user', content: 'The team agreed to use a small API surface.', createdAt: '2026-10-20T10:00:00.000Z' });
    leader.app.store.insertMessage({ sessionId, role: 'assistant', content: 'I will prepare the first draft.', createdAt: '2026-10-20T10:01:00.000Z' });

    const invitation = await leader.api('POST', `/api/projects/${projects[0]}/collaboration/invitations`, { email: users[1]!.email });
    expect(invitation.status, JSON.stringify(invitation.json)).toBe(200);
    expect(invitationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const join = await teammate.api('POST', '/api/project-invitations/join', {
      token: invitationToken, localProjectId: projects[1], agent: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised' },
    });
    expect(join.status, JSON.stringify(join.json)).toBe(200);

    const consent = await teammate.api('POST', `/api/projects/${projects[1]}/team-consent`, {
      sessionIds: [join.json.sessionId], permissionLevel: 'supervised', settingsVersion: 1,
      disclaimerVersion: TEAM_CONSENT_DISCLAIMER_VERSION,
    });
    expect(consent.status, JSON.stringify(consent.json)).toBe(200);
    await leader.app.distributed.transport.sync();
    const hostAgentsBeforeAdd = await leader.api('GET', `/api/projects/${projects[0]}/team-agents`);
    expect(hostAgentsBeforeAdd.status, JSON.stringify(hostAgentsBeforeAdd.json)).toBe(200);
    expect(hostAgentsBeforeAdd.json.agents).toContainEqual(expect.objectContaining({
      agentId: consent.json.agentIds[0], consent: 'granted', usable: true, groupId: null,
    }));
    expect(hostAgentsBeforeAdd.json.teamSession).toBeNull();

    const invalidMessage = await teammate.api('POST', `/api/projects/${projects[1]}/team-chat/messages`, { body: 'x'.repeat(20_001), mentions: [], unexpected: true });
    expect(invalidMessage.status).toBe(400);

    const imported = await leader.api('POST', `/api/projects/${projects[0]}/team-chat/import`, { sessionId });
    expect(imported.status, JSON.stringify(imported.json)).toBe(200);
    expect(imported.json).toMatchObject({ imported: 2, truncated: false });
    // Historical assistant text is attributed to the importing account unless its session is a published roster agent.
    expect(imported.json.messages.map((message: { author: { kind: string } }) => message.author.kind)).toEqual(['human', 'human']);
    await teammate.app.distributed.transport.sync();
    const joinedHistory = await teammate.api('GET', `/api/projects/${projects[1]}/team-chat?limit=20`);
    expect(joinedHistory.status, JSON.stringify(joinedHistory.json)).toBe(200);
    expect(joinedHistory.json.messages.map((message: { body: string }) => message.body), JSON.stringify(joinedHistory.json.messages)).toEqual([
      'The team agreed to use a small API surface.', 'I will prepare the first draft.',
    ]);

    const sent = await teammate.api('POST', `/api/projects/${projects[1]}/team-chat/messages`, { body: 'The new checkout has the shared session history.', mentions: [] });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    // Sends return before fan-out; wait until the teammate has queued the envelope, then exchange mailboxes.
    for (let attempt = 0; attempt < 100; attempt++) {
      const own = await teammate.api('GET', `/api/projects/${projects[1]}/team-chat?limit=20`);
      const state = own.json.messages.find((message: { id: string }) => message.id === sent.json.id)?.deliveryState;
      if (state && state !== 'sending') { expect(state).toBe('sent'); break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await teammate.app.distributed.transport.sync();
    await leader.app.distributed.transport.sync();
    const leaderHistory = await leader.api('GET', `/api/projects/${projects[0]}/team-chat?limit=20`);
    expect(leaderHistory.status, JSON.stringify(leaderHistory.json)).toBe(200);
    expect(leaderHistory.json.messages.map((message: { body: string }) => message.body)).toContain('The new checkout has the shared session history.');
    expect(leaderHistory.json.transport.linkedDeviceCount).toBeGreaterThan(0);
    const agentMessage = await teammate.api('POST', `/api/projects/${projects[1]}/team-chat/messages`, {
      body: 'Reply using the local fake provider.', mentions: [join.json.sessionId],
    });
    expect(agentMessage.status, JSON.stringify(agentMessage.json)).toBe(200);
    await waitFor(() => teammate.app.store.db.prepare('SELECT delivery_state FROM team_chat_messages WHERE id=?').get(agentMessage.json.id)?.delivery_state === 'sent');
    expect(teammate.fake.runs).toHaveLength(0);
    await leader.app.distributed.transport.sync();
    const agentReply = await leader.api('GET', `/api/projects/${projects[0]}/team-chat?limit=20`);
    expect(agentReply.json.messages.some((message: { author: { kind: string }; body: string }) => message.author.kind === 'human' && message.body === 'Reply using the local fake provider.'),
      JSON.stringify(agentReply.json.messages)).toBe(true);
    expect(leader.fake.runs).toHaveLength(0);
    expect(teammate.app.store.db.prepare('SELECT run_state FROM team_chat_messages WHERE id=?').get(agentMessage.json.id)?.run_state).toBeNull();

    const added = await leader.api('POST', `/api/sessions/${sessionId}/team-agents`, { agentId: consent.json.agentIds[0] });
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    expect(added.json.members.some((member: { sessionId: string }) => member.sessionId.startsWith('proxy_'))).toBe(true);
    await teammate.app.distributed.transport.sync();
    const joinedStructure = await teammate.api('GET', `/api/projects/${projects[1]}/team-structure`);
    expect(joinedStructure.status, JSON.stringify(joinedStructure.json)).toBe(200);
    expect(joinedStructure.json.teamSession).toMatchObject({ title: 'History to share' });
    const hostAgents = await leader.api('GET', `/api/projects/${projects[0]}/team-agents`);
    expect(hostAgents.status, JSON.stringify(hostAgents.json)).toBe(200);
    expect(hostAgents.json.agents).toContainEqual(expect.objectContaining({
      agentId: consent.json.agentIds[0], consent: 'granted', groupId: expect.any(String),
    }));

    const fullAccess = await leader.api('PATCH', `/api/projects/${projects[0]}/team-orchestration`, {
      expectedVersion: joinedStructure.json.settings.version, permissionLevel: 'full-access',
    });
    expect(fullAccess.status, JSON.stringify(fullAccess.json)).toBe(200);
    await teammate.app.distributed.transport.sync();
    const needsReconsent = await teammate.api('GET', `/api/projects/${projects[1]}/team-structure`);
    expect(needsReconsent.status, JSON.stringify(needsReconsent.json)).toBe(200);
    expect(needsReconsent.json.myConsent).toMatchObject({ state: 'needs-reconsent' });
  } finally {
    while (apps.length) await apps.pop()!.cleanup();
    vi.restoreAllMocks();
    for (const repository of repositories) rmSync(repository, { recursive: true, force: true });
    await cloud.close();
  }
}, 60_000);
