import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RunOptions } from '@mingle/contracts';
import { EXAMPLE_PROJECT_ID } from '../example.ts';
import { SessionResumeService } from '../session-resume.ts';
import { TaskService } from '../tasks.ts';
import { deferred, makeRepo, startTestApp, waitFor, type Script, type TestApp } from '../test-utils.ts';
import { newId } from '../util.ts';
import { SessionWorkflowService } from './service.ts';
import { workflowOwnsRun } from './ownership.ts';

const apps: TestApp[] = [];
const clients: Client[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()!.close().catch(() => undefined);
  while (apps.length) await apps.pop()!.cleanup();
});

interface Harness { t: TestApp; service: SessionWorkflowService; sessionId: string; dir: string; scripts: Script[]; runs: () => number }

async function harness(options: { worktree?: string } = {}): Promise<Harness> {
  const t = await startTestApp();
  apps.push(t);
  const dir = options.worktree ?? makeRepo();
  const session = t.app.store.insertSession({ projectId: EXAMPLE_PROJECT_ID, name: 'Goal session', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: false, worktreePath: dir, branch: 'main' });
  // Once the application wires its own service, reuse it so hooks and timers are never duplicated.
  const service = (t.app as { workflows?: SessionWorkflowService }).workflows
    ?? new SessionWorkflowService({ store: t.app.store, runtime: t.app.runtime, tasks: new TaskService(t.app.store), recovery: t.app.recovery, groups: t.app.groups });
  const scripts: Script[] = [];
  t.fake.script = async (o, emit) => {
    const index = t.fake.runs.length - 1;
    const script = scripts[Math.min(index, scripts.length - 1)];
    if (script) await script(o, emit);
  };
  return { t, service, sessionId: session.id, dir, scripts, runs: () => t.fake.runs.length };
}

async function tool(options: RunOptions, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  const client = new Client({ name: 'workflow-test', version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(options.progressMcp!.url), { requestInit: { headers: { Authorization: `Bearer ${options.progressMcp!.token}` } } }));
  const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: result.isError, text: result.content[0]?.text ?? '' };
}
const plan = (...status: Array<'pending' | 'in_progress' | 'done'>) => ({ steps: status.map((s, i) => ({ title: `Step ${i + 1}`, status: s })) });
const finish = (o: RunOptions, outcome: string, summary = 'Reported by the test agent.') => tool(o, 'mingle_workflow_finish', { outcome, summary });
const edit = (h: Harness, name: string) => writeFileSync(path.join(h.dir, name), `${name}\n`);
const settled = (h: Harness, predicate: (state: string) => boolean = (s) => s !== 'running') => waitFor(() => { const w = h.service.get(h.sessionId); return w && predicate(w.state) ? w : null; }, 6000, 'workflow state');
const idle = (h: Harness) => waitFor(() => !h.t.app.runtime.isActive(h.sessionId), 6000, 'runtime idle');
const prompts = (h: Harness) => h.t.fake.runs.map((r) => r.prompt);

