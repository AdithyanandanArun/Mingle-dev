import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMingle } from './store/store';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Workspace } from './views/Workspace';
import { TasksView } from './views/Tasks';
import { ActivityView } from './views/Activity';
import { ConnectionBanner, StartupScreen, Toasts } from './components/Shell';
import { DeleteGroupDialog, DeleteSessionDialog, HandoffDialog, ProjectDialog, RenameDialog, TaskDialog } from './components/Dialogs';
import { ImportDialog } from './components/ImportDialog';
import { SettingsPage } from './components/Settings';
import { Palette, ShortcutsDialog } from './components/Palette';
import { Boundary, DialogMotionContext, Spinner } from './components/ui';
import { cx } from './lib/format';
import { useRetainedPresence } from './lib/motion';
import { AddAgentDialog } from './components/group/AddAgentDialog';
import { GroupModeDialog, MemberSettingsDialog } from './components/group/GroupDialogs';
import { BrowserPopout } from './components/browser/BrowserPopout';
import { ProjectInviteJoinDialog, ProjectTeammatesDialog } from './components/project-collaboration/ProjectCollaboration';

declare global {
  interface Window {
    mingleProjectInvitations?: {
      onInvitation(callback: (token: string) => void): () => void;
    };
  }
}

interface ActiveInvitation { token: string; sequence: number }

const AgentMap = lazy(() => import('./views/AgentMap'));
const TeamStructure = lazy(() => import('./views/TeamStructure'));

function cleanJoinTokenFromLocation(): string | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('join') ?? new URLSearchParams(url.hash.replace(/^#/, '')).get('join');
  if (!token) return null;
  url.searchParams.delete('join');
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  hashParams.delete('join');
  url.hash = hashParams.size ? hashParams.toString() : '';
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return token;
}

function tokenFromDeepLink(value: unknown): string | null {
  const raw = typeof value === 'string' ? value : value && typeof value === 'object' && 'url' in value && typeof value.url === 'string' ? value.url : null;
  if (!raw) return null;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.protocol === 'mingle:') {
      const validJoinTarget = (url.hostname.toLowerCase() === 'join' && ['', '/'].includes(url.pathname))
        || (!url.hostname && ['join', 'join/'].includes(url.pathname));
      if (!validJoinTarget || raw.length > 160 || raw.includes('#') || /[\u0000-\u001f\u007f-\u009f]/.test(raw) || url.username || url.password || url.port) return null;
      const entries = [...url.searchParams.entries()];
      const token = entries.length === 1 && entries[0]?.[0] === 'token' ? entries[0][1] : null;
      if (!token || url.search !== `?token=${token}` || !/^[A-Za-z0-9_-]{43,128}$/.test(token) || token.length % 4 === 1) return null;
      try {
        const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
        const canonical = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return canonical === token ? token : null;
      } catch { return null; }
    }
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin !== window.location.origin && !(isLoopback && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname))) return null;
    return url.searchParams.get('join') ?? new URLSearchParams(url.hash.replace(/^#/, '')).get('join');
  } catch { return null; }
}

function Dialogs() {
  const dialog = useMingle((s) => s.dialog);
  const { value: active, present, closing, key } = useRetainedPresence(dialog, 160);
  if (!present || !active) return null;
  let content: ReactNode = null;
  switch (active.kind) {
    case 'project': content = <ProjectDialog />; break;
    case 'task': content = <TaskDialog />; break;
    case 'handoff': content = <HandoffDialog taskId={active.taskId} fromSessionId={active.fromSessionId} />; break;
    case 'settings': break; // Legacy actions route to the Settings page through the store.
    case 'palette': content = <Palette />; break;
    case 'rename': content = <RenameDialog sessionId={active.sessionId} />; break;
    case 'delete-session': content = <DeleteSessionDialog sessionId={active.sessionId} />; break;
    case 'delete-group': content = <DeleteGroupDialog groupId={active.groupId} />; break;
    case 'import': content = <ImportDialog />; break;
    case 'shortcuts': content = <ShortcutsDialog />; break;
    case 'add-agent': content = <AddAgentDialog sessionId={active.sessionId} />; break;
    case 'group-mode': content = <GroupModeDialog groupId={active.groupId} />; break;
    case 'member-settings': content = <MemberSettingsDialog groupId={active.groupId} memberId={active.memberId} />; break;
    case 'project-collaboration': {
      const project = useMingle.getState().boot?.projects.find((item) => item.id === active.projectId);
      content = project ? <ProjectTeammatesDialog project={project} onClose={() => useMingle.getState().closeDialog()} /> : null;
      break;
    }
  }
  return <DialogMotionContext.Provider key={key} value={closing}>{content}</DialogMotionContext.Provider>;
}

