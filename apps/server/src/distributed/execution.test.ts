import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db.ts';
import { RemoteExecutionService, type AuthenticatedEnvelope, type RemoteExecutionAccount, type RemoteExecutionProviders, type RemoteExecutionRuntime, type RemoteExecutionTransport, type RemoteExecutionWorkspace } from './execution.ts';

const TEAM = 'team_exec';
const SHARED_PROJECT = 'shared_project_exec';
const OWNER_A = 'c5a275f0-28af-4cdb-b4bb-bd3b1634131c';
const OWNER_B = '7a35f046-8d11-4e97-8a3d-101728c209c4';
const DEVICE_A = 'device_exec_a';
const DEVICE_B = 'device_exec_b';
const now = () => new Date().toISOString();

type CloudRow = Record<string, unknown>;
class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Array<[string, unknown]> = [];
  constructor(private readonly rows: CloudRow[]) {}
  select(_columns: string): this { return this; }
  eq(column: string, value: string): this { this.filters.push([column, value]); return this; }
  is(column: string, value: null): this { this.filters.push([column, value]); return this; }
  private result(single: boolean) {
    const rows = this.rows.filter((row) => this.filters.every(([key, value]) => row[key] === value));
    return { data: single ? rows[0] ?? null : rows, error: null };
  }
  maybeSingle(): Promise<{ data: unknown; error: unknown }> { return Promise.resolve(this.result(true)); }
  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.result(false)).then(onfulfilled, onrejected);
  }
}

const cloud = {
  mingle_members: [{ team_id: TEAM, user_id: OWNER_A, revoked_at: null }, { team_id: TEAM, user_id: OWNER_B, revoked_at: null }],
  mingle_projects: [{ id: SHARED_PROJECT, team_id: TEAM }],
  mingle_devices: [
    { id: DEVICE_A, team_id: TEAM, owner_id: OWNER_A, revoked_at: null },
    { id: DEVICE_B, team_id: TEAM, owner_id: OWNER_B, revoked_at: null },
  ],
  mingle_device_links: [
    { team_id: TEAM, device_id: DEVICE_A, peer_device_id: DEVICE_B },
    { team_id: TEAM, device_id: DEVICE_B, peer_device_id: DEVICE_A },
  ],
};

function makeAccount(ownerId: string): RemoteExecutionAccount {
  const client = { from: (table: string) => new FakeQuery((cloud as Record<string, CloudRow[]>)[table] ?? []) };
  return { withAuthenticatedClient: async (work) => work(client as never, { id: ownerId }) };
}

class FakeTransport implements RemoteExecutionTransport {
  sent: Array<{ teamId: string; toDeviceId: string; kind: string; payload: unknown; idempotencyKey: string }> = [];
  handler: ((envelope: AuthenticatedEnvelope) => Promise<void>) | null = null;
  constructor(readonly localDeviceId: string, private readonly remoteDeviceId: string) {}
  snapshot() {
    const localOwner = this.localDeviceId === DEVICE_A ? OWNER_A : OWNER_B;
    const remoteOwner = this.remoteDeviceId === DEVICE_A ? OWNER_A : OWNER_B;
    return { localDeviceId: this.localDeviceId, devices: [
      { id: this.localDeviceId, teamId: TEAM, ownerId: localOwner, linked: true, revokedAt: null, online: true },
      { id: this.remoteDeviceId, teamId: TEAM, ownerId: remoteOwner, linked: true, revokedAt: null, online: true },
    ] };
  }
  async send(input: { teamId: string; toDeviceId: string; kind: string; payload: unknown; idempotencyKey: string }) {
    if (input.kind === 'execution.request') {
      const existing = this.sent.find((entry) => entry.kind === input.kind && entry.idempotencyKey === input.idempotencyKey);
      if (existing) {
        if (JSON.stringify(existing.payload) !== JSON.stringify(input.payload)) throw new Error('Transport idempotency key was reused with a different immutable request payload.');
        return { accepted: true };
      }
    }
    this.sent.push(input);
    return { accepted: true };
  }
  onMessage(handler: (envelope: AuthenticatedEnvelope) => Promise<void>): () => void { this.handler = handler; return () => { this.handler = null; }; }
}

let databases: ReturnType<typeof openDatabase>[] = [];
let services: RemoteExecutionService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const db of databases.splice(0)) db.close();
});

