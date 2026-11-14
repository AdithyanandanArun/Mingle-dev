import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ProgressMcpConnection, RunOptions } from '@mingle/contracts';
import { EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { deferred, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const clients: Client[] = [];
const gates: Array<ReturnType<typeof deferred>> = [];
afterEach(async () => {
  while (gates.length) gates.pop()!.resolve(undefined);
  while (clients.length) await clients.pop()!.close();
  while (apps.length) await apps.pop()!.cleanup();
});

async function connect(connection: ProgressMcpConnection): Promise<Client> {
  const client = new Client({ name: 'mingle-progress-questions-test', version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
  }));
  return client;
}

const question = { id: 'choice', header: 'Color', question: 'Which color?', options: [{ label: 'Blue' }, { label: 'Green' }], multiSelect: false, allowOther: false, secret: false };

describe('progress MCP user questions', () => {
  it('registers the required question schema, answers via the API and excludes secret text from persistence', async () => {
    const t = await startTestApp(); apps.push(t);
    const started = deferred<RunOptions>();
    t.fake.script = async (options) => { started.resolve(options); await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true })); };
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'Ask me.' })).status).toBe(202);
    const run = await started.promise;
    expect(run.progressMcp).toBeTruthy();
    const client = await connect(run.progressMcp!);
    const listed = await client.listTools();
    const tool = listed.tools.find((entry) => entry.name === 'mingle_request_user_input');
    expect(tool).toBeTruthy();
    expect(tool!.inputSchema).toMatchObject({ required: ['questions'] });
    const fieldSchema = (tool!.inputSchema.properties as any).questions.items;
    expect(fieldSchema.required).toEqual(expect.arrayContaining(['id', 'question', 'options', 'multiSelect', 'allowOther', 'secret']));

    const secret = { id: 'secret', question: 'Temporary phrase?', options: [], multiSelect: false, allowOther: true, secret: true };
    const pending = client.callTool({ name: 'mingle_request_user_input', arguments: { questions: [question, secret] } });
    const stored = await waitFor(() => t.app.store.bootstrapQuestions().find((row) => row.status === 'pending'));
    expect(stored.tool).toBe('mingle_request_user_input');
    expect(stored.id).toBeTruthy();
    expect(stored.questions).toEqual([question, secret]);
    expect(JSON.stringify(stored)).not.toContain('ephemeral secret response');
    const answered = await t.api('POST', `/api/questions/${stored.id}/answer`, { choice: ['Blue'], secret: ['ephemeral secret response'] });
    expect(answered.status).toBe(200);
    const result = await pending;
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('ephemeral secret response');
    expect(t.app.store.getUserQuestion(stored.id)).toMatchObject({ status: 'answered', answers: { choice: ['Blue'] } });
    expect(JSON.stringify(t.app.store.getUserQuestion(stored.id))).not.toContain('ephemeral secret response');
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/interrupt`, {});
  });

  it('returns a cancelled result when the user cancels the pending question', async () => {
    const t = await startTestApp(); apps.push(t);
    const started = deferred<RunOptions>();
    t.fake.script = async (options) => { started.resolve(options); await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true })); };
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'Ask, then cancel.' });
    const run = await started.promise;
    const client = await connect(run.progressMcp!);
    const pending = client.callTool({ name: 'mingle_request_user_input', arguments: { questions: [question] } });
    const stored = await waitFor(() => t.app.store.bootstrapQuestions().find((row) => row.status === 'pending'));
    expect((await t.api('POST', `/api/questions/${stored.id}/cancel`, {})).status).toBe(200);
    const result = await pending;
    // Cancelling a question interrupts its native run; the expired capability must not release answers.
    expect(result.isError === true || JSON.stringify(result).includes('cancelled')).toBe(true);
    expect(t.app.store.getUserQuestion(stored.id)?.status).toBe('cancelled');
  });

  it('exposes only the question tool in read-only native plans and rejects a revoked capability', async () => {
    const t = await startTestApp(); apps.push(t);
    const planned = deferred<RunOptions>();
    const gate = deferred(); gates.push(gate);
    t.fake.script = async (options) => { planned.resolve(options); await gate.promise; };
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'Plan the work.', intent: 'plan' });
    const run = await planned.promise;
    expect(run.progressMcp).toBeTruthy();
    const client = await connect(run.progressMcp!);
    const names = (await client.listTools()).tools.map((entry) => entry.name);
    expect(names).toEqual(['mingle_request_user_input']);
    gate.resolve();
    await waitFor(() => t.app.runtime.activeCount() === 0);

    const started = deferred<RunOptions>();
    const runGate = deferred(); gates.push(runGate);
    t.fake.script = async (options) => { started.resolve(options); await runGate.promise; };
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'Start another turn.' });
    const normal = await started.promise;
    const revokedClient = await connect(normal.progressMcp!);
    runGate.resolve();
    await waitFor(() => t.app.runtime.activeCount() === 0);
    await expect(revokedClient.callTool({ name: 'mingle_request_user_input', arguments: { questions: [question] } })).rejects.toThrow();
  });
});
