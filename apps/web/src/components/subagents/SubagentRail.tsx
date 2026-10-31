import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { DelegatedSubagent, Provider } from '@mingle/contracts';
import { LoaderCircle, X } from 'lucide-react';
import { PROVIDER_NAMES } from '../../lib/providers';
import { subagentStatusLabel, type SubagentRun } from '../../lib/subagents';
import { AgentIdentity } from '../group/AgentIdentity';
import './SubagentStyles.css';

export function SubagentRail({
  subagents, delegated = [], provider, onOpen, onOpenDelegated, onCancel, expandAtWidth = 960,
}: {
  subagents: readonly SubagentRun[];
  delegated?: readonly DelegatedSubagent[];
  provider: Provider;
  onOpen: (subagentId: string) => void;
  onOpenDelegated?: (subagent: DelegatedSubagent) => void;
  onCancel?: (subagent: DelegatedSubagent) => void;
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
  }, [expandAtWidth, subagents.length, delegated.length]);

  useEffect(() => {
    if (subagents.length + delegated.length === 0) preference.current = null;
  }, [subagents.length, delegated.length]);

  if (subagents.length + delegated.length === 0) return null;
  const total = subagents.length + delegated.length;
  const announcement = [...subagents.map((item) => `${item.label} ${subagentStatusLabel(item.status)}`), ...delegated.map((item) => `${item.name} ${item.status}`)].join('. ');
  const toggle = () => {
    const next = !expanded;
    preference.current = next;
    setExpanded(next);
  };

  return (
    <aside ref={panel} className={`agent-presence single-subagents${expanded ? ' is-expanded' : ' is-collapsed'}`} aria-label="Subagents">
      <span className="sr-only" aria-live="polite">{announcement}</span>
      <header className="agent-presence__head">
        <strong>Subagents</strong>
        <span>{total}</span>
        <button type="button" className="agent-presence__toggle" aria-label={expanded ? 'Collapse subagents' : 'Expand subagents'} aria-expanded={expanded} aria-controls={listId} onClick={toggle}>
          <span aria-hidden="true">{expanded ? '−' : '+'}</span>
        </button>
      </header>
      <ul className="agent-presence__list" id={listId} aria-hidden={!expanded} inert={!expanded}>
        {delegated.map((item) => {
          const status = item.status === 'running' ? 'Running' : item.status === 'completed' ? 'Done' : item.status === 'failed' ? 'Failed' : 'Cancelled';
          const elapsed = Math.max(0, Math.floor(((item.endedAt ? Date.parse(item.endedAt) : Date.now()) - Date.parse(item.startedAt)) / 1000));
          return <li key={`delegated:${item.id}`} className={`agent-presence__row is-${item.status}`}>
            <div className="agent-presence__open" role="group" aria-label={`@${item.name}, ${PROVIDER_NAMES[item.provider]} ${item.model}, ${status}`}>
              <button type="button" className="agent-presence__identity" onClick={() => onOpenDelegated?.(item)} aria-label={`Open @${item.name} subagent session`}>
                <AgentIdentity handle={item.name} identityKey={item.childSessionId} provider={item.provider} />
              </button>
              <span className="agent-presence__state">{item.status === 'running' ? <LoaderCircle size={12} className="single-subagents__spinner" aria-hidden="true" /> : null}<span>{status}</span></span>
              <small className="agent-presence__model" title={`${PROVIDER_NAMES[item.provider]} · ${item.model}`}>{PROVIDER_NAMES[item.provider]} · {item.model} · {elapsed}s</small>
              {item.resultPreview ? <small className="single-subagents__preview">{item.resultPreview}</small> : null}
              {item.status === 'running' && onCancel ? <button type="button" className="single-subagents__cancel" onClick={() => onCancel(item)} aria-label={`Cancel @${item.name}`}><X size={12} /> Cancel</button> : null}
            </div>
          </li>;
        })}
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
              <small className="agent-presence__model" title={`${PROVIDER_NAMES[provider]} · ${subagent.model}`}>
                {PROVIDER_NAMES[provider]} · {subagent.model}
              </small>
              <small className="single-subagents__elapsed">{Math.max(0, Math.floor(((subagent.endedAt ? Date.parse(subagent.endedAt) : Date.now()) - Date.parse(subagent.startedAt)) / 1000))}s</small>
              {subagent.finalResult ? <small className="single-subagents__preview">{subagent.finalResult}</small> : null}
            </button>
          </li>;
        })}
      </ul>
    </aside>
  );
}
