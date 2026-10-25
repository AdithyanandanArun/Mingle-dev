import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db.ts';
import { Store } from '../store.ts';
import {
  RemoteExecutionService,
  type AuthenticatedEnvelope,
  type LocalAlternative,
  type RemoteExecutionAccount,
  type RemoteExecutionProviders,
  type RemoteExecutionRuntime,
  type RemoteExecutionTransport,
  type RemoteExecutionWorkspace,
} from './execution.ts';

const TEAM = 'team-test';
const SHARED_PROJECT = 'shared-project-test';
const OWNER_A = '10000000-0000-4000-8000-000000000001';
const OWNER_B = '10000000-0000-4000-8000-000000000002';
const DEVICE_A = 'device-test-a';
const DEVICE_B = 'device-test-b';
type CloudRow = Record<string, unknown>;
type QueryResult = { data: unknown; error: null };

/** Minimal query adapter for the injected authenticated Supabase client boundary. */
class MemoryQuery implements PromiseLike<QueryResult> {
  private readonly filters: Array<[string, unknown]> = [];
  constructor(private readonly rows: CloudRow[]) {}

  select(_columns: string): this { return this; }
  eq(column: string, value: string): this { this.filters.push([column, value]); return this; }
  is(column: string, value: null): this { this.filters.push([column, value]); return this; }

  private matching(): CloudRow[] {
    return this.rows.filter((row) => this.filters.every(([column, value]) => row[column] === value));
  }

  async maybeSingle(): Promise<QueryResult> {
    const rows = this.matching();
    return { data: rows[0] ?? null, error: null };
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve({ data: this.matching(), error: null }).then(onfulfilled, onrejected);
  }
}

class MemoryCloud {
  readonly tables: Record<string, CloudRow[]> = {
    mingle_members: [
      { team_id: TEAM, user_id: OWNER_A, revoked_at: null },
      { team_id: TEAM, user_id: OWNER_B, revoked_at: null },
    ],
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

  account(userId: string): RemoteExecutionAccount {
    const client = {
      from: (table: string) => ({ select: (_columns: string) => new MemoryQuery(this.tables[table] ?? []) }),
    };
    return {
      async withAuthenticatedClient<T>(work: (client: never, user: { id: string }) => Promise<T>): Promise<T> {
        return work(client as never, { id: userId });
      },
    };
  }
}

interface PendingEnvelope extends AuthenticatedEnvelope { idempotencyKey: string }

/** A two-endpoint delivery queue: services remain real; only the network/mailbox boundary is in memory. */
class MemoryTwoDeviceTransport {
  readonly sent: PendingEnvelope[] = [];
  readonly pending: PendingEnvelope[] = [];
  private readonly handlers = new Map<string, (envelope: AuthenticatedEnvelope) => Promise<void>>();
  private sequence = 0;

  constructor(private readonly devices: Array<{ id: string; ownerId: string; revokedAt: string | null }>) {}

  forDevice(deviceId: string): RemoteExecutionTransport {
    return {
      snapshot: (teamId?: string) => ({
        localDeviceId: deviceId,
        devices: this.devices.filter((device) => !teamId || TEAM === teamId).map((device) => ({
          id: device.id, teamId: TEAM, ownerId: device.ownerId, linked: true,
          revokedAt: device.revokedAt, online: true,
        })),
      }),
      send: async (input) => {
        const existing = this.sent.find((envelope) => envelope.fromDeviceId === deviceId && envelope.toDeviceId === input.toDeviceId && envelope.idempotencyKey === input.idempotencyKey);
        if (existing) {
          if (input.kind === 'execution.request' && JSON.stringify(existing.payload) !== JSON.stringify(input.payload)) {
            throw new Error('Transport idempotency key was reused with a different immutable request payload.');
          }
          return existing;
        }
        const envelope: PendingEnvelope = {
          id: `envelope-${++this.sequence}`, teamId: input.teamId, fromDeviceId: deviceId,
          toDeviceId: input.toDeviceId, kind: input.kind, payload: structuredClone(input.payload), idempotencyKey: input.idempotencyKey,
        };
        this.sent.push(envelope);
        this.pending.push(envelope);
        return envelope;
      },
      onMessage: (handler) => {
        this.handlers.set(deviceId, handler);
        return () => { if (this.handlers.get(deviceId) === handler) this.handlers.delete(deviceId); };
      },
    };
  }

