import { Ban, Check, ChevronDown, Circle, CircleDot, ListTodo } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import type { StatusBarState, StatusBarStepStatus } from './deriveStatusBarState';
import './status-bar.css';

const STATUS_LABEL: Record<StatusBarStepStatus, string> = { pending: 'Pending', in_progress: 'In progress', done: 'Done', blocked: 'Blocked' };

function StepIcon({ status }: { status: StatusBarStepStatus }) {
  if (status === 'done') return <Check size={13} aria-hidden="true" />;
  if (status === 'in_progress') return <CircleDot size={13} aria-hidden="true" />;
  if (status === 'blocked') return <Ban size={13} aria-hidden="true" />;
  return <Circle size={13} aria-hidden="true" />;
}

export function StatusBar({ state, onStop, children, helperCount = 0, embedded = false }: { state: StatusBarState | null; onStop?: () => void | Promise<void>; children?: ReactNode; helperCount?: number; embedded?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const checklistId = useId();
  if (!state && !helperCount && !embedded) return null;
  state ??= { primary: 'Subagent activity', running: false, steps: [] };
  const hasChecklist = state.steps.length > 0;
  const doneCount = state.steps.filter((step) => step.status === 'done').length;
  const currentStep = state.steps.find((step) => step.status === 'in_progress')
    ?? state.steps.find((step) => step.status === 'pending' || step.status === 'blocked')
    ?? state.steps[0];

  const steps = <ul className="status-bar__steps" id={!helperCount && !embedded ? checklistId : undefined} aria-label="Task checklist" hidden={!embedded && !helperCount && !expanded}>
    {state.steps.map(step => <li key={step.id} className={`status-bar__step is-${step.status}`} aria-current={step.status === 'in_progress' ? 'step' : undefined}>
      <StepIcon status={step.status} /><span className="status-bar__step-title" title={step.title}>{step.title}</span><span className="status-bar__step-state">{STATUS_LABEL[step.status]}</span>
    </li>)}
  </ul>;
  if (embedded) return <div className="session-progress__details">{hasChecklist ? steps : null}{children}</div>;
  return (
    <div className={`status-bar${expanded ? ' is-expanded' : ''}`} onKeyDown={(event) => { if (event.key === 'Escape' && expanded) { event.preventDefault(); setExpanded(false); } }}>
      <div className="status-bar__row">
        {hasChecklist || helperCount ? <button type="button" className="status-bar__toggle" aria-expanded={expanded} aria-controls={checklistId}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${hasChecklist ? `task checklist, ${doneCount} of ${state.steps.length} complete` : 'progress details'}${helperCount ? `, ${helperCount} helpers` : ''}`} onClick={() => setExpanded((value) => !value)}>
          <ListTodo className="status-bar__task-icon" size={13} aria-hidden="true" />
          <span className="status-bar__task-label">{hasChecklist ? 'Tasks' : 'Activity'}</span>
          <strong className="status-bar__task-title" title={currentStep?.title}>{currentStep?.title ?? state.primary}</strong>
          {hasChecklist ? <span className="status-bar__task-count">{doneCount}/{state.steps.length}</span> : null}
          {helperCount ? <span className="status-bar__task-count">{helperCount} helper{helperCount === 1 ? '' : 's'}</span> : null}
          <span className="status-bar__task-progress" aria-hidden="true">
            {state.steps.map((step) => <i key={step.id} className={`is-${step.status}`} />)}
          </span>
          <ChevronDown className="status-bar__chevron" size={14} aria-hidden="true" />
        </button> : <div className="status-bar__message">
          <span className={`status-bar__dot${state.running ? ' is-running' : ''}`} aria-hidden="true" />
          <strong className="status-bar__primary" aria-live="polite">{state.primary}</strong>
          {state.secondary ? <span className="status-bar__secondary" title={state.secondary}>{state.secondary}</span> : null}
        </div>}
        {state.running && onStop ? <button type="button" className="status-bar__stop" onClick={() => void onStop()}>Stop</button> : null}
      </div>
      {helperCount ? <div id={checklistId} className="session-progress__details" hidden={!expanded}>{hasChecklist ? steps : null}{children}</div> : hasChecklist ? steps : null}
    </div>
  );
}