describe('autonomous single-session workflow', () => {
  it('retries one eligible generated continuation once, consumes a budgeted turn, then accepts the retry outcome', async () => {
    const h = await harness();
    const failedAt = new Date().toISOString();
    const retryAt = new Date(Date.now() + 80).toISOString();
    h.scripts.push(
      async (o, emit) => { emit({ type: 'session', providerSessionId: 'example-native-session' }); await tool(o, 'mingle_plan_update', plan('in_progress')); edit(h, 'before-retry.txt'); },
      async () => { throw new Error('temporary provider failure'); },
      async (o) => { await finish(o, 'complete', 'Completed on the bounded retry.'); },
    );
    const recovery = h.t.app.recovery as unknown as { failureForRun: (id: string) => unknown };
    recovery.failureForRun = (id) => {
      const run = h.t.app.store.getRun(id);
      if (!run || run.status !== 'failed') return null;
      return { id: 'failure_test', sessionId: h.sessionId, runId: id, actor: 'session', provider: 'claude', kind: 'temporary_rate_limit', retryable: true, safeToRetry: true, outcomeUnknown: false, dispatchState: 'not-dispatched', continuationSafety: 'safe', retryAt, message: 'Temporary rate limit.', occurredAt: failedAt };
    };
    h.service.start(h.sessionId, { goal: 'Retry the generated continuation once', limits: { maxTurns: 3, maxElapsedMinutes: 5, maxStalls: 2 } });
    const done = await settled(h, (state) => state === 'completed' || state === 'paused');
    expect(done).toMatchObject({ state: 'completed', counters: { turns: 3 } });
    expect(h.runs()).toBe(3);
    expect(prompts(h)[2]).toBe(prompts(h)[1]);
    expect(h.t.fake.runs[2]?.context).toBe(h.t.fake.runs[1]?.context);
    expect(h.t.fake.runs[2]?.session.providerSessionId).toBe(h.t.fake.runs[1]?.session.providerSessionId);
    const ledger = h.t.app.store.db.prepare('SELECT status,retry_run_id FROM session_workflow_retries').get() as { status: string; retry_run_id: string };
    expect(ledger.status).toBe('consumed');
    expect(ledger.retry_run_id).toBeTruthy();
  });

  it('pauses after the one automatic retry fails and never schedules a third attempt', async () => {
    const h = await harness();
    h.scripts.push(
      async (o, emit) => { emit({ type: 'session', providerSessionId: 'example-native-session' }); await tool(o, 'mingle_plan_update', plan('in_progress')); edit(h, 'before-retry.txt'); },
      async () => { throw new Error('temporary provider failure'); },
      async () => { throw new Error('temporary provider failure again'); },
    );
    const recovery = h.t.app.recovery as unknown as { failureForRun: (id: string) => unknown };
    recovery.failureForRun = (id) => {
      const run = h.t.app.store.getRun(id);
      if (!run || run.status !== 'failed') return null;
      return { id: `failure_${id}`, sessionId: h.sessionId, runId: id, actor: 'session', provider: 'claude', kind: 'temporary_rate_limit', retryable: true, safeToRetry: true, outcomeUnknown: false, dispatchState: 'not-dispatched', continuationSafety: 'safe', retryAt: new Date(Date.now() + 60).toISOString(), message: 'Temporary rate limit.', occurredAt: new Date().toISOString() };
    };
    h.service.start(h.sessionId, { goal: 'Retry at most once', limits: { maxTurns: 4, maxElapsedMinutes: 5, maxStalls: 2 } });
    const paused = await settled(h, (state) => state === 'paused');
    await idle(h);
    expect(paused.state).toBe('paused');
    expect(h.runs()).toBe(3);
    const ledger = h.t.app.store.db.prepare('SELECT status,retry_run_id FROM session_workflow_retries').get() as { status: string; retry_run_id: string };
    expect(ledger.status).toBe('consumed');
    expect(ledger.retry_run_id).toBeTruthy();
  });

  it('fails closed on missing, unsafe and refusal retry evidence', async () => {
    for (const override of [null, { safeToRetry: false }, { providerCode: 'refusal' }]) {
      const h = await harness();
      h.scripts.push(
        async (o, emit) => { emit({ type: 'session', providerSessionId: 'example-native-session' }); await tool(o, 'mingle_plan_update', plan('in_progress')); edit(h, 'work.txt'); },
        async () => { throw new Error('transient failure text is not proof'); },
      );
      const recovery = h.t.app.recovery as unknown as { failureForRun: (id: string) => unknown };
      recovery.failureForRun = (id) => {
        if (override === null) return null;
        const run = h.t.app.store.getRun(id);
        if (!run || run.status !== 'failed') return null;
        return { id: 'failure_test', sessionId: h.sessionId, runId: id, actor: 'session', provider: 'claude', kind: 'temporary_rate_limit', retryable: true, safeToRetry: true, outcomeUnknown: false, dispatchState: 'not-dispatched', continuationSafety: 'safe', retryAt: new Date(Date.now() + 60_000).toISOString(), message: 'Transient.', occurredAt: new Date().toISOString(), ...override };
      };
      h.service.start(h.sessionId, { goal: 'Keep going', limits: { maxTurns: 5, maxElapsedMinutes: 5, maxStalls: 2 } });
      const paused = await settled(h, (state) => state === 'paused');
      await idle(h);
      expect(paused.state).toBe('paused');
      expect(h.runs()).toBe(2);
      expect(h.t.app.store.db.prepare('SELECT COUNT(*) AS n FROM session_workflow_retries').get()).toEqual({ n: 0 });
    }
  });

  it('cancels a pending retry when a person pauses before its timer fires', async () => {
    const h = await harness();
    h.scripts.push(
      async (o, emit) => { emit({ type: 'session', providerSessionId: 'example-native-session' }); await tool(o, 'mingle_plan_update', plan('in_progress')); edit(h, 'work.txt'); },
      async () => { throw new Error('temporary failure'); },
    );
    const recovery = h.t.app.recovery as unknown as { failureForRun: (id: string) => unknown };
    recovery.failureForRun = (id) => {
      const run = h.t.app.store.getRun(id);
      if (!run || run.status !== 'failed') return null;
      return { id: 'failure_test', sessionId: h.sessionId, runId: id, actor: 'session', provider: 'claude', kind: 'temporary_rate_limit', retryable: true, safeToRetry: true, outcomeUnknown: false, dispatchState: 'not-dispatched', continuationSafety: 'safe', retryAt: new Date(Date.now() + 60_000).toISOString(), message: 'Transient.', occurredAt: new Date().toISOString() };
    };
    h.service.start(h.sessionId, { goal: 'Keep going', limits: { maxTurns: 5, maxElapsedMinutes: 5, maxStalls: 2 } });
    await waitFor(() => h.t.app.store.db.prepare("SELECT 1 FROM session_workflow_retries WHERE status='pending'").get(), 6000, 'pending retry');
    const paused = h.service.pause(h.sessionId, h.service.get(h.sessionId)!.version);
    expect(paused).toMatchObject({ state: 'paused', stopReason: 'user-pause' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(h.runs()).toBe(2);
    expect(h.t.app.store.db.prepare('SELECT status FROM session_workflow_retries').get()).toEqual({ status: 'cancelled' });
  });

  it('keeps a goal running when its retry timer wakes before the retry and goal deadlines', async () => {
    const h = await harness();
    h.scripts.push(
      async (o, emit) => { emit({ type: 'session', providerSessionId: 'example-native-session' }); await tool(o, 'mingle_plan_update', plan('in_progress')); edit(h, 'work.txt'); },
      async () => { throw new Error('temporary failure'); },
    );
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    const recovery = h.t.app.recovery as unknown as { failureForRun: (id: string) => unknown };
    recovery.failureForRun = (id) => {
      const run = h.t.app.store.getRun(id);
      if (!run || run.status !== 'failed') return null;
      return { id: 'failure_test', sessionId: h.sessionId, runId: id, actor: 'session', provider: 'claude', kind: 'temporary_rate_limit', retryable: true, safeToRetry: true, outcomeUnknown: false, dispatchState: 'not-dispatched', continuationSafety: 'safe', retryAt, message: 'Transient.', occurredAt: new Date().toISOString() };
    };
    h.service.start(h.sessionId, { goal: 'Keep going', limits: { maxTurns: 5, maxElapsedMinutes: 5, maxStalls: 2 } });
    await waitFor(() => h.t.app.store.db.prepare("SELECT 1 FROM session_workflow_retries WHERE status='pending'").get(), 6000, 'pending retry');
    const workflow = h.service.get(h.sessionId)!;
    // Reproduce a native timer waking early, without depending on scheduler jitter.
    (h.service as unknown as { onDeadline(id: string): void }).onDeadline(workflow.id);
    expect(h.service.get(h.sessionId)).toMatchObject({ state: 'running', stopReason: null });
    expect(h.runs()).toBe(2);
    expect(h.t.app.store.db.prepare('SELECT status FROM session_workflow_retries').get()).toEqual({ status: 'pending' });
    h.service.pause(h.sessionId, workflow.version);
  });

  it('pauses a pending retry as app-closed on restart instead of dispatching it', async () => {
    const h = await harness();
    h.scripts.push(
      async (o, emit) => { emit({ type: 'session', providerSessionId: 'example-native-session' }); await tool(o, 'mingle_plan_update', plan('in_progress')); edit(h, 'work.txt'); },
      async () => { throw new Error('temporary failure'); },
    );
    const recovery = h.t.app.recovery as unknown as { failureForRun: (id: string) => unknown };
    recovery.failureForRun = (id) => {
      const run = h.t.app.store.getRun(id);
      if (!run || run.status !== 'failed') return null;
      return { id: 'failure_test', sessionId: h.sessionId, runId: id, actor: 'session', provider: 'claude', kind: 'temporary_rate_limit', retryable: true, safeToRetry: true, outcomeUnknown: false, dispatchState: 'not-dispatched', continuationSafety: 'safe', retryAt: new Date(Date.now() + 60_000).toISOString(), message: 'Transient.', occurredAt: new Date().toISOString() };
    };
    h.service.start(h.sessionId, { goal: 'Keep going', limits: { maxTurns: 5, maxElapsedMinutes: 5, maxStalls: 2 } });
    await waitFor(() => h.t.app.store.db.prepare("SELECT 1 FROM session_workflow_retries WHERE status='pending'").get(), 6000, 'pending retry');
    h.service.close();
    const recovered = new SessionWorkflowService({ store: h.t.app.store, runtime: h.t.app.runtime, tasks: new TaskService(h.t.app.store), recovery: h.t.app.recovery, groups: h.t.app.groups });
    expect(recovered.get(h.sessionId)).toMatchObject({ state: 'paused', stopReason: 'app-closed' });
    expect(h.t.app.store.db.prepare('SELECT status FROM session_workflow_retries').get()).toEqual({ status: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(h.runs()).toBe(2);
    recovered.close();
  });

  it('pauses at retry time if the session configuration changes while waiting', async () => {
    const h = await harness();
    h.scripts.push(
      async (o, emit) => { emit({ type: 'session', providerSessionId: 'example-native-session' }); await tool(o, 'mingle_plan_update', plan('in_progress')); edit(h, 'work.txt'); },
      async () => { throw new Error('temporary failure'); },
    );
    const recovery = h.t.app.recovery as unknown as { failureForRun: (id: string) => unknown };
    recovery.failureForRun = (id) => {
      const run = h.t.app.store.getRun(id);
      if (!run || run.status !== 'failed') return null;
      return { id: 'failure_test', sessionId: h.sessionId, runId: id, actor: 'session', provider: 'claude', kind: 'temporary_rate_limit', retryable: true, safeToRetry: true, outcomeUnknown: false, dispatchState: 'not-dispatched', continuationSafety: 'safe', retryAt: new Date(Date.now() + 500).toISOString(), message: 'Transient.', occurredAt: new Date().toISOString() };
    };
    h.service.start(h.sessionId, { goal: 'Keep going', limits: { maxTurns: 5, maxElapsedMinutes: 5, maxStalls: 2 } });
    await waitFor(() => h.t.app.store.db.prepare("SELECT 1 FROM session_workflow_retries WHERE status='pending'").get(), 6000, 'pending retry');
    h.t.app.store.updateSession(h.sessionId, { effort: 'low' });
    expect(await settled(h, (state) => state === 'paused')).toMatchObject({ stopReason: 'configuration-changed' });
    expect(h.runs()).toBe(2);
    expect(h.t.app.store.db.prepare('SELECT status FROM session_workflow_retries').get()).toEqual({ status: 'cancelled' });
  });

  it('runs three turns to an agent-reported completion without a spurious task per turn and leaves the goal task in Review', async () => {
    const h = await harness();
    h.scripts.push(
      async (o) => { await tool(o, 'mingle_plan_update', plan('in_progress', 'pending')); edit(h, 'a.txt'); },
      async (o) => { await tool(o, 'mingle_plan_update', plan('done', 'in_progress')); edit(h, 'b.txt'); },
      async (o) => { edit(h, 'c.txt'); expect((await finish(o, 'complete', 'Everything is written.')).isError).toBeFalsy(); },
    );
    const started = h.service.start(h.sessionId, { goal: 'Write three files' });
    expect(started).toMatchObject({ state: 'running', counters: { turns: 1, stalls: 0 }, limits: { maxTurns: 8, maxElapsedMinutes: 240, maxStalls: 2 } });
    const done = await settled(h);
    expect(done).toMatchObject({ state: 'completed', stopReason: 'goal-complete', summary: 'Everything is written.', counters: { turns: 3 }, currentRunId: null });
    expect(h.runs()).toBe(3);
    expect(prompts(h)[0]).toContain('Write three files');
    expect(prompts(h)[1]).toContain('turn 2 of at most 8');
    const task = h.t.app.store.getTask(done.taskId)!;
    expect(task.status).toBe('review');
    expect(h.t.app.store.listTasks(EXAMPLE_PROJECT_ID).filter((x) => x.sessionId === h.sessionId)).toHaveLength(1);
    const kinds = h.t.app.store.listMessages(h.sessionId).filter((m) => m.role === 'user').map((m) => [m.kind, m.content]);
    expect(kinds).toEqual([['workflow-start', 'Write three files'], ['workflow-continuation', expect.stringContaining('turn 2')], ['workflow-continuation', expect.stringContaining('turn 3')]]);
    expect(h.t.app.store.listMessages(h.sessionId).some((m) => m.role === 'system' && /own report/.test(m.content))).toBe(true);
    expect(h.service.ownsRun(done.lastRunId!)).toBe(true);
  });

  it('never treats a native end of turn as completion: one verification turn, then pauses unreported', async () => {
    const h = await harness();
    h.scripts.push(async () => { /* replies and ends, no checklist, no report */ });
    h.service.start(h.sessionId, { goal: 'Do something' });
    const paused = await settled(h);
    expect(paused).toMatchObject({ state: 'paused', stopReason: 'unreported-outcome', counters: { turns: 2 } });
    expect(h.runs()).toBe(2);
    expect(prompts(h)[1]).toMatch(/without a goal report/);
    expect(h.t.app.store.listMessages(h.sessionId).filter((m) => m.kind === 'workflow-verification')).toHaveLength(1);
  });

  it('applies a blocked report as a pause and ignores a report from a failed turn', async () => {
    const blocked = await harness();
    blocked.scripts.push(async (o) => { await finish(o, 'blocked', 'Needs a license key.'); });
    blocked.service.start(blocked.sessionId, { goal: 'Try' });
    expect(await settled(blocked)).toMatchObject({ state: 'paused', stopReason: 'agent-blocked', summary: 'Needs a license key.' });

    const failed = await harness();
    failed.scripts.push(async (o) => { await finish(o, 'complete', 'All done'); throw new Error('provider exploded'); });
    failed.service.start(failed.sessionId, { goal: 'Try' });
    const wf = await settled(failed);
    expect(wf).toMatchObject({ state: 'paused', stopReason: 'failure' });
    expect(wf.summary).toMatch(/not retried automatically/);
    await idle(failed);
    expect(failed.runs()).toBe(1);
    expect(failed.t.app.store.getTask(wf.taskId)!.status).toBe('ready');
  });

  it('maps ACP refusals and quota to truthful stop reasons without retrying', async () => {
    const refused = await harness();
    refused.scripts.push(async () => { throw Object.assign(new Error('Provider refused'), { code: 'refusal', outcomeKnown: true }); });
    refused.service.start(refused.sessionId, { goal: 'Try' });
    expect(await settled(refused)).toMatchObject({ state: 'paused', stopReason: 'refused' });
    expect(refused.runs()).toBe(1);

    const quota = await harness();
    quota.scripts.push(async () => { throw Object.assign(new Error('Usage limit reached for this account'), { code: 'usage_limit_reached' }); });
    quota.service.start(quota.sessionId, { goal: 'Try' });
    expect(await settled(quota)).toMatchObject({ state: 'paused', stopReason: 'quota' });
  });

  it('pauses after consecutive no-progress turns and counts progress by files or checklist movement', async () => {
    const h = await harness();
    h.scripts.push(
      async (o) => { await tool(o, 'mingle_plan_update', plan('in_progress')); },
      async (o) => { await tool(o, 'mingle_plan_update', plan('in_progress')); },
      async (o) => { await tool(o, 'mingle_plan_update', plan('in_progress')); },
    );
    h.service.start(h.sessionId, { goal: 'Spin', limits: { maxTurns: 8, maxElapsedMinutes: 240, maxStalls: 2 } });
    const paused = await settled(h);
    expect(paused).toMatchObject({ state: 'paused', stopReason: 'stalled', counters: { turns: 3, stalls: 2 } });
    expect(h.runs()).toBe(3);
  });

  it('stops at the turn budget and resume grants explicit extra turns only', async () => {
    const h = await harness();
    let n = 0;
    h.scripts.push(async (o) => { await tool(o, 'mingle_plan_update', plan('in_progress')); edit(h, `f${n++}.txt`); });
    const started = h.service.start(h.sessionId, { goal: 'Many', limits: { maxTurns: 2, maxElapsedMinutes: 240, maxStalls: 2 } });
    const paused = await settled(h);
    expect(paused).toMatchObject({ stopReason: 'limit', counters: { turns: 2 } });
    await idle(h);
    expect(() => h.service.resume(h.sessionId, { expectedVersion: paused.version })).toThrow(/turn budget is used up/);
    expect(() => h.service.resume(h.sessionId, { expectedVersion: started.version })).toThrow(/changed since/);
    const resumed = h.service.resume(h.sessionId, { expectedVersion: paused.version, additionalTurns: 1 });
    expect(resumed).toMatchObject({ state: 'running', limits: { maxTurns: 3 }, counters: { turns: 3, stalls: 0 } });
    await waitFor(() => h.runs() >= 3, 4000, 'resume run');
    expect(prompts(h)[2]).toMatch(/inspect the current state/);
    expect(h.t.app.store.listMessages(h.sessionId).filter((m) => m.kind === 'workflow-resume')).toHaveLength(1);
    expect(await settled(h)).toMatchObject({ stopReason: 'limit', counters: { turns: 3 } });
  });

  it('pauses at the persisted deadline, cancels the active run and refuses an unextended resume', async () => {
    const h = await harness();
    const entered = deferred<void>();
    h.scripts.push(async (o) => { entered.resolve(); await new Promise<void>((_r, reject) => o.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })); });
    const started = h.service.start(h.sessionId, { goal: 'Wait', limits: { maxTurns: 8, maxElapsedMinutes: 1, maxStalls: 2 } });
    await entered.promise;
    // Move the persisted deadline into the past before emulating its timer callback.
    h.t.app.store.db.prepare('UPDATE session_workflows SET deadline_at=? WHERE id=?').run(new Date(Date.now() - 1).toISOString(), started.id);
    // The timer armed at start() still targets the original deadline; emulate expiry via the same code path used by the timer.
    (h.service as unknown as { onDeadline(id: string): void }).onDeadline(started.id);
    const paused = h.service.get(h.sessionId)!;
    expect(paused).toMatchObject({ state: 'paused', stopReason: 'limit', currentRunId: null });
    await idle(h);
    expect(h.t.app.store.bootstrapRuns().find((r) => r.id === started.currentRunId)?.status).toBe('interrupted');
    expect(() => h.service.resume(h.sessionId, { expectedVersion: paused.version })).toThrow(/time budget is used up/);
    expect(h.service.resume(h.sessionId, { expectedVersion: paused.version, extendMinutes: 30 })).toMatchObject({ state: 'running', limits: { maxElapsedMinutes: expect.any(Number) } });
  });

  it('stops on a denied approval even when the agent keeps going and reports completion', async () => {
    const h = await harness();
    h.scripts.push(async (o) => {
      const allowed = await o.requestApproval({ tool: 'Bash', description: 'rm -rf build', input: {} });
      expect(allowed).toBe(false);
      await finish(o, 'complete', 'Done anyway');
    });
    h.service.start(h.sessionId, { goal: 'Clean' });
    const approval = await waitFor(() => h.t.app.store.pendingApprovals(h.sessionId)[0], 6000, 'approval');
    h.t.app.runtime.decide(approval.id, 'denied');
    const paused = await settled(h);
    expect(paused).toMatchObject({ state: 'paused', stopReason: 'approval-denied' });
    expect(paused.summary).toMatch(/not applied/);
    expect(h.runs()).toBe(1);
  });

  it('stops when a provider question is cancelled', async () => {
    const h = await harness();
    h.scripts.push(async (o) => {
      await o.requestUserInput?.({ nativeRequestId: 'q1', tool: 'AskUserQuestion', questions: [{ id: 'a', header: 'Pick', question: 'Which?', options: [{ label: 'One' }, { label: 'Two' }], multiSelect: false, allowOther: false, secret: false }] });
      await new Promise<void>((resolve) => o.signal.aborted ? resolve() : o.signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    h.service.start(h.sessionId, { goal: 'Ask' });
    const q = await waitFor(() => h.t.app.store.listSessionQuestions(h.sessionId).find((x) => x.status === 'pending'), 6000, 'question');
    h.t.app.runtime.cancelUserQuestion(q.id);
    expect(await settled(h)).toMatchObject({ state: 'paused', stopReason: 'needs-input' });
  });

  it('pauses on a session configuration change instead of continuing', async () => {
    const h = await harness();
    h.scripts.push(async (o) => { await tool(o, 'mingle_plan_update', plan('in_progress')); edit(h, 'x.txt'); h.t.app.store.updateSession(h.sessionId, { effort: 'low' }); });
    h.service.start(h.sessionId, { goal: 'Change' });
    expect(await settled(h)).toMatchObject({ state: 'paused', stopReason: 'configuration-changed' });
    expect(h.runs()).toBe(1);
  });

  it('rejects stale controls, fences pending continuations after pause and cancels the active run before callbacks', async () => {
    const h = await harness();
    const entered = deferred<void>();
    h.scripts.push(async (o) => { entered.resolve(); await new Promise<void>((_r, reject) => o.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })); });
    const started = h.service.start(h.sessionId, { goal: 'Hold' });
    await entered.promise;
    expect(() => h.service.pause(h.sessionId, started.version - 1)).toThrow(/changed since/);
    expect(h.service.isRunning(h.sessionId)).toBe(true);
    const paused = h.service.pause(h.sessionId, h.service.get(h.sessionId)!.version);
    expect(paused).toMatchObject({ state: 'paused', stopReason: 'user-pause', currentRunId: null });
    expect(h.t.app.store.getSession(h.sessionId)!.status).not.toBe('idle');
    await idle(h);
    expect(h.runs()).toBe(1);
    // Passive bookkeeping after the interrupted run ended must not bump the version a person just received.
    expect(h.service.get(h.sessionId)!.version).toBe(paused.version);
    expect(() => h.service.pause(h.sessionId, paused.version)).toThrow(/Only a running/);
    const stopped = h.service.stop(h.sessionId, paused.version);
    expect(stopped).toMatchObject({ state: 'stopped', stopReason: 'user-stop' });
    expect(() => h.service.resume(h.sessionId, { expectedVersion: stopped.version })).toThrow(/already stopped|cannot be resumed/);
  });

  it('fences a continuation that was scheduled at the idle edge when Pause arrives first', async () => {
    const h = await harness();
    h.scripts.push(async () => { /* ends without a report, so a verification turn is scheduled */ });
    h.service.start(h.sessionId, { goal: 'Fence' });
    // Pause synchronously as soon as the first turn is recorded as ended: the microtask continuation must observe the new epoch.
    const original = h.t.app.runtime.drainQueued.bind(h.t.app.runtime);
    let paused = false;
    h.t.app.runtime.drainQueued = (id: string) => {
      const result = original(id);
      if (!paused && h.service.get(h.sessionId)?.counters.turns === 1) { paused = true; queueMicrotask(() => h.service.pause(h.sessionId, h.service.get(h.sessionId)!.version)); }
      return result;
    };
    await waitFor(() => paused, 6000, 'idle edge');
    await idle(h);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.runs()).toBe(1);
    expect(h.service.get(h.sessionId)).toMatchObject({ state: 'paused', stopReason: 'user-pause' });
  });

  it('waits for in-flight subagents without polling, adopts their result as a turn, and fences late results after Pause', async () => {
    const h = await harness();
    const { store } = h.t.app;
    const child = store.insertSession({ projectId: EXAMPLE_PROJECT_ID, name: '↳ helper', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: false, worktreePath: h.dir, branch: 'main', parentSessionId: h.sessionId });
    const row = { id: newId('run'), parentSessionId: h.sessionId, childSessionId: child.id, name: 'helper', provider: 'claude' as const, model: 'claude-sonnet-5-5', task: 'check', status: 'running' as const, requestedBy: 'agent' as const, startedAt: new Date().toISOString(), endedAt: null, resultPreview: null, error: null, resultDelivered: false };
    h.scripts.push(
      async (o) => { store.insertDelegatedSubagent(row); await tool(o, 'mingle_plan_update', plan('in_progress')); },
      async (o) => { await finish(o, 'complete', 'Used the helper result'); },
    );
    h.service.start(h.sessionId, { goal: 'Delegate' });
    await idle(h);
    await new Promise((r) => setTimeout(r, 80));
    expect(h.runs()).toBe(1); // awaiting: no continuation, no polling
    expect(h.service.get(h.sessionId)).toMatchObject({ state: 'running', currentRunId: null });
    store.updateDelegatedSubagent(row.id, { status: 'completed', endedAt: new Date().toISOString() });
    store.enqueueMessage({ id: newId('msg'), sessionId: h.sessionId, content: 'Subagent @helper (Claude m) finished.\n\nResult:\nok\n\nContinue your work using this result.', intent: 'normal', skills: [], attachmentIds: [], contextRefs: [] });
    h.t.app.runtime.drainQueued(h.sessionId);
    expect(await settled(h)).toMatchObject({ state: 'completed', counters: { turns: 2 } });
    expect(h.t.app.store.getTask(h.service.get(h.sessionId)!.taskId)!.status).toBe('review');
  });

  it('keeps late subagent results queued after Pause and delivers them after Resume', async () => {
    const h = await harness();
    const { store } = h.t.app;
    const entered = deferred<void>();
    const child = store.insertSession({ projectId: EXAMPLE_PROJECT_ID, name: '↳ late', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: false, worktreePath: h.dir, branch: 'main', parentSessionId: h.sessionId });
    store.insertDelegatedSubagent({ id: newId('run'), parentSessionId: h.sessionId, childSessionId: child.id, name: 'late', provider: 'claude', model: 'claude-sonnet-5-5', task: 'x', status: 'completed', requestedBy: 'agent', startedAt: new Date(Date.now() - 1000).toISOString(), endedAt: new Date().toISOString(), resultPreview: null, error: null, resultDelivered: false });
    h.scripts.push(
      async (o) => { entered.resolve(); await new Promise<void>((_r, reject) => o.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })); },
      async () => undefined,
      async (o) => { await tool(o, 'mingle_plan_update', plan('in_progress')); edit(h, 'resumed.txt'); },
      async (o) => { await finish(o, 'complete', 'ok'); },
    );
    h.service.start(h.sessionId, { goal: 'Late' });
    await entered.promise;
    const paused = h.service.pause(h.sessionId, h.service.get(h.sessionId)!.version);
    store.enqueueMessage({ id: newId('msg'), sessionId: h.sessionId, content: 'Subagent @late (Claude m) finished.\n\nResult:\nok', intent: 'normal', skills: [], attachmentIds: [], contextRefs: [] });
    await idle(h);
    h.t.app.runtime.drainQueued(h.sessionId);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.runs()).toBe(1);
    expect(store.listQueuedMessages(h.sessionId)).toHaveLength(1);
    // An explicit human message still starts a normal, un-adopted run.
    store.enqueueMessage({ id: 'queued-human', sessionId: h.sessionId, content: 'Hello, please also check X', intent: 'normal', skills: [], attachmentIds: [], contextRefs: [] });
    h.t.app.runtime.drainQueued(h.sessionId);
    await waitFor(() => h.runs() === 2, 4000, 'human run');
    await idle(h);
    expect(h.service.get(h.sessionId)).toMatchObject({ state: 'paused', counters: { turns: 1 } });
    h.service.resume(h.sessionId, { expectedVersion: paused.version });
    expect(await settled(h)).toMatchObject({ state: 'completed' });
    expect(store.listQueuedMessages(h.sessionId)).toHaveLength(0);
  });

  it('does not let a helper that was still running at completion start an unbudgeted parent turn later', async () => {
    const h = await harness();
    const { store } = h.t.app;
    const child = store.insertSession({ projectId: EXAMPLE_PROJECT_ID, name: '↳ old', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: false, worktreePath: h.dir, branch: 'main', parentSessionId: h.sessionId });
    const row = { id: newId('run'), parentSessionId: h.sessionId, childSessionId: child.id, name: 'old', provider: 'claude' as const, model: 'claude-sonnet-5-5', task: 'x', status: 'running' as const, requestedBy: 'agent' as const, startedAt: new Date().toISOString(), endedAt: null, resultPreview: null, error: null, resultDelivered: false };
    h.scripts.push(async (o) => { store.insertDelegatedSubagent(row); await finish(o, 'complete', 'Finished while a helper still ran'); });
    h.service.start(h.sessionId, { goal: 'Finish early' });
    const done = await settled(h);
    expect(done.state).toBe('completed');
    await idle(h);
    await new Promise((r) => setTimeout(r, 20));
    store.updateDelegatedSubagent(row.id, { status: 'completed', endedAt: new Date().toISOString() });
    store.enqueueMessage({ id: newId('msg'), sessionId: h.sessionId, content: 'Subagent @old (Claude m) finished.\n\nResult:\nok\n\nContinue your work using this result.', intent: 'normal', skills: [], attachmentIds: [], contextRefs: [] });
    h.t.app.runtime.drainQueued(h.sessionId);
    await new Promise((r) => setTimeout(r, 60));
    expect(h.runs()).toBe(1);
    expect(store.listQueuedMessages(h.sessionId)).toHaveLength(1);
    expect(h.service.get(h.sessionId)).toMatchObject({ state: 'completed', counters: { turns: 1 } });
    // Explicit human work and helpers started after completion remain possible.
    store.enqueueMessage({ id: 'queued-human', sessionId: h.sessionId, content: 'Now something new', intent: 'normal', skills: [], attachmentIds: [], contextRefs: [] });
    h.t.app.runtime.drainQueued(h.sessionId);
    await waitFor(() => h.runs() === 2, 4000, 'human run after completion');
    expect(h.service.get(h.sessionId)).toMatchObject({ state: 'completed', counters: { turns: 1 } });
  });

  it('adopts queued human input in FIFO order as a goal turn before any automatic continuation', async () => {
    const h = await harness();
    const entered = deferred<void>();
    const release = deferred<void>();
    h.scripts.push(
      async (o) => { await tool(o, 'mingle_plan_update', plan('in_progress')); entered.resolve(); await release.promise; edit(h, 'one.txt'); },
      async (o) => { await finish(o, 'complete', 'Followed the human'); },
    );
    h.service.start(h.sessionId, { goal: 'Queue' });
    await entered.promise;
    h.t.app.store.enqueueMessage({ id: 'queued-1', sessionId: h.sessionId, content: 'First human note', intent: 'normal', skills: [], attachmentIds: [], contextRefs: [] });
    release.resolve();
    expect(await settled(h)).toMatchObject({ state: 'completed', counters: { turns: 2 } });
    expect(prompts(h)[1]).toContain('First human note');
    expect(prompts(h)[1]).toContain('newest human message outranks the goal');
    expect(h.runs()).toBe(2);
    expect(h.t.app.store.getTask(h.service.get(h.sessionId)!.taskId)!.status).toBe('review');
  });

  it('adopts a direct human send between turns and counts it in the budget', async () => {
    const h = await harness();
    const { store } = h.t.app;
    const child = store.insertSession({ projectId: EXAMPLE_PROJECT_ID, name: '↳ w', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: false, worktreePath: h.dir, branch: 'main', parentSessionId: h.sessionId });
    store.insertDelegatedSubagent({ id: newId('run'), parentSessionId: h.sessionId, childSessionId: child.id, name: 'w', provider: 'claude', model: 'claude-sonnet-5-5', task: 't', status: 'running', requestedBy: 'agent', startedAt: new Date().toISOString(), endedAt: null, resultPreview: null, error: null, resultDelivered: false });
    h.scripts.push(async () => undefined, async (o) => { await finish(o, 'complete', 'Human guided'); });
    h.service.start(h.sessionId, { goal: 'Await' });
    await idle(h);
    await new Promise((r) => setTimeout(r, 50));
    h.t.app.runtime.start(h.sessionId, 'Actually do it this way', { deferContextResolution: true });
    expect(await settled(h)).toMatchObject({ state: 'completed', counters: { turns: 2 } });
    expect(store.listMessages(h.sessionId).filter((m) => m.role === 'user' && m.content === 'Actually do it this way')).toHaveLength(1);
  });

  it('leaves nothing behind when the runtime refuses to start, and rejects ineligible sessions', async () => {
    const h = await harness({ worktree: path.join(makeRepo(), 'does-not-exist') });
    const before = { tasks: h.t.app.store.listTasks(EXAMPLE_PROJECT_ID).length, messages: h.t.app.store.listMessages(h.sessionId).length };
    expect(() => h.service.start(h.sessionId, { goal: 'Nope' })).toThrow(/worktree no longer exists/);
    expect(h.service.get(h.sessionId)).toBeNull();
    expect(h.service.list()).toEqual([]);
    expect(h.t.app.store.listTasks(EXAMPLE_PROJECT_ID)).toHaveLength(before.tasks);
    expect(h.t.app.store.listMessages(h.sessionId)).toHaveLength(before.messages);
    expect(h.t.app.store.db.prepare('SELECT COUNT(*) AS n FROM session_workflow_runs').get()).toEqual({ n: 0 });
    expect(() => h.service.start(h.sessionId, { goal: '   ' })).toThrow();
    expect(() => h.service.start('missing', { goal: 'x' })).toThrow(/not found/i);
    const child = h.t.app.store.insertSession({ projectId: EXAMPLE_PROJECT_ID, name: 'c', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: false, worktreePath: h.dir, branch: 'main', parentSessionId: h.sessionId });
    expect(() => h.service.start(child.id, { goal: 'x' })).toThrow(/Subagent/);
  });

  it('pauses interrupted goals on restart, owns their runs, and the resume service skips them', async () => {
    const h = await harness();
    const entered = deferred<void>();
    h.scripts.push(async (o) => { entered.resolve(); await new Promise<void>((_r, reject) => o.signal.addEventListener('abort', () => reject(Object.assign(new Error('child stopped'), { signal: 'SIGTERM' })), { once: true })); });
    const started = h.service.start(h.sessionId, { goal: 'Survive' });
    await entered.promise;
    const runId = started.currentRunId!;
    // Crash: no orderly handling; storage still says running with a bound run.
    h.service.close();
    h.t.app.store.recoverRuns();
    h.t.app.store.enqueueSessionResume({ runId, sessionId: h.sessionId, reason: 'server-restarted', taskId: started.taskId });
    const restarted = new SessionWorkflowService({ store: h.t.app.store, runtime: h.t.app.runtime, tasks: new TaskService(h.t.app.store), groups: h.t.app.groups });
    expect(restarted.get(h.sessionId)).toMatchObject({ state: 'paused', stopReason: 'app-closed', currentRunId: null, lastRunId: runId });
    expect(restarted.ownsRun(runId)).toBe(true);
    expect(workflowOwnsRun(h.t.app.store.db, runId)).toBe(true);
    expect(h.t.app.store.getTask(started.taskId)!.status).toBe('ready');
    const resumeService = new SessionResumeService(h.t.app.store, h.t.app.runtime, h.t.app.providers, h.t.app.groups, () => undefined, restarted);
    resumeService.start(new AbortController().signal);
    await waitFor(() => h.t.app.store.db.prepare("SELECT skipped_reason AS r FROM session_resume_queue WHERE run_id=?").get(runId), 4000, 'resume skip');
    expect(h.t.app.store.db.prepare('SELECT skipped_reason AS r, state FROM session_resume_queue WHERE run_id=?').get(runId)).toMatchObject({ state: 'skipped', r: 'workflow-managed' });
    expect(h.runs()).toBe(1);
  });

  it('exposes the finish tool only to workflow turns, bound to the live run', async () => {
    const h = await harness();
    const seen: string[][] = [];
    let ordinary: RunOptions | undefined;
    h.scripts.push(
      async (o) => { await finish(o, 'complete', 'ok'); },
      async (o) => {
        ordinary = o;
        const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(o.progressMcp!.url), { requestInit: { headers: { Authorization: `Bearer ${o.progressMcp!.token}` } } }));
        seen.push((await client.listTools()).tools.map((x) => x.name));
      },
    );
    h.service.start(h.sessionId, { goal: 'Tools' });
    await settled(h);
    await idle(h);
    h.t.app.runtime.start(h.sessionId, 'plain chat message', {});
    await waitFor(() => seen.length === 1, 5000, 'tool listing');
    expect(seen[0]).toEqual(['mingle_status_set', 'mingle_plan_update']);
    expect(ordinary).toBeDefined();
    expect(h.service.get(h.sessionId)!.state).toBe('completed');
  });
});
