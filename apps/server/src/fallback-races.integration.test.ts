import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfiguration, GroupSnapshot, ProviderInfo } from '@mingle/contracts';
import { EXAMPLE_CLIENT_SESSION_ID } from './example.ts';
import { ProviderError, type DispatchAwareOptions } from './providers/common.js';
import { deferred, FakeProviders, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const boot = async (options: Parameters<typeof startTestApp>[0] = {}) => {
  const app = await startTestApp(options);
  apps.push(app);
  return app;
};

afterEach(async () => {
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.cleanup();
});

const codexConfig = {
  provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', policy: 'supervised', serviceTier: 'standard',
} as const satisfies AgentConfiguration;

async function bootWithCodexAndClaude(): Promise<TestApp> {
  const fake = new FakeProviders();
  fake.detectProviders = async () => [
    { id: 'codex', name: 'Codex', available: true, version: 'fake', executable: '/fake/codex', reason: null, policies: ['supervised', 'full-access'], models: [{ id: 'gpt-6.1-sol', name: 'Codex fake', reasoningEfforts: ['low', 'medium', 'high'].map((id) => ({ id, label: id })), defaultReasoningEffort: 'high', policies: ['supervised', 'full-access'] }] },
    { id: 'claude', name: 'Claude', available: true, version: 'fake', executable: '/fake/claude', reason: null, models: [{ id: 'claude-sonnet-5-5', name: 'Claude fake', reasoningEfforts: ['low', 'medium', 'high'].map((id) => ({ id, label: id })), defaultReasoningEffort: 'high' }] },
  ] satisfies ProviderInfo[];
  return boot({ fake });
}

async function createQuotaFallbackGroup(t: TestApp): Promise<{
  initial: GroupSnapshot; source: GroupSnapshot['members'][number]; target: GroupSnapshot['members'][number];
}> {
  await t.api('POST', '/api/providers/refresh', {});
  const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
    sessionId: EXAMPLE_CLIENT_SESSION_ID,
    mode: 'current-leads',
    agent: { handle: 'codex-backup', isolated: true, configuration: codexConfig },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);

  const initial = created.json;
  const source = initial.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
  const target = initial.members.find((member) => member.handle === 'codex-backup')!;
  const configured = await t.api('PATCH', `/api/groups/${initial.group.id}`, {
    recoveryPolicy: {
      automaticFallback: true,
      allowUnverifiedQuotaFallback: true,
      leadFallbackMemberId: target.id,
    },
  });
  expect(configured.status, JSON.stringify(configured.json)).toBe(200);
  return { initial, source, target };
}

