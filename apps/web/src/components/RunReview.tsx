import { useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import type { RunReviewEvidence, SessionRun } from '@mingle/contracts';
import { api, errorMessage } from '../lib/api';
import { formatToolDuration } from '../lib/toolRecords';
import {
  changesVisible, checklistSummary, commandOutcome, commandsSummary, commandWentWrong, deriveCommands, extraProblems, GOAL_OUTCOME_LABEL, GOAL_STATE_LABEL,
  hasReviewContent, STEP_STATUS_LABEL, turnStatusLabel,
} from '../lib/runReview';
import type { RunBlock } from '../lib/transcript';
import { RunChanges } from './RunChanges';

type EvidenceState =
  | { phase: 'idle' }
  | { phase: 'loading'; key: string; data: RunReviewEvidence | null }
  | { phase: 'ready'; key: string; data: RunReviewEvidence }
  | { phase: 'error'; key: string; message: string; data: RunReviewEvidence | null };

/** What the evidence describes: it is read again if the run's finished record or tool count changes underneath it. */
const evidenceKey = (run: SessionRun, calls: RunBlock['calls']): string => `${run.id}|${run.status}|${run.finishedAt ?? ''}|${run.toolCount}|${calls.map((call) => `${call.id}:${call.revision ?? 0}:${call.status}:${call.exitCode ?? ''}`).join(',')}`;

/**
 * Bounded evidence (command rows, failure, the run's own goal report) for one finished run. Requested only when asked for: the
 * newest run (and the goal's latest turn) loads it without being opened, older runs when a person opens their details. Each request is fenced by an abort
 * signal, so a response for a previous version, another run or an unmounted card is never applied. A failed request is not
 * retried by itself.
 */
function useRunReviewEvidence(run: SessionRun, calls: RunBlock['calls'], enabled: boolean): { state: EvidenceState; retry: () => void } {
  const [state, setState] = useState<EvidenceState>({ phase: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const key = evidenceKey(run, calls);
  // Token of the last pass whose answer (or failure) was applied: a pass that was cancelled leaves it unset so a later one asks again.
  const settled = useRef<string | null>(null);
  const runId = run.id;
  const sessionId = run.sessionId;
  const finished = run.status !== 'running';
  useEffect(() => {
    const token = `${key}|${attempt}`;
    if (!enabled || !finished || settled.current === token) return;
    const abort = new AbortController();
    setState((current) => ({ phase: 'loading', key, data: current.phase === 'idle' ? null : current.data }));
    void api.runReview(runId, abort.signal).then((data) => {
      if (abort.signal.aborted) return;
      settled.current = token;
      if (data.runId !== runId || data.sessionId !== sessionId) { setState((current) => ({ phase: 'error', key, message: 'The server answered for a different run.', data: current.phase === 'idle' ? null : current.data })); return; }
      setState({ phase: 'ready', key, data });
    }).catch((reason: unknown) => {
      if (abort.signal.aborted) return;
      settled.current = token;
      setState((current) => ({ phase: 'error', key, message: errorMessage(reason), data: current.phase === 'idle' ? null : current.data }));
    });
    return () => abort.abort();
  }, [enabled, finished, key, attempt, runId]);
  return { state, retry: () => setAttempt((value) => value + 1) };
}

const FAILURE_KIND: Record<string, string> = {
  context_exhausted: 'Context window exhausted', output_truncated: 'Output was cut off', quota_exhausted: 'Usage quota exhausted', temporary_rate_limit: 'Rate limited',
  authentication: 'Sign-in problem', provider_unavailable: 'Provider unavailable', unknown: 'Unclassified failure',
};

/**
 * One completion card per finished run. It shows what Mingle recorded (saved changes, commands the provider reported, failures)
 * apart from what the agent claims (its goal report and checklist). A provider turn that ended normally is shown as exactly that,
 * never as proof that the goal was achieved, and nothing here moves a task out of Review.
 */
export function RunReview({ block }: { block: RunBlock }) {
  const { run, calls, hints, latest } = block;
  const ids = { recorded: useId(), agent: useId() };
  const [basicOpen, setBasicOpen] = useState(true);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  // The basic review uses the snapshot. Older runs fetch full evidence when its disclosure opens.
  const { state, retry } = useRunReviewEvidence(run, calls, latest || hints.goalTurn || (basicOpen && evidenceOpen));
  // Evidence read for an older version of the run record is not shown as if it described the current one.
  const evidence = state.phase !== 'idle' && state.key === evidenceKey(run, calls) ? state.data : null;
  const commands = useMemo(() => deriveCommands(run, calls, evidence), [run, calls, evidence]);
  const problems = useMemo(() => extraProblems(evidence, commands), [evidence, commands]);
  const checklist = useMemo(() => checklistSummary(hints.checklist), [hints.checklist]);
  if (!hasReviewContent({ run, hints })) return null;

  const toggleBasic = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.target === event.currentTarget) setBasicOpen(event.currentTarget.open);
  };
  const toggleEvidence = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.target === event.currentTarget) setEvidenceOpen(event.currentTarget.open);
  };
  const showChanges = changesVisible(run.changes);
  const loading = state.phase === 'loading';
  const goal = evidence?.goalTurn ?? null;
  const failure = evidence?.failure ?? null;
  const hasDetails = run.toolCount > 0 || run.status !== 'completed' || hints.goalTurn || checklist.total > 0;
  const count = (value: number, unit: string) => `${value.toLocaleString()} ${unit}${value === 1 ? '' : 's'}`;
  const counts = [
    run.changes?.status === 'available' && run.changes.fileCount > 0 ? count(run.changes.fileCount, 'changed file') : null,
    commands.total > 0 ? count(commands.total, 'command') : run.toolCount > 0 ? count(run.toolCount, 'tool call') : null,
    checklist.total > 0 ? `${checklist.completed}/${checklist.total} steps reported done` : null,
  ].filter(Boolean);

  return (
    <section className={`run-review is-${run.status}`} aria-label="Review of this turn" data-run-review-id={run.id} data-run-id={run.id} tabIndex={-1}>
      <details className="run-review__details" open={basicOpen} onToggle={toggleBasic}>
        <summary className="run-review__summary">
          <span className="run-review__title">Turn review</span>
          <span className="run-review__status">{turnStatusLabel(run.status)}</span>
          {counts.length > 0 ? <span className="run-review__counts">{counts.join(' · ')}</span> : null}
        </summary>
        <div className="run-review__group" role="group" aria-labelledby={ids.recorded}>
          <p className="run-review__label" id={ids.recorded}>Recorded by Mingle</p>
          <RunChanges runId={run.id} summary={run.changes} embedded />
          {run.status === 'interrupted' ? <p className="run-review__line is-bad">Changes and command records may be partial.</p> : null}
          {failure ? <p className="run-review__line is-bad">{FAILURE_KIND[failure.kind] ?? 'Failure'} · {failure.message}{failure.outcomeUnknown ? ' Provider outcome unknown.' : ''}</p> : null}
          {run.toolCount > 0 ? <p className="run-review__line">{commandsSummary(commands)}</p> : null}
          {!loading && !showChanges && run.toolCount === 0 && !failure && run.status !== 'interrupted' ? <p className="run-review__line">{run.changes ? 'No file changes recorded.' : 'No file capture for this turn.'}</p> : null}
        </div>
        {hasDetails ? <details className="run-review__evidence" onToggle={toggleEvidence}>
          <summary className="run-review__summary run-review__evidence-summary">Review details</summary>
          <div className="run-review__group">
            {loading ? <p className="run-review__line" role="status">Loading details…</p> : null}
            {state.phase === 'error' ? <p className="run-review__line is-bad" role="alert">Could not load details. {state.message} <button type="button" className="run-review__retry" onClick={retry}>Try again</button></p> : null}
            {commands.total > 0 || problems.length > 0 ? <div className="run-review__body">
              {commands.rows.length ? <>
                <p className="run-review__caveat">Recorded exit codes and outcomes. Test results are unknown.</p>
                <ul className="run-review__list" aria-label="Commands recorded for this turn">
                  {commands.rows.map((row) => <li key={row.id} className={commandWentWrong(row) ? 'is-bad' : undefined}>
                    <code className="run-review__command" title={row.command ?? undefined}>{row.command?.trim() || row.title}</code>
                    <span className="run-review__outcome">{commandOutcome(row.status, row.exitCode)}{row.durationMs !== null ? ` · ${formatToolDuration(row.durationMs)}` : ''}</span>
                  </li>)}
                </ul>
              </> : null}
              {!loading && commands.rows.length < commands.total ? <p className="run-review__line">Showing {commands.rows.length.toLocaleString('en-US')} of {commands.total.toLocaleString('en-US')} recorded commands.</p> : null}
              {problems.length ? <>
                <p className="run-review__label">Other calls with problems</p>
                <ul className="run-review__list" aria-label="Other tool calls with problems">
                  {problems.map((row) => <li key={row.id} className="is-bad"><span className="run-review__command">{row.title}</span><span className="run-review__outcome">{row.category} · {row.outcome}</span></li>)}
                </ul>
                {evidence?.problems.truncated ? <p className="run-review__line">Showing the first {evidence.problems.items.length} of {evidence.problems.total.toLocaleString('en-US')} problem calls.</p> : null}
              </> : null}
            </div> : null}
            {state.phase === 'ready' && commands.total === 0 && problems.length === 0 && !goal && checklist.total === 0 ? <p className="run-review__line">No additional details recorded.</p> : null}
          </div>
          {goal || checklist.total > 0 ? <div className="run-review__group" role="group" aria-labelledby={ids.agent}>
            <p className="run-review__label" id={ids.agent}>Reported by the agent</p>
            {goal?.report ? <p className="run-review__line">{GOAL_OUTCOME_LABEL[goal.report.outcome]} · “{goal.report.summary}” <span className="run-review__quiet">{GOAL_STATE_LABEL[goal.report.state]}.</span></p>
              : goal ? <p className="run-review__line">No goal report filed.</p> : null}
            {checklist.total > 0 ? <div className="run-review__line">
              <span>{checklist.completed} of {checklist.total} steps marked complete</span>
              {checklist.open.length ? <ul className="run-review__list" aria-label="Checklist items still open">
                {checklist.open.map((step) => <li key={step.id} className={step.status === 'blocked' ? 'is-bad' : undefined}><span className="run-review__command">{step.title}</span><span className="run-review__outcome">{STEP_STATUS_LABEL[step.status]}</span></li>)}
              </ul> : null}
            </div> : null}
          </div> : null}
        </details> : null}
      </details>
    </section>
  );
}