  async deliver(envelope: PendingEnvelope): Promise<void> {
    const handler = this.handlers.get(envelope.toDeviceId);
    if (!handler) throw new Error(`No test receiver is registered for ${envelope.toDeviceId}`);
    await handler(envelope);
  }

  async deliverAll(): Promise<void> {
    while (this.pending.length) await this.deliver(this.pending.shift()!);
  }

  revoke(deviceId: string): void {
    const device = this.devices.find((item) => item.id === deviceId);
    if (device) device.revokedAt = new Date().toISOString();
    const cloudDevice = (this.cloud?.tables.mingle_devices ?? []).find((item) => item.id === deviceId);
    if (cloudDevice) cloudDevice.revoked_at = device?.revokedAt ?? new Date().toISOString();
  }

  cloud?: MemoryCloud;
}

interface DeviceFixture {
  ownerId: string;
  deviceId: string;
  projectId: string;
  sessionId: string;
  store: Store;
}

function localDevice(ownerId: string, deviceId: string, suffix: string): DeviceFixture {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  const projectId = `local-project-${suffix}`;
  const sessionId = `local-session-${suffix}`;
  store.insertProject({ id: projectId, name: `Local ${suffix}`, path: `/test/${suffix}` });
  store.insertSession({
    id: sessionId, projectId, name: `Provider ${suffix}`, provider: suffix === 'a' ? 'codex' : 'claude',
    model: suffix === 'a' ? 'codex-test-model' : 'claude-test-model', effort: 'high', policy: 'supervised',
    isolated: false, worktreePath: `/test/${suffix}`, branch: 'main',
  });
  return { ownerId, deviceId, projectId, sessionId, store };
}

function recordSafeProviderFailure(source: DeviceFixture): string {
  const now = new Date().toISOString();
  const task = source.store.insertTask({
    projectId: source.projectId, title: 'Continue local work', description: 'A recovery test task',
    acceptanceCriteria: 'Do not dispatch automatically', sessionId: source.sessionId, dependsOn: [], status: 'ready',
  });
  const userMessage = source.store.insertMessage({ sessionId: source.sessionId, role: 'user', content: 'Test the recovery path' });
  const runId = `failed-run-${source.deviceId}`;
  source.store.insertRun({
    id: runId, sessionId: source.sessionId, userMessageId: userMessage.id, provider: 'codex', model: 'codex-test-model', startedAt: now,
  });
  source.store.finishRun(runId, 'failed', 1, now);
  source.store.insertProviderFailure(source.sessionId, runId, {
    id: `failure-${source.deviceId}`, sessionId: source.sessionId, runId, actor: 'session', kind: 'provider_unavailable',
    provider: 'codex', retryable: false, dispatchState: 'not-dispatched', continuationSafety: 'safe',
    message: 'Injected unavailable provider; no provider was contacted by this test.', occurredAt: now,
  }, now);
  source.store.insertRecoveryCheckpoint({
    id: `checkpoint-${source.deviceId}`, version: 1, sessionId: source.sessionId, runId,
    reason: 'integration test', capturedAt: now, objective: 'Continue local work',
    tasks: [{ id: task.id, title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria, status: task.status }],
    worktree: { path: `/test/${source.ownerId}`, branch: 'main', head: 'a'.repeat(40), dirtyPaths: [], dirtyPathsTruncated: false, isRepository: true, statusKnown: true },
    artifacts: [], pendingApprovals: [], errors: [], uncertainTools: [], notices: [],
  });
  return task.id;
}

function runtime() {
  const starts: Array<{ sessionId: string; content: string }> = [];
  const implementation: RemoteExecutionRuntime = {
    start(sessionId, content) { starts.push({ sessionId, content }); return `local-run-${starts.length}`; },
    isActive: () => false,
  };
  return { starts, implementation };
}

const workspace: RemoteExecutionWorkspace = {
  isUnpublishedWork: async () => true,
  subscribeSession: () => () => undefined,
};

function providers(alternatives: LocalAlternative[] = []): RemoteExecutionProviders {
  return {
    localAlternatives: async () => alternatives,
    quotaForSession: async () => ({ state: 'available', observedAt: new Date().toISOString(), reason: 'injected test observation' }),
  };
}

describe('distributed two-device execution integration', () => {
  let fixture: {
    source: DeviceFixture; destination: DeviceFixture; cloud: MemoryCloud; bus: MemoryTwoDeviceTransport;
    sourceService: RemoteExecutionService; destinationService: RemoteExecutionService;
    sourceRuntime: ReturnType<typeof runtime>; destinationRuntime: ReturnType<typeof runtime>;
    destinationProviders: RemoteExecutionProviders;
  } | undefined;

  afterEach(async () => {
    if (!fixture) return;
    await fixture.sourceService.close();
    await fixture.destinationService.close();
    fixture.source.store.close();
    fixture.destination.store.close();
    fixture = undefined;
  });

  it('shares messages with verified attribution, keeps dispatch local-first, and consumes an owner-local approval once', async () => {
    const source = localDevice(OWNER_A, DEVICE_A, 'a');
    const destination = localDevice(OWNER_B, DEVICE_B, 'b');
    const cloud = new MemoryCloud();
    const bus = new MemoryTwoDeviceTransport([
      { id: DEVICE_A, ownerId: OWNER_A, revokedAt: null },
      { id: DEVICE_B, ownerId: OWNER_B, revokedAt: null },
    ]);
    bus.cloud = cloud;
    const sourceRuntime = runtime();
    const destinationRuntime = runtime();
    const alternatives: LocalAlternative[] = [{
      sessionId: 'local-alternative', provider: 'claude', model: 'claude-test-model', eligible: true, state: 'available',
    }];
    const destinationProviders = providers();
    const sourceService = new RemoteExecutionService({
      store: source.store, account: cloud.account(OWNER_A), transport: bus.forDevice(DEVICE_A),
      runtime: sourceRuntime.implementation, workspace, providers: providers(), changed: () => undefined,
    });
    let destinationService = new RemoteExecutionService({
      store: destination.store, account: cloud.account(OWNER_B), transport: bus.forDevice(DEVICE_B),
      runtime: destinationRuntime.implementation, workspace, providers: destinationProviders, changed: () => undefined,
    });
    fixture = { source, destination, cloud, bus, sourceService, destinationService, sourceRuntime, destinationRuntime, destinationProviders };

    await sourceService.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: source.projectId });
    await destinationService.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: destination.projectId });

