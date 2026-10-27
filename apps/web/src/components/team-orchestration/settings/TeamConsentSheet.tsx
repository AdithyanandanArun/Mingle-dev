import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, RefreshCw, ShieldCheck } from 'lucide-react';
import { TEAM_CONSENT_DISCLAIMER, TEAM_CONSENT_DISCLAIMER_VERSION } from '@mingle/contracts';
import type { TeamPermissionLevel, TeamStructureSnapshot } from '@mingle/contracts';
import { useMingle } from '../../../store/store';
import { Button, Modal, ProviderMark, StatusDot } from '../../ui';
import { api } from '../../../lib/api';
import { TeamOrchestrationApiError, teamOrchestrationApi } from './api';
import { initialConsentPermissionLevel, initialConsentSessionIds } from './team-consent-flow';
import './team-orchestration-settings.css';

export function TeamConsentSheet({ projectId, initialSelectedSessionIds, onClose, onAccepted, presentation = 'modal' }: {
  projectId: string;
  initialSelectedSessionIds?: string[];
  onClose: () => void;
  onAccepted?: () => void;
  presentation?: 'modal' | 'inline';
}) {
  // Select the stable store array and filter outside the selector; a fresh array per read loops the renderer.
  const allSessions = useMingle((state) => state.boot?.sessions);
  const sessions = useMemo(() => (allSessions ?? []).filter((session) => session.projectId === projectId), [allSessions, projectId]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const initialSelectedSessionIdsRef = useRef(initialSelectedSessionIds);
  initialSelectedSessionIdsRef.current = initialSelectedSessionIds;
  const [projectSnapshot, setProjectSnapshot] = useState<TeamStructureSnapshot | null>(null);
  const snapshot = projectSnapshot?.projectId === projectId ? projectSnapshot : null;
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>(() => initialSelectedSessionIds
    ? initialConsentSessionIds(initialSelectedSessionIds, [], sessions.map((session) => session.id)) : []);
  const [permissionLevel, setPermissionLevel] = useState<TeamPermissionLevel>(() => initialConsentPermissionLevel(
    snapshot?.myConsent, TEAM_CONSENT_DISCLAIMER_VERSION,
  ));
  const [refreshing, setRefreshing] = useState(false);
  const [projectSnapshotLoading, setProjectSnapshotLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const initialized = useRef(initialSelectedSessionIds !== undefined);
  const permissionTouched = useRef(false);
  const initialStructureRequested = useRef(false);
  const previousProjectId = useRef(projectId);
  const projectRequestSequence = useRef(0);
  const projectRequestController = useRef<AbortController | null>(null);
  const lifecycleGeneration = useRef(0);
  const loadedAccount = useRef<{ status: string; id: string | null } | null>(null);
  const mounted = useRef(true);
  const snapshotLoading = projectSnapshotLoading;
  const validSelectedSessionIds = selectedSessionIds.filter((id) => sessions.some((session) => session.id === id));

  const refresh = useCallback(async (): Promise<TeamStructureSnapshot | null> => {
    const sequence = ++projectRequestSequence.current;
    projectRequestController.current?.abort();
    const controller = new AbortController();
    projectRequestController.current = controller;
    const isCurrent = () => mounted.current && sequence === projectRequestSequence.current && !controller.signal.aborted;
    const identity = (account: Awaited<ReturnType<typeof api.account>>) => ({
      status: account.status,
      id: account.status === 'signed-in' ? account.user?.id ?? null : null,
    });
    loadedAccount.current = null;
    setProjectSnapshot(null);
    setProjectSnapshotLoading(true);
    setRefreshing(true);
    setError('');
    try {
      const beforeAccount = identity(await api.account(controller.signal));
      if (!isCurrent()) return null;
      const next = await teamOrchestrationApi.structure(projectId, controller.signal);
      if (!isCurrent()) return null;
      const afterAccount = identity(await api.account(controller.signal));
      if (!isCurrent()) return null;
      if (beforeAccount.status !== afterAccount.status || beforeAccount.id !== afterAccount.id) {
        loadedAccount.current = null;
        setProjectSnapshot(null);
        setPermissionLevel('supervised');
        permissionTouched.current = false;
        throw new Error('The signed-in account changed while loading consent for this project. Refresh and review again.');
      }
      if (next.projectId !== projectId) throw new Error('The team settings response did not match the invited project. Refresh and try again.');
      loadedAccount.current = afterAccount;
      setProjectSnapshot(next);
      if (!permissionTouched.current) setPermissionLevel(initialConsentPermissionLevel(next.myConsent, TEAM_CONSENT_DISCLAIMER_VERSION));
      if (next && !initialized.current) {
        const sharedAgentIds = new Set(next.myConsent?.agentIds ?? []);
        const priorSessions = next.members.filter((member) => member.local && sharedAgentIds.has(member.agentId) && member.sessionId).map((member) => member.sessionId!);
        setSelectedSessionIds(initialConsentSessionIds(initialSelectedSessionIdsRef.current, priorSessions, sessionsRef.current.map((session) => session.id)));
        initialized.current = true;
      }
      return next;
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : 'Could not load team consent details.');
      return null;
    } finally {
      if (isCurrent()) {
        setRefreshing(false);
        setProjectSnapshotLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    if (snapshot || initialStructureRequested.current) return;
    initialStructureRequested.current = true;
    void refresh();
  }, [projectId, refresh, snapshot]);

  useEffect(() => {
    if (previousProjectId.current !== projectId) {
      previousProjectId.current = projectId;
      initialStructureRequested.current = false;
      initialized.current = initialSelectedSessionIdsRef.current !== undefined;
      permissionTouched.current = false;
      loadedAccount.current = null;
      setProjectSnapshot(null);
      setProjectSnapshotLoading(false);
      setSelectedSessionIds(initialConsentSessionIds(initialSelectedSessionIdsRef.current, [], sessionsRef.current.map((session) => session.id)));
      setPermissionLevel('supervised');
      setSaving(false);
      setError('');
    }
  }, [projectId]);

  useEffect(() => {
    const generation = ++lifecycleGeneration.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (lifecycleGeneration.current === generation) lifecycleGeneration.current++;
      initialStructureRequested.current = false;
      projectRequestSequence.current++;
      projectRequestController.current?.abort();
    };
  }, [projectId]);

  useEffect(() => {
    if (!snapshot || permissionTouched.current) return;
    setPermissionLevel(initialConsentPermissionLevel(snapshot.myConsent, TEAM_CONSENT_DISCLAIMER_VERSION));
  }, [snapshot]);

  const toggleSession = (sessionId: string, checked: boolean) => {
    setSelectedSessionIds((current) => checked
      ? (current.length < 8 ? [...new Set([...current, sessionId])] : current)
      : current.filter((id) => id !== sessionId));
  };

  const accept = async () => {
    if (!snapshot || snapshotLoading || refreshing || !validSelectedSessionIds.length || validSelectedSessionIds.length > 8 || saving) return;
    const acceptGeneration = lifecycleGeneration.current;
    const isCurrentAccept = () => mounted.current && lifecycleGeneration.current === acceptGeneration;
    setSaving(true);
    setError('');
    try {
      const account = await api.account();
      if (!isCurrentAccept()) return;
      const currentAccount = {
        status: account.status,
        id: account.status === 'signed-in' ? account.user?.id ?? null : null,
      };
      if (!loadedAccount.current || currentAccount.status !== loadedAccount.current.status || currentAccount.id !== loadedAccount.current.id) {
        loadedAccount.current = null;
        setProjectSnapshot(null);
        setPermissionLevel('supervised');
        permissionTouched.current = false;
        throw new Error('The signed-in account changed since these consent settings loaded. Refresh and review again before agreeing.');
      }
      const expectedAccount = loadedAccount.current;
      await teamOrchestrationApi.acceptConsent(projectId, {
        sessionIds: validSelectedSessionIds,
        permissionLevel,
        settingsVersion: snapshot.settings?.version ?? 1,
        disclaimerVersion: TEAM_CONSENT_DISCLAIMER_VERSION,
      });
      if (!isCurrentAccept()) return;
      const afterConsentAccount = await api.account();
      if (!isCurrentAccept()) return;
      const afterConsentIdentity = {
        status: afterConsentAccount.status,
        id: afterConsentAccount.status === 'signed-in' ? afterConsentAccount.user?.id ?? null : null,
      };
      if (afterConsentIdentity.status !== expectedAccount.status || afterConsentIdentity.id !== expectedAccount.id) {
        loadedAccount.current = null;
        setProjectSnapshot(null);
        setPermissionLevel('supervised');
        permissionTouched.current = false;
        throw new Error('Consent may have been saved, but the signed-in account changed. Refresh and review this project again before continuing.');
      }
      const latest = await refresh();
      if (!isCurrentAccept()) return;
      if (!latest) {
        setError('Consent was saved, but the latest team settings could not be loaded. Refresh before continuing.');
        return;
      }
      useMingle.getState().toast('success', `${validSelectedSessionIds.length} agent${validSelectedSessionIds.length === 1 ? '' : 's'} shared with the team.`);
      onAccepted?.();
    } catch (cause) {
      if (!isCurrentAccept()) return;
      if (cause instanceof TeamOrchestrationApiError && cause.status === 409) {
        await refresh();
        if (!isCurrentAccept()) return;
        setError('Team settings changed while you were reviewing consent. The latest permission level has been loaded; review the disclaimer and agree again.');
      } else setError(cause instanceof Error ? cause.message : 'Could not save team consent.');
    } finally { if (isCurrentAccept()) setSaving(false); }
  };

  const content = <div className={`team-consent${presentation === 'inline' ? ' team-consent--inline' : ''}`} aria-busy={refreshing || saving || snapshotLoading}>
    <header className="team-consent__heading"><span><ShieldCheck size={18} /></span><div><h3>Share your agents with the team</h3><p>Choose which local project agents teammates may send work to.</p></div></header>
    {error ? <p className="team-consent__error" role="alert"><AlertTriangle size={14} />{error}</p> : null}
    {!snapshot && (refreshing || snapshotLoading) ? <p className="team-consent__status" role="status">Loading consent settings for this project…</p> : null}
    <>
      <label className="team-consent__level"><strong>Maximum permission level you allow</strong>
        <select value={permissionLevel} disabled={saving || refreshing || snapshotLoading || !snapshot} onChange={(event) => { permissionTouched.current = true; setPermissionLevel(event.target.value as TeamPermissionLevel); }}>
          <option value="supervised">Supervised (default)</option>
          <option value="full-access">Full access</option>
        </select>
        <span>{snapshot?.settings ? `Current team setting: ${snapshot.settings.permissionLevel === 'supervised' ? 'Supervised' : 'Full access'} · settings version ${snapshot.settings.version}`
          : 'The project lead can add your agents to a session after you agree.'}</span>
      </label>
      <fieldset className="team-consent__agents" disabled={saving || refreshing || snapshotLoading || !snapshot}>
        <legend>Your local agents in this project</legend>
        {sessions.map((session) => {
          const checked = selectedSessionIds.includes(session.id);
          const lockedByLimit = !checked && selectedSessionIds.length >= 8;
          return <label className="team-consent__agent" key={session.id}>
            <input type="checkbox" checked={checked} disabled={lockedByLimit} onChange={(event) => toggleSession(session.id, event.target.checked)} />
            <ProviderMark provider={session.provider} size={17} />
            <span className="team-consent__copy"><strong>{session.name}</strong><small>{session.provider} · {session.model} · {session.status === 'running' ? 'running' : 'on this device'}</small></span>
            <StatusDot status={session.status} label={false} />
          </label>;
        })}
        {!sessions.length ? <p className="team-consent__empty">No local agents are registered in this project on this device.</p> : null}
      </fieldset>
      <p className="team-consent__limit">Select up to 8 agents. You can pause or revoke sharing at any time.</p>
      <section className="team-consent__disclaimer" aria-labelledby="team-consent-disclaimer-title">
        <h4 id="team-consent-disclaimer-title">Please review before agreeing</h4>
        <blockquote>{TEAM_CONSENT_DISCLAIMER}</blockquote>
      </section>
      <div className="team-consent__actions">
        <Button size="sm" variant="ghost" disabled={saving} onClick={onClose}>Skip for now</Button>
        <Button size="sm" variant="primary" disabled={saving || refreshing || snapshotLoading || !snapshot || validSelectedSessionIds.length === 0} busy={saving} onClick={() => void accept()}><Check size={14} />I agree — share selected agents</Button>
      </div>
    </>
    <div className="team-consent__refresh"><Button size="sm" variant="ghost" disabled={refreshing || saving} busy={refreshing} onClick={() => void refresh()}><RefreshCw size={12} />Refresh team settings</Button></div>
  </div>;

  return presentation === 'inline' ? content : <Modal title="Agent sharing consent" description="Your agents stay on this device; team access is sandboxed and revocable." onClose={onClose} width={560}>{content}</Modal>;
}
