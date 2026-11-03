import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ProgressMcpConnection } from '@mingle/contracts';
import { deferred, FakeProviders, makeRepo, rawRequest, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const clients: Client[] = [];
const repos: string[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()!.close().catch(() => undefined);
  while (apps.length) await apps.pop()!.cleanup();
  while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true });
});

async function setup() {
  const t = await startTestApp({ exampleWorkspace: false, fake: fullAccessFake() });
  apps.push(t);
  await t.app.providers.list();
  const repo = makeRepo(); repos.push(repo);
  const projectResult = await t.api('POST', '/api/projects', { name: 'Example workflow', path: repo });
  expect(projectResult.status, JSON.stringify(projectResult.json)).toBe(201);
  const project = projectResult.json;
  const sessionResult = await t.api('POST', '/api/sessions', {
    projectId: project.id, name: 'Example agent', provider: 'claude', model: 'claude-sonnet-5-5', policy: 'full-access',
  });
  expect(sessionResult.status, JSON.stringify(sessionResult.json)).toBe(201);
  const session = sessionResult.json;
  return { t, session, project, endpoint: `/api/sessions/${session.id}/workflow` };
}
function fullAccessFake() {
  const fake = new FakeProviders();
  const detect = fake.detectProviders.bind(fake);
  fake.detectProviders = async (settings) => (await detect(settings)).map((provider) => ({ ...provider,
    models: provider.models.map((model) => ({ ...model, policies: ['supervised', 'full-access'] })),
  }));
  return fake;
}
async function connect(connection: ProgressMcpConnection) {
  const client = new Client({ name: 'example-workflow-test', version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
  }));
  return client;
}

