import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import {
  TEAM_CONSENT_DISCLAIMER_VERSION, TeamDeliveryPayloadSchema, TeamStructurePayloadSchema,
  type GroupSnapshot, type Session,
} from '@mingle/contracts';
import { openDatabase } from '../../db.ts';
import { Store } from '../../store.ts';
import { makeRepo } from '../../test-utils.ts';
import { TeamOrchestrationHost } from './service.ts';

const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const OWNER = '10000000-0000-4000-8000-000000000002';
const TEAM = '20000000-0000-4000-8000-000000000001';
const SHARED = '30000000-0000-4000-8000-000000000001';
const DEVICE = '40000000-0000-4000-8000-000000000001';
const OWNER_DEVICE = '40000000-0000-4000-8000-000000000002';
const PROJECT = 'team-host-test-project';
const LOCAL_AGENT = 'local-published-agent';
const REMOTE_AGENT = 'remote-published-agent';

const fixtures: Array<{ close(): Promise<void> }> = [];
const paths: string[] = [];
afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.close();
  while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true });
});

function fixture(options: { deviceId?: string; role?: 'leader' | 'admin' | 'member'; deliveryTimeoutMs?: number; now?: () => number } = {}) {
  const store = new Store(openDatabase(':memory:'));
  const repo = makeRepo();
  paths.push(repo);
  const project = store.insertProject({ id: PROJECT, name: 'Shared host fixture', path: repo });
  const local = store.insertSession({ projectId: PROJECT, id: LOCAL_AGENT, name: 'Local Claude', provider: 'claude', model: 'claude-sonnet-5-5',
    effort: 'high', policy: 'supervised', isolated: false, worktreePath: repo, branch: null });
  store.db.exec(`CREATE TABLE mingle_project_collaboration_sources (
    local_project_id TEXT,owner_id TEXT,team_id TEXT,shared_project_id TEXT,leader_device_id TEXT,leader_fingerprint TEXT
  ); CREATE TABLE mingle_project_collaboration_joins (
    local_project_id TEXT,account_id TEXT,team_id TEXT,shared_project_id TEXT,device_id TEXT
  );`);
  store.db.prepare('INSERT INTO mingle_project_collaboration_sources VALUES(?,?,?,?,?,?)').run(PROJECT, ACCOUNT, TEAM, SHARED, DEVICE, 'fingerprint');

  const agents = [
    { id: LOCAL_AGENT, name: 'Local Claude', accountId: ACCOUNT, deviceId: DEVICE, projectId: PROJECT, sessionId: LOCAL_AGENT, provider: 'claude', model: local.model, state: 'idle' },
    { id: REMOTE_AGENT, name: 'Remote Codex', accountId: OWNER, deviceId: OWNER_DEVICE, projectId: PROJECT, sessionId: 'owner-session-remote', provider: 'codex', model: 'gpt-6-codex', state: 'idle' },
  ];
  let role = options.role ?? 'leader';
  const collaboration = {
    async snapshot() {
      return {
        project: { teamId: TEAM, sharedProjectId: SHARED, name: 'Shared host fixture', repositoryUrl: 'https://example.test/shared.git' },
        members: [
          { accountId: ACCOUNT, displayName: 'Lead Ada', email: null, role, status: 'active' },
          { accountId: OWNER, displayName: 'Owner Sam', email: null, role: 'member', status: 'active' },
        ],
        agents, invitations: [], email: { configured: false },
      };
    },
  };
  const outgoing: Array<{ teamId: string; toDeviceId: string; kind: string; payload: unknown; idempotencyKey: string }> = [];
  const artifactImports: unknown[] = [];
  const teamGit = {
    async exportTeamArtifact(input: any) { return { revision: input.revision, transferId: 'host-input-transfer', ref: `refs/mingle/team/input/${input.revision}`, ...(input.path ? { path: input.path } : {}), ...(input.taskId ? { taskId: input.taskId } : {}) }; },
    async importTeamArtifact(input: any) {
      artifactImports.push(input);
      return { ...input.artifact, ref: `refs/mingle/team/${input.sharedProjectId}/${input.deliveryId}/${input.artifact.revision}` };
    },
  };
  let receive: ((envelope: any) => Promise<void>) | null = null;
  let localDeviceId = options.deviceId ?? DEVICE;
  const transport = {
    snapshot: () => ({ deviceId: localDeviceId, status: 'ready', error: null,
      devices: [
        { id: DEVICE, teamId: TEAM, ownerId: ACCOUNT, name: 'Host device', fingerprint: 'host-fingerprint', signingPublicKey: '', encryptionPublicKey: '', lastSeenAt: new Date().toISOString(), revokedAt: null, createdAt: new Date().toISOString(), status: 'online' },
        { id: OWNER_DEVICE, teamId: TEAM, ownerId: OWNER, name: 'Owner device', fingerprint: 'owner-fingerprint', signingPublicKey: '', encryptionPublicKey: '', lastSeenAt: new Date().toISOString(), revokedAt: null, createdAt: new Date().toISOString(), status: 'online' },
      ],
      links: [
        { teamId: TEAM, deviceId: DEVICE, peerDeviceId: OWNER_DEVICE, peerFingerprint: 'owner-fingerprint', createdAt: new Date().toISOString(), mutual: true },
        { teamId: TEAM, deviceId: OWNER_DEVICE, peerDeviceId: DEVICE, peerFingerprint: 'host-fingerprint', createdAt: new Date().toISOString(), mutual: true },
      ], outbox: [] }),
    async send(input: typeof outgoing[number]) { outgoing.push(input); return `envelope-${outgoing.length}`; },
    async sync() {},
    onMessage(handler: (message: any) => Promise<void>) { receive = handler; return () => { receive = null; }; },
  };
  const account = {
    async withAuthenticatedClient<T>(callback: (client: SupabaseClient, user: User) => Promise<T>) {
      const cloud = {
        from(table: string) {
          const filters = new Map<string, unknown>();
          const builder: any = {
            select() { return builder; }, eq(key: string, value: unknown) { filters.set(key, value); return builder; },
            is() { return builder; },
            maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
            then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
              return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
            },
          };
          const rows = () => {
            if (table === 'mingle_devices') return [
              { id: DEVICE, owner_id: ACCOUNT, revoked_at: null }, { id: OWNER_DEVICE, owner_id: OWNER, revoked_at: null },
            ].filter((row) => (!filters.has('id') || filters.get('id') === row.id) && (!filters.has('team_id') || filters.get('team_id') === TEAM));
            if (table === 'mingle_members') return [ACCOUNT, OWNER].filter((id) => id === filters.get('user_id')).map((user_id) => ({ user_id }));
            return [];
          };
          return builder;
        },
      };
      const user = { id: ACCOUNT, email: 'lead@example.test', aud: 'authenticated', created_at: '2026-01-01T00:00:00Z', app_metadata: {}, user_metadata: {} } as unknown as User;
      return callback(cloud as unknown as SupabaseClient, user);
    },
  };
  let group: GroupSnapshot | null = null;
  const finished: Array<{ sessionId: string; runId: string; outcome: string }> = [];
  const enqueued: Array<{ content: string; recipients?: string[]; clientMessageId: string }> = [];
  const groupService = {
    createTeamGroup(input: { id: string; projectId: string; title: string; orchestratorSessionId: string; members: Array<{ sessionId: string; handle: string; role: 'orchestrator' | 'worker' | 'idle'; held: boolean }> }) {
      const members = input.members.map((member) => ({ id: `member-${member.sessionId}`, groupId: input.id, sessionId: member.sessionId,
        handle: member.handle, role: member.role === 'orchestrator' ? 'orchestrator' as const : 'worker' as const, held: member.held, joinedAt: new Date().toISOString(), removedAt: null }));
      group = { group: { id: input.id, projectId: input.projectId, title: input.title, anchorSessionId: input.orchestratorSessionId, mode: 'orchestrated',
        orchestratorMemberId: members.find((member) => member.sessionId === input.orchestratorSessionId)?.id ?? null, paused: false, pauseReason: null, maxParallel: 2, maxTurns: 80, maxHops: 6, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        members, deliveries: [], requests: [], messages: [], assignments: [] };
      return group;
    },
    syncTeamMembers(_groupId: string, members: Array<{ sessionId: string; handle: string; role: 'orchestrator' | 'worker' | 'idle'; held: boolean }>) {
      if (!group) return;
      group.members = members.map((member) => ({ id: `member-${member.sessionId}`, groupId: group!.group.id, sessionId: member.sessionId,
        handle: member.handle, role: member.role === 'orchestrator' ? 'orchestrator' as const : 'worker' as const, held: member.held, joinedAt: new Date().toISOString(), removedAt: null }));
      group.group.orchestratorMemberId = group.members.find((member) => member.role === 'orchestrator')?.id ?? null;
    },
    get() { if (!group) throw new Error('No group'); return group; },
    setTeamLeader(_groupId: string, sessionId: string | null, options: { paused?: boolean } = {}) {
      if (!group) return;
      group.group.orchestratorMemberId = sessionId ? group.members.find((member) => member.sessionId === sessionId)?.id ?? null : null;
      group.group.paused = options.paused ?? !sessionId;
      for (const member of group.members) member.role = member.sessionId === sessionId ? 'orchestrator' : 'worker';
    },
    pauseTeamGroup() { if (group) group.group.paused = true; },
    sendTeamMessage(_groupId: string, input: typeof enqueued[number]) { enqueued.push(input); return [`host-chat-delivery-${enqueued.length}`]; },
    onRunFinished(sessionId: string, runId: string, outcome: string) {
      finished.push({ sessionId, runId, outcome });
      const delivery = group?.deliveries.find((entry) => entry.runId === runId);
      if (delivery && (outcome === 'completed' || outcome === 'failed' || outcome === 'interrupted')) delivery.status = outcome;
    },
    setTeamDispatchGuard() {}, setTeamRunFinishedHook() {}, holdTeamMember() {},
    contextForRun() { return undefined; },
  };
  const teamMcp = {
    create() { return { url: 'http://127.0.0.1/api/team/mcp', token: 'unused-token' }; },
    revoke() {},
    async callRemote(_runId: string, _sessionId: string, tool: string) { return { tool, actual: true }; },
  };
  const recovery = { recordFailure() {}, clearFailure() {} };
  const host = new TeamOrchestrationHost({ store, git: teamGit as any, account: account as any, transport: transport as any, authorizeTeam: async () => undefined,
    collaboration: collaboration as any, groups: groupService as any, teamMcp: teamMcp as any, recovery: recovery as any,
    deliveryTimeoutMs: options.deliveryTimeoutMs ?? 60_000, now: options.now });
  const fx = {
    store, project, local, host, outgoing, finished, enqueued, artifactImports, group: () => group, setRole(value: typeof role) { role = value; },
     setDevice(deviceId: string) { localDeviceId = deviceId; },
     async incoming(kind: string, payload: unknown, fromDeviceId = OWNER_DEVICE) {
      if (!receive) throw new Error('No team orchestration transport handler');
      return receive({ id: randomUUID(), teamId: TEAM, fromDeviceId, toDeviceId: options.deviceId ?? DEVICE, kind, payload });
    },
    async close() { await host.close(); store.db.close(); },
  };
  fixtures.push(fx);
  return fx;
}

