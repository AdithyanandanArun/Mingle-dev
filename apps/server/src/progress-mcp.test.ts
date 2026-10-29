import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
import type { ProgressMcpConnection, RunOptions } from '@mingle/contracts';
import { EXAMPLE_CLIENT_SESSION_ID, EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { deferred, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const clients: Client[] = [];
const sockets: WebSocket[] = [];
const gates: Array<ReturnType<typeof deferred>> = [];
afterEach(async () => {
  while (gates.length) gates.pop()!.resolve(undefined);
  while (clients.length) await clients.pop()!.close();
  while (sockets.length) sockets.pop()!.close();
  while (apps.length) await apps.pop()!.cleanup();
});

async function connect(connection: ProgressMcpConnection): Promise<Client> {
  const client = new Client({ name: 'mingle-progress-test', version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
  }));
  return client;
}

async function openSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: 'http://localhost:5173' } });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function notified(socket: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('message', onMessage); reject(new Error(`No WebSocket event ${type}`)); }, 3000);
    const onMessage = (data: WebSocket.RawData) => {
      const payload = JSON.parse(data.toString());
      if (payload.type !== 'state.changed' || payload.event?.type !== type) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(payload);
    };
    socket.on('message', onMessage);
  });
}

describe('built-in progress MCP', () => {
  it('validates tools, persists scoped plans/status, broadcasts updates and clears status when a run ends', async () => {
    const t = await startTestApp();
    apps.push(t);
    const runStarted = new Map<string, ReturnType<typeof deferred<RunOptions>>>([
      [EXAMPLE_CONTRACT_SESSION_ID, deferred<RunOptions>()], [EXAMPLE_CLIENT_SESSION_ID, deferred<RunOptions>()],
    ]);
    const runGates = new Map<string, ReturnType<typeof deferred>>([
      [EXAMPLE_CONTRACT_SESSION_ID, deferred()], [EXAMPLE_CLIENT_SESSION_ID, deferred()],
    ]);
    gates.push(...runGates.values());
    t.fake.script = async (options) => {
      runStarted.get(options.session.id)?.resolve(options);
      await runGates.get(options.session.id)?.promise;
    };

    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'Begin work.' })).status).toBe(202);
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`, { content: 'Begin separate work.' })).status).toBe(202);
    const [runA, runB] = await Promise.all([
      runStarted.get(EXAMPLE_CONTRACT_SESSION_ID)!.promise,
      runStarted.get(EXAMPLE_CLIENT_SESSION_ID)!.promise,
    ]);
    expect(runA.progressMcp?.url).toContain('127.0.0.1');
    expect(runB.progressMcp?.token).not.toBe(runA.progressMcp?.token);
    const clientA = await connect(runA.progressMcp!);
    const clientB = await connect(runB.progressMcp!);

    const socket = await openSocket(t.port);
    const statusBroadcast = notified(socket, 'session.progress.status');
    const status = await clientA.callTool({ name: 'mingle_status_set', arguments: {
      step: 'Inspecting the API', detail: 'Following the request path', progress: { current: 2, total: 4 },
    } });
    expect(status.isError).not.toBe(true);
    expect(await statusBroadcast).toMatchObject({ event: { sessionId: EXAMPLE_CONTRACT_SESSION_ID, payload: { runId: expect.any(String), status: { step: 'Inspecting the API' } } } });
    const crossSession = await clientA.callTool({ name: 'mingle_status_set', arguments: { step: 'Try to target another session', sessionId: EXAMPLE_CLIENT_SESSION_ID } });
    expect(crossSession.isError).toBe(true);
    const storedStatus = t.app.store.recentEvents(30).find((event) => event.type === 'session.progress.status' && event.sessionId === EXAMPLE_CONTRACT_SESSION_ID);
    expect(storedStatus?.payload.status).toMatchObject({ step: 'Inspecting the API', detail: 'Following the request path', progress: { current: 2, total: 4 } });
    expect(t.app.store.recentEvents(30).some((event) => event.type === 'session.progress.status' && event.sessionId === EXAMPLE_CLIENT_SESSION_ID)).toBe(false);

    const invalidStatus = await clientA.callTool({ name: 'mingle_status_set', arguments: { step: 'x'.repeat(121) } });
    expect(invalidStatus.isError).toBe(true);
    const invalidProgress = await clientA.callTool({ name: 'mingle_status_set', arguments: { step: 'Invalid ratio', progress: { current: 3, total: 2 } } });
    expect(invalidProgress.isError).toBe(true);
    const invalidPlan = await clientA.callTool({ name: 'mingle_plan_update', arguments: { steps: [{ title: 'x'.repeat(161), status: 'pending' }] } });
    expect(invalidPlan.isError).toBe(true);
    const invalidPlanSize = await clientA.callTool({ name: 'mingle_plan_update', arguments: { steps: Array.from({ length: 31 }, (_, index) => ({ title: `Step ${index}`, status: 'pending' })) } });
    expect(invalidPlanSize.isError).toBe(true);

    const plan = await clientA.callTool({ name: 'mingle_plan_update', arguments: { steps: [
      { title: 'Review the API', status: 'done' }, { title: 'Update the client', status: 'in_progress' }, { title: 'Run checks', status: 'pending' },
    ] } });
    expect(plan.isError).not.toBe(true);
    const persisted = t.app.store.recentEvents(30).find((event) => event.type === 'session.progress.plan' && event.sessionId === EXAMPLE_CONTRACT_SESSION_ID);
    expect(persisted?.payload).toMatchObject({ planId: `mingle-status:${EXAMPLE_CONTRACT_SESSION_ID}`, steps: [
      { title: 'Review the API', status: 'done' }, { title: 'Update the client', status: 'in_progress' }, { title: 'Run checks', status: 'pending' },
    ] });
    const bootstrap = await t.api('GET', '/api/bootstrap');
    expect(bootstrap.json.events).toContainEqual(expect.objectContaining({ id: persisted?.id, sessionId: EXAMPLE_CONTRACT_SESSION_ID, type: 'session.progress.plan' }));

    runGates.get(EXAMPLE_CONTRACT_SESSION_ID)!.resolve(undefined);
    runGates.get(EXAMPLE_CLIENT_SESSION_ID)!.resolve(undefined);
    await waitFor(() => t.app.store.recentEvents(30).find((event) => event.type === 'session.progress.status' && event.sessionId === EXAMPLE_CONTRACT_SESSION_ID && event.payload.status === null));
    expect(t.app.store.recentEvents(30).some((event) => event.type === 'session.progress.plan' && event.sessionId === EXAMPLE_CONTRACT_SESSION_ID)).toBe(true);
    await waitFor(() => t.app.runtime.activeCount() === 0);

    const planningRun = deferred<RunOptions>();
    t.fake.script = async (options) => { planningRun.resolve(options); };
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'Prepare a read-only plan.', intent: 'plan' })).status).toBe(202);
    const planOptions = await planningRun.promise;
    expect(planOptions.progressMcp).toBeUndefined();
    expect(planOptions.prompt).not.toContain('mingle_status_set');
  });
});
