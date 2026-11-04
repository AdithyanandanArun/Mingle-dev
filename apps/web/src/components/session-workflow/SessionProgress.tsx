import { useId, useState } from 'react';
import { ChevronDown, CircleHelp } from 'lucide-react';
import type { Session, SessionWorkflow, UserQuestion } from '@mingle/contracts';
import { useRetainedPresence } from '../../lib/motion';
import { UserQuestionCard } from '../ConversationParts';
import { StatusBar } from '../status-bar/StatusBar';
import type { StatusBarState } from '../status-bar/deriveStatusBarState';
import { SessionWorkflowPanel } from './SessionWorkflowPanel';
import '../composer/composer-surface.css';

const NO_QUESTIONS: readonly UserQuestion[] = [];

/** The composer dock summarizes work; individual helper activity lives in the floating bubble. */
export function SessionProgress({ session, workflow, state, questions = NO_QUESTIONS, helperCount = 0, onStop }: {
  session: Session; workflow?: SessionWorkflow; state?: StatusBarState | null;
  questions?: readonly UserQuestion[]; helperCount?: number; onStop: () => void;
}) {
  const activeWorkflow = workflow?.state === 'running' || workflow?.state === 'paused' ? workflow : undefined;
  const { value, present, closing } = useRetainedPresence(
    state || activeWorkflow || questions.length ? { state, workflow: activeWorkflow, questions, helperCount } : null, 180,
  );
  const [collapsedQuestion, setCollapsedQuestion] = useState<string | null>(null);
  const bodyId = useId();
  if (!present || !value) return null;
  const questionKey = value.questions.map((question) => question.id).join(':');
  const questionsExpanded = collapsedQuestion !== questionKey;
  const current = value.state?.steps.find(step => step.status === 'in_progress') ?? value.state?.steps.find(step => step.status === 'pending' || step.status === 'blocked');
  return <div className={`composer-activity${closing ? ' is-closing' : ''}`} aria-hidden={closing || undefined} inert={closing}>
    <div className="composer-activity__inner">
      {value.questions.length ? <section className="composer-question-dock" aria-label="Questions for you">
        <button type="button" className="composer-question-dock__toggle" data-activity-strip aria-expanded={questionsExpanded} aria-controls={bodyId}
          onClick={() => setCollapsedQuestion(questionsExpanded ? questionKey : null)}>
          <CircleHelp size={14} aria-hidden="true" />
          <strong aria-live="polite">{value.questions.length === 1 ? 'Question for you' : `${value.questions.length} questions for you`}</strong>
          <span>Waiting for your answer</span>
          {value.helperCount ? <small className="composer-question-dock__count">{value.helperCount} active</small> : null}
          <ChevronDown size={14} className={questionsExpanded ? 'is-open' : undefined} aria-hidden="true" />
        </button>
        <div id={bodyId} className="composer-question-dock__body" data-question-dock hidden={!questionsExpanded}>
          {value.questions.map(question => <UserQuestionCard key={question.id} question={question} compact />)}
        </div>
      </section> : null}
      {value.workflow ? <SessionWorkflowPanel key={value.workflow.id} workflow={value.workflow} session={session} compact totalHelpers={value.helperCount} currentTask={current?.title}>
        <StatusBar state={value.state ?? null} embedded />
      </SessionWorkflowPanel> : !value.questions.length ? <StatusBar state={value.state ?? null} helperCount={value.helperCount} onStop={onStop} /> : null}
    </div>
  </div>;
}
