import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserDiscovery } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';

const INSTALL_POLL_MS = 2000;

export interface BrowserDiscoveryHandle {
  discovery: BrowserDiscovery | null;
  loading: boolean;
  error: string | null;
  /** Installing the managed Chromium, started here or elsewhere (the request itself can take about two minutes). */
  installing: boolean;
  refresh(): Promise<void>;
  install(): Promise<void>;
}

/** Reads what browsers Mingle can use. Nothing is downloaded or probed until the caller shows the control that needs it. */
export function useBrowserDiscovery(): BrowserDiscoveryHandle {
  const [discovery, setDiscovery] = useState<BrowserDiscovery | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);

  const refresh = useCallback(async () => {
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    setLoading(true);
    try {
      const next = await api.browserDiscovery(mine.signal);
      if (!mine.signal.aborted) { setDiscovery(next); setError(null); }
    } catch (cause) {
      if (!mine.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!mine.signal.aborted) setLoading(false);
    }
  }, []);

  const install = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const next = await api.installBrowser();
      if (alive.current) setDiscovery(next);
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    } finally {
      if (alive.current) setStarting(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const installing = starting || Boolean(discovery?.installing);
  useEffect(() => {
    if (!installing) return;
    const controller = new AbortController();
    let polling = false;
    const id = window.setInterval(() => {
      if (polling) return;
      polling = true;
      api.browserDiscovery(controller.signal)
        .then((next) => { if (!controller.signal.aborted) setDiscovery(next); })
        .catch(() => undefined)
        .finally(() => { polling = false; });
    }, INSTALL_POLL_MS);
    return () => { window.clearInterval(id); controller.abort(); };
  }, [installing]);

  return { discovery, loading, error, installing, refresh, install };
}
