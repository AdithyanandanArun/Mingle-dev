import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
const OWN_DEVICE = randomUUID();
const HOST_DEVICE = randomUUID();
const OTHER_DEVICE = randomUUID();
const AGENT_ID = 'agent_local';

interface Sent { teamId: string; toDeviceId: string; kind: string; payload: any; idempotencyKey: string; sentAt?: number }
interface Fixture {
  store: Store; side: ReturnType<typeof createDeviceSide>; routes: Array<{ method: string; path: string; handler: (ctx: any) => unknown }>;
  projectId: string; root: string; repo: string; worktree: string; sent: Sent[]; roster: any[]; handler: ((envelope: any) => Promise<void>) | null;
  runtime: FakeRuntime; exportCalls: any[]; importCalls: any[]; executionOrder: string[]; chatReplies: any[]; members: any[]; setConsent(permission?: 'supervised' | 'full-access', settingsVersion?: number): Promise<any>;
  holdImports(gate: Promise<void>): void;
  restartSide(): Promise<void>;
  deliver(overrides?: Record<string, unknown>, sender?: string): Promise<void>; close(): Promise<void>;
}

class FakeRuntime {
  startCount = 0;
  mode: 'complete' | 'approval' | 'manual' | 'failed' = 'complete';
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
      writeFileSync(path.join(options.worktree.path, `artifact-${runId}.txt`), `result from ${runId}\n`);
      runGit(options.worktree.path, '-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'add', `artifact-${runId}.txt`);
      runGit(options.worktree.path, '-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'commit', '-m', `artifact ${runId}`);
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
  const store = new Store(openDatabase(':memory:'));
  const project = store.insertProject({ name: 'Shared workspace', path: repo });
  const session = store.insertSession({ projectId: project.id, name: 'Local agent', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: true, worktreePath: worktree, branch: 'agent-worker' });
  store.db.exec(`CREATE TABLE mingle_project_collaboration_sources (local_project_id TEXT, owner_id TEXT, team_id TEXT, shared_project_id TEXT, leader_device_id TEXT);
    CREATE TABLE mingle_project_collaboration_joins (invitation_id TEXT, account_id TEXT, device_id TEXT, local_project_id TEXT, team_id TEXT, shared_project_id TEXT);`);
  store.db.prepare(`INSERT INTO mingle_project_collaboration_joins VALUES(?,?,?,?,?,?)`)
    .run(randomUUID(), ACCOUNT, OWN_DEVICE, project.id, TEAM, SHARED);

  const sent: Sent[] = [];
  const roster: any[] = [];
  const members = [
    { accountId: LEAD, role: 'leader', displayName: 'Lead' },
    { accountId: ACCOUNT, role: 'member', displayName: 'Owner' },
    { accountId: OTHER, role: 'member', displayName: 'Other' },
  ];
  let handler: ((envelope: any) => Promise<void>) | null = null;
  const devices = [
    { id: OWN_DEVICE, teamId: TEAM, ownerId: ACCOUNT, name: 'Owner', revokedAt: null, status: 'online' },
    { id: HOST_DEVICE, teamId: TEAM, ownerId: LEAD, name: 'Lead', revokedAt: null, status: 'online' },
    { id: OTHER_DEVICE, teamId: TEAM, ownerId: OTHER, name: 'Teammate', revokedAt: null, status: 'online' },
  ];
  const transport: any = {
    snapshot: (teamId?: string) => ({ deviceId: OWN_DEVICE, devices: devices.filter((device) => !teamId || device.teamId === teamId),
      links: [{ deviceId: OWN_DEVICE, peerDeviceId: HOST_DEVICE, mutual: true }, { deviceId: OWN_DEVICE, peerDeviceId: OTHER_DEVICE, mutual: true }] }),
    send: async (input: Sent) => { sent.push({ ...input, sentAt: Date.now() }); return `envelope-${sent.length}`; },
    sync: async () => undefined,
    onMessage: (next: (envelope: any) => Promise<void>) => { handler = next; return () => { handler = null; }; },
  };
  const account: any = {
    snapshot: () => ({ user: { id: ACCOUNT }, status: 'signed-in' }),
    withAuthenticatedClient: async (callback: (client: any, user: any) => unknown) => callback({}, { id: ACCOUNT }),
  };
  const collaboration: any = {
    snapshot: async (projectId: string) => ({
      project: projectId === project.id ? { teamId: TEAM, sharedProjectId: SHARED, name: 'Shared workspace' } : null,
      members,
      agents: roster.map((agent) => ({ ...agent, projectId, state: 'idle' })),
      invitations: [], email: { configured: false },
    }),
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
  const teamChat = { postAgentReply: async (...args: any[]) => { chatReplies.push(args); return { id: `chat-${chatReplies.length}` }; } };
  const routes: Fixture['routes'] = [];
  let side!: ReturnType<typeof createDeviceSide>;
  const startSide = () => {
    side = createDeviceSide({ store, runtime: runtime as any, transport, account, distributed, collaboration, teamChat: teamChat as any,
      activityThrottleMs: 15, toolTimeoutMs: 30 });
    side.routes((method, route, routeHandler) => routes.push({ method, path: route, handler: routeHandler }));
  };
  startSide();
  const result: Fixture = {
    store, get side() { return side; }, routes, projectId: project.id, root, repo, worktree, sent, roster, get handler() { return handler; }, runtime, exportCalls, importCalls, executionOrder, chatReplies, members,
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
    agentId: AGENT_ID, role: 'worker', kind: 'request', content: 'Implement the scoped task.', hop: 0,
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
    expect(f.sent.some((message) => message.kind === 'teamgroup.consent' && message.toDeviceId === HOST_DEVICE)).toBe(true);
    expect(f.side.localConsent(SHARED)?.state).toBe('granted');
    expect(f.store.listEvents().filter((event) => event.type === 'team.structure.updated').at(-1)?.projectId).toBe(f.projectId);

    const paused = await callRoute(f, 'PATCH', '/api/projects/:projectId/team-consent', { projectId: f.projectId }, { state: 'paused' });
    expect(paused.state).toBe('paused');
    const revoked = await callRoute(f, 'PATCH', '/api/projects/:projectId/team-consent', { projectId: f.projectId }, { state: 'revoked' });
    expect(revoked.state).toBe('revoked');

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

    await f.deliver({ ...payload, deliveryId: `delivery-${randomUUID()}`, agentId: 'agent-unknown' });
    expect(f.sent.at(-1)?.payload).toMatchObject({ status: 'rejected', rejection: 'agent-unavailable' });
    expect(f.runtime.startCount).toBe(0);
  });

  it('accepts one delivery, runs in the isolated worktree, exports a commit, posts one chat reply and deduplicates delivery', async () => {
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
    expect(completed).toMatchObject({ finalText: 'Final result: safe output', artifacts: [{ transferId: 'transfer-1' }] });
    expect(f.exportCalls).toHaveLength(1);
    expect(f.exportCalls[0]).toMatchObject({ toDeviceId: HOST_DEVICE, deliveryId: payload.deliveryId, sourceWorktreePath: f.worktree });
    expect(f.chatReplies).toHaveLength(1);
    expect(f.chatReplies[0]).toEqual([f.projectId, AGENT_ID, 'Final result: safe output', payload.requestId, payload.deliveryId]);
  });

  it('bounds each teammate-triggered run by the saved session, team, and owner-consent policies', async () => {
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
    expect(startedRuns.map((options) => options.runPolicy)).toEqual(['supervised', 'full-access']);
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
});

describe('team device migration 21 and session base migration 22', () => {
  it('creates its owner-device tables when upgraded from schema version 20', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mingle-team-device-migration-'));
    roots.push(root);
    const file = path.join(root, 'state.sqlite');
    const db = openDatabase(file);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(22);
    db.close();
    for (const legacyVersion of [19, 20]) {
      const older = new DatabaseSync(file);
      older.exec(`DROP TABLE mingle_team_device_approvals; DROP TABLE mingle_team_device_activity; DROP TABLE mingle_team_device_deliveries;
        DROP TABLE mingle_team_device_structures; DROP TABLE mingle_team_device_consents; PRAGMA user_version=${legacyVersion};`);
      older.close();
      const upgraded = openDatabase(file);
      expect((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(22);
      expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mingle_team_device_consents'").get()).toBeTruthy();
      upgraded.close();
    }
  });
});
