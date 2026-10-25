import { useCallback, useState } from 'react';
import { AlertTriangle, Pause, Play, ShieldCheck, UserRoundMinus } from 'lucide-react';
import type { TeamStructureSnapshot } from '@mingle/contracts';
import { Button } from '../../ui';
import { TeamOrchestrationApiError, teamOrchestrationApi } from './api';
import { TeamConsentSheet } from './TeamConsentSheet';
import { useTeamStructure } from '../../../lib/team-structure-context';
import { sharedAgentCountLabel } from './team-consent-flow';
import './team-orchestration-settings.css';

export function TeamConsentBanner({ projectId }: { projectId: string }) {
  const teamStructure = useTeamStructure();
  const snapshot: TeamStructureSnapshot | null = teamStructure.snapshot?.projectId === projectId ? teamStructure.snapshot : null;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await teamStructure.refresh();
      if (!next) throw new Error('Team consent status is unavailable.');
      setError('');
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Team consent status is unavailable.');
      throw cause;
    }
  }, [teamStructure.refresh]);

  const changeConsent = async (state: 'granted' | 'paused' | 'revoked') => {
    if (busy) return;
    if (state === 'revoked' && !window.confirm('Leave this team project and revoke access to all of your shared agents? You can share them again later.')) return;
    setBusy(true);
    setError('');
    try {
      await teamOrchestrationApi.updateConsent(projectId, { state });
      await refresh();
    } catch (cause) {
      if (cause instanceof TeamOrchestrationApiError && cause.status === 409) {
        await refresh().catch(() => null);
        setError('Team settings changed elsewhere. Review the latest consent status before trying again.');
      } else setError(cause instanceof Error ? cause.message : 'Could not update team consent.');
    } finally { setBusy(false); }
  };

  if (teamStructure.loading && !snapshot) return null;
  if ((error || teamStructure.error) && !snapshot) return <div className="team-consent-banner team-consent-banner--error" role="status"><AlertTriangle size={14} /><span>Could not load team consent status.</span><Button size="sm" variant="ghost" onClick={() => { void refresh().catch(() => null); }}>Retry</Button></div>;
  if (!snapshot) return null;

  const consent = snapshot.myConsent;
  const needsConsent = !consent || consent.state === 'needs-reconsent';
  const openSheet = () => setSheetOpen(true);
  const permissionLevel = snapshot.settings?.permissionLevel ?? consent?.permissionLevel ?? 'supervised';
  const level = permissionLevel === 'supervised' ? 'Supervised' : 'Full access';

  return <>
    <section className={`team-consent-banner${needsConsent ? ' is-action-needed' : ''}`} aria-label="Team agent sharing status">
      <span className="team-consent-banner__icon">{needsConsent ? <AlertTriangle size={15} /> : <ShieldCheck size={15} />}</span>
      <div className="team-consent-banner__copy">
        <strong>{needsConsent ? consent?.state === 'needs-reconsent' ? 'Your agents need renewed consent' : 'Share your agents with the team' : consent?.state === 'revoked' ? 'Agent sharing is revoked' : sharedAgentCountLabel(consent.agentIds.length, consent.state === 'paused' ? 'paused' : 'shared', level)}</strong>
        {error ? <small role="alert">{error}</small> : consent?.state === 'needs-reconsent' ? <small>The group permission level or consent terms changed. Review and agree again before new work is delivered.</small> : needsConsent ? <small>Choose which local agents teammates may send work to. Sharing is optional and revocable.</small> : null}
      </div>
      {needsConsent || consent?.state === 'revoked' ? <Button size="sm" variant="primary" disabled={busy} onClick={openSheet}>{consent?.state === 'needs-reconsent' ? 'Review consent' : consent?.state === 'revoked' ? 'Share agents again' : 'Choose agents'}</Button>
        : consent.state === 'paused' ? <Button size="sm" disabled={busy} busy={busy} onClick={() => void changeConsent('granted')}><Play size={13} />Resume</Button>
          : <Button size="sm" disabled={busy} busy={busy} onClick={() => void changeConsent('paused')}><Pause size={13} />Pause my agents</Button>}
      {consent && consent.state !== 'revoked' ? <Button size="sm" variant="ghost" disabled={busy} aria-label="Leave and revoke shared agent access" onClick={() => void changeConsent('revoked')}><UserRoundMinus size={13} />Leave (revoke)</Button> : null}
    </section>
    {sheetOpen ? <TeamConsentSheet projectId={projectId} onClose={() => setSheetOpen(false)} onAccepted={() => { setSheetOpen(false); void refresh().catch(() => null); }} /> : null}
  </>;
}
