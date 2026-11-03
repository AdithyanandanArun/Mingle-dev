import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { SessionWorkflow, WorkflowFinish, WorkflowStopReason } from '@mingle/contracts';
import type { WorkflowRunKind } from './hooks.ts';

type Row = Record<string, unknown>;

export const newWorkflowId = (): string => `wfl_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

/** Checklist as last reported by the agent; used to judge progress across turns. */
export interface StoredChecklist { total: number; done: number; open: number; fingerprint: string }

export interface WorkflowRow extends SessionWorkflow {
  projectId: string;
  checklist: StoredChecklist | null;
  endedAt: string | null;
}

export interface WorkflowRunRow {
  runId: string; workflowId: string; sessionId: string; seq: number; kind: WorkflowRunKind; startedAt: string;
  report: WorkflowFinish | null; reportState: 'none' | 'pending' | 'applied' | 'discarded';
  outcome: 'completed' | 'failed' | 'interrupted' | null; endedAt: string | null;
}

const OPEN = "('running','paused')";
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T;

function workflowRow(row: Row): WorkflowRow {
  return {
    id: String(row.id), sessionId: String(row.session_id), projectId: String(row.project_id), taskId: String(row.task_id), goal: String(row.goal),
    state: row.state as SessionWorkflow['state'], version: Number(row.version),
    stopReason: (row.stop_reason as WorkflowStopReason | null) ?? null, summary: (row.summary as string | null) ?? null,
    limits: { maxTurns: Number(row.max_turns), maxElapsedMinutes: Number(row.max_elapsed_minutes), maxStalls: Number(row.max_stalls) },
    counters: { turns: Number(row.turns), stalls: Number(row.stalls) },
    currentRunId: (row.current_run_id as string | null) ?? null, lastRunId: (row.last_run_id as string | null) ?? null,
    configuration: json(row.config_json), checklist: row.checklist_json ? json(row.checklist_json) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), deadlineAt: String(row.deadline_at), endedAt: (row.ended_at as string | null) ?? null,
  };
}

function runRow(row: Row): WorkflowRunRow {
  return {
    runId: String(row.run_id), workflowId: String(row.workflow_id), sessionId: String(row.session_id), seq: Number(row.seq), kind: row.kind as WorkflowRunKind,
    startedAt: String(row.started_at), report: row.report_json ? json(row.report_json) : null, reportState: row.report_state as WorkflowRunRow['reportState'],
    outcome: (row.outcome as WorkflowRunRow['outcome'] | null) ?? null, endedAt: (row.ended_at as string | null) ?? null,
  };
}

/** Public snapshot of a row: bookkeeping-only fields are not part of the contract. */
export function snapshot(row: WorkflowRow): SessionWorkflow {
  const { projectId: _projectId, checklist: _checklist, endedAt: _endedAt, ...rest } = row;
  return rest;
}

/**
 * Durable workflow and run-binding rows. Tables live beside the main schema and are created idempotently; there are no
 * foreign keys so a removed session or project can never block deletion, and an orphaned row is simply never surfaced.
 */
export class WorkflowRepo {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_workflows (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT NOT NULL, goal TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('running','paused','stopped','completed')), version INTEGER NOT NULL,
        stop_reason TEXT, summary TEXT,
        max_turns INTEGER NOT NULL, max_elapsed_minutes INTEGER NOT NULL, max_stalls INTEGER NOT NULL,
        turns INTEGER NOT NULL, stalls INTEGER NOT NULL, current_run_id TEXT, last_run_id TEXT,
        config_json TEXT NOT NULL, checklist_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deadline_at TEXT NOT NULL, ended_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS session_workflows_open ON session_workflows(session_id) WHERE state IN ${OPEN};
      CREATE INDEX IF NOT EXISTS session_workflows_session ON session_workflows(session_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS session_workflow_runs (
        run_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
        started_at TEXT NOT NULL, report_json TEXT, report_state TEXT NOT NULL DEFAULT 'none', outcome TEXT, ended_at TEXT
      );
      CREATE INDEX IF NOT EXISTS session_workflow_runs_workflow ON session_workflow_runs(workflow_id, seq);`);
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...params) as Row | undefined; }
  private exec(sql: string, ...params: SQLInputValue[]): number { return Number(this.db.prepare(sql).run(...params).changes); }

  insert(row: WorkflowRow): void {
    this.exec(`INSERT INTO session_workflows(id,session_id,project_id,task_id,goal,state,version,stop_reason,summary,max_turns,max_elapsed_minutes,max_stalls,turns,stalls,current_run_id,last_run_id,config_json,checklist_json,created_at,updated_at,deadline_at,ended_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.id, row.sessionId, row.projectId, row.taskId, row.goal, row.state, row.version, row.stopReason, row.summary,
    row.limits.maxTurns, row.limits.maxElapsedMinutes, row.limits.maxStalls, row.counters.turns, row.counters.stalls, row.currentRunId, row.lastRunId,
    JSON.stringify(row.configuration), row.checklist ? JSON.stringify(row.checklist) : null, row.createdAt, row.updatedAt, row.deadlineAt, row.endedAt);
  }

  /** Compare-and-set write: only applies when the stored version still equals `expected`. Returns whether it applied. */
  update(row: WorkflowRow, expectedVersion: number): boolean {
    return this.exec(`UPDATE session_workflows SET state=?,version=?,stop_reason=?,summary=?,max_turns=?,max_elapsed_minutes=?,max_stalls=?,turns=?,stalls=?,current_run_id=?,last_run_id=?,config_json=?,checklist_json=?,updated_at=?,deadline_at=?,ended_at=?
      WHERE id=? AND version=?`,
    row.state, row.version, row.stopReason, row.summary, row.limits.maxTurns, row.limits.maxElapsedMinutes, row.limits.maxStalls, row.counters.turns, row.counters.stalls,
    row.currentRunId, row.lastRunId, JSON.stringify(row.configuration), row.checklist ? JSON.stringify(row.checklist) : null, row.updatedAt, row.deadlineAt, row.endedAt,
    row.id, expectedVersion) === 1;
  }

  get(id: string): WorkflowRow | undefined {
    const row = this.one('SELECT * FROM session_workflows WHERE id=?', id);
    return row ? workflowRow(row) : undefined;
  }

  /** The running or paused workflow of a session, if any. */
  open(sessionId: string): WorkflowRow | undefined {
    const row = this.one(`SELECT * FROM session_workflows WHERE session_id=? AND state IN ${OPEN}`, sessionId);
    return row ? workflowRow(row) : undefined;
  }

  latest(sessionId: string): WorkflowRow | undefined {
    const row = this.one('SELECT * FROM session_workflows WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', sessionId);
    return row ? workflowRow(row) : undefined;
  }

  /** The most recent workflow of every session that still has one (bounded). */
  latestPerSession(limit = 200): WorkflowRow[] {
    return this.all(`SELECT w.* FROM session_workflows w
      WHERE w.rowid = (SELECT w2.rowid FROM session_workflows w2 WHERE w2.session_id = w.session_id ORDER BY w2.created_at DESC, w2.rowid DESC LIMIT 1)
      ORDER BY w.updated_at DESC LIMIT ?`, Math.max(1, Math.min(limit, 500))).map(workflowRow);
  }

  running(): WorkflowRow[] { return this.all("SELECT * FROM session_workflows WHERE state='running'").map(workflowRow); }

  insertRun(row: Pick<WorkflowRunRow, 'runId' | 'workflowId' | 'sessionId' | 'seq' | 'kind' | 'startedAt'>): void {
    this.exec('INSERT INTO session_workflow_runs(run_id,workflow_id,session_id,seq,kind,started_at,report_state) VALUES(?,?,?,?,?,?,?)',
      row.runId, row.workflowId, row.sessionId, row.seq, row.kind, row.startedAt, 'none');
  }

  run(runId: string): WorkflowRunRow | undefined {
    const row = this.one('SELECT * FROM session_workflow_runs WHERE run_id=?', runId);
    return row ? runRow(row) : undefined;
  }

  setReport(runId: string, report: WorkflowFinish): boolean {
    return this.exec("UPDATE session_workflow_runs SET report_json=?,report_state='pending' WHERE run_id=? AND ended_at IS NULL", JSON.stringify(report), runId) === 1;
  }

  setReportState(runId: string, state: 'applied' | 'discarded'): void {
    this.exec("UPDATE session_workflow_runs SET report_state=? WHERE run_id=? AND report_state='pending'", state, runId);
  }

  endRun(runId: string, outcome: NonNullable<WorkflowRunRow['outcome']>, at: string): void {
    this.exec('UPDATE session_workflow_runs SET outcome=?,ended_at=? WHERE run_id=? AND ended_at IS NULL', outcome, at, runId);
  }

  /** Marks runs of a workflow that never reported an ending (crash) as interrupted and drops unapplied reports. */
  closeOpenRuns(workflowId: string, at: string): void {
    this.exec("UPDATE session_workflow_runs SET outcome='interrupted',ended_at=? WHERE workflow_id=? AND ended_at IS NULL", at, workflowId);
    this.exec("UPDATE session_workflow_runs SET report_state='discarded' WHERE workflow_id=? AND report_state='pending'", workflowId);
  }

  ownsRun(runId: string): boolean { return Boolean(this.one('SELECT 1 AS found FROM session_workflow_runs WHERE run_id=?', runId)); }
}
