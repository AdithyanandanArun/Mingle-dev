import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import type { TeamStructureSnapshot } from '@mingle/contracts';
import { api, errorMessage } from './api';
import { teamSessionsApi } from './team-sessions';
import { subscribeToTeamUpdates } from './team-live-updates';
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
  const teamSessionAutoSelectByProject = useMingle((state) => state.teamSessionAutoSelectByProject);
  const [snapshot, setSnapshot] = useState<TeamStructureSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorProjectId, setErrorProjectId] = useState<string | null>(null);

  const clearProjectTeam = (id: string) => {
    setSnapshot(null);
    useMingle.getState().setTeamSessionInfo(id, null, false);
  };
  const assertCurrentAccount = async (expectedAccountId: string | null, id: string, signal?: AbortSignal): Promise<boolean> => {
    const account = await api.account(signal);
    if (signal?.aborted || useMingle.getState().activeProjectId !== id) return false;
    const accountId = account.status === 'signed-in' ? account.user?.id ?? null : null;
    if (accountId === expectedAccountId) return true;
    clearProjectTeam(id);
    throw new Error('The signed-in account changed while team structure was loading. Refresh the team view.');
  };

  const acceptStructure = (id: string, latest: TeamStructureSnapshot, accountId: string | null, binding: { teamId: string; sharedProjectId: string }) => {
    if (latest.projectId !== id || latest.teamId !== binding.teamId || latest.sharedProjectId !== binding.sharedProjectId
      || useMingle.getState().activeProjectId !== id) return false;
    setSnapshot(latest);
    setError(null);
    setErrorProjectId(null);
    const store = useMingle.getState();
    store.setTeamSessionInfo(id, latest.teamSession ?? null, latest.host.isThisDevice);
    if (accountId && !latest.host.isThisDevice) store.preferTeamSessionIfUnset(id);
    return true;
  };

  const refresh = useCallback(async () => {
    if (!projectId || connection !== 'online' || useMingle.getState().activeProjectId !== projectId) return null;
    const account = await api.account();
    const accountId = account.status === 'signed-in' ? account.user?.id ?? null : null;
    const collaboration = await api.projectCollaboration(projectId);
    if (useMingle.getState().activeProjectId !== projectId) return null;
    if (!(await assertCurrentAccount(accountId, projectId))) return null;
    if (!collaboration.project) {
      clearProjectTeam(projectId);
      setError(null);
      setErrorProjectId(null);
      return null;
    }
    const latest = await teamSessionsApi.structure(projectId);
    if (!(await assertCurrentAccount(accountId, projectId))) return null;
    return acceptStructure(projectId, latest, accountId, collaboration.project) ? latest : null;
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
      const account = await api.account(controller.signal);
      if (controller.signal.aborted) return null;
      const accountId = account.status === 'signed-in' ? account.user?.id ?? null : null;
      const collaboration = await api.projectCollaboration(projectId, controller.signal);
      if (controller.signal.aborted) return;
      if (!(await assertCurrentAccount(accountId, projectId, controller.signal))) return null;
      if (!collaboration.project) {
        clearProjectTeam(projectId);
        setError(null); setErrorProjectId(null);
        return null;
      }
      const latest = await teamSessionsApi.structure(projectId, controller.signal);
      if (controller.signal.aborted) return;
      if (!(await assertCurrentAccount(accountId, projectId, controller.signal))) return null;
      return acceptStructure(projectId, latest, accountId, collaboration.project) ? latest : null;
    })().catch((cause) => {
      if (!controller.signal.aborted) { setError(errorMessage(cause)); setErrorProjectId(projectId); }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [connection, projectId]);

  useEffect(() => {
    if (!projectId) return;
    return subscribeToTeamUpdates(projectId, () => {
      void refresh().catch((cause) => { setError(errorMessage(cause)); setErrorProjectId(projectId); });
    }, { kinds: ['structure'] });
  }, [projectId, refresh]);

  // A team session is a remote selection rather than a local Bootstrap session.
  // Restore that navigation after a normal bootstrap refresh resolves selections.
  useLayoutEffect(() => {
    const currentSnapshot = snapshot?.projectId === projectId ? snapshot : null;
    if (!projectId || !currentSnapshot || currentSnapshot.host.isThisDevice || !currentSnapshot.teamSession || activeProjectId !== projectId) return;
    const ref = currentSnapshot.teamSession;
    const selected = selectedTeamSessionByProject[projectId] ?? (sessionByProject[projectId] === ref.sessionId ? ref.sessionId : null);
    const automatic = teamSessionAutoSelectByProject[projectId] === true;
    if (!automatic && selected !== ref.sessionId) return;
    if (sessionByProject[projectId] === ref.sessionId && selectedTeamSessionByProject[projectId] === ref.sessionId) return;
    useMingle.getState().restoreTeamSessionSelection(projectId, ref.sessionId);
  }, [activeProjectId, projectId, selectedTeamSessionByProject, teamSessionAutoSelectByProject, sessionByProject, snapshot]);

  const currentSnapshot = snapshot?.projectId === projectId ? snapshot : null;
  const currentError = errorProjectId === projectId ? error : null;
  const value = useMemo(() => ({ snapshot: currentSnapshot, loading, error: currentError, refresh }), [currentSnapshot, loading, currentError, refresh]);
  return <TeamStructureContext.Provider value={value}>{children}</TeamStructureContext.Provider>;
}

export function useTeamStructure(): TeamStructureContextValue {
  return useContext(TeamStructureContext);
}
