import { afterEach, describe, expect, it } from 'vitest';
import type { QueuedMessage } from '@mingle/contracts';
import { EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import type { SessionWorkflowHooks } from './session-workflow/hooks.ts';
import { deferred, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

function recorder(t: TestApp, extra: Partial<SessionWorkflowHooks> = {}) {
  const log: string[] = [];
  const snapshots: Array<{ active: boolean; queued: number; status: string }> = [];
  const hooks: SessionWorkflowHooks = {
    prepareStart: (_s, _c, options) => options,
    runBound: () => undefined,
    recordReport: () => undefined,
    runEnded: (info) => { log.push(`ended:${info.runId}:${info.outcome}`); },
    idle: (info) => {
      log.push(`idle:${info.runId}:${info.outcome}`);
      snapshots.push({ active: t.app.runtime.isActive(info.sessionId), queued: t.app.store.listQueuedMessages(info.sessionId).length, status: t.app.store.getSession(info.sessionId)!.status });
    },
    allowQueuedStart: () => true,
    ...extra,
  };
  t.app.runtime.setWorkflowHooks(hooks);
  return { log, snapshots };
}

describe('runtime idle edge', () => {
  it('fires once per run, after cleanup and after the queue-drain attempt has started the next queued message', async () => {
    const t = await startTestApp();
    apps.push(t);
    const { log, snapshots } = recorder(t);
    const gate = deferred<void>();
    t.fake.script = async (o) => { if (t.fake.runs.length === 1) await gate.promise; else if (o.signal.aborted) return; };
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'first' });
    await waitFor(() => t.fake.runs.length === 1, 4000, 'first run');
    t.app.store.enqueueMessage({ id: 'queued-a', sessionId: EXAMPLE_CONTRACT_SESSION_ID, content: 'second', intent: 'normal', skills: [], attachmentIds: [], contextRefs: [] });
    gate.resolve();
    await waitFor(() => log.filter((x) => x.startsWith('idle:')).length === 2, 6000, 'two idle edges');
    const runs = t.app.store.bootstrapRuns().filter((r) => r.sessionId === EXAMPLE_CONTRACT_SESSION_ID);
    expect(log.filter((x) => x.startsWith('idle:'))).toHaveLength(runs.length);
    // runEnded precedes idle for each run, and the first idle edge already sees the queued message started (drain ran first).
    for (const run of runs) expect(log.indexOf(`ended:${run.id}:completed`)).toBeLessThan(log.indexOf(`idle:${run.id}:completed`));
    expect(snapshots[0]).toMatchObject({ active: true, queued: 0 });
    expect(snapshots[1]).toMatchObject({ active: false, queued: 0, status: 'idle' });
  });

  it('waits for a provider that ignores abort to release before the idle edge, and still fires exactly once', async () => {
    const t = await startTestApp();
    apps.push(t);
    const { log, snapshots } = recorder(t);
    const release = deferred<void>();
    t.fake.script = async () => { await release.promise; };
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'stubborn' });
    await waitFor(() => t.fake.runs.length === 1, 4000, 'run');
    t.app.runtime.interrupt(EXAMPLE_CONTRACT_SESSION_ID);
    await waitFor(() => log.some((x) => x.startsWith('ended:')), 4000, 'run ended while cleanup is pending');
    await new Promise((r) => setTimeout(r, 120));
    expect(log.some((x) => x.startsWith('idle:'))).toBe(false);
    expect(t.app.runtime.isActive(EXAMPLE_CONTRACT_SESSION_ID)).toBe(true);
    release.resolve();
    await waitFor(() => log.some((x) => x.startsWith('idle:')), 6000, 'idle after release');
    await new Promise((r) => setTimeout(r, 60));
    expect(log.filter((x) => x.startsWith('idle:'))).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ active: false });
  });

  it('lets the hooks leave a queued item queued while later eligible items still start in order', async () => {
    const t = await startTestApp();
    apps.push(t);
    const blocked = (item: QueuedMessage) => item.content !== 'hold';
    recorder(t, { allowQueuedStart: (_s, item) => blocked(item) });
    const gate = deferred<void>();
    t.fake.script = async () => { if (t.fake.runs.length === 1) await gate.promise; };
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'first' });
    await waitFor(() => t.fake.runs.length === 1, 4000, 'first run');
    for (const [id, content] of [['queued-1', 'hold'], ['queued-2', 'go']] as const) t.app.store.enqueueMessage({ id, sessionId: EXAMPLE_CONTRACT_SESSION_ID, content, intent: 'normal', skills: [], attachmentIds: [], contextRefs: [] });
    gate.resolve();
    await waitFor(() => t.fake.runs.length === 2, 4000, 'eligible item starts');
    expect(t.fake.runs[1]!.prompt).toContain('go');
    await waitFor(() => !t.app.runtime.isActive(EXAMPLE_CONTRACT_SESSION_ID), 4000, 'idle');
    expect(t.app.store.listQueuedMessages(EXAMPLE_CONTRACT_SESSION_ID).map((m) => m.content)).toEqual(['hold']);
  });
});
