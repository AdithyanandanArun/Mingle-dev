import { create } from 'zustand';
import { mergeTextDelta } from '@mingle/contracts/stream';
import type { Approval, Bootstrap, GroupSnapshot, Message, MessageContextRef, Project, ServerEvent, ClientEvent, Session, Task, WorkspaceEvent } from '@mingle/contracts';
import { api, errorMessage } from '../lib/api';
import { terminalBus } from './terminalBus';
import { resolveTab, useBrowserStore } from './browser';
import { activeMembers, findGroupForSession, groupChildSessionIds } from '../lib/groups';

export type View = 'workspace' | 'tasks' | 'activity' | 'map' | 'team-structure' | 'settings';
export type SettingsSection = 'account' | 'general' | 'project' | 'agents' | 'team' | 'providers' | 'browser' | 'appearance';
export type TeamWorkspaceTab = 'people' | 'projects' | 'devices' | 'agents' | 'conversation' | 'recovery' | 'transfers';
export type ContextTab = 'overview' | 'files' | 'changes' | 'browser';
export type Scope = 'session' | 'project';
export type Connection = 'connecting' | 'online' | 'offline';
export type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited' | 'lost';

export type Dialog =
  | { kind: 'project' }
  | { kind: 'task' }
  | { kind: 'handoff'; taskId?: string; fromSessionId?: string }
  | { kind: 'settings' }
  | { kind: 'palette' }
  | { kind: 'rename'; sessionId: string }
  | { kind: 'delete-session'; sessionId: string }
  | { kind: 'delete-group'; groupId: string }
  | { kind: 'import' }
  | { kind: 'shortcuts' }
  | { kind: 'add-agent'; sessionId: string }
  | { kind: 'group-mode'; groupId: string }
  | { kind: 'member-settings'; groupId: string; memberId: string }
  | { kind: 'project-collaboration'; projectId: string };

export interface Toast { id: number; tone: 'info' | 'success' | 'error'; text: string }
export interface StreamEntry { sessionId: string; base: string; text: string }

export interface TerminalState {
  status: TerminalStatus;
  terminalId: string | null;
  exitCode: number | null;
  projectId: string | null;
  sessionId: string | null;
  label: string;
  note: string | null;
}

const LS = 'relay.ui.v2';
interface Persisted {
  activeProjectId?: string; sessionByProject?: Record<string, string>; view?: View; contextTab?: ContextTab;
  contextOpen?: boolean; terminalOpen?: boolean; terminalHeight?: number; scope?: Scope;
}
/** The Preview tab became the shared Browser tab; keep a saved selection pointing at it. */
const migratePersisted = (saved: Persisted): Persisted =>
  (saved.contextTab as string | undefined) === 'preview' ? { ...saved, contextTab: 'browser' } : saved;
const loadPersisted = (): Persisted => {
  try {
    const current = localStorage.getItem(LS);
    if (current) return migratePersisted(JSON.parse(current) as Persisted);
    const previous = JSON.parse(localStorage.getItem('relay.ui.v1') ?? '{}') as Persisted;
    // Keep the user's project/session selection while starting the simpler layout with optional panels closed.
    return { activeProjectId: previous.activeProjectId, sessionByProject: previous.sessionByProject, scope: previous.scope };
  } catch {
    return {};
  }
};
const persisted = loadPersisted();

interface MingleState {
  boot: Bootstrap | null;
  bootError: string | null;
  bootLoading: boolean;
  staleError: string | null;
  connection: Connection;
  attempt: number;
  nextRetryAt: number | null;

  activeProjectId: string | null;
  teamChatProjectId: string | null;
  sessionByProject: Record<string, string>;
  view: View;
  settingsReturnView: Exclude<View, 'settings'>;
  settingsSection: SettingsSection;
  settingsProjectId: string | null;
  settingsTeamTab: TeamWorkspaceTab;
  contextTab: ContextTab;
  contextOpen: boolean;
  terminalOpen: boolean;
  terminalHeight: number;
  sidebarOpen: boolean;
  creatingSession: boolean;
  scope: Scope;
  dialog: Dialog | null;
  selectedTaskId: string | null;
  groupMembersOpenId: string | null;
  groupActionBusyId: string | null;
  centerTab: string;
  mapSelection: string | null;

