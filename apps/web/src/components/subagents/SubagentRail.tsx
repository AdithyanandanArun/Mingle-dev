import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Provider } from '@mingle/contracts';
import { LoaderCircle } from 'lucide-react';
import { subagentStatusLabel, type SubagentRun } from '../../lib/subagents';
import { AgentIdentity } from '../group/AgentIdentity';
import './SubagentStyles.css';

export function SubagentRail({
  subagents, provider, onOpen, expandAtWidth = 960,
}: {
  subagents: readonly SubagentRun[];
  provider: Provider;
  onOpen: (subagentId: string) => void;
  expandAtWidth?: number;
}) {
  const panel = useRef<HTMLElement>(null);
  const preference = useRef<boolean | null>(null);
  const listId = useId();
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const container = panel.current?.parentElement;
    if (!container) return;
    const update = () => {
      if (preference.current === null) setExpanded(container.clientWidth >= expandAtWidth);
    };
    update();
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(container);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [expandAtWidth, subagents.length]);

  useEffect(() => {
    if (subagents.length === 0) preference.current = null;
  }, [subagents.length]);

  if (subagents.length === 0) return null;
  const toggle = () => {
    const next = !expanded;
    preference.current = next;
    setExpanded(next);
  };

  return (
    <aside ref={panel} className={`agent-presence single-subagents${expanded ? ' is-expanded' : ' is-collapsed'}`} aria-label="Subagents">
      <header className="agent-presence__head">
        <strong>Subagents</strong>
        <span>{subagents.length}</span>
        <button type="button" className="agent-presence__toggle" aria-label={expanded ? 'Collapse subagents' : 'Expand subagents'} aria-expanded={expanded} aria-controls={listId} onClick={toggle}>
          <span aria-hidden="true">{expanded ? '−' : '+'}</span>
        </button>
      </header>
      <ul className="agent-presence__list" id={listId} aria-hidden={!expanded} inert={!expanded}>
        {subagents.map((subagent) => {
          const status = subagentStatusLabel(subagent.status);
          return <li key={subagent.id} className={`agent-presence__row is-${subagent.status}`}>
            <button type="button" className="agent-presence__open" aria-label={`Open @${subagent.handle} subagent chat, ${status}`} onClick={() => onOpen(subagent.id)}>
              <div className="agent-presence__identity" title={subagent.label}>
                <AgentIdentity handle={subagent.handle} identityKey={subagent.id} provider={provider} />
              </div>
              <span className="agent-presence__state">
                {subagent.status === 'running' ? <LoaderCircle size={12} className="single-subagents__spinner" aria-hidden="true" /> : null}
                <span className={subagent.status === 'running' ? 'activity-shimmer' : undefined}>{status}</span>
              </span>
              <small className="agent-presence__model" title={`${subagent.model} · ${subagent.type}`}>{subagent.model} · {subagent.type}</small>
            </button>
          </li>;
        })}
      </ul>
    </aside>
  );
}
