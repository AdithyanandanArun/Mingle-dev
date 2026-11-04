import type { Message } from '@mingle/contracts';
import { isOptimisticMessage } from '../store/bootstrapState';
import { api, errorMessage } from './api';

/**
 * Older history of one standalone session, paged on demand from `GET /api/sessions/:id/messages`.
 *
 * The bootstrap carries only the newest `BOOTSTRAP_MESSAGES_PER_SESSION` stored messages of a session. This module
 * keeps what the reader has loaded before that window, contiguous and chronological:
 *
 *   older (fetched or slid out of the bootstrap window) ++ window (the bootstrap's durable messages)
 *
 * The bootstrap always wins for messages it still carries, so fetched text can never replace fresher bootstrap or
 * stream text. When the bootstrap window slides forward, the messages that left it are appended to `older` so the
 * reader keeps what was on screen. Nothing here touches the store, so bootstrap refreshes stay untouched.
 */

/**
 * Newest stored messages per session in a bootstrap (`GET /api/bootstrap`, `bootstrapMessages(300)` in the server's
 * routes). A session with fewer is complete in the bootstrap; one with this many may have older history.
 * apps/server/src/message-history.test.ts fails if the server's window stops matching.
 */
export const BOOTSTRAP_MESSAGES_PER_SESSION = 300;
/** Messages requested per click. One extra is requested so "is there more" is answered without another request. */
export const HISTORY_PAGE_SIZE = 100;
/** Most older messages one open session holds, including messages leaving the live window. */
export const HISTORY_OPEN_LIMIT = 5000;
/** Older messages kept for a session that is no longer open (the ones nearest the live window). */
export const HISTORY_IDLE_KEEP = 400;
/** Sessions whose history stays cached after being left. */
export const HISTORY_CACHED_SESSIONS = 6;

export interface SessionHistory {
  /** Loaded before the bootstrap window, oldest first. Never contains a message the window carries. */
  older: readonly Message[];
  /** Durable bootstrap messages at the last sync: the reference for detecting how the window slid. */
  window: readonly Message[];
  /** False only once the first stored message of the session is displayed. */
  hasMore: boolean;
  phase: 'idle' | 'loading' | 'error';
  error: string | null;
  /** Changes whenever loaded history is discarded, so responses requested earlier can no longer apply. */
  epoch: number;
  notice: string | null;
}

export interface HistoryRequest { cursor: string; epoch: number }

export const EMPTY_HISTORY: SessionHistory = Object.freeze({
  older: [], window: [], hasMore: false, phase: 'idle', error: null, epoch: 0, notice: null,
}) as SessionHistory;

const durable = (message: Message): boolean => !isOptimisticMessage(message);

function boundOpenHistory(history: SessionHistory): SessionHistory {
  if (history.older.length <= HISTORY_OPEN_LIMIT) return history;
  return {
    ...history,
    older: history.older.slice(-HISTORY_OPEN_LIMIT),
    hasMore: true, phase: 'idle', error: null, epoch: history.epoch + 1,
    notice: 'Earlier messages left this view’s cache to keep it bounded. They remain saved in the conversation.',
  };
}