  streams: Record<string, StreamEntry>;
  drafts: Record<string, string>;
  contextDrafts: Record<string, MessageContextRef[]>;
  toasts: Toast[];
  terminal: TerminalState;

  init(): void;
  refreshNow(): Promise<void>;
  reconnect(): void;
  setView(view: View): void;
  openSettings(options?: { section?: SettingsSection; projectId?: string; teamTab?: TeamWorkspaceTab }): void;
  setSettingsSection(section: SettingsSection): void;
  closeSettings(): void;
  setContextTab(tab: ContextTab): void;
  setGroupMembersOpen(groupId: string | null): void;
  setGroupActionBusy(groupId: string | null): void;
  toggleContext(open?: boolean): void;
  toggleTerminal(open?: boolean): void;
  setTerminalHeight(h: number): void;
  setSidebarOpen(open: boolean): void;
  setScope(scope: Scope): void;
  openDialog(d: Dialog): void;
  closeDialog(): void;
  selectProject(id: string): void;
  openTeamChat(projectId: string): void;
  closeTeamChat(): void;
  selectSession(id: string): void;
  createSession(): Promise<void>;
  organizeSession(id: string, changes: Partial<Pick<Session, 'pinned' | 'unread'>>): Promise<void>;
  /** Merge a group snapshot returned by a group mutation without waiting for the next bootstrap. */
  applyGroup(snapshot: GroupSnapshot): void;
  /** Remove successfully archived records locally while the next bootstrap is pending. */
  applyArchivedSessions(sessionIds: string[], groupId?: string): void;
  selectTask(id: string | null): void;
  setCenterTab(key: string): void;
  setMapSelection(id: string | null): void;
  setDraft(sessionId: string, text: string): void;
  setContextDraft(sessionId: string, refs: MessageContextRef[]): void;
  toast(tone: Toast['tone'], text: string): void;
  dismissToast(id: number): void;
  startTerminal(cols: number, rows: number): void;
  stopTerminal(): void;
  sendTerminalInput(data: string): void;
  resizeTerminal(cols: number, rows: number): void;
}

const sameValue = (a: unknown, b: unknown): boolean => a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
const sameItem = <T extends object>(a: T, b: T): boolean => {
  const ka = Object.keys(a) as (keyof T)[];
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => sameValue(a[k], b[k]));
};

/** Group snapshots have no top-level id; keep the previous reference for any that did not change. */
function reconcileGroups(prev: GroupSnapshot[] | undefined, next: GroupSnapshot[]): GroupSnapshot[] {
  if (!prev) return next;
  const old = new Map(prev.map((p) => [p.group.id, p]));
  let changed = prev.length !== next.length;
  const out = next.map((n, i) => {
    const o = old.get(n.group.id);
    if (o && sameValue(o, n)) {
      if (prev[i] !== o) changed = true;
      return o;
    }
    changed = true;
    return n;
  });
  return changed ? out : prev;
}

/** Reuses previous object references for unchanged items so unrelated components do not re-render. */
function reconcile<T extends { id: string | number }>(prev: T[] | undefined, next: T[]): T[] {
  if (!prev) return next;
  const old = new Map(prev.map((p) => [p.id, p]));
  let changed = prev.length !== next.length;
  const out = next.map((n, i) => {
    const o = old.get(n.id);
    if (o && sameItem(o, n)) {
      if (prev[i] !== o) changed = true;
      return o;
    }
    changed = true;
    return n;
  });
  return changed ? out : prev;
}

function reconcileBootstrap(prev: Bootstrap | null, next: Bootstrap): Bootstrap {
  if (!prev) return next;
  return {
    ...next,
    runs: reconcile(prev.runs, next.runs ?? []),
    toolCalls: reconcile(prev.toolCalls, next.toolCalls ?? []),
    projects: reconcile<Project>(prev.projects, next.projects),
    sessions: reconcile<Session>(prev.sessions, next.sessions),
    messages: reconcile<Message>(prev.messages, next.messages),
    tasks: reconcile<Task>(prev.tasks, next.tasks),
    events: reconcile<WorkspaceEvent>(prev.events, next.events),
    approvals: reconcile<Approval>(prev.approvals, next.approvals),
    plans: reconcile(prev.plans, next.plans),
    questions: reconcile(prev.questions, next.questions),
    providers: reconcile(prev.providers, next.providers),
    settings: sameItem(prev.settings, next.settings) ? prev.settings : next.settings,
    ...(next.groups ? { groups: reconcileGroups(prev.groups, next.groups) } : {}),
  };
}

