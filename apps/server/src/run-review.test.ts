import { afterEach, describe, expect, it } from 'vitest';
import { RUN_REVIEW_COMMAND_LIMIT, RUN_REVIEW_PROBLEM_LIMIT, type RunReviewEvidence, type ToolCall } from '@mingle/contracts';
import { WorkflowRepo } from './session-workflow/repo.ts';
import { makeRepo, startTestApp, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

let counter = 0;
const call = (runId: string, sessionId: string, extra: Partial<ToolCall> = {}): ToolCall => {
  const n = ++counter;
  return {
    id: `tool_${n}`, runId, sessionId, providerId: `p${n}`, parentProviderId: null, name: 'Bash', category: 'command', status: 'completed',
    summary: `call ${n}`, command: `echo ${n}`, input: '{}', output: 'SECRET-OUTPUT '.repeat(50), cwd: '/example', exitCode: 0, processId: null,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 5, ...extra,
  };
};

async function fixture() {
  const t = await startTestApp();
  apps.push(t);
  const store = t.app.store;
  const project = store.insertProject({ name: 'Run review fixture (example)', path: makeRepo() });
  const session = store.insertSession({ projectId: project.id, name: 'Example', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', policy: 'supervised', isolated: false, worktreePath: project.path, branch: 'main' });
  const run = (id: string, status: 'completed' | 'failed' | 'interrupted' | 'running' = 'completed') => {
    const message = store.insertMessage({ sessionId: session.id, role: 'user', content: `prompt ${id}` });
    const row = store.insertRun({ id, sessionId: session.id, userMessageId: message.id, provider: 'claude', model: 'claude-sonnet-5-5', startedAt: new Date().toISOString() });
    if (status !== 'running') store.finishRun(id, status, 100);
    return row;
  };
  const review = (id: string) => t.api<RunReviewEvidence>('GET', `/api/runs/${id}/review`);
  return { t, store, project, session, run, review };
}

describe('GET /api/runs/:id/review', () => {
  it('reports recorded commands, outcomes and counts without any tool output, and never states success', async () => {
    const { store, session, run, review } = await fixture();
    run('run_a');
    store.putToolCall(call('run_a', session.id, { command: 'npm test', exitCode: 0, summary: 'Run tests' }));
    store.putToolCall(call('run_a', session.id, { command: 'npm run lint', exitCode: 2, status: 'failed' }));
    store.putToolCall(call('run_a', session.id, { command: 'echo no-exit', exitCode: null }));
    store.putToolCall(call('run_a', session.id, { name: 'Read', category: 'file', command: null, summary: 'Read a.ts', exitCode: null }));
    store.putToolCall(call('run_a', session.id, { command: 'sleep 5', status: 'interrupted', exitCode: null }));
    const { status, json } = await review('run_a');
    expect(status).toBe(200);
    expect(json.tools).toMatchObject({ total: 5, counts: { command: 4, file: 1 }, failed: 1, interrupted: 1, running: 0, nonZeroExit: 1 });
    expect(json.commands).toMatchObject({ total: 4, truncated: false });
    expect(json.commands.items.map((item) => [item.command, item.status, item.exitCode])).toEqual([
      ['npm test', 'completed', 0], ['npm run lint', 'failed', 2], ['echo no-exit', 'completed', null], ['sleep 5', 'interrupted', null],
    ]);
    expect(json.problems.total).toBe(2);
    expect(json.problems.items.map((item) => item.status)).toEqual(['failed', 'interrupted']);
    expect(JSON.stringify(json)).not.toContain('SECRET-OUTPUT');
    expect(json).not.toHaveProperty('passed');
    expect(json.goalTurn).toBeNull();
    expect(json.failure).toBeNull();
  });

  it('is scoped to the one run and bounded: it lists the first rows, says it is truncated and still counts them all', async () => {
    const { store, session, run, review } = await fixture();
    run('run_big'); run('run_other');
    store.tx(() => {
      for (let i = 0; i < RUN_REVIEW_COMMAND_LIMIT + 7; i++) store.putToolCall(call('run_big', session.id, { command: `step ${i}`, exitCode: i < RUN_REVIEW_PROBLEM_LIMIT + 3 ? 1 : 0 }));
      store.putToolCall(call('run_other', session.id, { command: 'belongs to another run', exitCode: 9, status: 'failed' }));
    });
    const { json } = await review('run_big');
    expect(json.commands.total).toBe(RUN_REVIEW_COMMAND_LIMIT + 7);
    expect(json.commands.items).toHaveLength(RUN_REVIEW_COMMAND_LIMIT);
    expect(json.commands.truncated).toBe(true);
    expect(json.commands.items[0]!.command).toBe('step 0');
    expect(json.problems.total).toBe(RUN_REVIEW_PROBLEM_LIMIT + 3);
    expect(json.problems.items).toHaveLength(RUN_REVIEW_PROBLEM_LIMIT);
    expect(json.problems.truncated).toBe(true);
    expect(JSON.stringify(json)).not.toContain('belongs to another run');
  });

  it('clips long commands and redacts secrets that look like credentials', async () => {
    const { store, session, run, review } = await fixture();
    run('run_clip');
    store.putToolCall(call('run_clip', session.id, { command: `curl -H "Authorization: Bearer sk-ant-api03-${'a'.repeat(40)}" ${'x'.repeat(2000)}` }));
    const item = (await review('run_clip')).json.commands.items[0]!;
    expect(item.command!.length).toBeLessThanOrEqual(301);
    expect(item.command).not.toContain('sk-ant-api03');
  });

  it('returns the stored failure of that exact run only', async () => {
    const { store, session, run, review } = await fixture();
    run('run_fail', 'failed'); run('run_ok');
    store.insertProviderFailure(session.id, 'run_fail', {
      id: 'fail_1', sessionId: session.id, runId: 'run_fail', actor: 'session', kind: 'quota_exhausted', provider: 'claude', retryable: false, outcomeUnknown: true,
      dispatchState: 'dispatched', continuationSafety: 'unknown', message: 'Example quota exhausted.', occurredAt: new Date().toISOString(),
    }, new Date().toISOString());
    const failed = (await review('run_fail')).json;
    expect(failed.status).toBe('failed');
    expect(failed.failure).toMatchObject({ kind: 'quota_exhausted', message: 'Example quota exhausted.', outcomeUnknown: true });
    expect((await review('run_ok')).json.failure).toBeNull();
  });

  it('attaches a goal report only to the run that made it, with its own state, and ignores the goal latest summary', async () => {
    const { t, store, session, run, review } = await fixture();
    run('run_goal_1'); run('run_goal_2'); run('run_plain');
    const repo = new WorkflowRepo(store.db);
    repo.insertRun({ runId: 'run_goal_1', workflowId: 'wfl_x', sessionId: session.id, seq: 1, kind: 'start', startedAt: new Date().toISOString() });
    repo.insertRun({ runId: 'run_goal_2', workflowId: 'wfl_x', sessionId: session.id, seq: 2, kind: 'verify', startedAt: new Date().toISOString() });
    repo.setReport('run_goal_2', { outcome: 'complete', summary: 'Agent says the example goal is complete.' });
    repo.setReportState('run_goal_2', 'applied');
    const first = (await review('run_goal_1')).json.goalTurn;
    expect(first).toEqual({ workflowId: 'wfl_x', sequence: 1, kind: 'start', report: null });
    expect((await review('run_goal_2')).json.goalTurn).toEqual({
      workflowId: 'wfl_x', sequence: 2, kind: 'verify', report: { outcome: 'complete', summary: 'Agent says the example goal is complete.', state: 'applied' },
    });
    expect((await review('run_plain')).json.goalTurn).toBeNull();
    // Reading evidence changes nothing: the run's tasks and status stay as they were.
    expect(t.app.store.getRun('run_goal_2')!.status).toBe('completed');
  });

  it('rejects unknown and still-running runs without leaking anything', async () => {
    const { run, review } = await fixture();
    run('run_live', 'running');
    expect((await review('run_missing')).status).toBe(404);
    expect((await review('run_live')).status).toBe(409);
  });

  it('reports a run with no recorded tool calls as empty rather than inventing activity', async () => {
    const { run, review } = await fixture();
    run('run_none');
    const { json } = await review('run_none');
    expect(json.tools).toEqual({ total: 0, counts: {}, failed: 0, interrupted: 0, running: 0, nonZeroExit: 0 });
    expect(json.commands).toEqual({ total: 0, items: [], truncated: false });
    expect(json.problems).toEqual({ total: 0, items: [], truncated: false });
  });
});
