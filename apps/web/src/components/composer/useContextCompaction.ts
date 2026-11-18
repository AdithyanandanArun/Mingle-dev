import { useMemo, useSyncExternalStore } from 'react';
import { api } from '../../lib/api';
import { useMingle } from '../../store/store';
import { ContextCompactionController } from './ContextCompactionController';

// Retain only active operations so returning to a session restores its cancel action.
const activeCompactions = new Map<string, ContextCompactionController>();

function createController(sessionId: string) {
  return new ContextCompactionController(sessionId, {
    compact: (id, operationId) => api.compactSession(id, undefined, operationId),
    cancel: (id, operationId) => api.interruptCompaction(id, operationId),
    refresh: () => useMingle.getState().refreshNow(),
  });
}

export function useContextCompaction(sessionId: string | null) {
  const controller = useMemo(() => (sessionId && activeCompactions.get(sessionId)) || createController(sessionId ?? ''), [sessionId]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  return { state, cancel: () => controller.cancel(), start: async () => {
    if (!sessionId || activeCompactions.has(sessionId)) return;
    activeCompactions.set(sessionId, controller);
    try {
      await controller.start();
    } finally {
      activeCompactions.delete(sessionId);
    }
  } };
}
