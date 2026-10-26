import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import {
  TEAM_CONSENT_DISCLAIMER_VERSION, TeamDeliveryPayloadSchema, TeamStructurePayloadSchema,
  type GroupSnapshot, type Session,
} from '@mingle/contracts';
import { openDatabase } from '../../db.ts';
import { Store } from '../../store.ts';
import { makeRepo, runGit, waitFor } from '../../test-utils.ts';
import { HttpError } from '../../util.ts';
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

function fixture(options: { deviceId?: string; accountId?: string; role?: 'leader' | 'admin' | 'member'; deliveryTimeoutMs?: number; deliveryMaxDurationMs?: number; now?: () => number;
  integrateTeamArtifact?: (input: any) => Promise<{ beforeRevision: string; revision: string; integrated: boolean }> } = {}) {
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
  const artifactDiscards: string[] = [];
  const remoteToolCalls: Array<{ runId: string; sessionId: string; tool: string; args: Record<string, unknown>; importsAtCall: number }> = [];
  const artifactIntegrations: unknown[] = [];
  const teamGit = {
    async exportTeamArtifact(input: any) { return { revision: input.revision, transferId: 'host-input-transfer', ref: `refs/mingle/team/input/${input.revision}`, ...(input.path ? { path: input.path } : {}), ...(input.taskId ? { taskId: input.taskId } : {}) }; },
    async importTeamArtifact(input: any) {
      artifactImports.push(input);
      return { ...input.artifact, ref: `refs/mingle/team/${input.sharedProjectId}/${input.deliveryId}/${input.artifact.revision}` };
    },
    async discardUnpublishedMcpArtifacts(input: { deliveryId: string }) { artifactDiscards.push(input.deliveryId); },
  };
  let receive: ((envelope: any) => Promise<void>) | null = null;
  let localDeviceId = options.deviceId ?? DEVICE;
  let ownerOnline = true;
  let delayedAuthorization: Promise<void> | null = null;
  const transport = {
    snapshot: () => ({ deviceId: localDeviceId, status: 'ready', error: null,
      devices: [
        { id: DEVICE, teamId: TEAM, ownerId: ACCOUNT, name: 'Host device', fingerprint: 'host-fingerprint', signingPublicKey: '', encryptionPublicKey: '', lastSeenAt: new Date().toISOString(), revokedAt: null, createdAt: new Date().toISOString(), status: 'online' },
        { id: OWNER_DEVICE, teamId: TEAM, ownerId: OWNER, name: 'Owner device', fingerprint: 'owner-fingerprint', signingPublicKey: '', encryptionPublicKey: '', lastSeenAt: new Date().toISOString(), revokedAt: null, createdAt: new Date().toISOString(), status: ownerOnline ? 'online' : 'offline' },
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
      const user = { id: options.accountId ?? ACCOUNT, email: 'lead@example.test', aud: 'authenticated', created_at: '2026-01-01T00:00:00Z', app_metadata: {}, user_metadata: {} } as unknown as User;
      return callback(cloud as unknown as SupabaseClient, user);
    },
  };
  let group: GroupSnapshot | null = null;
  let failNextSync = false;
  let publishLocalAgents: ((input: { teamId: string; sharedProjectId: string; sessionIds: string[] }) => Promise<unknown>) | null = null;
  let pumpCount = 0;
  let afterRunFinished: ((sessionId: string, runId: string, outcome: string) => void) | null = null;
  const finished: Array<{ sessionId: string; runId: string; outcome: string }> = [];
  const enqueued: Array<{ content: string; recipients?: string[]; clientMessageId: string }> = [];
  const groupService = {
    createTeamGroup(input: { id: string; projectId: string; title: string; orchestratorSessionId: string; mode?: 'cowork' | 'orchestrated' | 'current-leads'; members: Array<{ sessionId: string; handle: string; role: 'orchestrator' | 'worker' | 'idle'; held: boolean }> }) {
      // Mirrors GroupService.createTeamGroup: cowork groups have only peers and no orchestrator.
      const cowork = input.mode === 'cowork';
      const members = input.members.map((member) => ({ id: `member-${member.sessionId}`, groupId: input.id, sessionId: member.sessionId,
        handle: member.handle, role: cowork ? 'peer' as const : member.role === 'orchestrator' ? 'orchestrator' as const : 'worker' as const, held: member.held, joinedAt: new Date().toISOString(), removedAt: null }));
      group = { group: { id: input.id, projectId: input.projectId, title: input.title, anchorSessionId: input.orchestratorSessionId, mode: input.mode ?? 'orchestrated',
        orchestratorMemberId: cowork ? null : members.find((member) => member.sessionId === input.orchestratorSessionId)?.id ?? null, paused: false, pauseReason: null, maxParallel: 2, maxTurns: 80, maxHops: 6, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        members, deliveries: [], requests: [], messages: [], assignments: [] };
      return group;
    },
    syncTeamMembers(_groupId: string, members: Array<{ sessionId: string; handle: string; role: 'orchestrator' | 'worker' | 'idle'; held: boolean }>) {
      if (failNextSync) { failNextSync = false; throw new Error('Scheduler rejected this team structure.'); }
      if (!group) return;
      group.members = members.map((member) => ({ id: `member-${member.sessionId}`, groupId: group!.group.id, sessionId: member.sessionId,
        handle: member.handle, role: member.role === 'orchestrator' ? 'orchestrator' as const : 'worker' as const, held: member.held, joinedAt: new Date().toISOString(), removedAt: null }));
      group.group.orchestratorMemberId = group.members.find((member) => member.role === 'orchestrator')?.id ?? null;
    },
    syncTeamRosterMembers(_groupId: string, members: Array<{ sessionId: string; handle: string; role: 'orchestrator' | 'worker' | 'idle'; held: boolean }>, managedSessionIds: string[] = []) {
      if (failNextSync) { failNextSync = false; throw new Error('Scheduler rejected this team structure.'); }
      if (!group) return;
      const wanted = new Set(members.map((member) => member.sessionId));
      for (const member of members) {
        const current = group.members.find((candidate) => candidate.sessionId === member.sessionId && !candidate.removedAt);
        if (current) Object.assign(current, { handle: member.handle, role: member.role === 'orchestrator' ? 'orchestrator' : group.group.mode === 'cowork' ? 'peer' : 'worker', held: member.held });
        else group.members.push({ id: `member-${member.sessionId}`, groupId: group.group.id, sessionId: member.sessionId,
          handle: member.handle, role: member.role === 'orchestrator' ? 'orchestrator' : 'worker', held: member.held, joinedAt: new Date().toISOString(), removedAt: null });
      }
      for (const current of group.members) if (managedSessionIds.includes(current.sessionId) && !wanted.has(current.sessionId) && !current.removedAt) current.removedAt = new Date().toISOString();
    },
    forSession(sessionId: string) { return group?.members.some((member) => member.sessionId === sessionId && !member.removedAt) ? group : undefined; },
    async addTeamMember(_groupId: string, input: { sessionId: string; handle: string }) {
      if (!group) throw new Error('No group');
      group.members.push({ id: `member-${input.sessionId}`, groupId: group.group.id, sessionId: input.sessionId,
        handle: input.handle, role: group.group.mode === 'cowork' ? 'peer' : 'worker', held: false, joinedAt: new Date().toISOString(), removedAt: null });
      return group;
    },
    get() { if (!group) throw new HttpError(404, 'No group'); return group; },
    setTeamLeader(_groupId: string, sessionId: string | null, options: { paused?: boolean } = {}) {
      if (!group) return;
      group.group.orchestratorMemberId = sessionId ? group.members.find((member) => member.sessionId === sessionId)?.id ?? null : null;
      group.group.paused = options.paused ?? !sessionId;
      for (const member of group.members) member.role = member.sessionId === sessionId ? 'orchestrator' : 'worker';
    },
    pauseTeamGroup() { if (group) group.group.paused = true; },
    pumpTeamGroup() { pumpCount++; },
    sendTeamMessage(_groupId: string, input: typeof enqueued[number]) { enqueued.push(input); return [`host-chat-delivery-${enqueued.length}`]; },
    onRunFinished(sessionId: string, runId: string, outcome: string) {
      finished.push({ sessionId, runId, outcome });
      const delivery = group?.deliveries.find((entry) => entry.runId === runId);
      if (delivery && (outcome === 'completed' || outcome === 'failed' || outcome === 'interrupted')) delivery.status = outcome;
      const hook = afterRunFinished;
      afterRunFinished = null;
      hook?.(sessionId, runId, outcome);
    },
    setTeamDispatchGuard() {}, setTeamRunFinishedHook() {}, holdTeamMember() {},
    contextForRun() { return undefined; },
  };
  const teamMcp = {
    create() { return { url: 'http://127.0.0.1/api/team/mcp', token: 'unused-token' }; },
    revoke() {},
    async callRemote(runId: string, sessionId: string, tool: string, args: Record<string, unknown>) {
      remoteToolCalls.push({ runId, sessionId, tool, args, importsAtCall: artifactImports.length });
      return { tool, actual: true };
    },
  };
  const recovery = { recordFailure() {}, clearFailure() {} };
  const hosts: TeamOrchestrationHost[] = [];
  const makeHost = () => {
    const host = new TeamOrchestrationHost({ store, git: teamGit as any, account: account as any, transport: transport as any,
      authorizeTeam: async () => { const gate = delayedAuthorization; delayedAuthorization = null; await gate; },
      collaboration: collaboration as any, groups: groupService as any, teamMcp: teamMcp as any, recovery: recovery as any,
      integrateTeamArtifact: options.integrateTeamArtifact ? async (input) => {
        artifactIntegrations.push(input);
        return options.integrateTeamArtifact!(input);
      } : undefined,
      publishLocalAgents: async (input) => {
        if (!publishLocalAgents) throw new Error('Publisher not configured.');
        return publishLocalAgents(input);
      },
      deliveryTimeoutMs: options.deliveryTimeoutMs ?? 60_000, deliveryMaxDurationMs: options.deliveryMaxDurationMs, now: options.now });
    hosts.push(host);
    return host;
  };
  let host = makeHost();
  const fx = {
    store, project, local, get host() { return host; }, outgoing, finished, enqueued, artifactImports, artifactDiscards, artifactIntegrations, remoteToolCalls, agents, group: () => group, setRole(value: typeof role) { role = value; },
    setPublisher(callback: typeof publishLocalAgents) { publishLocalAgents = callback; },
    setDevice(deviceId: string) { localDeviceId = deviceId; },
    setOwnerOnline(value: boolean) { ownerOnline = value; },
    addPublishedAgent(agent: typeof agents[number]) { agents.push(agent); },
    failNextSync() { failNextSync = true; },
    pumpCount() { return pumpCount; },
    delayAuthorization(gate: Promise<void>) { delayedAuthorization = gate; },
    restartHost() { host = makeHost(); return host; },
    afterRunFinished(callback: (sessionId: string, runId: string, outcome: string) => void) { afterRunFinished = callback; },
    async incoming(kind: string, payload: unknown, fromDeviceId = OWNER_DEVICE) {
      if (!receive) throw new Error('No team orchestration transport handler');
      return receive({ id: randomUUID(), teamId: TEAM, fromDeviceId, toDeviceId: options.deviceId ?? DEVICE, kind, payload });
    },
    async close() { await Promise.all(hosts.map((instance) => instance.close())); store.db.close(); },
    setGroup(snapshot: GroupSnapshot) { group = snapshot; },
    removeGroupMember(memberId: string) {
       if (!group) return;
       const member = group.members.find((candidate) => candidate.id === memberId);
       if (!member) return;
       member.removedAt = new Date().toISOString();
      store.recordEvent({ projectId: PROJECT, type: 'group.member.removed', summary: 'Agent removed', payload: { groupId: group.group.id, memberId } });
    },
    archiveGroup() {
      if (!group) return;
      const groupId = group.group.id;
      group = null;
      store.recordEvent({ projectId: PROJECT, type: 'group.archived', summary: 'Group archived', payload: { groupId } });
    },
  };
  fixtures.push(fx);
  return fx;
}

const enableInput = (orchestratorAgentId = LOCAL_AGENT) => ({ leaderOrchestration: true, permissionLevel: 'supervised', orchestratorAgentId,
  fallbackAgentIds: orchestratorAgentId === LOCAL_AGENT ? [] : [LOCAL_AGENT] });

async function grantRemote(fx: ReturnType<typeof fixture>, settingsVersion = 1): Promise<void> {
  await fx.incoming('teamgroup.consent', {
    sharedProjectId: SHARED, agentIds: [REMOTE_AGENT], permissionLevel: 'supervised', settingsVersion,
    disclaimerVersion: TEAM_CONSENT_DISCLAIMER_VERSION, state: 'granted', at: new Date().toISOString(),
  });
}

async function addRemoteToSession(fx: ReturnType<typeof fixture>): Promise<GroupSnapshot> {
  await grantRemote(fx);
  return fx.host.addAgentToSession(LOCAL_AGENT, { agentId: REMOTE_AGENT });
}

function seedRemoteConsent(fx: ReturnType<typeof fixture>): void {
  const at = new Date().toISOString();
  fx.store.db.prepare(`INSERT INTO mingle_team_host_consents(team_id,shared_project_id,agent_id,owner_account_id,owner_device_id,state,
    permission_level,settings_version,disclaimer_version,accepted_at,updated_at) VALUES(?,?,?,?,?,'granted','supervised',1,?,?,?)`)
    .run(TEAM, SHARED, REMOTE_AGENT, OWNER, OWNER_DEVICE, TEAM_CONSENT_DISCLAIMER_VERSION, at, at);
}

it('authorizes host changes, enforces optimistic versions, validates broadcasts, and routes chat without starting inference', async () => {
  const fx = fixture();
  const enabled = await fx.host.enable(PROJECT, enableInput());
  expect(enabled.settings?.version).toBe(1);
  expect(enabled.teamSession).toBeNull();
  expect(fx.group()).toBeNull();
  expect(fx.store.db.prepare('SELECT group_id FROM mingle_team_host_projects WHERE team_id=? AND shared_project_id=?').get(TEAM, SHARED))
    .toEqual({ group_id: '' });
  const broadcast = fx.outgoing.find((entry) => entry.kind === 'teamgroup.structure');
  expect(TeamStructurePayloadSchema.safeParse(broadcast?.payload).success).toBe(true);
  await expect(fx.host.update(PROJECT, { expectedVersion: 99, leaderOrchestration: false })).rejects.toMatchObject({ status: 409 });
  const changedWithoutSession = await fx.host.update(PROJECT, { expectedVersion: 1, permissionLevel: 'full-access' });
  expect(changedWithoutSession).toMatchObject({ settings: { version: 2, permissionLevel: 'full-access' }, teamSession: null });
  expect(fx.group()).toBeNull();

  const denied = fixture({ role: 'member' });
  await expect(denied.host.enable(PROJECT, enableInput())).rejects.toMatchObject({ status: 403 });
  const wrongDevice = fixture({ deviceId: OWNER_DEVICE });
  await expect(wrongDevice.host.enable(PROJECT, enableInput())).rejects.toMatchObject({ status: 403 });

  const routed = await fx.host.routeTeamChatMessage(PROJECT, {
    id: 'chat-untagged', teamId: TEAM, sharedProjectId: SHARED, body: 'Plan a fix', mentions: [],
    author: { kind: 'human', accountId: ACCOUNT, displayName: 'Lead Ada' },
  });
  expect(routed).toBe('handled');
  expect(fx.enqueued).toHaveLength(0);
  await fx.host.routeTeamChatMessage(PROJECT, {
    id: 'chat-mentioned', teamId: TEAM, sharedProjectId: SHARED, body: 'Check this', mentions: [REMOTE_AGENT],
    author: { kind: 'human', accountId: ACCOUNT, displayName: 'Lead Ada' },
  });
  expect(fx.enqueued).toHaveLength(0);
  expect(fx.outgoing.every((entry) => entry.kind !== 'teamgroup.delivery')).toBe(true);
});

it('keeps a full-access consent granted when the team level is raised to full access', async () => {
  const fx = fixture();
  await fx.host.enable(PROJECT, enableInput());
  await fx.incoming('teamgroup.consent', {
    sharedProjectId: SHARED, agentIds: [REMOTE_AGENT], permissionLevel: 'full-access', settingsVersion: 1,
    disclaimerVersion: TEAM_CONSENT_DISCLAIMER_VERSION, state: 'granted', at: new Date().toISOString(),
  });
  await fx.host.update(PROJECT, { expectedVersion: 1, permissionLevel: 'full-access' });
  expect((await fx.host.structure(PROJECT)).members.find((member) => member.agentId === REMOTE_AGENT)?.consent).toBe('granted');
  expect((await fx.host.availableAgents(PROJECT)).agents.find((agent) => agent.agentId === REMOTE_AGENT)).toMatchObject({ consent: 'granted' });
});

it('lazily migrates legacy local session IDs in host state while preserving assigned handles', async () => {
  const fx = fixture();
  const localSession = (id: string, name: string) => fx.store.insertSession({ id, projectId: PROJECT, name,
    provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: false,
    worktreePath: fx.project.path, branch: null });
  const leader = localSession('ses_legacy_team_leader', 'Published host leader');
  const fallback = localSession('ses_legacy_team_fallback', 'Published host fallback');
  fx.addPublishedAgent({ id: 'agent_host_leader', name: leader.name, accountId: ACCOUNT, deviceId: DEVICE,
    projectId: PROJECT, sessionId: leader.id, provider: leader.provider, model: leader.model, state: 'idle' });
  fx.addPublishedAgent({ id: 'agent_host_fallback', name: fallback.name, accountId: ACCOUNT, deviceId: DEVICE,
    projectId: PROJECT, sessionId: fallback.id, provider: fallback.provider, model: fallback.model, state: 'idle' });

  const enabled = await fx.host.enable(PROJECT, { leaderOrchestration: true, permissionLevel: 'supervised',
    orchestratorAgentId: 'agent_host_leader', fallbackAgentIds: ['agent_host_fallback'] });
  const hostRow = fx.store.db.prepare(`SELECT settings_json,leader_history_json FROM mingle_team_host_projects
    WHERE team_id=? AND shared_project_id=?`).get(TEAM, SHARED) as { settings_json: string; leader_history_json: string };
  const leaderHandle = (fx.store.db.prepare(`SELECT handle FROM mingle_team_host_roster
    WHERE team_id=? AND shared_project_id=? AND agent_id=?`).get(TEAM, SHARED, 'agent_host_leader') as { handle: string }).handle;
  const settings = JSON.parse(hostRow.settings_json);
  settings.orchestratorAgentId = leader.id;
  settings.fallbackAgentIds = [fallback.id];
  fx.store.db.prepare(`UPDATE mingle_team_host_projects SET settings_json=?,leader_history_json=? WHERE team_id=? AND shared_project_id=?`)
    .run(JSON.stringify(settings), JSON.stringify([{ id: 'leader_old_session_id', at: new Date().toISOString(), fromAgentId: leader.id,
      toAgentId: fallback.id, reason: 'manual', byAccountId: ACCOUNT }]), TEAM, SHARED);
  fx.store.db.prepare(`UPDATE mingle_team_host_roster SET agent_id=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
    .run(leader.id, TEAM, SHARED, 'agent_host_leader');
  fx.store.db.prepare(`UPDATE mingle_team_host_roster SET agent_id=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
    .run(fallback.id, TEAM, SHARED, 'agent_host_fallback');
  const at = new Date().toISOString();
  fx.store.db.prepare(`INSERT INTO mingle_team_host_consents(team_id,shared_project_id,agent_id,owner_account_id,owner_device_id,state,
    permission_level,settings_version,disclaimer_version,accepted_at,updated_at) VALUES(?,?,?,?,?,'granted','supervised',1,?,?,?)`)
    .run(TEAM, SHARED, leader.id, ACCOUNT, DEVICE, TEAM_CONSENT_DISCLAIMER_VERSION, at, at);

  const broadcastsBefore = fx.outgoing.filter((entry) => entry.kind === 'teamgroup.structure').length;
  const migrated = await fx.host.structure(PROJECT);
  // Members still hold the structure sent under session ids, so the migrated structure is sent to them.
  await waitFor(() => fx.outgoing.filter((entry) => entry.kind === 'teamgroup.structure').length > broadcastsBefore);
  const resent = fx.outgoing.filter((entry) => entry.kind === 'teamgroup.structure').at(-1)?.payload as { members: Array<{ agentId: string; handle: string }> };
  expect(resent.members).toContainEqual(expect.objectContaining({ agentId: 'agent_host_leader', handle: leaderHandle }));
  expect(migrated.settings).toMatchObject({ orchestratorAgentId: 'agent_host_leader', fallbackAgentIds: ['agent_host_fallback'], version: enabled.settings?.version });
  expect(migrated.leaderHistory[0]).toMatchObject({ fromAgentId: 'agent_host_leader', toAgentId: 'agent_host_fallback' });
  expect(fx.store.db.prepare(`SELECT agent_id,handle FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
    .get(TEAM, SHARED, 'agent_host_leader')).toEqual({ agent_id: 'agent_host_leader', handle: leaderHandle });
  expect(fx.store.db.prepare(`SELECT agent_id FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
    .get(TEAM, SHARED, 'agent_host_fallback')).toEqual({ agent_id: 'agent_host_fallback' });
  expect(fx.store.db.prepare(`SELECT agent_id FROM mingle_team_host_consents WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
    .get(TEAM, SHARED, 'agent_host_leader')).toEqual({ agent_id: 'agent_host_leader' });
  expect(fx.store.db.prepare(`SELECT 1 FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
    .get(TEAM, SHARED, leader.id)).toBeUndefined();
});

it('lists teammate agents with consent, online, host-role, and existing-group usability', async () => {
  const fx = fixture();
  const beforeConsent = await fx.host.availableAgents(PROJECT);
  expect(beforeConsent.agents[0]).toMatchObject({ agentId: REMOTE_AGENT, online: true, consent: 'none', usable: false,
    unusableReason: expect.stringContaining('has not granted team consent'), groupId: null });
  seedRemoteConsent(fx);
  const usable = await fx.host.availableAgents(PROJECT);
  expect(usable).toMatchObject({ teamId: TEAM, sharedProjectId: SHARED, canAdd: true, permissionLevel: null });
  expect(usable.agents[0]).toMatchObject({ agentId: REMOTE_AGENT, handle: 'owner', ownerDisplayName: 'Owner Sam', deviceName: 'Owner device', consent: 'granted', usable: true });
  fx.setOwnerOnline(false);
  expect((await fx.host.availableAgents(PROJECT)).agents[0]).toMatchObject({ online: false, usable: false, unusableReason: expect.stringContaining('offline') });
  fx.setOwnerOnline(true);
  fx.setRole('member');
  const readOnly = await fx.host.availableAgents(PROJECT);
  expect(readOnly).toMatchObject({ canAdd: false, reason: expect.stringContaining('team lead') });
  expect(readOnly.agents[0]).toMatchObject({ usable: false, unusableReason: expect.stringContaining('team lead') });
});

it('keeps explicit team enablement group-free until Add agents converts a session', async () => {
  const fx = fixture();
  const enabled = await fx.host.enable(PROJECT, enableInput());
  expect(enabled.teamSession).toBeNull();
  expect(fx.group()).toBeNull();
  expect(fx.store.db.prepare('SELECT group_id FROM mingle_team_host_projects WHERE team_id=? AND shared_project_id=?').get(TEAM, SHARED))
    .toEqual({ group_id: '' });

  await grantRemote(fx);
  expect((await fx.host.structure(PROJECT)).teamSession).toBeNull();
  expect(fx.group()).toBeNull();
  const group = await fx.host.addAgentToSession(LOCAL_AGENT, { agentId: REMOTE_AGENT });
  expect((await fx.host.structure(PROJECT)).teamSession).toMatchObject({ groupId: group.group.id, sessionId: LOCAL_AGENT });
});

it('shares the current local session as a one-member team group and is idempotent with a zero remote roster', async () => {
  const fx = fixture();
  const first = await fx.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'supervised' });
  const group = fx.group()!;
  expect(group.group).toMatchObject({ projectId: PROJECT, anchorSessionId: LOCAL_AGENT, mode: 'orchestrated' });
  expect(group.members).toHaveLength(1);
  expect(group.members[0]).toMatchObject({ sessionId: LOCAL_AGENT, role: 'orchestrator' });
  expect(first).toMatchObject({ enabled: true, settings: { version: 1, orchestratorAgentId: LOCAL_AGENT },
    teamSession: { groupId: group.group.id, sessionId: LOCAL_AGENT } });
  expect((await fx.host.availableAgents(PROJECT)).teamSession).toMatchObject({ groupId: group.group.id, sessionId: LOCAL_AGENT });
  expect(fx.host.activeCount()).toBe(0);
  expect(fx.outgoing.some((entry) => entry.kind === 'teamgroup.delivery')).toBe(false);

  const retry = await fx.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'supervised', expectedVersion: 1 });
  expect(retry.settings?.version).toBe(1);
  expect(retry.teamSession?.groupId).toBe(group.group.id);
  expect(fx.group()?.members).toHaveLength(1);
});

it('auto-publishes only the selected session while retaining the host device published set', async () => {
  const fx = fixture();
  fx.agents.splice(0, 1);
  const calls: Array<{ teamId: string; sharedProjectId: string; sessionIds: string[] }> = [];
  fx.setPublisher(async (input) => {
    calls.push(input);
    fx.addPublishedAgent({ id: LOCAL_AGENT, name: fx.local.name, accountId: ACCOUNT, deviceId: DEVICE,
      projectId: PROJECT, sessionId: LOCAL_AGENT, provider: fx.local.provider, model: fx.local.model, state: 'idle' });
  });

  await fx.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'supervised' });

  expect(calls).toEqual([{ teamId: TEAM, sharedProjectId: SHARED, sessionIds: [LOCAL_AGENT] }]);
  expect(fx.group()?.members.map((member) => member.sessionId)).toEqual([LOCAL_AGENT]);
});

