import type { ReactNode } from 'react';
import type { Session, SessionWorkflow } from '@mingle/contracts';
import { StatusBar } from '../status-bar/StatusBar';
import type { StatusBarState } from '../status-bar/deriveStatusBarState';
import { SessionWorkflowPanel } from './SessionWorkflowPanel';

/** One disclosure owns goal controls, checklist and helper navigation. */
export function SessionProgress({ session, workflow, state, helpers, helperCount = 0, onStop }: {
  session: Session; workflow?: SessionWorkflow; state?: StatusBarState | null;
  helpers?: ReactNode; helperCount?: number; onStop: () => void;
}) {
  const current = state?.steps.find(step => step.status === 'in_progress') ?? state?.steps.find(step => step.status === 'pending' || step.status === 'blocked');
  if (workflow) return <SessionWorkflowPanel key={workflow.id} workflow={workflow} session={session} compact totalHelpers={helperCount} currentTask={current?.title}>
    <StatusBar state={state ?? null} embedded>{helpers}</StatusBar>
  </SessionWorkflowPanel>;
  return <StatusBar state={state ?? null} helperCount={helperCount} onStop={onStop}>{helpers}</StatusBar>;
}