    const outbound = await sourceService.sendMessage({
      teamId: TEAM, sharedProjectId: SHARED_PROJECT, content: 'Shared conversation from device A', idempotencyKey: 'shared-message-1',
    });
    await bus.deliverAll();
    const messageEnvelope = bus.sent.find((envelope) => envelope.kind === 'collaboration.message')!;
    await bus.deliver(messageEnvelope); // same durable envelope is delivered again after a reconnect
    const snapshotAfterDuplicate = await destinationService.snapshot(TEAM);
    expect(snapshotAfterDuplicate.messages.filter((message) => message.id === outbound.id)).toHaveLength(1);
    expect(snapshotAfterDuplicate.messages[0]).toMatchObject({ deviceId: DEVICE_A, ownerId: OWNER_A, content: 'Shared conversation from device A' });

    const forgedEnvelope: AuthenticatedEnvelope = {
      ...messageEnvelope, id: 'forged-owner-envelope',
      payload: { ...(messageEnvelope.payload as Record<string, unknown>), ownerId: OWNER_B },
    };
    await expect(destinationService.onEnvelope(forgedEnvelope)).rejects.toThrow(/attribution/i);
    expect((await destinationService.snapshot(TEAM)).messages).toHaveLength(1);

    await expect(sourceService.requestDelegation({
      teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: source.sessionId,
      taskId: 'task-does-not-exist', agentId: 'not-published', mode: 'provider-failure',
      content: 'routine work must remain local', idempotencyKey: 'ineligible-request',
    })).rejects.toThrow(/recovery|failure|task/i);
    expect(bus.sent.filter((envelope) => envelope.kind === 'execution.request')).toHaveLength(0);
    expect(sourceRuntime.starts).toHaveLength(0);

