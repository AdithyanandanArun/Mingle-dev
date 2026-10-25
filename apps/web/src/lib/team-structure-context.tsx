import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import type { TeamStructureSnapshot } from '@mingle/contracts';
import { api, errorMessage } from './api';
import { teamSessionsApi } from './team-sessions';
import { useMingle } from '../store/store';

interface TeamStructureContextValue {
  snapshot: TeamStructureSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<TeamStructureSnapshot | null>;
}

const TeamStructureContext = createContext<TeamStructureContextValue>({
  snapshot: null, loading: false, error: null, refresh: async () => null,
});

export function TeamStructureProvider({ projectId, children }: { projectId: string | null; children: ReactNode }) {
  const connection = useMingle((state) => state.connection);
  const activeProjectId = useMingle((state) => state.activeProjectId);
  const sessionByProject = useMingle((state) => state.sessionByProject);
  const selectedTeamSessionByProject = useMingle((state) => state.selectedTeamSessionByProject);
  const [snapshot, setSnapshot] = useState<TeamStructureSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorProjectId, setErrorProjectId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId || connection !== 'online') return null;
    const collaboration = await api.projectCollaboration(projectId);
    if (!collaboration.project) {
      setSnapshot(null);
      setError(null);
      setErrorProjectId(null);
      useMingle.getState().setTeamSessionInfo(projectId, null, false);
      return null;
    }
    const latest = await teamSessionsApi.structure(projectId);
    setSnapshot(latest);
    setError(null);
    setErrorProjectId(null);
    useMingle.getState().setTeamSessionInfo(projectId, latest.teamSession ?? null, latest.host.isThisDevice);
    return latest;
  }, [connection, projectId]);

  useEffect(() => {
    if (!projectId) {
      setSnapshot(null); setError(null); setErrorProjectId(null); setLoading(false);
      return;
    }
    if (connection !== 'online') {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setSnapshot(null); setError(null); setErrorProjectId(null); setLoading(true);
    void (async () => {
      const collaboration = await api.projectCollaboration(projectId, controller.signal);
      if (controller.signal.aborted) return;
      if (!collaboration.project) {
        setSnapshot(null);
        setError(null); setErrorProjectId(null);
        useMingle.getState().setTeamSessionInfo(projectId, null, false);
        return null;
      }
      const latest = await teamSessionsApi.structure(projectId, controller.signal);
      if (controller.signal.aborted) return;
      setSnapshot(latest);
      setError(null); setErrorProjectId(null);
      useMingle.getState().setTeamSessionInfo(projectId, latest.teamSession ?? null, latest.host.isThisDevice);
      return latest;
    })().catch((cause) => {
      if (!controller.signal.aborted) { setError(errorMessage(cause)); setErrorProjectId(projectId); }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [connection, projectId]);

  // A team session is a remote selection rather than a local Bootstrap session.
  // Restore that navigation after a normal bootstrap refresh resolves selections.
  useLayoutEffect(() => {
    const currentSnapshot = snapshot?.projectId === projectId ? snapshot : null;
    if (!projectId || !currentSnapshot || currentSnapshot.host.isThisDevice || !currentSnapshot.teamSession || activeProjectId !== projectId) return;
    const ref = currentSnapshot.teamSession;
    const selected = selectedTeamSessionByProject[projectId] ?? (sessionByProject[projectId] === ref.sessionId ? ref.sessionId : null);
    if (selected !== ref.sessionId || sessionByProject[projectId] === ref.sessionId) return;
    useMingle.getState().restoreTeamSessionSelection(projectId, ref.sessionId);
  }, [activeProjectId, projectId, selectedTeamSessionByProject, sessionByProject, snapshot]);

  const currentSnapshot = snapshot?.projectId === projectId ? snapshot : null;
  const currentError = errorProjectId === projectId ? error : null;
  const value = useMemo(() => ({ snapshot: currentSnapshot, loading, error: currentError, refresh }), [currentSnapshot, loading, currentError, refresh]);
  return <TeamStructureContext.Provider value={value}>{children}</TeamStructureContext.Provider>;
}

export function useTeamStructure(): TeamStructureContextValue {
  return useContext(TeamStructureContext);
}