it('does not publish a different session when a canonical team session is already bound', async () => {
  const fx = fixture();
  await fx.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'supervised' });
  const other = fx.store.insertSession({ id: 'other-current-session', projectId: PROJECT, name: 'Another session', provider: 'codex', model: 'gpt-6-codex',
    effort: 'high', policy: 'supervised', isolated: false, worktreePath: fx.project.path, branch: null });
  const calls: string[][] = [];
  fx.setPublisher(async (input) => { calls.push(input.sessionIds); });

  await expect(fx.host.shareSession(PROJECT, { sessionId: other.id, permissionLevel: 'supervised' }))
    .rejects.toMatchObject({ status: 409, message: expect.stringContaining('canonical session') });

  expect(calls).toEqual([]);
});

it('preserves advanced host settings when permission is changed on the established canonical group', async () => {
  const fx = fixture();
  await fx.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'supervised' });
  const row = fx.store.db.prepare(`SELECT settings_json FROM mingle_team_host_projects WHERE team_id=? AND shared_project_id=?`).get(TEAM, SHARED) as { settings_json: string };
  const advanced = { ...JSON.parse(row.settings_json), leaderOrchestration: false, fallbackAgentIds: [REMOTE_AGENT] };
  fx.store.db.prepare(`UPDATE mingle_team_host_projects SET settings_json=? WHERE team_id=? AND shared_project_id=?`)
    .run(JSON.stringify(advanced), TEAM, SHARED);

  const changed = await fx.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'full-access', expectedVersion: 1 });

  expect(changed.settings).toMatchObject({ ...advanced, permissionLevel: 'full-access', version: 2, updatedAt: expect.any(String) });
  expect(Date.parse(changed.settings!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(advanced.updatedAt));
  expect(fx.group()?.members).toHaveLength(1);
});

