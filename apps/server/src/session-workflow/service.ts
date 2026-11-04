import { StartSessionWorkflowSchema, ResumeSessionWorkflowSchema, type SessionWorkflow, type WorkflowFinish, type WorkflowStopReason } from '@mingle/contracts';
import type { QueuedMessage, Session, DelegatedSubagent, RunReviewGoalTurn } from '@mingle/contracts';
import type { GroupService } from '../groups/service.ts';
import type { RecoveryService } from '../recovery/service.ts';
import type { SessionRuntime, StartOptions } from '../runtime.ts';
import type { ProviderFailure } from '@mingle/contracts';
import type { Store } from '../store.ts';
import type { TaskService } from '../tasks.ts';
import type { Logger } from '../types.ts';
import { badRequest, conflict, errorMessage, notFound, nowIso, redactSecrets, truncate } from '../util.ts';
import type { RunEndInfo, SessionWorkflowHooks, WorkflowRunBinding, WorkflowRunKind } from './hooks.ts';
import { adoptedContext, continuePrompt, describeReason, resumePrompt, startPrompt, verifyPrompt } from './prompts.ts';
import { newWorkflowId, snapshot, WorkflowRepo, type WorkflowRow, type WorkflowRunRow } from './repo.ts';

const HARD_MAX_TURNS = 50;
const HARD_MAX_MINUTES = 1440;
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface SessionWorkflowServiceOptions {
  store: Store;
  runtime: SessionRuntime;
  tasks: TaskService;
  /** Accepted for the documented seam; checkpoints are captured by the runtime around every run. */
  recovery?: RecoveryService;
  groups: Pick<GroupService, 'forSession'>;
  log?: Logger;
}

type Next = 'continue' | 'verify' | 'await';
interface Verdict {
  state: 'running' | 'paused' | 'completed';
  reason: WorkflowStopReason | null;
  summary: string | null;
  stalls: number;
  next: Next | null;
  report: 'applied' | 'discarded' | null;
}

const sameConfiguration = (a: SessionWorkflow['configuration'], b: SessionWorkflow['configuration']): boolean =>
  a.provider === b.provider && a.model === b.model && a.effort === b.effort && a.policy === b.policy
  && a.serviceTier === b.serviceTier && a.worktreePath === b.worktreePath && a.branch === b.branch;

function pinned(session: Session): SessionWorkflow['configuration'] {
  return { provider: session.provider, model: session.model, effort: session.effort, policy: session.policy, serviceTier: session.serviceTier ?? 'standard', worktreePath: session.worktreePath, branch: session.branch };
}

const clean = (text: string, max: number): string => truncate(redactSecrets(text).replaceAll('\0', ''), max);

/**
 * Bounded autonomous work for one standalone session. It never changes the session's provider, model, permissions or
 * worktree; it only asks the agent for follow-up turns at the runtime's idle edge, and stops at every human boundary.
 */
export class SessionWorkflowService {
  private readonly store: Store;
  private readonly runtime: SessionRuntime;
  private readonly tasks: TaskService;
  private readonly groups: Pick<GroupService, 'forSession'>;
  private readonly log: Logger;
  private readonly repo: WorkflowRepo;
  private readonly recovery: RecoveryService | undefined;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Bumped by every control transition; a scheduled continuation carries the epoch it was created in. */
  private readonly fences = new Map<string, number>();
  /** What the workflow intends to do at its next idle edge (survives unrelated interjected runs; cleared when a turn binds). */
  private readonly pendingNext = new Map<string, Next>();
  private closed = false;

  constructor(options: SessionWorkflowServiceOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.tasks = options.tasks;
    this.groups = options.groups;
    this.recovery = options.recovery;
    this.log = options.log ?? (() => undefined);
    this.repo = new WorkflowRepo(options.store.db);
    this.recover();
    this.runtime.setWorkflowHooks(this.hooks);
  }

  // ---- public seam --------------------------------------------------------------------------------------------------

  get(sessionId: string): SessionWorkflow | null {
    const row = this.repo.latest(sessionId);
    return row ? snapshot(row) : null;
  }

  list(): SessionWorkflow[] {
    return this.repo.latestPerSession().filter((row) => this.store.getSession(row.sessionId, true)).map(snapshot);
  }

  isRunning(sessionId: string): boolean { return this.repo.open(sessionId)?.state === 'running'; }

  ownsRun(runId: string): boolean { return this.repo.ownsRun(runId); }

  /** Exact goal-turn binding and report of one run, from its own durable row; never the goal's latest summary. */
  goalTurn(runId: string): RunReviewGoalTurn | null {
    const row = this.repo.run(runId);
    if (!row) return null;
    const report = row.report && row.reportState !== 'none' ? { outcome: row.report.outcome, summary: clean(row.report.summary, 2000), state: row.reportState } : null;
    return { workflowId: row.workflowId, sequence: row.seq, kind: row.kind, report };
  }

