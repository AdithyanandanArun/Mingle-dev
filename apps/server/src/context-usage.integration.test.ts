import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const boot = async (options: Parameters<typeof startTestApp>[0] = {}) => {
  const app = await startTestApp(options);
  apps.push(app);
  return app;
};
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

const getSession = async (t: TestApp, id = EXAMPLE_CONTRACT_SESSION_ID) =>
  (await t.api('GET', '/api/bootstrap')).json.sessions.find((session: any) => session.id === id);
const send = async (t: TestApp, emit: (event: any) => void) => {
  t.fake.script = async (_options, onEvent) => {
    emit(onEvent);
  };
  await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'Inspect context' });
  await waitFor(async () => (await getSession(t)).status === 'idle' && t.app.runtime.activeCount() === 0);
};

describe('provider context usage', () => {
  it('clears a context reading only after successful manual native compaction', async () => {
    const t = await boot();
    const id = EXAMPLE_CONTRACT_SESSION_ID;
    t.app.store.updateSession(id, { providerSessionId: 'native-manual' });
    const s = t.app.store.getSession(id)!;
    const usage = { provider: s.provider, model: s.model, providerSessionId: s.providerSessionId, usedTokens: 900, contextWindow: 1000, estimated: true, source: 'provider', updatedAt: new Date().toISOString() };
    t.app.store.setContextUsage(id, usage);
    const original = t.fake.createAdapter.bind(t.fake);
    let status: 'completed' | 'failed' = 'failed';
    t.fake.createAdapter = provider => ({ ...original(provider), compact: async ({ session }) => ({ sessionId: session.id, provider: session.provider, status, message: 'Example compact outcome', error: status === 'failed' ? 'Example failure' : null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), checkpointId: null }) });
    expect((await t.api('POST', `/api/sessions/${id}/compact`, {})).json.status).toBe('failed');
    expect(t.app.store.getSession(id)?.contextUsage?.usedTokens).toBe(900);
    status = 'completed';
    expect((await t.api('POST', `/api/sessions/${id}/compact`, {})).json.status).toBe('completed');
    expect(t.app.store.getSession(id)?.contextUsage).toBeUndefined();
  });
  it('invalidates occupancy after automatic compaction without inventing an empty context', async () => {
    const t = await boot();
    await send(t, emit => {
      emit({ type: 'session', providerSessionId: 'native-auto-compact' });
      emit({ type: 'context.usage', usedTokens: 950, contextWindow: 1000, estimated: true, source: 'provider' });
      emit({ type: 'context.reset' });
    });
    expect(await getSession(t)).not.toHaveProperty('contextUsage');
    const snapshot = await t.api('GET', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/snapshot`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.json.session).not.toHaveProperty('contextUsage');
    expect(t.app.store.getSession(EXAMPLE_CONTRACT_SESSION_ID)?.contextUsage).toBeUndefined();
  });
  it('stores native context usage separately from cumulative totals and exposes it in snapshots', async () => {
    const t = await boot();
    await send(t, emit => {
      emit({ type: 'session', providerSessionId: 'native-context-1' });
      emit({ type: 'usage', inputTokens: 12, outputTokens: 5, costUsd: null });
      emit({ type: 'context.usage', usedTokens: 321, contextWindow: 1000, estimated: false, source: 'provider' });
    });
    const s = await getSession(t);
    expect(s.inputTokens).toBe(12);
    expect(s.outputTokens).toBe(5);
    expect(s.contextUsage).toMatchObject({ usedTokens: 321, contextWindow: 1000, estimated: false, source: 'provider', providerSessionId: 'native-context-1' });
    expect((await t.api('GET', '/api/bootstrap')).json.sessions.find((x: any) => x.id === s.id).contextUsage).toEqual(s.contextUsage);
    expect((await t.api('GET', `/api/sessions/${s.id}/snapshot`)).json.session.contextUsage).toEqual(s.contextUsage);
  });
  it('retains the latest reported context across a local server restart', async () => {
    const t = await boot({ keepData: true });
    await send(t, emit => {
      emit({ type: 'session', providerSessionId: 'native-restarted' });
      emit({ type: 'context.usage', usedTokens: 701, contextWindow: 1000, estimated: true, source: 'example' });
    });
    await t.app.close();
    const reopened = await boot({ dataDir: t.dataDir, detectOnStart: false });
    expect((await getSession(reopened)).contextUsage).toMatchObject({ usedTokens: 701, providerSessionId: 'native-restarted' });
  });

  it('leaves context usage absent when the provider reports no native reading', async () => {
    const t = await boot();
    await send(t, emit => emit({ type: 'session', providerSessionId: 'native-no-usage' }));
    expect(await getSession(t)).not.toHaveProperty('contextUsage');
  });

  it('ignores malformed context readings without replacing the last good value', async () => {
    const t = await boot();
    await send(t, emit => {
      emit({ type: 'session', providerSessionId: 'native-valid' });
      emit({ type: 'context.usage', usedTokens: 321, contextWindow: 1000, estimated: false, source: 'provider' });
      emit({ type: 'context.usage', usedTokens: -1, contextWindow: 1000, estimated: false, source: 'broken' });
    });
    expect((await getSession(t)).contextUsage).toMatchObject({ usedTokens: 321, source: 'provider' });
  });

  it('does not resurrect readings from an earlier model or native identity', async () => {
    const t = await boot();
    await send(t, emit => {
      emit({ type: 'session', providerSessionId: 'native-identity-a' });
      emit({ type: 'context.usage', usedTokens: 321, contextWindow: 1000, estimated: false, source: 'provider' });
    });
    const id = EXAMPLE_CONTRACT_SESSION_ID;
    expect((await t.api('PATCH', `/api/sessions/${id}`, { model: 'claude-sonnet-5-5' })).status).toBe(200);
    expect(await getSession(t)).not.toHaveProperty('contextUsage');
    expect((await t.api('PATCH', `/api/sessions/${id}`, { model: 'gpt-6.1-sol' })).status).toBe(200);
    expect(await getSession(t)).not.toHaveProperty('contextUsage');
  });
});