it('attaches a legacy enabled zero-roster row with leader routing while preserving fallback settings', async () => {
  const fx = fixture();
  await fx.host.enable(PROJECT, enableInput());
  const row = fx.store.db.prepare(`SELECT settings_json FROM mingle_team_host_projects WHERE team_id=? AND shared_project_id=?`).get(TEAM, SHARED) as { settings_json: string };
  fx.store.db.prepare('DELETE FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=?').run(TEAM, SHARED);
  const priorSettings = { ...JSON.parse(row.settings_json), leaderOrchestration: false, fallbackAgentIds: [REMOTE_AGENT] };
  fx.store.db.prepare(`UPDATE mingle_team_host_projects SET settings_json=? WHERE team_id=? AND shared_project_id=?`)
    .run(JSON.stringify(priorSettings), TEAM, SHARED);
  fx.agents.splice(0, 1);
  const publishCalls: string[][] = [];
  fx.setPublisher(async (input) => {
    publishCalls.push(input.sessionIds);
    fx.addPublishedAgent({ id: LOCAL_AGENT, name: fx.local.name, accountId: ACCOUNT, deviceId: DEVICE,
      projectId: PROJECT, sessionId: LOCAL_AGENT, provider: fx.local.provider, model: fx.local.model, state: 'idle' });
  });

  await expect(fx.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'supervised' }))
    .rejects.toMatchObject({ status: 409, message: expect.stringContaining('expectedVersion') });
  expect(publishCalls).toEqual([]);

  const attached = await fx.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'supervised', expectedVersion: 1 });

  expect(attached.settings).toMatchObject({ ...priorSettings, leaderOrchestration: true, version: 2, updatedAt: expect.any(String) });
  expect(Date.parse(attached.settings!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(priorSettings.updatedAt));
  expect(attached.teamSession?.sessionId).toBe(LOCAL_AGENT);
  expect(publishCalls).toEqual([[LOCAL_AGENT]]);
  expect(fx.group()?.members).toHaveLength(1);
});

it('adopts the visible anchor of an existing local group and derives its non-anchor lead without changing group state', async () => {
  const fx = fixture();
  const second = fx.store.insertSession({ id: 'local-existing-worker', projectId: PROJECT, name: 'Existing worker', provider: 'codex', model: 'gpt-6-codex',
    effort: 'high', policy: 'supervised', isolated: false, worktreePath: fx.project.path, branch: null });
  const existing: GroupSnapshot = { group: { id: 'group_existing_local', projectId: PROJECT, title: 'Existing local group', anchorSessionId: LOCAL_AGENT,
    mode: 'orchestrated', orchestratorMemberId: 'member-local-lead', paused: false, pauseReason: null, maxParallel: 2, maxTurns: 80, maxHops: 6,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, members: [
      { id: 'member-local-anchor', groupId: 'group_existing_local', sessionId: LOCAL_AGENT, handle: 'local-anchor', role: 'worker', held: false, joinedAt: new Date().toISOString(), removedAt: null },
      { id: 'member-local-lead', groupId: 'group_existing_local', sessionId: second.id, handle: 'local-lead', role: 'orchestrator', held: false, joinedAt: new Date().toISOString(), removedAt: null },
    ], messages: [], requests: [], deliveries: [], assignments: [] };
  const original = structuredClone(existing);
  fx.setGroup(existing);
  const publishCalls: string[][] = [];
  fx.setPublisher(async (input) => {
    publishCalls.push(input.sessionIds);
    fx.addPublishedAgent({ id: 'local-nonanchor-lead', name: 'Existing worker', accountId: ACCOUNT, deviceId: DEVICE,
      projectId: PROJECT, sessionId: second.id, provider: 'codex', model: 'gpt-6-codex', state: 'idle' });
  });

  const result = await fx.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'supervised' });

  expect(result.teamSession).toMatchObject({ groupId: existing.group.id, sessionId: LOCAL_AGENT });
  expect(result.settings?.orchestratorAgentId).toBe('local-nonanchor-lead');
  expect(publishCalls).toEqual([[LOCAL_AGENT, second.id]]);
  expect(fx.group()).toEqual(original);
  expect(fx.store.db.prepare('SELECT group_id FROM mingle_team_host_projects WHERE team_id=? AND shared_project_id=?').get(TEAM, SHARED))
    .toEqual({ group_id: existing.group.id });
});

it('adopts an existing cowork group without adding an orchestrator or changing its mode', async () => {
  const fx = fixture();
  const existing: GroupSnapshot = { group: { id: 'group_existing_cowork', projectId: PROJECT, title: 'Existing cowork', anchorSessionId: LOCAL_AGENT,
    mode: 'cowork', orchestratorMemberId: null, paused: false, pauseReason: null, maxParallel: 2, maxTurns: 80, maxHops: 6,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, members: [
      { id: 'member-local-peer', groupId: 'group_existing_cowork', sessionId: LOCAL_AGENT, handle: 'local-peer', role: 'peer', held: false, joinedAt: new Date().toISOString(), removedAt: null },
    ], messages: [], requests: [], deliveries: [], assignments: [] };
  const original = structuredClone(existing);
  fx.setGroup(existing);

  const result = await fx.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'supervised' });

  expect(result.settings?.orchestratorAgentId).toBeNull();
  expect(fx.group()).toEqual(original);
});

it('rejects other-project and proxy sessions, wrong host roles/devices, and stale expected versions', async () => {
  const fx = fixture();
  const otherRepo = makeRepo();
  paths.push(otherRepo);
  fx.store.insertProject({ id: 'other-team-project', name: 'Other project', path: otherRepo });
  const wrongProject = fx.store.insertSession({ id: 'session-other-project', projectId: 'other-team-project', name: 'Other', provider: 'claude', model: 'claude-sonnet-5-5',
    effort: 'high', policy: 'supervised', isolated: false, worktreePath: otherRepo, branch: null });
  const proxy = fx.store.insertSession({ id: 'session-team-proxy', projectId: PROJECT, name: 'Proxy', provider: 'codex', model: 'gpt-6-codex',
    effort: 'high', policy: 'supervised', isolated: false, worktreePath: fx.project.path, branch: null });
  fx.store.db.prepare(`INSERT INTO mingle_team_proxy_sessions(session_id,team_id,shared_project_id,agent_id,owner_account_id,owner_device_id,handle)
    VALUES(?,?,?,?,?,?,?)`).run(proxy.id, TEAM, SHARED, REMOTE_AGENT, OWNER, OWNER_DEVICE, 'owner');
  await expect(fx.host.shareSession(PROJECT, { sessionId: wrongProject.id, permissionLevel: 'supervised' })).rejects.toMatchObject({ status: 404 });
  await expect(fx.host.shareSession(PROJECT, { sessionId: proxy.id, permissionLevel: 'supervised' })).rejects.toMatchObject({ status: 404 });

  const member = fixture({ role: 'member' });
  await expect(member.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'supervised' })).rejects.toMatchObject({ status: 403 });
  const wrongDevice = fixture({ deviceId: OWNER_DEVICE });
  await expect(wrongDevice.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'supervised' })).rejects.toMatchObject({ status: 403 });
  const wrongAccount = fixture({ accountId: '10000000-0000-4000-8000-000000000003' });
  await expect(wrongAccount.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'supervised' })).rejects.toMatchObject({ status: 403 });

  await fx.host.enable(PROJECT, enableInput());
  await expect(fx.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'supervised', expectedVersion: 99 })).rejects.toMatchObject({ status: 409 });
});

