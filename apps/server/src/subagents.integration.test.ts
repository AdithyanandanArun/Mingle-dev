import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLE_CLIENT_SESSION_ID } from './example.ts';
import { startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const boot = async (options: Parameters<typeof startTestApp>[0] = {}) => {
  const app = await startTestApp(options);
  apps.push(app);
  return app;
};

afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

describe('subagent tool-call persistence', () => {
  it('marks a background agent interrupted with an explicit note when the parent run ends first', async () => {
    const app = await boot();
    app.fake.script = async (_options, emit) => {
      emit({ type: 'tool.activity', activity: {
        id: 'background-agent', name: 'Agent', category: 'agent', status: 'running', parentId: null,
        input: JSON.stringify({ description: 'Explore auth', prompt: 'Trace auth', run_in_background: true, sdkResult: { background: true, backgroundTaskId: 'task-async' } }),
      } });
    };
    expect((await app.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`, { content: 'Explore auth' })).status).toBe(202);
    await waitFor(async () => (await app.api('GET', '/api/bootstrap')).json.sessions.find((session: any) => session.id === EXAMPLE_CLIENT_SESSION_ID)?.status === 'idle');
    const call = (await app.api('GET', '/api/bootstrap')).json.toolCalls.find((tool: any) => tool.providerId === 'background-agent');
    expect(call).toMatchObject({ status: 'interrupted' });
    expect(call.output).toContain('Background agent did not report completion before the run ended.');
  });

  it('returns a subagent launch, its assistant text and child calls in bootstrap after reload', async () => {
    const first = await boot({ keepData: true });
    first.fake.script = async (_options, emit) => {
      const input = JSON.stringify({ description: 'Explore auth', subagent_type: 'Explore', model: 'claude-haiku-4-5-20251001', prompt: 'Find the auth flow' });
      emit({ type: 'tool.activity', activity: { id: 'task-1', name: 'Task', category: 'agent', status: 'running', parentId: null, input } });
      emit({ type: 'subagent.text', parentId: 'task-1', messageId: 'child-message', text: 'The auth flow is in sessions.' });
      emit({ type: 'tool.activity', activity: { id: 'child-read', name: 'Read', category: 'file', status: 'completed', parentId: 'task-1', summary: 'Read session source', input: '{"file_path":"src/session.ts"}', output: 'export class SessionService {}' } });
      emit({ type: 'tool.activity', activity: { id: 'task-1', name: 'Task', category: 'agent', status: 'completed', parentId: null, input, output: 'Auth flow located.' } });
    };
    expect((await first.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`, { content: 'Explore auth' })).status).toBe(202);
    await waitFor(async () => (await first.api('GET', '/api/bootstrap')).json.sessions.find((session: any) => session.id === EXAMPLE_CLIENT_SESSION_ID)?.status === 'idle');

    const beforeReload = (await first.api('GET', '/api/bootstrap')).json;
    expect(beforeReload.messages.some((message: any) => message.content === 'The auth flow is in sessions.')).toBe(false);
    const dataDir = first.dataDir;
    await first.app.close();
    apps.pop();

    const second = await boot({ dataDir });
    const bootstrap = (await second.api('GET', '/api/bootstrap')).json;
    const parent = bootstrap.toolCalls.find((call: any) => call.providerId === 'task-1');
    const child = bootstrap.toolCalls.find((call: any) => call.providerId === 'child-read');
    expect(parent).toMatchObject({
      category: 'agent', status: 'completed', output: 'Auth flow located.',
      subagentMessages: [{ id: 'child-message', content: 'The auth flow is in sessions.' }],
    });
    expect(child).toMatchObject({ parentProviderId: 'task-1', name: 'Read', output: 'export class SessionService {}' });
  });
});