function gateFreshQuotaCapture(t: TestApp, sourceSessionId: string) {
  const captureStarted = deferred<void>();
  const captureGate = deferred<void>();
  const captureSettled = deferred<void>();
  const capture = t.app.recovery.capture.bind(t.app.recovery);

  vi.spyOn(t.app.recovery, 'capture').mockImplementation(async (sessionId, reason, runId) => {
    const failure = t.app.recovery.failure(sourceSessionId);
    const isFreshQuotaCapture = sessionId === sourceSessionId
      && !t.app.runtime.isActive(sourceSessionId)
      && failure?.kind === 'quota_exhausted';
    if (!isFreshQuotaCapture) return capture(sessionId, reason, runId);

    captureStarted.resolve();
    try {
      await captureGate.promise;
      return await capture(sessionId, reason, runId);
    } finally {
      captureSettled.resolve();
    }
  });

  return { captureStarted, captureGate, captureSettled };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function failLeadWithTerminalQuota(t: TestApp, sourceSessionId: string, targetSessionId: string, groupId: string): Promise<void> {
  t.fake.script = async (options, emit) => {
    if (options.session.id === sourceSessionId) {
      (options as typeof options & DispatchAwareOptions).onDispatchState?.('dispatched');
      throw new ProviderError('Account quota exhausted.', { providerCode: 'usageLimitExceeded', outcomeKnown: true });
    }
    if (options.session.id === targetSessionId) emit({ type: 'text', text: 'Unexpected fallback run.' });
  };
  const response = await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Continue only after a safe fresh recovery capture.' });
  expect(response.status, JSON.stringify(response.json)).toBe(202);
}

function expectCoordinatorUnchanged(initial: GroupSnapshot, current: GroupSnapshot, sourceId: string): void {
  expect(current.group.mode).toBe('current-leads');
  expect(current.group.anchorSessionId).toBe(initial.group.anchorSessionId);
  expect(current.group.orchestratorMemberId).toBe(sourceId);
  expect(current.group.coordinatorEpoch).toBe(initial.group.coordinatorEpoch);
}

function expectFallbackStillConfigured(current: GroupSnapshot, targetId: string): void {
  expect(current.group.recoveryPolicy).toMatchObject({
    automaticFallback: true,
    allowUnverifiedQuotaFallback: true,
    leadFallbackMemberId: targetId,
  });
}

async function finishCaptureAndFlush(t: TestApp, groupId: string, captureGate: ReturnType<typeof deferred<void>>, captureSettled: Promise<void>): Promise<void> {
  captureGate.resolve();
  await withTimeout(captureSettled, 5000, 'fresh quota recovery capture to finish');
  // Let the scheduler finish its post-capture safety recheck before observing durable state.
  await t.api('GET', `/api/groups/${groupId}`);
}

describe('automatic quota fallback races', () => {
  it('does not hand off after the group is stopped while the fresh source capture is pending', async () => {
    const t = await bootWithCodexAndClaude();
    const { initial, source, target } = await createQuotaFallbackGroup(t);
    const groupId = initial.group.id;
    const capture = gateFreshQuotaCapture(t, source.sessionId);

    try {
      await failLeadWithTerminalQuota(t, source.sessionId, target.sessionId, groupId);
      await withTimeout(capture.captureStarted.promise, 3000, 'automatic fresh quota capture to start');

      const stopped = await t.api('POST', `/api/groups/${groupId}/stop`, {});
      expect(stopped.status, JSON.stringify(stopped.json)).toBe(200);
      expect(stopped.json.group).toMatchObject({ paused: true, pauseReason: expect.stringContaining('Stopped by the user') });

      await finishCaptureAndFlush(t, groupId, capture.captureGate, capture.captureSettled.promise);
      const current = t.app.groups.get(groupId);
      const sourceFailure = current.deliveries.find((delivery) => delivery.memberId === source.id && delivery.status === 'failed');

      expect(current.group.paused).toBe(true);
      expectCoordinatorUnchanged(initial, current, source.id);
      expectFallbackStillConfigured(current, target.id);
      expect(sourceFailure?.recoveredByDeliveryId).toBeUndefined();
      expect(current.deliveries.filter((delivery) => delivery.memberId === target.id)).toHaveLength(0);
      expect(t.fake.runs.filter((run) => run.session.id === target.sessionId)).toHaveLength(0);
    } finally {
      capture.captureGate.resolve();
    }
  });

  it('rechecks target permissions after the fresh source capture and blocks a changed policy', async () => {
    const t = await bootWithCodexAndClaude();
    const { initial, source, target } = await createQuotaFallbackGroup(t);
    const groupId = initial.group.id;
    const capture = gateFreshQuotaCapture(t, source.sessionId);

    try {
      await failLeadWithTerminalQuota(t, source.sessionId, target.sessionId, groupId);
      await withTimeout(capture.captureStarted.promise, 3000, 'automatic fresh quota capture to start');

      const changed = await t.api('PATCH', `/api/sessions/${target.sessionId}`, { policy: 'full-access' });
      expect(changed.status, JSON.stringify(changed.json)).toBe(200);
      expect((await t.api('GET', '/api/bootstrap')).json.sessions.find((session: any) => session.id === target.sessionId).policy).toBe('full-access');

      await finishCaptureAndFlush(t, groupId, capture.captureGate, capture.captureSettled.promise);
      const current = t.app.groups.get(groupId);
      const sourceFailure = current.deliveries.find((delivery) => delivery.memberId === source.id && delivery.status === 'failed');
      const savedTarget = (await t.api('GET', '/api/bootstrap')).json.sessions.find((session: any) => session.id === target.sessionId);

      expectCoordinatorUnchanged(initial, current, source.id);
      expectFallbackStillConfigured(current, target.id);
      expect(current.group.recoveryState?.reason).toMatch(/permission|policy/i);
      expect(sourceFailure?.recoveredByDeliveryId).toBeUndefined();
      expect(current.deliveries.filter((delivery) => delivery.memberId === target.id)).toHaveLength(0);
      expect(t.fake.runs.filter((run) => run.session.id === target.sessionId)).toHaveLength(0);
      expect(savedTarget).toMatchObject({ provider: 'codex', policy: 'full-access' });
    } finally {
      capture.captureGate.resolve();
    }
  });
});
