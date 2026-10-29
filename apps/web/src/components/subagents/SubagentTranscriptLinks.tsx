import { ChevronRight } from 'lucide-react';
import type { SubagentRun } from '../../lib/subagents';

export function SubagentTranscriptLinks({ subagents, onOpen }: { subagents: readonly SubagentRun[]; onOpen: (id: string) => void }) {
  if (subagents.length === 0) return null;
  return <details className="subagent-transcript-links">
    <summary>{subagents.length} {subagents.length === 1 ? 'subagent' : 'subagents'}</summary>
    <div className="subagent-transcript-links__list">
      {subagents.map((subagent) => <button type="button" key={subagent.id} onClick={() => onOpen(subagent.id)}>
        <ChevronRight size={11} aria-hidden="true" /> @{subagent.handle}
      </button>)}
    </div>
  </details>;
}
