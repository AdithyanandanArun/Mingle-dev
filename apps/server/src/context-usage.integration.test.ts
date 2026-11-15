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
