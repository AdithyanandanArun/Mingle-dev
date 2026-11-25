import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserSessionState } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { useBrowserStore } from '../../store/browser';

const POLL_MS = 1500;

/** True while the tab is in the foreground; hidden tabs neither poll nor stream. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

export interface BrowserStateHandle {
  state: BrowserSessionState | undefined;
  /** Last failure to read the state; cleared by the next successful read. */
  error: string | null;
  /** Apply a state returned by a mutation and discard any older poll still in flight. */
  apply(next: BrowserSessionState): void;
  refresh(): void;
}

/** Polls a session's browser state while `active`; a stale response (older than a mutation or a session switch) is dropped. */
export function useBrowserState(sessionId: string | undefined, active: boolean): BrowserStateHandle {
  const state = useBrowserStore((s) => (sessionId ? s.states[sessionId] : undefined));
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const kick = useRef<() => void>(() => undefined);
  const poll = active && Boolean(sessionId);

  useEffect(() => {
    if (!poll || !sessionId) return;
    let stopped = false;
    let timer = 0;
    let controller: AbortController | null = null;
    const tick = async () => {
      window.clearTimeout(timer);
      controller?.abort();
      const mine = new AbortController();
      controller = mine;
      const started = epoch.current;
      try {
        const next = await api.browserState(sessionId, mine.signal);
        if (stopped || mine.signal.aborted || started !== epoch.current) return;
        useBrowserStore.getState().publish(sessionId, next);
        setError(null);
      } catch (cause) {
        if (stopped || mine.signal.aborted) return;
        setError(errorMessage(cause));
      } finally {
        if (!stopped && controller === mine) timer = window.setTimeout(() => void tick(), POLL_MS);
      }
    };
    kick.current = () => void tick();
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      controller?.abort();
      kick.current = () => undefined;
    };
  }, [poll, sessionId]);

  useEffect(() => setError(null), [sessionId]);

  const apply = useCallback((next: BrowserSessionState) => {
    epoch.current += 1;
    useBrowserStore.getState().publish(next.sessionId, next);
    setError(null);
  }, []);
  const refresh = useCallback(() => kick.current(), []);
  return { state, error, apply, refresh };
}
