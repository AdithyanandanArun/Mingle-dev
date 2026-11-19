import { useLayoutEffect, useRef } from 'react';
import { ChevronDown, CircleHelp } from 'lucide-react';
import type { UserQuestion } from '@mingle/contracts';
import type { Speaker } from '../../lib/groupTimeline';
import { UserQuestionCard } from '../ConversationParts';
import './question-dock.css';

export function PendingQuestions({ questions, speakers }: {
  questions: readonly UserQuestion[];
  speakers?: ReadonlyMap<string, Speaker>;
}) {
  const dock = useRef<HTMLDetailsElement>(null);
  const latestId = questions.at(-1)?.id;
  useLayoutEffect(() => {
    if (dock.current) dock.current.open = true;
  }, [latestId]);

  if (!questions.length) return null;
  return <details ref={dock} className="composer-question-dock">
    <summary className="composer-question-dock__toggle" data-activity-strip>
      <CircleHelp size={14} aria-hidden="true" />
      <strong>{questions.length === 1 ? 'Question for you' : `${questions.length} questions for you`}</strong>
      <ChevronDown size={14} aria-hidden="true" />
    </summary>
    <div className="composer-question-dock__body">
      {questions.map(question => <UserQuestionCard key={question.id} question={question} speaker={speakers?.get(question.sessionId)} />)}
    </div>
  </details>;
}