const enableInput = (orchestratorAgentId = LOCAL_AGENT) => ({ leaderOrchestration: true, permissionLevel: 'supervised', orchestratorAgentId,
  fallbackAgentIds: orchestratorAgentId === LOCAL_AGENT ? [] : [LOCAL_AGENT] });

async function grantRemote(fx: ReturnType<typeof fixture>): Promise<void> {
  await fx.incoming('teamgroup.consent', {
    sharedProjectId: SHARED, agentIds: [REMOTE_AGENT], permissionLevel: 'supervised', settingsVersion: 1,
    disclaimerVersion: TEAM_CONSENT_DISCLAIMER_VERSION, state: 'granted', at: new Date().toISOString(),
  });
}

it('authorizes host changes, enforces optimistic versions, validates broadcasts, and routes chat without starting inference', async () => {
  const fx = fixture();
  const enabled = await fx.host.enable(PROJECT, enableInput());
  expect(enabled.settings?.version).toBe(1);
  const broadcast = fx.outgoing.find((entry) => entry.kind === 'teamgroup.structure');
  expect(TeamStructurePayloadSchema.safeParse(broadcast?.payload).success).toBe(true);
  await expect(fx.host.update(PROJECT, { expectedVersion: 99, leaderOrchestration: false })).rejects.toMatchObject({ status: 409 });

  const denied = fixture({ role: 'member' });
  await expect(denied.host.enable(PROJECT, enableInput())).rejects.toMatchObject({ status: 403 });
  const wrongDevice = fixture({ deviceId: OWNER_DEVICE });
  await expect(wrongDevice.host.enable(PROJECT, enableInput())).rejects.toMatchObject({ status: 403 });

  const routed = await fx.host.routeTeamChatMessage(PROJECT, {
    id: 'chat-untagged', teamId: TEAM, sharedProjectId: SHARED, body: 'Plan a fix', mentions: [],
    author: { kind: 'human', accountId: ACCOUNT, displayName: 'Lead Ada' },
  });
  expect(routed).toBe('routed');
  expect(fx.enqueued.at(-1)?.recipients).toBeUndefined();
  await fx.host.routeTeamChatMessage(PROJECT, {
    id: 'chat-mentioned', teamId: TEAM, sharedProjectId: SHARED, body: 'Check this', mentions: [REMOTE_AGENT],
    author: { kind: 'human', accountId: ACCOUNT, displayName: 'Lead Ada' },
  });
  expect(fx.enqueued.at(-1)?.recipients).toEqual(['codex1']);
  expect(fx.outgoing.every((entry) => entry.kind !== 'teamgroup.delivery')).toBe(true);
});

