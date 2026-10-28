import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TeamDeliveryPayloadSchema } from '@mingle/contracts';
import type { AdapterEvent, TeamDeliveryPayload, TeamStructurePayload } from '@mingle/contracts';
import { TEAM_CONSENT_DISCLAIMER_VERSION } from '@mingle/contracts';
import { openDatabase } from '../../db.ts';
import { Store } from '../../store.ts';
import { createDeviceSide } from './index.ts';
import { makeRepo, runGit, waitFor } from '../../test-utils.ts';

const TEAM = randomUUID();
const SHARED = randomUUID();
const ACCOUNT = randomUUID();
const LEAD = randomUUID();
const OTHER = randomUUID();
const NEW_MEMBER = randomUUID();
const OWN_DEVICE = randomUUID();
const HOST_DEVICE = randomUUID();
const OTHER_DEVICE = randomUUID();
const AGENT_ID = 'agent_local';

interface Sent { teamId: string; toDeviceId: string; kind: string; payload: any; idempotencyKey: string; sentAt?: number }
interface Fixture {
  store: Store; side: ReturnType<typeof createDeviceSide>; routes: Array<{ method: string; path: string; handler: (ctx: any) => unknown }>;
  projectId: string; root: string; repo: string; worktree: string; worktreeRoot: string; sent: Sent[]; roster: any[]; handler: ((envelope: any) => Promise<void>) | null;
  hubEvents: unknown[];
  runtime: FakeRuntime; exportCalls: any[]; importCalls: any[]; executionOrder: string[]; chatReplies: any[]; members: any[];
  collaborationRefreshCount(): number; revokeDevice(deviceId: string): void;
  authenticatedCalls(): number;
  setFreshCollaborationSnapshot(members: any[], agents: any[], otherDeviceOwner?: string): void;
  setConsent(permission?: 'supervised' | 'full-access', settingsVersion?: number): Promise<any>;
  failTerminalStatusSends(count: number): void;
  failChatReplies(count: number): void;
  holdImports(gate: Promise<void>): void;
  restartSide(): Promise<void>;
  deliver(overrides?: Record<string, unknown>, sender?: string): Promise<void>; close(): Promise<void>;
}

class FakeRuntime {
  startCount = 0;
  mode: 'complete' | 'approval' | 'manual' | 'failed' = 'complete';
  commitChanges = true;
  writeDefaultArtifact = true;
  onWorktree?: (worktreePath: string, runId: string) => void;
  active = new Map<string, string>();
  optionsByRun = new Map<string, any>();
  executionOrder: string[] = [];
  store!: Store;
  onStart?: (options: any, sessionId: string, runId: string) => void;

  start(sessionId: string, content: string, options: any): string {
    this.executionOrder.push('start');
    const runId = `team_run_${++this.startCount}_${randomUUID().slice(0, 8)}`;
    const userMessage = this.store.insertMessage({ sessionId, role: 'user', content, kind: 'team-delivery', runId });
    const session = this.store.getSession(sessionId)!;
    this.store.insertRun({ id: runId, sessionId, userMessageId: userMessage.id, provider: session.provider, model: session.model, startedAt: new Date().toISOString() });
    this.active.set(sessionId, runId);
    this.optionsByRun.set(runId, options);
    this.onStart?.(options, sessionId, runId);
    if (this.mode !== 'manual') setTimeout(() => {
      if (this.mode === 'approval') {
        const approval = this.store.insertApproval({ sessionId, tool: 'Bash', description: 'Run the requested check', input: { command: 'pnpm test' } });
        options.onApproval?.(approval);
      } else if (this.mode === 'failed') {
        const at = new Date().toISOString();
        this.store.finishRun(runId, 'failed', 1, at);
        this.store.updateSession(sessionId, { status: 'error', error: 'The provider reports an exhausted quota.' });
        this.store.recordEvent({ projectId: session.projectId, sessionId, type: 'session.run.failed', summary: 'Fake provider failed', payload: { runId } });
        this.store.insertProviderFailure(sessionId, runId, { id: `failure-${runId}`, sessionId, runId, actor: 'worker',
          kind: 'quota_exhausted', provider: session.provider, retryable: true, safeToRetry: false, outcomeUnknown: false,
          dispatchState: 'dispatched', continuationSafety: 'unsafe', message: 'Quota exhausted on the local provider.', occurredAt: at }, at);
        this.active.delete(sessionId);
      } else this.complete(sessionId, runId, options);
    }, 10).unref();
    return runId;
  }

  isActive(sessionId: string): boolean { return this.active.has(sessionId); }

  interrupt(sessionId: string): boolean {
    const runId = this.active.get(sessionId);
    if (!runId) return false;
    this.store.finishRun(runId, 'interrupted', 0);
    this.store.recordEvent({ projectId: this.store.getSession(sessionId)?.projectId ?? null, sessionId, type: 'session.run.interrupted', summary: 'Fake provider interrupted', payload: { runId } });
    this.active.delete(sessionId);
    return true;
  }

  decide(approvalId: string, decision: 'approved' | 'denied'): any {
    const approval = this.store.resolveApproval(approvalId, decision, 'host');
    const runId = this.active.get(approval.sessionId);
    if (runId) this.complete(approval.sessionId, runId, this.optionsByRun.get(runId));
    return approval;
  }

