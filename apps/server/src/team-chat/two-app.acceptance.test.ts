import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { TEAM_CONSENT_DISCLAIMER_VERSION, type TeamMcpConnection } from '@mingle/contracts';
import { AccountService } from '../account/service.ts';
import { FakeProviders, makeRepo, runGit, startTestApp, tmpDir, waitFor, type TestApp } from '../test-utils.ts';
import { ProjectInvitationCloudFixture } from '../project-collaboration-cloud.test-utils.ts';

const FULL_ACCESS_POLICIES = ['supervised', 'balanced', 'auto', 'full-access'] as const;
const toolTimings: Array<{ name: string; startedAt: number; repliedAt?: number; closedAt?: number }> = [];

async function callTeamTool(connection: TeamMcpConnection, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const timing = { name, startedAt: Date.now() } as typeof toolTimings[number];
  toolTimings.push(timing);
  const client = new Client({ name: 'mingle-two-app-acceptance', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name, arguments: args });
    timing.repliedAt = Date.now();
    const text = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === 'text')?.text;
    if (result.isError) throw new Error(`${name} failed: ${text ?? 'no error details'}`);
    if (!text) return null;
    return JSON.parse(text);
  } finally { await client.close(); timing.closedAt = Date.now(); }
}

function fullAccessFakeProviders(): FakeProviders {
  const fake = new FakeProviders();
  const detect = fake.detectProviders.bind(fake);
  fake.detectProviders = async (settings) => [
    ...(await detect(settings)).map((provider) => ({
      ...provider,
      policies: [...FULL_ACCESS_POLICIES],
      models: provider.models.map((model) => ({ ...model, policies: [...FULL_ACCESS_POLICIES] })),
    })),
    { id: 'opencode', name: 'OpenCode', available: true, version: 'fake', executable: '/fake/opencode', reason: null,
      policies: [...FULL_ACCESS_POLICIES], models: [{ id: 'fake-opencode', name: 'Fake OpenCode', policies: [...FULL_ACCESS_POLICIES] }] },
  ];
  return fake;
}

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
      apps.push(await startTestApp({ dataDir, env: {}, exampleWorkspace: false, fake: fullAccessFakeProviders(), projectCollaboration: { emailSender } }));
      const repo = repositories.length ? tmpDir('mingle-team-chat-clone-') : makeRepo();
      if (repositories.length) runGit(path.dirname(repo), 'clone', '--quiet', repositories[0]!, repo);
      repositories.push(repo);
      runGit(repo, 'config', 'user.name', 'Team acceptance');
      runGit(repo, 'config', 'user.email', `team-acceptance-${repositories.length}@example.invalid`);
      if (repositories.length === 1) runGit(repo, 'remote', 'add', 'origin', 'https://github.com/example/team-chat-acceptance.git');
      else runGit(repo, 'remote', 'set-url', 'origin', 'https://github.com/example/team-chat-acceptance.git');
    }
    const [leader, teammate] = apps as [TestApp, TestApp];
    const projects: string[] = [];
    for (let index = 0; index < apps.length; index++) {
      const created = await apps[index]!.api('POST', '/api/projects', { name: 'Team chat acceptance', path: repositories[index] });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      projects.push(created.json.id);
    }
    const sessionResponse = await leader.api('POST', '/api/sessions', { projectId: projects[0], name: 'History to share', provider: 'opencode', model: 'fake-opencode', effort: 'none', policy: 'full-access' });
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
    const teammateCollaboration = await teammate.api('GET', `/api/projects/${projects[1]}/collaboration`);
    const teammateAgentId = teammateCollaboration.json.agents.find((agent: { sessionId: string }) => agent.sessionId === join.json.sessionId)?.id;
    expect(teammateAgentId).toMatch(/^agent_/);
    const additionalSession = await teammate.api('POST', '/api/sessions', { projectId: projects[1], name: 'Second teammate agent',
      provider: 'opencode', model: 'fake-opencode', effort: 'none', policy: 'full-access' });
    expect(additionalSession.status, JSON.stringify(additionalSession.json)).toBe(201);

    const consent = await teammate.api('POST', `/api/projects/${projects[1]}/team-consent`, {
      sessionIds: [join.json.sessionId, additionalSession.json.id], permissionLevel: 'supervised', settingsVersion: 1,
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
      body: 'Reply using the local fake provider.', mentions: [teammateAgentId],
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
    const joinedStructure = await waitFor(async () => {
      await teammate.app.distributed.transport.sync();
      const response = await teammate.api('GET', `/api/projects/${projects[1]}/team-structure`);
      return response.json.teamSession ? response : null;
    }, 6000, 'member device team-session structure');
    expect(joinedStructure.status, JSON.stringify(joinedStructure.json)).toBe(200);
    expect(joinedStructure.json.teamSession).toMatchObject({ title: 'History to share' });
    const hostAgents = await leader.api('GET', `/api/projects/${projects[0]}/team-agents`);
    expect(hostAgents.status, JSON.stringify(hostAgents.json)).toBe(200);
    expect(hostAgents.json.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: teammateAgentId, consent: 'granted' }),
    ]));

    const secondCollaboration = await teammate.api('GET', `/api/projects/${projects[1]}/collaboration`);
    const secondAgentId = secondCollaboration.json.agents.find((agent: { sessionId: string }) => agent.sessionId === additionalSession.json.id)?.id;
    expect(secondAgentId).toMatch(/^agent_/);
    const firstHostAgent = hostAgents.json.agents.find((agent: { agentId: string }) => agent.agentId === teammateAgentId);
    const secondAgent = hostAgents.json.agents.find((agent: { agentId: string }) => agent.agentId === secondAgentId);
    let teamGroupId = firstHostAgent?.groupId;
    if (!teamGroupId) {
      const added = await leader.api('POST', `/api/sessions/${sessionId}/team-agents`, { agentId: teammateAgentId });
      expect(added.status, JSON.stringify(added.json)).toBe(200);
      teamGroupId = added.json.group.id;
    }
    expect(teamGroupId).toEqual(expect.any(String));
    expect(secondAgent).toMatchObject({ consent: 'granted' });
    // A consented teammate agent joins the established team session without a manual leader step.
    await waitFor(async () => {
      const response = await leader.api('GET', `/api/projects/${projects[0]}/team-agents`);
      return response.json.agents.some((agent: { agentId: string; groupId: string | null }) => agent.agentId === secondAgentId && agent.groupId === teamGroupId);
    }, 6000, 'automatic team-session membership for the second consented agent');
    const proxySessionId = (leader.app.store.db.prepare(`SELECT session_id FROM mingle_team_proxy_sessions
      WHERE team_id=? AND shared_project_id=? AND agent_id=?`).get(join.json.teamId, join.json.sharedProjectId, secondAgentId) as { session_id: string }).session_id;
    const firstProxySessionId = (leader.app.store.db.prepare(`SELECT session_id FROM mingle_team_proxy_sessions
      WHERE team_id=? AND shared_project_id=? AND agent_id=?`).get(join.json.teamId, join.json.sharedProjectId, teammateAgentId) as { session_id: string }).session_id;
    await teammate.app.distributed.transport.sync();
    const hostStructure = await leader.api('GET', `/api/projects/${projects[0]}/team-structure`);
    const memberStructure = await teammate.api('GET', `/api/projects/${projects[1]}/team-structure`);
    const hostOwnMember = hostStructure.json.members.find((member: { local: boolean }) => member.local);
    const memberHostMember = memberStructure.json.members.find((member: { agentId: string }) => member.agentId === hostOwnMember?.agentId);
    expect(hostOwnMember?.handle, JSON.stringify({ host: hostStructure.json.members, member: memberStructure.json.members })).toBeTruthy();
    expect(memberHostMember?.handle).toBe(hostOwnMember?.handle);
    expect(memberStructure.json.teamSession).toMatchObject({ title: 'History to share' });

    const latestStructure = await leader.api('GET', `/api/projects/${projects[0]}/team-structure`);
    const fullAccess = await leader.api('PATCH', `/api/projects/${projects[0]}/team-orchestration`, {
      expectedVersion: latestStructure.json.settings.version, permissionLevel: 'full-access',
    });
    expect(fullAccess.status, JSON.stringify(fullAccess.json)).toBe(200);
    await teammate.app.distributed.transport.sync();
    const needsReconsent = await teammate.api('GET', `/api/projects/${projects[1]}/team-structure`);
    expect(needsReconsent.status, JSON.stringify(needsReconsent.json)).toBe(200);
    expect(needsReconsent.json.myConsent).toMatchObject({ state: 'needs-reconsent' });

    const reconsent = await teammate.api('POST', `/api/projects/${projects[1]}/team-consent`, {
      sessionIds: [join.json.sessionId, additionalSession.json.id], permissionLevel: 'full-access',
      settingsVersion: fullAccess.json.settings.version, disclaimerVersion: TEAM_CONSENT_DISCLAIMER_VERSION,
    });
    expect(reconsent.status, JSON.stringify(reconsent.json)).toBe(200);
    expect(reconsent.json).toMatchObject({ state: 'granted', permissionLevel: 'full-access' });
    await leader.app.distributed.transport.sync();
    expect(leader.app.store.getSession(sessionId)?.policy).toBe('full-access');
    expect(teammate.app.store.getSession(additionalSession.json.id)?.policy).toBe('full-access');
    expect(fullAccess.json.settings.permissionLevel).toBe('full-access');

    const assignmentTaskIds: string[] = [];
    const workerRuns: Array<{ baseRevision: string; worktreePath: string }> = [];
    const leadReviews: Array<{ head: string; html: string; css: string; workerAsked: boolean }> = [];
    const groupArtifactErrors: string[] = [];
    const hostToolErrors: string[] = [];
    const hostToolResults: Array<{ callId: string; ok: boolean; error?: string; result?: unknown }> = [];
    const artifactSecurityProbes: string[] = [];
    const originalGroupArtifact = leader.app.groups.artifact.bind(leader.app.groups);
    const importedArtifactProof = Reflect.get(leader.app.groups, 'importedTeamArtifactProof');
    const verifyImportedArtifact = Reflect.get(leader.app.groups, 'verifyImportedTeamArtifact');
    vi.spyOn(leader.app.groups, 'artifact').mockImplementation(async (...args) => {
      try {
        const [context, artifact] = args as unknown as [{ groupId: string; deliveryId: string }, { taskId?: string; path: string; revision: string }];
        if (artifact.path === 'index.html') {
          const activeDelivery = leader.app.groups.get(context.groupId).deliveries.find((item) => item.id === context.deliveryId);
          if (!activeDelivery?.runId) throw new Error('The active assignment delivery lost its run before artifact verification.');
          const source = leader.app.store.getSession(proxySessionId);
          if (!source) throw new Error('The team proxy session was not available for artifact verification.');
          const blob = runGit(source.worktreePath, 'rev-parse', '--verify', `${artifact.revision}:${artifact.path}`).trim();
          const proofInput = { groupId: context.groupId, deliveryId: context.deliveryId, runId: activeDelivery.runId,
            sessionId: proxySessionId, taskId: artifact.taskId ?? null, path: artifact.path, revision: artifact.revision,
            blob, worktreePath: source.worktreePath };
          const exactAccepted = await verifyImportedArtifact.call(leader.app.groups, proofInput);
          artifactSecurityProbes.push(exactAccepted ? 'exact-ref-revision-blob-accepted' : 'exact-ref-revision-blob-denied');
          for (const [name, changed] of [
            ['cross-task', { taskId: 'spoofed-task' }], ['wrong-path', { path: 'README.md' }],
            ['wrong-revision', { revision: 'f'.repeat(40) }],
            ['wrong-run', { runId: 'ended-or-other-run' }],
          ] as const) {
            const proof = importedArtifactProof.call(leader.app.groups, { ...proofInput, ...changed });
            artifactSecurityProbes.push(`${name}-${proof.failure ? 'denied' : 'accepted'}`);
          }
          const wrongBlobAccepted = await verifyImportedArtifact.call(leader.app.groups, { ...proofInput, blob: '0'.repeat(40) });
          artifactSecurityProbes.push(wrongBlobAccepted ? 'wrong-blob-accepted' : 'wrong-blob-denied');
          const transferRows = leader.app.store.db.prepare(`SELECT transfer_id,source_device_id,peer_device_id,owner_id,ref_name FROM mingle_git_team_artifacts
            WHERE team_id=? AND shared_project_id=? AND delivery_id=? AND direction='incoming' AND status='imported'`).all(join.json.teamId,
            join.json.sharedProjectId, context.deliveryId) as Array<{ transfer_id: string; source_device_id: string; peer_device_id: string; owner_id: string; ref_name: string | null }>;
          const transfer = transferRows.find((row) => row.source_device_id === teammate.app.distributed.transport.snapshot(join.json.teamId).deviceId
            && row.ref_name?.endsWith(`/${artifact.revision.toLowerCase()}`));
          if (!transfer) throw new Error('The imported exact-revision transfer record was not available for spoof checks.');
          leader.app.store.db.prepare('UPDATE mingle_git_team_artifacts SET ref_name=? WHERE transfer_id=?').run('refs/mingle/team/spoofed', transfer.transfer_id);
          try {
            const accepted = await verifyImportedArtifact.call(leader.app.groups, proofInput);
            artifactSecurityProbes.push(accepted ? 'spoofed-ref-accepted' : 'spoofed-ref-denied');
          } finally {
            leader.app.store.db.prepare('UPDATE mingle_git_team_artifacts SET ref_name=? WHERE transfer_id=?').run(transfer.ref_name, transfer.transfer_id);
          }
          for (const [column, original] of [['source_device_id', transfer.source_device_id], ['peer_device_id', transfer.peer_device_id],
            ['owner_id', transfer.owner_id]] as const) {
            leader.app.store.db.prepare(`UPDATE mingle_git_team_artifacts SET ${column}=? WHERE transfer_id=?`).run('spoofed-identity', transfer.transfer_id);
            try {
              const proof = importedArtifactProof.call(leader.app.groups, proofInput);
              artifactSecurityProbes.push(`${column}-spoof-${proof.failure ? 'denied' : 'accepted'}`);
            } finally {
              leader.app.store.db.prepare(`UPDATE mingle_git_team_artifacts SET ${column}=? WHERE transfer_id=?`).run(original, transfer.transfer_id);
            }
          }
          const deliveryRow = leader.app.store.db.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?').get(context.deliveryId) as { status: string } | undefined;
          if (!deliveryRow) throw new Error('The active host delivery record was unavailable for authorization probes.');
          leader.app.store.db.prepare("UPDATE mingle_team_host_deliveries SET status='completed' WHERE delivery_id=?").run(context.deliveryId);
          try {
            const accepted = await verifyImportedArtifact.call(leader.app.groups, proofInput);
            artifactSecurityProbes.push(accepted ? 'ended-delivery-accepted' : 'ended-delivery-denied');
          } finally {
            leader.app.store.db.prepare('UPDATE mingle_team_host_deliveries SET status=? WHERE delivery_id=?').run(deliveryRow.status, context.deliveryId);
          }
        }
        return await originalGroupArtifact(...args);
      } catch (error) {
        groupArtifactErrors.push(error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
    const hostTeamMcp = Reflect.get(leader.app.teamOrchestration.host, 'options').teamMcp;
    const originalRemoteCall = hostTeamMcp.callRemote.bind(hostTeamMcp);
    vi.spyOn(hostTeamMcp, 'callRemote').mockImplementation(async (...args: any[]) => {
      try { return await originalRemoteCall(...args); }
      catch (error) {
        hostToolErrors.push(error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
    const originalHostSend = leader.app.distributed.transport.send.bind(leader.app.distributed.transport);
    vi.spyOn(leader.app.distributed.transport, 'send').mockImplementation(async (input: any) => {
      if (input.kind === 'teamgroup.tool.result') hostToolResults.push(input.payload);
      return originalHostSend(input);
    });
    let orchestratorAssignments = 0;
    leader.fake.script = async (options, emit) => {
      if (options.session.id !== sessionId) { emit({ type: 'text', text: 'Unrelated local turn.' }); return; }
      if (!options.teamMcp) throw new Error('The local orchestrator did not receive the host Team MCP connection.');
      const roster = await callTeamTool(options.teamMcp, 'team_members');
      if (roster.role !== 'orchestrator' || roster.canAssign !== true || !roster.members.some((member: { handle: string }) => member.handle === secondAgent.handle)) {
        throw new Error('The host orchestrator could not see the remote worker in its team tools.');
      }
      if (orchestratorAssignments === 0) {
        const assigned = await callTeamTool(options.teamMcp, 'team_assign', {
          recipient: secondAgent.handle, title: 'Build the static landing page',
          objective: 'Build the small static landing page requested by the user.',
          acceptanceCriteria: 'index.html and styles.css are committed and provide a responsive landing page.',
          scope: ['index.html', 'styles.css'],
        });
        assignmentTaskIds.push(assigned.taskId);
        orchestratorAssignments += 1;
        emit({ type: 'text', text: 'I planned the task and delegated the landing page to the teammate’s agent.' });
        return;
      }
      if (orchestratorAssignments === 1) {
        const inbox = await callTeamTool(options.teamMcp, 'team_inbox');
        const workspace = options.session.worktreePath;
        const workerQuestion = inbox.messages.find((message: { content: string }) => message.content.includes('Should the primary button use mint or amber?'));
        if (workerQuestion && !existsSync(path.join(workspace, 'index.html'))) {
          await callTeamTool(options.teamMcp, 'team_message', {
            recipient: secondAgent.handle, content: 'Use a mint primary accent with an amber hover state.',
            replyToId: workerQuestion.id, expectsReply: false,
          });
          emit({ type: 'text', text: 'Answered the worker’s design question while its assignment is still running.' });
          return;
        }
        const html = readFileSync(path.join(workspace, 'index.html'), 'utf8');
        const css = readFileSync(path.join(workspace, 'styles.css'), 'utf8');
        const head = runGit(workspace, 'rev-parse', '--verify', 'HEAD').trim();
        leadReviews.push({ head, html, css, workerAsked: inbox.messages.some((message: { content: string }) => message.content.includes('ready for review')) });
        if (!html.includes('Welcome to Northstar') || !css.includes('.hero')) throw new Error('The remote files were not integrated before orchestrator review.');
        const assigned = await callTeamTool(options.teamMcp, 'team_assign', {
          recipient: firstHostAgent.handle, title: 'Polish the landing page button',
          objective: 'Add a visible hover treatment to the primary landing-page button.',
          acceptanceCriteria: 'The primary button has an accessible, visible hover treatment in styles.css.',
          scope: ['styles.css'], dependsOn: [assignmentTaskIds[0]!],
          inputArtifacts: [{ taskId: assignmentTaskIds[0]!, path: 'index.html' }],
        });
        assignmentTaskIds.push(assigned.taskId);
        orchestratorAssignments += 1;
        emit({ type: 'text', text: 'I reviewed the delivered files in the host workspace and requested a focused CSS fix.' });
        return;
      }
      const html = readFileSync(path.join(options.session.worktreePath, 'index.html'), 'utf8');
      const css = readFileSync(path.join(options.session.worktreePath, 'styles.css'), 'utf8');
      if (!css.includes('.hero__cta:hover')) throw new Error('The follow-up fix did not arrive in the host group workspace.');
      emit({ type: 'text', text: `The landing page is integrated in the host group workspace. It includes ${html.includes('Northstar') ? 'the Northstar page' : 'the requested page'} and the reviewed button fix.` });
    };

    teammate.fake.runs.length = 0;
    teammate.fake.script = async (options, emit) => {
      const runIndex = workerRuns.length;
      const taskId = assignmentTaskIds[runIndex];
      if (!taskId || !options.teamMcp) throw new Error('The remote worker did not receive its assignment task or Team MCP connection.');
      const workerView = await callTeamTool(options.teamMcp, 'team_members');
      if (workerView.role !== 'worker' || workerView.canAssign !== false) throw new Error('The remote worker has incorrect Team MCP role metadata.');
      await callTeamTool(options.teamMcp, 'team_status', { taskId, status: 'running', note: 'Starting the assigned landing-page work.' });
      const worktreePath = options.session.worktreePath;
      const baseRevision = runGit(worktreePath, 'rev-parse', '--verify', 'HEAD').trim();
      if (runIndex === 0) {
        const question = await callTeamTool(options.teamMcp, 'team_message', {
          recipient: hostOwnMember.handle, content: 'Should the primary button use mint or amber?', expectsReply: true,
        });
        if (!question.wakesRecipient) throw new Error('A genuine worker question did not wake the idle coordinator.');
        const answer = await waitFor(async () => {
          const inbox = await callTeamTool(options.teamMcp!, 'team_inbox');
          return inbox.messages.some((message: { content: string }) => message.content.includes('Use a mint primary accent')) ? inbox : null;
        }, 5_000, 'the coordinator to answer the active worker question');
        if (!answer) throw new Error('The worker did not receive the coordinator’s answer during active work.');
        writeFileSync(path.join(worktreePath, 'index.html'), '<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Northstar</title><link rel="stylesheet" href="styles.css"><main class="hero"><h1>Welcome to Northstar</h1><p>Make your next idea real.</p><a class="hero__cta" href="#start">Get started</a></main></html>\n');
        writeFileSync(path.join(worktreePath, 'styles.css'), 'body{margin:0;font:16px system-ui;background:#101820;color:#f8fafc}.hero{min-height:100vh;display:grid;place-content:center;gap:1rem;padding:2rem;text-align:center}.hero__cta{justify-self:center;padding:.8rem 1.2rem;border-radius:.5rem;background:#72d6c9;color:#10202a;text-decoration:none}\n');
      } else {
        const html = readFileSync(path.join(worktreePath, 'index.html'), 'utf8');
        const currentCss = readFileSync(path.join(worktreePath, 'styles.css'), 'utf8');
        if (!html.includes('Welcome to Northstar') || !currentCss.includes('.hero__cta')) throw new Error('The follow-up worker did not start from the integrated host state.');
        writeFileSync(path.join(worktreePath, 'styles.css'), `${currentCss}\n.hero__cta:hover{background:#f4bd50;transform:translateY(-2px)}\n`);
      }
      const artifactPaths = runIndex === 0 ? ['index.html', 'styles.css'] : ['styles.css'];
      runGit(worktreePath, 'add', '--', ...artifactPaths);
      runGit(worktreePath, 'commit', '-m', `Commit scoped assignment ${runIndex + 1}`);
      const artifactRevision = runGit(worktreePath, 'rev-parse', '--verify', 'HEAD').trim();
      for (const artifactPath of artifactPaths) {
        const published = await callTeamTool(options.teamMcp, 'team_artifact', {
          recipient: runIndex === 0 ? firstHostAgent.handle : hostOwnMember.handle,
          path: artifactPath, revision: artifactRevision, taskId,
          note: 'Committed handoff for the active assignment.',
        });
        if (!published.artifactId || published.revision !== artifactRevision || published.path !== artifactPath || published.taskId !== taskId) {
          throw new Error(`The active assignment artifact ${artifactPath} was not verified and recorded before provider completion.`);
        }
      }
      workerRuns.push({ baseRevision, worktreePath });
      await callTeamTool(options.teamMcp, 'team_status', { taskId, status: 'review', note: 'Committed assignment artifacts are transferred; the host will integrate them after this run ends.' });
      const assignmentsBeforeReplyRequest = orchestratorAssignments;
      const reviewsBeforeReplyRequest = leadReviews.length;
      await callTeamTool(options.teamMcp, 'team_message', {
        recipient: hostOwnMember.handle, content: 'The landing page is ready for review; please inspect the integrated files and send any focused fixes.', expectsReply: true,
      });
      // Deliberately leave a window after both tools returned but before the provider turn ends.
      // The coordinator must not inspect the host workspace until this remote completion is imported.
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (orchestratorAssignments !== assignmentsBeforeReplyRequest || leadReviews.length !== reviewsBeforeReplyRequest) {
        throw new Error('The coordinator was woken to review before the remote worker delivery completed.');
      }
      emit({ type: 'text', text: `Created and committed the ${runIndex === 0 ? 'landing page' : 'requested button fix'}; published its scoped artifacts before completion.` });
    };

    const request = await leader.api('POST', `/api/groups/${teamGroupId}/messages`, {
      content: 'Build a small static landing website with index.html and styles.css. You are the orchestrator: plan, delegate the implementation to the teammate agent, review what they deliver, ask for fixes, and summarise.',
    });
    expect(request.status, JSON.stringify(request.json)).toBe(202);
    try {
      // These assignments run sequentially: the second depends on the first's
      // committed artifacts and coordinator review. Keep a bounded deadline for
      // each worker rather than charging both workflows to one worker's budget.
      for (const expectedWorkerRuns of [1, 2]) {
        await waitFor(async () => {
          await teammate.app.distributed.transport.sync();
          await leader.app.distributed.transport.sync();
          return workerRuns.length >= expectedWorkerRuns;
        }, 15_000, `delegated remote worker run ${expectedWorkerRuns}`);
      }
    } catch (error) {
      const current = leader.app.groups.get(teamGroupId);
      const activeAssignment = current.assignments.find((assignment) => assignment.taskId === assignmentTaskIds[0]);
      const diagnostics = {
        workerRuns: workerRuns.length,
        leaderRuns: leader.fake.runs.length,
        teammateRuns: teammate.fake.runs.length,
        recentToolTimings: toolTimings.slice(-8).map(({ name, startedAt, repliedAt, closedAt }) => ({ name,
          elapsedMs: Date.now() - startedAt, replyMs: repliedAt === undefined ? null : repliedAt - startedAt,
          closeMs: closedAt === undefined ? null : closedAt - startedAt })),
        ownerToolInbox: teammate.app.store.db.prepare(`SELECT idempotency_key,status,error FROM mingle_transport_inbox
          WHERE kind='teamgroup.tool.result' ORDER BY received_at DESC LIMIT 3`).all(),
        hostToolOutbox: leader.app.store.db.prepare(`SELECT idempotency_key,status,error FROM mingle_transport_outbox
          WHERE kind='teamgroup.tool.result' ORDER BY created_at DESC LIMIT 3`).all(),
        ownerToolOutbox: teammate.app.store.db.prepare(`SELECT idempotency_key,status,error FROM mingle_transport_outbox
          WHERE kind='teamgroup.tool.call' ORDER BY created_at DESC LIMIT 3`).all(),
        hostDeliveries: leader.app.store.db.prepare(`SELECT delivery_id,status,failure_json FROM mingle_team_host_deliveries WHERE shared_project_id=?`)
          .all(join.json.sharedProjectId),
        ownerDeliveries: teammate.app.store.db.prepare(`SELECT delivery_id,status,error,json_extract(request_json,'$.inputArtifacts') AS inputs
          FROM mingle_team_device_deliveries WHERE shared_project_id=?`).all(join.json.sharedProjectId),
        inputTransfers: leader.app.store.db.prepare(`SELECT delivery_id,status,retry_error AS error,json_extract(offer_json,'$.purpose') AS purpose
          FROM mingle_git_team_artifacts WHERE shared_project_id=? AND direction='outgoing'`).all(join.json.sharedProjectId),
        assignments: current.assignments.map(({ deliveryId, taskId, scope, toMemberId }) => ({ deliveryId, taskId, scope, toMemberId })),
        groupArtifacts: leader.app.store.db.prepare(`SELECT a.group_id,a.from_member_id,a.to_member_id,a.task_id,a.path,a.commit_id
          FROM group_artifacts a WHERE a.group_id=? ORDER BY a.created_at`).all(teamGroupId),
        assignmentInputs: leader.app.store.db.prepare(`SELECT a.id AS assignment_id,a.task_id,a.to_member_id,i.task_id AS input_task_id,i.path,i.artifact_id
          FROM group_assignments a JOIN group_assignment_inputs i ON i.assignment_id=a.id WHERE a.group_id=?`).all(teamGroupId),
        deliveries: current.deliveries.map(({ id, kind, status, runId, error: message, memberId }) => ({ id, kind, status, runId, error: message, memberId })),
        tasks: leader.app.store.listTasks(projects[0]).map(({ id, title, status }) => ({ id, title, status })),
        hostDelivery: activeAssignment ? leader.app.store.db.prepare(`SELECT delivery_id,status,run_id,agent_id,owner_account_id,owner_device_id,session_id
          FROM mingle_team_host_deliveries WHERE delivery_id=?`).get(activeAssignment.deliveryId) : null,
        hostArtifactAuthority: activeAssignment ? leader.app.store.db.prepare(`SELECT d.status,d.run_id,d.group_id,d.agent_id,d.owner_account_id,d.owner_device_id,
            p.host_device_id,p.owner_account_id AS host_owner,r.agent_id AS roster_agent_id,r.removed_at,c.state,c.owner_account_id AS consent_owner,c.owner_device_id AS consent_device
          FROM mingle_team_host_deliveries d JOIN mingle_team_host_projects p ON p.team_id=d.team_id AND p.shared_project_id=d.shared_project_id
          LEFT JOIN mingle_team_host_roster r ON r.team_id=d.team_id AND r.shared_project_id=d.shared_project_id AND r.agent_id=d.agent_id
          LEFT JOIN mingle_team_host_consents c ON c.team_id=d.team_id AND c.shared_project_id=d.shared_project_id AND c.agent_id=d.agent_id
          WHERE d.delivery_id=?`).get(activeAssignment.deliveryId) : null,
        hostProxy: leader.app.store.db.prepare(`SELECT team_id,shared_project_id,agent_id,owner_account_id,owner_device_id
          FROM mingle_team_proxy_sessions WHERE session_id=?`).get(proxySessionId),
        hostConsent: leader.app.store.db.prepare(`SELECT state,owner_account_id,owner_device_id FROM mingle_team_host_consents
          WHERE team_id=? AND shared_project_id=? AND agent_id=?`).get(join.json.teamId, join.json.sharedProjectId, secondAgentId),
        hostRoster: leader.app.store.db.prepare(`SELECT agent_id,removed_at FROM mingle_team_host_roster
          WHERE team_id=? AND shared_project_id=? AND agent_id=?`).get(join.json.teamId, join.json.sharedProjectId, secondAgentId),
        importedTransfers: activeAssignment ? leader.app.store.db.prepare(`SELECT transfer_id,source_device_id,peer_device_id,owner_id,status,offer_json
          FROM mingle_git_team_artifacts WHERE team_id=? AND shared_project_id=? AND delivery_id=? AND direction='incoming'`)
          .all(join.json.teamId, join.json.sharedProjectId, activeAssignment.deliveryId) : [],
        groupArtifactErrors,
        hostToolErrors,
        hostToolResults: hostToolResults.map((result) => ({ callId: result.callId, ok: result.ok, error: result.error })),
        artifactSecurityProbes,
        proxySession: leader.app.store.getSession(proxySessionId),
        proxyMessages: leader.app.store.listMessages(proxySessionId, { limit: 30 }).map(({ role, kind, runId, content }) => ({ role, kind, runId, content: content.slice(0, 500) })),
        ownerMessages: teammate.app.store.listMessages(additionalSession.json.id, { limit: 30 }).map(({ role, kind, runId, content }) => ({ role, kind, runId, content: content.slice(0, 500) })),
      };
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nAcceptance diagnostics: ${JSON.stringify(diagnostics).slice(0, 10_000)}`);
    }
    await waitFor(() => orchestratorAssignments === 2 && leader.fake.runs.length === 4, 15_000, 'one active-work question answer, one review/fix turn, and one final summary');
    await waitFor(() => leader.app.groups.get(teamGroupId).requests.some((item) => item.status === 'completed'), 15_000, 'completed cross-device group request');

    expect(groupArtifactErrors).toEqual([]);
    expect(hostToolErrors).toEqual([]);
    const publishedArtifactResults = hostToolResults.filter((result) => result.ok && result.result && typeof result.result === 'object'
      && 'artifactId' in result.result).map((result) => result.result as { path: string; revision: string; taskId: string });
    expect(publishedArtifactResults.map(({ path, taskId }) => ({ path, taskId }))).toEqual([
      { path: 'index.html', taskId: assignmentTaskIds[0] },
      { path: 'styles.css', taskId: assignmentTaskIds[0] },
      { path: 'styles.css', taskId: assignmentTaskIds[1] },
    ]);
    expect(artifactSecurityProbes).toEqual([
      'exact-ref-revision-blob-accepted', 'cross-task-denied', 'wrong-path-denied', 'wrong-revision-denied', 'wrong-run-denied',
      'wrong-blob-denied', 'spoofed-ref-denied', 'source_device_id-spoof-denied', 'peer_device_id-spoof-denied',
      'owner_id-spoof-denied', 'ended-delivery-denied',
    ]);

    const firstWorkerRevision = runGit(workerRuns[0]!.worktreePath, 'rev-parse', '--verify', 'HEAD').trim();
    const secondWorkerRevision = runGit(workerRuns[1]!.worktreePath, 'rev-parse', '--verify', 'HEAD').trim();
    expect(workerRuns[1]!.baseRevision).toBe(firstWorkerRevision);
    const successorAssignment = leader.app.groups.get(teamGroupId).assignments.find((assignment) => assignment.taskId === assignmentTaskIds[1])!;
    const ownerDelivery = teammate.app.store.db.prepare(`SELECT request_json FROM mingle_team_device_deliveries WHERE delivery_id=?`)
      .get(successorAssignment.deliveryId) as { request_json: string };
    const ownerDeliveryPayload = JSON.parse(ownerDelivery.request_json) as { baseRevision: string; inputArtifacts: Array<Record<string, unknown>> };
    expect(ownerDeliveryPayload.baseRevision).toBe(firstWorkerRevision);
    expect(ownerDeliveryPayload.inputArtifacts).toHaveLength(2);
    expect(ownerDeliveryPayload.inputArtifacts).toEqual(expect.arrayContaining([expect.objectContaining({
      revision: firstWorkerRevision, path: 'index.html', taskId: assignmentTaskIds[0], transferId: expect.any(String), ref: expect.any(String),
    }), expect.objectContaining({
      revision: firstWorkerRevision, path: 'styles.css', taskId: assignmentTaskIds[0], transferId: expect.any(String), ref: expect.any(String),
    })]));
    const forwardedInputOffers = leader.app.store.db.prepare(`SELECT offer_json FROM mingle_git_team_artifacts
      WHERE team_id=? AND shared_project_id=? AND delivery_id=? AND direction='outgoing'`)
      .all(join.json.teamId, join.json.sharedProjectId, successorAssignment.deliveryId) as Array<{ offer_json: string }>;
    expect(forwardedInputOffers.map((row) => JSON.parse(row.offer_json))).toContainEqual(expect.objectContaining({
      purpose: 'input', revision: firstWorkerRevision, path: 'index.html', taskId: assignmentTaskIds[0],
    }));
    expect(leadReviews).toHaveLength(1);
    expect(leadReviews[0]).toMatchObject({ head: firstWorkerRevision, workerAsked: true });
    expect(leadReviews[0]!.html).toContain('Welcome to Northstar');
    expect(leadReviews[0]!.css).toContain('.hero__cta');
    const groupWorkspace = leader.app.store.getSession(sessionId)!.worktreePath;
    expect(runGit(groupWorkspace, 'rev-parse', '--verify', 'HEAD').trim()).toBe(secondWorkerRevision);
    expect(readFileSync(path.join(groupWorkspace, 'index.html'), 'utf8')).toContain('Welcome to Northstar');
    expect(readFileSync(path.join(groupWorkspace, 'styles.css'), 'utf8')).toContain('.hero__cta:hover');
    expect(teammate.fake.runs).toHaveLength(2);
    expect(leader.fake.runs).toHaveLength(4);

    const remoteProxyIds = new Set([proxySessionId, firstProxySessionId]);
    const completedRemoteRuns = leader.app.store.bootstrapRuns().filter((run) => remoteProxyIds.has(run.sessionId) && run.status === 'completed')
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
    expect(completedRemoteRuns).toHaveLength(2);
    expect(completedRemoteRuns[0]!.changes?.files.map((file) => file.path)).toEqual(['index.html', 'styles.css']);
    expect(completedRemoteRuns[1]!.changes?.files.map((file) => file.path)).toEqual(['styles.css']);
    const remoteProxyMessages = [...remoteProxyIds].flatMap((remoteProxyId) => leader.app.store.listMessages(remoteProxyId, { limit: 20 }))
      .filter((message) => message.role === 'assistant');
    expect(remoteProxyMessages.some((message) => message.content.includes('published its scoped artifacts before completion'))).toBe(true);
    expect(remoteProxyMessages.some((message) => message.content.includes('Integrated into the host group workspace')
      && message.content.includes('index.html') && message.content.includes('styles.css'))).toBe(true);

    await waitFor(async () => {
      await teammate.app.distributed.transport.sync();
      const transcript = await teammate.api('GET', `/api/projects/${projects[1]}/team-chat?limit=50`);
      return transcript.json.messages.find((message: { author: { kind: string }; body: string }) => message.author.kind === 'agent'
        && message.body.includes('The landing page is integrated in the host group workspace.'));
    }, 10_000, 'member-device shared team session result');
    await waitFor(async () => {
      await teammate.app.distributed.transport.sync();
      const transcript = await teammate.api('GET', `/api/projects/${projects[1]}/team-chat?limit=50`);
      return transcript.json.messages.find((message: { author: { kind: string; agentId?: string }; body: string }) =>
        message.author.kind === 'agent' && message.author.agentId === secondAgentId
        && message.body.includes('published its scoped artifacts before completion'));
    }, 10_000, 'member-device remote worker reply');

    // Route through the real member chat service, rather than the leader's group composer.
    // The host must complete notification without trying to sign as this remote owner.
    teammate.fake.script = async (_options, emit) => { emit({ type: 'text', text: 'Owner-signed direct remote completion.' }); };
    const direct = await teammate.api('POST', `/api/projects/${projects[1]}/team-chat/messages`, {
      body: 'Reply once from your owner device; no edits or commands.', mentions: [teammateAgentId],
    });
    expect(direct.status, JSON.stringify(direct.json)).toBe(200);
    const completedDirect = await waitFor(async () => {
      await leader.app.distributed.transport.sync();
      await teammate.app.distributed.transport.sync();
      const delivery = leader.app.store.db.prepare(`SELECT delivery_id,status,failure_json FROM mingle_team_host_deliveries WHERE source_chat_message_id=?`)
        .get(direct.json.id) as { delivery_id: string; status: string; failure_json: string | null } | undefined;
      const transcript = await leader.api('GET', `/api/projects/${projects[0]}/team-chat?limit=100`);
      const reply = transcript.json.messages.find((message: { body: string }) => message.body === 'Owner-signed direct remote completion.');
      return delivery?.status === 'completed' && delivery.failure_json === null && reply ? { delivery, reply } : null;
    }, 10_000, 'owner-signed direct reply and completed host notification');
    await waitFor(() => teammate.app.store.db.prepare('SELECT run_state FROM team_chat_messages WHERE id=?').get(direct.json.id)
      ?.run_state === 'completed', 10_000, 'member-visible direct-message completion state');
    expect(completedDirect.reply.author).toMatchObject({ kind: 'agent', agentId: teammateAgentId, ownerAccountId: users[1]!.id });
    expect(completedDirect.reply.authorDeviceId).toBe(teammate.app.distributed.transport.snapshot(join.json.teamId).deviceId);
    expect(completedDirect.reply.authorSignature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(leader.app.store.db.prepare('SELECT run_state FROM team_chat_messages WHERE id=?').get(direct.json.id)).toMatchObject({ run_state: 'completed' });
    expect(teammate.app.store.db.prepare('SELECT run_state FROM team_chat_messages WHERE id=?').get(direct.json.id)).toMatchObject({ run_state: 'completed' });
    expect(leader.app.store.db.prepare('SELECT COUNT(*) AS count FROM team_chat_messages WHERE body=?').get('Owner-signed direct remote completion.')).toEqual({ count: 1 });
  } finally {
    while (apps.length) await apps.pop()!.cleanup();
    vi.restoreAllMocks();
    for (const repository of repositories) rmSync(repository, { recursive: true, force: true });
    await cloud.close();
  }
}, 60_000);