it('dispatches remote proxy deliveries, proxies team MCP calls, rejects mismatched owners, and records completion', async () => {
  const fx = fixture();
  await fx.host.enable(PROJECT, enableInput(REMOTE_AGENT));
  await grantRemote(fx);
  const sessionId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
  const group = fx.group()!;
  const member = group.members.find((candidate) => candidate.sessionId === sessionId)!;
  const deliveryId = 'team-delivery-1';
  const requestId = 'team-request-1';
  group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId, messageId: 'group-message-1', memberId: member.id,
    status: 'running', runId: 'host-run-1', hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'assignment' });
  const userMessage = fx.store.insertMessage({ sessionId, role: 'user', content: 'Review the diff', runId: 'host-run-1', kind: 'group-delivery' });
  fx.store.insertRun({ id: 'host-run-1', sessionId, userMessageId: userMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
  const inputRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.project.path, encoding: 'utf8' }).trim();
  fx.store.recordEvent({ projectId: PROJECT, sessionId, type: 'handoff.created', summary: 'Committed input handoff', payload: {
    messageId: 'handoff-input-1', fromSessionId: LOCAL_AGENT, toSessionId: sessionId, taskId: 'task-input-1', path: 'README.md', revision: inputRevision,
  } });
  fx.host.start({
    session: fx.store.getSession(sessionId)!, runId: 'host-run-1', content: 'TEAM INSTRUCTIONS\n\nReview the diff', options: { groupDeliveryId: deliveryId },
    context: { groupId: group.group.id, memberId: member.id, requestId, deliveryId, hop: 0, instructions: 'TEAM INSTRUCTIONS' }, consumedHandoffs: ['handoff-input-1'],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const dispatched = fx.outgoing.find((entry) => entry.kind === 'teamgroup.delivery');
  expect(TeamDeliveryPayloadSchema.safeParse(dispatched?.payload)).toMatchObject({ success: true });
  expect(dispatched?.payload).toMatchObject({ content: expect.stringContaining('Git ref: refs/mingle/team/input/'),
    inputArtifacts: [expect.objectContaining({ revision: inputRevision, taskId: 'task-input-1', path: 'README.md', transferId: 'host-input-transfer' })],
    integrationDeviceId: DEVICE, permissionLevel: 'supervised', settingsVersion: 1, kind: 'assignment' });
  await expect(fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, status: 'running', runId: 'owner-run-1', at: new Date().toISOString() }, DEVICE))
    .rejects.toMatchObject({ status: 403 });
  await expect(fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId: 'unknown-delivery', agentId: REMOTE_AGENT, status: 'running', runId: 'owner-run-1', at: new Date().toISOString() }))
    .rejects.toMatchObject({ status: 404 });

  await fx.incoming('teamgroup.tool.call', { sharedProjectId: SHARED, deliveryId, callId: 'call-1', agentId: REMOTE_AGENT, tool: 'team_members', args: {} });
  expect(fx.outgoing.find((entry) => entry.kind === 'teamgroup.tool.result')?.payload).toMatchObject({ callId: 'call-1', ok: true, result: { actual: true } });
  await expect(fx.incoming('teamgroup.tool.call', { sharedProjectId: SHARED, deliveryId, callId: 'call-bad', agentId: LOCAL_AGENT, tool: 'team_members', args: {} })).rejects.toMatchObject({ status: 403 });

  await fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, status: 'awaiting-approval', runId: 'owner-run-1', at: new Date().toISOString() });
  await fx.incoming('teamgroup.approval.request', { sharedProjectId: SHARED, deliveryId, approvalId: 'owner-approval-1', agentId: REMOTE_AGENT,
    summary: 'Run a scoped command', kind: 'command', expiresAt: new Date(Date.now() + 30_000).toISOString() });
  const mirroredApproval = fx.store.pendingApprovals(sessionId)[0]!;
  expect(mirroredApproval.description).toBe('Run a scoped command');
  await expect(fx.host.authorizeApprovalDecision(mirroredApproval.id)).resolves.toBeUndefined();
  fx.setRole('member');
  await expect(fx.host.authorizeApprovalDecision(mirroredApproval.id)).rejects.toMatchObject({ status: 403 });
  fx.setRole('leader');
  fx.setDevice(OWNER_DEVICE);
  await expect(fx.host.authorizeApprovalDecision(mirroredApproval.id)).rejects.toMatchObject({ status: 403 });
  fx.setDevice(DEVICE);
  await expect(fx.host.authorizeApprovalDecision(mirroredApproval.id)).resolves.toBeUndefined();
  fx.host.decideApproval(mirroredApproval.id, 'approved');
  expect(fx.store.getApproval(mirroredApproval.id)?.status).toBe('approved');
  expect(fx.outgoing.find((entry) => entry.kind === 'teamgroup.approval.decision')?.payload).toMatchObject({ approvalId: 'owner-approval-1', decision: 'approved' });

  await fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, status: 'completed', runId: 'owner-run-1',
    finalText: 'Reviewed and found one issue.', artifacts: [], at: new Date().toISOString() });
  expect(fx.finished).toContainEqual({ sessionId, runId: 'host-run-1', outcome: 'completed' });
  expect(fx.store.getRun('host-run-1')?.status).toBe('completed');
  expect(fx.store.listMessages(sessionId, { limit: 20 }).some((message) => message.role === 'assistant' && message.content === 'Reviewed and found one issue.')).toBe(true);
  await expect(fx.incoming('teamgroup.tool.call', { sharedProjectId: SHARED, deliveryId, callId: 'call-finished', agentId: REMOTE_AGENT, tool: 'team_members', args: {} })).rejects.toMatchObject({ status: 404 });
});

