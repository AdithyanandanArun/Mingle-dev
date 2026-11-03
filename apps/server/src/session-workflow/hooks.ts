import type { ProviderFailure, QueuedMessage, WorkflowFinish } from '@mingle/contracts';

/** Why a run belongs to a workflow. `start`/`continue`/`verify`/`resume` are scheduled by the service; the rest are adopted. */
export type WorkflowRunKind = 'start' | 'continue' | 'verify' | 'resume' | 'human' | 'queue' | 'wakeup';

/** Server-only run binding. No public request can supply one: it only travels through `StartOptions`. */
export interface WorkflowRunBinding { workflowId: string; kind: WorkflowRunKind }

/** What happened at provider/user boundaries while one run was alive. */
export interface RunBoundaryCounters {
  /** A person (or a stale-approval expiry) denied a native approval request. */
  approvalsDenied: number;
  /** Approvals still unanswered when a run completed on its own. */
  approvalsExpired: number;
  /** Approvals released because the run was interrupted. */
  approvalsCancelled: number;
  questionsAnswered: number;
  /** Provider questions cancelled, timed out or left unanswered. */
  questionsCancelled: number;
}

export interface RunChecklistState { total: number; done: number; open: number; fingerprint: string }

/** Facts about one finished run, delivered once to `runEnded` and once more to `idle`. */
export interface RunEndInfo {
  sessionId: string;
  runId: string;
  outcome: 'completed' | 'failed' | 'interrupted';
  /** Redacted failure text, when the run failed. */
  failure: string | null;
  failureInfo: Pick<ProviderFailure, 'kind' | 'providerCode' | 'outcomeUnknown' | 'dispatchState' | 'message'> | null;
  /** True when the run was interrupted because Mingle itself was closing. */
  shutdown: boolean;
  boundary: RunBoundaryCounters;
  /** Net edited files between run start and end; null when no trustworthy snapshot exists. */
  changedFiles: number | null;
  toolCalls: number;
  /** Final progress checklist if the run replaced it; null when the run never touched it. */
  checklist: RunChecklistState | null;
  startedAt: string;
}

/**
 * Narrow seam through which `SessionRuntime` talks to the single-session workflow service. All calls are synchronous
 * and must not start provider runs from inside `runEnded`; `idle` is the only edge that may start follow-up work.
 */
export interface SessionWorkflowHooks {
  /** Called at the top of `start()` for non-group, non-proxy sessions. May adopt the start (return new options) or throw. */
  prepareStart(sessionId: string, content: string, options: import('../runtime.ts').StartOptions): import('../runtime.ts').StartOptions;
  /** Called inside the same transaction that inserts the run row. Throwing rolls the whole start back. */
  runBound(info: { sessionId: string; runId: string; workflow: WorkflowRunBinding }): void;
  /** Records the agent's own report for a live, bound run. Throws when the binding is stale. */
  recordReport(info: { sessionId: string; runId: string; report: WorkflowFinish }): void;
  /** Synchronous, early: the run row and task are finalised; provider cleanup and queue handling have not happened yet. */
  runEnded(info: RunEndInfo): void;
  /** After provider cleanup AND the queue-drain attempt. Fires exactly once per workflow run. */
  idle(info: RunEndInfo & { sessionActive: boolean }): void;
  /** Queue gate. Return false to leave an item queued (e.g. late subagent results after Pause/Stop). */
  allowQueuedStart(sessionId: string, item: QueuedMessage): boolean;
}