/** Choose valid selections without disturbing choices that are still valid. */
function resolveSelection(s: Pick<MingleState, 'activeProjectId' | 'sessionByProject'>, boot: Bootstrap): Pick<MingleState, 'activeProjectId' | 'sessionByProject'> {
  let projectId = s.activeProjectId;
  if (!projectId || !boot.projects.some((p) => p.id === projectId)) {
    projectId = (boot.projects.find((p) => p.isExample) ?? boot.projects[0])?.id ?? null;
  }
  const map = { ...s.sessionByProject };
  let changed = false;
  const children = groupChildSessionIds(boot.groups);
  for (const p of boot.projects) {
    // Member sessions are reached through their group's anchor, so they are never a selection of their own.
    const sessions = boot.sessions.filter((x) => x.projectId === p.id && !children.has(x.id));
    const cur = map[p.id];
    if (cur && sessions.some((x) => x.id === cur)) continue;
    const group = findGroupForSession(boot.groups, cur);
    const anchor = group && sessions.find((x) => x.id === group.group.anchorSessionId);
    if (anchor) { map[p.id] = anchor.id; changed = true; continue; }
    if (!cur && p.id !== projectId) continue;
    const pick = sessions.find(session => boot.providers.some(provider => provider.id === session.provider && provider.available)) ?? sessions[0];
    if (pick) map[p.id] = pick.id;
    else delete map[p.id];
    changed = true;
  }
  return { activeProjectId: projectId, sessionByProject: changed ? map : s.sessionByProject };
}

/** Drop stream buffers the server snapshot has already caught up with. */
function pruneStreams(streams: Record<string, StreamEntry>, boot: Bootstrap): Record<string, StreamEntry> {
  let changed = false;
  const out: Record<string, StreamEntry> = {};
  for (const [id, entry] of Object.entries(streams)) {
    const msg = boot.messages.find((m) => m.id === id);
    const session = boot.sessions.find((x) => x.id === entry.sessionId);
    const caughtUp = msg && msg.content.length >= (entry.base + entry.text).length;
    const orphan = !msg && session && session.status !== 'running';
    if (caughtUp || orphan || !session) {
      changed = true;
      continue;
    }
    out[id] = entry;
  }
  return changed ? out : streams;
}

let socket: WebSocket | null = null;
let retryTimer: number | undefined;
let refreshTimer: number | undefined;
let refreshFirstQueuedAt = 0;
let inflight: Promise<void> | null = null;
let dirty = false;
let toastSeq = 1;
let pendingInput = '';
let pendingResize: { cols: number; rows: number } | null = null;
let abandonedStarts = 0;
let started = false;

const stripAnsi = (v: string): string => v.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').trim();
const wsUrl = (): string => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const send = (event: ClientEvent): boolean => {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(event));
  return true;
};

