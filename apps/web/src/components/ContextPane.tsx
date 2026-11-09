import { useEffect, useRef, useState } from 'react';
import { BookOpen, FileText, GitCompare, Globe, Info, X } from 'lucide-react';
import { useActiveSession, useMingle, type ContextTab } from '../store/store';
import { useBrowserStore } from '../store/browser';
import { cx } from '../lib/format';
import { Boundary, IconButton } from './ui';
import { Overview } from './context/Overview';
import { Files } from './context/Files';
import { Changes } from './context/Changes';
import { Browser } from './context/Browser';
import { ProjectMemory } from './context/ProjectMemory';

const TABS: { id: ContextTab; label: string; icon: typeof Info }[] = [
  { id: 'overview', label: 'Overview', icon: Info },
  { id: 'files', label: 'Files', icon: FileText },
  { id: 'changes', label: 'Changes', icon: GitCompare },
  { id: 'memory', label: 'Memory', icon: BookOpen },
  { id: 'browser', label: 'Browser', icon: Globe },
];

export function ContextPane() {
  const tab = useMingle((s) => s.contextTab);
  const open = useMingle((s) => s.contextOpen);
  const { setContextTab, toggleContext } = useMingle.getState();
  const [visited, setVisited] = useState<Set<ContextTab>>(() => new Set([tab]));
  const listRef = useRef<HTMLDivElement>(null);
  const focusReturnFrame = useRef<number | null>(null);
  const session = useActiveSession();
  const browserLive = useBrowserStore((s) => (session ? s.states[session.id]?.status === 'connected' : false));
  useEffect(() => setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab))), [tab]);
  useEffect(() => () => { if (focusReturnFrame.current !== null) window.cancelAnimationFrame(focusReturnFrame.current); }, []);

  const close = () => {
    toggleContext(false);
    if (focusReturnFrame.current !== null) window.cancelAnimationFrame(focusReturnFrame.current);
    focusReturnFrame.current = window.requestAnimationFrame(() => {
      focusReturnFrame.current = null;
      if (!useMingle.getState().contextOpen) document.querySelector<HTMLButtonElement>('button[aria-label="Show context pane"]')?.focus({ preventScroll: true });
    });
  };

  const onKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    if (e.key === 'ArrowRight') setContextTab(TABS[(i + 1) % TABS.length]!.id);
    else if (e.key === 'ArrowLeft') setContextTab(TABS[(i + TABS.length - 1) % TABS.length]!.id);
    else if (e.key === 'Home') setContextTab(TABS[0]!.id);
    else if (e.key === 'End') setContextTab(TABS[TABS.length - 1]!.id);
    else return;
    e.preventDefault();
    window.requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };

  return (
    <aside className={cx('context', open && 'is-open')} aria-label="Context" aria-hidden={!open} inert={!open} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}>
      <div className="context__content">
      <div className="context__tabs" role="tablist" aria-label="Context sections" ref={listRef} onKeyDown={onKey}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" role="tab" id={`ctx-tab-${id}`} aria-selected={tab === id} aria-controls={`ctx-panel-${id}`} tabIndex={tab === id ? 0 : -1} className={cx('ctab', tab === id && 'is-active')} onClick={() => setContextTab(id)}>
            <Icon size={13} aria-hidden="true" />{label}{id === 'browser' && browserLive ? <i className="ctab__live" title="Browser connected" role="img" aria-label="connected" /> : null}
          </button>
        ))}
        <IconButton label="Close context pane" className="context__close" onClick={close}><X size={15} /></IconButton>
      </div>
      <div className="context__body">
        {TABS.map(({ id }) => (
          <div key={id} role="tabpanel" id={`ctx-panel-${id}`} aria-labelledby={`ctx-tab-${id}`} hidden={tab !== id} className="context__panel">
            {visited.has(id) ? (
              <Boundary label={`${id[0]!.toUpperCase()}${id.slice(1)}`}>
                {id === 'overview' ? <Overview /> : id === 'files' ? <Files active={tab === id} /> : id === 'changes' ? <Changes active={tab === id} /> : id === 'memory' ? <ProjectMemory active={tab === id && open} /> : <Browser active={tab === id && open} />}
              </Boundary>
            ) : null}
          </div>
        ))}
      </div>
      </div>
    </aside>
  );
}
