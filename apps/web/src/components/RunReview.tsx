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
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Loaded without being opened for the newest run and for the run the goal record names; older runs wait until a person opens them.
  const { state, retry } = useRunReviewEvidence(run, calls, latest || hints.goalTurn || detailsOpen);
  // Evidence read for an older version of the run record is not shown as if it described the current one.
  const evidence = state.phase !== 'idle' && state.key === evidenceKey(run, calls) ? state.data : null;
  const commands = useMemo(() => deriveCommands(run, calls, evidence), [run, calls, evidence]);
  const problems = useMemo(() => extraProblems(evidence, commands), [evidence, commands]);
  const checklist = useMemo(() => checklistSummary(hints.checklist), [hints.checklist]);
  if (!hasReviewContent({ run, hints })) return null;

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    if (event.target === event.currentTarget) setDetailsOpen(event.currentTarget.open);
  };
  const noChangeCapture = !changesVisible(run.changes);
  const hasDetails = run.toolCount > 0;
  const loading = state.phase === 'loading';
  const goal = evidence?.goalTurn ?? null;
  const failure = evidence?.failure ?? null;

  return (
    <section className={`run-review is-${run.status}`} aria-label="Review of this turn" data-run-review-id={run.id} data-run-id={run.id} tabIndex={-1}>
      <header className="run-review__head">
        <span className="run-review__title">Turn review</span>
        <span className="run-review__status">{turnStatusLabel(run.status)}</span>
      </header>
      <p className="run-review__note">A completed provider turn does not verify the goal.</p>

      <div className="run-review__group" role="group" aria-labelledby={ids.recorded}>
        <p className="run-review__label" id={ids.recorded}>Recorded by Mingle</p>
        <RunChanges runId={run.id} summary={run.changes} embedded />
        {noChangeCapture ? <p className="run-review__line">{run.changes ? 'No file changes were saved for this turn.' : 'No change capture was saved for this run.'}</p> : null}

        {run.status === 'interrupted' ? <p className="run-review__line is-bad">The turn was interrupted before it finished, so changes and commands may be partial.</p> : null}
        {run.status === 'failed' ? <p className="run-review__line is-bad">The provider turn failed{failure ? '' : evidence ? '; no classified failure was stored for it.' : '.'}</p> : null}
        {failure ? <p className="run-review__line is-bad">{FAILURE_KIND[failure.kind] ?? 'Failure'}: {failure.message}{failure.outcomeUnknown ? ' The provider may have acted before it failed, so the outcome is unknown.' : ''}</p> : null}

        {hasDetails ? (
          <details className="run-review__details" onToggle={onToggle}>
          <summary className="run-review__summary"><span>{commands.total ? 'Commands' : 'Recorded activity'}</span><span className="run-review__quiet">{commandsSummary(commands)}</span></summary>
            <div className="run-review__body">
              <p className="run-review__caveat">Recorded commands and outcomes only. Mingle did not run these checks; test results are unknown.</p>
              {loading ? <p className="run-review__line" role="status">Loading recorded details…</p> : null}
              {state.phase === 'error' ? <p className="run-review__line is-bad" role="alert">Could not load recorded details: {state.message} <button type="button" className="run-review__retry" onClick={retry}>Try again</button></p> : null}
              {commands.rows.length ? <ul className="run-review__list" aria-label="Commands recorded for this turn">
                {commands.rows.map((row) => <li key={row.id} className={commandWentWrong(row) ? 'is-bad' : undefined}>
                  <code className="run-review__command" title={row.command ?? undefined}>{row.command?.trim() || row.title}</code>
                  <span className="run-review__outcome">{commandOutcome(row.status, row.exitCode)}{row.durationMs !== null ? ` · ${formatToolDuration(row.durationMs)}` : ''}</span>
                </li>)}
              </ul> : null}
              {!loading && commands.rows.length < commands.total ? <p className="run-review__line">Showing {commands.rows.length.toLocaleString('en-US')} of {commands.total.toLocaleString('en-US')} recorded commands.</p> : null}
              {problems.length ? <>
                <p className="run-review__label">Other calls that failed or exited non-zero</p>
                <ul className="run-review__list" aria-label="Other tool calls with problems">
                  {problems.map((row) => <li key={row.id} className="is-bad"><span className="run-review__command">{row.title}</span><span className="run-review__outcome">{row.category} · {row.outcome}</span></li>)}
                </ul>
                {evidence && evidence.problems.truncated ? <p className="run-review__line">Showing the first {evidence.problems.items.length} of {evidence.problems.total.toLocaleString('en-US')} problem calls.</p> : null}
              </> : null}
            </div>
          </details>
        ) : run.toolCount === 0 ? <p className="run-review__line">No provider tool calls were captured for this turn. That does not show that nothing ran.</p>
          : <p className="run-review__line">No commands were recorded for this turn.</p>}
      </div>

      <div className="run-review__group" role="group" aria-labelledby={ids.agent}>
        <p className="run-review__label" id={ids.agent}>Reported by the agent</p>
        {goal?.report ? <p className="run-review__line">{GOAL_OUTCOME_LABEL[goal.report.outcome]}: “{goal.report.summary}”<span className="run-review__quiet"> This is the agent’s own report, {GOAL_STATE_LABEL[goal.report.state]}; Mingle has not verified it.</span></p>
          : goal ? <p className="run-review__line">This turn belonged to an autonomous goal, but the agent filed no report for it.</p>
            : hints.goalTurn && loading ? <p className="run-review__line" role="status">Checking for a goal report…</p> : null}
        {checklist.total > 0 ? <div className="run-review__line">
          <span>Checklist as last reported in this turn: {checklist.completed} of {checklist.total} marked complete{checklist.open.length ? `, ${checklist.open.length} still open` : ''}.</span>
          {checklist.open.length ? <ul className="run-review__list" aria-label="Checklist items still open">
            {checklist.open.map((step) => <li key={step.id} className={step.status === 'blocked' ? 'is-bad' : undefined}><span className="run-review__command">{step.title}</span><span className="run-review__outcome">{STEP_STATUS_LABEL[step.status]}</span></li>)}
          </ul> : null}
          <span className="run-review__quiet">These are the agent’s claims. Mingle leaves completed items in Review for you to accept.</span>
        </div> : <p className="run-review__line">No checklist was recorded for this turn, so remaining work is not reported.</p>}
      </div>
    </section>
  );
}