it('imports remote artifacts into isolated refs and includes those ref names in the orchestrator result', async () => {
  const fx = fixture();
  await fx.host.enable(PROJECT, enableInput(REMOTE_AGENT));
  await grantRemote(fx);
  const sessionId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
  const group = fx.group()!;
  const member = group.members.find((candidate) => candidate.sessionId === sessionId)!;
  const deliveryId = 'team-artifact-delivery';
  const requestId = 'team-artifact-request';
  group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId, messageId: 'team-artifact-message', memberId: member.id,
    status: 'running', runId: 'team-artifact-run', hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'assignment' });
  const userMessage = fx.store.insertMessage({ sessionId, role: 'user', content: 'Implement this task', runId: 'team-artifact-run' });
  fx.store.insertRun({ id: 'team-artifact-run', sessionId, userMessageId: userMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
  fx.host.start({ session: fx.store.getSession(sessionId)!, runId: 'team-artifact-run', content: 'Implement this task', options: { groupDeliveryId: deliveryId },
    context: { groupId: group.group.id, memberId: member.id, requestId, deliveryId, hop: 0, instructions: 'Instructions' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const revision = 'a'.repeat(40);
  const artifact = { revision, transferId: 'owner-transfer', path: 'src/output.ts', taskId: 'task-42' };
  await fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, status: 'completed',
    runId: 'owner-run-artifact', finalText: 'The implementation is committed.', artifacts: [artifact], at: new Date().toISOString() });
  expect(fx.artifactImports).toEqual([expect.objectContaining({ teamId: TEAM, sharedProjectId: SHARED, deliveryId,
    sourceDeviceId: OWNER_DEVICE, artifact })]);
  const refs = fx.store.db.prepare('SELECT artifacts_json FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId) as { artifacts_json: string };
  const stored = JSON.parse(refs.artifacts_json) as Array<{ ref: string; revision: string }>;
  expect(stored[0]).toMatchObject({ revision, ref: `refs/mingle/team/${SHARED}/${deliveryId}/${revision}` });
  const assistant = fx.store.listMessages(sessionId, { limit: 20 }).find((message) => message.role === 'assistant');
  expect(assistant?.content).toContain(`Git ref: refs/mingle/team/${SHARED}/${deliveryId}/${revision}`);
});

it('supports idle, fallback, promote/swap and remove changes with leader history', async () => {
  const fx = fixture();
  await fx.host.enable(PROJECT, enableInput());
  await grantRemote(fx);
  const idle = await fx.host.change(PROJECT, { action: 'set-role', agentId: REMOTE_AGENT, role: 'idle', expectedVersion: 1 });
  expect(idle.members.find((member) => member.agentId === REMOTE_AGENT)).toMatchObject({ role: 'idle', state: 'paused' });
  const worker = await fx.host.change(PROJECT, { action: 'set-role', agentId: REMOTE_AGENT, role: 'worker', expectedVersion: 2 });
  expect(worker.members.find((member) => member.agentId === REMOTE_AGENT)?.role).toBe('worker');
  const fallback = await fx.host.change(PROJECT, { action: 'set-fallbacks', agentIds: [REMOTE_AGENT], expectedVersion: 3 });
  expect(fallback.members.find((member) => member.agentId === REMOTE_AGENT)?.fallbackRank).toBe(1);
  const promoted = await fx.host.change(PROJECT, { action: 'set-orchestrator', agentId: REMOTE_AGENT, previousRole: 'idle', expectedVersion: 4 });
  expect(promoted.settings?.orchestratorAgentId).toBe(REMOTE_AGENT);
  expect(promoted.members.find((member) => member.agentId === LOCAL_AGENT)?.role).toBe('idle');
  const swapped = await fx.host.change(PROJECT, { action: 'set-orchestrator', agentId: LOCAL_AGENT, previousRole: 'worker', expectedVersion: 5 });
  expect(swapped.settings?.orchestratorAgentId).toBe(LOCAL_AGENT);
  expect(swapped.members.find((member) => member.agentId === REMOTE_AGENT)?.role).toBe('worker');
  const removedWorker = await fx.host.change(PROJECT, { action: 'remove', agentId: REMOTE_AGENT, expectedVersion: 6 });
  expect(removedWorker.members.some((member) => member.agentId === REMOTE_AGENT)).toBe(false);
  const removedLeader = await fx.host.change(PROJECT, { action: 'remove', agentId: LOCAL_AGENT, expectedVersion: 7 });
  expect(removedLeader.needsLeader).toBe(true);
  expect(removedLeader.settings?.orchestratorAgentId).toBeNull();
  expect(removedLeader.leaderHistory.at(-1)).toMatchObject({ reason: 'removed', fromAgentId: LOCAL_AGENT, toAgentId: null });
  expect(fx.store.listSessions().length).toBe(2); // roster edits keep the real and proxy session history intact
});

it('promotes a consented online fallback after quota exhaustion and never infers during structure updates', async () => {
  const fx = fixture();
  await fx.host.enable(PROJECT, enableInput(REMOTE_AGENT));
  await grantRemote(fx);
  const proxyId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
  const group = fx.group()!;
  const member = group.members.find((candidate) => candidate.sessionId === proxyId)!;
  const deliveryId = 'quota-delivery';
  const requestId = 'quota-request';
  group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId, messageId: 'quota-message', memberId: member.id,
    status: 'running', runId: 'quota-host-run', hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'request' });
  const userMessage = fx.store.insertMessage({ sessionId: proxyId, role: 'user', content: 'Try work', runId: 'quota-host-run' });
  fx.store.insertRun({ id: 'quota-host-run', sessionId: proxyId, userMessageId: userMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
  fx.host.start({ session: fx.store.getSession(proxyId)!, runId: 'quota-host-run', content: 'Try work', options: { groupDeliveryId: deliveryId },
    context: { groupId: group.group.id, memberId: member.id, requestId, deliveryId, hop: 0, instructions: 'Instructions' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, status: 'failed', runId: 'owner-run-quota',
    failure: { id: 'failure-1', sessionId: 'owner-session-remote', kind: 'quota_exhausted', actor: 'lead', provider: 'codex', retryable: false,
      dispatchState: 'dispatched', continuationSafety: 'unknown', message: 'Quota exhausted', occurredAt: new Date().toISOString() }, at: new Date().toISOString() });
  expect(group.group.orchestratorMemberId).toBe(`member-${LOCAL_AGENT}`);
  expect(fx.store.getSession(proxyId)?.status).toBe('error');
  expect(fx.outgoing.filter((entry) => entry.kind === 'teamgroup.delivery')).toHaveLength(1);
  const handedOver = await fx.host.structure(PROJECT);
  expect(handedOver.leaderHistory.at(-1)?.reason).toBe('fallback-quota');

  await fx.host.change(PROJECT, { action: 'set-orchestrator', agentId: REMOTE_AGENT, expectedVersion: handedOver.settings!.version });
  const current = await fx.host.structure(PROJECT);
  await fx.host.update(PROJECT, { expectedVersion: current.settings!.version, fallbackAgentIds: [] });
  const noFallback = await fx.host.structure(PROJECT);
  const nextDeliveryId = 'quota-delivery-without-fallback';
  const nextRequestId = 'quota-request-without-fallback';
  const remoteMember = group.members.find((candidate) => candidate.sessionId === proxyId)!;
  group.deliveries.push({ id: nextDeliveryId, groupId: group.group.id, requestId: nextRequestId, messageId: 'quota-message-2', memberId: remoteMember.id,
    status: 'running', runId: 'quota-host-run-2', hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'request' });
  const secondMessage = fx.store.insertMessage({ sessionId: proxyId, role: 'user', content: 'Try another task', runId: 'quota-host-run-2' });
  fx.store.insertRun({ id: 'quota-host-run-2', sessionId: proxyId, userMessageId: secondMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
  fx.host.start({ session: fx.store.getSession(proxyId)!, runId: 'quota-host-run-2', content: 'Try another task', options: { groupDeliveryId: nextDeliveryId },
    context: { groupId: group.group.id, memberId: remoteMember.id, requestId: nextRequestId, deliveryId: nextDeliveryId, hop: 0, instructions: 'Instructions' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId: nextDeliveryId, agentId: REMOTE_AGENT, status: 'failed', runId: 'owner-run-quota-2',
    failure: { id: 'failure-2', sessionId: 'owner-session-remote', kind: 'quota_exhausted', actor: 'lead', provider: 'codex', retryable: false,
      dispatchState: 'dispatched', continuationSafety: 'unknown', message: 'Quota exhausted again', occurredAt: new Date().toISOString() }, at: new Date().toISOString() });
  const paused = await fx.host.structure(PROJECT);
  expect(paused.needsLeader).toBe(true);
  expect(group.group.paused).toBe(true);
});

it('fails a proxy delivery at its configurable timeout using the injected clock', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-24T12:00:00.000Z') });
  let clock = Date.now();
  try {
    const fx = fixture({ deliveryTimeoutMs: 5_000, now: () => clock });
    await fx.host.enable(PROJECT, enableInput(REMOTE_AGENT));
    await grantRemote(fx);
    const sessionId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
    const group = fx.group()!;
    const member = group.members.find((candidate) => candidate.sessionId === sessionId)!;
    const deliveryId = 'timeout-delivery';
    const requestId = 'timeout-request';
    group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId, messageId: 'timeout-message', memberId: member.id,
      status: 'running', runId: 'timeout-host-run', hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'request' });
    const userMessage = fx.store.insertMessage({ sessionId, role: 'user', content: 'Wait remotely', runId: 'timeout-host-run' });
    fx.store.insertRun({ id: 'timeout-host-run', sessionId, userMessageId: userMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
    fx.host.start({ session: fx.store.getSession(sessionId)!, runId: 'timeout-host-run', content: 'Wait remotely', options: { groupDeliveryId: deliveryId },
      context: { groupId: group.group.id, memberId: member.id, requestId, deliveryId, hop: 0, instructions: 'Instructions' } });
    clock += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    expect(fx.store.getSession(sessionId)?.error).toContain('timed out');
    expect(fx.finished).toContainEqual({ sessionId, runId: 'timeout-host-run', outcome: 'failed' });
    expect((fx.store.db.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId) as { status: string }).status).toBe('failed');
  } finally {
    vi.useRealTimers();
  }
});
