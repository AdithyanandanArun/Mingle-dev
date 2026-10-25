import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, RefreshCw, ShieldCheck } from 'lucide-react';
import { TEAM_CONSENT_DISCLAIMER, TEAM_CONSENT_DISCLAIMER_VERSION } from '@mingle/contracts';
import type { TeamPermissionLevel } from '@mingle/contracts';
import { useMingle } from '../../../store/store';
import { Button, Modal, ProviderMark, StatusDot } from '../../ui';
import { TeamOrchestrationApiError, teamOrchestrationApi } from './api';
import { initialConsentSessionIds } from './team-consent-flow';
import { useTeamStructure } from '../../../lib/team-structure-context';
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
  const teamStructure = useTeamStructure();
  const snapshot = teamStructure.snapshot?.projectId === projectId ? teamStructure.snapshot : null;
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>(() => initialSelectedSessionIds
    ? initialConsentSessionIds(initialSelectedSessionIds, [], sessions.map((session) => session.id)) : []);
  const [permissionLevel, setPermissionLevel] = useState<TeamPermissionLevel>('supervised');
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const initialized = useRef(initialSelectedSessionIds !== undefined);
  const validSelectedSessionIds = selectedSessionIds.filter((id) => sessions.some((session) => session.id === id));

  const refresh = async () => {
    setRefreshing(true);
    setError('');
    try {
      const next = await teamStructure.refresh();
      if (next && !initialized.current) {
        const sharedAgentIds = new Set(next.myConsent?.agentIds ?? []);
        const priorSessions = next.members.filter((member) => member.local && sharedAgentIds.has(member.agentId) && member.sessionId).map((member) => member.sessionId!);
        setSelectedSessionIds(initialConsentSessionIds(initialSelectedSessionIds, priorSessions, sessions.map((session) => session.id)));
        initialized.current = true;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load team consent details.');
    } finally { setRefreshing(false); }
  };

  useEffect(() => {
    if (initialized.current || !snapshot) return;
    const sharedAgentIds = new Set(snapshot.myConsent?.agentIds ?? []);
    const priorSessions = snapshot.members.filter((member) => member.local && sharedAgentIds.has(member.agentId) && member.sessionId).map((member) => member.sessionId!);
    setSelectedSessionIds(initialConsentSessionIds(initialSelectedSessionIds, priorSessions, sessions.map((session) => session.id)));
    initialized.current = true;
  }, [initialSelectedSessionIds, sessions, snapshot]);

  const toggleSession = (sessionId: string, checked: boolean) => {
    setSelectedSessionIds((current) => checked
      ? (current.length < 8 ? [...new Set([...current, sessionId])] : current)
      : current.filter((id) => id !== sessionId));
  };

  const accept = async () => {
    if (!validSelectedSessionIds.length || validSelectedSessionIds.length > 8 || saving) return;
    setSaving(true);
    setError('');
    try {
      await teamOrchestrationApi.acceptConsent(projectId, {
        sessionIds: validSelectedSessionIds,
        permissionLevel,
        settingsVersion: snapshot?.settings?.version ?? 1,
        disclaimerVersion: TEAM_CONSENT_DISCLAIMER_VERSION,
      });
      useMingle.getState().toast('success', `${validSelectedSessionIds.length} agent${validSelectedSessionIds.length === 1 ? '' : 's'} shared with the team.`);
      onAccepted?.();
      void teamStructure.refresh().catch(() => null);
    } catch (cause) {
      if (cause instanceof TeamOrchestrationApiError && cause.status === 409) {
        await refresh();
        setError('Team settings changed while you were reviewing consent. The latest permission level has been loaded; review the disclaimer and agree again.');
      } else setError(cause instanceof Error ? cause.message : 'Could not save team consent.');
    } finally { setSaving(false); }
  };

  const content = <div className={`team-consent${presentation === 'inline' ? ' team-consent--inline' : ''}`} aria-busy={refreshing || saving}>
    <header className="team-consent__heading"><span><ShieldCheck size={18} /></span><div><h3>Share your agents with the team</h3><p>Choose which local project agents teammates may send work to.</p></div></header>
    {error ? <p className="team-consent__error" role="alert"><AlertTriangle size={14} />{error}</p> : null}
    <>
      <label className="team-consent__level"><strong>Maximum permission level you allow</strong>
        <select value={permissionLevel} disabled={saving} onChange={(event) => setPermissionLevel(event.target.value as TeamPermissionLevel)}>
          <option value="supervised">Supervised (default)</option>
          <option value="full-access">Full access</option>
        </select>
        <span>{snapshot?.settings ? `Current team setting: ${snapshot.settings.permissionLevel === 'supervised' ? 'Supervised' : 'Full access'} · settings version ${snapshot.settings.version}`
          : 'The project lead can add your agents to a session after you agree.'}</span>
      </label>
      <fieldset className="team-consent__agents" disabled={saving}>
        <legend>Your local agents in this project</legend>
        {sessions.map((session) => {
          const checked = selectedSessionIds.includes(session.id);
          const lockedByLimit = !checked && selectedSessionIds.length >= 8;
          return <label className="team-consent__agent" key={session.id}>
            <input type="checkbox" checked={checked} disabled={lockedByLimit} onChange={(event) => toggleSession(session.id, event.target.checked)} />
            <ProviderMark provider={session.provider} size={17} />
            <span><strong>{session.name}</strong><small>{session.provider} · {session.model} · {session.status === 'running' ? 'running' : 'on this device'}</small></span>
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
        <Button size="sm" variant="primary" disabled={saving || validSelectedSessionIds.length === 0} busy={saving} onClick={() => void accept()}><Check size={14} />I agree — share selected agents</Button>
      </div>
    </>
    <div className="team-consent__refresh"><Button size="sm" variant="ghost" disabled={refreshing || saving} busy={refreshing} onClick={() => void refresh()}><RefreshCw size={12} />Refresh team settings</Button></div>
  </div>;

  return presentation === 'inline' ? content : <Modal title="Agent sharing consent" description="Your agents stay on this device; team access is sandboxed and revocable." onClose={onClose} width={560}>{content}</Modal>;
}
