import type { DatabaseSync } from 'node:sqlite';

/** Shown for a run that was active when Mingle closed and belongs to an autonomous goal. */
export const WORKFLOW_RESTART_MESSAGE = 'Mingle was closed while this goal turn was running. The goal is paused and will not resume by itself; inspect the partial work, then resume it.';

/**
 * Read-only ownership probe usable before the workflow service exists (startup recovery runs first). Returns false when
 * the workflow tables have never been created.
 */
export function workflowOwnsRun(db: DatabaseSync, runId: string): boolean {
  try { return Boolean(db.prepare('SELECT 1 AS found FROM session_workflow_runs WHERE run_id=?').get(runId)); }
  catch { return false; }
}
