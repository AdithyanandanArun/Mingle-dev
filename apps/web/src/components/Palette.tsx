import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowDownToLine, ArrowRightLeft, CornerDownLeft, FolderOpen, FolderPlus, Kanban, LayoutPanelLeft, ListPlus, Moon, Network, PanelRight, Pencil, Plus, RefreshCw, Search, Settings, Square, SquareTerminal, Keyboard, Globe } from 'lucide-react';
import { useMingle } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { cx, fuzzy } from '../lib/format';
import { Kbd, Modal, MOD, ProviderMark } from './ui';
import { groupChildSessionIds } from '../lib/groups';

interface Cmd { id: string; label: string; group: string; icon: ReactNode; hint?: string; keywords?: string; run: () => void; disabled?: string }

export function Palette() {
  const s = useMingle();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = s.closeDialog;
  const project = s.boot?.projects.find((p) => p.id === s.activeProjectId);
  const session = s.activeProjectId ? s.boot?.sessions.find((x) => x.id === s.sessionByProject[s.activeProjectId!]) : undefined;

  const commands = useMemo<Cmd[]>(() => {
    const st = useMingle.getState();
    const go = (fn: () => void) => () => { st.closeDialog(); fn(); };
    const list: Cmd[] = [
      { id: 'new-session', group: 'Create', label: 'New session', icon: <Plus size={15} />, run: go(() => { void st.createSession(); }), disabled: !project ? 'Open a project first' : s.creatingSession ? 'Creating session…' : undefined },
      { id: 'new-task', group: 'Create', label: 'New task', icon: <ListPlus size={15} />, run: go(() => st.openDialog({ kind: 'task' })), disabled: project ? undefined : 'Open a project first' },
      { id: 'new-project', group: 'Create', label: 'Open project…', icon: <FolderPlus size={15} />, run: go(() => st.openDialog({ kind: 'project' })) },
      { id: 'import-conversation', group: 'Create', label: 'Import conversation…', keywords: 'claude codex antigravity opencode history transcript', icon: <ArrowDownToLine size={15} />, run: go(() => st.openDialog({ kind: 'import' })) },
      { id: 'v-workspace', group: 'Go to', label: 'Workspace', icon: <LayoutPanelLeft size={15} />, run: go(() => st.setView('workspace')) },
      { id: 'v-tasks', group: 'Go to', label: 'Tasks', icon: <Kanban size={15} />, run: go(() => st.setView('tasks')) },
      { id: 'v-activity', group: 'Go to', label: 'Activity', icon: <Activity size={15} />, run: go(() => st.setView('activity')) },
      { id: 'v-map', group: 'Go to', label: 'Agent map', icon: <Network size={15} />, run: go(() => st.setView('map')) },
      { id: 'tab-files', group: 'Workspace', label: 'Show files', icon: <PanelRight size={15} />, run: go(() => { st.setView('workspace'); st.setContextTab('files'); }) },
      { id: 'tab-changes', group: 'Workspace', label: 'Show changes', icon: <PanelRight size={15} />, run: go(() => { st.setView('workspace'); st.setContextTab('changes'); }) },
      { id: 'tab-browser', group: 'Workspace', label: 'Show browser', keywords: 'preview web page chromium', icon: <Globe size={15} />, run: go(() => { st.setView('workspace'); st.setContextTab('browser'); }) },
      { id: 'terminal', group: 'Workspace', label: st.terminalOpen ? 'Hide terminal' : 'Show terminal', icon: <SquareTerminal size={15} />, hint: `${MOD} J`, run: go(() => st.toggleTerminal()) },
      { id: 'context', group: 'Workspace', label: st.contextOpen ? 'Hide context pane' : 'Show context pane', icon: <PanelRight size={15} />, run: go(() => st.toggleContext()) },
    ];
    if (session) {
      list.push(
        { id: 'rename', group: 'Session', label: `Rename “${session.name}”`, icon: <Pencil size={15} />, run: go(() => st.openDialog({ kind: 'rename', sessionId: session.id })) },
        { id: 'handoff', group: 'Session', label: 'Hand off an artifact…', icon: <ArrowRightLeft size={15} />, run: go(() => st.openDialog({ kind: 'handoff', fromSessionId: session.id })) },
        {
          id: 'interrupt', group: 'Session', label: `Interrupt “${session.name}”`, icon: <Square size={14} />, disabled: session.status === 'running' || session.status === 'waiting' ? undefined : 'Session is not running',
          run: go(() => { api.interrupt(session.id).then(() => st.refreshNow()).catch((e) => st.toast('error', errorMessage(e))); }),
        },
      );
    }
    const groupChildren = groupChildSessionIds(s.boot?.groups);
    for (const x of s.boot?.sessions ?? []) {
      if (groupChildren.has(x.id)) continue;
      list.push({ id: `s-${x.id}`, group: 'Sessions', label: x.name, hint: x.model, icon: <ProviderMark provider={x.provider} size={16} />, keywords: `${x.provider} ${x.status} session`, run: go(() => st.selectSession(x.id)) });
    }
    for (const p of s.boot?.projects ?? []) {
      if (p.id !== project?.id) list.push({ id: `p-${p.id}`, group: 'Projects', label: `Switch to ${p.name}`, icon: <FolderOpen size={15} />, run: go(() => st.selectProject(p.id)) });
    }
    list.push(
      { id: 'settings', group: 'App', label: 'Settings', icon: <Settings size={15} />, run: go(() => st.openDialog({ kind: 'settings' })) },
      { id: 'providers', group: 'App', label: 'Re-check providers', icon: <RefreshCw size={15} />, run: go(() => { api.refreshProviders().then(() => st.refreshNow()).then(() => st.toast('info', 'Providers re-checked')).catch((e) => st.toast('error', errorMessage(e))); }) },
      { id: 'theme', group: 'App', label: s.boot?.settings.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme', icon: <Moon size={15} />, run: go(() => { api.updateSettings({ theme: s.boot?.settings.theme === 'light' ? 'dark' : 'light' }).then(() => st.refreshNow()).catch((e) => st.toast('error', errorMessage(e))); }) },
      { id: 'reconnect', group: 'App', label: 'Reconnect to server', icon: <RefreshCw size={15} />, run: go(() => st.reconnect()) },
      { id: 'shortcuts', group: 'App', label: 'Keyboard shortcuts', icon: <Keyboard size={15} />, run: go(() => st.openDialog({ kind: 'shortcuts' })) },
    );
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.boot?.sessions, s.boot?.projects, s.boot?.settings.theme, project?.id, session?.id, session?.status, session?.name, s.terminalOpen, s.contextOpen, s.creatingSession]);

  const results = useMemo(() => {
    if (!query.trim()) return commands;
    return commands
      .map((c) => ({ c, score: fuzzy(query.trim(), `${c.label} ${c.group} ${c.keywords ?? ''}`) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.c);
  }, [commands, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [index, results]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const direction = e.key === 'ArrowDown' ? 1 : -1;
      let next = index;
      for (let step = 0; step < results.length; step += 1) {
        next = (next + direction + results.length) % results.length;
        if (!results[next]!.disabled) { setIndex(next); break; }
      }
      e.preventDefault();
    }
    else if (e.key === 'Enter') {
      const c = results[index];
      if (c && !c.disabled) { e.preventDefault(); c.run(); }
    }
  };

  let lastGroup = '';
  return (
    <Modal variant="palette" title="Command menu" onClose={close}>
      <div className="palette" onKeyDown={onKey}>
        <div className="palette__input">
          <Search size={15} aria-hidden="true" />
          <input
            data-autofocus role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={results[index] ? `cmd-${results[index].id}` : undefined}
            aria-label="Search commands" placeholder="Type a command or session name…" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} autoComplete="off"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="palette__list" id="palette-list" role="listbox" ref={listRef} aria-label="Commands">
          {results.length === 0 ? <p className="palette__empty">No matching commands.</p> : null}
          {results.map((c, i) => {
            const showGroup = c.group !== lastGroup && !query;
            lastGroup = c.group;
            return (
              <div key={c.id} role="presentation">
                {showGroup ? <div className="menu__section" role="presentation">{c.group}</div> : null}
                <div
                  id={`cmd-${c.id}`} role="option" aria-selected={i === index} aria-disabled={Boolean(c.disabled)} title={c.disabled}
                  className={cx('cmd', i === index && 'is-selected', c.disabled && 'is-disabled')} onMouseMove={() => setIndex(i)} onClick={() => { if (!c.disabled) c.run(); }}
                >
                  <span className="cmd__icon">{c.icon}</span>
                  <span className="cmd__label">{c.label}</span>
                  {c.disabled ? <span className="cmd__hint">{c.disabled}</span> : c.hint ? <span className="cmd__hint">{c.hint}</span> : null}
                  {i === index && !c.disabled ? <CornerDownLeft size={12} aria-hidden="true" /> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

export function ShortcutsDialog() {
  const close = useMingle.getState().closeDialog;
  const rows: [string, string[]][] = [
    ['Open command menu', [MOD, 'K']], ['Toggle terminal', [MOD, 'J']], ['Save file in editor', [MOD, 'S']],
    ['Send message', ['↵']], ['New line in message', ['⇧', '↵']], ['Close dialog or menu', ['Esc']],
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={close} width={420}>
      <ul className="shortcuts">{rows.map(([label, keys]) => <li key={label}><span>{label}</span><span>{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span></li>)}</ul>
    </Modal>
  );
}
