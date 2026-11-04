import type {
  RunChangesSummary, RunReviewCommand, RunReviewEvidence, RunReviewGoalTurn, RunReviewProblem, SessionRun, SessionWorkflow, Task, ToolCall, ToolStatus,
} from '@mingle/contracts';

/**
 * Facts for the completion review card. Everything here restates a record: the run's own status, saved change capture, tool
 * calls the provider reported (with the exit codes and statuses stored for them), a provider failure stored for that run, and
 * what the agent itself reported. Nothing is inferred from a command's name, its output text or an exit code alone, and nothing
 * says tests passed: Mingle records commands, it does not run or verify checks.
 */

export interface ChecklistStep { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' | 'blocked' }
/** Per-run facts that come from stores the client already holds (no request): the agent's checklist as last reported by that run. */
export interface RunReviewHints {
  /** Provider plan steps whose most recent report came from this run (steps a later run updated belong to that run). */
  checklist: readonly ChecklistStep[];
  /** True when the session's goal record names this run as its latest turn, so a goal report may exist for it. */
  goalTurn: boolean;
}
export const EMPTY_CHECKLIST: readonly ChecklistStep[] = [];
export const NO_HINTS: RunReviewHints = { checklist: EMPTY_CHECKLIST, goalTurn: false };

const sameSteps = (a: readonly ChecklistStep[], b: readonly ChecklistStep[]): boolean =>
  a === b || (a.length === b.length && a.every((step, index) => step.id === b[index]!.id && step.title === b[index]!.title && step.status === b[index]!.status));

/**
 * One linear pass over the tasks. Each step's durable source records the run that last reported it and the status it reported,
 * so a run's checklist is exactly the steps it reported last. Per-run arrays (and the map, when nothing changed) keep their
 * previous identity so downstream memoization holds across refreshes that return the same data.
 */
export function deriveReviewHints(tasks: readonly Task[] | undefined, workflows: readonly SessionWorkflow[] | undefined, sessionId: string, previous?: ReadonlyMap<string, RunReviewHints>): ReadonlyMap<string, RunReviewHints> {
  const steps = new Map<string, Task[]>();
  for (const task of tasks ?? []) {
    const source = task.source;
    if (task.sessionId !== sessionId || source?.kind !== 'provider' || !source.runId || source.missing || !source.reportedStatus) continue;
    const list = steps.get(source.runId);
    if (list) list.push(task); else steps.set(source.runId, [task]);
  }
  const goalRuns = new Set<string>();
  for (const workflow of workflows ?? []) {
    if (workflow.sessionId !== sessionId) continue;
    if (workflow.lastRunId) goalRuns.add(workflow.lastRunId);
    if (workflow.currentRunId) goalRuns.add(workflow.currentRunId);
  }
  const next = new Map<string, RunReviewHints>();
  for (const runId of new Set([...steps.keys(), ...goalRuns])) {
    const checklist = (steps.get(runId) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((task): ChecklistStep => ({ id: task.id, title: task.title, status: task.source!.reportedStatus! }));
    const old = previous?.get(runId);
    const stable = old && sameSteps(old.checklist, checklist) ? old.checklist : checklist.length ? checklist : EMPTY_CHECKLIST;
    const goalTurn = goalRuns.has(runId);
    next.set(runId, old && old.checklist === stable && old.goalTurn === goalTurn ? old : { checklist: stable, goalTurn });
  }
  if (previous && previous.size === next.size && [...next].every(([id, hints]) => previous.get(id) === hints)) return previous;
  return next;
}

/** The facts a command row may show. `exitCode` is only what the provider recorded for that process. */
export interface ReviewCommandRow {
  id: string; title: string; command: string | null; status: ToolStatus; exitCode: number | null; durationMs: number | null;
}

/** Outcome words restate the recorded status and exit code. "exit 0" is never turned into "passed". */
export function commandOutcome(status: ToolStatus, exitCode: number | null): string {
  if (status === 'running') return 'still running';
  if (status === 'interrupted') return exitCode === null ? 'interrupted' : `interrupted · exit ${exitCode}`;
  if (status === 'failed') return exitCode === null ? 'failed' : `failed · exit ${exitCode}`;
  return exitCode === null ? 'no exit code recorded' : `exit ${exitCode}`;
}

/** Whether a row reports something that went wrong (a recorded failure or non-zero exit), as opposed to a neutral or unknown outcome. */
export const commandWentWrong = (row: Pick<ReviewCommandRow, 'status' | 'exitCode'>): boolean =>
  row.status === 'failed' || row.status === 'interrupted' || (row.exitCode !== null && row.exitCode !== 0);

const rowTitle = (summary: string, command: string | null, name: string): string => summary.trim() || command?.trim() || name || 'Command';
const fromCall = (call: ToolCall): ReviewCommandRow => ({ id: call.id, title: rowTitle(call.summary, call.command, call.name), command: call.command, status: call.status, exitCode: call.exitCode, durationMs: call.durationMs });
const fromEvidence = (item: RunReviewCommand): ReviewCommandRow => ({ id: item.id, title: rowTitle(item.summary, item.command, item.name), command: item.command, status: item.status, exitCode: item.exitCode, durationMs: item.durationMs });

export interface ReviewCommands {
  /** Commands the run record counts. Known even when the rows are not loaded. */
  total: number;
  rows: ReviewCommandRow[];
  /** True when `rows` is every recorded command, so outcome counts over them are complete. */
  complete: boolean;
  source: 'evidence' | 'loaded' | 'none';
}

/** Prefers the server's bounded evidence; otherwise the tool calls already in the snapshot, complete only when every counted command is among them. */
export function deriveCommands(run: SessionRun, calls: readonly ToolCall[], evidence: RunReviewEvidence | null): ReviewCommands {
  if (evidence && evidence.runId === run.id) {
    return { total: evidence.commands.total, rows: evidence.commands.items.map(fromEvidence), complete: !evidence.commands.truncated, source: 'evidence' };
  }
  const own = calls.filter((call) => call.runId === run.id && call.category === 'command');
  const total = Math.max(run.toolCounts?.command ?? 0, own.length);
  return { total, rows: own.map(fromCall), complete: own.length >= total, source: own.length ? 'loaded' : 'none' };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "3 commands recorded · 1 failed · 1 exited non-zero", with outcomes only when every recorded command is in hand. */
export function commandsSummary(commands: ReviewCommands): string {
  if (commands.total === 0) return 'No commands recorded';
  const parts = [`${plural(commands.total, 'command')} recorded`];
  if (commands.complete) {
    const failed = commands.rows.filter((row) => row.status === 'failed').length;
    const interrupted = commands.rows.filter((row) => row.status === 'interrupted').length;
    const running = commands.rows.filter((row) => row.status === 'running').length;
    const nonZero = commands.rows.filter((row) => row.exitCode !== null && row.exitCode !== 0).length;
    const unknown = commands.rows.filter((row) => row.status === 'completed' && row.exitCode === null).length;
    if (running) parts.push(`${running} still running`);
    if (failed) parts.push(`${failed} failed`);
    if (interrupted) parts.push(`${interrupted} interrupted`);
    if (nonZero) parts.push(`${nonZero} exited non-zero`);
    if (unknown) parts.push(`${unknown} without an exit code`);
  } else parts.push('outcomes not fully loaded');
  return parts.join(' · ');
}

export interface ReviewProblem { id: string; title: string; category: string; outcome: string }
const fromProblem = (item: RunReviewProblem): ReviewProblem => ({ id: item.id, title: rowTitle(item.summary, null, item.name), category: item.category, outcome: commandOutcome(item.status, item.exitCode) });

/** Problem rows the commands list does not already show (failed or interrupted tools of other categories, or commands past the listed ones). */
export function extraProblems(evidence: RunReviewEvidence | null, commands: ReviewCommands): ReviewProblem[] {
  if (!evidence) return [];
  const shown = new Set(commands.rows.map((row) => row.id));
  return evidence.problems.items.filter((item) => !shown.has(item.id)).map(fromProblem);
}

export function changesVisible(summary: RunChangesSummary | null | undefined): boolean {
  return Boolean(summary) && (summary!.status === 'unavailable' || summary!.fileCount > 0);
}

export interface ReviewVisibility { run: SessionRun; hints: RunReviewHints }
/** A finished run earns a card when there is something to review. A plain text answer with no changes, commands or problems does not. */
export function hasReviewContent({ run, hints }: ReviewVisibility): boolean {
  if (run.status === 'running') return false;
  return changesVisible(run.changes) || run.toolCount > 0 || run.status !== 'completed' || hints.checklist.length > 0 || hints.goalTurn;
}

export function turnStatusLabel(status: SessionRun['status']): string {
  if (status === 'completed') return 'Provider turn completed';
  if (status === 'failed') return 'Provider turn failed';
  if (status === 'interrupted') return 'Turn interrupted';
  return 'Turn running';
}

export const GOAL_OUTCOME_LABEL: Record<NonNullable<RunReviewGoalTurn['report']>['outcome'], string> = {
  complete: 'The agent reported the goal complete', blocked: 'The agent reported it is blocked', needs_human: 'The agent asked for a person',
};
export const GOAL_STATE_LABEL: Record<NonNullable<RunReviewGoalTurn['report']>['state'], string> = {
  applied: 'accepted as the goal’s outcome', pending: 'still being applied', discarded: 'ignored; the goal did not use it',
};

export function checklistSummary(checklist: readonly ChecklistStep[]): { total: number; open: ChecklistStep[]; completed: number } {
  const open = checklist.filter((step) => step.status !== 'completed');
  return { total: checklist.length, open: [...open], completed: checklist.length - open.length };
}

export const STEP_STATUS_LABEL: Record<ChecklistStep['status'], string> = { pending: 'not started', in_progress: 'in progress', completed: 'marked complete', blocked: 'blocked' };