it('increments settings and requires re-consent when attaching with raised full-access permission', async () => {
  const fx = fixture();
  await fx.host.enable(PROJECT, enableInput());
  seedRemoteConsent(fx);

  const result = await fx.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'full-access', expectedVersion: 1 });

  expect(result.settings).toMatchObject({ version: 2, permissionLevel: 'full-access' });
  expect(fx.store.db.prepare(`SELECT state FROM mingle_team_host_consents WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
    .get(TEAM, SHARED, REMOTE_AGENT)).toEqual({ state: 'needs-reconsent' });
  expect(result.members.find((member) => member.agentId === REMOTE_AGENT)?.consent).toBe('needs-reconsent');
  await expect(fx.host.shareSession(PROJECT, { sessionId: LOCAL_AGENT, permissionLevel: 'supervised', expectedVersion: 1 })).rejects.toMatchObject({ status: 409 });
});

it('uses owner-name handles with provider and numeric suffixes when an owner has multiple agents', async () => {
  const fx = fixture();
  fx.agents.push({ id: 'remote-agent-two', name: 'Remote Codex 2', accountId: OWNER, deviceId: OWNER_DEVICE,
    projectId: PROJECT, sessionId: 'owner-session-remote-two', provider: 'codex', model: 'gpt-6-codex', state: 'idle' });

  const snapshot = await fx.host.availableAgents(PROJECT);

  expect(snapshot.agents.map((agent) => agent.handle)).toEqual(['owner-codex', 'owner-2']);
});

it('rebroadcasts structure after published agents, permission changes, and renewed consent', async () => {
  const fx = fixture();
  await fx.host.enable(PROJECT, enableInput());
  await grantRemote(fx);
  let structures = fx.outgoing.filter((entry) => entry.kind === 'teamgroup.structure');
  expect(structures.length).toBeGreaterThanOrEqual(2);

  fx.addPublishedAgent({ id: 'newly-published-agent', name: 'New Codex', accountId: OWNER, deviceId: OWNER_DEVICE,
    projectId: PROJECT, sessionId: 'owner-session-new', provider: 'codex', model: 'gpt-6-codex', state: 'idle' });
  await fx.incoming('execution.agents', { generatedAt: new Date().toISOString(), agents: [{ sharedProjectId: SHARED }] });
  structures = fx.outgoing.filter((entry) => entry.kind === 'teamgroup.structure');
  expect(structures.length).toBeGreaterThanOrEqual(3);
  expect((await fx.host.availableAgents(PROJECT)).agents.map((agent) => agent.agentId)).toContain('newly-published-agent');

  const settings = await fx.host.update(PROJECT, { expectedVersion: 1, permissionLevel: 'full-access' });
  expect(settings.settings?.version).toBe(2);
  expect((fx.outgoing.filter((entry) => entry.kind === 'teamgroup.structure').at(-1)?.payload as any).settings.permissionLevel).toBe('full-access');
  expect((await fx.host.structure(PROJECT)).members.find((member) => member.agentId === REMOTE_AGENT)?.consent).toBe('needs-reconsent');

  await fx.incoming('teamgroup.consent', {
    sharedProjectId: SHARED, agentIds: [REMOTE_AGENT], permissionLevel: 'full-access', settingsVersion: 2,
    disclaimerVersion: TEAM_CONSENT_DISCLAIMER_VERSION, state: 'granted', at: new Date().toISOString(),
  });
  const updated = fx.outgoing.filter((entry) => entry.kind === 'teamgroup.structure').at(-1)?.payload as any;
  expect(updated.settings).toMatchObject({ permissionLevel: 'full-access', version: 2 });
  expect(updated.members.find((member: { agentId: string }) => member.agentId === REMOTE_AGENT)?.consent).toBe('granted');
});

it('converts one session into its team group, creates a remote proxy member, and routes it to the owner device', async () => {
  const fx = fixture();
  await grantRemote(fx, 7);
  const group = await fx.host.addAgentToSession(LOCAL_AGENT, { agentId: REMOTE_AGENT });
  const proxySessionId = (fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id;
  expect(group.group).toMatchObject({ id: expect.stringMatching(/^group_/), title: 'Local Claude', mode: 'orchestrated', anchorSessionId: LOCAL_AGENT });
  expect(group.members).toContainEqual(expect.objectContaining({ sessionId: LOCAL_AGENT, role: 'orchestrator' }));
  expect(group.members).toContainEqual(expect.objectContaining({ sessionId: proxySessionId, handle: 'owner' }));
  expect(fx.store.db.prepare('SELECT group_id FROM mingle_team_host_projects WHERE team_id=? AND shared_project_id=?').get(TEAM, SHARED))
    .toEqual({ group_id: group.group.id });
  const mirrors: unknown[] = [];
  fx.host.setTeamChat({ mirrorTeamSessionMessage: async (input: { projectId: string; sessionId: string; sourceMessageId: string; content: string; kind: 'human' | 'agent'; replyTo?: string }) => { mirrors.push(input); } } as any);
  fx.group()!.messages.push({ id: 'host-group-user-message', seq: 1, groupId: group.group.id, senderMemberId: null,
    recipientMemberIds: [], kind: 'user', content: 'Lead message from the group composer', requestId: 'request-1', replyToId: null,
    sourceMessageId: null, sourceRunId: null, createdAt: new Date().toISOString() });
  fx.store.recordEvent({ projectId: PROJECT, type: 'group.message.sent', summary: 'Group message sent', payload: { groupId: group.group.id, messageId: 'host-group-user-message' } });
  await waitFor(() => mirrors.length === 1);
  expect(mirrors[0]).toMatchObject({ sessionId: LOCAL_AGENT, sourceMessageId: 'host-group-user-message', kind: 'human' });
  fx.store.recordEvent({ projectId: PROJECT, type: 'group.message.sent', summary: 'Team-chat routed message', payload: { groupId: group.group.id, messageId: 'host-group-user-message', source: 'teamchat' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mirrors).toHaveLength(1);
  const structure = await fx.host.structure(PROJECT);
  expect(structure.settings?.version).toBe(7);
  expect(structure.teamSession).toEqual({ groupId: group.group.id, sessionId: LOCAL_AGENT, title: 'Local Claude' });
  expect(await fx.host.availableAgents(PROJECT)).toMatchObject({ agents: [expect.objectContaining({ usable: false, groupId: group.group.id })] });
  expect(fx.outgoing.filter((entry) => entry.kind === 'teamgroup.structure').at(-1)?.payload).toMatchObject({
    teamSession: { groupId: group.group.id, sessionId: LOCAL_AGENT, title: 'Local Claude' },
  });
  const routed = await fx.host.routeTeamChatMessage(PROJECT, { id: 'member-chat', teamId: TEAM, sharedProjectId: SHARED,
    body: 'Please check this', mentions: [REMOTE_AGENT], author: { kind: 'human', accountId: OWNER, displayName: 'Owner Sam' } });
  expect(routed).toBe('routed');
  expect(fx.enqueued.at(-1)?.recipients).toEqual(['owner']);
  const live = fx.group()!;
  const remoteMember = live.members.find((member) => member.sessionId === proxySessionId)!;
  const deliveryId = 'converted-group-delivery';
  const requestId = 'converted-group-request';
  const runId = 'converted-proxy-run';
  live.deliveries.push({ id: deliveryId, groupId: live.group.id, requestId, messageId: 'converted-message', memberId: remoteMember.id,
    status: 'running', runId, hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'request' });
  const userMessage = fx.store.insertMessage({ sessionId: proxySessionId, role: 'user', content: 'Check the change', runId, kind: 'group-delivery' });
  const proxySession = fx.store.getSession(proxySessionId)!;
  fx.store.insertRun({ id: runId, sessionId: proxySessionId, userMessageId: userMessage.id, provider: proxySession.provider, model: proxySession.model,
    startedAt: new Date().toISOString() });
  fx.host.start({ session: proxySession, runId, content: 'Check the change', options: { groupDeliveryId: deliveryId },
    context: { groupId: live.group.id, memberId: remoteMember.id, requestId, deliveryId, hop: 0, instructions: 'Team instructions' } });
  await waitFor(() => fx.outgoing.find((entry) => entry.kind === 'teamgroup.delivery' && (entry.payload as { deliveryId?: string }).deliveryId === deliveryId));
  expect(fx.outgoing.find((entry) => entry.kind === 'teamgroup.delivery')).toMatchObject({ toDeviceId: OWNER_DEVICE });
});

it('uses the selected group mode when a teammate agent converts a single session', async () => {
  const fx = fixture();
  seedRemoteConsent(fx);
  const group = await fx.host.addAgentToSession(LOCAL_AGENT, { agentId: REMOTE_AGENT, mode: 'cowork' });
  expect(group.group.mode).toBe('cowork');
  expect(group.group.orchestratorMemberId).toBeNull();
  expect(group.members.every((member) => member.role === 'peer')).toBe(true);
});

it('adds a teammate agent to an existing ordinary group and blocks a second team session', async () => {
  const fx = fixture();
  seedRemoteConsent(fx);
  const second = fx.store.insertSession({ id: 'local-worker', projectId: PROJECT, name: 'Local worker', provider: 'claude', model: 'claude-sonnet-5-5',
    effort: 'high', policy: 'supervised', isolated: false, worktreePath: fx.project.path, branch: null });
  const existing: GroupSnapshot = { group: { id: 'group_existing', projectId: PROJECT, title: 'Existing discussion', anchorSessionId: LOCAL_AGENT,
    mode: 'orchestrated', orchestratorMemberId: 'member-lead', paused: false, pauseReason: null, maxParallel: 2, maxTurns: 80, maxHops: 6,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, members: [
      { id: 'member-lead', groupId: 'group_existing', sessionId: LOCAL_AGENT, handle: 'claude1', role: 'orchestrator', held: false, joinedAt: new Date().toISOString(), removedAt: null },
      { id: 'member-worker', groupId: 'group_existing', sessionId: second.id, handle: 'claude2', role: 'worker', held: false, joinedAt: new Date().toISOString(), removedAt: null },
    ], messages: [], requests: [], deliveries: [], assignments: [] };
  fx.setGroup(existing);
  const group = await fx.host.addAgentToGroup('group_existing', { agentId: REMOTE_AGENT });
  expect(group.members.map((member) => member.sessionId)).toContain('local-worker');
  expect(group.members.some((member) => member.sessionId.startsWith('proxy_'))).toBe(true);
  const other = fx.store.insertSession({ id: 'another-local-session', projectId: PROJECT, name: 'Another session', provider: 'codex', model: 'gpt-6-codex',
    effort: 'high', policy: 'supervised', isolated: false, worktreePath: fx.project.path, branch: null });
  await expect(fx.host.addAgentToSession(other.id, { agentId: REMOTE_AGENT })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Existing discussion') });
});

it('requires the host lead/admin and clears team-session metadata when the last proxy member is removed', async () => {
  const denied = fixture({ role: 'member' });
  seedRemoteConsent(denied);
  await expect(denied.host.addAgentToSession(LOCAL_AGENT, { agentId: REMOTE_AGENT })).rejects.toMatchObject({ status: 403 });

  const fx = fixture();
  seedRemoteConsent(fx);
  const group = await fx.host.addAgentToSession(LOCAL_AGENT, { agentId: REMOTE_AGENT });
  const remote = group.members.find((member) => member.sessionId.startsWith('proxy_'))!;
  fx.removeGroupMember(remote.id);
  await waitFor(() => fx.store.db.prepare('SELECT removed_at FROM mingle_team_host_roster WHERE agent_id=?').get(REMOTE_AGENT)
    && (fx.store.db.prepare('SELECT removed_at FROM mingle_team_host_roster WHERE agent_id=?').get(REMOTE_AGENT) as { removed_at: string | null }).removed_at !== null);
  expect((await fx.host.structure(PROJECT)).teamSession).toMatchObject({ groupId: group.group.id, sessionId: LOCAL_AGENT });
  expect(fx.store.listEvents({ projectId: PROJECT }).filter((event) => event.type === 'team.session.updated').at(-1)?.payload)
    .toMatchObject({ teamSession: { groupId: group.group.id, sessionId: LOCAL_AGENT } });
});

it('clears and broadcasts the team session when its group is deleted, keeping team mode and consent', async () => {
  const fx = fixture();
  seedRemoteConsent(fx);
  const group = await fx.host.addAgentToSession(LOCAL_AGENT, { agentId: REMOTE_AGENT });
  expect((await fx.host.structure(PROJECT)).teamSession?.groupId).toBe(group.group.id);

  fx.archiveGroup();
  await waitFor(() => fx.outgoing.some((entry) => entry.kind === 'teamgroup.structure'
    && (entry.payload as { teamSession?: unknown }).teamSession === null));

  expect(fx.outgoing.filter((entry) => entry.kind === 'teamgroup.structure').at(-1)?.payload).toMatchObject({ teamSession: null, members: [] });
  const structure = await fx.host.structure(PROJECT);
  expect(structure).toMatchObject({ enabled: true, teamSession: null });
  expect(fx.store.db.prepare('SELECT group_id FROM mingle_team_host_projects WHERE team_id=? AND shared_project_id=?').get(TEAM, SHARED))
    .toEqual({ group_id: '' });
  expect((await fx.host.availableAgents(PROJECT)).agents[0]).toMatchObject({ consent: 'granted', usable: true });

  const next = await fx.host.addAgentToSession(LOCAL_AGENT, { agentId: REMOTE_AGENT });
  expect(next.group.id).not.toBe(group.group.id);
  expect((await fx.host.structure(PROJECT)).teamSession?.groupId).toBe(next.group.id);
});

it('rejects remote dispatch when consent identity or disclaimer no longer matches the proxy owner', async () => {
  const fx = fixture();
  await fx.host.enable(PROJECT, enableInput(REMOTE_AGENT));
  await grantRemote(fx);
  const proxySessionId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?')
    .get(REMOTE_AGENT) as { session_id: string }).session_id);
  const proxySession = fx.store.getSession(proxySessionId)!;
  const dispatch = () => fx.host.start({ session: proxySession, runId: 'stale-consent-run', content: 'no dispatch', options: {} as any });

  fx.store.db.prepare(`UPDATE mingle_team_host_consents SET owner_device_id=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
    .run(DEVICE, TEAM, SHARED, REMOTE_AGENT);
  expect(() => dispatch()).toThrow(/current consent/i);
  fx.store.db.prepare(`UPDATE mingle_team_host_consents SET owner_device_id=?,disclaimer_version=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
    .run(OWNER_DEVICE, 'outdated-disclaimer', TEAM, SHARED, REMOTE_AGENT);
  expect(() => dispatch()).toThrow(/current consent/i);
});

it('returns 404 for an unknown published agent and 409 for an agent without consent', async () => {
  const fx = fixture();
  await expect(fx.host.addAgentToSession(LOCAL_AGENT, { agentId: 'not-published' })).rejects.toMatchObject({ status: 404 });
  await expect(fx.host.addAgentToSession(LOCAL_AGENT, { agentId: REMOTE_AGENT })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('consent') });
});

it('does not route member messages into a group before a teammate agent is added', async () => {
  const fx = fixture();
  await fx.host.enable(PROJECT, enableInput());
  await fx.host.update(PROJECT, { expectedVersion: 1, leaderOrchestration: false });
  const result = await fx.host.routeTeamChatMessage(PROJECT, { id: 'member-untagged', teamId: TEAM, sharedProjectId: SHARED,
    body: 'Use the group mode', mentions: [], author: { kind: 'human', accountId: OWNER, displayName: 'Owner Sam' } });
  expect(result).toBe('handled');
  expect(fx.enqueued).toHaveLength(0);
});

it('pumps queued team work when renewed owner consent makes a remote member eligible', async () => {
  const fx = fixture();
  const group = await addRemoteToSession(fx);
  const remote = group.members.find((member) => member.sessionId.startsWith('proxy_'))!;
  remote.held = true;
  fx.store.db.prepare(`UPDATE mingle_team_host_consents SET state='paused' WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
    .run(TEAM, SHARED, REMOTE_AGENT);
  expect(remote.held).toBe(true);

  await grantRemote(fx);

  expect(group.members.find((member) => member.sessionId.startsWith('proxy_'))?.held).toBe(false);
  expect(fx.pumpCount()).toBe(1);
});

it('dispatches remote proxy deliveries, proxies team MCP calls, rejects mismatched owners, and records completion', async () => {
  const integrationCalls: unknown[] = [];
  const fx = fixture({ integrateTeamArtifact: async (input) => {
    integrationCalls.push(input);
    return { beforeRevision: String(input.artifact.revision), revision: String(input.artifact.revision), integrated: true };
  } });
  const group = await addRemoteToSession(fx);
  const sessionId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
  const member = group.members.find((candidate) => candidate.sessionId === sessionId)!;
  const deliveryId = 'team-delivery-1';
  const requestId = 'team-request-1';
  group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId, messageId: 'group-message-1', memberId: member.id,
    status: 'running', runId: 'host-run-1', hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'assignment' });
  group.assignments.push({ id: 'team-assignment-1', groupId: group.group.id, requestId, fromMemberId: group.members.find((candidate) => candidate.role === 'orchestrator')!.id,
    toMemberId: member.id, taskId: 'task-scoped-1', deliveryId, scope: ['src/features/landing.ts', 'tests/landing.test.ts'], createdAt: new Date().toISOString() });
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
  await waitFor(() => fx.outgoing.find((entry) => entry.kind === 'teamgroup.delivery' && (entry.payload as { deliveryId?: string }).deliveryId === deliveryId));
  const artifactWorktree = path.join(path.dirname(fx.project.path), `team-host-artifact-${randomUUID()}`);
  paths.push(artifactWorktree);
  runGit(fx.project.path, 'worktree', 'add', '--detach', artifactWorktree, inputRevision);
  mkdirSync(path.join(artifactWorktree, 'src/features'), { recursive: true });
  writeFileSync(path.join(artifactWorktree, 'src/features/landing.ts'), 'export const landing = true;\n');
  runGit(artifactWorktree, 'add', '--', 'src/features/landing.ts');
  runGit(artifactWorktree, '-c', 'user.name=Owner test', '-c', 'user.email=owner-test@example.invalid', 'commit', '-m', 'Scoped owner artifact');
  const artifactRevision = runGit(artifactWorktree, 'rev-parse', '--verify', 'HEAD').trim();
  const artifactRef = `refs/mingle/team/${SHARED}/${deliveryId}/${artifactRevision}`;
  runGit(fx.project.path, 'update-ref', artifactRef, artifactRevision);
  const dispatched = fx.outgoing.find((entry) => entry.kind === 'teamgroup.delivery');
  const dispatchedPayload = dispatched?.payload as Record<string, unknown>;
  expect(dispatchedPayload.scope).toEqual(['src/features/landing.ts', 'tests/landing.test.ts']);
  expect(TeamDeliveryPayloadSchema.safeParse(dispatched?.payload)).toMatchObject({ success: true });
  expect(dispatched?.payload).toMatchObject({ content: expect.stringContaining('Git ref: refs/mingle/team/input/'),
    inputArtifacts: [expect.objectContaining({ revision: inputRevision, taskId: 'task-input-1', path: 'README.md', transferId: 'host-input-transfer' })],
    taskId: 'task-scoped-1', scope: ['src/features/landing.ts', 'tests/landing.test.ts'],
    baseRevision: inputRevision, integrationDeviceId: DEVICE, permissionLevel: 'supervised', settingsVersion: 1, kind: 'assignment' });
  await expect(fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, status: 'running', runId: 'owner-run-1', at: new Date().toISOString() }, DEVICE))
    .rejects.toMatchObject({ status: 403 });
  await expect(fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId: 'unknown-delivery', agentId: REMOTE_AGENT, status: 'running', runId: 'owner-run-1', at: new Date().toISOString() }))
    .rejects.toMatchObject({ status: 404 });

  await fx.incoming('teamgroup.tool.call', { sharedProjectId: SHARED, deliveryId, callId: 'call-1', agentId: REMOTE_AGENT, tool: 'team_members', args: {} });
  expect(fx.outgoing.find((entry) => entry.kind === 'teamgroup.tool.result')?.payload).toMatchObject({ callId: 'call-1', ok: true, result: { actual: true } });
  const rejectedArtifact = { revision: inputRevision, transferId: 'out-of-scope-transfer', path: 'README.md', taskId: 'task-scoped-1' };
  await fx.incoming('teamgroup.tool.call', { sharedProjectId: SHARED, deliveryId, callId: 'artifact-out-of-scope', agentId: REMOTE_AGENT,
    tool: 'team_artifact', args: { recipient: group.members.find((candidate) => candidate.role === 'orchestrator')!.handle, path: rejectedArtifact.path, revision: rejectedArtifact.revision,
      taskId: rejectedArtifact.taskId, __mingleArtifactTransfer: rejectedArtifact } });
  expect(fx.outgoing.find((entry) => entry.kind === 'teamgroup.tool.result' && (entry.payload as any).callId === 'artifact-out-of-scope')?.payload)
    .toMatchObject({ ok: false, error: expect.stringContaining('outside its assigned scope') });
  expect(fx.artifactImports).toHaveLength(0);
  expect(fx.remoteToolCalls.some((call) => call.tool === 'team_artifact')).toBe(false);

  const requestedArtifact = { revision: artifactRevision, transferId: 'd'.repeat(64), path: 'src/features/landing.ts', taskId: 'task-scoped-1' };
  await fx.incoming('teamgroup.tool.call', { sharedProjectId: SHARED, deliveryId, callId: 'artifact-in-scope', agentId: REMOTE_AGENT,
    tool: 'team_artifact', args: { recipient: group.members.find((candidate) => candidate.role === 'orchestrator')!.handle, path: requestedArtifact.path, revision: requestedArtifact.revision,
      taskId: requestedArtifact.taskId, __mingleArtifactTransfer: requestedArtifact } });
  expect(fx.artifactImports).toContainEqual(expect.objectContaining({ artifact: requestedArtifact, sourceDeviceId: OWNER_DEVICE }));
  expect(fx.remoteToolCalls.at(-1)).toMatchObject({ tool: 'team_artifact', importsAtCall: 1,
    args: { recipient: group.members.find((candidate) => candidate.role === 'orchestrator')!.handle,
      path: requestedArtifact.path, revision: requestedArtifact.revision, taskId: requestedArtifact.taskId } });
  expect((fx.remoteToolCalls.at(-1)!.args as any).__mingleArtifactTransfer).toBeUndefined();

  runGit(artifactWorktree, 'mv', 'src/features/landing.ts', 'src/features/Landing.ts');
  runGit(artifactWorktree, '-c', 'user.name=Owner test', '-c', 'user.email=owner-test@example.invalid', 'commit', '-m', 'Change an assigned path by case');
  const caseRevision = runGit(artifactWorktree, 'rev-parse', '--verify', 'HEAD').trim();
  runGit(fx.project.path, 'update-ref', `refs/mingle/team/${SHARED}/${deliveryId}/${caseRevision}`, caseRevision);
  const callsBeforeCaseArtifact = fx.remoteToolCalls.length;
  await fx.incoming('teamgroup.tool.call', { sharedProjectId: SHARED, deliveryId, callId: 'artifact-case-scope', agentId: REMOTE_AGENT,
    tool: 'team_artifact', args: { recipient: group.members.find((candidate) => candidate.role === 'orchestrator')!.handle,
      path: 'src/features/landing.ts', revision: caseRevision, taskId: 'task-scoped-1',
      __mingleArtifactTransfer: { revision: caseRevision, transferId: 'a'.repeat(64), path: 'src/features/landing.ts', taskId: 'task-scoped-1' } } });
  expect(fx.outgoing.find((entry) => entry.kind === 'teamgroup.tool.result' && (entry.payload as any).callId === 'artifact-case-scope')?.payload)
    .toMatchObject({ ok: false, error: expect.stringContaining('out-of-scope path src/features/Landing.ts') });
  expect(fx.remoteToolCalls).toHaveLength(callsBeforeCaseArtifact);
  runGit(artifactWorktree, 'mv', 'src/features/Landing.ts', 'src/features/landing.ts');
  runGit(artifactWorktree, '-c', 'user.name=Owner test', '-c', 'user.email=owner-test@example.invalid', 'commit', '-m', 'Restore assigned path casing');

  writeFileSync(path.join(artifactWorktree, 'README.md'), '# changed outside the assigned source scope\n');
  runGit(artifactWorktree, 'add', '--', 'README.md');
  runGit(artifactWorktree, '-c', 'user.name=Owner test', '-c', 'user.email=owner-test@example.invalid', 'commit', '-m', 'Intermediate out-of-scope change');
  mkdirSync(path.join(artifactWorktree, 'docs'), { recursive: true });
  runGit(artifactWorktree, 'mv', 'README.md', 'docs/README.md');
  runGit(artifactWorktree, '-c', 'user.name=Owner test', '-c', 'user.email=owner-test@example.invalid', 'commit', '-m', 'Rename out-of-scope file');
  runGit(artifactWorktree, 'rm', 'docs/README.md');
  runGit(artifactWorktree, '-c', 'user.name=Owner test', '-c', 'user.email=owner-test@example.invalid', 'commit', '-m', 'Delete renamed out-of-scope file');
  const hostileRevision = runGit(artifactWorktree, 'rev-parse', '--verify', 'HEAD').trim();
  const hostileRef = `refs/mingle/team/${SHARED}/${deliveryId}/${hostileRevision}`;
  runGit(fx.project.path, 'update-ref', hostileRef, hostileRevision);
  const callsBeforeHostileArtifact = fx.remoteToolCalls.length;
  await fx.incoming('teamgroup.tool.call', { sharedProjectId: SHARED, deliveryId, callId: 'artifact-hidden-readme', agentId: REMOTE_AGENT,
    tool: 'team_artifact', args: { recipient: group.members.find((candidate) => candidate.role === 'orchestrator')!.handle,
      path: 'src/features/landing.ts', revision: hostileRevision, taskId: 'task-scoped-1',
      __mingleArtifactTransfer: { revision: hostileRevision, transferId: 'e'.repeat(64), path: 'src/features/landing.ts', taskId: 'task-scoped-1' } } });
  expect(fx.outgoing.find((entry) => entry.kind === 'teamgroup.tool.result' && (entry.payload as any).callId === 'artifact-hidden-readme')?.payload)
    .toMatchObject({ ok: false, error: expect.stringContaining('out-of-scope path') });
  expect(fx.remoteToolCalls).toHaveLength(callsBeforeHostileArtifact);
  await expect(fx.incoming('teamgroup.tool.call', { sharedProjectId: SHARED, deliveryId, callId: 'call-bad', agentId: LOCAL_AGENT, tool: 'team_members', args: {} })).rejects.toMatchObject({ status: 403 });

  await fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, status: 'running', runId: 'owner-run-1', at: new Date().toISOString() });
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

  let releaseDelayedStatus!: () => void;
  fx.delayAuthorization(new Promise<void>((resolve) => { releaseDelayedStatus = resolve; }));
  const delayedRunningStatus = fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT,
    status: 'running', runId: 'owner-run-1', at: new Date().toISOString() });
  const completedStatus = { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, status: 'completed', runId: 'owner-run-1' as const,
    finalText: 'Reviewed and found one issue.', artifacts: [{ revision: hostileRevision, transferId: 'f'.repeat(64), taskId: 'task-scoped-1' }], at: new Date().toISOString() };
  await fx.incoming('teamgroup.delivery.status', completedStatus);
  releaseDelayedStatus();
  await delayedRunningStatus;
  await fx.incoming('teamgroup.delivery.status', completedStatus);
  expect(integrationCalls).toHaveLength(0);
  expect(runGit(fx.project.path, 'rev-parse', '--verify', 'HEAD').trim()).toBe(inputRevision);
  expect(readFileSync(path.join(fx.project.path, 'README.md'), 'utf8')).not.toContain('outside the assigned source scope');
  expect(runGit(artifactWorktree, 'rev-parse', '--verify', 'HEAD').trim()).toBe(hostileRevision);
  expect(fx.store.db.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId)).toMatchObject({ status: 'completed' });
  expect(fx.finished.filter((entry) => entry.runId === 'host-run-1')).toHaveLength(1);
  expect(fx.finished).toContainEqual({ sessionId, runId: 'host-run-1', outcome: 'completed' });
  expect(fx.store.getRun('host-run-1')?.status).toBe('completed');
  expect(fx.store.listMessages(sessionId, { limit: 20 }).filter((message) => message.role === 'assistant'
    && message.content.includes('Reviewed and found one issue.'))).toHaveLength(1);
  await expect(fx.incoming('teamgroup.tool.call', { sharedProjectId: SHARED, deliveryId, callId: 'call-finished', agentId: REMOTE_AGENT, tool: 'team_members', args: {} })).rejects.toMatchObject({ status: 404 });
});

