import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  const bindingRef = useRef<{ projectId: string; teamId: string; sharedProjectId: string } | null>(null);

  const clearProjectTeam = (id: string) => {
    setSnapshot(null);
    if (bindingRef.current?.projectId === id) bindingRef.current = null;
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
    bindingRef.current = { projectId: id, teamId: binding.teamId, sharedProjectId: binding.sharedProjectId };
    setError(null);
    setErrorProjectId(null);
    const store = useMingle.getState();
    store.setTeamSessionInfo(id, latest.teamSession ?? null, latest.host.isThisDevice);
    if (accountId && !latest.host.isThisDevice) store.preferTeamSessionIfUnset(id);
    return true;
  };

  const refresh = useCallback(async () => {
    if (!projectId || connection !== 'online' || useMingle.getState().activeProjectId !== projectId) return null;
    const knownBinding = bindingRef.current?.projectId === projectId ? bindingRef.current : null;
    const structureResult = (signal?: AbortSignal) => teamSessionsApi.structure(projectId, signal)
      .then((value) => ({ value } as const), (cause: unknown) => ({ cause } as const));
    if (knownBinding) {
      const [account, result] = await Promise.all([api.account(), structureResult()]);
      if (useMingle.getState().activeProjectId !== projectId) return null;
      const accountId = account.status === 'signed-in' ? account.user?.id ?? null : null;
      if (!(await assertCurrentAccount(accountId, projectId))) return null;
      if ('value' in result) {
        if (result.value.teamId === knownBinding.teamId && result.value.sharedProjectId === knownBinding.sharedProjectId) {
          return acceptStructure(projectId, result.value, accountId, knownBinding) ? result.value : null;
        }
        const collaboration = await api.projectCollaboration(projectId);
        if (useMingle.getState().activeProjectId !== projectId) return null;
        if (!(await assertCurrentAccount(accountId, projectId))) return null;
        if (!collaboration.project) {
          clearProjectTeam(projectId);
          setError(null);
          setErrorProjectId(null);
          return null;
        }
        return acceptStructure(projectId, result.value, accountId, collaboration.project) ? result.value : null;
      }
      const collaboration = await api.projectCollaboration(projectId);
      if (useMingle.getState().activeProjectId !== projectId) return null;
      if (!(await assertCurrentAccount(accountId, projectId))) return null;
      if (!collaboration.project) {
        clearProjectTeam(projectId);
        setError(null);
        setErrorProjectId(null);
        return null;
      }
      throw result.cause;
    }
    const [account, collaboration, result] = await Promise.all([api.account(), api.projectCollaboration(projectId), structureResult()]);
    if (useMingle.getState().activeProjectId !== projectId) return null;
    const accountId = account.status === 'signed-in' ? account.user?.id ?? null : null;
    if (!(await assertCurrentAccount(accountId, projectId))) return null;
    if (!collaboration.project) {
      clearProjectTeam(projectId);
      setError(null);
      setErrorProjectId(null);
      return null;
    }
    if ('cause' in result) throw result.cause;
    return acceptStructure(projectId, result.value, accountId, collaboration.project) ? result.value : null;
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
    bindingRef.current = null;
    void (async () => {
      const structureResult = teamSessionsApi.structure(projectId, controller.signal)
        .then((value) => ({ value } as const), (cause: unknown) => ({ cause } as const));
      const [account, collaboration, result] = await Promise.all([
        api.account(controller.signal), api.projectCollaboration(projectId, controller.signal), structureResult,
      ]);
      if (controller.signal.aborted) return;
      const accountId = account.status === 'signed-in' ? account.user?.id ?? null : null;
      if (!(await assertCurrentAccount(accountId, projectId, controller.signal))) return null;
      if (!collaboration.project) {
        clearProjectTeam(projectId);
        setError(null); setErrorProjectId(null);
        return null;
      }
      if ('cause' in result) throw result.cause;
      if (!(await assertCurrentAccount(accountId, projectId, controller.signal))) return null;
      return acceptStructure(projectId, result.value, accountId, collaboration.project) ? result.value : null;
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
