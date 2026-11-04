import type { RunStatus, ToolCategory, ToolStatus } from './index';

/** Most command rows one review carries; `commands.total` always counts every recorded command. */
export const RUN_REVIEW_COMMAND_LIMIT = 50;
/** Most failed/interrupted/non-zero tool rows one review carries; `problems.total` counts all of them. */
export const RUN_REVIEW_PROBLEM_LIMIT = 20;

/** One command-category tool call as the provider and host recorded it. No output, no input: metadata only. */
export interface RunReviewCommand {
  id: string; name: string; /** First characters of the recorded command text; null when none was recorded. */ command: string | null;
  summary: string; status: ToolStatus; exitCode: number | null; durationMs: number | null; cwd: string | null;
}
/** A tool call (any category) that ended in failure, was interrupted, or reported a non-zero exit code. */
export interface RunReviewProblem {
  id: string; name: string; category: ToolCategory; status: ToolStatus; exitCode: number | null; summary: string;
}
/** The exact goal-turn binding and report of one run. Absent when the run was not a turn of an autonomous goal. */
export interface RunReviewGoalTurn {
  workflowId: string; sequence: number; kind: 'start' | 'continue' | 'verify' | 'resume' | 'human' | 'queue' | 'wakeup';
  /** `applied` reports changed the goal's state; `pending` ones were still being judged; `discarded` ones were ignored. */
  report: { outcome: 'complete' | 'blocked' | 'needs_human'; summary: string; state: 'pending' | 'applied' | 'discarded' } | null;
}
/**
 * Read-only, bounded metadata about one finished run, read from the tool and failure records already stored. It is evidence
 * of what was recorded, never a verdict: `report` is the agent's own claim and nothing here says tests passed.
 */
export interface RunReviewEvidence {
  runId: string; sessionId: string; status: RunStatus; readAt: string;
  tools: {
    total: number; counts: Partial<Record<ToolCategory, number>>;
    failed: number; interrupted: number; running: number; nonZeroExit: number;
  };
  commands: { total: number; items: RunReviewCommand[]; truncated: boolean };
  problems: { total: number; items: RunReviewProblem[]; truncated: boolean };
  /** Classified provider failure stored for this exact run, when one exists. */
  failure: { kind: string; message: string; occurredAt: string; outcomeUnknown: boolean } | null;
  goalTurn: RunReviewGoalTurn | null;
}
