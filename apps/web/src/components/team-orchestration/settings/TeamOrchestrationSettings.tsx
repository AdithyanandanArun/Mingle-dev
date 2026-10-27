import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, Crown, RefreshCw, Users } from 'lucide-react';
import type { Session, TeamPermissionLevel, TeamStructureSnapshot, UpdateTeamOrchestration } from '@mingle/contracts';
import { useMingle } from '../../../store/store';
import { Button, Segmented } from '../../ui';
import { TeamOrchestrationApiError, teamOrchestrationApi } from './api';
import { teamSessionShareEligibility } from './share-eligibility';
import './team-orchestration-settings.css';

export function TeamOrchestrationSettings({ projectId, currentSession, onShared, onOpenProject }: {
  projectId: string;
  /** Captured when the Teammates dialog opens; never follows later workspace navigation. */
  currentSession: Session | null;
  onShared?: () => void;
  onOpenProject?: () => void;
}) {
  const activeProjectId = useMingle((state) => state.activeProjectId);
  const boot = useMingle((state) => state.boot);
  const [snapshot, setSnapshot] = useState<TeamStructureSnapshot | null>(null);
  const [permissionLevel, setPermissionLevel] = useState<TeamPermissionLevel>('supervised');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState<'shared' | 'permission' | null>(null);
  const operation = useRef(0);
  const currentProjectId = useRef(projectId);
  currentProjectId.current = projectId;

  const hasCanonicalSession = Boolean(snapshot?.teamSession);
  const sharedSession = useMemo(() => {
    if (snapshot?.teamSession) {
      const ref = snapshot.teamSession;
      const session = boot?.sessions.find((item) => item.id === ref.sessionId && item.projectId === projectId);
      return {
        id: ref.sessionId,
        name: session?.name ?? ref.title,
        detail: session ? `${session.provider} · ${session.model}` : 'Shared project session',
      };
    }
    if (currentSession?.projectId === projectId) return {
      id: currentSession.id,
      name: currentSession.name,
      detail: `${currentSession.provider} · ${currentSession.model}`,
    };
    return null;
  }, [boot?.sessions, currentSession, projectId, snapshot?.teamSession]);

  const canApply = (sequence: number, signal?: AbortSignal) => sequence === operation.current
    && currentProjectId.current === projectId
    && useMingle.getState().activeProjectId === projectId
    && !signal?.aborted;
  const canFinish = (sequence: number) => sequence === operation.current && currentProjectId.current === projectId;

  const load = async (signal?: AbortSignal) => {
    const sequence = ++operation.current;
    setLoading(true);
    setError('');
    try {
      const next = await teamOrchestrationApi.structure(projectId, signal);
      if (!canApply(sequence, signal)) return;
      setSnapshot(next);
      setPermissionLevel(next.settings?.permissionLevel ?? 'supervised');
    } catch (cause) {
      if (canApply(sequence, signal)) setError(cause instanceof Error ? cause.message : 'Could not load team settings.');
    } finally {
      if (canFinish(sequence)) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    setPermissionLevel('supervised');
    void load(controller.signal);
    return () => { operation.current++; controller.abort(); };
    // projectId identifies this dialog's backing project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const canEdit = Boolean(snapshot?.canEdit && snapshot.host.online && snapshot.host.isThisDevice);
  const projectIsActive = activeProjectId === projectId;
  const hasSessionForProject = Boolean(sharedSession);
  const shareEligibility = useMemo(() => teamSessionShareEligibility(currentSession, projectId, boot?.sessions ?? [], boot?.groups), [boot, currentSession, projectId]);
  const choosingFullAccess = permissionLevel === 'full-access';

  const refreshAfterShare = async (latest: TeamStructureSnapshot, targetSessionId: string, navigate: boolean, sequence: number) => {
    if (!canApply(sequence)) return;
    setSnapshot(latest);
    setPermissionLevel(latest.settings?.permissionLevel ?? permissionLevel);
    const store = useMingle.getState();
    store.setTeamSessionInfo(projectId, latest.teamSession ?? null, latest.host.isThisDevice);
    await store.refreshNow();
    if (!canApply(sequence)) return;
    if (navigate && targetSessionId) store.selectSession(targetSessionId);
  };

  const save = async () => {
    if (!snapshot || !canEdit || !sharedSession || !projectIsActive || saving) return;
    const sequence = ++operation.current;
    const bindingSessionId = sharedSession.id;
    const bindSession = !hasCanonicalSession;
    if (bindSession && !shareEligibility.allowed) return;
    setSaving(true);
    setError('');
    setConflict(false);
    setSaved(null);
    try {
      let latest: TeamStructureSnapshot;
      if (bindSession) {
        latest = await teamOrchestrationApi.shareSession(projectId, {
          sessionId: bindingSessionId,
          permissionLevel,
          ...(snapshot.settings ? { expectedVersion: snapshot.settings.version } : {}),
        });
      } else {
        if (!snapshot.settings) throw new Error('Team settings are unavailable. Refresh before changing the permission level.');
        const update: UpdateTeamOrchestration = {
          permissionLevel,
          expectedVersion: snapshot.settings.version,
        };
        await teamOrchestrationApi.updateSettings(projectId, update);
        latest = await teamOrchestrationApi.structure(projectId);
      }
      if (!canApply(sequence)) return;
      if (bindSession) await refreshAfterShare(latest, latest.teamSession?.sessionId ?? bindingSessionId, true, sequence);
      else {
        setSnapshot(latest);
        setPermissionLevel(latest.settings?.permissionLevel ?? permissionLevel);
      }
      if (!canApply(sequence)) return;
      setSaved(bindSession ? 'shared' : 'permission');
      if (bindSession) onShared?.();
    } catch (cause) {
      if (!canApply(sequence)) return;
      if (cause instanceof TeamOrchestrationApiError && cause.status === 409) {
        setConflict(true);
        setError(`${cause.message} Refresh team settings and try again after resolving the issue.`);
        try {
          const latest = await teamOrchestrationApi.structure(projectId);
          if (canApply(sequence)) {
            setSnapshot(latest);
            setPermissionLevel(latest.settings?.permissionLevel ?? 'supervised');
          }
        } catch (refreshCause) {
          if (canApply(sequence)) setError(refreshCause instanceof Error ? refreshCause.message : 'Could not refresh the latest team settings.');
        }
      } else setError(cause instanceof Error ? cause.message : 'Could not save team settings.');
    } finally {
      if (canFinish(sequence)) setSaving(false);
    }
  };

  const openProject = () => {
    if (onOpenProject) onOpenProject();
    else {
      const store = useMingle.getState();
      store.selectProject(projectId);
    }
  };

  return <section className="team-orch-settings" aria-labelledby="team-orch-settings-title" aria-busy={loading || saving}>
    <header className="team-orch-settings__heading">
      <span className="team-orch-settings__icon"><Crown size={16} /></span>
      <div><h3 id="team-orch-settings-title">Share a session with the team</h3><p>Share this conversation and set its maximum permission.</p></div>
      <Button size="sm" variant="ghost" disabled={loading || saving} onClick={() => void load()} aria-label="Refresh team orchestration settings"><RefreshCw size={13} /></Button>
    </header>
    {loading && !snapshot ? <p className="team-orch-settings__status" role="status">Loading team settings…</p> : null}
    {error ? <p className="team-orch-settings__error" role="alert"><CircleAlert size={14} />{error}</p> : null}
    {conflict ? <p className="team-orch-settings__notice" role="status">The latest team settings are loaded. Resolve the reported issue, then try again.</p> : null}
    {saved ? <p className="team-orch-settings__success" role="status">{saved === 'shared' ? 'Current session shared with the team.' : 'Team permission level saved.'}</p> : null}
    {snapshot ? <>
      {!snapshot.host.online ? <p className="team-orch-settings__notice" role="status">The lead’s device is offline. Team sharing can’t be changed until it reconnects.</p>
        : !snapshot.host.isThisDevice ? <p className="team-orch-settings__notice" role="status">This device is not the project host. Only the lead’s device can share a session or change its permission level.</p>
          : !snapshot.canEdit ? <p className="team-orch-settings__notice" role="status">Only the team lead or an admin on the lead’s device can share a session or change its permission level.</p> : null}
      {!projectIsActive ? <p className="team-orch-settings__notice" role="status">The active project changed. Close Teammates and reopen it before sharing or changing permissions.</p> : null}
      {!hasCanonicalSession && sharedSession && !shareEligibility.allowed ? <p className="team-orch-settings__notice" role="status">{shareEligibility.message}</p> : null}
      <div className="team-orch-settings__layout">
        {sharedSession ? <div className="team-orch-settings__session" aria-label="Current shared session">
          <Users size={14} /><span><strong>{sharedSession.name}</strong><small>{sharedSession.detail}{hasCanonicalSession ? ' · already shared' : ' · selected session on this device'}</small></span>
        </div> : <div className="team-orch-settings__no-session" role="status">
          <p>No local session is open for this project. Open the project and create or select a session, then reopen Teammates to share it.</p>
          <Button size="sm" variant="ghost" disabled={saving} onClick={openProject}>Open this project</Button>
        </div>}
        {canEdit && hasSessionForProject ? <fieldset className="team-orch-settings__controls" aria-label="Team permission level" disabled={saving}>
          <div className="team-orch-settings__field">
            <strong>Maximum permission for teammate runs</strong>
            <Segmented value={permissionLevel} onChange={(value) => { setPermissionLevel(value); setSaved(null); }} label="Team permission level" options={[
              { value: 'supervised', label: 'Supervised' }, { value: 'full-access', label: 'Full access' },
            ]} />
            <p>{choosingFullAccess
              ? 'Full access allows file and command actions after owner consent. Raising to Full access requires every teammate to consent again before new work is delivered.'
              : 'Supervised asks owners to approve file or command actions. Sharing can be paused or revoked at any time.'}</p>
          </div>
        </fieldset> : snapshot.settings ? <p className="team-orch-settings__summary"><Users size={14} /> Team permission: {snapshot.settings.permissionLevel === 'supervised' ? 'Supervised' : 'Full access'}</p> : null}
      </div>
      {canEdit ? <div className="team-orch-settings__actions"><Button variant="primary" size="sm" disabled={saving || loading || !projectIsActive || !hasSessionForProject || (!hasCanonicalSession && (!shareEligibility.allowed || currentSession?.projectId !== projectId))} busy={saving} onClick={() => void save()}>{hasCanonicalSession ? 'Save permission level' : 'Share current session'}</Button></div> : null}
    </> : null}
  </section>;
}