export const useMingle = create<MingleState>((set, get) => {
  let lastBootstrapText: string | null = null;
  const savePersisted = (): void => {
    const s = get();
    const data: Persisted = {
      activeProjectId: s.activeProjectId ?? undefined, sessionByProject: s.sessionByProject, view: s.view, contextTab: s.contextTab,
      contextOpen: s.contextOpen, terminalOpen: s.terminalOpen, terminalHeight: s.terminalHeight, scope: s.scope,
    };
    try {
      localStorage.setItem(LS, JSON.stringify(data));
    } catch {
      /* storage may be unavailable */
    }
  };
  const patch = (p: Partial<MingleState>): void => {
    set(p);
    savePersisted();
  };

  const scheduleRefresh = (): void => {
    const now = Date.now();
    if (!refreshTimer) refreshFirstQueuedAt = now;
    window.clearTimeout(refreshTimer);
    // Debounce bursts of state.changed, but never starve the UI during a long stream.
    const wait = Math.max(0, Math.min(180, 1200 - (now - refreshFirstQueuedAt)));
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined;
      void get().refreshNow();
    }, wait);
  };

  const markTerminalLost = (): void => {
    const t = get().terminal;
    if (t.status === 'running' || t.status === 'starting') {
      set({ terminal: { ...t, status: 'lost', terminalId: null } });
    }
    pendingInput = '';
    abandonedStarts = 0;
  };

  const scheduleReconnect = (): void => {
    window.clearTimeout(retryTimer);
    const attempt = get().attempt + 1;
    const delay = Math.min(500 * 2 ** (attempt - 1), 15_000) + Math.random() * 250;
    set({ attempt, nextRetryAt: Date.now() + delay, connection: 'offline' });
    retryTimer = window.setTimeout(connect, delay);
  };

  const handleServerEvent = (ev: ServerEvent): void => {
    switch (ev.type) {
      case 'browser.opened': {
        // Surface the run's actual tab without stealing focus or changing a human's current tab.
        const { activeProjectId, sessionByProject, view } = get();
        if (view === 'workspace' && activeProjectId && sessionByProject[activeProjectId] === ev.sessionId) {
          const browser = useBrowserStore.getState();
          const current = resolveTab(browser.states[ev.sessionId], browser.selected[ev.sessionId]);
          if (!current?.controlOwner) browser.select(ev.sessionId, ev.tabId);
          patch({ contextTab: 'browser', contextOpen: true });
        }
        break;
      }
      case 'state.changed': {
        const incoming = ev.event;
        const boot = get().boot;
        if (incoming && boot && !boot.events.some((e) => e.id === incoming.id)) {
          set({ boot: { ...boot, events: [...boot.events, incoming] } });
        }
        scheduleRefresh();
        window.dispatchEvent(new Event('mingle:state-changed'));
        break;
      }
      case 'session.delta': {
        const { streams, boot } = get();
        const existing = streams[ev.messageId];
        const snapshot = boot?.messages.find((m) => m.id === ev.messageId)?.content ?? '';
        if (ev.offset !== undefined) {
          const buffered = existing ? existing.base + existing.text : '';
          const current = snapshot.length > buffered.length ? snapshot : buffered;
          const text = mergeTextDelta(current, ev.offset, ev.delta);
          if (text === null) { scheduleRefresh(); break; }
          set({ streams: { ...streams, [ev.messageId]: { sessionId: ev.sessionId, base: '', text } } });
        } else {
          const base = existing ? existing.base : snapshot;
          set({ streams: { ...streams, [ev.messageId]: { sessionId: ev.sessionId, base, text: (existing?.text ?? '') + ev.delta } } });
        }
        break;
      }
      case 'terminal.error': {
        if (abandonedStarts > 0) { abandonedStarts--; break; }
        const terminal = get().terminal;
        if (terminal.status === 'starting') {
          set({ terminal: { ...terminal, status: 'lost', terminalId: null, exitCode: -1, note: ev.message } });
          pendingInput = '';
        }
        get().toast('error', ev.message);
        break;
      }
      case 'terminal.ready': {
        const t = get().terminal;
        if (abandonedStarts > 0 || t.status !== 'starting') {
          // A start we already gave up on (restart/stop while starting): release the orphaned PTY.
          abandonedStarts = Math.max(0, abandonedStarts - 1);
          send({ type: 'terminal.stop', terminalId: ev.terminalId });
          break;
        }
        set({ terminal: { ...t, status: 'running', terminalId: ev.terminalId } });
        if (pendingResize) send({ type: 'terminal.resize', terminalId: ev.terminalId, ...pendingResize });
        if (pendingInput) send({ type: 'terminal.input', terminalId: ev.terminalId, data: pendingInput });
        pendingInput = '';
        break;
      }
      case 'terminal.output': {
        const t = get().terminal;
        if (t.terminalId === ev.terminalId) terminalBus.push(ev.data);
        else if (t.status === 'starting' && !t.terminalId) {
          // The server reports a failed start as output + exit on an id that never got a ready frame.
          set({ terminal: { ...t, terminalId: ev.terminalId, note: `${t.note ?? ''}${stripAnsi(ev.data)}`.trim() } });
        }
        break;
      }
      case 'terminal.exit': {
        const t = get().terminal;
        if (t.terminalId === ev.terminalId) {
          set({ terminal: { ...t, status: t.status === 'starting' ? 'lost' : 'exited', exitCode: ev.exitCode } });
        } else if (abandonedStarts > 0 && ev.exitCode === -1) {
          abandonedStarts -= 1;
        }
        break;
      }
    }
  };

  const connect = (): void => {
    window.clearTimeout(retryTimer);
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    set({ connection: 'connecting', nextRetryAt: null });
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      // Deltas missed while disconnected would leave gaps, so rebuild from the server snapshot.
      set({ connection: 'online', attempt: 0, nextRetryAt: null, streams: {} });
      void get().refreshNow();
    };
    ws.onmessage = (msg) => {
      if (typeof msg.data !== 'string') return;
      try {
        handleServerEvent(JSON.parse(msg.data) as ServerEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      markTerminalLost();
      scheduleReconnect();
    };
    ws.onerror = () => {
      /* close follows; reconnect handled there */
    };
  };

  const addOptimisticSessionMessage = (event: Event): void => {
    const message = (event as CustomEvent<{ message?: Message }>).detail?.message;
    if (!message || !message.id.startsWith('optimistic:')) return;
    set((s) => s.boot && !s.boot.messages.some((row) => row.id === message.id)
      ? { boot: { ...s.boot, messages: [...s.boot.messages, message] } } : {});
  };
  const removeOptimisticSessionMessage = (event: Event): void => {
    const messageId = (event as CustomEvent<{ messageId?: string }>).detail?.messageId;
    if (!messageId) return;
    set((s) => s.boot?.messages.some((row) => row.id === messageId)
      ? { boot: { ...s.boot, messages: s.boot.messages.filter((row) => row.id !== messageId) } } : {});
  };
  const addOptimisticGroupMessage = (event: Event): void => {
    const detail = (event as CustomEvent<{ groupId?: string; message?: import('@mingle/contracts').GroupMessage }>).detail;
    if (!detail?.groupId || !detail.message) return;
    set((s) => {
      if (!s.boot) return {};
      const groups = s.boot.groups ?? [];
      if (!groups.some((group) => group.group.id === detail.groupId)) return {};
      return { boot: { ...s.boot, groups: groups.map((group) => group.group.id === detail.groupId
        ? { ...group, messages: [...group.messages, detail.message!] } : group) } };
    });
  };
  const removeOptimisticGroupMessage = (event: Event): void => {
    const detail = (event as CustomEvent<{ groupId?: string; messageId?: string }>).detail;
    if (!detail?.groupId || !detail.messageId) return;
    set((s) => s.boot?.groups?.some((group) => group.group.id === detail.groupId && group.messages.some((message) => message.id === detail.messageId))
      ? { boot: { ...s.boot!, groups: s.boot!.groups!.map((group) => group.group.id === detail.groupId
        ? { ...group, messages: group.messages.filter((message) => message.id !== detail.messageId) } : group) } } : {});
  };

  const initialTerminal: TerminalState = { status: 'idle', terminalId: null, exitCode: null, projectId: null, sessionId: null, label: '', note: null };

  return {
    boot: null,
    bootError: null,
    bootLoading: true,
    staleError: null,
    connection: 'connecting',
    attempt: 0,
    nextRetryAt: null,

    activeProjectId: persisted.activeProjectId ?? null,
    teamChatProjectId: null,
    sessionByProject: persisted.sessionByProject ?? {},
    view: persisted.view ?? 'workspace',
    settingsReturnView: 'workspace',
    settingsSection: 'general',
    settingsProjectId: persisted.activeProjectId ?? null,
    settingsTeamTab: 'people',
    contextTab: persisted.contextTab ?? 'files',
    contextOpen: persisted.contextOpen ?? false,
    terminalOpen: persisted.terminalOpen ?? false,
    terminalHeight: persisted.terminalHeight ?? 260,
    sidebarOpen: false,
    creatingSession: false,
    scope: persisted.scope ?? 'session',
    dialog: null,
    selectedTaskId: null,
    groupMembersOpenId: null,
    groupActionBusyId: null,
    centerTab: 'session',
    mapSelection: null,

    streams: {},
    drafts: {},
    contextDrafts: {},
    toasts: [],
    terminal: initialTerminal,

    init() {
      if (started) return;
      started = true;
      window.addEventListener('mingle:optimistic-session-message', addOptimisticSessionMessage);
      window.addEventListener('mingle:optimistic-session-remove', removeOptimisticSessionMessage);
      window.addEventListener('mingle:optimistic-group-message', addOptimisticGroupMessage);
      window.addEventListener('mingle:optimistic-group-remove', removeOptimisticGroupMessage);
      window.addEventListener('mingle:optimistic-group-accepted', (event) => {
        const snapshot = (event as CustomEvent<{ snapshot?: GroupSnapshot }>).detail?.snapshot;
        if (snapshot) get().applyGroup(snapshot);
      });
      connect();
      void get().refreshNow();
      window.addEventListener('online', handleOnline);
      document.addEventListener('visibilitychange', handleVisibility);
    },

    refreshNow() {
      if (inflight) {
        dirty = true;
        return inflight;
      }
      inflight = (async () => {
        do {
          dirty = false;
          try {
            const next = await api.bootstrap();
            const s = get();
            const serialized = JSON.stringify(next);
            if (serialized === lastBootstrapText) {
              if (s.bootLoading || s.bootError || s.staleError) set({ bootError: null, staleError: null, bootLoading: false });
              continue;
            }
            lastBootstrapText = serialized;
            const pendingOptimistic = s.boot?.messages.filter((message) => message.id.startsWith('optimistic:') &&
              !next.messages.some((saved) => saved.role === 'user' && saved.sessionId === message.sessionId && saved.content === message.content &&
                Math.abs(Date.parse(saved.createdAt) - Date.parse(message.createdAt)) < 10_000)) ?? [];
            const boot = reconcileBootstrap(s.boot, pendingOptimistic.length
              ? { ...next, messages: [...next.messages, ...pendingOptimistic] }
              : next);
            const sel = resolveSelection(s, boot);
            set({ boot, bootError: null, staleError: null, bootLoading: false, streams: pruneStreams(s.streams, boot), ...sel });
            savePersisted();
          } catch (e) {
            const msg = errorMessage(e);
            if (get().boot) set({ staleError: msg, bootLoading: false });
            else set({ bootError: msg, bootLoading: false });
          }
        } while (dirty);
      })().finally(() => { inflight = null; });
      return inflight;
    },

    reconnect() {
      window.clearTimeout(retryTimer);
      if (socket && socket.readyState === WebSocket.OPEN) {
        void get().refreshNow();
        return;
      }
      if (socket) {
        socket.onclose = null;
        socket.close();
        socket = null;
      }
      set({ attempt: 0 });
      connect();
      void get().refreshNow();
    },

    setView: (view) => {
      if (view === 'settings') { get().openSettings(); return; }
      patch({ view, sidebarOpen: false, dialog: null, teamChatProjectId: null });
    },
    openSettings(options) {
      const view = get().view;
      patch({ view: 'settings', settingsReturnView: view === 'settings' ? get().settingsReturnView : view,
        settingsSection: options?.section ?? 'general', settingsProjectId: options?.projectId ?? get().activeProjectId,
        settingsTeamTab: options?.teamTab ?? 'people', teamChatProjectId: null,
        dialog: null, sidebarOpen: false });
      window.requestAnimationFrame(() => document.getElementById('settings-title')?.focus());
    },
    setSettingsSection: (settingsSection) => set({ settingsSection }),
    closeSettings() { patch({ view: get().settingsReturnView, dialog: null }); },
    setContextTab: (contextTab) => patch({ contextTab, contextOpen: true }),
    toggleContext: (open) => patch({ contextOpen: open ?? !get().contextOpen }),
    toggleTerminal: (open) => patch({ terminalOpen: open ?? !get().terminalOpen, view: 'workspace' }),
    setTerminalHeight: (terminalHeight) => patch({ terminalHeight }),
    setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
    setScope: (scope) => patch({ scope }),
    openDialog: (dialog) => { if (dialog.kind === 'settings') get().openSettings(); else set({ dialog }); },
    closeDialog: () => set({ dialog: null }),
    setGroupMembersOpen: (groupMembersOpenId) => set({ groupMembersOpenId }),
    setGroupActionBusy: (groupActionBusyId) => set({ groupActionBusyId }),

    selectProject(id) {
      const { boot, sessionByProject } = get();
      if (!boot?.projects.some((p) => p.id === id)) return;
      const children = groupChildSessionIds(boot.groups);
      const sessions = boot.sessions.filter((s) => s.projectId === id && !children.has(s.id));
      const remembered = sessionByProject[id];
      const pick = sessions.find((s) => s.id === remembered) ?? sessions[0];
      patch({
        activeProjectId: id, settingsProjectId: id, centerTab: 'session', sidebarOpen: false, teamChatProjectId: null,
        sessionByProject: pick ? { ...sessionByProject, [id]: pick.id } : sessionByProject,
      });
      if (pick?.unread && get().view === 'workspace') void get().organizeSession(pick.id, { unread: false }).catch(() => {});
    },
    openTeamChat(projectId) {
      const project = get().boot?.projects.find((item) => item.id === projectId);
      if (!project) return;
      patch({ activeProjectId: projectId, settingsProjectId: projectId, view: 'workspace', teamChatProjectId: projectId, sidebarOpen: false, dialog: null });
    },
    closeTeamChat() { patch({ teamChatProjectId: null }); },
    selectSession(id) {
      const boot = get().boot;
      // Choosing any member of a group opens the group through its anchor session.
      const group = findGroupForSession(boot?.groups, id);
      const s = boot?.sessions.find((x) => x.id === (group?.group.anchorSessionId ?? id));
      if (!boot || !s) return;
      patch({
        activeProjectId: s.projectId, sessionByProject: { ...get().sessionByProject, [s.projectId]: s.id },
        view: 'workspace', centerTab: 'session', sidebarOpen: false, teamChatProjectId: null,
      });
      const toRead = group ? activeMembers(group).map((member) => boot.sessions.find((x) => x.id === member.sessionId)).filter((x): x is Session => Boolean(x?.unread)) : s.unread ? [s] : [];
      for (const session of toRead) void get().organizeSession(session.id, { unread: false }).catch(() => {});
    },
    applyGroup(snapshot) {
      set((s) => {
        if (!s.boot) return {};
        const groups = s.boot.groups ?? [];
        const next = groups.some((g) => g.group.id === snapshot.group.id) ? groups.map((g) => (g.group.id === snapshot.group.id ? snapshot : g)) : [...groups, snapshot];
        return { boot: { ...s.boot, groups: next } };
      });
    },
    applyArchivedSessions(sessionIds, groupId) {
      const ids = new Set(sessionIds);
      const terminalSessionId = get().terminal.sessionId;
      if (terminalSessionId && ids.has(terminalSessionId)) get().stopTerminal();
      set((s) => {
        if (!s.boot) return {};
        const boot: Bootstrap = {
          ...s.boot,
          sessions: s.boot.sessions.filter((session) => !ids.has(session.id)),
          ...(groupId ? { groups: (s.boot.groups ?? []).filter((group) => group.group.id !== groupId) } : {}),
        };
        const streams = Object.fromEntries(Object.entries(s.streams).filter(([, stream]) => !ids.has(stream.sessionId)));
        const drafts = { ...s.drafts };
        const contextDrafts = { ...s.contextDrafts };
        for (const id of ids) delete drafts[id];
        for (const id of ids) delete contextDrafts[id];
        return {
          boot, streams, drafts, contextDrafts,
          ...(groupId && s.groupMembersOpenId === groupId ? { groupMembersOpenId: null } : {}),
          ...(groupId && s.groupActionBusyId === groupId ? { groupActionBusyId: null } : {}),
          ...resolveSelection(s, boot),
        };
      });
    },
    async organizeSession(id, changes) {
      try {
        const updated = await api.updateSession(id, changes);
        // Merge only organization flags: a provider run may have advanced while this request was in flight.
        set((s) => ({ boot: s.boot ? { ...s.boot, sessions: s.boot.sessions.map((session) => session.id === id ? { ...session, pinned: updated.pinned, unread: updated.unread } : session) } : null }));
        await get().refreshNow();
      } catch (error) {
        get().toast('error', errorMessage(error));
        throw error;
      }
    },
    async createSession() {
      const { activeProjectId, creatingSession, connection } = get();
      if (creatingSession) return;
      if (!activeProjectId) { get().toast('error', 'Open a project first.'); return; }
      if (connection !== 'online') { get().toast('error', 'Reconnect to the server to create a session.'); return; }
      set({ creatingSession: true });
      try {
        const session = await api.createSession({ projectId: activeProjectId });
        await get().refreshNow();
        // Keep the server result usable even if the subsequent bootstrap request failed.
        set((s) => ({ boot: s.boot ? { ...s.boot, sessions: [...s.boot.sessions.filter((x) => x.id !== session.id), session] } : s.boot }));
        get().selectSession(session.id);
        window.requestAnimationFrame(() => document.getElementById(`composer-${session.id}`)?.focus());
      } catch (error) {
        get().toast('error', errorMessage(error));
      } finally {
        set({ creatingSession: false });
      }
    },
    selectTask: (selectedTaskId) => set({ selectedTaskId }),
    setCenterTab: (centerTab) => set({ centerTab }),
    setMapSelection: (mapSelection) => set({ mapSelection }),
    setDraft: (sessionId, text) => set((s) => ({ drafts: { ...s.drafts, [sessionId]: text } })),
    setContextDraft: (sessionId, refs) => set((s) => ({ contextDrafts: { ...s.contextDrafts, [sessionId]: refs.slice(0, 10) } })),

    toast(tone, text) {
      const id = toastSeq++;
      set((s) => ({ toasts: [...s.toasts.slice(-3), { id, tone, text }] }));
      window.setTimeout(() => get().dismissToast(id), tone === 'error' ? 8000 : 4000);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    startTerminal(cols, rows) {
      const s = get();
      if (s.terminal.status === 'starting' || s.terminal.status === 'running') return;
      const project = s.boot?.projects.find((p) => p.id === s.activeProjectId);
      if (!project) return;
      const session = s.scope === 'session' ? s.boot?.sessions.find((x) => x.id === s.sessionByProject[project.id]) : undefined;
      terminalBus.reset();
      pendingInput = '';
      pendingResize = { cols, rows };
      const ok = send({ type: 'terminal.start', projectId: project.id, sessionId: session?.id, cols, rows });
      set({
        terminal: {
          status: ok ? 'starting' : 'lost', terminalId: null, exitCode: null, projectId: project.id, sessionId: session?.id ?? null,
          label: session ? `${session.name} · ${session.isolated ? 'worktree' : 'project folder'}` : `${project.name} · project folder`,
          note: ok ? null : 'Not connected to the server.',
        },
      });
    },
    stopTerminal() {
      const t = get().terminal;
      if (t.status === 'starting') abandonedStarts += 1;
      if (t.terminalId) send({ type: 'terminal.stop', terminalId: t.terminalId });
      set({ terminal: { ...initialTerminal } });
    },
    sendTerminalInput(data) {
      const t = get().terminal;
      if (t.status === 'running' && t.terminalId) send({ type: 'terminal.input', terminalId: t.terminalId, data });
      else if (t.status === 'starting') pendingInput += data;
    },
    resizeTerminal(cols, rows) {
      pendingResize = { cols, rows };
      const t = get().terminal;
      if (t.status === 'running' && t.terminalId) send({ type: 'terminal.resize', terminalId: t.terminalId, cols, rows });
    },
  };
});

