import { afterEach, expect, it } from 'vitest';
import type { ContextCompactionResult, RunOptions, Session } from '@mingle/contracts';
import { EXAMPLE_CONTRACT_SESSION_ID as sessionId } from './example.ts';
import { abortError, markDispatched } from './providers/common.ts';
import { deferred, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const path = `/api/sessions/${sessionId}`;
const apps: TestApp[] = [];
const boot = async (options: Parameters<typeof startTestApp>[0] = {}) => {
  const app = await startTestApp(options);
  apps.push(app);
  return app;
};
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

const report = (usedTokens: number, contextWindow: number | null = 1000) =>
  ({ type: 'context.usage' as const, usedTokens, contextWindow, estimated: false, source: 'Example' });
const stopped = (signal: AbortSignal) => signal.aborted
  ? Promise.reject(abortError())
  : new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }));

function installCompact(t: TestApp, compact: (options: { session: Session; signal: AbortSignal }) => Promise<ContextCompactionResult>) {
  const original = t.fake.createAdapter.bind(t.fake);
  t.fake.createAdapter = provider => ({ ...original(provider), compact });
}

function compactOutcome(session: Session, status: ContextCompactionResult['status'] = 'completed'): ContextCompactionResult {
  return { sessionId: session.id, provider: session.provider, status, message: 'Example compaction', error: null,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), checkpointId: null };
}

async function configure(t: TestApp, percent: number | null) {
  expect(await t.api('PATCH', `${path}/auto-compaction`, { percent })).toMatchObject({ status: 200, json: { autoCompactionPercent: percent } });
}

async function start(t: TestApp) {
  expect((await t.api('POST', `${path}/messages`, { content: 'Finish the Example task' })).status).toBe(202);
}

it('validates the session threshold and persists it across restarts', async () => {
  const t = await boot({ keepData: true });
  for (const percent of [0, 101, 19.5, '80']) {
    expect((await t.api('PATCH', `${path}/auto-compaction`, { percent })).status).toBe(400);
  }
  await configure(t, 80);
  await t.app.close();
  const reopened = await boot({ dataDir: t.dataDir });
  expect((await reopened.api('GET', `${path}/snapshot`)).json.session.autoCompactionPercent).toBe(80);
  await configure(reopened, null);
});

it('pauses at the threshold, holds the session slot, and resumes exactly once in the same conversation', async () => {
  const t = await boot();
  await configure(t, 80);
  const compactEntered = deferred();
  const releaseCompact = deferred();
  let attempts = 0;
  installCompact(t, async ({ session }) => {
    attempts++;
    expect(session.providerSessionId).toBe('native-example');
    compactEntered.resolve();
    await releaseCompact.promise;
    return compactOutcome(session);
  });
  t.fake.script = async (options, emit) => {
    markDispatched(options);
    if (t.fake.runs.length === 1) {
      emit({ type: 'session', providerSessionId: 'native-example' });
      emit({ type: 'usage', inputTokens: 40, outputTokens: 10, costUsd: null });
      emit(report(800));
      await stopped(options.signal);
    } else {
      expect(options.session.providerSessionId).toBe('native-example');
      expect(options.prompt).toContain('Continue the request already in this conversation');
      expect(options.signal.aborted).toBe(false);
      emit(report(805));
      emit({ type: 'usage', inputTokens: 12, outputTokens: 3, costUsd: null });
      emit({ type: 'text', text: 'Example work continued.' });
    }
  };
  await start(t);
  try {
    await compactEntered.promise;
    expect(t.fake.runs).toHaveLength(1);
    expect(t.app.runtime.activeCount()).toBe(1);
    expect((await t.api('POST', `${path}/compact`, {})).status).toBe(409);
  } finally {
    releaseCompact.resolve();
  }
  await waitFor(() => !t.app.runtime.isActive(sessionId));
  expect(attempts).toBe(1);
  expect(t.fake.runs).toHaveLength(2);
  expect(t.app.store.getSession(sessionId)).toMatchObject({ status: 'idle', inputTokens: 52, outputTokens: 13 });
  const snapshot = (await t.api('GET', `${path}/snapshot`)).json;
  expect(snapshot.runs).toHaveLength(1);
  expect(snapshot.runs[0].status).toBe('completed');
  expect(snapshot.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(1);
});

it.each(['below', 'unknown', 'before dispatch', 'invalid', 'disabled'])('does not pause on %s occupancy', async scenario => {
  const t = await boot();
  await configure(t, scenario === 'disabled' ? null : 80);
  let called = false;
  installCompact(t, async ({ session }) => { called = true; return compactOutcome(session); });
  t.fake.script = async (options, emit) => {
    if (scenario !== 'before dispatch') markDispatched(options);
    emit({ type: 'session', providerSessionId: 'example' });
    emit(scenario === 'unknown' ? report(1000, null) : report(scenario === 'below' ? 799 : scenario === 'invalid' ? 800.25 : 800));
    expect(options.signal.aborted).toBe(false);
  };
  await start(t);
  await waitFor(() => !t.app.runtime.isActive(sessionId));
  expect(called).toBe(false);
  expect(t.app.store.getSession(sessionId)?.status).toBe('idle');
});

it.each(['failed', 'unsupported', 'cancelled'] as const)('does not resume after %s automatic compaction', async reason => {
  const t = await boot();
  await configure(t, 75);
  const compactEntered = deferred();
  installCompact(t, async ({ session, signal }) => {
    compactEntered.resolve();
    if (reason === 'cancelled') return stopped(signal);
    return compactOutcome(session, reason);
  });
  t.fake.script = async (options: RunOptions, emit) => {
    markDispatched(options);
    emit({ type: 'session', providerSessionId: 'example' });
    emit(report(750));
    await stopped(options.signal);
  };
  await start(t);
  await compactEntered.promise;
  if (reason === 'cancelled') expect((await t.api('POST', `${path}/interrupt`, {})).status).toBe(200);
  await waitFor(() => !t.app.runtime.isActive(sessionId));
  expect(t.fake.runs).toHaveLength(1);
  expect(t.app.store.getSession(sessionId)?.status).toBe(reason === 'cancelled' ? 'interrupted' : 'error');
});