  complete(sessionId: string, runId: string, options: any): void {
    const session = this.store.getSession(sessionId)!;
    if (options.worktree?.path) {
      if (this.writeDefaultArtifact) writeFileSync(path.join(options.worktree.path, `artifact-${runId}.txt`), `result from ${runId}\n`);
      this.onWorktree?.(options.worktree.path, runId);
      if (this.commitChanges && this.writeDefaultArtifact) {
        runGit(options.worktree.path, '-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'add', `artifact-${runId}.txt`);
        runGit(options.worktree.path, '-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'commit', '-m', `artifact ${runId}`);
      }
    }
    options.onActivity?.({ type: 'text', text: 'Final result: safe output' } satisfies AdapterEvent);
    this.store.insertMessage({ sessionId, role: 'assistant', content: 'Final result: safe output', runId });
    this.store.finishRun(runId, 'completed', 3);
    this.store.recordEvent({ projectId: session.projectId, sessionId, type: 'session.run.completed', summary: 'Fake provider completed', payload: { runId } });
    this.active.delete(sessionId);
  }
}

const fixtures: Fixture[] = [];
let roots: string[] = [];

let sharedRoot = '';
let sharedRepo = '';
let sharedWorktree = '';

beforeAll(() => {
  sharedRoot = mkdtempSync(path.join(os.tmpdir(), 'mingle-device-team-tests-'));
  sharedRepo = makeRepo({ 'README.md': '# team agent\n' });
  sharedWorktree = path.join(sharedRoot, 'agent-worktree');
  runGit(sharedRepo, 'worktree', 'add', '-b', 'agent-worker', sharedWorktree, 'HEAD');
});
afterAll(() => {
  runGit(sharedRepo, 'worktree', 'remove', '--force', sharedWorktree);
  rmSync(sharedRoot, { recursive: true, force: true });
  rmSync(sharedRepo, { recursive: true, force: true });
});
beforeEach(() => { roots = []; });
afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function fixture(): Promise<Fixture> {
  const root = sharedRoot;
  const repo = sharedRepo;
  const worktree = sharedWorktree;
  const permanentBranch = 'mingle/worker/work';
  runGit(repo, 'worktree', 'prune', '--expire', 'now');
  if (runGit(repo, 'branch', '--list', permanentBranch).trim()) runGit(repo, 'branch', '-D', permanentBranch);
  const worktreeRoot = mkdtempSync(path.join(os.tmpdir(), 'mingle-team-delivery-data-'));
  roots.push(worktreeRoot);
  const store = new Store(openDatabase(':memory:'));
  const project = store.insertProject({ name: 'Shared workspace', path: repo });
  const session = store.insertSession({ projectId: project.id, name: 'Local agent', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: true, worktreePath: worktree, branch: 'agent-worker' });
  store.db.exec(`CREATE TABLE mingle_project_collaboration_sources (local_project_id TEXT, owner_id TEXT, team_id TEXT, shared_project_id TEXT, leader_device_id TEXT);
    CREATE TABLE mingle_project_collaboration_joins (invitation_id TEXT, account_id TEXT, device_id TEXT, local_project_id TEXT, team_id TEXT, shared_project_id TEXT);`);
  store.db.prepare(`INSERT INTO mingle_project_collaboration_joins VALUES(?,?,?,?,?,?)`)
    .run(randomUUID(), ACCOUNT, OWN_DEVICE, project.id, TEAM, SHARED);

  const sent: Sent[] = [];
  let terminalStatusFailures = 0;
  const roster: any[] = [];
  const members = [
    { accountId: LEAD, role: 'leader', displayName: 'Lead', status: 'active' },
    { accountId: ACCOUNT, role: 'member', displayName: 'Owner', status: 'active' },
    { accountId: OTHER, role: 'member', displayName: 'Other', status: 'active' },
  ];
  let collaborationRefreshes = 0;
  let freshCollaborationSnapshot: { members: any[]; agents: any[]; otherDeviceOwner?: string } | null = null;
  let otherDeviceOwner: string = OTHER;
  let handler: ((envelope: any) => Promise<void>) | null = null;
  const devices: Array<{ id: string; teamId: string; ownerId: string; name: string; revokedAt: string | null; status: string }> = [
    { id: OWN_DEVICE, teamId: TEAM, ownerId: ACCOUNT, name: 'Owner', revokedAt: null, status: 'online' },
    { id: HOST_DEVICE, teamId: TEAM, ownerId: LEAD, name: 'Lead', revokedAt: null, status: 'online' },
      { id: OTHER_DEVICE, teamId: TEAM, ownerId: otherDeviceOwner, name: 'Teammate', revokedAt: null, status: 'online' },
  ];
  const transport: any = {
    snapshot: (teamId?: string) => ({ deviceId: OWN_DEVICE, devices: devices.map((device) => device.id === OTHER_DEVICE
      ? { ...device, ownerId: otherDeviceOwner } : device).filter((device) => !teamId || device.teamId === teamId),
      links: [{ deviceId: OWN_DEVICE, peerDeviceId: HOST_DEVICE, mutual: true }, { deviceId: OWN_DEVICE, peerDeviceId: OTHER_DEVICE, mutual: true }] }),
    send: async (input: Sent) => {
      if (input.kind === 'teamgroup.delivery.status' && ['completed', 'failed', 'interrupted'].includes(input.payload?.status) && terminalStatusFailures > 0) {
        terminalStatusFailures--;
        throw new Error('temporary mailbox queue failure');
      }
      sent.push({ ...input, sentAt: Date.now() }); return `envelope-${sent.length}`;
    },
    sync: async () => undefined,
    onMessage: (next: (envelope: any) => Promise<void>) => { handler = next; return () => { handler = null; }; },
  };
  let authenticatedCalls = 0;
  const account: any = {
    snapshot: () => ({ user: { id: ACCOUNT }, status: 'signed-in' }),
    withAuthenticatedClient: async (callback: (client: any, user: any) => unknown) => { authenticatedCalls += 1; return callback({}, { id: ACCOUNT }); },
  };
  const collaboration: any = {
    snapshot: async (projectId: string) => ({
      project: projectId === project.id ? { teamId: TEAM, sharedProjectId: SHARED, name: 'Shared workspace' } : null,
      members,
      agents: roster.map((agent) => ({ ...agent, projectId, state: 'idle' })),
      invitations: [], email: { configured: false },
    }),
    refreshSnapshot: async (projectId: string) => {
      collaborationRefreshes++;
      if (freshCollaborationSnapshot) {
        members.splice(0, members.length, ...freshCollaborationSnapshot.members);
        roster.splice(0, roster.length, ...freshCollaborationSnapshot.agents);
        if (freshCollaborationSnapshot.otherDeviceOwner) otherDeviceOwner = freshCollaborationSnapshot.otherDeviceOwner;
        freshCollaborationSnapshot = null;
      }
      return collaboration.snapshot(projectId);
    },
  };
  const exportCalls: any[] = [];
  const importCalls: any[] = [];
  let importGate: Promise<void> | null = null;
  const executionOrder: string[] = [];
  const distributed: any = {
    transport,
    execution: {
      snapshot: async () => ({ agents: [...roster] }),
      publishAgents: async (input: { sessionIds: string[] }) => {
        for (const id of input.sessionIds) {
          if (!roster.some((agent) => agent.sessionId === id)) roster.push({ id: AGENT_ID, name: 'Local agent', accountId: ACCOUNT, deviceId: OWN_DEVICE,
            sessionId: id, provider: 'claude', model: 'claude-sonnet-5-5', state: 'idle' });
        }
        return [...roster];
      },
    },
    git: {
      request: async (input: unknown) => { exportCalls.push(input); return { id: `transfer-${exportCalls.length}` }; },
      exportTeamArtifact: async (input: any) => { exportCalls.push(input); return { revision: input.revision, transferId: `transfer-${exportCalls.length}`,
        ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.path ? { path: input.path } : {}), ref: `refs/mingle/team/${input.revision}` }; },
    },
    importTeamArtifact: async (input: any) => { importCalls.push(input); executionOrder.push('import'); await importGate; return input.artifact; },
  };
  const runtime = new FakeRuntime();
  runtime.store = store;
  runtime.executionOrder = executionOrder;
  const chatReplies: any[] = [];
  let chatFailures = 0;
  const teamChat = { postAgentReply: async (...args: any[]) => {
    if (chatFailures > 0) { chatFailures--; throw new Error('Owner signing temporarily unavailable'); }
    chatReplies.push(args); return { id: `chat-${chatReplies.length}` };
  } };
  const routes: Fixture['routes'] = [];
  const hubEvents: unknown[] = [];
  let side!: ReturnType<typeof createDeviceSide>;
  const startSide = () => {
    side = createDeviceSide({ store, runtime: runtime as any, transport, account, distributed, collaboration, teamChat: teamChat as any,
      hub: { broadcast: (event) => hubEvents.push(event) },
      deliveryWorktreeRoot: worktreeRoot,
      activityThrottleMs: 15, toolTimeoutMs: 30, heartbeatIntervalMs: 15, terminalStatusRetryMs: 15 });
    side.routes((method, route, routeHandler) => routes.push({ method, path: route, handler: routeHandler }));
  };
  startSide();
  const result: Fixture = {
    store, get side() { return side; }, routes, projectId: project.id, root, repo, worktree, worktreeRoot, sent, roster, hubEvents, get handler() { return handler; }, runtime, exportCalls, importCalls, executionOrder, chatReplies, members,
    collaborationRefreshCount: () => collaborationRefreshes,
    authenticatedCalls: () => authenticatedCalls,
    setFreshCollaborationSnapshot(nextMembers, nextAgents, nextOwner) {
      freshCollaborationSnapshot = { members: nextMembers, agents: nextAgents, ...(nextOwner ? { otherDeviceOwner: nextOwner } : {}) };
    },
    revokeDevice(deviceId) { const device = devices.find((candidate) => candidate.id === deviceId); if (device) device.revokedAt = new Date().toISOString(); },
    failTerminalStatusSends(count) { terminalStatusFailures = count; },
    failChatReplies(count) { chatFailures = count; },
    holdImports(gate) { importGate = gate; },
    async restartSide() { await side.close(); routes.length = 0; startSide(); },
    async setConsent(permission = 'supervised', settingsVersion = 1) {
      const body = { sessionIds: [session.id], permissionLevel: permission, settingsVersion, disclaimerVersion: TEAM_CONSENT_DISCLAIMER_VERSION };
      return callRoute(result, 'POST', '/api/projects/:projectId/team-consent', { projectId: project.id }, body);
    },
    async deliver(overrides = {}, sender = HOST_DEVICE) {
      const payload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` , ...overrides });
      await handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: sender, toDeviceId: OWN_DEVICE, kind: 'teamgroup.delivery', payload });
    },
    async close() { await side.close(); store.db.close(); },
  };
  fixtures.push(result);
  return result;
}

function deliveryPayload(overrides: Record<string, unknown> = {}) {
  return {
    sharedProjectId: SHARED, deliveryId: `delivery-${randomUUID()}`, groupId: 'group-1', requestId: `request-${randomUUID()}`,
    agentId: AGENT_ID, workerHandle: 'worker', role: 'worker', kind: 'request', content: 'Implement the scoped task.', hop: 0,
    permissionLevel: 'supervised', settingsVersion: 1, integrationDeviceId: HOST_DEVICE, issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function callRoute(f: Fixture, method: string, routePath: string, params: Record<string, string>, input?: unknown): Promise<any> {
  const route = f.routes.find((candidate) => candidate.method === method && candidate.path === routePath);
  if (!route) throw new Error(`Route ${method} ${routePath} is not registered.`);
  return route.handler({ params, url: new URL(`http://mingle.local${routePath.replace(':projectId', params.projectId ?? '').replace(':agentId', params.agentId ?? '')}`),
    body: async (schema: any) => schema.parse(input ?? {}) });
}

function structure(version: number, permissionLevel: 'supervised' | 'full-access' = 'supervised'): TeamStructurePayload {
  return {
    sharedProjectId: SHARED,
    settings: { leaderOrchestration: true, permissionLevel, orchestratorAgentId: AGENT_ID, fallbackAgentIds: [], version,
      updatedAt: new Date().toISOString(), updatedByAccountId: LEAD },
    disclaimerVersion: TEAM_CONSENT_DISCLAIMER_VERSION,
    members: [{ agentId: AGENT_ID, handle: 'worker', role: 'worker', fallbackRank: null, ownerAccountId: ACCOUNT, deviceId: OWN_DEVICE, state: 'idle', currentTask: null }],
    leaderHistory: [], needsLeader: false, teamSession: { groupId: 'group-shared-session', sessionId: 'session-lead', title: 'Shared session' },
  };
}

async function sendStructure(f: Fixture, payload = structure(1)): Promise<void> {
  await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE,
    kind: 'teamgroup.structure', payload });
}