it('imports remote artifacts into isolated refs and includes those ref names in the orchestrator result', async () => {
  const fx = fixture();
  const group = await addRemoteToSession(fx);
  const sessionId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
  const member = group.members.find((candidate) => candidate.sessionId === sessionId)!;
  const deliveryId = 'team-artifact-delivery';
  const requestId = 'team-artifact-request';
  group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId, messageId: 'team-artifact-message', memberId: member.id,
    status: 'running', runId: 'team-artifact-run', hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'request' });
  const userMessage = fx.store.insertMessage({ sessionId, role: 'user', content: 'Implement this task', runId: 'team-artifact-run' });
  fx.store.insertRun({ id: 'team-artifact-run', sessionId, userMessageId: userMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
  fx.host.start({ session: fx.store.getSession(sessionId)!, runId: 'team-artifact-run', content: 'Implement this task', options: { groupDeliveryId: deliveryId },
    context: { groupId: group.group.id, memberId: member.id, requestId, deliveryId, hop: 0, instructions: 'Instructions' } });
  await waitFor(() => fx.outgoing.find((entry) => entry.kind === 'teamgroup.delivery' && (entry.payload as { deliveryId?: string }).deliveryId === deliveryId));
  mkdirSync(path.join(fx.project.path, 'src'), { recursive: true });
  writeFileSync(path.join(fx.project.path, 'src/output.ts'), 'export const output = true;\n');
  runGit(fx.project.path, 'add', '--', 'src/output.ts');
  runGit(fx.project.path, '-c', 'user.name=Host test', '-c', 'user.email=host-test@example.invalid', 'commit', '-m', 'Output artifact');
  const revision = runGit(fx.project.path, 'rev-parse', '--verify', 'HEAD').trim();
  const artifactRef = `refs/mingle/team/${SHARED}/${deliveryId}/${revision}`;
  runGit(fx.project.path, 'update-ref', artifactRef, revision);
  const artifact = { revision, transferId: 'a'.repeat(64), path: 'src/output.ts' };
  await fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, status: 'completed',
    runId: 'owner-run-artifact', finalText: 'The implementation is committed.', artifacts: [artifact], at: new Date().toISOString() });
  expect(fx.artifactImports).toEqual([expect.objectContaining({ teamId: TEAM, sharedProjectId: SHARED, deliveryId,
    sourceDeviceId: OWNER_DEVICE, artifact })]);
  const refs = fx.store.db.prepare('SELECT artifacts_json FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId) as { artifacts_json: string };
  const stored = JSON.parse(refs.artifacts_json) as Array<{ ref: string; revision: string }>;
  expect(stored[0]).toMatchObject({ revision, ref: `refs/mingle/team/${SHARED}/${deliveryId}/${revision}` });
  const assistant = fx.store.listMessages(sessionId, { limit: 20 }).find((message) => message.role === 'assistant');
  expect(assistant?.content).toContain(`Git ref: refs/mingle/team/${SHARED}/${deliveryId}/${revision}`);
  expect(assistant?.content).toContain('Artifact import/integration failures');
});