interface Fixture {
  service: RemoteExecutionService; workspace: RemoteExecutionWorkspace; db: ReturnType<typeof openDatabase>; transport: FakeTransport;
  runCalls: Array<{ sessionId: string; content: string; options?: { taskId?: string; userMessage?: { content: string; kind?: string } } }>;
  progressListeners: Array<(event: { runId: string; kind: 'status' | 'progress' | 'result'; status?: string; summary?: string; delta?: string; terminal?: boolean }) => void>;
  quota: { state: 'available' | 'exhausted' | 'unknown'; observedAt: string | null };
  alternativeState: 'available' | 'busy' | 'quota-exhausted' | 'provider-unavailable' | 'unknown';
}

function createFixture(input: { deviceId: string; peerId: string; ownerId: string; projectId: string; sessionId: string; sessionName: string; provider: 'codex' | 'claude' | 'opencode'; seedFailure?: boolean }): Fixture {
  const db = openDatabase(':memory:');
  databases.push(db);
  const projectId = input.projectId;
  const created = now();
  db.prepare('INSERT INTO projects(id,name,path,created_at,is_example,archived_at) VALUES (?,?,?,?,0,NULL)').run(projectId, projectId, `/tmp/${projectId}`, created);
  db.prepare(`INSERT INTO sessions(id,project_id,name,provider,model,effort,status,policy,isolated,worktree_path,branch,provider_session_id,
    created_at,updated_at,error,input_tokens,output_tokens,cost_usd,service_tier,archived_at)
    VALUES (?, ?, ?, ?, ?, 'high', 'idle', 'supervised', 1, ?, 'main', ?, ?, ?, NULL, 0, 0, NULL, 'standard', NULL)`)
    .run(input.sessionId, projectId, input.sessionName, input.provider, input.provider === 'codex' ? 'gpt-test-model' : input.provider === 'claude' ? 'claude-test-model' : 'opencode-test-model',
      `/tmp/${projectId}/worktree`, `native_${input.sessionId}`, created, created);
  db.prepare(`INSERT INTO tasks(id,project_id,title,description,acceptance_criteria,session_id,status,created_at,updated_at)
    VALUES ('task_base',?,'Base dependency','','',NULL,'done',?,?)`).run(projectId, created, created);
  db.prepare(`INSERT INTO tasks(id,project_id,title,description,acceptance_criteria,session_id,status,created_at,updated_at)
    VALUES ('task_exec',?,'Fix the fixture','Implement one bounded change','Keep the fixture safe',?,'ready',?,?)`)
    .run(projectId, input.sessionId, created, created);
  db.prepare("INSERT INTO task_deps(task_id,depends_on) VALUES ('task_exec','task_base')").run();

  if (input.seedFailure) {
    const messageId = `msg_${input.sessionId}`;
    const runId = `run_${input.sessionId}`;
    db.prepare("INSERT INTO messages(id,session_id,role,content,created_at) VALUES (?,?,'user','Complete task_exec',?)").run(messageId, input.sessionId, created);
    db.prepare(`INSERT INTO session_runs(id,session_id,user_message_id,provider,model,status,started_at,finished_at,duration_ms)
      VALUES (?,?,?,?,?,'failed',?,?,1000)`).run(runId, input.sessionId, messageId, input.provider, input.provider === 'codex' ? 'gpt-test-model' : input.provider === 'claude' ? 'claude-test-model' : 'opencode-test-model', created, created);
    const checkpoint = {
      id: `checkpoint_${input.sessionId}`, version: 1, sessionId: input.sessionId, runId, reason: 'Provider failed', capturedAt: created,
      objective: 'Finish task_exec', tasks: [{ id: 'task_exec', title: 'Fix the fixture', description: 'Implement one bounded change', acceptanceCriteria: 'Keep the fixture safe', status: 'ready' }],
      worktree: { path: `/tmp/${projectId}/worktree`, branch: 'main', head: 'a'.repeat(40), dirtyPaths: [], dirtyPathsTruncated: false, isRepository: true, statusKnown: true },
      artifacts: [{ id: 'artifact1', path: 'src/base.ts', revision: 'b'.repeat(40), taskId: 'task_exec' }],
      pendingApprovals: [], errors: [], uncertainTools: [], notices: [],
    };
    db.prepare('INSERT INTO session_checkpoints(id,session_id,run_id,version,reason,checkpoint_json,created_at) VALUES (?,?,?,1,?,?,?)')
      .run(checkpoint.id, input.sessionId, runId, checkpoint.reason, JSON.stringify(checkpoint), created);
    const failure = { id: `failure_${input.sessionId}`, sessionId: input.sessionId, runId, actor: 'session', kind: 'quota_exhausted',
      provider: input.provider, retryable: false, safeToRetry: false, outcomeUnknown: false, dispatchState: 'dispatched',
      continuationSafety: 'safe', message: 'Provider quota exhausted', occurredAt: created };
    db.prepare('INSERT INTO session_failures(id,session_id,run_id,failure_json,updated_at,resolved_at) VALUES (?,?,?,?,?,NULL)')
      .run(failure.id, input.sessionId, runId, JSON.stringify(failure), created);
  }

  const transport = new FakeTransport(input.deviceId, input.peerId);
  const runCalls: Fixture['runCalls'] = [];
  const progressListeners: Fixture['progressListeners'] = [];
  const runtime: RemoteExecutionRuntime = { start: (sessionId, content, options) => { runCalls.push({ sessionId, content, options }); return `remote_run_${runCalls.length}`; }, isActive: () => false };
  let alternativeState: Fixture['alternativeState'] = 'busy';
  let quota: Fixture['quota'] = { state: 'unknown', observedAt: null };
  const providers: RemoteExecutionProviders = {
    localAlternatives: async () => [{ sessionId: `local_alt_${input.deviceId}`, provider: input.provider, model: 'model', eligible: true, state: alternativeState }],
    quotaForSession: async () => quota,
  };
  const workspace: RemoteExecutionWorkspace = {
    isUnpublishedWork: async () => false,
    subscribeSession: (_sessionId, listener) => { progressListeners.push(listener); return () => { const index = progressListeners.indexOf(listener); if (index >= 0) progressListeners.splice(index, 1); }; },
  };
  const service = new RemoteExecutionService({ store: { db }, account: makeAccount(input.ownerId), transport, runtime, providers, workspace, changed: () => undefined });
  services.push(service);
  return {
    service, workspace, db, transport, runCalls, progressListeners,
    get quota() { return quota; }, set quota(value) { quota = value; },
    get alternativeState() { return alternativeState; }, set alternativeState(value) { alternativeState = value; },
  };
}

