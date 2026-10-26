import { useCallback, useEffect, useState } from 'react';
import { Activity, ArrowDownToLine, ChevronsUpDown, FolderOpen, FolderPlus, FolderMinus, Kanban, LayoutPanelLeft, MoreHorizontal, Network, Search, Settings, SquarePen, Loader2, Pin, Users } from 'lucide-react';
import type { Project, Session } from '@mingle/contracts';
import { useMingle, useProject, type View } from '../store/store';
import { copyText } from '../lib/clipboard';
import { errorMessage } from '../lib/api';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { cx, relativeTime, useNow } from '../lib/format';
import { DialogMotionContext, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, StatusDot } from './ui';
import { activeMembers, findGroupForSession, groupChildSessionIds, groupSessionStatus } from '../lib/groups';
import { RemoveProjectDialog } from './RemoveProjectDialog';
import { useRetainedPresence } from '../lib/motion';
import { useTeamStructure } from '../lib/team-structure-context';

const VIEWS: { view: View; label: string; icon: typeof Kanban }[] = [
  { view: 'tasks', label: 'Tasks', icon: Kanban }, { view: 'activity', label: 'Activity', icon: Activity }, { view: 'map', label: 'Agent map', icon: Network }, { view: 'team-structure', label: 'Team structure', icon: Network },
];
const GROUPS: { id: string; label: string; match: (session: Session) => boolean }[] = [
  { id: 'pinned', label: 'Pinned', match: (session) => session.pinned },
  { id: 'attention', label: 'Needs attention', match: (session) => session.status === 'waiting' || session.status === 'error' },
  { id: 'running', label: 'Running', match: (session) => session.status === 'running' },
  { id: 'idle', label: 'Sessions', match: (session) => session.status === 'idle' || session.status === 'interrupted' },
];

