import type { Session, SessionWorkflow } from '@mingle/contracts';
import { useRetainedPresence } from '../../lib/motion';
import { StatusBar } from '../status-bar/StatusBar';
import type { StatusBarState } from '../status-bar/deriveStatusBarState';
import { SessionWorkflowPanel } from './SessionWorkflowPanel';
import '../composer/composer-surface.css';

/** The composer dock summarizes work; individual helper activity lives in the floating bubble. */
export function SessionProgress({ session, workflow, state, helperCount = 0, onStop }: {
  session: Session; workflow?: SessionWorkflow; state?: StatusBarState | null;
  helperCount?: number; onStop: () => void;
}) {
  const activeWorkflow = workflow?.state === 'running' || workflow?.state === 'paused' ? workflow : undefined;
  const { value, present, closing } = useRetainedPresence(
    state || activeWorkflow ? { state, workflow: activeWorkflow, helperCount } : null, 180,
  );
  if (!present || !value) return null;
  const current = value.state?.steps.find(step => step.status === 'in_progress') ?? value.state?.steps.find(step => step.status === 'pending' || step.status === 'blocked');
  return <div className={`composer-activity${closing ? ' is-closing' : ''}`} aria-hidden={closing || undefined} inert={closing}>
    <div className="composer-activity__inner">
      {value.workflow ? <SessionWorkflowPanel key={value.workflow.id} workflow={value.workflow} session={session} compact totalHelpers={value.helperCount} currentTask={current?.title}>
        <StatusBar state={value.state ?? null} embedded />
      </SessionWorkflowPanel> : <StatusBar state={value.state ?? null} helperCount={value.helperCount} onStop={onStop} />}
    </div>
  </div>;
}
