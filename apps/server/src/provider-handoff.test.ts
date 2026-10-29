import { afterEach, describe, expect, it } from 'vitest';
import type { Message, ProviderInfo, SessionPlan, Task } from '@mingle/contracts';
import { buildProviderHandoff, PROVIDER_HANDOFF_MAX_CHARS } from './provider-handoff.ts';
import { EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { deferred, FakeProviders, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const boot = async (fake = new FakeProviders()) => { const app = await startTestApp({ fake }); apps.push(app); return app; };
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

const handoffFixture = (messages: Message[], maxChars?: number) => {
  const plan: SessionPlan = {
    id: 'plan_current', sessionId: 'ses_test', runId: 'run_plan', provider: 'codex', providerPlanId: 'native-plan',
    explanation: 'Finish the endpoint before updating client code.',
    steps: [{ id: 'step_api', providerId: null, title: 'Finish API endpoint', description: 'Add pagination support.', acceptanceCriteria: ['Pagination tests pass.'], dependsOn: [], status: 'in_progress' }],
    revision: 2, approvedRevision: null, status: 'review', executionRunId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  };
  const task: Task = {
    id: 'task_open', projectId: 'project', title: 'Finish API tests', description: 'Cover cursor handling.', acceptanceCriteria: 'Tests verify the next page.',
    sessionId: 'ses_test', dependsOn: [], status: 'ready', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  };
  return buildProviderHandoff({
    fromProvider: 'codex', fromModel: 'GPT-6.1', toProvider: 'claude', toModel: 'Sonnet', latestPlan: plan, openTasks: [task],
    changedFiles: ['M src/api.ts'], diffStat: 'src/api.ts | 4 +++-', messages, maxChars,
  });
};

describe('buildProviderHandoff', () => {
  it('includes the current plan and open tasks, redacts secrets, and excludes internal/tool messages', () => {
    const messages: Message[] = [
      { id: 'u1', sessionId: 'ses_test', role: 'user', content: 'Use sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456 carefully.', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'a1', sessionId: 'ses_test', role: 'assistant', content: 'I will finish the API endpoint.', createdAt: '2026-01-01T00:01:00.000Z' },
      { id: 't1', sessionId: 'ses_test', role: 'tool', kind: 'tool', content: 'TOOL OUTPUT SECRET', createdAt: '2026-01-01T00:02:00.000Z' },
      { id: 's1', sessionId: 'ses_test', role: 'system', kind: 'info', content: 'SYSTEM INTERNAL NOISE', createdAt: '2026-01-01T00:03:00.000Z' },
    ];
    const block = handoffFixture(messages);
    expect(block).toContain('Current Mingle plan');
    expect(block).toContain('Finish API endpoint');
    expect(block).toContain('Finish API tests');
    expect(block).toContain('M src/api.ts');
    expect(block).toContain('[redacted]');
    expect(block).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(block).not.toContain('TOOL OUTPUT SECRET');
    expect(block).not.toContain('SYSTEM INTERNAL NOISE');
  });

  it('keeps the newest exchanges while respecting the strict character budget', () => {
    const messages: Message[] = [];
    for (let index = 0; index < 30; index++) {
      messages.push({ id: `u${index}`, sessionId: 'ses_test', role: 'user', content: `Earlier request ${index} ${'x'.repeat(900)}`, createdAt: '' });
      messages.push({ id: `a${index}`, sessionId: 'ses_test', role: 'assistant', content: `Earlier response ${index} ${'y'.repeat(900)}`, createdAt: '' });
    }
    messages.push({ id: 'u-latest', sessionId: 'ses_test', role: 'user', content: 'Most recent request to preserve', createdAt: '' });
    messages.push({ id: 'a-latest', sessionId: 'ses_test', role: 'assistant', content: 'Most recent response to preserve', createdAt: '' });
    const block = handoffFixture(messages);
    expect(block.length).toBeLessThanOrEqual(PROVIDER_HANDOFF_MAX_CHARS);
    expect(block).toContain('Most recent request to preserve');
    expect(block).toContain('Most recent response to preserve');
  });
});

const providers = (): ProviderInfo[] => [
  { id: 'codex', name: 'Codex', available: true, version: 'test', executable: '/fake/codex', reason: null, models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1' }, { id: 'gpt-6.1-fast', name: 'GPT-6.1 Fast' }] },
  { id: 'claude', name: 'Claude', available: true, version: 'test', executable: '/fake/claude', reason: null, models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }, { id: 'claude-opus-5-5', name: 'Opus 5.5' }] },
];

describe('single-session provider switching', () => {
  it('clears native identity and hands prior context to the new provider prompt only', async () => {
    const fake = new FakeProviders();
    fake.detectProviders = async () => providers();
    const t = await boot(fake);
    await t.api('GET', '/api/bootstrap'); // populate provider metadata before configuration validation
    const session = t.app.store.getSession(EXAMPLE_CONTRACT_SESSION_ID)!;
    t.app.store.updateSession(session.id, { providerSessionId: 'native-codex-thread' });
    t.app.store.insertMessage({ sessionId: session.id, role: 'user', content: 'Implement cursor pagination.' });
    t.app.store.insertMessage({ sessionId: session.id, role: 'assistant', content: 'I will update the API and tests.' });

    const switched = await t.api('PATCH', `/api/sessions/${session.id}`, { provider: 'claude', model: 'claude-sonnet-5-5' });
    expect(switched.status).toBe(200);
    expect(switched.json).toMatchObject({ provider: 'claude', providerSessionId: null, handoffFromProvider: 'codex', handoffFromModel: 'gpt-6.1-sol' });
    expect(switched.json.handoffPendingAt).toEqual(expect.any(String));
    const notice = (await t.api('GET', `/api/sessions/${session.id}/messages`)).json.find((message: Message) => message.content.includes('Switched from'));
    expect(notice.content).toContain('No extra model call');

    const sent = await t.api('POST', `/api/sessions/${session.id}/messages`, { content: 'Continue with cursor pagination.' });
    expect(sent.status).toBe(202);
    await waitFor(() => fake.runs.length === 1);
    expect(fake.runs[0]!.prompt).toContain('Mingle context handoff');
    expect(fake.runs[0]!.prompt).toContain('Implement cursor pagination.');
    expect(fake.runs[0]!.prompt).toContain('Continue with cursor pagination.');
    const messages = (await t.api('GET', `/api/sessions/${session.id}/messages`)).json as Message[];
    expect(messages.find((message) => message.role === 'user' && message.content === 'Continue with cursor pagination.')).toBeDefined();
    expect(messages.filter((message) => message.role === 'user').every((message) => !message.content.includes('Mingle context handoff'))).toBe(true);
    expect(t.app.store.getSession(session.id)?.handoffPendingAt).toBeNull();
    const handoffEvent = t.app.store.recentEvents(20).find((event) => event.type === 'session.provider.handoff');
    expect(handoffEvent?.payload).toMatchObject({ fromProvider: 'codex', toProvider: 'claude' });
    expect(handoffEvent?.payload.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(handoffEvent?.payload)).not.toContain('Implement cursor pagination.');
  });

  it('does not create a handoff for a model change within the same provider', async () => {
    const fake = new FakeProviders();
    fake.detectProviders = async () => providers();
    const t = await boot(fake);
    await t.api('GET', '/api/bootstrap');
    const session = t.app.store.getSession(EXAMPLE_CONTRACT_SESSION_ID)!;
    t.app.store.updateSession(session.id, { providerSessionId: 'native-codex-thread' });
    t.app.store.insertMessage({ sessionId: session.id, role: 'user', content: 'Existing history.' });
    const updated = await t.api('PATCH', `/api/sessions/${session.id}`, { model: 'gpt-6.1-fast' });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ model: 'gpt-6.1-fast', providerSessionId: 'native-codex-thread', handoffPendingAt: null });
    expect((await t.api('GET', `/api/sessions/${session.id}/messages`)).json.some((message: Message) => message.content.includes('Switched from'))).toBe(false);
  });

  it('updates the pending source when switching providers more than once before sending', async () => {
    const fake = new FakeProviders();
    fake.detectProviders = async () => providers();
    const t = await boot(fake);
    await t.api('GET', '/api/bootstrap');
    const session = t.app.store.getSession(EXAMPLE_CONTRACT_SESSION_ID)!;
    t.app.store.insertMessage({ sessionId: session.id, role: 'user', content: 'Keep this conversation.' });
    await t.api('PATCH', `/api/sessions/${session.id}`, { provider: 'claude', model: 'claude-sonnet-5-5' });
    const switchedBack = await t.api('PATCH', `/api/sessions/${session.id}`, { provider: 'codex', model: 'gpt-6.1-sol' });
    expect(switchedBack.status).toBe(200);
    expect(switchedBack.json).toMatchObject({ provider: 'codex', handoffFromProvider: 'claude', handoffFromModel: 'claude-sonnet-5-5' });
    expect(switchedBack.json.handoffPendingAt).toEqual(expect.any(String));
  });

  it('keeps the pending marker when adapter setup fails before the provider run starts', async () => {
    const fake = new FakeProviders();
    fake.detectProviders = async () => providers();
    const t = await boot(fake);
    await t.api('GET', '/api/bootstrap');
    const session = t.app.store.getSession(EXAMPLE_CONTRACT_SESSION_ID)!;
    t.app.store.insertMessage({ sessionId: session.id, role: 'user', content: 'Existing message.' });
    await t.api('PATCH', `/api/sessions/${session.id}`, { provider: 'claude', model: 'claude-sonnet-5-5' });
    fake.createAdapter = () => { throw new Error('adapter setup failed'); };
    await t.api('POST', `/api/sessions/${session.id}/messages`, { content: 'Continue.' });
    await waitFor(() => t.app.store.getSession(session.id)?.status === 'error');
    expect(t.app.store.getSession(session.id)).toMatchObject({ handoffFromProvider: 'codex', handoffPendingAt: expect.any(String) });
  });

  it('rejects provider changes while a run is active', async () => {
    const fake = new FakeProviders();
    fake.detectProviders = async () => providers();
    const t = await boot(fake);
    await t.api('GET', '/api/bootstrap');
    const gate = deferred();
    fake.script = async () => { await gate.promise; };
    const sessionId = EXAMPLE_CONTRACT_SESSION_ID;
    await t.api('POST', `/api/sessions/${sessionId}/messages`, { content: 'Wait for me.' });
    await waitFor(() => fake.runs.length === 1);
    const response = await t.api('PATCH', `/api/sessions/${sessionId}`, { provider: 'claude' });
    expect(response.status).toBe(409);
    expect(response.json.error).toMatch(/run to finish/i);
    gate.resolve();
  });
});