describe('owner-device team orchestration', () => {
  it('creates consent, publishes selected sessions, honours pause/revoke locally and marks consent for re-acceptance', async () => {
    const f = await fixture();
    await sendStructure(f);
    expect(f.side.latestStructure(SHARED)?.teamSession).toEqual({ groupId: 'group-shared-session', sessionId: 'session-lead', title: 'Shared session' });
    await sendStructure(f, { ...structure(1), teamSession: { groupId: 'group-updated', sessionId: 'session-lead', title: 'Renamed session' } });
    expect(f.side.latestStructure(SHARED)?.teamSession).toEqual({ groupId: 'group-updated', sessionId: 'session-lead', title: 'Renamed session' });
    expect(f.store.listEvents().filter((event) => event.type === 'team.session.updated')).toHaveLength(2);
    expect(f.store.listEvents().filter((event) => event.type === 'team.structure.updated')).toHaveLength(2);
    const accepted = await f.setConsent();
    expect(accepted).toMatchObject({ state: 'granted', permissionLevel: 'supervised', agentIds: [AGENT_ID], hostSync: 'sent' });
    expect(f.authenticatedCalls()).toBe(0);
    expect(f.collaborationRefreshCount()).toBe(0);
    expect(f.sent.some((message) => message.kind === 'teamgroup.consent' && message.toDeviceId === HOST_DEVICE)).toBe(true);
    expect(f.side.localConsent(SHARED)?.state).toBe('granted');
    expect(f.store.listEvents().filter((event) => event.type === 'team.structure.updated').at(-1)?.projectId).toBe(f.projectId);

    const paused = await callRoute(f, 'PATCH', '/api/projects/:projectId/team-consent', { projectId: f.projectId }, { state: 'paused' });
    expect(paused.state).toBe('paused');
    const revoked = await callRoute(f, 'PATCH', '/api/projects/:projectId/team-consent', { projectId: f.projectId }, { state: 'revoked' });
    expect(revoked.state).toBe('revoked');
    expect(f.authenticatedCalls()).toBe(0);
    expect(f.collaborationRefreshCount()).toBe(0);

    await f.setConsent();
    await sendStructure(f, structure(2, 'full-access'));
    expect(f.side.latestStructure(SHARED)?.settings.version).toBe(2);
    expect(f.side.localConsent(SHARED)?.state).toBe('needs-reconsent');
    expect(f.store.listEvents().filter((event) => event.type === 'team.structure.updated').at(-1)?.payload).toMatchObject({
      sharedProjectId: SHARED, teamSession: { groupId: 'group-shared-session' },
    });
    await f.setConsent('full-access', 2);
    await sendStructure(f, { ...structure(3, 'full-access'), disclaimerVersion: '2027-01.1' });
    expect(f.side.localConsent(SHARED)?.state).toBe('needs-reconsent');
  });

  it('accepts the owner-selected permission and settings version before any host structure has arrived', async () => {
    const f = await fixture();
    const accepted = await f.setConsent('full-access', 7);
    expect(accepted).toMatchObject({ state: 'granted', permissionLevel: 'full-access', settingsVersion: 7, hostSync: 'sent' });
    expect(f.side.latestStructure(SHARED)).toBeNull();

    await sendStructure(f, structure(7, 'full-access'));
    expect(f.side.localConsent(SHARED)).toMatchObject({ state: 'granted', permissionLevel: 'full-access', settingsVersion: 7 });
    await sendStructure(f, { ...structure(8, 'full-access'), settings: { ...structure(8, 'full-access').settings, leaderOrchestration: false } });
    expect(f.side.localConsent(SHARED)).toMatchObject({ state: 'granted', permissionLevel: 'full-access', settingsVersion: 7 });
  });

  it('advances consent timestamps from persisted owner state after a wall-clock correction and restart', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    const saved = f.side.localConsent(SHARED)!;
    const futureAt = '2099-01-01T00:00:00.000Z';
    f.store.db.prepare(`UPDATE mingle_team_device_consents SET consent_json=?,updated_at=?
      WHERE shared_project_id=? AND account_id=? AND device_id=?`)
      .run(JSON.stringify({ ...saved, updatedAt: futureAt }), futureAt, SHARED, ACCOUNT, OWN_DEVICE);

    await f.restartSide();
    const paused = await callRoute(f, 'PATCH', '/api/projects/:projectId/team-consent', { projectId: f.projectId }, { state: 'paused' });
    expect(paused.updatedAt).toBe('2099-01-01T00:00:00.001Z');
    expect(f.side.localConsent(SHARED)?.state).toBe('paused');
    const pauseMessage = f.sent.filter((message) => message.kind === 'teamgroup.consent').at(-1);
    expect(pauseMessage?.payload).toMatchObject({ state: 'paused', at: paused.updatedAt });

    const revoked = await callRoute(f, 'PATCH', '/api/projects/:projectId/team-consent', { projectId: f.projectId }, { state: 'revoked' });
    expect(revoked.updatedAt).toBe('2099-01-01T00:00:00.002Z');
    expect(f.sent.filter((message) => message.kind === 'teamgroup.consent').at(-1)?.payload)
      .toMatchObject({ state: 'revoked', at: revoked.updatedAt });

    const resumed = await f.setConsent();
    expect(resumed).toMatchObject({ state: 'granted', updatedAt: '2099-01-01T00:00:00.003Z' });
    expect(f.sent.filter((message) => message.kind === 'teamgroup.consent').at(-1)?.payload)
      .toMatchObject({ state: 'granted', at: resumed.updatedAt });
  });

  it('rejects stale consent settings versions but lets owners choose a maximum permission level', async () => {
    const f = await fixture();
    await sendStructure(f, structure(2, 'full-access'));
    await expect(f.setConsent('supervised', 1)).rejects.toThrow(/settings changed/i);
    await expect(f.setConsent('supervised', 2)).resolves.toMatchObject({
      state: 'granted', permissionLevel: 'supervised', settingsVersion: 2,
    });
  });

  it('applies the delivery rejection matrix without starting provider work', async () => {
    const f = await fixture();
    await sendStructure(f, structure(2, 'supervised'));
    const payload = deliveryPayload({ settingsVersion: 2 });

    await f.deliver(payload, OTHER_DEVICE);
    expect(f.sent.at(-1)?.payload).toMatchObject({ status: 'rejected', rejection: 'invalid' });

    f.members[0]!.role = 'member';
    await f.deliver({ ...payload, deliveryId: `delivery-${randomUUID()}` });
    expect(f.sent.at(-1)?.payload).toMatchObject({ status: 'rejected', rejection: 'invalid' });
    f.members[0]!.role = 'leader';

    f.roster.push({ id: AGENT_ID, name: 'Local agent', accountId: ACCOUNT, deviceId: OWN_DEVICE, sessionId: 'local-session',
      provider: 'claude', model: 'claude-sonnet-5-5', state: 'idle' });
    f.roster[0]!.sessionId = f.store.listSessions(f.projectId)[0]!.id;
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE,
      kind: 'teamgroup.delivery', payload: deliveryPayload({ settingsVersion: 2 }) });
    expect(f.sent.at(-1)?.payload).toMatchObject({ status: 'rejected', rejection: 'no-consent' });

    await f.setConsent('supervised', 2);
    await callRoute(f, 'PATCH', '/api/projects/:projectId/team-consent', { projectId: f.projectId }, { state: 'paused' });
    await f.deliver({ ...payload, deliveryId: `delivery-${randomUUID()}` });
    expect(f.sent.at(-1)?.payload).toMatchObject({ status: 'rejected', rejection: 'paused' });

    await f.setConsent('supervised', 2);
    await f.deliver({ ...payload, deliveryId: `delivery-${randomUUID()}`, permissionLevel: 'full-access' });
    expect(f.sent.at(-1)?.payload).toMatchObject({ status: 'rejected', rejection: 'invalid' });

    await f.deliver({ ...payload, deliveryId: `delivery-${randomUUID()}`, settingsVersion: 1 });
    expect(f.sent.at(-1)?.payload).toMatchObject({ status: 'rejected', rejection: 'invalid' });

    const beforeUnknownAgent = f.collaborationRefreshCount();
    await f.deliver({ ...payload, deliveryId: `delivery-${randomUUID()}`, agentId: 'agent-unknown' });
    expect(f.sent.at(-1)?.payload).toMatchObject({ status: 'rejected', rejection: 'agent-unavailable' });
    expect(f.collaborationRefreshCount()).toBeGreaterThan(beforeUnknownAgent);
    expect(f.runtime.startCount).toBe(0);
  });

  it('forces a refresh for an unknown sender and rejects revoked membership or a revoked host device', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    const payload = deliveryPayload();

    const beforeRemovedMember = f.collaborationRefreshCount();
    f.members.splice(0, 1);
    await f.deliver(payload, OTHER_DEVICE);
    expect(f.collaborationRefreshCount()).toBeGreaterThan(beforeRemovedMember);
    expect(f.sent.at(-1)?.payload).toMatchObject({ status: 'rejected', rejection: 'invalid' });

    f.members.unshift({ accountId: LEAD, role: 'leader', displayName: 'Lead' });
    f.revokeDevice(HOST_DEVICE);
    const beforeRevokedDevice = f.collaborationRefreshCount();
    await f.deliver({ ...payload, deliveryId: `delivery-${randomUUID()}` });
    expect(f.collaborationRefreshCount()).toBeGreaterThan(beforeRevokedDevice);
    expect(f.sent.at(-1)?.payload).toMatchObject({ status: 'rejected', rejection: 'invalid' });
    expect(f.runtime.startCount).toBe(0);
  });

  it('accepts one delivery, exports an isolated commit and reuses its chat reply identity across delivery retries', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    const payload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    const envelope = { id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.delivery', payload };
    await f.handler?.(envelope);
    await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.delivery.status' && message.payload.deliveryId === payload.deliveryId && message.payload.status === 'completed'));
    await f.handler?.(envelope);
    expect(f.runtime.startCount).toBe(1);
    expect(f.sent.some((message) => message.payload?.status === 'accepted')).toBe(true);
    expect(f.sent.some((message) => message.payload?.status === 'running')).toBe(true);
    const completed = f.sent.find((message) => message.payload?.status === 'completed' && message.payload.deliveryId === payload.deliveryId)?.payload;
    expect(completed).toMatchObject({ finalText: expect.stringContaining('Final result: safe output'), artifacts: [{ transferId: 'transfer-1' }] });
    expect(f.exportCalls).toHaveLength(1);
    const deliveryWorktree = f.runtime.optionsByRun.get(completed.runId)?.worktree?.path;
    expect(deliveryWorktree).toEqual(expect.any(String));
    expect(deliveryWorktree).not.toBe(f.worktree);
    expect(deliveryWorktree.startsWith(f.worktreeRoot)).toBe(true);
    expect(runGit(deliveryWorktree, 'rev-parse', 'HEAD').trim()).toBe(f.exportCalls[0].revision);
    expect(f.store.db.prepare('SELECT worktree_path,branch FROM mingle_team_device_deliveries WHERE delivery_id=?').get(payload.deliveryId))
      .toMatchObject({ worktree_path: deliveryWorktree, branch: 'mingle/worker/work' });
    expect(f.exportCalls[0]).toMatchObject({ toDeviceId: HOST_DEVICE, deliveryId: payload.deliveryId, sourceWorktreePath: deliveryWorktree });
    expect(f.chatReplies).toHaveLength(2);
    expect(new Set(f.chatReplies.map((args) => args[4])).size).toBe(1);
    expect(f.chatReplies[0]).toEqual([f.projectId, AGENT_ID, 'Final result: safe output', payload.requestId, payload.deliveryId]);

    const localSessionId = f.store.listSessions(f.projectId)[0]!.id;
    const legacyPayload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}`, agentId: localSessionId });
    await f.deliver(legacyPayload);
    await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.delivery.status'
      && message.payload.deliveryId === legacyPayload.deliveryId && message.payload.status === 'completed'));
    const savedLegacy = f.store.db.prepare(`SELECT agent_id,request_json FROM mingle_team_device_deliveries WHERE delivery_id=?`)
      .get(legacyPayload.deliveryId) as { agent_id: string; request_json: string };
    expect(savedLegacy.agent_id).toBe(AGENT_ID);
    expect(JSON.parse(savedLegacy.request_json).agentId).toBe(AGENT_ID);
    expect(f.runtime.startCount).toBe(2);
  });

  it('reuses the same worktree and permanent branch across deliveries and starts the next turn at the prior commit', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    const first = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    await f.deliver(first);
    await waitFor(() => f.sent.some((message) => message.payload?.deliveryId === first.deliveryId && message.payload?.status === 'completed'));
    const firstRow = f.store.db.prepare('SELECT worktree_path,branch FROM mingle_team_device_deliveries WHERE delivery_id=?')
      .get(first.deliveryId) as { worktree_path: string; branch: string };
    const firstHead = runGit(firstRow.worktree_path, 'rev-parse', 'HEAD').trim();
    let secondTurnSawFirstCommit = false;
    f.runtime.onStart = (options) => {
      if (options.worktree.path !== firstRow.worktree_path) return;
      try { runGit(options.worktree.path, 'cat-file', '-e', `${firstHead}^{commit}`); secondTurnSawFirstCommit = true; }
      catch { secondTurnSawFirstCommit = false; }
    };

    const second = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    await f.deliver(second);
    await waitFor(() => f.sent.some((message) => message.payload?.deliveryId === second.deliveryId && message.payload?.status === 'completed'));
    const secondRow = f.store.db.prepare('SELECT worktree_path,branch,base_revision FROM mingle_team_device_deliveries WHERE delivery_id=?')
      .get(second.deliveryId) as { worktree_path: string; branch: string; base_revision: string };
    const secondHead = runGit(secondRow.worktree_path, 'rev-parse', 'HEAD').trim();

    expect(secondTurnSawFirstCommit).toBe(true);
    expect(secondRow).toEqual({ worktree_path: firstRow.worktree_path, branch: 'mingle/worker/work', base_revision: firstHead });
    expect(() => runGit(secondRow.worktree_path, 'merge-base', '--is-ancestor', firstHead, secondHead)).not.toThrow();
    expect(f.runtime.startCount).toBe(2);
  });

  it('pushes completion to the permanent worker branch on origin without exporting duplicate artifacts', async () => {
    const f = await fixture();
    const originRoot = mkdtempSync(path.join(os.tmpdir(), 'mingle-worker-origin-'));
    roots.push(originRoot);
    const origin = path.join(originRoot, 'origin.git');
    mkdirSync(origin);
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
    runGit(f.repo, 'remote', 'add', 'origin', origin);
    try {
      runGit(f.repo, 'config', 'user.name', 'Owner');
      runGit(f.repo, 'config', 'user.email', 'owner@example.test');
      runGit(f.repo, 'push', 'origin', 'main');
      const base = runGit(origin, 'rev-parse', 'refs/heads/main').trim();
      await sendStructure(f);
      await f.setConsent();
      const payload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}`, taskId: 'task-worker-finish' });
      await f.deliver(payload);
      await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.delivery.status'
        && message.payload.deliveryId === payload.deliveryId && message.payload.status === 'completed'));

      const completed = f.sent.find((message) => message.kind === 'teamgroup.delivery.status'
        && message.payload.deliveryId === payload.deliveryId && message.payload.status === 'completed')!.payload;
      expect(completed.pushedBranch).toEqual(expect.objectContaining({ name: 'mingle/worker/work', commitSha: expect.any(String), baseCommitSha: base }));
      expect(completed.branchPushFailure).toBeUndefined();
      expect(runGit(origin, 'rev-parse', 'refs/heads/main').trim()).toBe(base);
      expect(runGit(origin, 'rev-parse', `refs/heads/${completed.pushedBranch.name}`).trim()).toBe(completed.pushedBranch.commitSha);
      expect(runGit(origin, 'tag', '--list').trim()).toBe('');
      expect(completed.artifacts).toEqual([]);
      expect(f.exportCalls).toHaveLength(0);
    } finally {
      runGit(f.repo, 'remote', 'remove', 'origin');
    }
  });

  it('reports an origin push failure and preserves the committed-artifact fallback', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    const payload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    await f.deliver(payload);
    await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.delivery.status'
      && message.payload.deliveryId === payload.deliveryId && message.payload.status === 'completed'));

    const completed = f.sent.find((message) => message.kind === 'teamgroup.delivery.status'
      && message.payload.deliveryId === payload.deliveryId && message.payload.status === 'completed')!.payload;
    expect(completed.pushedBranch).toBeUndefined();
    expect(completed.branchPushFailure).toContain('no origin remote');
    expect(completed.finalText).toBe('Final result: safe output');
    expect(completed.artifacts).toHaveLength(1);
    expect(f.exportCalls).toHaveLength(1);
  });

  it('pushes earlier unpushed commits when the next completed turn makes no new commit', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    const first = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    await f.deliver(first);
    await waitFor(() => f.sent.some((message) => message.payload?.deliveryId === first.deliveryId && message.payload?.status === 'completed'));
    const firstRow = f.store.db.prepare('SELECT worktree_path FROM mingle_team_device_deliveries WHERE delivery_id=?')
      .get(first.deliveryId) as { worktree_path: string };
    const unpushedHead = runGit(firstRow.worktree_path, 'rev-parse', 'HEAD').trim();
    expect(f.sent.find((message) => message.payload?.deliveryId === first.deliveryId && message.payload?.status === 'completed')?.payload.branchPushFailure)
      .toContain('no origin remote');

    const originRoot = mkdtempSync(path.join(os.tmpdir(), 'mingle-later-origin-'));
    roots.push(originRoot);
    const origin = path.join(originRoot, 'origin.git');
    mkdirSync(origin);
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
    runGit(f.repo, 'remote', 'add', 'origin', origin);
    try {
      runGit(f.repo, 'config', 'user.name', 'Owner');
      runGit(f.repo, 'config', 'user.email', 'owner@example.test');
      runGit(f.repo, 'push', 'origin', 'main');
      f.runtime.writeDefaultArtifact = false;
      f.runtime.commitChanges = false;
      const second = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
      await f.deliver(second);
      await waitFor(() => f.sent.some((message) => message.payload?.deliveryId === second.deliveryId && message.payload?.status === 'completed'));
      const completed = f.sent.find((message) => message.payload?.deliveryId === second.deliveryId && message.payload?.status === 'completed')!.payload;

      expect(completed.pushedBranch).toEqual({ name: 'mingle/worker/work', commitSha: unpushedHead, baseCommitSha: unpushedHead });
      expect(completed.branchPushFailure).toBeUndefined();
      expect(completed.artifacts).toEqual([]);
      expect(runGit(origin, 'rev-parse', 'refs/heads/mingle/worker/work').trim()).toBe(unpushedHead);
      expect(f.exportCalls).toHaveLength(1);
    } finally {
      runGit(f.repo, 'remote', 'remove', 'origin');
    }
  });

  it('merges a clean host integration update into the persistent worker branch before the next turn', async () => {
    const f = await fixture();
    const originRoot = mkdtempSync(path.join(os.tmpdir(), 'mingle-integration-origin-'));
    roots.push(originRoot);
    const origin = path.join(originRoot, 'origin.git');
    mkdirSync(origin);
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
    runGit(f.repo, 'remote', 'add', 'origin', origin);
    try {
      runGit(f.repo, 'config', 'user.name', 'Owner');
      runGit(f.repo, 'config', 'user.email', 'owner@example.test');
      runGit(f.repo, 'push', 'origin', 'main');
      await sendStructure(f);
      await f.setConsent();
      const base = runGit(f.repo, 'rev-parse', 'HEAD').trim();
      const first = deliveryPayload({ deliveryId: `delivery-${randomUUID()}`, baseRevision: base, integrationBranch: 'main' });
      await f.deliver(first);
      await waitFor(() => f.sent.some((message) => message.payload?.deliveryId === first.deliveryId && message.payload?.status === 'completed'));
      const firstRow = f.store.db.prepare('SELECT worktree_path FROM mingle_team_device_deliveries WHERE delivery_id=?')
        .get(first.deliveryId) as { worktree_path: string };
      const firstHead = runGit(firstRow.worktree_path, 'rev-parse', 'HEAD').trim();

      writeFileSync(path.join(f.repo, 'host-integration.txt'), 'host change\n');
      runGit(f.repo, 'add', '--', 'host-integration.txt');
      runGit(f.repo, 'commit', '-m', 'Host integration change');
      const hostHead = runGit(f.repo, 'rev-parse', 'HEAD').trim();
      runGit(f.repo, 'push', 'origin', 'main');
      let secondStartHead = '';
      f.runtime.onStart = (options) => {
        secondStartHead = runGit(options.worktree.path, 'rev-parse', 'HEAD').trim();
      };

      const second = deliveryPayload({ deliveryId: `delivery-${randomUUID()}`, baseRevision: hostHead, integrationBranch: 'main' });
      await f.deliver(second);
      await waitFor(() => f.sent.some((message) => message.payload?.deliveryId === second.deliveryId && message.payload?.status === 'completed'));
      const row = f.store.db.prepare('SELECT worktree_path,base_revision FROM mingle_team_device_deliveries WHERE delivery_id=?')
        .get(second.deliveryId) as { worktree_path: string; base_revision: string };
      const requestJson = f.store.db.prepare('SELECT request_json FROM mingle_team_device_deliveries WHERE delivery_id=?')
        .get(second.deliveryId) as { request_json: string };
      const secondPrompt = f.store.listMessages(f.store.listSessions(f.projectId)[0]!.id, { limit: 50 })
        .filter((message) => message.role === 'user' && message.kind === 'team-delivery').at(-1)?.content ?? '';

      expect(JSON.parse(requestJson.request_json)).toMatchObject({ baseRevision: hostHead, integrationBranch: 'main' });
      expect(secondPrompt).not.toContain('could not merge the latest integration commit');
      expect(secondStartHead).not.toBe(firstHead);
      expect(() => runGit(row.worktree_path, 'merge-base', '--is-ancestor', hostHead, secondStartHead)).not.toThrow();
      expect(readFileSync(path.join(row.worktree_path, 'host-integration.txt'), 'utf8')).toBe('host change\n');
      expect(() => runGit(row.worktree_path, 'merge-base', '--is-ancestor', firstHead, secondStartHead)).not.toThrow();
      expect(row.base_revision).toBe(secondStartHead);
    } finally {
      runGit(f.repo, 'remote', 'remove', 'origin');
    }
  });

  it('aborts a conflicting integration merge and tells the worker how to pull and resolve it', async () => {
    const f = await fixture();
    writeFileSync(path.join(f.repo, 'conflict.txt'), 'base\n');
    runGit(f.repo, 'add', '--', 'conflict.txt');
    runGit(f.repo, 'commit', '-m', 'Add merge fixture');
    const originRoot = mkdtempSync(path.join(os.tmpdir(), 'mingle-conflict-origin-'));
    roots.push(originRoot);
    const origin = path.join(originRoot, 'origin.git');
    mkdirSync(origin);
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
    runGit(f.repo, 'remote', 'add', 'origin', origin);
    try {
      runGit(f.repo, 'push', 'origin', 'main');
      await sendStructure(f);
      await f.setConsent();
      const base = runGit(f.repo, 'rev-parse', 'HEAD').trim();
      const first = deliveryPayload({ deliveryId: `delivery-${randomUUID()}`, baseRevision: base, integrationBranch: 'main' });
      await f.deliver(first);
      await waitFor(() => f.sent.some((message) => message.payload?.deliveryId === first.deliveryId && message.payload?.status === 'completed'));
      const firstRow = f.store.db.prepare('SELECT worktree_path FROM mingle_team_device_deliveries WHERE delivery_id=?')
        .get(first.deliveryId) as { worktree_path: string };
      writeFileSync(path.join(firstRow.worktree_path, 'conflict.txt'), 'worker change\n');
      runGit(firstRow.worktree_path, 'add', '--', 'conflict.txt');
      runGit(firstRow.worktree_path, 'commit', '-m', 'Worker conflict change');
      const workerHead = runGit(firstRow.worktree_path, 'rev-parse', 'HEAD').trim();

      writeFileSync(path.join(f.repo, 'conflict.txt'), 'host change\n');
      runGit(f.repo, 'add', '--', 'conflict.txt');
      runGit(f.repo, 'commit', '-m', 'Host conflicting change');
      const hostHead = runGit(f.repo, 'rev-parse', 'HEAD').trim();
      runGit(f.repo, 'push', 'origin', 'main');
      let secondStartHead = '';
      let secondStartClean = false;
      f.runtime.onStart = (options) => {
        secondStartHead = runGit(options.worktree.path, 'rev-parse', 'HEAD').trim();
        secondStartClean = runGit(options.worktree.path, 'status', '--porcelain=v1').trim() === '';
      };

      const second = deliveryPayload({ deliveryId: `delivery-${randomUUID()}`, baseRevision: hostHead, integrationBranch: 'main' });
      await f.deliver(second);
      await waitFor(() => f.sent.some((message) => message.payload?.deliveryId === second.deliveryId && message.payload?.status === 'completed'));
      const completed = f.sent.find((message) => message.payload?.deliveryId === second.deliveryId && message.payload?.status === 'completed')!.payload;
      const secondRunId = completed.runId;
      const requestMessage = f.store.listMessages(f.store.listSessions(f.projectId)[0]!.id, { limit: 50 })
        .find((message) => message.runId === secondRunId && message.role === 'user')!;

      expect(secondStartHead).toBe(workerHead);
      expect(secondStartClean).toBe(true);
      expect(requestMessage.content).toContain('could not merge the latest integration commit');
      expect(requestMessage.content).toContain('git pull --no-rebase origin main');
      expect(completed.finalText).not.toContain('unmerged paths');
    } finally {
      runGit(f.repo, 'remote', 'remove', 'origin');
    }
  });

  it('snapshots uncommitted provider files into a clean artifact commit while excluding secrets and ignored paths', async () => {
    const f = await fixture();
    const originalSessionHead = runGit(f.worktree, 'rev-parse', '--verify', 'HEAD').trim();
    writeFileSync(path.join(f.repo, '.gitignore'), 'ignored-output.txt\n');
    runGit(f.repo, 'config', 'user.name', 'Owner');
    runGit(f.repo, 'config', 'user.email', 'owner@example.invalid');
    runGit(f.repo, 'add', '.gitignore');
    runGit(f.repo, '-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', 'commit', '-m', 'Ignore generated local output');
    await sendStructure(f);
    await f.setConsent();
    f.runtime.commitChanges = false;
    f.runtime.writeDefaultArtifact = false;
    f.runtime.onWorktree = (worktreePath) => {
      writeFileSync(path.join(worktreePath, 'index.html'), '<!doctype html><title>Uncommitted landing page</title>\n');
      writeFileSync(path.join(worktreePath, 'styles.css'), 'body{font-family:system-ui}\n');
      writeFileSync(path.join(worktreePath, '.env'), 'PRIVATE_VALUE=do-not-transfer\n');
      writeFileSync(path.join(worktreePath, 'ignored-output.txt'), 'ignored local output\n');
    };
    const payload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    const envelope = { id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.delivery', payload };
    await f.handler?.(envelope);
    await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.delivery.status'
      && message.payload.deliveryId === payload.deliveryId && message.payload.status === 'completed'));

    const completed = f.sent.find((message) => message.kind === 'teamgroup.delivery.status'
      && message.payload.deliveryId === payload.deliveryId && message.payload.status === 'completed')!.payload;
    expect(completed.artifacts).toHaveLength(1);
    expect(completed.finalText).toContain('protected or ignored path(s) were excluded');
    const worktreePath = f.exportCalls[0]!.sourceWorktreePath as string;
    const committedPaths = runGit(worktreePath, 'show', '--pretty=format:', '--name-only', completed.artifacts[0]!.revision)
      .split('\n').filter(Boolean).sort();
    expect(committedPaths).toEqual(['index.html', 'styles.css']);
    expect(runGit(f.worktree, 'rev-parse', '--verify', 'HEAD').trim()).toBe(originalSessionHead);
    expect(() => readFileSync(path.join(f.worktree, 'index.html'))).toThrow();
    expect(() => readFileSync(path.join(f.worktree, 'styles.css'))).toThrow();
    expect(() => readFileSync(path.join(worktreePath, '.env'))).not.toThrow();
    expect(runGit(worktreePath, 'rev-parse', '--verify', 'HEAD').trim()).toBe(completed.artifacts[0]!.revision);
    expect(f.runtime.startCount).toBe(1);
  });

  it('refuses the complete artifact history when a protected file appears only in an intermediate commit', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    f.runtime.commitChanges = false;
    f.runtime.writeDefaultArtifact = false;
    f.runtime.onWorktree = (worktreePath) => {
      const commit = (message: string) => runGit(worktreePath, '-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'commit', '-m', message);
      writeFileSync(path.join(worktreePath, 'styles.css'), 'body{color:#222}\n');
      runGit(worktreePath, 'add', 'styles.css');
      commit('safe style');
      writeFileSync(path.join(worktreePath, '.env'), 'PRIVATE_VALUE=do-not-transfer\n');
      runGit(worktreePath, 'add', '.env');
      commit('temporary secret');
      rmSync(path.join(worktreePath, '.env'));
      runGit(worktreePath, 'add', '-u', '.env');
      commit('remove secret');
      writeFileSync(path.join(worktreePath, 'index.html'), '<title>safe later commit</title>\n');
      runGit(worktreePath, 'add', 'index.html');
      commit('safe later change');
    };
    const payload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    await f.deliver(payload);
    await waitFor(() => f.sent.some((message) => message.payload?.deliveryId === payload.deliveryId && message.payload?.status === 'completed'));

    const completed = f.sent.find((message) => message.payload?.deliveryId === payload.deliveryId && message.payload?.status === 'completed')!.payload;
    expect(f.exportCalls).toHaveLength(0);
    expect(completed.artifacts).toEqual([]);
    expect(completed.finalText).toContain('protected path change(s)');
    const row = f.store.db.prepare('SELECT worktree_path,branch FROM mingle_team_device_deliveries WHERE delivery_id=?').get(payload.deliveryId) as { worktree_path: string; branch: string };
    expect(runGit(row.worktree_path, 'show', '--pretty=format:', '--name-only', 'HEAD')).toContain('index.html');
    expect(runGit(row.worktree_path, 'rev-parse', '--verify', 'HEAD').trim()).not.toBe(runGit(f.repo, 'rev-parse', '--verify', 'HEAD').trim());
  });

  it('filters dirty out-of-scope paths from snapshots while preserving them in the retained delivery worktree', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    f.runtime.commitChanges = false;
    f.runtime.writeDefaultArtifact = false;
    f.runtime.onWorktree = (worktreePath) => {
      writeFileSync(path.join(worktreePath, 'styles.css'), 'body{font-family:system-ui}\n');
      writeFileSync(path.join(worktreePath, 'README.md'), '# out of scope edit\n');
    };
    const payload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}`, scope: ['styles.css'] });
    await f.deliver(payload);
    await waitFor(() => f.sent.some((message) => message.payload?.deliveryId === payload.deliveryId && message.payload?.status === 'completed'));

    const completed = f.sent.find((message) => message.payload?.deliveryId === payload.deliveryId && message.payload?.status === 'completed')!.payload;
    expect(completed.artifacts).toHaveLength(1);
    expect(completed.finalText).toContain('out-of-scope path(s) were left');
    const worktreePath = f.exportCalls[0]!.sourceWorktreePath as string;
    expect(runGit(worktreePath, 'show', '--pretty=format:', '--name-only', completed.artifacts[0]!.revision).split('\n').filter(Boolean))
      .toEqual(['styles.css']);
    expect(readFileSync(path.join(worktreePath, 'README.md'), 'utf8')).toBe('# out of scope edit\n');
  });

  it('refuses manually committed out-of-scope paths and retains their commits for recovery', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    f.runtime.commitChanges = false;
    f.runtime.writeDefaultArtifact = false;
    f.runtime.onWorktree = (worktreePath) => {
      writeFileSync(path.join(worktreePath, 'styles.css'), 'body{font-family:system-ui}\n');
      runGit(worktreePath, 'add', 'styles.css');
      runGit(worktreePath, 'commit', '-m', 'in-scope style');
      writeFileSync(path.join(worktreePath, 'README.md'), '# manually committed outside scope\n');
      runGit(worktreePath, 'add', 'README.md');
      runGit(worktreePath, 'commit', '-m', 'out-of-scope readme');
    };
    const payload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}`, scope: ['styles.css'] });
    await f.deliver(payload);
    await waitFor(() => f.sent.some((message) => message.payload?.deliveryId === payload.deliveryId && message.payload?.status === 'completed'));

    const completed = f.sent.find((message) => message.payload?.deliveryId === payload.deliveryId && message.payload?.status === 'completed')!.payload;
    expect(f.exportCalls).toHaveLength(0);
    expect(completed.artifacts).toEqual([]);
    expect(completed.finalText).toContain('committed path change(s) outside the assigned scope');
    const row = f.store.db.prepare('SELECT worktree_path FROM mingle_team_device_deliveries WHERE delivery_id=?').get(payload.deliveryId) as { worktree_path: string };
    expect(runGit(row.worktree_path, 'rev-parse', '--verify', 'HEAD').trim()).not.toBe(runGit(f.repo, 'rev-parse', '--verify', 'HEAD').trim());
    expect(runGit(row.worktree_path, 'status', '--porcelain=v1')).toBe('');
  });

  it('exports and validates a committed in-scope artifact before relaying team_artifact to the host', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    f.runtime.mode = 'manual';
    let connection: any;
    let artifactRevision = '';
    f.runtime.onStart = (options) => {
      const worktreePath = options.worktree.path as string;
      writeFileSync(path.join(worktreePath, 'styles.css'), 'body{color:#123}\n');
      runGit(worktreePath, 'add', '--', 'styles.css');
      runGit(worktreePath, 'commit', '-m', 'Commit scoped artifact');
      artifactRevision = runGit(worktreePath, 'rev-parse', 'HEAD').trim();
      connection = options.teamMcp;
    };
    const baseRevision = runGit(f.repo, 'rev-parse', 'HEAD').trim();
    const payload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}`, kind: 'assignment', taskId: 'task-41',
      scope: ['styles.css'], baseRevision });
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.delivery', payload });
    await waitFor(() => connection && f.runtime.active.size === 1);

    const client = new Client({ name: 'owner-artifact-test', version: '1.0.0' }, { capabilities: {} });
    const clientTransport = new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
    });
    await client.connect(clientTransport);
    try {
      const denied = await client.callTool({ name: 'team_artifact', arguments: {
        recipient: 'lead', path: 'README.md', revision: artifactRevision, taskId: 'task-41',
      } });
      expect(denied.isError).toBe(true);
      expect(f.exportCalls).toHaveLength(0);
      expect(f.sent.filter((message) => message.kind === 'teamgroup.tool.call')).toHaveLength(0);

      const toolResult = client.callTool({ name: 'team_artifact', arguments: {
        recipient: 'lead', path: 'styles.css', revision: artifactRevision, taskId: 'task-41', note: 'Committed before review',
      } });
      await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.tool.call'));
      const toolCall = f.sent.find((message) => message.kind === 'teamgroup.tool.call')!;
      expect(f.exportCalls).toHaveLength(1);
      expect(f.exportCalls[0]).toMatchObject({ revision: artifactRevision, path: 'styles.css', taskId: 'task-41',
        deliveryId: payload.deliveryId, toDeviceId: HOST_DEVICE });
      expect(toolCall.payload.args).toMatchObject({
        recipient: 'lead', path: 'styles.css', revision: artifactRevision, taskId: 'task-41',
        __mingleArtifactTransfer: { revision: artifactRevision, path: 'styles.css', taskId: 'task-41', transferId: 'transfer-1' },
      });
      await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE,
        kind: 'teamgroup.tool.result', payload: { sharedProjectId: SHARED, deliveryId: payload.deliveryId, callId: toolCall.payload.callId,
          ok: true, result: { artifactId: 'artifact-41' } } });
      const result = await toolResult;
      expect(result.isError).toBeFalsy();
      expect((result.content as Array<{ text?: string }>)[0]?.text).toContain('artifact-41');
    } finally {
      await client.close();
    }
  });

  it('heartbeats during a long owner-side run and stops heartbeating after completion', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    f.runtime.mode = 'manual';
    const payload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    await f.deliver(payload);
    const sessionId = f.store.listSessions(f.projectId)[0]!.id;
    await waitFor(() => f.runtime.active.get(sessionId));
    const heartbeatCount = () => f.sent.filter((message) => message.kind === 'teamgroup.delivery.heartbeat'
      && message.payload.deliveryId === payload.deliveryId).length;
    await waitFor(() => heartbeatCount() >= 2);
    const heartbeats = f.sent.filter((message) => message.kind === 'teamgroup.delivery.heartbeat' && message.payload.deliveryId === payload.deliveryId);
    expect(heartbeats.map((message) => message.payload.sequence)).toEqual([1, 2]);
    const runId = f.runtime.active.get(sessionId)!;
    f.runtime.complete(sessionId, runId, f.runtime.optionsByRun.get(runId));
    await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.delivery.status'
      && message.payload.deliveryId === payload.deliveryId && message.payload.status === 'completed'));
    const completedHeartbeatCount = heartbeatCount();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(heartbeatCount()).toBe(completedHeartbeatCount);
  });

  it('recovers an unposted owner reply from saved completion without replaying its provider or changing its author', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    f.failChatReplies(100);
    const request = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    await f.deliver(request);
    await waitFor(() => f.store.db.prepare(`SELECT terminal_status_json FROM mingle_team_device_deliveries WHERE delivery_id=? AND status='completed'`)
      .get(request.deliveryId)?.terminal_status_json, 4000, 'saved completed result before owner signing');
    await waitFor(() => f.sent.some((entry) => entry.kind === 'teamgroup.delivery.status'
      && entry.payload.deliveryId === request.deliveryId && entry.payload.status === 'completed'), 4000, 'status delivery independent of reply signing');
    await f.side.close();
    expect(f.chatReplies).toHaveLength(0);
    const starts = f.runtime.startCount;
    // A changed account/device owner must never acquire the original agent's saved output.
    f.roster[0].accountId = OTHER;
    f.failChatReplies(0);
    await f.restartSide();
    await waitFor(() => f.sent.some((entry) => entry.kind === 'teamgroup.delivery.status' && entry.payload.deliveryId === request.deliveryId && entry.payload.status === 'completed'));
    expect(f.chatReplies).toHaveLength(0);
    f.roster[0].accountId = ACCOUNT;
    await f.restartSide();
    await waitFor(() => f.chatReplies.length === 1, 4000, 'owner reply recovered from durable completion');
    expect(f.chatReplies[0]).toEqual([f.projectId, AGENT_ID, 'Final result: safe output', request.requestId, request.deliveryId]);
    expect(f.runtime.startCount).toBe(starts);
  });

  it('keeps awaiting owner approval alive with heartbeats and retries a failed terminal status enqueue', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    f.runtime.mode = 'approval';
    const waiting = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    await f.deliver(waiting);
    const approval = await waitFor(() => f.store.pendingApprovals()[0]);
    await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.delivery.status'
      && message.payload.deliveryId === waiting.deliveryId && message.payload.status === 'awaiting-approval'));
    await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.delivery.heartbeat' && message.payload.deliveryId === waiting.deliveryId));
    expect(f.store.db.prepare('SELECT status FROM mingle_team_device_deliveries WHERE delivery_id=?').get(waiting.deliveryId))
      .toMatchObject({ status: 'awaiting-approval' });
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE,
      kind: 'teamgroup.interrupt', payload: { sharedProjectId: SHARED, deliveryId: waiting.deliveryId, reason: 'stop after approval wait' } });
    await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.delivery.status'
      && message.payload.deliveryId === waiting.deliveryId && message.payload.status === 'interrupted'));
    expect(approval.status).toBe('pending');

    f.runtime.mode = 'complete';
    f.failTerminalStatusSends(1);
    const result = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    const resultEnvelope = { id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.delivery', payload: result };
    await f.handler?.(resultEnvelope);
    await waitFor(() => {
      const row = f.store.db.prepare('SELECT status,terminal_status_json FROM mingle_team_device_deliveries WHERE delivery_id=?')
        .get(result.deliveryId) as { status: string; terminal_status_json: string | null } | undefined;
      return row?.status === 'completed' && row.terminal_status_json;
    }, 4000, 'durable completion payload before status retry');
    const saved = f.store.db.prepare('SELECT terminal_status_json FROM mingle_team_device_deliveries WHERE delivery_id=?')
      .get(result.deliveryId) as { terminal_status_json: string };
    const savedPayload = JSON.parse(saved.terminal_status_json);
    expect(savedPayload).toMatchObject({ deliveryId: result.deliveryId, status: 'completed', runId: expect.any(String),
      finalText: expect.stringContaining('Final result: safe output'), artifacts: [{ transferId: 'transfer-1' }] });
    await f.restartSide();
    await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.delivery.status'
      && message.payload.deliveryId === result.deliveryId && message.payload.status === 'completed'));
    const resent = f.sent.find((message) => message.kind === 'teamgroup.delivery.status'
      && message.payload.deliveryId === result.deliveryId && message.payload.status === 'completed')!.payload;
    expect(resent).toEqual(savedPayload);
    await f.handler?.(resultEnvelope);
    const replays = f.sent.filter((message) => message.kind === 'teamgroup.delivery.status'
      && message.payload.deliveryId === result.deliveryId && message.payload.status === 'completed');
    expect(replays.at(-1)?.payload).toEqual(savedPayload);
    expect(f.runtime.startCount).toBe(2);
  });

  it('keeps teammate-triggered runs dynamically permissioned by the host for their full duration', async () => {
    const f = await fixture();
    const sessionId = f.store.listSessions(f.projectId)[0]!.id;
    f.store.db.prepare("UPDATE sessions SET policy = 'full-access' WHERE id = ?").run(sessionId);
    await sendStructure(f, structure(1, 'supervised'));
    await f.setConsent('supervised', 1);

    const supervisedDelivery = deliveryPayload({ deliveryId: `delivery-${randomUUID()}`, permissionLevel: 'supervised', settingsVersion: 1 });
    await f.deliver(supervisedDelivery);
    await waitFor(() => f.sent.some((message) => message.payload.deliveryId === supervisedDelivery.deliveryId && message.payload.status === 'completed'));
    const supervisedRun = [...f.runtime.optionsByRun.entries()].find(([runId]) => f.store.getRun(runId)?.sessionId === sessionId);
    expect(supervisedRun?.[1]).toMatchObject({ runPolicy: 'supervised' });
    expect(f.store.getSession(sessionId)?.policy).toBe('full-access');

    await sendStructure(f, structure(2, 'full-access'));
    await f.setConsent('full-access', 2);
    const fullAccessDelivery = deliveryPayload({ deliveryId: `delivery-${randomUUID()}`, permissionLevel: 'full-access', settingsVersion: 2 });
    await f.deliver(fullAccessDelivery);
    await waitFor(() => f.sent.some((message) => message.payload.deliveryId === fullAccessDelivery.deliveryId && message.payload.status === 'completed'));
    const startedRuns = [...f.runtime.optionsByRun.values()];
    expect(startedRuns.map((options) => options.runPolicy)).toEqual(['supervised', 'supervised']);
    expect(f.store.getSession(sessionId)?.policy).toBe('full-access');
  });

  it('imports delivery input artifacts into the owner repository before starting the provider run', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    const revision = runGit(f.worktree, 'rev-parse', 'HEAD').trim();
    const artifact = { revision, transferId: 'incoming-transfer', path: 'README.md', ref: 'refs/mingle/team/input' };
    const payload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}`, inputArtifacts: [artifact] });
    await f.deliver(payload);
    await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.delivery.status'
      && message.payload.deliveryId === payload.deliveryId && message.payload.status === 'completed'));
    expect(f.importCalls).toHaveLength(1);
    expect(f.importCalls[0]).toMatchObject({ deliveryId: payload.deliveryId, sourceDeviceId: HOST_DEVICE, artifact });
    expect(f.executionOrder.slice(0, 2)).toEqual(['import', 'start']);
  });

  it('interrupts active owner-device runs as soon as local consent is paused', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    f.runtime.mode = 'manual';
    const payload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.delivery', payload });
    await waitFor(() => f.runtime.startCount === 1);
    expect(f.runtime.isActive(f.store.listSessions(f.projectId)[0]!.id)).toBe(true);
    const changed = await callRoute(f, 'PATCH', '/api/projects/:projectId/team-consent', { projectId: f.projectId }, { state: 'paused' });
    expect(changed.state).toBe('paused');
    await waitFor(() => f.sent.some((message) => message.payload?.deliveryId === payload.deliveryId && message.payload?.status === 'interrupted'));
    expect(f.runtime.isActive(f.store.listSessions(f.projectId)[0]!.id)).toBe(false);
  });

  it('cancels an accepted delivery paused during artifact preparation before the provider can start', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    let releaseImport!: () => void;
    const importGate = new Promise<void>((resolve) => { releaseImport = resolve; });
    f.holdImports(importGate);
    const revision = runGit(f.worktree, 'rev-parse', 'HEAD').trim();
    const payload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}`, inputArtifacts: [{ revision, transferId: 'blocked-import' }] });
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.delivery', payload });
    await waitFor(() => f.importCalls.length === 1);

    await callRoute(f, 'PATCH', '/api/projects/:projectId/team-consent', { projectId: f.projectId }, { state: 'paused' });
    releaseImport();
    await waitFor(() => f.sent.some((message) => message.payload?.deliveryId === payload.deliveryId && message.payload?.status === 'interrupted'));
    expect(f.runtime.startCount).toBe(0);

    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.delivery', payload });
    expect(f.sent.at(-1)?.payload).toMatchObject({ deliveryId: payload.deliveryId, status: 'interrupted' });
  });

  it('reconciles persisted active deliveries as interrupted on owner-device restart and deduplicates retries', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    const payload: TeamDeliveryPayload = TeamDeliveryPayloadSchema.parse(deliveryPayload({ deliveryId: `delivery-${randomUUID()}` }));
    const at = new Date().toISOString();
    f.store.db.prepare(`INSERT INTO mingle_team_device_deliveries(delivery_id,shared_project_id,agent_id,session_id,request_json,status,
      base_revision,created_at,updated_at) VALUES(?,?,?,?,?,'accepted',NULL,?,?)`)
      .run(payload.deliveryId, SHARED, AGENT_ID, f.store.listSessions(f.projectId)[0]!.id, JSON.stringify(payload), at, at);

    await f.restartSide();
    await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.delivery.status'
      && message.payload.deliveryId === payload.deliveryId && message.payload.status === 'interrupted'));
    expect(f.store.db.prepare('SELECT status FROM mingle_team_device_deliveries WHERE delivery_id=?').get(payload.deliveryId))
      .toMatchObject({ status: 'interrupted' });

    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.delivery', payload });
    expect(f.runtime.startCount).toBe(0);
    expect(f.sent.at(-1)?.payload).toMatchObject({ deliveryId: payload.deliveryId, status: 'interrupted' });
  });

  it('preserves provider quota-exhausted failures when reporting a remote run failure', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    f.runtime.mode = 'failed';
    const payload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.delivery', payload });
    await waitFor(() => f.sent.find((message) => message.payload?.deliveryId === payload.deliveryId && message.payload?.status === 'failed'));
    expect(f.sent.find((message) => message.payload?.deliveryId === payload.deliveryId && message.payload?.status === 'failed')?.payload.failure)
      .toMatchObject({ kind: 'quota_exhausted', message: 'Quota exhausted on the local provider.' });
  });

  it('interrupts an active delivery and mirrors supervised approvals with first-decision-wins behavior', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    f.runtime.mode = 'approval';
    const payload = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.delivery', payload });
    const approval = await waitFor(() => f.store.pendingApprovals()[0]);
    await waitFor(() => f.sent.find((message) => message.kind === 'teamgroup.approval.request'));
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE,
      kind: 'teamgroup.approval.decision', payload: { sharedProjectId: SHARED, deliveryId: payload.deliveryId, approvalId: approval.id, decision: 'approved' } });
    expect(f.store.getApproval(approval.id)?.status).toBe('approved');

    f.runtime.mode = 'manual';
    const interrupted = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.delivery', payload: interrupted });
    await waitFor(() => f.runtime.startCount === 2);
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE,
      kind: 'teamgroup.interrupt', payload: { sharedProjectId: SHARED, deliveryId: interrupted.deliveryId, reason: 'stop' } });
    await waitFor(() => f.sent.some((message) => message.payload?.deliveryId === interrupted.deliveryId && message.payload?.status === 'interrupted'));

    f.runtime.mode = 'approval';
    const ownerDenied = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.delivery', payload: ownerDenied });
    const ownerApproval = await waitFor(() => f.store.pendingApprovals()[0]);
    await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.approval.request' && message.payload.approvalId === ownerApproval.id));
    f.runtime.decide(ownerApproval.id, 'denied');
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE,
      kind: 'teamgroup.approval.decision', payload: { sharedProjectId: SHARED, deliveryId: ownerDenied.deliveryId, approvalId: ownerApproval.id, decision: 'approved' } });
    expect(f.store.getApproval(ownerApproval.id)?.status).toBe('denied');
  });

  it('serves local activity and mirrors only roster-owned remote activity with bounded entries', async () => {
    const f = await fixture();
    await sendStructure(f);
    await f.setConsent();
    const delivery = deliveryPayload({ deliveryId: `delivery-${randomUUID()}` });
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.delivery', payload: delivery });
    await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.activity' && message.payload.entries.length));
    await waitFor(() => f.sent.some((message) => message.kind === 'teamgroup.delivery.status' && message.payload.deliveryId === delivery.deliveryId && message.payload.status === 'completed'));
    const local = await callRoute(f, 'GET', '/api/projects/:projectId/team-agents/:agentId/activity',
      { projectId: f.projectId, agentId: AGENT_ID });
    expect(local).toMatchObject({ local: true, entries: expect.arrayContaining([expect.objectContaining({ kind: 'request' }), expect.objectContaining({ kind: 'assistant' })]) });
    const activityMessages = f.sent.filter((message) => message.kind === 'teamgroup.activity');
    for (const deviceId of [HOST_DEVICE, OTHER_DEVICE]) {
      const perDevice = activityMessages.filter((message) => message.toDeviceId === deviceId);
      for (let index = 1; index < perDevice.length; index++) {
        expect(perDevice[index]!.sentAt! - perDevice[index - 1]!.sentAt!).toBeGreaterThanOrEqual(15);
      }
    }
    expect(activityMessages.every((message) => message.payload.entries.length <= 20
      && message.payload.entries.every((entry: any) => entry.text.length <= 8_000))).toBe(true);

    const remoteAgent = { id: 'agent_remote', name: 'Remote', accountId: OTHER, deviceId: OTHER_DEVICE,
      sessionId: 'remote-session', provider: 'claude', model: 'claude-sonnet-5-5', state: 'idle' };
    f.roster.push(remoteAgent);
    const remoteEntry = { id: 'entry_remote_1', runId: 'run_remote_1', at: new Date().toISOString(), kind: 'assistant', text: 'Remote answer' };
    const activity = { sharedProjectId: SHARED, agentId: remoteAgent.id, state: 'idle', runId: 'run_remote_1', entries: [remoteEntry] };
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: OTHER_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.activity', payload: activity });
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.activity', payload: { ...activity, entries: [{ ...remoteEntry, id: 'entry_forged' }] } });
    const remote = await callRoute(f, 'GET', '/api/projects/:projectId/team-agents/:agentId/activity',
      { projectId: f.projectId, agentId: remoteAgent.id });
    expect(remote).toMatchObject({ local: false, entries: [expect.objectContaining({ id: 'entry_remote_1', text: 'Remote answer' })] });
  });

  it('persists activity bursts without generic store touches and emits a coalesced scoped notification', async () => {
    const f = await fixture();
    const remoteAgent = { id: 'agent_remote', name: 'Remote', accountId: OTHER, deviceId: OTHER_DEVICE,
      sessionId: 'remote-session', provider: 'claude', model: 'claude-sonnet-5-5', state: 'idle' };
    f.roster.push(remoteAgent);
    const touch = vi.spyOn(f.store, 'touch');
    for (let index = 0; index < 10; index++) {
      await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: OTHER_DEVICE, toDeviceId: OWN_DEVICE, kind: 'teamgroup.activity', payload: {
        sharedProjectId: SHARED, agentId: remoteAgent.id, state: 'working', runId: 'run_remote_burst', entries: [
          { id: `entry_remote_burst_${index}`, runId: 'run_remote_burst', at: new Date(Date.now() + index).toISOString(), kind: 'tool', text: `Tool ${index}` },
        ],
      } });
    }

    expect(touch).not.toHaveBeenCalled();
    expect(f.hubEvents).toHaveLength(1);
    expect(f.hubEvents[0]).toMatchObject({ type: 'state.changed', event: {
      type: 'team.agent.activity.updated', projectId: f.projectId, payload: { sharedProjectId: SHARED, agentId: remoteAgent.id },
    } });
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM mingle_team_device_activity WHERE agent_id=?').get(remoteAgent.id)).toEqual({ n: 10 });
  });

  it('refreshes before rejecting an activity author removed by a structure notification', async () => {
    const f = await fixture();
    const removedAgent = { id: 'agent_removed', name: 'Removed', accountId: OTHER, deviceId: OTHER_DEVICE,
      sessionId: 'removed-session', provider: 'claude', model: 'claude-sonnet-5-5', state: 'idle' };
    f.roster.push(removedAgent);
    // Model the immediate read-model refresh caused by the signed removal notification.
    f.members.splice(f.members.findIndex((member) => member.accountId === OTHER), 1);
    f.roster.splice(f.roster.indexOf(removedAgent), 1);
    await sendStructure(f, structure(2));
    const before = f.collaborationRefreshCount();
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: OTHER_DEVICE, toDeviceId: OWN_DEVICE,
      kind: 'teamgroup.activity', payload: { sharedProjectId: SHARED, agentId: removedAgent.id, state: 'idle', runId: 'removed-run',
        entries: [{ id: 'removed-entry', runId: 'removed-run', at: new Date().toISOString(), kind: 'assistant', text: 'must not persist' }] } });
    expect(f.collaborationRefreshCount()).toBeGreaterThan(before);
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM mingle_team_device_activity WHERE entry_id=?').get('removed-entry')).toEqual({ n: 0 });
  });

  it('refreshes an unknown activity author and accepts a newly joined member after authority confirms it', async () => {
    const f = await fixture();
    await sendStructure(f);
    const newAgent = { id: 'agent_new_member', name: 'New member agent', accountId: NEW_MEMBER, deviceId: OTHER_DEVICE,
      sessionId: 'new-member-session', provider: 'claude', model: 'claude-sonnet-5-5', state: 'idle' };
    const before = f.collaborationRefreshCount();
    f.setFreshCollaborationSnapshot([...f.members, { accountId: NEW_MEMBER, role: 'member', displayName: 'New teammate', status: 'active' }], [newAgent], NEW_MEMBER);
    await f.handler?.({ id: randomUUID(), teamId: TEAM, fromDeviceId: OTHER_DEVICE, toDeviceId: OWN_DEVICE,
      kind: 'teamgroup.activity', payload: { sharedProjectId: SHARED, agentId: newAgent.id, state: 'idle', runId: 'new-member-run',
        entries: [{ id: 'new-member-entry', runId: 'new-member-run', at: new Date().toISOString(), kind: 'assistant', text: 'accepted after refresh' }] } });
    expect(f.collaborationRefreshCount()).toBeGreaterThan(before);
    expect(f.store.db.prepare('SELECT entry_json FROM mingle_team_device_activity WHERE entry_id=?').get('new-member-entry'))
      .toMatchObject({ entry_json: expect.stringContaining('accepted after refresh') });
  });
});

describe('team device migration 21, session base migration 22, and terminal status migration 23', () => {
  it('creates its owner-device tables when upgraded from schema version 20', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mingle-team-device-migration-'));
    roots.push(root);
    const file = path.join(root, 'state.sqlite');
    const db = openDatabase(file);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(23);
    db.close();
    for (const legacyVersion of [19, 20]) {
      const older = new DatabaseSync(file);
      older.exec(`DROP TABLE mingle_team_device_approvals; DROP TABLE mingle_team_device_activity; DROP TABLE mingle_team_device_deliveries;
        DROP TABLE mingle_team_device_structures; DROP TABLE mingle_team_device_consents; PRAGMA user_version=${legacyVersion};`);
      older.close();
      const upgraded = openDatabase(file);
      expect((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(23);
      expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mingle_team_device_consents'").get()).toBeTruthy();
      upgraded.close();
    }
  });
});
