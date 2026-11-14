import { useMemo, useSyncExternalStore } from 'react';
import { api } from '../../lib/api';
import { useMingle } from '../../store/store';
import { ContextCompactionController } from './ContextCompactionController';

export function useContextCompaction(sessionId: string | null) {
  const controller = useMemo(() => new ContextCompactionController(sessionId ?? '', {
    compact: (id, operationId) => api.compactSession(id, undefined, operationId),
    cancel: (id, operationId) => api.interruptCompaction(id, operationId),
    refresh: () => useMingle.getState().refreshNow(),
  }), [sessionId]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  return { state, start: () => controller.start(), cancel: () => controller.cancel() };
}
