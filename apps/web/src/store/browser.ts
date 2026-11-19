import { create } from 'zustand';
import type { BrowserSessionState, BrowserTab } from '@mingle/contracts';

interface BrowserUiState {
  /** Last session state the visible pane fetched; lets other surfaces (tab marker) read it without polling. */
  states: Record<string, BrowserSessionState>;
  /** Tab each session's viewer was explicitly pointed at; absent means follow the server's active tab. */
  selected: Record<string, string>;
  /** Open requests held until the session viewer mounts. */
  openRequests: Record<string, number>;
  publish(sessionId: string, state: BrowserSessionState): void;
  select(sessionId: string, tabId: string | null, broadcast?: boolean): void;
  requestOpen(sessionId: string): void;
  acknowledgeOpen(sessionId: string, revision: number): void;
}

const selectionChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('mingle.browser.selection.v1');

export const useBrowserStore = create<BrowserUiState>((set) => ({
  states: {},
  selected: {},
  openRequests: {},
  publish: (sessionId, state) => set((s) => ({ states: { ...s.states, [sessionId]: state } })),
  requestOpen: (sessionId) => set((s) => ({ openRequests: { ...s.openRequests, [sessionId]: (s.openRequests[sessionId] ?? 0) + 1 } })),
  acknowledgeOpen: (sessionId, revision) => set((s) => {
    if (s.openRequests[sessionId] !== revision) return s;
    const openRequests = { ...s.openRequests };
    delete openRequests[sessionId];
    return { openRequests };
  }),
  select: (sessionId, tabId, broadcast = true) => {
    set((s) => {
      const selected = { ...s.selected };
      if (tabId) selected[sessionId] = tabId; else delete selected[sessionId];
      return { selected };
    });
    if (broadcast) selectionChannel?.postMessage({ sessionId, tabId });
  },
}));

selectionChannel?.addEventListener('message', (event: MessageEvent<unknown>) => {
  const value = event.data as { sessionId?: unknown; tabId?: unknown } | null;
  if (!value || typeof value.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.sessionId)) return;
  if (value.tabId !== null && (typeof value.tabId !== 'string' || !/^tab_[a-f0-9]{12}$/.test(value.tabId))) return;
  useBrowserStore.getState().select(value.sessionId, value.tabId, false);
});

/** The tab a viewer should show: its own choice when still open, otherwise the server's active tab. */
export function resolveTab(state: BrowserSessionState | undefined, selectedId: string | undefined): BrowserTab | null {
  if (!state || state.status !== 'connected') return null;
  return state.tabs.find((t) => t.id === selectedId) ?? state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0] ?? null;
}