    destination.store.db.prepare("UPDATE sessions SET policy = 'full-access' WHERE id = ?").run(destination.sessionId);
    const [agent] = await destinationService.publishAgents({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sessionIds: [destination.sessionId] });
    await bus.deliverAll();
    expect(agent).toBeDefined();
    expect(agent?.policy).toBe('full-access');
    expect((await sourceService.snapshot(TEAM)).agents.some((item) => item.id === agent!.id && item.ownerId === OWNER_B)).toBe(true);

    const taskId = recordSafeProviderFailure(source);
    const sourceProviders = providers(alternatives);
    // The service instance is intentionally configured with static dependencies; this fresh instance represents
    // the same device process after durable local failure evidence has been recorded.
    await sourceService.close();
    let refreshedCheckpoint = 0;
    const sourceWorkspace: RemoteExecutionWorkspace = {
      ...workspace,
      captureCheckpoint: async (sessionId, _reason, runId) => {
        if (!runId) throw new Error('Expected a failed source run checkpoint.');
        const row = source.store.db.prepare(`SELECT id, checkpoint_json FROM session_checkpoints WHERE session_id = ? AND run_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sessionId, runId) as { id: string; checkpoint_json: string } | undefined;
        if (!row) throw new Error('Missing integration checkpoint.');
        const checkpoint = JSON.parse(row.checkpoint_json) as { id: string; capturedAt: string };
        checkpoint.id = `checkpoint-refresh-${++refreshedCheckpoint}`;
        checkpoint.capturedAt = new Date().toISOString();
        source.store.db.prepare('UPDATE session_checkpoints SET id = ?, checkpoint_json = ?, created_at = ? WHERE id = ?')
          .run(checkpoint.id, JSON.stringify(checkpoint), checkpoint.capturedAt, row.id);
      },
    };
    const sourceServiceWithFailure = new RemoteExecutionService({
      store: source.store, account: cloud.account(OWNER_A), transport: bus.forDevice(DEVICE_A),
      runtime: sourceRuntime.implementation, workspace: sourceWorkspace, providers: sourceProviders, changed: () => undefined,
    });
    fixture.sourceService = sourceServiceWithFailure;

    const requestInput = {
      teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: source.sessionId, taskId,
      agentId: agent!.id, mode: 'provider-failure', content: 'Continue this explicit recovery task',
      idempotencyKey: 'eligible-provider-failure',
    } as const;
    await expect(sourceServiceWithFailure.requestDelegation(requestInput)).rejects.toThrow(/local alternative/i);
    expect(bus.sent.filter((envelope) => envelope.kind === 'execution.request')).toHaveLength(0);
    alternatives[0]!.state = 'provider-unavailable';
    const request = await sourceServiceWithFailure.requestDelegation(requestInput);
    expect(request.maxSpendUsd).toBeNull();
    expect(request.allowUnverifiedTarget).toBe(false);
    const requestEnvelope = bus.sent.find((envelope) => envelope.kind === 'execution.request')!;
    await bus.deliverAll();
    await bus.forDevice(DEVICE_B).send({ teamId: TEAM, toDeviceId: DEVICE_A, kind: 'execution.status',
      payload: { requestId: request.id, sharedProjectId: SHARED_PROJECT, state: 'awaiting-approval', runId: null,
        destinationDeviceId: DEVICE_B, updatedAt: new Date().toISOString() }, idempotencyKey: `status:${request.id}:awaiting-approval` });
    await bus.deliverAll();
    const sameRequest = await sourceServiceWithFailure.requestDelegation(requestInput);
    expect(sameRequest).toMatchObject({ id: request.id, digest: request.digest, state: 'awaiting-approval' });
    expect(sameRequest.evidence.checkpointId).toBe(request.evidence.checkpointId);
    await bus.deliverAll();
    expect((await destinationService.snapshot(TEAM)).requests.find((item) => item.id === request.id)?.state).toBe('awaiting-approval');
    await expect(destinationService.onEnvelope({
      ...requestEnvelope, id: 'peer-forged-approval', kind: 'execution.approval',
      payload: { requestId: request.id, decision: 'approved', digest: request.digest },
    })).rejects.toThrow(/owner-local|never accepted/i);

    await expect(sourceServiceWithFailure.decide({
      requestId: request.id, expectedDigest: request.digest, decision: 'approved', allowProviderSpend: true,
      allowUnverifiedQuota: false, shareProgress: false,
    })).rejects.toThrow(/destination|owner|device/i);
    expect(destinationRuntime.starts).toHaveLength(0);

    const changedPayload: Record<string, unknown> = { ...(requestEnvelope.payload as Record<string, unknown>), content: 'mutated after approval request' };
    await expect(destinationService.onEnvelope({ ...requestEnvelope, id: 'mutated-request-envelope', payload: changedPayload })).rejects.toThrow(/digest/i);

    await expect(destinationService.decide({
      requestId: request.id, expectedDigest: request.digest, decision: 'approved', allowProviderSpend: false,
      allowUnverifiedQuota: false, shareProgress: false,
    })).rejects.toThrow(/spend|consent/i);
    expect(destinationRuntime.starts).toHaveLength(0);

    const decided = await destinationService.decide({
      requestId: request.id, expectedDigest: request.digest, decision: 'approved', allowProviderSpend: true,
      allowUnverifiedQuota: false, shareProgress: false,
    });
    expect(decided.state).toBe('dispatched');
    expect(destinationRuntime.starts).toHaveLength(1);
    expect(destinationRuntime.starts[0]?.sessionId).toBe(destination.sessionId);
    expect((await destinationService.snapshot(TEAM)).approvals[0]).toMatchObject({
      allowProviderSpend: true, allowUnverifiedQuota: false, decision: 'approved',
    });
    await expect(destinationService.decide({
      requestId: request.id, expectedDigest: request.digest, decision: 'approved', allowProviderSpend: true,
      allowUnverifiedQuota: false, shareProgress: false,
    })).rejects.toThrow(/no longer|one-time|decision/i);
    await bus.deliverAll();

    const dispatchedAudit = destination.store.db.prepare(`
      select type, summary, payload from mingle_remote_events where type = 'execution.dispatched'
    `).all() as Array<{ type: string; summary: string; payload: string }>;
    expect(dispatchedAudit).toHaveLength(1);
    expect(JSON.stringify(dispatchedAudit)).not.toContain('Continue this explicit recovery task');

    // A durable inbox receipt and request decision survive a service restart; redelivery cannot start again.
    await destinationService.close();
    destinationService = new RemoteExecutionService({
      store: destination.store, account: cloud.account(OWNER_B), transport: bus.forDevice(DEVICE_B),
      runtime: destinationRuntime.implementation, workspace, providers: destinationProviders, changed: () => undefined,
    });
    fixture.destinationService = destinationService;
    expect((await destinationService.snapshot(TEAM)).requests.find((item) => item.id === request.id)?.state).toBe('uncertain');
    await destinationService.onEnvelope(requestEnvelope);
    expect(destinationRuntime.starts).toHaveLength(1);

    const sourceMembership = cloud.tables.mingle_members!.find((row) => row.user_id === OWNER_A)!;
    sourceMembership.revoked_at = new Date().toISOString();
    await expect(destinationService.onEnvelope({ ...messageEnvelope, id: 'revoked-member-envelope', payload: { ...(messageEnvelope.payload as Record<string, unknown>), id: 'revoked-member-message' } })).rejects.toThrow(/active member/i);
    sourceMembership.revoked_at = null;
    bus.revoke(DEVICE_A);
    const afterRevocation: AuthenticatedEnvelope = {
      ...messageEnvelope, id: 'envelope-after-revocation',
      payload: { ...(messageEnvelope.payload as Record<string, unknown>), id: 'message-after-revocation' },
    };
    await expect(destinationService.onEnvelope(afterRevocation)).rejects.toThrow(/active|revoked|linked|device/i);
    expect((await destinationService.snapshot(TEAM)).messages).toHaveLength(1);
  });

  it('keeps unknown remote quota out of suggestions and requires destination opt-in for an explicit recovery', async () => {
    const source = localDevice(OWNER_A, DEVICE_A, 'quota-source');
    const destination = localDevice(OWNER_B, DEVICE_B, 'quota-destination');
    const cloud = new MemoryCloud();
    const bus = new MemoryTwoDeviceTransport([
      { id: DEVICE_A, ownerId: OWNER_A, revokedAt: null },
      { id: DEVICE_B, ownerId: OWNER_B, revokedAt: null },
    ]);
    bus.cloud = cloud;
    const sourceRuntime = runtime();
    const destinationRuntime = runtime();
    const destinationProviders: RemoteExecutionProviders = {
      localAlternatives: async () => [],
      quotaForSession: async () => ({ state: 'unknown', observedAt: null, reason: 'No native quota report is available.' }),
    };
    const sourceService = new RemoteExecutionService({
      store: source.store, account: cloud.account(OWNER_A), transport: bus.forDevice(DEVICE_A),
      runtime: sourceRuntime.implementation, workspace, providers: providers(), changed: () => undefined,
    });
    const destinationService = new RemoteExecutionService({
      store: destination.store, account: cloud.account(OWNER_B), transport: bus.forDevice(DEVICE_B),
      runtime: destinationRuntime.implementation, workspace, providers: destinationProviders, changed: () => undefined,
    });
    fixture = { source, destination, cloud, bus, sourceService, destinationService, sourceRuntime, destinationRuntime, destinationProviders };

    await sourceService.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: source.projectId });
    await destinationService.bindProject({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, localProjectId: destination.projectId });
    const taskId = recordSafeProviderFailure(source);
    const [agent] = await destinationService.publishAgents({ teamId: TEAM, sharedProjectId: SHARED_PROJECT, sessionIds: [destination.sessionId] });
    await bus.deliverAll();
    expect(agent).toMatchObject({ quotaKnown: false, quotaState: 'unknown' });

    const suggestion = await sourceService.suggestFallback({
      teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: source.sessionId, taskId,
    });
    expect(suggestion.candidates.some((candidate) => candidate.id === agent!.id)).toBe(false);
    await expect(sourceService.requestDelegation({
      teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: source.sessionId, taskId, agentId: agent!.id,
      mode: 'provider-failure', content: 'Unknown quota must not become a fallback suggestion.', idempotencyKey: 'unknown-auto-fallback',
    })).rejects.toThrow(/quota|available/i);
    expect(bus.sent.filter((envelope) => envelope.kind === 'execution.request')).toHaveLength(0);

    const request = await sourceService.requestDelegation({
      teamId: TEAM, sharedProjectId: SHARED_PROJECT, sourceSessionId: source.sessionId, taskId, agentId: agent!.id,
      mode: 'unpublished-recovery', content: 'Explicitly continue this unpublished task on the destination.',
      allowUnverifiedTarget: true, idempotencyKey: 'unknown-explicit-recovery',
    });
    expect(request.maxSpendUsd).toBeNull();
    expect(request.allowUnverifiedTarget).toBe(true);
    await bus.deliverAll();
    const noQuotaConsent = {
      requestId: request.id, expectedDigest: request.digest, decision: 'approved' as const,
      allowProviderSpend: true, allowUnverifiedQuota: false, shareProgress: false,
    };
    await expect(destinationService.decide(noQuotaConsent)).rejects.toThrow(/unknown|unverified|quota/i);
    expect(destinationRuntime.starts).toHaveLength(0);

    const approved = await destinationService.decide({ ...noQuotaConsent, allowUnverifiedQuota: true });
    expect(approved.state).toBe('dispatched');
    expect(destinationRuntime.starts).toHaveLength(1);
    expect(destinationRuntime.starts[0]?.sessionId).toBe(destination.sessionId);
    expect((await destinationService.snapshot(TEAM)).approvals[0]).toMatchObject({
      allowProviderSpend: true, allowUnverifiedQuota: true, decision: 'approved',
    });
  });
});