function envelope(fromDeviceId: string, toDeviceId: string, kind: string, payload: unknown, id = randomUUID()): AuthenticatedEnvelope {
  return { id, teamId: TEAM, fromDeviceId, toDeviceId, kind, payload };
}

let checkpointRefresh = 0;
function installFreshCheckpointCapture(fixture: Fixture, sessionId: string, runId: string, changeHead: () => boolean): void {
  fixture.workspace.captureCheckpoint = async () => {
    const row = fixture.db.prepare('SELECT id, checkpoint_json FROM session_checkpoints WHERE session_id = ? AND run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(sessionId, runId) as { id: string; checkpoint_json: string } | undefined;
    if (!row) throw new Error('Missing source checkpoint fixture.');
    const checkpoint = JSON.parse(row.checkpoint_json) as { id: string; capturedAt: string; worktree: { head: string | null } };
    checkpoint.id = `checkpoint_refresh_${++checkpointRefresh}`;
    checkpoint.capturedAt = now();
    if (changeHead()) checkpoint.worktree.head = 'c'.repeat(40);
    fixture.db.prepare('UPDATE session_checkpoints SET id = ?, checkpoint_json = ?, created_at = ? WHERE id = ?')
      .run(checkpoint.id, JSON.stringify(checkpoint), checkpoint.capturedAt, row.id);
  };
}

describe('RemoteExecutionService', () => {
  it('requires durable source proof and exhausted local alternatives before suggesting a remote fallback', async () => {
    const source = createFixture({ deviceId: DEVICE_A, peerId: DEVICE_B, ownerId: OWNER_A, projectId: 'project_a', sessionId: 'session_a', sessionName: 'Source', provider: 'codex', seedFailure: true });
    const destination = createFixture({ deviceId: DEVICE_B, peerId: DEVICE_A, ownerId: OWNER_B, projectId: 'project_b', sessionId: 'session_b', sessionName: 'Destination', provider: 'claude' });
    destination.quota = { state: 'available', observedAt: now() };
    await destination.service.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: 'project_b' });
    const [agent] = await destination.service.publishAgents({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sessionIds: ['session_b'] });
    await source.service.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: 'project_a' });
    const published = destination.transport.sent.find((entry) => entry.kind === 'execution.agents');
    expect(published).toBeDefined();
    await source.service.onEnvelope(envelope(DEVICE_B, DEVICE_A, 'execution.agents', published!.payload));

    const blocked = await source.service.suggestFallback({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: 'session_a', taskId: 'task_exec' });
    expect(blocked.eligible).toBe(false);
    expect(blocked.candidates).toEqual([]);
    source.alternativeState = 'unknown';
    expect((await source.service.suggestFallback({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: 'session_a', taskId: 'task_exec' })).eligible).toBe(false);
    await expect(source.service.suggestFallback({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: 'session_a', taskId: 'task_exec', failure: 'quota_exhausted' })).rejects.toThrow();
    source.alternativeState = 'quota-exhausted';
    const eligible = await source.service.suggestFallback({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: 'session_a', taskId: 'task_exec' });
    expect(eligible).toMatchObject({ eligible: true, candidates: [{ id: agent!.id, quotaState: 'available', presence: 'idle' }] });
    expect(source.runCalls).toHaveLength(0);
  });

  it('blocks recovery when unfinished source files are absent from the committed checkpoint', async () => {
    const source = createFixture({ deviceId: DEVICE_A, peerId: DEVICE_B, ownerId: OWNER_A, projectId: 'dirty_source', sessionId: 'dirty_session', sessionName: 'Source', provider: 'codex', seedFailure: true });
    await source.service.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: 'dirty_source' });
    source.workspace.captureCheckpoint = async () => { throw new Error('Git inspection failed'); };
    const unavailable = await source.service.suggestFallback({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: 'dirty_session', taskId: 'task_exec' });
    expect(unavailable.eligible).toBe(false);
    expect(unavailable.reason).toMatch(/checkpoint could not be refreshed/i);
    delete source.workspace.captureCheckpoint;
    const row = source.db.prepare('SELECT checkpoint_json FROM session_checkpoints').get() as { checkpoint_json: string };
    const checkpoint = JSON.parse(row.checkpoint_json);
    checkpoint.worktree.dirtyPaths = ['src/unfinished.ts'];
    source.db.prepare('UPDATE session_checkpoints SET checkpoint_json = ?').run(JSON.stringify(checkpoint));
    source.alternativeState = 'provider-unavailable';
    const result = await source.service.suggestFallback({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: 'dirty_session', taskId: 'task_exec' });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/commit.*source changes/i);
    expect(source.transport.sent.some((item) => item.kind === 'execution.request')).toBe(false);
    expect(source.runCalls).toHaveLength(0);
  });

  it('refreshes published presence and configuration without probing quota', async () => {
    const destination = createFixture({ deviceId: DEVICE_B, peerId: DEVICE_A, ownerId: OWNER_B, projectId: 'project_refresh', sessionId: 'session_refresh', sessionName: 'Old name', provider: 'opencode' });
    await destination.service.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: 'project_refresh' });
    await destination.service.publishAgents({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sessionIds: ['session_refresh'] });
    destination.quota = { state: 'available', observedAt: now() };
    destination.db.prepare("UPDATE sessions SET name = 'Updated name', status = 'running' WHERE id = 'session_refresh'").run();

    const refreshed = await destination.service.refreshPublishedAgents({ teamId: TEAM, sharedProjectId: SHARED_PROJECT });
    expect(refreshed).toMatchObject([{ name: 'Updated name', presence: 'busy', quotaState: 'unknown' }]);
    expect(destination.transport.sent.filter((entry) => entry.kind === 'execution.agents')).toHaveLength(2);
    expect(destination.runCalls).toHaveLength(0);

    const observedAt = refreshed[0]!.presenceObservedAt;
    const unchanged = await destination.service.refreshPublishedAgents({ teamId: TEAM, sharedProjectId: SHARED_PROJECT });
    expect(unchanged[0]!.presenceObservedAt).toBe(observedAt);
    expect(destination.transport.sent.filter((entry) => entry.kind === 'execution.agents')).toHaveLength(2);
  });

  it('leaves an archived published session out of the snapshot until refresh revokes it', async () => {
    const destination = createFixture({ deviceId: DEVICE_B, peerId: DEVICE_A, ownerId: OWNER_B, projectId: 'project_archived', sessionId: 'session_archived', sessionName: 'Archived', provider: 'opencode' });
    await destination.service.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: 'project_archived' });
    await destination.service.publishAgents({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sessionIds: ['session_archived'] });
    destination.db.prepare("UPDATE sessions SET archived_at = ? WHERE id = 'session_archived'").run(now());

    expect((await destination.service.snapshot(TEAM)).agents.filter((entry) => entry.deviceId === DEVICE_B)).toHaveLength(0);
    expect(await destination.service.refreshPublishedAgents({ teamId: TEAM, sharedProjectId: SHARED_PROJECT })).toHaveLength(0);
    expect(destination.db.prepare("SELECT revoked_at FROM mingle_remote_agents WHERE session_id = 'session_archived'").get()).toMatchObject({ revoked_at: expect.any(String) });
  });

  it('pins approval to the destination owner and dispatches once only after fresh known quota', async () => {
    const source = createFixture({ deviceId: DEVICE_A, peerId: DEVICE_B, ownerId: OWNER_A, projectId: 'project_a2', sessionId: 'session_a2', sessionName: 'Source', provider: 'codex', seedFailure: true });
    const destination = createFixture({ deviceId: DEVICE_B, peerId: DEVICE_A, ownerId: OWNER_B, projectId: 'project_b2', sessionId: 'session_b2', sessionName: 'Destination', provider: 'claude' });
    destination.quota = { state: 'available', observedAt: now() };
    await destination.service.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: 'project_b2' });
    await destination.service.publishAgents({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sessionIds: ['session_b2'] });
    const agentPayload = destination.transport.sent.find((entry) => entry.kind === 'execution.agents')!.payload;
    await source.service.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: 'project_a2' });
    await source.service.onEnvelope(envelope(DEVICE_B, DEVICE_A, 'execution.agents', agentPayload));
    source.alternativeState = 'provider-unavailable';
    const agent = (await source.service.snapshot(TEAM)).agents.find((entry) => entry.deviceId === DEVICE_B)!;
    const request = await source.service.requestDelegation({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: 'session_a2',
      taskId: 'task_exec', agentId: agent.id, mode: 'provider-failure', content: 'Finish the saved task and verify the existing files.', maxSpendUsd: 2.5,
      idempotencyKey: 'delegation-a2-b2' });
    expect(request.evidence.unverifiedAtDestination).toBe(true);
    const requestEnvelope = source.transport.sent.find((entry) => entry.kind === 'execution.request')!;
    await destination.service.onEnvelope(envelope(DEVICE_A, DEVICE_B, 'execution.request', requestEnvelope.payload));

    await expect(source.service.decide({ requestId: request.id, expectedDigest: request.digest, decision: 'approved', allowProviderSpend: true })).rejects.toMatchObject({ status: 403 });
    await expect(destination.service.onEnvelope(envelope(DEVICE_A, DEVICE_B, 'execution.approval', { requestId: request.id }))).rejects.toThrow(/owner-local/i);
    destination.db.prepare("UPDATE sessions SET model = 'changed-after-request' WHERE id = 'session_b2'").run();
    await expect(destination.service.decide({ requestId: request.id, expectedDigest: request.digest, decision: 'approved', allowProviderSpend: true })).rejects.toThrow(/configuration changed/i);
    destination.db.prepare("UPDATE sessions SET model = 'claude-test-model', policy = 'full-access' WHERE id = 'session_b2'").run();
    await expect(destination.service.decide({ requestId: request.id, expectedDigest: request.digest, decision: 'approved', allowProviderSpend: true }))
      .rejects.toThrow(/requires a supervised session/i);
    destination.db.prepare("UPDATE sessions SET policy = 'supervised' WHERE id = 'session_b2'").run();
    destination.quota = { state: 'unknown', observedAt: null };
    await expect(destination.service.decide({ requestId: request.id, expectedDigest: request.digest, decision: 'approved', allowProviderSpend: true })).rejects.toThrow(/unknown/i);
    expect(destination.runCalls).toHaveLength(0);
    expect((await destination.service.snapshot(TEAM)).approvals).toHaveLength(0);

    destination.quota = { state: 'available', observedAt: now() };
    destination.workspace.validateDestinationCheckpoint = async () => { throw new Error('Source checkpoint commit is missing at destination'); };
    await expect(destination.service.decide({ requestId: request.id, expectedDigest: request.digest, decision: 'approved', allowProviderSpend: true }))
      .rejects.toThrow(/checkpoint commit is missing/i);
    expect(destination.runCalls).toHaveLength(0);
    expect((await destination.service.snapshot(TEAM)).approvals).toHaveLength(0);
    destination.workspace.validateDestinationCheckpoint = async () => undefined;
    const dispatched = await destination.service.decide({ requestId: request.id, expectedDigest: request.digest, decision: 'approved', allowProviderSpend: true, shareProgress: true });
    expect(dispatched).toMatchObject({ state: 'dispatched', runId: 'remote_run_1' });
    expect(destination.runCalls).toHaveLength(1);
    expect(destination.runCalls[0]?.options).toEqual({ userMessage: { content: expect.any(String), kind: 'remote-recovery' } });
    expect(destination.runCalls[0]?.content).toContain('UNVERIFIED');
    expect(destination.runCalls[0]?.content).toContain('Do not replay');
    expect(destination.runCalls[0]?.options?.taskId).toBeUndefined();
    expect(destination.progressListeners).toHaveLength(1);
    destination.progressListeners[0]!({ runId: 'remote_run_1', kind: 'progress', summary: 'Progress contains sk-ant-secretvalue and no tool input.' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sharedProgress = destination.transport.sent.find((entry) => entry.kind === 'collaboration.message');
    expect(sharedProgress?.payload).toMatchObject({ ownerId: OWNER_B, deviceId: DEVICE_B, agentId: agent.id, taskId: 'task_exec', dependsOn: ['task_base'], kind: 'progress' });
    expect(sharedProgress?.payload).toMatchObject({ content: 'Progress contains [redacted] and no tool input.' });
    await expect(destination.service.decide({ requestId: request.id, expectedDigest: request.digest, decision: 'approved', allowProviderSpend: true })).rejects.toThrow(/no longer awaiting/i);
    expect(destination.runCalls).toHaveLength(1);
  });

  it('keeps delegation retries bound to the first captured evidence across status updates and terminal completion', async () => {
    const source = createFixture({ deviceId: DEVICE_A, peerId: DEVICE_B, ownerId: OWNER_A, projectId: 'project_retry_a', sessionId: 'session_retry_a', sessionName: 'Source', provider: 'codex', seedFailure: true });
    const destination = createFixture({ deviceId: DEVICE_B, peerId: DEVICE_A, ownerId: OWNER_B, projectId: 'project_retry_b', sessionId: 'session_retry_b', sessionName: 'Destination', provider: 'claude' });
    destination.quota = { state: 'available', observedAt: now() };
    await destination.service.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: 'project_retry_b' });
    const [agent] = await destination.service.publishAgents({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sessionIds: ['session_retry_b'] });
    await source.service.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: 'project_retry_a' });
    await source.service.onEnvelope(envelope(DEVICE_B, DEVICE_A, 'execution.agents', destination.transport.sent.find((entry) => entry.kind === 'execution.agents')!.payload));
    source.alternativeState = 'provider-unavailable';
    let changeHead = false;
    installFreshCheckpointCapture(source, 'session_retry_a', 'run_session_retry_a', () => changeHead);
    const requestInput = { teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: 'session_retry_a', taskId: 'task_exec',
      agentId: agent!.id, mode: 'provider-failure' as const, content: 'Retry the exact saved recovery intent.', allowUnverifiedTarget: true,
      idempotencyKey: 'fresh-checkpoint-retry' };

    const request = await source.service.requestDelegation(requestInput);
    const wireEnvelope = source.transport.sent.find((entry) => entry.kind === 'execution.request')!;
    const retryBeforeStatus = await source.service.requestDelegation(requestInput);
    expect(retryBeforeStatus).toMatchObject({ id: request.id, digest: request.digest, evidence: { checkpointId: request.evidence.checkpointId } });
    await expect(source.service.requestDelegation({ ...requestInput, content: 'Changed intent with the same key.' })).rejects.toThrow(/different request/i);

    await destination.service.onEnvelope(envelope(DEVICE_A, DEVICE_B, 'execution.request', wireEnvelope.payload));
    await source.service.onEnvelope(envelope(DEVICE_B, DEVICE_A, 'execution.status', {
      requestId: request.id, sharedProjectId: SHARED_PROJECT, state: 'awaiting-approval', runId: null, destinationDeviceId: DEVICE_B, updatedAt: now(),
    }));
    const retryAfterAwaiting = await source.service.requestDelegation(requestInput);
    expect(retryAfterAwaiting).toMatchObject({ id: request.id, state: 'awaiting-approval', digest: request.digest });
    expect(source.transport.sent.filter((entry) => entry.kind === 'execution.request')).toHaveLength(1);

    const dispatched = await destination.service.decide({ requestId: request.id, expectedDigest: request.digest, decision: 'approved', allowProviderSpend: true });
    expect(dispatched).toMatchObject({ state: 'dispatched', runId: 'remote_run_1' });
    await source.service.onEnvelope(envelope(DEVICE_B, DEVICE_A, 'execution.status', {
      requestId: request.id, sharedProjectId: SHARED_PROJECT, state: 'dispatched', runId: dispatched.runId,
      destinationDeviceId: DEVICE_B, updatedAt: now(),
    }));
    expect(await source.service.requestDelegation(requestInput)).toMatchObject({ id: request.id, state: 'dispatched', digest: request.digest });
    expect(destination.runCalls).toHaveLength(1);

    destination.progressListeners[0]!({ runId: dispatched.runId!, kind: 'result', status: 'completed', terminal: true, summary: 'Completed safely.' });
    let completedStatus: { state?: string; runId?: string | null } | undefined;
    for (let attempt = 0; attempt < 20 && !completedStatus; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completedStatus = destination.transport.sent.map((entry) => entry.payload as { state?: string; runId?: string | null })
        .find((payload) => payload.state === 'completed');
    }
    expect(completedStatus).toMatchObject({ state: 'completed', runId: dispatched.runId });
    await source.service.onEnvelope(envelope(DEVICE_B, DEVICE_A, 'execution.status', {
      requestId: request.id, sharedProjectId: SHARED_PROJECT, state: 'completed', runId: dispatched.runId,
      destinationDeviceId: DEVICE_B, updatedAt: now(),
    }));
    const completionRetry = await source.service.requestDelegation(requestInput);
    expect(completionRetry).toMatchObject({ id: request.id, state: 'completed', runId: dispatched.runId, digest: request.digest });
    expect(completionRetry.evidence.checkpointId).toBe(request.evidence.checkpointId);
    expect(destination.runCalls).toHaveLength(1);

    changeHead = true;
    await expect(source.service.requestDelegation(requestInput)).rejects.toThrow(/different request/i);
    expect(destination.runCalls).toHaveLength(1);
  });

  it('lets the destination owner explicitly approve one OpenCode run with unknown quota and completes without shared progress', async () => {
    const source = createFixture({ deviceId: DEVICE_A, peerId: DEVICE_B, ownerId: OWNER_A, projectId: 'project_unknown_a', sessionId: 'session_unknown_a', sessionName: 'Source', provider: 'codex', seedFailure: true });
    const destination = createFixture({ deviceId: DEVICE_B, peerId: DEVICE_A, ownerId: OWNER_B, projectId: 'project_unknown_b', sessionId: 'session_unknown_b', sessionName: 'OpenCode destination', provider: 'opencode' });
    await destination.service.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: 'project_unknown_b' });
    const [agent] = await destination.service.publishAgents({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sessionIds: ['session_unknown_b'] });
    await source.service.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: 'project_unknown_a' });
    await source.service.onEnvelope(envelope(DEVICE_B, DEVICE_A, 'execution.agents', destination.transport.sent.find((entry) => entry.kind === 'execution.agents')!.payload));
    source.alternativeState = 'provider-unavailable';

    const suggestion = await source.service.suggestFallback({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: 'session_unknown_a', taskId: 'task_exec' });
    expect(suggestion.candidates).toEqual([]);
    const request = await source.service.requestDelegation({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: 'session_unknown_a',
      taskId: 'task_exec', agentId: agent!.id, mode: 'provider-failure', content: 'Continue the saved task after inspecting local files.',
      allowUnverifiedTarget: true, idempotencyKey: 'unknown-opencode-run' });
    const requestEnvelope = source.transport.sent.find((entry) => entry.kind === 'execution.request')!;
    await destination.service.onEnvelope(envelope(DEVICE_A, DEVICE_B, 'execution.request', requestEnvelope.payload));

    await expect(destination.service.decide({ requestId: request.id, expectedDigest: '0'.repeat(64), decision: 'approved', allowProviderSpend: true, allowUnverifiedQuota: true }))
      .rejects.toThrow(/displayed request changed/i);
    await expect(destination.service.decide({ requestId: request.id, expectedDigest: request.digest, decision: 'approved', allowProviderSpend: true }))
      .rejects.toThrow(/unknown/i);
    const dispatched = await destination.service.decide({ requestId: request.id, expectedDigest: request.digest, decision: 'approved',
      allowProviderSpend: true, allowUnverifiedQuota: true });
    expect(dispatched.state).toBe('dispatched');
    expect(destination.runCalls).toHaveLength(1);
    expect(destination.runCalls[0]?.content).toContain('provider-enforced dollar ceiling');

    destination.progressListeners[0]!({ runId: 'remote_run_1', kind: 'result', status: 'completed', summary: 'Finished.' });
    await destination.service.close();
    expect(destination.db.prepare('SELECT state FROM mingle_remote_requests WHERE id = ?').get(request.id)).toMatchObject({ state: 'completed' });
    expect(destination.transport.sent.some((entry) => entry.kind === 'execution.status' && (entry.payload as { state?: string }).state === 'completed')).toBe(true);
    expect(destination.transport.sent.some((entry) => entry.kind === 'collaboration.message')).toBe(false);
    expect(destination.db.prepare('SELECT allow_unverified_quota FROM mingle_remote_approvals WHERE request_id = ?').get(request.id))
      .toMatchObject({ allow_unverified_quota: 1 });
  });

  it('keeps grouped session identity visible but never forges a local group delivery', async () => {
    const source = createFixture({ deviceId: DEVICE_A, peerId: DEVICE_B, ownerId: OWNER_A, projectId: 'project_group_a', sessionId: 'session_group_a', sessionName: 'Source', provider: 'codex', seedFailure: true });
    const destination = createFixture({ deviceId: DEVICE_B, peerId: DEVICE_A, ownerId: OWNER_B, projectId: 'project_group_b', sessionId: 'session_group_b', sessionName: 'Grouped worker', provider: 'claude' });
    destination.quota = { state: 'available', observedAt: now() };
    const at = now();
    destination.db.prepare(`INSERT INTO conversation_groups(id,project_id,title,anchor_session_id,mode,max_parallel,max_turns,max_hops,created_at,updated_at)
      VALUES ('local_group','project_group_b','Local group','session_group_b','orchestrated',2,8,4,?,?)`).run(at, at);
    destination.db.prepare(`INSERT INTO group_members(id,group_id,session_id,handle,role,joined_at)
      VALUES ('member_group','local_group','session_group_b','worker','worker',?)`).run(at);
    await destination.service.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: 'project_group_b' });
    const [groupAgent] = await destination.service.publishAgents({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sessionIds: ['session_group_b'] });
    expect(groupAgent?.activeGroupId).toBe('local_group');
    await source.service.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: 'project_group_a' });
    await source.service.onEnvelope(envelope(DEVICE_B, DEVICE_A, 'execution.agents', destination.transport.sent.find((entry) => entry.kind === 'execution.agents')!.payload));
    source.alternativeState = 'quota-exhausted';
    const suggestion = await source.service.suggestFallback({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: 'session_group_a', taskId: 'task_exec' });
    expect(suggestion.candidates).toEqual([]);
    await expect(source.service.requestDelegation({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: 'session_group_a',
      taskId: 'task_exec', agentId: groupAgent!.id, mode: 'provider-failure', content: 'Continue task', maxSpendUsd: 1, idempotencyKey: 'group-request' }))
      .rejects.toThrow(/online remote device|group delivery/i);
    expect(destination.runCalls).toHaveLength(0);
  });

  it('marks a crash after dispatch reservation uncertain and never schedules that request again', async () => {
    const fixture = createFixture({ deviceId: DEVICE_B, peerId: DEVICE_A, ownerId: OWNER_B, projectId: 'project_crash', sessionId: 'session_crash', sessionName: 'Crash', provider: 'claude' });
    const created = now();
    const evidence = { unverifiedAtDestination: true, sourceDeviceId: DEVICE_A, sourceSessionId: 'source_session', sourceRunId: null,
      failureKind: 'human_requested_recovery', failureMessage: null, checkpointId: null, objective: null, taskProgress: [],
      worktree: null, committedReferences: [], notices: [] };
    fixture.db.prepare(`INSERT INTO mingle_remote_requests(id,team_id,shared_project_id,source_device_id,source_owner_id,target_device_id,target_owner_id,
      source_session_id,local_project_id,agent_id,target_session_id,task_id,task_json,content,mode,evidence_json,max_spend_usd,target_config_digest,
      request_digest,state,run_id,idempotency_key,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('crash_req',
      TEAM, SHARED_PROJECT, DEVICE_A, OWNER_A, DEVICE_B, OWNER_B, 'source_session', 'project_crash', 'agent_crash', 'session_crash', 'task_exec', null,
      'prompt', 'unpublished-recovery', JSON.stringify(evidence), 1, 'a'.repeat(64), 'b'.repeat(64), 'dispatched', 'native_run', 'crash-key', created, created);
    await fixture.service.close();
    services = services.filter((service) => service !== fixture.service);
    const restarted = new RemoteExecutionService({ store: { db: fixture.db }, account: makeAccount(OWNER_B), transport: fixture.transport,
      runtime: { start: () => { throw new Error('must not restart'); }, isActive: () => false },
      workspace: { isUnpublishedWork: async () => false, subscribeSession: () => () => undefined },
      providers: { localAlternatives: async () => [], quotaForSession: async () => ({ state: 'unknown', observedAt: null }) }, changed: () => undefined });
    services.push(restarted);
    expect(fixture.db.prepare('SELECT state FROM mingle_remote_requests WHERE id = ?').get('crash_req')).toMatchObject({ state: 'uncertain' });
    await expect(restarted.decide({ requestId: 'crash_req', expectedDigest: 'b'.repeat(64), decision: 'approved', allowProviderSpend: true })).rejects.toThrow(/no longer awaiting/i);
  });
});