function sameMessages(a: readonly Message[], b: readonly Message[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

/** The message a "load older" request pages before: the oldest stored message currently displayed. */
export function oldestDisplayed(history: SessionHistory): Message | undefined {
  return history.older[0] ?? history.window[0];
}

export function canLoadOlder(history: SessionHistory): boolean {
  return history.hasMore && history.older.length < HISTORY_OPEN_LIMIT && oldestDisplayed(history) !== undefined;
}

/**
 * Follows the bootstrap window. Returns `history` itself when nothing changed. A window that slid forward moves the
 * messages that left it into `older`; a window that cannot be proven contiguous with what is held (many new
 * messages arrived unseen) discards the held history rather than showing a transcript with a hidden hole.
 */
export function syncWindow(history: SessionHistory, bootstrapMessages: readonly Message[]): SessionHistory {
  const next = bootstrapMessages.filter(durable);
  if (sameMessages(history.window, next)) return history;
  if (history.window.length === 0) {
    return { ...history, window: next, hasMore: history.older.length > 0 ? history.hasMore : next.length >= BOOTSTRAP_MESSAGES_PER_SESSION };
  }
  const firstKept = next.length > 0 ? history.window.findIndex((message) => message.id === next[0]!.id) : -1;
  if (firstKept < 0) {
    return {
      ...EMPTY_HISTORY, window: next, hasMore: next.length >= BOOTSTRAP_MESSAGES_PER_SESSION, epoch: history.epoch + 1,
      notice: history.older.length > 0 ? 'Earlier messages you had loaded were cleared because many new messages arrived. Load older messages to bring them back.' : null,
    };
  }
  if (firstKept === 0) return { ...history, window: next };
  const known = new Set(history.older.map((message) => message.id));
  const slid = history.window.slice(0, firstKept).filter((message) => !known.has(message.id));
  return boundOpenHistory({ ...history, older: slid.length ? [...history.older, ...slid] : history.older, window: next });
}

/**
 * Stored messages for the transcript: `bootstrapMessages` itself when no older history is held, otherwise the older
 * messages followed by the bootstrap's. A message the bootstrap carries is never taken from `older`.
 */
export function withOlderMessages(older: readonly Message[], sessionMessages: readonly Message[], bootstrapMessages: readonly Message[] | undefined): readonly Message[] | undefined {
  if (older.length === 0) return bootstrapMessages;
  const current = new Set(sessionMessages.map((message) => message.id));
  const kept = older.filter((message) => !current.has(message.id));
  return kept.length ? [...kept, ...(bootstrapMessages ?? [])] : bootstrapMessages;
}

export function loadStarted(history: SessionHistory): SessionHistory {
  return { ...history, phase: 'loading', error: null, notice: null };
}

const stale = (history: SessionHistory, request: HistoryRequest): boolean =>
  history.epoch !== request.epoch || oldestDisplayed(history)?.id !== request.cursor;

/**
 * Applies a fetched page (oldest first, already trimmed to the page size) in front of the loaded history.
 * Ignored when the history it was requested for no longer exists, so a late response cannot reorder or resurrect it.
 * Anything the window or `older` already carries is dropped, which keeps the newer copy.
 */
export function pageLoaded(history: SessionHistory, request: HistoryRequest, sessionId: string, page: readonly Message[], hasMore: boolean): SessionHistory {
  if (stale(history, request)) return history.phase === 'loading' ? { ...history, phase: 'idle' } : history;
  const known = new Set<string>();
  for (const message of history.window) known.add(message.id);
  for (const message of history.older) known.add(message.id);
  const added: Message[] = [];
  for (const message of page) {
    if (message.sessionId !== sessionId || !durable(message) || known.has(message.id)) continue;
    known.add(message.id);
    added.push(message);
  }
  if (added.length === 0 && hasMore) return { ...history, phase: 'error', error: 'The server returned no new older messages.' };
  return boundOpenHistory({ ...history, older: added.length ? [...added, ...history.older] : history.older, hasMore, phase: 'idle', error: null, notice: null });
}

export function loadFailed(history: SessionHistory, request: HistoryRequest, message: string): SessionHistory {
  if (stale(history, request)) return history.phase === 'loading' ? { ...history, phase: 'idle' } : history;
  return { ...history, phase: 'error', error: message };
}

/** History kept for a session the reader has left: bounded, with the part nearest the live window retained. */
export function settleIdle(history: SessionHistory): SessionHistory {
  const trimmed = history.older.length > HISTORY_IDLE_KEEP;
  if (!trimmed && history.phase === 'idle' && !history.notice) return history;
  return {
    ...history,
    older: trimmed ? history.older.slice(history.older.length - HISTORY_IDLE_KEEP) : history.older,
    hasMore: trimmed ? true : history.hasMore,
    phase: 'idle', error: null, notice: null,
    epoch: history.epoch + 1,
  };
}

export type HistoryFetcher = (sessionId: string, params: { limit: number; before: string }, signal: AbortSignal) => Promise<Message[]>;

export interface LoadOlderOptions {
  /** Called synchronously before a fetched page is published, while the DOM still shows the old transcript. */
  beforeApply?: () => void;
}

export interface SessionHistoryCache {
  get(sessionId: string | undefined): SessionHistory;
  subscribe(listener: () => void): () => void;
  commit(sessionId: string, history: SessionHistory): void;
  loadOlder(sessionId: string, options?: LoadOlderOptions): Promise<void>;
  /** The session is no longer open: cancel its request and shrink what is kept. */
  release(sessionId: string): void;
  has(sessionId: string): boolean;
  size(): number;
}

export function createSessionHistoryCache(fetchPage: HistoryFetcher = (sessionId, params, signal) => api.sessionMessages(sessionId, params, signal)): SessionHistoryCache {
  const entries = new Map<string, SessionHistory>();
  const inflight = new Map<string, AbortController>();
  const listeners = new Set<() => void>();
  const notify = (): void => { for (const listener of [...listeners]) listener(); };

  function commit(sessionId: string, history: SessionHistory): void {
    const previous = entries.get(sessionId);
    if (previous === history) return;
    entries.delete(sessionId);
    entries.set(sessionId, history);
    while (entries.size > HISTORY_CACHED_SESSIONS) {
      const oldest = entries.keys().next().value as string;
      if (oldest === sessionId) break;
      inflight.get(oldest)?.abort();
      inflight.delete(oldest);
      entries.delete(oldest);
    }
    notify();
  }

  const get = (sessionId: string | undefined): SessionHistory => (sessionId ? entries.get(sessionId) : undefined) ?? EMPTY_HISTORY;

  return {
    get,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    commit,
    has: (sessionId) => entries.has(sessionId),
    size: () => entries.size,
    release(sessionId) {
      inflight.get(sessionId)?.abort();
      inflight.delete(sessionId);
      const history = entries.get(sessionId);
      if (history) commit(sessionId, settleIdle(history));
    },
    async loadOlder(sessionId, options = {}) {
      const history = get(sessionId);
      const cursor = oldestDisplayed(history)?.id;
      if (inflight.has(sessionId) || history.phase === 'loading' || !canLoadOlder(history) || !cursor) return;
      const request: HistoryRequest = { cursor, epoch: history.epoch };
      const controller = new AbortController();
      inflight.set(sessionId, controller);
      commit(sessionId, loadStarted(history));
      const current = (): boolean => inflight.get(sessionId) === controller && !controller.signal.aborted;
      try {
        const page = await fetchPage(sessionId, { limit: HISTORY_PAGE_SIZE + 1, before: cursor }, controller.signal);
        if (!current()) return;
        const hasMore = page.length > HISTORY_PAGE_SIZE;
        const before = get(sessionId);
        const after = pageLoaded(before, request, sessionId, hasMore ? page.slice(page.length - HISTORY_PAGE_SIZE) : page, hasMore);
        if (after.older !== before.older) options.beforeApply?.();
        commit(sessionId, after);
      } catch (error) {
        if (!current()) return;
        commit(sessionId, loadFailed(get(sessionId), request, errorMessage(error)));
      } finally {
        if (inflight.get(sessionId) === controller) inflight.delete(sessionId);
      }
    },
  };
}

/** The cache the conversation uses. Tests create their own. */
export const sessionHistory = createSessionHistoryCache();
