import { useCallback, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { Message } from '@mingle/contracts';
import { sessionHistory, syncWindow, withOlderMessages, type LoadOlderOptions, type SessionHistory, type SessionHistoryCache } from './sessionHistory';

const NONE: readonly Message[] = [];

export interface SessionHistoryView {
  history: SessionHistory;
  /** Stored messages for the transcript: `bootstrapMessages` itself until older history exists, then older ++ bootstrap. */
  messages: readonly Message[] | undefined;
  loadOlder(options?: LoadOlderOptions): void;
}

/**
 * Older history of one session over the bootstrap's messages. Fetches only when `loadOlder` is called (a person
 * pressed the control); nothing polls. The view is computed during render from the bootstrap, so a window that
 * slid is already reflected on the first paint, and the cache is updated right after in a layout effect.
 */
export function useSessionHistory(sessionId: string | undefined, bootstrapMessages: readonly Message[] | undefined, cache: SessionHistoryCache = sessionHistory): SessionHistoryView {
  const subscribe = cache.subscribe;
  const getSnapshot = useCallback(() => cache.get(sessionId), [cache, sessionId]);
  const held = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const sessionMessages = useMemo(
    () => sessionId && bootstrapMessages ? bootstrapMessages.filter((message) => message.sessionId === sessionId) : NONE,
    [bootstrapMessages, sessionId],
  );
  const history = useMemo(() => syncWindow(held, sessionMessages), [held, sessionMessages]);
  useLayoutEffect(() => { if (sessionId && history !== held) cache.commit(sessionId, history); }, [cache, sessionId, history, held]);
  useEffect(() => {
    if (!sessionId) return undefined;
    return () => cache.release(sessionId);
  }, [cache, sessionId]);

  const messages = useMemo(() => withOlderMessages(history.older, sessionMessages, bootstrapMessages), [history.older, sessionMessages, bootstrapMessages]);

  const loadOlder = useCallback((options?: LoadOlderOptions) => { if (sessionId) void cache.loadOlder(sessionId, options); }, [cache, sessionId]);
  return { history, messages, loadOlder };
}
