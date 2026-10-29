import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { deferred, startTestApp, tmpDir, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot(): Promise<TestApp> {
  const dataDir = tmpDir('mingle-shutdown-');
  dirs.push(dataDir);
  const app = await startTestApp({ dataDir, keepData: true });
  apps.push(app);
  return app;
}

async function start(app: TestApp): Promise<void> {
  expect((await app.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'Continue the task.' })).status).toBe(202);
  await waitFor(() => app.fake.runs.length === 1, 5000, 'provider start');
}

describe('run shutdown classification', () => {
  it('records a signal-terminated provider run as interrupted and queues it during shutdown', async () => {
    const app = await boot();
    const entered = deferred<void>();
    app.fake.script = async (options) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('child stopped'), { signal: 'SIGTERM' })), { once: true }));
    };
    await start(app);
    await entered.promise;
    await app.app.runtime.shutdown();
    const run = app.app.store.bootstrapRuns().find((item) => item.sessionId === EXAMPLE_CONTRACT_SESSION_ID)!;
    expect(run.status).toBe('interrupted');
    expect(app.app.store.queuedSessionResumes()).toEqual(expect.arrayContaining([expect.objectContaining({ runId: run.id, reason: 'application-closed' })]));
  });

  it('does not queue a user-initiated stop for resume', async () => {
    const app = await boot();
    const entered = deferred<void>();
    app.fake.script = async (options) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('user stopped')), { once: true }));
    };
    await start(app);
    await entered.promise;
    expect((await app.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/interrupt`)).status).toBe(200);
    await waitFor(() => app.app.runtime.activeCount() === 0, 5000, 'user stop completion');
    expect(app.app.store.bootstrapRuns().find((item) => item.sessionId === EXAMPLE_CONTRACT_SESSION_ID)?.status).toBe('interrupted');
    expect(app.app.store.queuedSessionResumes()).toHaveLength(0);
  });

  it('keeps genuine provider failures failed and out of the resume queue', async () => {
    const app = await boot();
    app.fake.script = async () => { throw new Error('provider rejected the request'); };
    await start(app);
    await waitFor(() => app.app.runtime.activeCount() === 0, 5000, 'provider failure completion');
    expect(app.app.store.bootstrapRuns().find((item) => item.sessionId === EXAMPLE_CONTRACT_SESSION_ID)?.status).toBe('failed');
    expect(app.app.store.queuedSessionResumes()).toHaveLength(0);
  });
});