export function Sidebar() {
  const boot = useMingle((state) => state.boot);
  const project = useProject();
  const teamInfo = useMingle((state) => project ? state.teamSessionsByProject[project.id] : undefined);
  const teamStructure = useTeamStructure().snapshot;
  const view = useMingle((state) => state.view);
  const sidebarOpen = useMingle((state) => state.sidebarOpen);
  const activeSessionId = useMingle((state) => state.activeProjectId ? state.sessionByProject[state.activeProjectId] : undefined);
  const connection = useMingle((state) => state.connection);
  const creatingSession = useMingle((state) => state.creatingSession);
  const { setView, selectSession, selectProject, openDialog, createSession, openTeamSession } = useMingle.getState();
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number; returnFocus: HTMLElement } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const { value: retainedMenu, present: menuPresent, closing: menuClosing, key: menuKey } = useRetainedPresence(menuOpen ? menu : null, 160);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const [organizing, setOrganizing] = useState<Set<string>>(() => new Set());
  const [removingProject, setRemovingProject] = useState<Project | null>(null);
  const { value: retainedProject, present: removePresent, closing: removeClosing, key: removeKey } = useRetainedPresence(removingProject, 160);
  const now = useNow();
  const childSessions = groupChildSessionIds(boot?.groups);
  const sessions = (boot?.sessions ?? []).filter((session) => session.projectId === project?.id && !childSessions.has(session.id)).map((session) => {
    const group = findGroupForSession(boot?.groups, session.id);
    if (!group || group.group.anchorSessionId !== session.id) return session;
    const members = activeMembers(group);
    const memberSessions = members.map((member) => boot?.sessions.find((item) => item.id === member.sessionId)).filter((item): item is Session => Boolean(item));
    const updatedAt = memberSessions.reduce((latest, item) => item.updatedAt > latest ? item.updatedAt : latest, session.updatedAt);
    return { ...session, status: groupSessionStatus(group, boot?.sessions ?? []), unread: memberSessions.some((item) => item.unread), updatedAt };
  });
  const remoteTeamSession = teamInfo && !teamInfo.hostIsThisDevice ? teamInfo.teamSession : null;
  const connectionLabel = connection === 'online' ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Disconnected';

  const target = sessions.find((session) => session.id === retainedMenu?.sessionId);
  const targetGroup = target ? findGroupForSession(boot?.groups, target.id) : undefined;
  useEffect(() => { if (menuOpen && retainedMenu && !target) setMenuOpen(false); }, [menuOpen, retainedMenu, target]);
  const organize = async (session: Session, changes: Partial<Pick<Session, 'pinned' | 'unread'>>) => {
    setOrganizing((current) => new Set(current).add(session.id));
    const focused = document.activeElement;
    const preserveFocus = focused instanceof HTMLElement && focused.closest('.sitem-row')?.getAttribute('data-session-id') === session.id;
    try {
      const group = changes.unread === false ? findGroupForSession(boot?.groups, session.id) : undefined;
      const affected = group ? activeMembers(group).map((member) => boot?.sessions.find((item) => item.id === member.sessionId)).filter((item): item is Session => Boolean(item && item.unread)) : [session];
      await Promise.all(affected.map((item) => useMingle.getState().organizeSession(item.id, changes)));
      if (preserveFocus && (!document.activeElement || document.activeElement === document.body || document.activeElement === focused)) {
        requestAnimationFrame(() => {
          const row = Array.from(document.querySelectorAll<HTMLElement>('.sitem-row')).find((element) => element.dataset.sessionId === session.id);
          row?.querySelector<HTMLElement>(focused?.classList.contains('sitem__actions') ? '.sitem__actions' : '.sitem')?.focus({ preventScroll: true });
        });
      }
    }
    catch { /* The store reports the failure. */ }
    finally { setOrganizing((current) => { const next = new Set(current); next.delete(session.id); return next; }); }
  };
  const copy = async (text: string, label: string) => {
    try { await copyText(text); useMingle.getState().toast('success', `${label} copied.`); }
    catch (error) { useMingle.getState().toast('error', errorMessage(error)); }
  };
  const menuItems: ContextMenuEntry[] = target ? [
    { id: 'pin', label: target.pinned ? 'Unpin session' : 'Pin session', checked: target.pinned, disabled: connection !== 'online' || organizing.has(target.id), onSelect: () => void organize(target, { pinned: !target.pinned }) },
    { type: 'separator', id: 'organize' },
    { id: 'rename', label: 'Rename session…', disabled: connection !== 'online', onSelect: () => openDialog({ kind: 'rename', sessionId: target.id }) },
    { id: 'unread', label: target.unread ? 'Mark read' : 'Mark unread', disabled: connection !== 'online' || organizing.has(target.id), onSelect: () => void organize(target, { unread: !target.unread }) },
    { type: 'separator', id: 'details' },
    { id: 'copy', label: 'Copy', children: [
      { id: 'copy-name', label: 'Session name', onSelect: () => void copy(target.name, 'Session name') },
      { id: 'copy-id', label: 'Session ID', onSelect: () => void copy(target.id, 'Session ID') },
      { id: 'copy-branch', label: 'Branch name', disabled: !target.branch, onSelect: () => void copy(target.branch!, 'Branch name') },
      { id: 'copy-path', label: target.isolated ? 'Worktree path' : 'Project path', onSelect: () => void copy(target.worktreePath, 'Folder path') },
    ] },
    { id: 'project-settings', label: 'Project settings', onSelect: () => useMingle.getState().openSettings({ section: 'project', projectId: target.projectId }) },
    { type: 'separator', id: 'delete-section' },
    targetGroup?.group.anchorSessionId === target.id
      ? { id: 'delete-group', label: 'Delete group…', danger: true, disabled: connection !== 'online', onSelect: () => openDialog({ kind: 'delete-group', groupId: targetGroup.group.id }) }
      : { id: 'delete-session', label: 'Delete session…', danger: true, disabled: connection !== 'online', onSelect: () => openDialog({ kind: 'delete-session', sessionId: target.id }) },
  ] : [];

  return <><aside className={cx('sidebar', sidebarOpen && 'is-open')} aria-label="Primary">
    <div className="sidebar__brand"><img className="sidebar__logo" src="/mingle.svg" width="20" height="20" alt="" aria-hidden="true" /><span className="brand-name">Mingle</span><span className="sidebar__local">local</span></div>
    <div className="sidebar__toolbar">
      <button type="button" className="sidebar__search" onClick={() => openDialog({ kind: 'palette' })} aria-label="Search sessions and commands"><Search size={15} /><span>Search</span></button>
      <IconButton label="Open project" onClick={() => openDialog({ kind: 'project' })}><FolderPlus size={15} /></IconButton>
      <IconButton label="New session" disabled={!project || creatingSession || connection !== 'online'} why={!project ? 'Open a project first' : connection !== 'online' ? 'Reconnect to the server first' : undefined} onClick={() => void createSession()}>{creatingSession ? <Loader2 size={15} className="spin" /> : <SquarePen size={15} />}</IconButton>
    </div>
    <div className="sidebar__project">
      <Menu width={250} trigger={(props) => <button type="button" className="switcher" aria-label={`Project: ${project?.name ?? 'none'}. Switch project`} title={project?.path} {...props}>
        <FolderOpen size={13} /><span className="switcher__text"><strong>{project?.name ?? 'Choose a project'}</strong></span><ChevronsUpDown size={12} />
      </button>}>
        <MenuLabel>Projects</MenuLabel>
        {(boot?.projects ?? []).map((item) => <MenuItem key={item.id} selected={item.id === project?.id} onSelect={() => selectProject(item.id)} icon={<FolderOpen size={14} />} hint={item.isExample ? 'example' : undefined}>{item.name}</MenuItem>)}
        <MenuSeparator /><MenuItem icon={<ArrowDownToLine size={14} />} onSelect={() => openDialog({ kind: 'import' })}>Import conversation…</MenuItem><MenuItem icon={<FolderPlus size={14} />} onSelect={() => openDialog({ kind: 'project' })}>Open project…</MenuItem>
        {project ? <><MenuSeparator /><MenuItem icon={<FolderMinus size={14} />} disabled={connection !== 'online'} onSelect={() => setRemovingProject(project)}>Remove project…</MenuItem></> : null}
      </Menu>
    </div>
    <div className="sidebar__sessions">
      <div className="session-scroll" role="list" aria-label="Sessions">
        {!sessions.length && !remoteTeamSession ? <p className="sidebar__empty">No sessions yet.</p> : null}
        {remoteTeamSession ? <div className="sgroup sgroup--team-session" role="group" aria-label="Shared project group conversation">
          <div className="sgroup__label">Shared project conversation</div>
          <div role="listitem" className="sitem-row" data-session-id={remoteTeamSession.sessionId}>
            <button type="button" className={cx('sitem', remoteTeamSession.sessionId === activeSessionId && view === 'workspace' && 'is-active')}
              onClick={() => openTeamSession(project!.id, remoteTeamSession.sessionId)}
              aria-current={remoteTeamSession.sessionId === activeSessionId && view === 'workspace' ? 'true' : undefined}
              aria-label={`${remoteTeamSession.title}, shared project team conversation`}
              title={`${remoteTeamSession.title} · Shared project conversation`}>
              <span className="sitem__text"><span className="sitem__meta"><span>Shared group · {project?.name}</span><span><Users size={11} aria-hidden="true" /></span></span><strong><span>{remoteTeamSession.title}</span></strong></span>
              <span className="sitem__state"><span className="team-session-row__mark" aria-label="Team conversation">Team</span></span>
            </button>
          </div>
        </div> : null}
        {GROUPS.map((group) => {
          const items = sessions.filter((session) => group.match(session) && (group.id === 'pinned' || !session.pinned)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          if (!items.length) return null;
          return <div key={group.id} className="sgroup" role="group" aria-label={group.label}>
            {group.id !== 'idle' || sessions.some((session) => session.pinned) ? <div className="sgroup__label">{group.label}</div> : null}
            {items.map((session) => {
              const groupSnapshot = findGroupForSession(boot?.groups, session.id);
              const groupConversation = groupSnapshot?.group.anchorSessionId === session.id;
              const teamAgent = teamStructure && teamStructure.projectId === project?.id
                ? teamStructure.members.find((member) => member.local && member.sessionId === session.id) : undefined;
              const kind = groupConversation ? 'Shared group conversation' : teamAgent ? `Your agent · @${teamAgent.handle}` : 'Individual session';
              return <div role="listitem" key={session.id} className={cx('sitem-row', teamAgent && 'sitem-row--agent', groupConversation && 'sitem-row--group')} data-session-id={session.id} onContextMenu={(event) => {
              event.preventDefault();
              const row = event.currentTarget.querySelector<HTMLButtonElement>('.sitem')!;
              setMenuOpen(true);
              setMenu({ sessionId: session.id, x: event.clientX, y: event.clientY, returnFocus: row });
            }} onKeyDown={(event) => {
              if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
              event.preventDefault();
              const row = event.currentTarget.querySelector<HTMLButtonElement>('.sitem')!;
              const bounds = row.getBoundingClientRect();
              setMenuOpen(true);
              setMenu({ sessionId: session.id, x: bounds.left + 24, y: bounds.bottom, returnFocus: event.target as HTMLElement });
            }}>
              <button type="button" className={cx('sitem', session.id === activeSessionId && view === 'workspace' && 'is-active', session.unread && 'is-unread')} onClick={() => selectSession(session.id)} aria-current={session.id === activeSessionId && view === 'workspace' ? 'true' : undefined} aria-label={`${kind}: ${session.name}${session.pinned ? ', pinned' : ''}${session.unread ? ', unread' : ''}`} title={`${kind} · ${session.name} · ${session.model}`}>
                <span className="sitem__text"><span className="sitem__meta"><span>{kind}</span><span>{relativeTime(session.updatedAt, now)}</span></span><strong>{session.unread ? <i className="sitem__unread" aria-hidden="true" /> : null}<span>{session.name}</span></strong></span>
                <span className="sitem__state">{session.pinned ? <Pin size={11} aria-hidden="true" /> : null}{session.status !== 'idle' ? <StatusDot status={session.status} label={false} /> : null}{teamAgent ? <span className="agent-session-row__mark">Agent</span> : groupConversation ? <span className="group-session-row__mark">Group</span> : null}</span>
              </button>
              <button type="button" className="sitem__actions" aria-label={`Actions for ${session.name}`} aria-haspopup="menu" aria-expanded={menuOpen && menu?.sessionId === session.id} onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                if (menuOpen && menu?.sessionId === session.id) setMenuOpen(false);
                else {
                  setMenu({ sessionId: session.id, x: bounds.right, y: bounds.bottom + 4, returnFocus: event.currentTarget });
                  setMenuOpen(true);
                }
              }}><MoreHorizontal size={14} /></button>
            </div>;
            })}
          </div>;
        })}
      </div>
    </div>
    {retainedMenu && menuPresent ? <ContextMenu key={menuKey} x={retainedMenu.x} y={retainedMenu.y} items={menuItems} returnFocus={retainedMenu.returnFocus} open={menuOpen} closing={menuClosing} onClose={closeMenu} /> : null}
    <footer className="sidebar__foot">
      <IconButton label="Settings" active={view === 'settings'} onClick={() => useMingle.getState().openSettings()}><Settings size={15} /></IconButton>
      <IconButton label="Workspace" active={view === 'workspace'} onClick={() => setView('workspace')}><LayoutPanelLeft size={15} /></IconButton>
      <Menu width={192} trigger={(props) => <IconButton label="More workspace views" active={VIEWS.some((item) => item.view === view)} {...props}><MoreHorizontal size={16} /></IconButton>}>
        <MenuLabel>Project</MenuLabel>{VIEWS.map(({ view: target, label, icon: Icon }) => <MenuItem key={target} selected={view === target} icon={<Icon size={14} />} onSelect={() => setView(target)}>{label}</MenuItem>)}
      </Menu>
      <span className="spacer" />
      <button type="button" className={cx('sidebar__connection', `sidebar__connection--${connection}`)} onClick={() => useMingle.getState().reconnect()} title={`${connectionLabel} to the local server. Click to reconnect.`}><i aria-hidden="true" /><span className="sr-only">{connectionLabel}</span></button>
    </footer>
  </aside><DialogMotionContext.Provider key={removeKey} value={removeClosing}>
    {removePresent && retainedProject ? <RemoveProjectDialog project={retainedProject} onClose={() => setRemovingProject(null)} /> : null}
  </DialogMotionContext.Provider></>;
}