describe('single-session workflow HTTP and native MCP integration', () => {
  it('continues the same native conversation, binds one task and applies completion only after the native turn ends', async () => {
    const { t, session, endpoint } = await setup();
    let reported = false;
    const release = deferred();
    let lastConnection: ProgressMcpConnection | undefined;
    t.fake.script = async (options, emit) => {
      const turn = t.fake.runs.length;
      emit({ type: 'session', providerSessionId: 'example-native-conversation' });
      const client = await connect(options.progressMcp!);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('mingle_workflow_finish');
      if (turn < 3) {
        await client.callTool({ name: 'mingle_plan_update', arguments: {
          steps: [{ title: `Finish example stage ${turn + 1}`, status: 'in_progress' }],
        } });
        emit({ type: 'tool.activity', activity: { id: `example-read-${turn}`, name: 'Read', category: 'file', status: 'completed', summary: 'Read README.md', output: '# repo' } });
      } else {
        const forged = await client.callTool({ name: 'mingle_workflow_finish', arguments: { outcome: 'complete', summary: 'Forged identity', sessionId: 'other-session' } });
        expect(forged.isError).toBe(true);
        const result = await client.callTool({ name: 'mingle_workflow_finish', arguments: { outcome: 'complete', summary: 'Example goal checked; ready for human review.' } });
        expect(result.isError).not.toBe(true);
        lastConnection = options.progressMcp;
        reported = true;
        await release.promise;
      }
      emit({ type: 'text', text: `Example turn ${turn}.` });
    };
    expect((await t.api('POST', endpoint, { goal: 'Complete and check the three-stage example goal.' })).status).toBe(202);
    try {
      await waitFor(() => reported, 8000, 'third-turn completion report');
      const pending = (await t.api('GET', endpoint)).json.workflow;
      expect(pending.state).toBe('running');
      expect(t.fake.runs).toHaveLength(3);
      expect(t.fake.runs.every((run) => run.session.id === session.id && run.session.policy === 'full-access')).toBe(true);
      expect(t.fake.runs.slice(1).every((run) => run.session.providerSessionId === 'example-native-conversation')).toBe(true);
    } finally { release.resolve(); }
    const completed = await waitFor(async () => {
      const value = (await t.api('GET', endpoint)).json.workflow;
      return value?.state === 'completed' ? value : null;
    }, 5000, 'agent-reported workflow completion');
    expect(completed).toMatchObject({ stopReason: 'goal-complete', counters: { turns: 3 } });
    const boot = (await t.api('GET', '/api/bootstrap')).json;
    expect(boot.workflows).toContainEqual(completed);
    expect(boot.tasks.filter((task: any) => task.id === completed.taskId)).toMatchObject([{ status: 'review' }]);
    expect(t.app.store.getSession(session.id)?.policy).toBe('full-access');
    expect((await rawRequest(t.port, 'POST', '/api/progress/mcp', { authorization: `Bearer ${lastConnection!.token}` }, '{}')).status).toBe(401);
  }, 15_000);

  it('rejects malformed goals and budgets, foreign context, unknown identities and web origins before dispatch', async () => {
    const { t, session, endpoint } = await setup();
    expect((await t.api('GET', endpoint)).json).toEqual({ workflow: null });
    for (const body of [{ goal: '' }, { goal: 'x', runId: 'forged' }, { goal: 'x', limits: { maxTurns: 51 } }, { goal: 'x', limits: { maxElapsedMinutes: 1441 } }]) {
      expect((await t.api('POST', endpoint, body)).status).toBe(400);
    }
    expect((await t.api('POST', endpoint, { goal: 'x' }, { origin: 'https://example.invalid' })).status).toBe(403);
    expect((await t.api('POST', '/api/sessions/missing/workflow', { goal: 'x' })).status).toBe(404);
    expect((await t.api('POST', endpoint, { goal: 'x', contextRefs: [{ kind: 'file', path: 'README.md', sourceSessionId: 'other-session' }] })).status).toBe(400);
    expect((await t.api('POST', `${endpoint}/pause`, { expectedVersion: 1, runId: 'forged' })).status).toBe(400);
    expect((await t.api('GET', endpoint)).json.workflow).toBeNull();
    expect(t.fake.runs).toHaveLength(0);
    expect(t.app.store.listTasks().filter((task) => task.sessionId === session.id)).toHaveLength(0);
  });

  it('fences stale controls, configuration updates and a delayed completion after explicit Stop', async () => {
    const { t, session, endpoint } = await setup();
    const begun = deferred();
    t.fake.script = async (options) => {
      begun.resolve();
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
    };
    const started = await t.api('POST', endpoint, { goal: 'Wait for an explicit human stop.' });
    expect(started.status).toBe(202);
    await begun.promise;
    const running = (await t.api('GET', endpoint)).json.workflow;
    expect((await t.api('POST', `${endpoint}/pause`, { expectedVersion: running.version + 1 })).status).toBe(409);
    expect((await t.api('PATCH', `/api/sessions/${session.id}`, { policy: 'supervised' })).status).toBe(409);
    expect((await t.api('POST', `/api/sessions/${session.id}/interrupt`, {})).status).toBe(200);
    await waitFor(() => !t.app.runtime.isActive(session.id));
    expect((await t.api('GET', endpoint)).json.workflow).toMatchObject({ state: 'stopped', stopReason: 'user-stop' });
    expect(t.fake.runs).toHaveLength(1);
    expect(t.app.store.getSession(session.id)?.policy).toBe('full-access');
  });

  it('restores a paused goal after restart without the generic resume service dispatching a duplicate run', async () => {
    const { t, session, endpoint } = await setup();
    t.fake.script = async (options, emit) => {
      emit({ type: 'session', providerSessionId: 'example-restart-conversation' });
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
    };
    expect((await t.api('POST', endpoint, { goal: 'Recover partial work without repeating side effects.' })).status).toBe(202);
    await waitFor(() => t.fake.runs.length === 1);
    const before = (await t.api('GET', endpoint)).json.workflow;
    await t.app.close();
    const fake = fullAccessFake();
    fake.script = async (options) => {
      const client = await connect(options.progressMcp!);
      expect((await client.callTool({ name: 'mingle_workflow_finish', arguments: { outcome: 'complete', summary: 'Partial work inspected and completed.' } })).isError).not.toBe(true);
    };
    const restarted = await startTestApp({ dataDir: t.dataDir, fake, exampleWorkspace: false });
    apps.push(restarted);
    await restarted.app.providers.list();
    const paused = (await restarted.api('GET', endpoint)).json.workflow;
    expect(paused).toMatchObject({ id: before.id, goal: before.goal, taskId: before.taskId, state: 'paused', stopReason: 'app-closed', currentRunId: null });
    await waitFor(() => restarted.app.store.recentEvents(100).some((event) => event.type === 'session.run.resume-skipped' && event.payload.reason === 'workflow-managed'));
    expect(fake.runs).toHaveLength(0);
    expect((await restarted.api('POST', `${endpoint}/resume`, { expectedVersion: paused.version })).status).toBe(200);
    await waitFor(async () => (await restarted.api('GET', endpoint)).json.workflow?.state === 'completed');
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]!.session.providerSessionId).toBe('example-restart-conversation');
    expect(fake.runs[0]!.prompt).toMatch(/inspect the current state/i);
    expect(restarted.app.store.getSession(session.id)?.policy).toBe('full-access');
  }, 15_000);

  it('rejects task and native-plan starts while a goal waits for a helper instead of bypassing its turn budget', async () => {
    const { t, session, project, endpoint } = await setup();
    const child = t.app.store.insertSession({ projectId: project.id, name: 'Example helper', provider: session.provider,
      model: session.model, effort: session.effort, policy: session.policy, isolated: false,
      worktreePath: session.worktreePath, branch: session.branch, parentSessionId: session.id,
    });
    t.fake.script = async (options) => {
      t.app.store.insertDelegatedSubagent({ id: 'example-held-helper', parentSessionId: session.id, childSessionId: child.id,
        name: 'example-helper', provider: session.provider, model: session.model, task: 'Wait in the fixture', status: 'running',
        requestedBy: 'agent', startedAt: new Date().toISOString(), endedAt: null, resultPreview: null, error: null, resultDelivered: false,
      });
      const client = await connect(options.progressMcp!);
      await client.callTool({ name: 'mingle_plan_update', arguments: { steps: [{ title: 'Wait for the helper', status: 'in_progress' }] } });
    };
    expect((await t.api('POST', endpoint, { goal: 'Wait for the helper result.' })).status).toBe(202);
    await waitFor(() => t.fake.runs.length === 1 && !t.app.runtime.isActive(session.id));
    const task = await t.api('POST', '/api/tasks', { projectId: project.id, sessionId: session.id,
      title: 'A different task', description: 'Another explicit task', acceptanceCriteria: '', dependsOn: [],
    });
    expect(task.status).toBe(201);
    expect((await t.api('POST', `/api/tasks/${task.json.id}/run`, {})).status).toBe(409);
    expect(() => t.app.runtime.start(session.id, 'Generate a native plan.', { intent: 'plan' })).toThrow(/Pause autonomous work/);
    expect(t.fake.runs).toHaveLength(1);
    expect((await t.api('GET', endpoint)).json.workflow).toMatchObject({ state: 'running', counters: { turns: 1 }, currentRunId: null });
    expect(t.app.store.getTask(task.json.id)?.status).toBe('ready');
  });
});
