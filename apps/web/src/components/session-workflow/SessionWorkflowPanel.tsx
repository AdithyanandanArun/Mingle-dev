import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, CircleDot, Pause, Play, Square } from 'lucide-react';
import type { Session, SessionWorkflow, WorkflowLimits, WorkflowStopReason } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { useMingle } from '../../store/store';
import './session-workflow.css';

const reasons: Record<WorkflowStopReason, string> = {
  'user-pause': 'Paused by you', 'user-stop': 'Stopped by you', 'needs-input': 'Needs your input',
  'approval-denied': 'Permission was declined', quota: 'Provider limit reached', failure: 'Provider needs attention',
  limit: 'Run limit reached', stalled: 'No further progress', 'goal-complete': 'Agent reported completion',
  'agent-blocked': 'Agent is blocked', refused: 'Provider declined the request', 'app-closed': 'Ready to resume after restart',
  'configuration-changed': 'Session settings changed', 'unreported-outcome': 'Agent did not report an outcome',
  'session-unavailable': 'Session is no longer available',
};

export function SessionWorkflowPanel({ workflow, session, children, currentTask, compact = false, totalHelpers = 0 }: { workflow: SessionWorkflow; session: Session; children?: ReactNode; currentTask?: string; compact?: boolean; totalHelpers?: number }) {
  const helpers = useMingle((state) => state.boot?.delegatedSubagents?.reduce((count, item) => count + Number(item.parentSessionId === session.id && item.status === 'running'), 0) ?? 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const running = workflow.state === 'running';
  const waiting = running && session.status === 'waiting';
  const terminal = workflow.state === 'completed' || workflow.state === 'stopped';
  const [expanded, setExpanded] = useState(!compact && !terminal);
  const bodyId = useId();
  const extraTurns = workflow.counters.turns >= workflow.limits.maxTurns ? Math.min(8, 50 - workflow.limits.maxTurns) : 0;
  const expired = Date.parse(workflow.deadlineAt) <= Date.now();
  const extraMinutes = expired ? Math.max(0, Math.min(240, 1440 - workflow.limits.maxElapsedMinutes)) : 0;
  const extraTimeLabel = extraMinutes % 60 === 0 ? `${extraMinutes / 60} hours` : `${extraMinutes} minutes`;
  const budgetExhausted = workflow.counters.turns >= 50 || (expired && extraMinutes === 0);
  const resumeLabel = extraTurns ? `Resume · +${extraTurns} turns` : extraMinutes ? `Resume · +${extraTimeLabel}` : 'Resume';
  const label = waiting ? 'Waiting for you' : running ? session.status === 'running' ? 'Working toward your goal' : helpers ? `Waiting for ${helpers} subagent${helpers === 1 ? '' : 's'}` : 'Continuing your goal'
    : workflow.stopReason ? reasons[workflow.stopReason] : workflow.state === 'completed' ? 'Agent reported completion' : 'Autonomous work paused';
  const act = async (action: 'pause' | 'resume' | 'stop') => {
    setBusy(action); setError(null);
    try {
      if (action === 'resume') await api.resumeSessionWorkflow(session.id, {
        expectedVersion: workflow.version, ...(extraTurns ? { additionalTurns: extraTurns } : {}), ...(extraMinutes ? { extendMinutes: extraMinutes } : {}),
      });
      else if (action === 'pause') await api.pauseSessionWorkflow(session.id, workflow.version);
      else await api.stopSessionWorkflow(session.id, workflow.version);
      await useMingle.getState().refreshNow();
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
      // Refresh conflicts without replaying an action against a newer workflow version.
      void useMingle.getState().refreshNow();
    } finally { if (mounted.current) setBusy(null); }
  };
  return <section className={`session-workflow${compact ? ' session-workflow--compact' : ''}`} aria-label="Autonomous workflow" aria-busy={busy !== null} onKeyDown={event => { if (event.key === 'Escape') setExpanded(false); }}>
    <div className="session-workflow__header">
      <button type="button" className="session-workflow__heading" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded((value) => !value)}>
        {workflow.state === 'completed' ? <Check size={14} /> : <CircleDot size={14} className={running && !waiting ? 'session-workflow__live' : undefined} />}
        <span className="session-workflow__heading-copy" aria-live="polite">{currentTask ? <strong title={currentTask}>{currentTask}</strong> : null}<span>{label}{compact && totalHelpers ? ` · ${totalHelpers} helper${totalHelpers === 1 ? '' : 's'}` : ''}</span></span><ChevronDown size={13} className={expanded ? 'is-open' : undefined} />
      </button>
      <span className="session-workflow__turns" title="Provider turns used; this is a turn budget, not a percentage of work completed.">{workflow.counters.turns}/{workflow.limits.maxTurns} turns</span>
      <div className="session-workflow__actions">
        {running ? <button type="button" disabled={busy !== null} onClick={() => void act('pause')} aria-label="Pause autonomous workflow"><Pause size={13} /><span>Pause</span></button> : null}
        {workflow.state === 'paused' ? <button type="button" disabled={busy !== null || session.status === 'running' || session.status === 'waiting' || budgetExhausted} onClick={() => void act('resume')} aria-label={resumeLabel}><Play size={13} /><span>{resumeLabel}</span></button> : null}
        {!terminal ? <button type="button" disabled={busy !== null} onClick={() => void act('stop')} aria-label="Stop autonomous workflow"><Square size={12} /><span>Stop</span></button> : null}
      </div>
    </div>
    <div id={bodyId} className="session-workflow__body" hidden={!expanded}>
      <p className="session-workflow__goal">{workflow.goal}</p>
      {workflow.summary ? <p className="session-workflow__summary">{workflow.summary}</p> : null}
      {workflow.state === 'completed' ? <button type="button" className="link-btn" onClick={() => useMingle.getState().setContextTab('changes')}>Review changes</button> : null}
      {waiting ? <p className="session-workflow__hint">Answer the question or permission request in this conversation to continue.</p> : null}
      {running && session.status === 'idle' && helpers > 0 ? <p className="session-workflow__hint">Helper results continue this goal within its remaining budget.</p> : null}
      {workflow.state === 'paused' && workflow.stopReason === 'app-closed' ? <p className="session-workflow__hint">Resume checks the current workspace before continuing partial work.</p> : null}
      {extraTurns && extraMinutes ? <p className="session-workflow__hint">Resuming grants {extraTurns} additional turns and {extraTimeLabel} more.</p> : null}
      {workflow.state === 'paused' && budgetExhausted ? <p className="session-workflow__hint">This goal reached its maximum budget. Stop it before starting a new goal.</p> : null}
      {children}
    </div>
    {error ? <p className="session-workflow__error" role="alert">{error}</p> : null}
  </section>;
}

export function WorkflowLimitsControl({ limits, onChange, disabled }: { limits: WorkflowLimits; onChange: (value: WorkflowLimits) => void; disabled: boolean }) {
  return <fieldset className="workflow-setup">
    <legend>Autonomous budget</legend>
    <p>Up to {limits.maxTurns} turns. Work through the goal and report what needs you.</p>
    <div className="workflow-setup__fields">
      <label>Turn budget<input type="number" min={1} max={50} step={1} value={limits.maxTurns} disabled={disabled} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isInteger(value) && value >= 1 && value <= 50) onChange({ ...limits, maxTurns: value }); }} /></label>
      <label>Time budget (minutes)<input type="number" min={1} max={1440} step={1} value={limits.maxElapsedMinutes} disabled={disabled} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isInteger(value) && value >= 1 && value <= 1440) onChange({ ...limits, maxElapsedMinutes: value }); }} /></label>
    </div>
  </fieldset>;
}