function handleOnline(): void { useMingle.getState().reconnect(); }
function handleVisibility(): void {
  if (document.visibilityState === 'visible' && useMingle.getState().connection !== 'online') useMingle.getState().reconnect();
}

// React refresh can preserve App's effect while replacing this store module. Boot its replacement explicitly.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.clearTimeout(retryTimer);
    window.clearTimeout(refreshTimer);
    window.removeEventListener('online', handleOnline);
    document.removeEventListener('visibilitychange', handleVisibility);
    if (socket) { socket.onclose = null; socket.close(); socket = null; }
  });
  useMingle.getState().init();
}

/* Selectors */
export const useProject = (): Project | undefined =>
  useMingle((s) => s.boot?.projects.find((p) => p.id === s.activeProjectId));
export const useActiveSession = (): Session | undefined =>
  useMingle((s) => {
    const id = s.activeProjectId ? s.sessionByProject[s.activeProjectId] : undefined;
    return id ? s.boot?.sessions.find((x) => x.id === id) : undefined;
  });
/** The group the active session anchors, when it has been converted. */
export const useActiveGroup = (): GroupSnapshot | undefined =>
  useMingle((s) => {
    const id = s.activeProjectId ? s.sessionByProject[s.activeProjectId] : undefined;
    return findGroupForSession(s.boot?.groups, id);
  });
export const useGroupById = (groupId: string): GroupSnapshot | undefined =>
  useMingle((s) => s.boot?.groups?.find((g) => g.group.id === groupId));