  start(sessionId: string, input: unknown): SessionWorkflow {
    const parsed = StartSessionWorkflowSchema.safeParse(input);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'The goal request is invalid.');
    const body = parsed.data;
    const session = this.eligibleSession(sessionId);
    if (this.repo.open(sessionId)) throw conflict('This session already has a goal in progress. Stop it before starting another.');
    for (const ref of body.contextRefs ?? []) {
      if (ref.kind === 'quote' && (ref.sourceGroupId || ref.sourceSessionId !== sessionId)) throw badRequest('A quoted source must come from this session. Choose text from a message in this conversation.');
      if (ref.kind === 'file' && ref.sourceSessionId !== sessionId) throw badRequest('A file reference must come from this session worktree. Choose the file again.');
    }
    const createdAt = nowIso();
    const row: WorkflowRow = {
      id: newWorkflowId(), sessionId, projectId: session.projectId, taskId: '', goal: body.goal, state: 'running', version: 1,
      stopReason: null, summary: null, limits: body.limits, counters: { turns: 0, stalls: 0 }, currentRunId: null, lastRunId: null,
      configuration: pinned(session), createdAt, updatedAt: createdAt, deadlineAt: new Date(Date.parse(createdAt) + body.limits.maxElapsedMinutes * 60_000).toISOString(),
      checklist: null, endedAt: null,
    };
    // One transaction: if the runtime refuses the start, no task, workflow row, run, message or attachment claim survives.
    this.store.tx(() => {
      const title = clean(`Goal: ${body.goal.split('\n')[0]!.trim()}`, 200);
      const task = this.tasks.create({ projectId: session.projectId, title, description: clean(body.goal, 20_000), acceptanceCriteria: '', sessionId, dependsOn: [] });
      row.taskId = task.id;
      this.repo.insert(row);
      const startRunId = this.runtime.start(sessionId, startPrompt(body.goal, row), {
        excludeProjectMemory: body.memory === 'exclude',
        taskId: task.id, userMessage: { content: body.goal, kind: 'workflow-start' },
        ...(body.attachmentIds?.length ? { attachmentIds: body.attachmentIds } : {}), ...(body.contextRefs?.length ? { contextRefs: body.contextRefs } : {}),
        deferContextResolution: true, workflow: { workflowId: row.id, kind: 'start' },
      });
      if (body.memory === 'exclude') this.store.setRunMemoryExcluded(startRunId);
      this.announce(this.repo.get(row.id)!, 'started', `Autonomous goal started (up to ${body.limits.maxTurns} turns, ${body.limits.maxElapsedMinutes} minutes).`, false);
    });
    const started = this.repo.get(row.id)!;
    this.armTimer(started);
    return snapshot(started);
  }

  pause(sessionId: string, expectedVersion: number): SessionWorkflow {
    const wf = this.controllable(sessionId, expectedVersion);
    if (wf.state !== 'running') throw conflict('Only a running goal can be paused.');
    return snapshot(this.detach(wf, { state: 'paused', stopReason: 'user-pause', summary: 'Paused by a person.' }, 'paused', 'Autonomous goal paused. Any partial work from the interrupted turn stays in the worktree.'));
  }

  stop(sessionId: string, expectedVersion: number): SessionWorkflow {
    const wf = this.controllable(sessionId, expectedVersion);
    return snapshot(this.detach(wf, { state: 'stopped', stopReason: 'user-stop', summary: 'Stopped by a person.', endedAt: nowIso() }, 'stopped', 'Autonomous goal stopped by a person.'));
  }

  /** Stops a running or paused goal without a version check (used before a native interrupt). */
  stopActive(sessionId: string): SessionWorkflow | null {
    const wf = this.repo.open(sessionId);
    if (!wf) return null;
    return snapshot(this.detach(wf, { state: 'stopped', stopReason: 'user-stop', summary: 'Stopped by a person.', endedAt: nowIso() }, 'stopped', 'Autonomous goal stopped by a person.'));
  }

  resume(sessionId: string, input: unknown): SessionWorkflow {
    const parsed = ResumeSessionWorkflowSchema.safeParse(input);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'The resume request is invalid.');
    const { expectedVersion, additionalTurns, extendMinutes } = parsed.data;
    const wf = this.controllable(sessionId, expectedVersion);
    if (wf.state !== 'paused') throw conflict(wf.state === 'running' ? 'This goal is already running.' : 'A stopped or completed goal cannot be resumed. Start a new goal.');
    const session = this.eligibleSession(sessionId);
    const now = Date.now();
    const limits = { ...wf.limits, maxTurns: Math.min(HARD_MAX_TURNS, wf.limits.maxTurns + (additionalTurns ?? 0)) };
    if (wf.counters.turns >= limits.maxTurns) {
      throw conflict(wf.limits.maxTurns >= HARD_MAX_TURNS ? 'The hard 50-turn limit is used up. Start a new goal.' : 'The turn budget is used up. Resume with additional turns to continue.');
    }
    let deadline = Date.parse(wf.deadlineAt);
    if (extendMinutes) {
      deadline = Math.min(Math.max(now, deadline) + extendMinutes * 60_000, Date.parse(wf.createdAt) + HARD_MAX_MINUTES * 60_000);
      limits.maxElapsedMinutes = Math.min(HARD_MAX_MINUTES, Math.max(limits.maxElapsedMinutes, Math.ceil((deadline - Date.parse(wf.createdAt)) / 60_000)));
    }
    if (deadline <= now) {
      throw conflict(Date.parse(wf.createdAt) + HARD_MAX_MINUTES * 60_000 <= now ? 'The hard 24-hour limit is reached. Start a new goal.' : 'The time budget is used up. Resume with extra minutes to continue.');
    }
    const queued = this.store.listQueuedMessages(sessionId).length;
    this.store.tx(() => {
      const next = this.persist(wf, {
        state: 'running', stopReason: null, summary: null, limits, counters: { turns: wf.counters.turns, stalls: 0 },
        configuration: pinned(session), deadlineAt: new Date(deadline).toISOString(),
      });
      this.bump(wf.id);
      this.runtime.start(sessionId, resumePrompt(wf, queued), {
        taskId: wf.taskId, userMessage: { content: 'Resuming the goal after a pause.', kind: 'workflow-resume' }, workflow: { workflowId: wf.id, kind: 'resume' },
      });
      this.announce(this.repo.get(next.id)!, 'resumed', 'Autonomous goal resumed.', false);
    });
    const resumed = this.repo.get(wf.id)!;
    this.armTimer(resumed);
    return snapshot(resumed);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pendingNext.clear();
    this.runtime.setWorkflowHooks(undefined);
  }

  // ---- eligibility and control helpers -----------------------------------------------------------------------------

  private eligibleSession(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) throw notFound('Session not found');
    if (!this.store.getProject(session.projectId)) throw notFound('Project not found');
    if (session.parentSessionId) throw conflict('Subagent sessions cannot run an autonomous goal.');
    if (this.groups.forSession(sessionId) || this.store.isGroupSession(sessionId)) throw conflict('Grouped sessions are coordinated by their group. Use a standalone session for an autonomous goal.');
    if (this.store.isTeamProxySession(sessionId)) throw conflict('Remote team agents cannot run an autonomous goal on this device.');
    if (!this.runtime.supportsWorkflowFinish()) throw conflict('This Mingle build cannot give the agent its goal-report tool.');
    if (this.runtime.isActive(sessionId) || session.status === 'running' || session.status === 'waiting') throw conflict('This session is busy. Wait for its current run or provider cleanup to finish.');
    return session;
  }

  private controllable(sessionId: string, expectedVersion: number): WorkflowRow {
    const wf = this.repo.latest(sessionId);
    if (!wf) throw notFound('No goal found for this session');
    if (!Number.isInteger(expectedVersion) || expectedVersion !== wf.version) throw conflict('This goal changed since you loaded it. Refresh and try again.');
    if (wf.state === 'stopped' || wf.state === 'completed') throw conflict(`This goal is already ${wf.state}.`);
    return wf;
  }

  private bump(id: string): number {
    const next = (this.fences.get(id) ?? 0) + 1;
    this.fences.set(id, next);
    return next;
  }

  /** Writes a new version of the row (compare-and-set). */
  private persist(wf: WorkflowRow, patch: Partial<WorkflowRow>): WorkflowRow {
    const next: WorkflowRow = { ...wf, ...patch, version: wf.version + 1, updatedAt: nowIso() };
    if (!this.repo.update(next, wf.version)) throw conflict('This goal changed concurrently. Refresh and try again.');
    return next;
  }

  private announce(wf: WorkflowRow, kind: 'started' | 'resumed' | 'paused' | 'stopped' | 'completed' | 'turn', text: string, chat = true): void {
    if (chat) this.store.insertMessage({ sessionId: wf.sessionId, role: 'system', kind: 'info', content: text });
    this.store.recordEvent({
      projectId: wf.projectId, sessionId: wf.sessionId, type: `session.workflow.${kind}`, summary: text,
      payload: { workflowId: wf.id, taskId: wf.taskId, state: wf.state, stopReason: wf.stopReason, version: wf.version, turns: wf.counters.turns },
    });
  }

  /** Control transition that ends or pauses the current turn: state first, fence next, interrupt last. */
  private detach(wf: WorkflowRow, patch: Partial<WorkflowRow>, kind: 'paused' | 'stopped', text: string): WorkflowRow {
    const runId = wf.currentRunId;
    const next = this.store.tx(() => {
      const written = this.persist(wf, { ...patch, currentRunId: null, lastRunId: runId ?? wf.lastRunId });
      if (runId) this.repo.setReportState(runId, 'discarded');
      this.announce(written, kind, text);
      return written;
    });
    this.bump(wf.id);
    this.clearTimer(wf.id);
    this.repo.cancelRetries(wf.id);
    this.pendingNext.delete(wf.id);
    if (runId) this.runtime.interrupt(wf.sessionId);
    return next;
  }

  // ---- deadline -----------------------------------------------------------------------------------------------------

  private armTimer(wf: WorkflowRow): void {
    this.clearTimer(wf.id);
    if (this.closed || wf.state !== 'running') return;
    const retry = this.repo.retryForWorkflow(wf.id);
    const deadline = Date.parse(wf.deadlineAt);
    const due = retry?.status === 'pending' ? Math.min(deadline, Date.parse(retry.retryAt)) : deadline;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, due - Date.now()));
    const timer = setTimeout(() => this.onDeadline(wf.id), delay);
    timer.unref();
    this.timers.set(wf.id, timer);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  private onDeadline(id: string): void {
    this.timers.delete(id);
    const wf = this.repo.get(id);
    if (this.closed || !wf || wf.state !== 'running') return;
    const retry = this.repo.retryForWorkflow(id);
    if (retry?.status === 'pending' && Date.parse(retry.retryAt) <= Date.now() && Date.now() < Date.parse(wf.deadlineAt)) {
      const next = this.pendingNext.get(id);
      if (next && next !== 'await') {
        const epoch = this.fences.get(id) ?? 0;
        queueMicrotask(() => this.continueNow(id, epoch, next));
      }
      return;
    }
    // A timer can wake before its target millisecond. Recheck the durable deadline
    // instead of treating an early retry wakeup as an exhausted time budget.
    if (Date.now() < Date.parse(wf.deadlineAt)) {
      this.armTimer(wf);
      return;
    }
    try {
      this.detach(wf, { state: 'paused', stopReason: 'limit', summary: `The ${wf.limits.maxElapsedMinutes}-minute time budget was reached.` }, 'paused', `Autonomous goal paused: the ${wf.limits.maxElapsedMinutes}-minute time budget was reached.`);
    } catch (error) { this.log('error', 'Could not pause a goal at its deadline', error); }
  }

  // ---- startup recovery -------------------------------------------------------------------------------------------

  /** A goal left "running" by a crash or exit is paused: nothing is retried until a person inspects the partial work. */
  private recover(): void {
    for (const retry of this.repo.pendingRetries()) {
      const wf = this.repo.get(retry.workflowId);
      this.repo.cancelRetries(retry.workflowId);
      if (wf?.state === 'running' && !wf.currentRunId) {
        try { this.pauseWith(wf, 'app-closed', 'Mingle was closed before a scheduled automatic retry started. Inspect the partial work, then resume manually.'); }
        catch (error) { this.log('error', `Could not pause workflow ${wf.id} after closing a pending retry`, error); }
      }
    }
    for (const wf of this.repo.running()) {
      try {
        this.store.tx(() => {
          this.repo.closeOpenRuns(wf.id, nowIso());
          const written = this.persist(wf, {
            state: 'paused', stopReason: 'app-closed', currentRunId: null, lastRunId: wf.currentRunId ?? wf.lastRunId,
            summary: 'Mingle was closed while this goal was running. Inspect the partial work, then resume.',
          });
          if (this.store.getTask(wf.taskId)) this.tasks.finishRun(wf.taskId, 'interrupted');
          this.announce(written, 'paused', 'Autonomous goal paused because Mingle was closed. Inspect the partial work, then resume.');
        });
      } catch (error) { this.log('error', `Could not recover goal ${wf.id}`, error); }
    }
  }

  // ---- runtime hooks ------------------------------------------------------------------------------------------------

  private wakeupRow(sessionId: string, content: string): DelegatedSubagent | null {
    const name = /^Subagent @(\S+) /.exec(content)?.[1];
    return name ? this.store.listDelegatedSubagents(sessionId).find((row) => row.name === name) ?? null : null;
  }

  private childrenRunning(sessionId: string): boolean {
    return this.store.listDelegatedSubagents(sessionId).some((row) => row.status === 'running');
  }

  private readonly hooks: SessionWorkflowHooks = {
    prepareStart: (sessionId, content, options) => this.prepareStart(sessionId, content, options),
    runBound: (info) => this.runBound(info),
    recordReplayPrompt: (info) => this.repo.setReplayPrompt(info.runId, info.prompt, info.context),
    recordReport: (info) => this.recordReport(info),
    runEnded: (info) => this.runEnded(info),
    idle: (info) => this.idle(info),
    allowQueuedStart: (sessionId, item) => this.allowQueuedStart(sessionId, item),
  };

  private prepareStart(sessionId: string, content: string, options: StartOptions): StartOptions {
    if (options.workflow) {
      const wf = this.repo.get(options.workflow.workflowId);
      if (!wf || wf.sessionId !== sessionId || wf.state !== 'running' || wf.currentRunId || options.taskId !== wf.taskId) throw conflict('This goal is not ready for another turn.');
      return options;
    }
    const wf = this.repo.open(sessionId);
    if (!wf || wf.state !== 'running' || wf.currentRunId) return options;
    const retry = this.repo.retryForWorkflow(wf.id);
    if (retry && !options.workflow) {
      this.repo.cancelRetries(wf.id);
      this.bump(wf.id);
      this.pendingNext.delete(wf.id);
      this.store.recordEvent({ projectId: wf.projectId, sessionId, type: 'session.workflow.retry-cancelled', summary: 'Pending automatic retry cancelled because new session work arrived.', payload: { workflowId: wf.id, state: 'running', reason: options.origin === 'queue' ? 'queued-input' : 'new-human-work' } });
    }
    if (options.intent === 'plan' || options.executionPlanId || options.taskId || options.invocation) {
      throw conflict('Pause autonomous work before starting a different task, native command or read-only plan in this session.');
    }
    if (wf.counters.turns >= wf.limits.maxTurns || Date.now() >= Date.parse(wf.deadlineAt)) {
      this.pauseWith(wf, 'limit', 'The goal reached its turn or time budget before this turn could start.');
      throw conflict('The autonomous goal reached its budget and is paused. Resume it with an explicit extension or send your message again as ordinary chat.');
    }
    const kind: WorkflowRunKind = options.origin === 'queue' ? (this.wakeupRow(sessionId, content) ? 'wakeup' : 'queue') : 'human';
    return {
      ...options, taskId: wf.taskId, workflow: { workflowId: wf.id, kind } satisfies WorkflowRunBinding,
      context: [options.context, adoptedContext(wf)].filter(Boolean).join('\n\n'),
    };
  }

  private runBound(info: { sessionId: string; runId: string; workflow: WorkflowRunBinding }): void {
    const wf = this.repo.get(info.workflow.workflowId);
    if (!wf || wf.sessionId !== info.sessionId || wf.state !== 'running' || wf.currentRunId) throw conflict('This goal is not ready for another turn.');
    if (wf.counters.turns >= wf.limits.maxTurns) throw conflict('The goal has used its turn budget.');
    const humanTurn = info.workflow.kind === 'human' || info.workflow.kind === 'queue';
    const written = this.persist(wf, { counters: { turns: wf.counters.turns + 1, stalls: humanTurn ? 0 : wf.counters.stalls }, currentRunId: info.runId });
    this.repo.insertRun({ runId: info.runId, workflowId: wf.id, sessionId: wf.sessionId, seq: written.counters.turns, kind: info.workflow.kind, startedAt: nowIso() });
    if (info.workflow.retryOfRunId) this.repo.consumeRetry(info.workflow.retryOfRunId, info.runId);
    this.pendingNext.delete(wf.id);
    if (info.workflow.kind !== 'start' && info.workflow.kind !== 'resume') this.announce(written, 'turn', `Goal turn ${written.counters.turns} of ${written.limits.maxTurns} started (${info.workflow.kind}).`, false);
  }

  private recordReport(info: { sessionId: string; runId: string; report: WorkflowFinish }): void {
    const bound = this.repo.run(info.runId);
    const wf = bound ? this.repo.get(bound.workflowId) : undefined;
    if (!bound || !wf || wf.sessionId !== info.sessionId || wf.state !== 'running' || wf.currentRunId !== info.runId) throw conflict('This goal turn is no longer active.');
    const report: WorkflowFinish = { outcome: info.report.outcome, summary: clean(info.report.summary, 2000) };
    if (!this.repo.setReport(info.runId, report)) throw conflict('This goal turn is no longer active.');
  }

  private configProblem(wf: WorkflowRow): { reason: WorkflowStopReason; summary: string } | null {
    const session = this.store.getSession(wf.sessionId);
    if (!session) return { reason: 'session-unavailable', summary: 'The session was archived or removed.' };
    if (session.parentSessionId || this.groups.forSession(wf.sessionId)) return { reason: 'session-unavailable', summary: 'The session joined a group or became a subagent.' };
    if (!sameConfiguration(wf.configuration, pinned(session))) return { reason: 'configuration-changed', summary: 'The session provider, model, effort, permission level or worktree changed after the goal started.' };
    return null;
  }

  private runEnded(info: RunEndInfo): void {
    const bound = this.repo.run(info.runId);
    if (!bound) return;
    this.repo.endRun(info.runId, info.outcome, nowIso());
    const wf = this.repo.get(bound.workflowId);
    if (!wf) return;
    if (wf.currentRunId !== info.runId) { this.repo.setReportState(info.runId, 'discarded'); return; }
    const autoRetry = this.makeAutomaticRetry(wf, bound, info);
    const verdict = autoRetry ? { state: 'running', reason: null, summary: 'Automatic retry pending.', stalls: wf.counters.stalls, next: bound.kind as Next, report: null } satisfies Verdict : this.evaluate(wf, bound, info);
    this.store.tx(() => {
      const terminal = verdict.state !== 'running';
      const written = this.persist(wf, {
        currentRunId: null, lastRunId: info.runId, counters: { turns: wf.counters.turns, stalls: verdict.stalls },
        state: verdict.state, stopReason: verdict.reason, summary: verdict.summary, checklist: info.checklist ?? wf.checklist,
        ...(terminal && verdict.state === 'completed' ? { endedAt: nowIso() } : {}),
      });
      if (verdict.report) this.repo.setReportState(info.runId, verdict.report);
      if (autoRetry) {
        this.store.insertMessage({ sessionId: wf.sessionId, role: 'system', kind: 'info', content: 'Automatic retry pending for this generated workflow turn. It will use the same provider, model and workflow prompt.' });
        this.store.recordEvent({ projectId: wf.projectId, sessionId: wf.sessionId, type: 'session.workflow.retry-pending', summary: 'Automatic retry pending for a safe, undispatched workflow turn.', payload: { workflowId: wf.id, originalRunId: info.runId, retryAt: this.repo.retryForWorkflow(wf.id)?.retryAt ?? null, state: 'running' } });
      }
      if (verdict.state === 'completed') {
        this.announce(written, 'completed', `The agent reported the goal complete: ${verdict.summary} This is the agent's own report; Mingle has not independently verified it. The task is waiting in Review.`);
      } else if (verdict.state === 'paused') {
        this.announce(written, 'paused', `Autonomous goal paused (${describeReason(verdict.reason!)}). ${verdict.summary ?? ''}`.trim());
      }
    });
    if (verdict.state !== 'running') {
      this.bump(wf.id);
      this.clearTimer(wf.id);
      this.pendingNext.delete(wf.id);
    } else if (verdict.next) {
      this.pendingNext.set(wf.id, verdict.next);
      if (autoRetry) this.armTimer(this.repo.get(wf.id)!);
    }
  }

  private makeAutomaticRetry(wf: WorkflowRow, run: WorkflowRunRow, info: RunEndInfo): boolean {
    if (!this.recovery || info.outcome !== 'failed' || info.shutdown || run.kind !== 'continue' && run.kind !== 'verify') return false;
    if (this.repo.isRetryRun(info.runId) || !run.prompt || run.context === null || info.toolCalls !== 0 || info.changedFiles !== 0) return false;
    const b = info.boundary;
    if (b.approvalsDenied || b.approvalsExpired || b.approvalsCancelled || b.questionsCancelled) return false;
    const failure: ProviderFailure | null = this.recovery.failureForRun(info.runId);
    if (!failure || failure.retryable !== true || failure.safeToRetry !== true || failure.dispatchState !== 'not-dispatched'
      || failure.outcomeUnknown !== false || failure.continuationSafety !== 'safe'
      || !['temporary_rate_limit', 'provider_unavailable'].includes(failure.kind) || failure.providerCode === 'refusal') return false;
    const session = this.store.getSession(wf.sessionId);
    if (failure.sessionId !== wf.sessionId || failure.provider !== wf.configuration.provider || !session?.providerSessionId) return false;
    const retryAt = failure.retryAt ? Date.parse(failure.retryAt) : Date.now();
    if (!Number.isFinite(retryAt) || retryAt < Date.now() - 1000 || retryAt > Date.now() + 86_400_000) return false;
    if (wf.counters.turns >= wf.limits.maxTurns || Date.now() >= Date.parse(wf.deadlineAt) || retryAt >= Date.parse(wf.deadlineAt)) return false;
    return this.repo.scheduleRetry({ originalRunId: run.runId, workflowId: wf.id, sessionId: wf.sessionId,
      taskId: wf.taskId, conversationId: session.providerSessionId, kind: run.kind, prompt: run.prompt, context: run.context,
      configJson: JSON.stringify(wf.configuration), retryAt: new Date(retryAt).toISOString(), status: 'pending', retryRunId: null });
  }

  private evaluate(wf: WorkflowRow, run: WorkflowRunRow, info: RunEndInfo): Verdict {
    const pause = (reason: WorkflowStopReason, summary: string, report: Verdict['report'] = run.reportState === 'pending' ? 'discarded' : null): Verdict =>
      ({ state: 'paused', reason, summary: clean(summary, 600), stalls: wf.counters.stalls, next: null, report });
    const report = run.reportState === 'pending' ? run.report : null;
    const note = report ? ' The agent\'s own report was not applied.' : '';
    if (info.shutdown) return pause('app-closed', 'Mingle was closed while this turn was running. Inspect the partial work, then resume.');
    const boundary = info.boundary;
    if (boundary.approvalsDenied || boundary.approvalsExpired) return pause('approval-denied', `An approval request was ${boundary.approvalsDenied ? 'denied' : 'left unanswered'}; the goal was not continued.${note}`);
    if (boundary.questionsCancelled) return pause('needs-input', `A question from the agent was cancelled or went unanswered.${note}`);
    if (info.outcome === 'failed') {
      const code = info.failureInfo?.providerCode;
      const reason: WorkflowStopReason = code === 'refusal' ? 'refused' : info.failureInfo?.kind === 'quota_exhausted' ? 'quota' : 'failure';
      const uncertain = info.failureInfo?.outcomeUnknown ? ' The provider may have partly executed the turn, so check the worktree before resuming.' : '';
      return pause(reason, `${reason === 'refused' ? 'The provider refused to continue.' : 'The provider run failed.'} ${info.failureInfo?.message ?? info.failure ?? ''} It was not retried automatically.${uncertain}`);
    }
    if (info.outcome === 'interrupted') return pause('user-pause', 'The turn was stopped before it finished.');

    if (report) {
      const summary = report.summary;
      if (report.outcome === 'complete') return { state: 'completed', reason: 'goal-complete', summary, stalls: wf.counters.stalls, next: null, report: 'applied' };
      if (report.outcome === 'blocked') return { ...pause('agent-blocked', summary), report: 'applied' };
      return { ...pause('needs-input', summary), report: 'applied' };
    }
    const problem = this.configProblem(wf);
    if (problem) return pause(problem.reason, problem.summary);
    if (wf.counters.turns >= wf.limits.maxTurns) return pause('limit', `The ${wf.limits.maxTurns}-turn budget was used.`);
    if (Date.now() >= Date.parse(wf.deadlineAt)) return pause('limit', `The ${wf.limits.maxElapsedMinutes}-minute time budget was reached.`);
    if (this.childrenRunning(wf.sessionId)) return { state: 'running', reason: null, summary: null, stalls: wf.counters.stalls, next: 'await', report: null };

    const checklist = info.checklist ?? wf.checklist;
    const open = (checklist?.open ?? 0) > 0;
    if (run.kind === 'verify' && !open) return pause('unreported-outcome', 'The agent ended its turn twice without reporting the goal as complete, blocked or needing a person. Review the conversation, then resume or stop.');
    if (!open) return { state: 'running', reason: null, summary: null, stalls: wf.counters.stalls, next: 'verify', report: null };
    const progressed = (info.changedFiles ?? 0) > 0 || Boolean(info.checklist && info.checklist.fingerprint !== wf.checklist?.fingerprint);
    const humanTurn = run.kind === 'human' || run.kind === 'queue';
    const stalls = progressed || humanTurn ? 0 : wf.counters.stalls + 1;
    if (stalls >= wf.limits.maxStalls) return { ...pause('stalled', `${stalls} consecutive turn${stalls === 1 ? '' : 's'} changed no files and did not move the checklist.`), stalls };
    return { state: 'running', reason: null, summary: null, stalls, next: 'continue', report: null };
  }

  private idle(info: RunEndInfo & { sessionActive: boolean }): void {
    if (this.closed) return;
    const wf = this.repo.open(info.sessionId);
    if (!wf || wf.state !== 'running' || wf.currentRunId) return;
    const next = this.pendingNext.get(wf.id);
    if (!next || next === 'await') return;
    if (info.sessionActive || this.runtime.isActive(info.sessionId)) return;
    if (this.store.listQueuedMessages(info.sessionId).length) {
      this.pauseWith(wf, 'session-unavailable', 'Queued input could not be started, so the goal did not jump ahead of it. Resolve the queue, then resume.');
      return;
    }
    const epoch = this.fences.get(wf.id) ?? 0;
    const retry = this.repo.retryForWorkflow(wf.id);
    if (retry?.status === 'pending') {
      this.armTimer(wf);
      return;
    }
    queueMicrotask(() => this.continueNow(wf.id, epoch, next));
  }

  private continueNow(id: string, epoch: number, next: Exclude<Next, 'await'>): void {
    if (this.closed || (this.fences.get(id) ?? 0) !== epoch) return;
    const wf = this.repo.get(id);
    if (!wf || wf.state !== 'running' || wf.currentRunId || this.pendingNext.get(id) !== next) return;
    if (this.runtime.isActive(wf.sessionId)) return;
    if (this.store.listQueuedMessages(wf.sessionId).length) { this.pauseWith(wf, 'session-unavailable', 'Queued input arrived before the next turn, so the goal did not jump ahead of it.'); return; }
    const problem = this.configProblem(wf);
    if (problem) { this.pauseWith(wf, problem.reason, problem.summary); return; }
    if (wf.counters.turns >= wf.limits.maxTurns) { this.pauseWith(wf, 'limit', `The ${wf.limits.maxTurns}-turn budget was used.`); return; }
    if (Date.now() >= Date.parse(wf.deadlineAt)) { this.pauseWith(wf, 'limit', `The ${wf.limits.maxElapsedMinutes}-minute time budget was reached.`); return; }
    const turn = `${wf.counters.turns + 1} of ${wf.limits.maxTurns}`;
    const retry = this.repo.retryForWorkflow(wf.id);
    if (retry) {
      const session = this.store.getSession(wf.sessionId);
      let config: unknown;
      try { config = JSON.parse(retry.configJson); } catch { config = null; }
      if (retry.status !== 'pending' || !session || session.providerSessionId !== retry.conversationId || wf.taskId !== retry.taskId || JSON.stringify(pinned(session)) !== retry.configJson || JSON.stringify(wf.configuration) !== retry.configJson || !sameConfiguration(wf.configuration, pinned(session)) || this.groups.forSession(wf.sessionId)) {
        this.pauseWith(wf, 'configuration-changed', 'Automatic retry paused because the saved session configuration changed. Review the run, then resume manually.');
        return;
      }
      if (!config || !this.repo.claimRetry(retry.originalRunId)) return;
      try {
        this.runtime.start(wf.sessionId, retry.prompt, {
          taskId: wf.taskId, workflow: { workflowId: wf.id, kind: retry.kind, retryOfRunId: retry.originalRunId, replayPrompt: retry.prompt, replayContext: retry.context },
          userMessage: { content: retry.kind === 'verify' ? `Asking the agent to report the goal outcome (turn ${turn}).` : `Continuing toward the goal (turn ${turn}).`, kind: retry.kind === 'verify' ? 'workflow-verification' : 'workflow-continuation' },
        });
      } catch (error) {
        this.repo.cancelRetries(wf.id);
        this.pauseWith(wf, 'failure', `Automatic retry could not start: ${clean(errorMessage(error), 300)} Review the run and resume manually.`);
      }
      return;
    }
    try {
      this.runtime.start(wf.sessionId, next === 'verify' ? verifyPrompt(wf) : continuePrompt(wf), {
        taskId: wf.taskId, workflow: { workflowId: wf.id, kind: next },
        userMessage: { content: next === 'verify' ? `Asking the agent to report the goal outcome (turn ${turn}).` : `Continuing toward the goal (turn ${turn}).`, kind: next === 'verify' ? 'workflow-verification' : 'workflow-continuation' },
      });
    } catch (error) {
      this.pauseWith(wf, 'failure', `The next turn could not start: ${clean(errorMessage(error), 300)} It was not retried.`);
    }
  }

  private pauseWith(wf: WorkflowRow, reason: WorkflowStopReason, summary: string): void {
    const fresh = this.repo.get(wf.id);
    if (!fresh || fresh.state !== 'running') return;
    this.detach(fresh, { state: 'paused', stopReason: reason, summary: clean(summary, 600) }, 'paused', `Autonomous goal paused (${describeReason(reason)}). ${clean(summary, 600)}`);
  }

  private allowQueuedStart(sessionId: string, item: QueuedMessage): boolean {
    if (item.id.startsWith('queued-')) return true;
    const row = this.wakeupRow(sessionId, item.content);
    if (!row) return true;
    const wf = this.repo.latest(sessionId);
    if (!wf || wf.state === 'running') return true;
    // A result from a helper that started before the goal paused, stopped or completed must not silently start an unbound,
    // unbudgeted parent turn. Helpers started afterwards (ordinary chat) are not affected.
    return Date.parse(row.startedAt) > Date.parse(wf.updatedAt);
  }
}
