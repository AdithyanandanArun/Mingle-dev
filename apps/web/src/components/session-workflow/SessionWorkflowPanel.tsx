import { useEffect, useRef, useState } from 'react';
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

export function SessionWorkflowPanel({ workflow, session }: { workflow: SessionWorkflow; session: Session }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const running = workflow.state === 'running';
  const waiting = running && session.status === 'waiting';
  const terminal = workflow.state === 'completed' || workflow.state === 'stopped';
  const [expanded, setExpanded] = useState(!terminal);
  const extraTurns = workflow.counters.turns >= workflow.limits.maxTurns ? Math.min(8, 50 - workflow.limits.maxTurns) : 0;
  const expired = Date.parse(workflow.deadlineAt) <= Date.now();
  const extraMinutes = expired ? Math.max(0, Math.min(240, 1440 - workflow.limits.maxElapsedMinutes)) : 0;
  const extraTimeLabel = extraMinutes % 60 === 0 ? `${extraMinutes / 60} hours` : `${extraMinutes} minutes`;
  const budgetExhausted = workflow.counters.turns >= 50 || (expired && extraMinutes === 0);
  const resumeLabel = extraTurns ? `Resume · +${extraTurns} turns` : extraMinutes ? `Resume · +${extraTimeLabel}` : 'Resume';
  const label = waiting ? 'Waiting for you' : running ? session.status === 'running' ? 'Working toward your goal' : 'Continuing your goal'
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
  return <section className="session-workflow" aria-label="Autonomous workflow" aria-busy={busy !== null}>
    <div className="session-workflow__header">
      <button type="button" className="session-workflow__heading" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        {workflow.state === 'completed' ? <Check size={14} /> : <CircleDot size={14} className={running && !waiting ? 'session-workflow__live' : undefined} />}
        <span aria-live="polite">{label}</span><ChevronDown size={13} className={expanded ? 'is-open' : undefined} />
      </button>
      <span className="session-workflow__turns" title="Provider turns used; this is a turn budget, not a percentage of work completed.">{workflow.counters.turns}/{workflow.limits.maxTurns} turns</span>
      <div className="session-workflow__actions">
        {running ? <button type="button" disabled={busy !== null} onClick={() => void act('pause')} aria-label="Pause autonomous workflow"><Pause size={13} /><span>Pause</span></button> : null}
        {workflow.state === 'paused' ? <button type="button" disabled={busy !== null || session.status === 'running' || session.status === 'waiting' || budgetExhausted} onClick={() => void act('resume')} aria-label={resumeLabel}><Play size={13} /><span>{resumeLabel}</span></button> : null}
        {!terminal ? <button type="button" disabled={busy !== null} onClick={() => void act('stop')} aria-label="Stop autonomous workflow"><Square size={12} /><span>Stop</span></button> : null}
      </div>
    </div>
    {expanded ? <div className="session-workflow__body">
      <p className="session-workflow__goal">{workflow.goal}</p>
      {workflow.summary ? <p className="session-workflow__summary">{workflow.summary}</p> : null}
      {workflow.state === 'completed' ? <button type="button" className="link-btn" onClick={() => useMingle.getState().setContextTab('changes')}>Review changes</button> : null}
      {waiting ? <p className="session-workflow__hint">Answer the question or permission request in this conversation to continue.</p> : null}
      {workflow.state === 'paused' && workflow.stopReason === 'app-closed' ? <p className="session-workflow__hint">Resume checks the current workspace before continuing partial work.</p> : null}
      {extraTurns && extraMinutes ? <p className="session-workflow__hint">Resuming grants {extraTurns} additional turns and {extraTimeLabel} more.</p> : null}
      {workflow.state === 'paused' && budgetExhausted ? <p className="session-workflow__hint">This goal reached its maximum budget. Stop it before starting a new goal.</p> : null}
    </div> : null}
    {error ? <p className="session-workflow__error" role="alert">{error}</p> : null}
  </section>;
}

export function WorkflowLimitsControl({ limits, onChange, disabled }: { limits: WorkflowLimits; onChange: (value: WorkflowLimits) => void; disabled: boolean }) {
  return <div className="workflow-setup">
    <span>Work through the goal, check the result, and report what needs you.</span>
    <details><summary>Up to {limits.maxTurns} turns <ChevronDown size={12} /></summary><div className="workflow-setup__fields">
      <label>Turn budget<input type="number" min={1} max={50} step={1} value={limits.maxTurns} disabled={disabled} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isInteger(value) && value >= 1 && value <= 50) onChange({ ...limits, maxTurns: value }); }} /></label>
      <label>Time budget (minutes)<input type="number" min={1} max={1440} step={1} value={limits.maxElapsedMinutes} disabled={disabled} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isInteger(value) && value >= 1 && value <= 1440) onChange({ ...limits, maxElapsedMinutes: value }); }} /></label>
    </div></details>
  </div>;
}
