import { Ban, Check, ChevronDown, Circle, CircleDot } from 'lucide-react';
import { useId, useState } from 'react';
import type { StatusBarState, StatusBarStepStatus } from './deriveStatusBarState';
import './status-bar.css';

const STATUS_LABEL: Record<StatusBarStepStatus, string> = { pending: 'Pending', in_progress: 'In progress', done: 'Done', blocked: 'Blocked' };

function StepIcon({ status }: { status: StatusBarStepStatus }) {
  if (status === 'done') return <Check size={13} aria-hidden="true" />;
  if (status === 'in_progress') return <CircleDot size={13} aria-hidden="true" />;
  if (status === 'blocked') return <Ban size={13} aria-hidden="true" />;
  return <Circle size={13} aria-hidden="true" />;
}

export function StatusBar({ state, onStop }: { state: StatusBarState | null; onStop?: () => void | Promise<void> }) {
  const [expanded, setExpanded] = useState(false);
  const checklistId = useId();
  if (!state) return null;
  const hasChecklist = state.steps.length > 0;

  return (
    <div className={`status-bar${expanded ? ' is-expanded' : ''}`} onKeyDown={(event) => { if (event.key === 'Escape' && expanded) { event.preventDefault(); setExpanded(false); } }}>
      <div className="status-bar__row">
        {hasChecklist ? <button type="button" className="status-bar__toggle" aria-expanded={expanded} aria-controls={checklistId}
          aria-label={expanded ? 'Collapse progress checklist' : 'Expand progress checklist'} onClick={() => setExpanded((value) => !value)}>
          <span className={`status-bar__dot${state.running ? ' is-running' : ''}`} aria-hidden="true" />
          <strong className="status-bar__primary" aria-live="polite">{state.primary}</strong>
          {state.secondary ? <span className="status-bar__secondary" title={state.secondary}>{state.secondary}</span> : null}
          <ChevronDown className="status-bar__chevron" size={14} aria-hidden="true" />
        </button> : <div className="status-bar__message">
          <span className={`status-bar__dot${state.running ? ' is-running' : ''}`} aria-hidden="true" />
          <strong className="status-bar__primary" aria-live="polite">{state.primary}</strong>
          {state.secondary ? <span className="status-bar__secondary" title={state.secondary}>{state.secondary}</span> : null}
        </div>}
        {state.running && onStop ? <button type="button" className="status-bar__stop" onClick={() => void onStop()}>Stop</button> : null}
      </div>
      {hasChecklist ? <ul className="status-bar__steps" id={checklistId} aria-label="Plan steps" hidden={!expanded}>
        {state.steps.map((step) => <li key={step.id} className={`status-bar__step is-${step.status}`}>
          <StepIcon status={step.status} />
          <span className="status-bar__step-title">{step.title}</span>
          <span className="status-bar__step-state">{STATUS_LABEL[step.status]}</span>
        </li>)}
      </ul> : null}
    </div>
  );
}
