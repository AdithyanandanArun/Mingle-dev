import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, RefreshCw, ShieldCheck } from 'lucide-react';
import { TEAM_CONSENT_DISCLAIMER, TEAM_CONSENT_DISCLAIMER_VERSION } from '@mingle/contracts';
import type { TeamStructureSnapshot } from '@mingle/contracts';
import { useMingle } from '../../../store/store';
import { Button, Modal, ProviderMark, StatusDot } from '../../ui';
import { TeamOrchestrationApiError, teamOrchestrationApi } from './api';
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
  const [snapshot, setSnapshot] = useState<TeamStructureSnapshot | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const initialized = useRef(false);
  const permissionLevel = snapshot?.settings?.permissionLevel ?? 'supervised';
  const validSelectedSessionIds = selectedSessionIds.filter((id) => sessions.some((session) => session.id === id));

  const refresh = async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const next = await teamOrchestrationApi.structure(projectId, signal);
      if (signal?.aborted) return;
      setSnapshot(next);
      if (!initialized.current) {
        const sharedAgentIds = new Set(next.myConsent?.agentIds ?? []);
        const priorSessions = next.members.filter((member) => member.local && sharedAgentIds.has(member.agentId) && member.sessionId).map((member) => member.sessionId!);
        setSelectedSessionIds(initialSelectedSessionIds ? [...initialSelectedSessionIds] : priorSessions);
        initialized.current = true;
      }
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : 'Could not load team consent details.');
    } finally { if (!signal?.aborted) setLoading(false); }
  };

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
    // One initial selection is applied when the consent sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const toggleSession = (sessionId: string, checked: boolean) => {
    setSelectedSessionIds((current) => checked
      ? (current.length < 8 ? [...new Set([...current, sessionId])] : current)
      : current.filter((id) => id !== sessionId));
  };

  const accept = async () => {
    if (!snapshot?.settings || !validSelectedSessionIds.length || validSelectedSessionIds.length > 8 || saving) return;
    setSaving(true);
    setError('');
    try {
      await teamOrchestrationApi.acceptConsent(projectId, {
        sessionIds: validSelectedSessionIds,
        permissionLevel,
        settingsVersion: snapshot.settings.version,
        disclaimerVersion: TEAM_CONSENT_DISCLAIMER_VERSION,
      });
      await refresh();
      useMingle.getState().toast('success', `${validSelectedSessionIds.length} agent${validSelectedSessionIds.length === 1 ? '' : 's'} shared with the team.`);
      onAccepted?.();
    } catch (cause) {
      if (cause instanceof TeamOrchestrationApiError && cause.status === 409) {
        await refresh();
        setError('Team settings changed while you were reviewing consent. The latest permission level has been loaded; review the disclaimer and agree again.');
      } else setError(cause instanceof Error ? cause.message : 'Could not save team consent.');
    } finally { setSaving(false); }
  };

  const content = <div className={`team-consent${presentation === 'inline' ? ' team-consent--inline' : ''}`} aria-busy={loading || saving}>
    <header className="team-consent__heading"><span><ShieldCheck size={18} /></span><div><h3>Share your agents with the team</h3><p>Choose which local project agents teammates may send work to.</p></div></header>
    {loading && !snapshot ? <p className="team-consent__status" role="status">Loading the current team settings…</p> : null}
    {error ? <p className="team-consent__error" role="alert"><AlertTriangle size={14} />{error}</p> : null}
    {snapshot?.settings ? <>
      <p className="team-consent__level"><strong>Group permission level:</strong> {permissionLevel === 'supervised' ? 'Supervised' : 'Full access'} <span>· settings version {snapshot.settings.version}</span></p>
      <fieldset className="team-consent__agents" disabled={loading || saving}>
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
        <Button size="sm" variant="primary" disabled={loading || saving || validSelectedSessionIds.length === 0 || !snapshot.settings} busy={saving} onClick={() => void accept()}><Check size={14} />I agree — add my agents</Button>
      </div>
    </> : !loading && snapshot ? <p className="team-consent__error" role="status">This project does not currently have team orchestration enabled.</p> : null}
    <div className="team-consent__refresh"><Button size="sm" variant="ghost" disabled={loading || saving} onClick={() => void refresh()}><RefreshCw size={12} />Refresh team settings</Button></div>
  </div>;

  return presentation === 'inline' ? content : <Modal title="Agent sharing consent" description="Your agents stay on this device; team access is sandboxed and revocable." onClose={onClose} width={560}>{content}</Modal>;
}