export function App() {
  const boot = useMingle((s) => s.boot);
  const view = useMingle((s) => s.view);
  const theme = useMingle((s) => s.boot?.settings.theme ?? 'dark');
  const sidebarOpen = useMingle((s) => s.sidebarOpen);
  const previousView = useRef(view);
  const [activeInvitation, setActiveInvitation] = useState<ActiveInvitation | null>(null);
  const [joinSuspended, setJoinSuspended] = useState(false);
  const invitationSequence = useRef(0);

  useEffect(() => { useMingle.getState().init(); }, []);
  useEffect(() => {
    const openInvitation = (token: string | null) => {
      if (!token) return;
      cleanJoinTokenFromLocation();
      useMingle.getState().closeDialog();
      setJoinSuspended(false);
      setActiveInvitation({ token, sequence: ++invitationSequence.current });
    };
    const initialToken = cleanJoinTokenFromLocation();
    openInvitation(initialToken);
    // Desktop queues cold/preload links in memory until this listener is installed.
    const unsubscribeInvitation = window.mingleProjectInvitations?.onInvitation((token) => openInvitation(token));
    const capture = (event: Event) => {
      const token = tokenFromDeepLink((event as CustomEvent<unknown>).detail);
      openInvitation(token);
    };
    const captureLocation = () => {
      const token = cleanJoinTokenFromLocation();
      openInvitation(token);
    };
    // The desktop shell forwards second-instance/custom-protocol opens here; tokens remain in React memory only.
    window.addEventListener('mingle:deep-link', capture);
    window.addEventListener('mingle:open-url', capture);
    window.addEventListener('popstate', captureLocation);
    window.addEventListener('hashchange', captureLocation);
    return () => {
      window.removeEventListener('mingle:deep-link', capture);
      window.removeEventListener('mingle:open-url', capture);
      window.removeEventListener('popstate', captureLocation);
      window.removeEventListener('hashchange', captureLocation);
      unsubscribeInvitation?.();
    };
  }, []);
  useEffect(() => {
    if (joinSuspended && view !== 'settings') setJoinSuspended(false);
  }, [joinSuspended, view]);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    if (view === 'settings') document.getElementById('settings-title')?.focus({ preventScroll: true });
    else if (previousView.current === 'settings') {
      const state = useMingle.getState();
      const sessionId = state.activeProjectId ? state.sessionByProject[state.activeProjectId] : undefined;
      const composer = view === 'workspace' && state.centerTab === 'session' && sessionId ? document.getElementById(`composer-${sessionId}`) : null;
      (composer ?? document.getElementById('main'))?.focus({ preventScroll: true });
    }
    previousView.current = view;
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const s = useMingle.getState();
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (s.dialog?.kind === 'palette') s.closeDialog();
        else s.openDialog({ kind: 'palette' });
      } else if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        s.toggleTerminal();
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        if (s.dialog) s.closeDialog();
        else if (s.sidebarOpen) s.setSidebarOpen(false);
        else if (s.selectedTaskId && s.view === 'tasks') s.selectTask(null);
        else if (s.contextOpen && window.innerWidth < 1240) s.toggleContext(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!boot) return <StartupScreen />;

  const browserPopoutId = new URLSearchParams(window.location.search).get('browserPopout');
  if (browserPopoutId) return <BrowserPopout sessionId={browserPopoutId} />;

  return (
    <div className={cx('app', `view-${view}`)}>
      <a className="skip" href="#main">Skip to content</a>
      <Sidebar />
      <button type="button" className={cx('sidebar-scrim', sidebarOpen && 'is-open')} aria-label="Close sidebar" aria-hidden={!sidebarOpen} inert={!sidebarOpen} tabIndex={-1} onClick={() => useMingle.getState().setSidebarOpen(false)} />
      <main className="main" id="main" tabIndex={-1}>
        <Header />
        <ConnectionBanner />
        <div className="main__body">
          <Boundary label="This view">
            {view === 'workspace' ? <Workspace /> : null}
            {view === 'tasks' ? <TasksView /> : null}
            {view === 'activity' ? <ActivityView /> : null}
            {view === 'map' ? <Suspense fallback={<div className="editor__state"><Spinner label="Loading map" /></div>}><AgentMap /></Suspense> : null}
            {view === 'team-structure' ? <Suspense fallback={<div className="editor__state"><Spinner label="Loading team structure" /></div>}><TeamStructure /></Suspense> : null}
            {view === 'settings' ? <SettingsPage /> : null}
          </Boundary>
        </div>
      </main>
      <Dialogs />
      {activeInvitation ? <style>{'.scrim:has(.pc-join) { z-index: 500; }'}</style> : null}
      {activeInvitation && !joinSuspended ? <ProjectInviteJoinDialog
        key={activeInvitation.sequence}
        token={activeInvitation.token}
        onClose={() => { setJoinSuspended(false); setActiveInvitation(null); }}
        onOpenAccountSettings={() => { setJoinSuspended(true); useMingle.getState().openSettings({ section: 'account' }); }}
        onOpenProviderSettings={() => { setJoinSuspended(true); useMingle.getState().openSettings({ section: 'providers' }); }}
        onJoined={(result) => useMingle.getState().openTeamChat(result.projectId)}
      /> : null}
      <Toasts />
    </div>
  );
}
