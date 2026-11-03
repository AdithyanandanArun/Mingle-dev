import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { useMingle } from '../store/store';
import { EMPTY_STREAM_IDS, pickSessionStreamIds, reuseById } from './transcript';

/**
 * Ids of the live stream buffers that belong to one session. The snapshot keeps its identity until the id set
 * changes, so token deltas (which only change buffer text) never re-render the subscriber, and neither do
 * buffers of other sessions.
 */
export function useSessionStreamIds(sessionId: string | undefined): readonly string[] {
  const cache = useRef<{ streams: unknown; sessionId: string | undefined; ids: readonly string[] }>({ streams: undefined, sessionId: undefined, ids: EMPTY_STREAM_IDS });
  const getSnapshot = useCallback(() => {
    const streams = useMingle.getState().streams;
    const held = cache.current;
    if (held.streams === streams && held.sessionId === sessionId) return held.ids;
    const ids = pickSessionStreamIds(streams, sessionId, held.sessionId === sessionId ? held.ids : EMPTY_STREAM_IDS);
    cache.current = { streams, sessionId, ids };
    return ids;
  }, [sessionId]);
  return useSyncExternalStore(useMingle.subscribe, getSnapshot, getSnapshot);
}

/** Keeps the identity of every item (and of the list) that is structurally unchanged since the previous result. */
export function useStableById<T extends { id: string | number }>(items: readonly T[]): readonly T[] {
  const previous = useRef<readonly T[] | undefined>(undefined);
  return useMemo(() => {
    const next = reuseById(previous.current, items);
    previous.current = next;
    return next;
  }, [items]);
}
