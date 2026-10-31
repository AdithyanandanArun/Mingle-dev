import { ArrowLeft, Menu as MenuIcon, PanelRight, Pencil, SquareTerminal, MoreHorizontal, Square, ListPlus, UserPlus, Users, Trash2 } from 'lucide-react';
import type { Session } from '@mingle/contracts';
import { useMingle, useActiveSession, useActiveGroup, useProject } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { Button, IconButton, Menu, MenuItem, MenuSeparator } from './ui';
import { useState } from 'react';
import { activeMembers, isBusy } from '../lib/groups';
import { stopGroup } from '../lib/groupActions';
import { GroupControl } from './group/GroupControl';
import { cx } from '../lib/format';
import { useTeamStructure } from '../lib/team-structure-context';

const TITLES = { workspace: 'Workspace', tasks: 'Tasks', activity: 'Activity', map: 'Agent map', 'team-structure': 'Team structure', settings: 'Settings' } as const;
const EMPTY_SESSIONS: Session[] = [];

export function Header() {
  const view = useMingle((s) => s.view);
  const project = useProject();
  const session = useActiveSession();
  const group = useActiveGroup();
  const teamStructure = useTeamStructure().snapshot;
  const teamInfo = useMingle((s) => project ? s.teamSessionsByProject[project.id] : undefined);
  const selectedSessionId = useMingle((s) => project ? s.sessionByProject[project.id] : undefined);
  const sessions = useMingle((s) => s.boot?.sessions ?? EMPTY_SESSIONS);
  const connection = useMingle((s) => s.connection);
  const contextOpen = useMingle((s) => s.contextOpen);
  const terminalOpen = useMingle((s) => s.terminalOpen);
  const groupActionBusy = useMingle((s) => s.groupActionBusyId !== null);
  const groupHasWork = group ? group.deliveries.some((delivery) => delivery.status === 'queued' || delivery.status === 'running')
    || activeMembers(group).some((member) => isBusy(sessions.find((item) => item.id === member.sessionId))) : false;
  const online = connection === 'online';
  const { openDialog, toggleContext, toggleTerminal, setSidebarOpen } = useMingle.getState();
  const [stopping, setStopping] = useState(false);
  const hasActiveRun = isBusy(session);
  const remoteTeamSession = teamInfo && !teamInfo.hostIsThisDevice ? teamInfo.teamSession : null;
  const activeTeamSession = remoteTeamSession && selectedSessionId === remoteTeamSession.sessionId;
  const sharedHostGroup = group && teamInfo?.hostIsThisDevice && teamInfo.teamSession?.groupId === group.group.id;

  const interrupt = async () => {
    if (!session) return;
    setStopping(true);
    try {
      if (group) {
        await stopGroup(group);
        return;
      }
      await api.interrupt(session.id);
      useMingle.getState().toast('info', `Interrupted ${session.name}`);
      void useMingle.getState().refreshNow();
    } catch (e) {
      useMingle.getState().toast('error', errorMessage(e));
    } finally {
      setStopping(false);
    }
  };

  if (view === 'settings') return <header className="header header--settings">
    <IconButton label="Open sidebar" className="header__burger" onClick={() => setSidebarOpen(true)}><MenuIcon size={16} /></IconButton>
    <Button variant="ghost" size="sm" onClick={() => useMingle.getState().closeSettings()}><ArrowLeft size={14} /> Back to workspace</Button>
  </header>;

  return (
    <header className={cx('header', view === 'workspace' && (group || activeTeamSession) && 'header--team')}>
      <div className="header__primary">
        <IconButton label="Open sidebar" className="header__burger" onClick={() => setSidebarOpen(true)}><MenuIcon size={16} /></IconButton>
        <div className="header__title">
          <div className="crumbs" aria-label="Current view">
            <span className="crumbs__project" title={project?.name}>{project?.name ?? 'No project'}</span>
            <span className="crumbs__sep" aria-hidden="true">/</span>
            <span className="crumbs__current" title={session ? [session.name, session.branch].filter(Boolean).join(' · ') : activeTeamSession ? remoteTeamSession.title : undefined}>{view === 'workspace' ? session?.name ?? (activeTeamSession ? remoteTeamSession.title : 'Workspace') : TITLES[view]}</span>
          </div>
          {view === 'workspace' && project?.isExample ? <span className="header__example badge" role="note" aria-label="Example workspace. Messages start real runs with your configured provider." title="Example workspace. Messages start real runs with your configured provider.">Example</span> : null}
          {view === 'workspace' && sharedHostGroup ? <span className="header__shared-team" role="note">Shared with team</span> : null}
        </div>
      </div>
      <div className="header__team-row">
        {view === 'workspace' && group ? <GroupControl key={group.group.id} snapshot={group} /> : null}
        {view === 'workspace' && activeTeamSession ? <div className="header__team"><div className="team-control team-control--remote" aria-label={`${teamStructure?.members.length ?? 'Team'} agents in shared session`} title="Shared team session">
          <Users size={14} aria-hidden="true" /><span className="team-control__count">{teamStructure?.members.length ?? '—'}<span> agents</span></span>
        </div></div> : null}
        <div className="header__actions">
          {view === 'workspace' && session && !group && hasActiveRun ? (
            <Button size="sm" variant="danger" busy={stopping} onClick={interrupt}><Square size={11} fill="currentColor" /> Interrupt</Button>
          ) : null}
          {view === 'tasks' ? (
            <Button size="sm" onClick={() => openDialog({ kind: 'task' })} disabled={!project} why="Open a project first"><ListPlus size={14} /> New task</Button>
          ) : null}
          {view === 'workspace' ? (
            <>
              <Button className="header__compact-action" size="sm" variant="secondary" aria-label="Add teammates" title="Add teammates" disabled={!project || project.isExample || connection !== 'online'} why={!project ? 'Open a project first' : project.isExample ? 'Choose a Git project to invite teammates' : connection !== 'online' ? 'Reconnect to the server first' : undefined} onClick={() => project && openDialog({ kind: 'project-collaboration', projectId: project.id })}><Users size={14} /><span>Add teammates</span></Button>
              {group && !activeTeamSession ? <Button className="header__compact-action" size="sm" variant="secondary" aria-label="Add agent" title="Add agent" disabled={connection !== 'online'} why={connection !== 'online' ? 'Reconnect to the server first' : undefined} onClick={() => openDialog({ kind: 'add-agent', sessionId: group.group.anchorSessionId })}><UserPlus size={14} /><span>Add agent</span></Button> : null}
              {!group && !activeTeamSession ? <Button className="header__compact-action" size="sm" variant="secondary" aria-label="Add agent" title="Add agent" disabled={!session || connection !== 'online'} why={!session ? 'Select a session first' : connection !== 'online' ? 'Reconnect to the server first' : undefined} onClick={() => session && openDialog({ kind: 'add-agent', sessionId: session.id })}><UserPlus size={14} /><span>Add agent</span></Button> : null}
              <IconButton label={terminalOpen ? 'Hide terminal' : 'Show terminal'} active={terminalOpen} onClick={() => toggleTerminal()}><SquareTerminal size={16} /></IconButton>
              <IconButton label={contextOpen ? 'Hide context pane' : 'Show context pane'} active={contextOpen} onClick={() => toggleContext()}><PanelRight size={16} /></IconButton>
              {activeTeamSession ? null : <Menu
                align="end" width={200}
                trigger={(p) => <IconButton label="Session actions" disabled={!session} why="No session selected" {...p}><MoreHorizontal size={16} /></IconButton>}
              >
                <MenuItem icon={<Pencil size={14} />} onSelect={() => session && openDialog({ kind: 'rename', sessionId: session.id })}>Rename session</MenuItem>
                {group ? <MenuSeparator /> : null}
                <MenuItem
                  icon={<Square size={14} />}
                  disabled={group ? !online || !groupHasWork || groupActionBusy : !session || !hasActiveRun || stopping}
                  why={group ? !online ? 'Reconnect to the server first' : groupActionBusy ? 'A group action is already in progress' : 'No active or queued work' : 'No active run to stop'}
                  onSelect={interrupt}
                >{group ? 'Stop active runs & pause queue' : 'Interrupt run'}</MenuItem>
                <MenuSeparator />
                {group
                  ? <MenuItem danger icon={<Trash2 size={14} />} disabled={!online} why="Reconnect to the server first" onSelect={() => openDialog({ kind: 'delete-group', groupId: group.group.id })}>Delete group…</MenuItem>
                  : <MenuItem danger icon={<Trash2 size={14} />} disabled={!online} why="Reconnect to the server first" onSelect={() => session && openDialog({ kind: 'delete-session', sessionId: session.id })}>Delete session…</MenuItem>}
              </Menu>}
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