it('does not import or integrate a completed artifact after the owner revokes team consent', async () => {
  const fx = fixture({ integrateTeamArtifact: async ({ artifact }) => ({ beforeRevision: 'a'.repeat(40), revision: artifact.revision, integrated: true }) });
  const group = await addRemoteToSession(fx);
  const sessionId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
  const member = group.members.find((candidate) => candidate.sessionId === sessionId)!;
  const deliveryId = 'team-revoked-artifact-delivery';
  const runId = 'team-revoked-artifact-run';
  group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId: 'team-revoked-request', messageId: 'team-revoked-message', memberId: member.id,
    status: 'running', runId, hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'assignment' });
  const userMessage = fx.store.insertMessage({ sessionId, role: 'user', content: 'Make the assigned change.', runId });
  fx.store.insertRun({ id: runId, sessionId, userMessageId: userMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
  fx.host.start({ session: fx.store.getSession(sessionId)!, runId, content: 'Make the assigned change.', options: { groupDeliveryId: deliveryId },
    context: { groupId: group.group.id, memberId: member.id, requestId: 'team-revoked-request', deliveryId, hop: 0, instructions: 'Instructions' } });
  await waitFor(() => fx.outgoing.some((entry) => entry.kind === 'teamgroup.delivery' && (entry.payload as { deliveryId?: string }).deliveryId === deliveryId));
  fx.store.db.prepare(`UPDATE mingle_team_host_consents SET state='revoked' WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
    .run(TEAM, SHARED, REMOTE_AGENT);

  await fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, status: 'completed', runId: 'owner-run-revoked',
    finalText: 'The owner stopped sharing this agent.', artifacts: [{ revision: 'c'.repeat(40), transferId: 'revoked-transfer', path: 'src/private.ts' }], at: new Date().toISOString() });

  expect(fx.artifactImports).toHaveLength(0);
  expect(fx.artifactIntegrations).toHaveLength(0);
  expect(fx.store.db.prepare('SELECT status,failure_json FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId))
    .toMatchObject({ status: 'interrupted', failure_json: expect.stringContaining('consent') });
  expect(fx.finished).toContainEqual({ sessionId, runId, outcome: 'interrupted' });
});

it('allows the next remote assignment to start from completion and does not idle its running proxy session', async () => {
  const fx = fixture();
  const group = await addRemoteToSession(fx);
  const sessionId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
  const member = group.members.find((candidate) => candidate.sessionId === sessionId)!;
  const firstDeliveryId = 'team-consecutive-first';
  const firstRunId = 'team-consecutive-first-run';
  group.deliveries.push({ id: firstDeliveryId, groupId: group.group.id, requestId: 'team-consecutive-request', messageId: 'team-consecutive-message-1', memberId: member.id,
    status: 'running', runId: firstRunId, hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'assignment' });
  const firstMessage = fx.store.insertMessage({ sessionId, role: 'user', content: 'Build the first artifact.', runId: firstRunId });
  fx.store.insertRun({ id: firstRunId, sessionId, userMessageId: firstMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
  fx.host.start({ session: fx.store.getSession(sessionId)!, runId: firstRunId, content: 'Build the first artifact.', options: { groupDeliveryId: firstDeliveryId },
    context: { groupId: group.group.id, memberId: member.id, requestId: 'team-consecutive-request', deliveryId: firstDeliveryId, hop: 0, instructions: 'Instructions' } });
  await waitFor(() => fx.outgoing.some((entry) => entry.kind === 'teamgroup.delivery' && (entry.payload as { deliveryId?: string }).deliveryId === firstDeliveryId));

  let secondDeliveryId = '';
  let secondRunId = '';
  fx.afterRunFinished((_sessionId, completedRunId, outcome) => {
    if (completedRunId !== firstRunId || outcome !== 'completed') throw new Error('Unexpected completion callback.');
    secondDeliveryId = 'team-consecutive-second';
    secondRunId = 'team-consecutive-second-run';
    const secondRequestId = 'team-consecutive-request-2';
    group.deliveries.push({ id: secondDeliveryId, groupId: group.group.id, requestId: secondRequestId, messageId: 'team-consecutive-message-2', memberId: member.id,
      status: 'running', runId: secondRunId, hop: 1, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'assignment' });
    const secondMessage = fx.store.insertMessage({ sessionId, role: 'user', content: 'Build the focused follow-up.', runId: secondRunId });
    fx.store.insertRun({ id: secondRunId, sessionId, userMessageId: secondMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
    fx.store.updateSession(sessionId, { status: 'running', error: null });
    fx.host.start({ session: fx.store.getSession(sessionId)!, runId: secondRunId, content: 'Build the focused follow-up.', options: { groupDeliveryId: secondDeliveryId },
      context: { groupId: group.group.id, memberId: member.id, requestId: secondRequestId, deliveryId: secondDeliveryId, hop: 1, instructions: 'Instructions' } });
  });

  await fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId: firstDeliveryId, agentId: REMOTE_AGENT, status: 'completed',
    runId: 'owner-run-consecutive-1', finalText: 'First assignment complete.', artifacts: [], at: new Date().toISOString() });
  await waitFor(() => secondDeliveryId && fx.outgoing.some((entry) => entry.kind === 'teamgroup.delivery'
    && (entry.payload as { deliveryId?: string }).deliveryId === secondDeliveryId));

  expect(fx.store.db.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?').get(firstDeliveryId)).toMatchObject({ status: 'completed' });
  expect(fx.store.db.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?').get(secondDeliveryId)).toMatchObject({ status: 'accepted' });
  expect(fx.host.isRunLive(sessionId, secondRunId)).toBe(true);
  expect(fx.store.getSession(sessionId)?.status).toBe('running');
});

it('resumes persisted artifact progress after host restart without redispatching the provider or duplicating final notifications', async () => {
  const fx = fixture({ integrateTeamArtifact: async ({ artifact }) => ({ beforeRevision: 'a'.repeat(40), revision: artifact.revision, integrated: true }) });
  const group = await addRemoteToSession(fx);
  const sessionId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
  const member = group.members.find((candidate) => candidate.sessionId === sessionId)!;
  const deliveryId = 'team-restart-artifact-delivery';
  const hostRunId = 'team-restart-host-run';
  group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId: 'team-restart-request', messageId: 'team-restart-message', memberId: member.id,
    status: 'running', runId: hostRunId, hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'request' });
  const userMessage = fx.store.insertMessage({ sessionId, role: 'user', content: 'Implement and hand off the result.', runId: hostRunId });
  fx.store.insertRun({ id: hostRunId, sessionId, userMessageId: userMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
  fx.host.start({ session: fx.store.getSession(sessionId)!, runId: hostRunId, content: 'Implement and hand off the result.', options: { groupDeliveryId: deliveryId },
    context: { groupId: group.group.id, memberId: member.id, requestId: 'team-restart-request', deliveryId, hop: 0, instructions: 'Instructions' } });
  await waitFor(() => fx.outgoing.some((entry) => entry.kind === 'teamgroup.delivery' && (entry.payload as { deliveryId?: string }).deliveryId === deliveryId));

  const at = new Date().toISOString();
  writeFileSync(path.join(fx.project.path, 'result.ts'), 'export const result = true;\n');
  runGit(fx.project.path, 'add', '--', 'result.ts');
  runGit(fx.project.path, '-c', 'user.name=Host test', '-c', 'user.email=host-test@example.invalid', 'commit', '-m', 'Persisted result artifact');
  const revision = runGit(fx.project.path, 'rev-parse', '--verify', 'HEAD').trim();
  const source = { revision, transferId: 'b'.repeat(64), path: 'result.ts' };
  const imported = { ...source, ref: `refs/mingle/team/${SHARED}/${deliveryId}/${revision}` };
  runGit(fx.project.path, 'update-ref', imported.ref, revision);
  const completionIntent = {
    kind: 'team-completion', version: 1, phase: 'artifacts', remoteRunId: 'owner-run-restart', at,
    finalText: 'The worker finished before the host restarted.', workspaceBefore: null,
    artifacts: [{ source, state: 'pending', imported }], artifactFailures: [], importedArtifacts: [imported], integratedArtifacts: [],
  };
  fx.store.db.prepare(`UPDATE mingle_team_host_deliveries SET status='running',remote_run_id=?,artifacts_json=?,failure_json=? WHERE delivery_id=?`)
    .run('owner-run-restart', JSON.stringify([imported]), JSON.stringify(completionIntent), deliveryId);

  fx.restartHost();
  await waitFor(() => (fx.store.db.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId) as { status: string }).status === 'completed');
  const replay = { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, status: 'completed' as const,
    runId: 'owner-run-restart', finalText: completionIntent.finalText, artifacts: [source], at };
  await fx.incoming('teamgroup.delivery.status', replay);

  expect(fx.artifactImports).toHaveLength(0);
  expect(fx.artifactIntegrations, fx.store.listMessages(sessionId, { limit: 30 }).find((message) => message.role === 'assistant' && message.runId === hostRunId)?.content)
    .toHaveLength(1);
  expect(fx.outgoing.filter((entry) => entry.kind === 'teamgroup.delivery' && (entry.payload as { deliveryId?: string }).deliveryId === deliveryId)).toHaveLength(1);
  expect(fx.finished.filter((entry) => entry.runId === hostRunId)).toHaveLength(1);
  expect(fx.store.getRun(hostRunId)?.status).toBe('completed');
  expect(fx.store.listMessages(sessionId, { limit: 30 }).filter((message) => message.role === 'assistant' && message.runId === hostRunId)).toHaveLength(1);
  expect(fx.store.listMessages(sessionId, { limit: 30 }).find((message) => message.role === 'assistant' && message.runId === hostRunId)?.content)
    .toContain('The worker finished before the host restarted.');
  expect(fx.store.db.prepare(`SELECT COUNT(*) AS count FROM events WHERE type='team.delivery.completed' AND json_extract(payload,'$.deliveryId')=?`)
    .get(deliveryId)).toEqual({ count: 1 });
});

it('replays a persisted post-completion group notification after restart without replaying provider work', async () => {
  const fx = fixture();
  const chatReplies: Array<Record<string, unknown>> = [];
  const chatStates: Array<Record<string, unknown>> = [];
  const chat = {
    postOrchestratedAgentReply: async (input: Record<string, unknown>) => { chatReplies.push(input); },
    setOrchestratedRunState: async (input: Record<string, unknown>) => { chatStates.push(input); },
  } as any;
  fx.host.setTeamChat(chat);
  const group = await addRemoteToSession(fx);
  const sessionId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
  const member = group.members.find((candidate) => candidate.sessionId === sessionId)!;
  const deliveryId = 'team-notification-restart-delivery';
  const runId = 'team-notification-restart-run';
  group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId: 'team-notification-restart-request', messageId: 'team-notification-restart-message', memberId: member.id,
    status: 'running', runId, hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'assignment' });
  const userMessage = fx.store.insertMessage({ sessionId, role: 'user', content: 'Finish and notify the coordinator.', runId });
  fx.store.insertRun({ id: runId, sessionId, userMessageId: userMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
  fx.host.start({ session: fx.store.getSession(sessionId)!, runId, content: 'Finish and notify the coordinator.', options: { groupDeliveryId: deliveryId },
    context: { groupId: group.group.id, memberId: member.id, requestId: 'team-notification-restart-request', deliveryId, hop: 0, instructions: 'Instructions' } });
  await waitFor(() => fx.outgoing.some((entry) => entry.kind === 'teamgroup.delivery' && (entry.payload as { deliveryId?: string }).deliveryId === deliveryId));

  const at = new Date().toISOString();
  const finalText = 'The committed result is integrated.';
  const intent = {
    kind: 'team-completion', version: 1, phase: 'notifying', remoteRunId: 'owner-run-notify-restart', at, finalText,
    finalContent: finalText, workspaceBefore: null, artifacts: [], artifactFailures: [], importedArtifacts: [], integratedArtifacts: [],
  };
  fx.store.finishRun(runId, 'completed', 1, at);
  fx.store.updateSession(sessionId, { status: 'idle', error: null });
  fx.store.insertMessage({ id: 'persisted-final-message', sessionId, runId, role: 'assistant', content: finalText });
  fx.store.db.prepare(`UPDATE mingle_team_host_deliveries SET status='completed',remote_run_id=?,source_chat_message_id=?,artifacts_json='[]',failure_json=? WHERE delivery_id=?`)
    .run('owner-run-notify-restart', 'source-chat-notify-restart', JSON.stringify(intent), deliveryId);

  fx.restartHost().setTeamChat(chat);
  await waitFor(() => (fx.store.db.prepare('SELECT failure_json FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId) as { failure_json: string | null }).failure_json === null);
  await fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, status: 'completed',
    runId: 'owner-run-notify-restart', finalText, artifacts: [], at });

  expect(fx.outgoing.filter((entry) => entry.kind === 'teamgroup.delivery' && (entry.payload as { deliveryId?: string }).deliveryId === deliveryId)).toHaveLength(1);
  expect(fx.finished.filter((entry) => entry.runId === runId)).toHaveLength(1);
  expect(fx.group()!.deliveries.find((entry) => entry.id === deliveryId)?.status).toBe('completed');
  expect(fx.store.listMessages(sessionId, { limit: 30 }).filter((message) => message.role === 'assistant' && message.runId === runId)).toHaveLength(1);
  expect(chatReplies).toHaveLength(0);
  expect(chatStates).toContainEqual({ messageId: 'source-chat-notify-restart', state: 'completed' });
});

it('preserves owner-completed artifact progress across graceful shutdown and resumes it without provider replay', async () => {
  let releaseIntegration!: () => void;
  let integrationStarted!: () => void;
  let gatedRevision = '';
  const integrationGate = new Promise<void>((resolve) => { releaseIntegration = resolve; });
  const started = new Promise<void>((resolve) => { integrationStarted = resolve; });
  const fx = fixture({ integrateTeamArtifact: async ({ artifact }) => {
    if (artifact.revision === gatedRevision) {
      integrationStarted();
      await integrationGate;
    }
    return { beforeRevision: 'a'.repeat(40), revision: artifact.revision, integrated: true };
  } });
  const group = await addRemoteToSession(fx);
  const sessionId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
  const member = group.members.find((candidate) => candidate.sessionId === sessionId)!;
  const deliveryId = 'team-graceful-close-delivery';
  const runId = 'team-graceful-close-run';
  const requestId = 'team-graceful-close-request';
  group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId, messageId: 'team-graceful-close-message', memberId: member.id,
    status: 'running', runId, hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'request' });
  const userMessage = fx.store.insertMessage({ sessionId, role: 'user', content: 'Integrate the two committed artifacts.', runId });
  fx.store.insertRun({ id: runId, sessionId, userMessageId: userMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
  fx.host.start({ session: fx.store.getSession(sessionId)!, runId, content: 'Integrate the two committed artifacts.', options: { groupDeliveryId: deliveryId },
    context: { groupId: group.group.id, memberId: member.id, requestId, deliveryId, hop: 0, instructions: 'Instructions' } });
  await waitFor(() => fx.outgoing.some((entry) => entry.kind === 'teamgroup.delivery' && (entry.payload as { deliveryId?: string }).deliveryId === deliveryId));

  const at = new Date().toISOString();
  writeFileSync(path.join(fx.project.path, 'first.ts'), 'export const first = true;\n');
  runGit(fx.project.path, 'add', '--', 'first.ts');
  runGit(fx.project.path, '-c', 'user.name=Host test', '-c', 'user.email=host-test@example.invalid', 'commit', '-m', 'First close artifact');
  const firstRevision = runGit(fx.project.path, 'rev-parse', '--verify', 'HEAD').trim();
  gatedRevision = firstRevision;
  writeFileSync(path.join(fx.project.path, 'second.ts'), 'export const second = true;\n');
  runGit(fx.project.path, 'add', '--', 'second.ts');
  runGit(fx.project.path, '-c', 'user.name=Host test', '-c', 'user.email=host-test@example.invalid', 'commit', '-m', 'Second close artifact');
  const secondRevision = runGit(fx.project.path, 'rev-parse', '--verify', 'HEAD').trim();
  const artifacts = [
    { revision: firstRevision, transferId: 'd'.repeat(64), path: 'first.ts' },
    { revision: secondRevision, transferId: 'e'.repeat(64), path: 'second.ts' },
  ];
  for (const artifact of artifacts) runGit(fx.project.path, 'update-ref', `refs/mingle/team/${SHARED}/${deliveryId}/${artifact.revision}`, artifact.revision);
  const incoming = fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, status: 'completed',
    runId: 'owner-run-graceful-close', finalText: 'Both artifacts are committed.', artifacts, at });
  await started;

  const closing = fx.host.close();
  releaseIntegration();
  await closing;
  await incoming;
  const interruptedState = fx.store.db.prepare('SELECT status,failure_json,artifacts_json FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId) as {
    status: string; failure_json: string | null; artifacts_json: string;
  };
  expect(interruptedState.status).toBe('running');
  expect(interruptedState.failure_json).toContain('team-completion');
  expect(JSON.parse(interruptedState.artifacts_json)).toEqual([expect.objectContaining({ revision: artifacts[0]!.revision, ref: expect.any(String) })]);
  expect(fx.finished.filter((entry) => entry.runId === runId)).toHaveLength(0);

  fx.restartHost();
  await waitFor(() => (fx.store.db.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId) as { status: string }).status === 'completed');

  expect(fx.artifactImports).toHaveLength(2);
  expect(fx.artifactIntegrations).toHaveLength(3);
  expect(fx.outgoing.filter((entry) => entry.kind === 'teamgroup.delivery' && (entry.payload as { deliveryId?: string }).deliveryId === deliveryId)).toHaveLength(1);
  expect(fx.finished.filter((entry) => entry.runId === runId)).toHaveLength(1);
  expect(fx.store.getRun(runId)?.status).toBe('completed');
  expect(fx.store.listMessages(sessionId, { limit: 30 }).filter((message) => message.role === 'assistant' && message.runId === runId)).toHaveLength(1);
});

it('rolls back a manual roster change when the group scheduler rejects the transition', async () => {
  const fx = fixture();
  await addRemoteToSession(fx);
  fx.failNextSync();

  await expect(fx.host.change(PROJECT, { action: 'set-role', agentId: REMOTE_AGENT, role: 'idle', expectedVersion: 1 }))
    .rejects.toThrow(/scheduler rejected/i);

  const structure = await fx.host.structure(PROJECT);
  expect(structure.settings?.version).toBe(1);
  expect(structure.members.find((member) => member.agentId === REMOTE_AGENT)?.role).toBe('worker');
  expect(fx.store.db.prepare('SELECT role FROM mingle_team_host_roster WHERE agent_id=?').get(REMOTE_AGENT)).toMatchObject({ role: 'worker' });
});

it('leaves host leader settings unchanged when an automatic scheduler handover fails', async () => {
  const fx = fixture();
  await fx.host.enable(PROJECT, enableInput(REMOTE_AGENT));
  await grantRemote(fx);
  const group = await fx.host.addAgentToSession(LOCAL_AGENT, { agentId: REMOTE_AGENT });
  await fx.host.change(PROJECT, { action: 'set-orchestrator', agentId: REMOTE_AGENT, expectedVersion: 2 });
  await fx.host.update(PROJECT, { expectedVersion: 3, fallbackAgentIds: [LOCAL_AGENT] });
  const proxyId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
  const member = group.members.find((candidate) => candidate.sessionId === proxyId)!;
  const deliveryId = 'quota-handover-scheduler-failure';
  const requestId = 'quota-handover-scheduler-failure-request';
  group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId, messageId: deliveryId, memberId: member.id,
    status: 'running', runId: 'quota-handover-host-run', hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'request' });
  const userMessage = fx.store.insertMessage({ sessionId: proxyId, role: 'user', content: 'Try work', runId: 'quota-handover-host-run' });
  fx.store.insertRun({ id: 'quota-handover-host-run', sessionId: proxyId, userMessageId: userMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
  fx.host.start({ session: fx.store.getSession(proxyId)!, runId: 'quota-handover-host-run', content: 'Try work', options: { groupDeliveryId: deliveryId },
    context: { groupId: group.group.id, memberId: member.id, requestId, deliveryId, hop: 0, instructions: 'Instructions' } });
  await waitFor(() => fx.outgoing.find((entry) => entry.kind === 'teamgroup.delivery' && (entry.payload as { deliveryId?: string }).deliveryId === deliveryId));
  fx.failNextSync();

  await fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, status: 'failed', runId: 'owner-run-quota-failed',
    failure: { id: 'quota-handover-failure', sessionId: 'owner-session-remote', kind: 'quota_exhausted', actor: 'lead', provider: 'codex', retryable: false,
      dispatchState: 'dispatched', continuationSafety: 'unknown', message: 'Quota exhausted', occurredAt: new Date().toISOString() }, at: new Date().toISOString() });

  const hostRow = fx.store.db.prepare('SELECT settings_json,needs_leader,leader_history_json FROM mingle_team_host_projects WHERE team_id=? AND shared_project_id=?')
    .get(TEAM, SHARED) as { settings_json: string; needs_leader: number; leader_history_json: string };
  expect(JSON.parse(hostRow.settings_json)).toMatchObject({ version: 4, orchestratorAgentId: REMOTE_AGENT, fallbackAgentIds: [LOCAL_AGENT] });
  expect(hostRow.needs_leader).toBe(1);
  expect(JSON.parse(hostRow.leader_history_json)).toMatchObject([expect.objectContaining({ reason: 'manual', toAgentId: REMOTE_AGENT })]);
  expect(group.group.orchestratorMemberId).toBe(member.id);
  expect(group.group.paused).toBe(true);
});

it('supports idle, fallback, promote/swap and remove changes with leader history', async () => {
  const fx = fixture();
  await fx.host.enable(PROJECT, enableInput());
  await grantRemote(fx);
  await fx.host.addAgentToSession(LOCAL_AGENT, { agentId: REMOTE_AGENT });
  const idle = await fx.host.change(PROJECT, { action: 'set-role', agentId: REMOTE_AGENT, role: 'idle', expectedVersion: 2 });
  expect(idle.members.find((member) => member.agentId === REMOTE_AGENT)).toMatchObject({ role: 'idle', state: 'paused' });
  const worker = await fx.host.change(PROJECT, { action: 'set-role', agentId: REMOTE_AGENT, role: 'worker', expectedVersion: 3 });
  expect(worker.members.find((member) => member.agentId === REMOTE_AGENT)?.role).toBe('worker');
  const fallback = await fx.host.change(PROJECT, { action: 'set-fallbacks', agentIds: [REMOTE_AGENT], expectedVersion: 4 });
  expect(fallback.members.find((member) => member.agentId === REMOTE_AGENT)?.fallbackRank).toBe(1);
  const promoted = await fx.host.change(PROJECT, { action: 'set-orchestrator', agentId: REMOTE_AGENT, previousRole: 'idle', expectedVersion: 5 });
  expect(promoted.settings?.orchestratorAgentId).toBe(REMOTE_AGENT);
  expect(promoted.members.find((member) => member.agentId === LOCAL_AGENT)?.role).toBe('idle');
  const swapped = await fx.host.change(PROJECT, { action: 'set-orchestrator', agentId: LOCAL_AGENT, previousRole: 'worker', expectedVersion: 6 });
  expect(swapped.settings?.orchestratorAgentId).toBe(LOCAL_AGENT);
  expect(swapped.members.find((member) => member.agentId === REMOTE_AGENT)?.role).toBe('worker');
  const removedWorker = await fx.host.change(PROJECT, { action: 'remove', agentId: REMOTE_AGENT, expectedVersion: 7 });
  expect(removedWorker.members.some((member) => member.agentId === REMOTE_AGENT)).toBe(false);
  const removedLeader = await fx.host.change(PROJECT, { action: 'remove', agentId: LOCAL_AGENT, expectedVersion: 8 });
  expect(removedLeader.needsLeader).toBe(true);
  expect(removedLeader.settings?.orchestratorAgentId).toBeNull();
  expect(removedLeader.leaderHistory.at(-1)).toMatchObject({ reason: 'removed', fromAgentId: LOCAL_AGENT, toAgentId: null });
  expect(fx.store.listSessions().length).toBe(2); // roster edits keep the real and proxy session history intact
});

it('promotes a consented online fallback after quota exhaustion and never infers during structure updates', async () => {
  const fx = fixture();
  await fx.host.enable(PROJECT, enableInput(REMOTE_AGENT));
  await grantRemote(fx);
  const group = await fx.host.addAgentToSession(LOCAL_AGENT, { agentId: REMOTE_AGENT });
  await fx.host.change(PROJECT, { action: 'set-orchestrator', agentId: REMOTE_AGENT, expectedVersion: 2 });
  await fx.host.update(PROJECT, { expectedVersion: 3, fallbackAgentIds: [LOCAL_AGENT] });
  const proxyId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
  const member = group.members.find((candidate) => candidate.sessionId === proxyId)!;
  const deliveryId = 'quota-delivery';
  const requestId = 'quota-request';
  group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId, messageId: 'quota-message', memberId: member.id,
    status: 'running', runId: 'quota-host-run', hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'request' });
  const userMessage = fx.store.insertMessage({ sessionId: proxyId, role: 'user', content: 'Try work', runId: 'quota-host-run' });
  fx.store.insertRun({ id: 'quota-host-run', sessionId: proxyId, userMessageId: userMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
  fx.host.start({ session: fx.store.getSession(proxyId)!, runId: 'quota-host-run', content: 'Try work', options: { groupDeliveryId: deliveryId },
    context: { groupId: group.group.id, memberId: member.id, requestId, deliveryId, hop: 0, instructions: 'Instructions' } });
  await waitFor(() => fx.outgoing.find((entry) => entry.kind === 'teamgroup.delivery' && (entry.payload as { deliveryId?: string }).deliveryId === deliveryId));
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
  await waitFor(() => fx.outgoing.find((entry) => entry.kind === 'teamgroup.delivery' && (entry.payload as { deliveryId?: string }).deliveryId === nextDeliveryId));
  await fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId: nextDeliveryId, agentId: REMOTE_AGENT, status: 'failed', runId: 'owner-run-quota-2',
    failure: { id: 'failure-2', sessionId: 'owner-session-remote', kind: 'quota_exhausted', actor: 'lead', provider: 'codex', retryable: false,
      dispatchState: 'dispatched', continuationSafety: 'unknown', message: 'Quota exhausted again', occurredAt: new Date().toISOString() }, at: new Date().toISOString() });
  const paused = await fx.host.structure(PROJECT);
  expect(paused.needsLeader).toBe(true);
  expect(group.group.paused).toBe(true);
});

it('fails a proxy delivery at its configurable idle timeout using the injected clock', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-24T12:00:00.000Z') });
  let clock = Date.now();
  try {
    const fx = fixture({ deliveryTimeoutMs: 5_000, now: () => clock });
    const group = await addRemoteToSession(fx);
    const sessionId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
    const member = group.members.find((candidate) => candidate.sessionId === sessionId)!;
    const deliveryId = 'timeout-delivery';
    const requestId = 'timeout-request';
    group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId, messageId: 'timeout-message', memberId: member.id,
      status: 'running', runId: 'timeout-host-run', hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'request' });
    const userMessage = fx.store.insertMessage({ sessionId, role: 'user', content: 'Wait remotely', runId: 'timeout-host-run' });
    fx.store.insertRun({ id: 'timeout-host-run', sessionId, userMessageId: userMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
    fx.host.start({ session: fx.store.getSession(sessionId)!, runId: 'timeout-host-run', content: 'Wait remotely', options: { groupDeliveryId: deliveryId },
      context: { groupId: group.group.id, memberId: member.id, requestId, deliveryId, hop: 0, instructions: 'Instructions' } });
    fx.setOwnerOnline(false);
    clock += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    expect(fx.store.getSession(sessionId)?.error).toContain('device was offline');
    expect(fx.finished).toContainEqual({ sessionId, runId: 'timeout-host-run', outcome: 'failed' });
    expect((fx.store.db.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId) as { status: string }).status).toBe('failed');
  } finally {
    vi.useRealTimers();
  }
});

it('keeps a proxy delivery alive on owner signals and times out after the last signal without a visible state event', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-24T12:00:00.000Z') });
  let clock = Date.now();
  try {
    const fx = fixture({ deliveryTimeoutMs: 5_000, now: () => clock });
    const group = await addRemoteToSession(fx);
    const sessionId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
    const member = group.members.find((candidate) => candidate.sessionId === sessionId)!;
    const deliveryId = 'heartbeat-delivery';
    const requestId = 'heartbeat-request';
    group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId, messageId: 'heartbeat-message', memberId: member.id,
      status: 'running', runId: 'heartbeat-host-run', hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'request' });
    const userMessage = fx.store.insertMessage({ sessionId, role: 'user', content: 'Work for longer than the idle timeout', runId: 'heartbeat-host-run' });
    fx.store.insertRun({ id: 'heartbeat-host-run', sessionId, userMessageId: userMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
    fx.host.start({ session: fx.store.getSession(sessionId)!, runId: 'heartbeat-host-run', content: 'Work', options: { groupDeliveryId: deliveryId },
      context: { groupId: group.group.id, memberId: member.id, requestId, deliveryId, hop: 0, instructions: 'Instructions' } });
    await vi.waitFor(() => expect(fx.outgoing.find((entry) => entry.kind === 'teamgroup.delivery')).toBeTruthy());
    const touch = vi.spyOn(fx.store, 'touch');
    const touchCount = touch.mock.calls.length;
    const firstHeartbeat = { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, runId: 'owner-run-heartbeat', sequence: 1, at: new Date().toISOString() };
    clock += 4_000;
    await vi.advanceTimersByTimeAsync(4_000);
    await fx.incoming('teamgroup.delivery.heartbeat', firstHeartbeat);
    expect(fx.store.db.prepare('SELECT timeout_at FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId))
      .toMatchObject({ timeout_at: clock + 5_000 });
    expect(touch).toHaveBeenCalledTimes(touchCount);

    clock += 4_000;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fx.store.db.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId)).toMatchObject({ status: 'accepted' });
    await fx.incoming('teamgroup.tool.call', { sharedProjectId: SHARED, deliveryId, callId: 'liveness-tool-call', agentId: REMOTE_AGENT,
      tool: 'team_members', args: {} });
    clock += 4_000;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fx.store.db.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId)).toMatchObject({ status: 'accepted' });
    await fx.incoming('teamgroup.activity', { sharedProjectId: SHARED, agentId: REMOTE_AGENT, state: 'working',
      runId: 'owner-run-heartbeat', entries: [] });
    expect(touch).toHaveBeenCalledTimes(touchCount);
    clock += 4_000;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fx.store.db.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId)).toMatchObject({ status: 'accepted' });
    clock += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    expect(fx.store.db.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId)).toMatchObject({ status: 'failed' });
    expect(fx.store.getSession(sessionId)?.error).toContain('stopped responding');
    touch.mockRestore();
  } finally {
    vi.useRealTimers();
  }
});

it('enforces the configurable absolute safety cap even while owner heartbeats continue', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-24T12:00:00.000Z') });
  let clock = Date.now();
  try {
    const fx = fixture({ deliveryTimeoutMs: 5_000, deliveryMaxDurationMs: 9_000, now: () => clock });
    const group = await addRemoteToSession(fx);
    const sessionId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
    const member = group.members.find((candidate) => candidate.sessionId === sessionId)!;
    const deliveryId = 'absolute-cap-delivery';
    const requestId = 'absolute-cap-request';
    group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId, messageId: deliveryId, memberId: member.id,
      status: 'running', runId: 'absolute-cap-run', hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'request' });
    const userMessage = fx.store.insertMessage({ sessionId, role: 'user', content: 'Continue until the cap', runId: 'absolute-cap-run' });
    fx.store.insertRun({ id: 'absolute-cap-run', sessionId, userMessageId: userMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
    fx.host.start({ session: fx.store.getSession(sessionId)!, runId: 'absolute-cap-run', content: 'Work', options: { groupDeliveryId: deliveryId },
      context: { groupId: group.group.id, memberId: member.id, requestId, deliveryId, hop: 0, instructions: 'Instructions' } });
    await vi.waitFor(() => expect(fx.outgoing.some((entry) => entry.kind === 'teamgroup.delivery')).toBe(true));
    clock += 4_000;
    await vi.advanceTimersByTimeAsync(4_000);
    await fx.incoming('teamgroup.delivery.heartbeat', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT,
      runId: 'owner-cap-run', sequence: 1, at: new Date().toISOString() });
    clock += 3_000;
    await vi.advanceTimersByTimeAsync(3_000);
    await fx.incoming('teamgroup.delivery.heartbeat', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT,
      runId: 'owner-cap-run', sequence: 2, at: new Date().toISOString() });
    clock += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    expect(fx.store.db.prepare('SELECT status,timeout_at FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId))
      .toMatchObject({ status: 'failed', timeout_at: clock });
  } finally {
    vi.useRealTimers();
  }
});

it('accepts a late completion after an idle timeout but not after an explicit interruption', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-24T12:00:00.000Z') });
  let clock = Date.now();
  try {
    const fx = fixture({ deliveryTimeoutMs: 5_000, now: () => clock });
    const group = await addRemoteToSession(fx);
    const sessionId = String((fx.store.db.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE agent_id=?').get(REMOTE_AGENT) as { session_id: string }).session_id);
    const member = group.members.find((candidate) => candidate.sessionId === sessionId)!;
    const deliveryId = 'late-completion-delivery';
    const requestId = 'late-completion-request';
    group.deliveries.push({ id: deliveryId, groupId: group.group.id, requestId, messageId: deliveryId, memberId: member.id,
      status: 'running', runId: 'late-host-run', hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'assignment' });
    const userMessage = fx.store.insertMessage({ sessionId, role: 'user', content: 'Wait for a remote result', runId: 'late-host-run' });
    fx.store.insertRun({ id: 'late-host-run', sessionId, userMessageId: userMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
    fx.host.start({ session: fx.store.getSession(sessionId)!, runId: 'late-host-run', content: 'Work', options: { groupDeliveryId: deliveryId },
      context: { groupId: group.group.id, memberId: member.id, requestId, deliveryId, hop: 0, instructions: 'Instructions' } });
    await vi.waitFor(() => expect(fx.outgoing.find((entry) => entry.kind === 'teamgroup.delivery')).toBeTruthy());
    clock += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    expect(fx.store.db.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId)).toMatchObject({ status: 'failed' });

    await fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId, agentId: REMOTE_AGENT, status: 'completed',
      runId: 'owner-late-run', finalText: 'The remote work completed after the host timeout.', artifacts: [], at: new Date().toISOString() });
    expect(fx.store.db.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId)).toMatchObject({ status: 'completed' });
    expect(fx.store.getRun('late-host-run')?.status).toBe('completed');
    expect(fx.store.listMessages(sessionId, { limit: 20 }).some((message) => message.content === 'The remote work completed after the host timeout.')).toBe(true);

    const interruptedId = 'late-after-interrupt-delivery';
    const next = group.members.find((candidate) => candidate.sessionId === sessionId)!;
    group.deliveries.push({ id: interruptedId, groupId: group.group.id, requestId, messageId: interruptedId, memberId: next.id,
      status: 'running', runId: 'interrupted-host-run', hop: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'assignment' });
    const interruptedMessage = fx.store.insertMessage({ sessionId, role: 'user', content: 'Interrupt this', runId: 'interrupted-host-run' });
    fx.store.insertRun({ id: 'interrupted-host-run', sessionId, userMessageId: interruptedMessage.id, provider: 'codex', model: 'gpt-6-codex', startedAt: new Date().toISOString() });
    fx.host.start({ session: fx.store.getSession(sessionId)!, runId: 'interrupted-host-run', content: 'Work', options: { groupDeliveryId: interruptedId },
      context: { groupId: group.group.id, memberId: next.id, requestId, deliveryId: interruptedId, hop: 0, instructions: 'Instructions' } });
    await vi.waitFor(() => expect(fx.outgoing.some((entry) => entry.kind === 'teamgroup.delivery' && (entry.payload as { deliveryId?: string }).deliveryId === interruptedId)).toBe(true));
    fx.host.interrupt(sessionId);
    await fx.incoming('teamgroup.delivery.status', { sharedProjectId: SHARED, deliveryId: interruptedId, agentId: REMOTE_AGENT, status: 'completed',
      runId: 'owner-too-late', finalText: 'Must be discarded after explicit interruption.', artifacts: [], at: new Date().toISOString() });
    expect(fx.store.db.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?').get(interruptedId)).toMatchObject({ status: 'interrupted' });
    await vi.waitFor(() => expect(fx.artifactDiscards).toContain(interruptedId));
  } finally {
    vi.useRealTimers();
  }
});
