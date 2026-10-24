import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, CircleAlert, Crown, RefreshCw, Users } from 'lucide-react';
import type { TeamPermissionLevel, TeamStructureSnapshot, UpdateTeamOrchestration } from '@mingle/contracts';
import { Button, Segmented, Switch } from '../../ui';
import { TeamOrchestrationApiError, teamOrchestrationApi } from './api';
import './team-orchestration-settings.css';

interface DraftSettings {
  leaderOrchestration: boolean;
  permissionLevel: TeamPermissionLevel;
  orchestratorAgentId: string;
  fallbackAgentIds: string[];
}

const EMPTY_DRAFT: DraftSettings = {
  leaderOrchestration: true,
  permissionLevel: 'supervised',
  orchestratorAgentId: '',
  fallbackAgentIds: [],
};

export function TeamOrchestrationSettings({ projectId }: { projectId: string }) {
  const [snapshot, setSnapshot] = useState<TeamStructureSnapshot | null>(null);
  const [draft, setDraft] = useState<DraftSettings>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const next = await teamOrchestrationApi.structure(projectId, signal);
      if (signal?.aborted) return;
      setSnapshot(next);
      setDraft(next.settings ? {
        leaderOrchestration: next.settings.leaderOrchestration,
        permissionLevel: next.settings.permissionLevel,
        orchestratorAgentId: next.settings.orchestratorAgentId ?? '',
        fallbackAgentIds: [...next.settings.fallbackAgentIds],
      } : { ...EMPTY_DRAFT, orchestratorAgentId: next.members[0]?.agentId ?? '' });
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : 'Could not load team settings.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    void load(controller.signal);
    return () => controller.abort();
    // projectId identifies this dialog's backing project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const members = snapshot?.members ?? [];
  const roster = useMemo(() => new Map(members.map((member) => [member.agentId, member])), [members]);
  const orchestrator = draft.orchestratorAgentId ? roster.get(draft.orchestratorAgentId) : undefined;
  const canEdit = Boolean(snapshot?.canEdit && snapshot.host.online);
  const enabled = Boolean(snapshot?.enabled && snapshot.settings);
  const choosingFullAccess = draft.permissionLevel === 'full-access';

  const save = async () => {
    if (!snapshot || !canEdit || saving) return;
    setSaving(true);
    setError('');
    setConflict(false);
    setSaved(false);
    try {
      if (!snapshot.enabled || !snapshot.settings) {
        if (!draft.orchestratorAgentId) throw new Error('Choose an orchestrator agent before enabling this project.');
        await teamOrchestrationApi.enable(projectId, {
          leaderOrchestration: draft.leaderOrchestration,
          permissionLevel: draft.permissionLevel,
          orchestratorAgentId: draft.orchestratorAgentId,
          fallbackAgentIds: draft.fallbackAgentIds.filter((id) => id !== draft.orchestratorAgentId),
        });
      } else {
        const update: UpdateTeamOrchestration = {
          leaderOrchestration: draft.leaderOrchestration,
          permissionLevel: draft.permissionLevel,
          fallbackAgentIds: draft.fallbackAgentIds.filter((id) => id !== snapshot.settings?.orchestratorAgentId),
          expectedVersion: snapshot.settings.version,
        };
        await teamOrchestrationApi.updateSettings(projectId, update);
      }
      const latest = await teamOrchestrationApi.structure(projectId);
      setSnapshot(latest);
      setDraft(latest.settings ? {
        leaderOrchestration: latest.settings.leaderOrchestration,
        permissionLevel: latest.settings.permissionLevel,
        orchestratorAgentId: latest.settings.orchestratorAgentId ?? '',
        fallbackAgentIds: [...latest.settings.fallbackAgentIds],
      } : EMPTY_DRAFT);
      setSaved(true);
    } catch (cause) {
      if (cause instanceof TeamOrchestrationApiError && cause.status === 409) {
        setConflict(true);
        try {
          const latest = await teamOrchestrationApi.structure(projectId);
          setSnapshot(latest);
          setDraft(latest.settings ? {
            leaderOrchestration: latest.settings.leaderOrchestration,
            permissionLevel: latest.settings.permissionLevel,
            orchestratorAgentId: latest.settings.orchestratorAgentId ?? '',
            fallbackAgentIds: [...latest.settings.fallbackAgentIds],
          } : EMPTY_DRAFT);
        } catch (refreshCause) {
          setError(refreshCause instanceof Error ? refreshCause.message : 'Could not refresh the latest team settings.');
        }
      } else setError(cause instanceof Error ? cause.message : 'Could not save team settings.');
    } finally { setSaving(false); }
  };

  const addFallback = (agentId: string) => {
    if (!agentId || draft.fallbackAgentIds.length >= 4 || draft.fallbackAgentIds.includes(agentId) || agentId === draft.orchestratorAgentId) return;
    setDraft((current) => ({ ...current, fallbackAgentIds: [...current.fallbackAgentIds, agentId] }));
  };

  const moveFallback = (index: number, direction: -1 | 1) => {
    setDraft((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.fallbackAgentIds.length) return current;
      const fallbackAgentIds = [...current.fallbackAgentIds];
      [fallbackAgentIds[index], fallbackAgentIds[nextIndex]] = [fallbackAgentIds[nextIndex]!, fallbackAgentIds[index]!];
      return { ...current, fallbackAgentIds };
    });
  };

  return <section className="team-orch-settings" aria-labelledby="team-orch-settings-title" aria-busy={loading || saving}>
    <header className="team-orch-settings__heading">
      <span className="team-orch-settings__icon"><Crown size={16} /></span>
      <div><h3 id="team-orch-settings-title">Make this a team project</h3><p>Coordinate consented agents across teammate devices.</p></div>
      <Button size="sm" variant="ghost" disabled={loading || saving} onClick={() => void load()} aria-label="Refresh team orchestration settings"><RefreshCw size={13} /></Button>
    </header>
    {loading && !snapshot ? <p className="team-orch-settings__status" role="status">Loading team settings…</p> : null}
    {error ? <p className="team-orch-settings__error" role="alert"><CircleAlert size={14} />{error}</p> : null}
    {conflict ? <p className="team-orch-settings__notice" role="status">These settings changed elsewhere. The latest version is shown; review it and save again if needed.</p> : null}
    {saved ? <p className="team-orch-settings__success" role="status">Team project settings saved.</p> : null}
    {snapshot ? <>
      {!snapshot.host.online ? <p className="team-orch-settings__notice" role="status">The lead’s device is offline. Team orchestration settings can’t be changed until it reconnects.</p>
        : !snapshot.host.isThisDevice ? <p className="team-orch-settings__notice" role="status">This device is not the project host. Only the lead’s device can change team orchestration settings.</p>
          : !snapshot.canEdit ? <p className="team-orch-settings__notice" role="status">Only the team lead or an admin on the lead’s device can change these settings.</p> : null}
      {snapshot.enabled && snapshot.settings ? <p className="team-orch-settings__summary"><Users size={14} /> Team orchestration is on · {snapshot.settings.permissionLevel === 'supervised' ? 'Supervised' : 'Full access'} · {snapshot.members.length} roster agents</p>
        : <p className="team-orch-settings__summary"><Users size={14} /> This shared project is not yet a team-orchestrated project.</p>}
      {!canEdit && snapshot.enabled && snapshot.settings ? <div className="team-orch-settings__readonly" aria-label="Read-only team orchestration settings">
        <p><strong>Leader orchestration</strong><span>{draft.leaderOrchestration ? 'On · untagged team messages go to the orchestrator' : 'Off · only @mentions start agents'}</span></p>
        <p><strong>Group permission level</strong><span>{draft.permissionLevel === 'supervised' ? 'Supervised' : 'Full access'}</span></p>
        <p><strong>Orchestrator agent</strong><span>{orchestrator ? `${orchestrator.name} · ${orchestrator.ownerDisplayName} · ${orchestrator.deviceName}` : 'Not assigned'}</span></p>
        <p><strong>Fallback leaders</strong><span>{draft.fallbackAgentIds.map((id) => roster.get(id)?.name ?? 'Unavailable agent').join(' → ') || 'None selected'}</span></p>
      </div> : !canEdit ? <p className="team-orch-settings__notice" role="status">Team orchestration is not enabled. Only the team lead or an admin on the lead’s device can enable it.</p> : null}
      {canEdit ? <fieldset className="team-orch-settings__controls" aria-label="Edit team orchestration settings">
      <Switch checked={draft.leaderOrchestration} onChange={(value) => { setDraft((current) => ({ ...current, leaderOrchestration: value })); setSaved(false); }} label="Leader orchestration" description="When on, untagged messages go to the orchestrator agent. When off, only @mentions start agents." id="team-leader-orchestration" />
      <div className="team-orch-settings__field">
        <strong>Group permission level</strong>
        <Segmented value={draft.permissionLevel} onChange={(value) => { setDraft((current) => ({ ...current, permissionLevel: value })); setSaved(false); }} label="Group permission level" options={[
          { value: 'supervised', label: 'Supervised' }, { value: 'full-access', label: 'Full access' },
        ]} />
        <p>Supervised runs ask the agent owner before file or command actions. Full access allows remote runs with full local tool permission in an isolated worktree; the owner device still controls its own credentials and can pause or revoke access.</p>
        {choosingFullAccess ? <p className="team-orch-settings__warning" role="alert"><CircleAlert size={14} />Choosing Full access means all teammates must consent at this level. Raising a project from Supervised to Full access requires every teammate to re-consent before new work is delivered.</p> : null}
      </div>
      <div className="team-orch-settings__field">
        <label htmlFor="team-orchestrator-agent">Orchestrator agent</label>
        {snapshot.enabled && snapshot.settings ? <p className="team-orch-settings__value">{orchestrator?.name ?? 'No orchestrator assigned'}{orchestrator ? ` · ${orchestrator.ownerDisplayName} · ${orchestrator.deviceName}` : ''}. Change the active leader in Team structure.</p> : <>
          <select id="team-orchestrator-agent" value={draft.orchestratorAgentId} disabled={!canEdit || !members.length} onChange={(event) => setDraft((current) => ({ ...current, orchestratorAgentId: event.target.value, fallbackAgentIds: current.fallbackAgentIds.filter((id) => id !== event.target.value) }))}>
            <option value="">{members.length ? 'Choose an agent…' : 'No roster agents available'}</option>
            {members.map((member) => <option key={member.agentId} value={member.agentId}>{member.name} · {member.ownerDisplayName} · {member.deviceName}</option>)}
          </select>
          {!members.length ? <p>Share an agent to the project roster before enabling orchestration. Agents on any teammate device can be selected.</p> : null}
        </>}
      </div>
      <div className="team-orch-settings__field">
        <strong>Fallback leaders <span>(optional · up to 4)</span></strong>
        <p>If the orchestrator goes offline or exhausts quota, Mingle tries these agents in order.</p>
        {draft.fallbackAgentIds.length ? <ol className="team-orch-settings__fallbacks">{draft.fallbackAgentIds.map((id, index) => {
          const member = roster.get(id);
          return <li key={id}><span><b>{index + 1}.</b> {member?.name ?? 'Agent unavailable'} <small>{member ? `${member.ownerDisplayName} · ${member.deviceName}` : id}</small></span>
            <div><Button size="sm" variant="ghost" disabled={!canEdit || index === 0} aria-label={`Move ${member?.name ?? 'fallback'} up`} onClick={() => moveFallback(index, -1)}><ArrowUp size={13} /></Button><Button size="sm" variant="ghost" disabled={!canEdit || index === draft.fallbackAgentIds.length - 1} aria-label={`Move ${member?.name ?? 'fallback'} down`} onClick={() => moveFallback(index, 1)}><ArrowDown size={13} /></Button><Button size="sm" variant="ghost" disabled={!canEdit} onClick={() => setDraft((current) => ({ ...current, fallbackAgentIds: current.fallbackAgentIds.filter((item) => item !== id) }))}>Remove</Button></div>
          </li>;
        })}</ol> : <p className="team-orch-settings__empty">No fallback leaders selected.</p>}
        {draft.fallbackAgentIds.length < 4 ? <label className="team-orch-settings__add-fallback">Add fallback agent
          <select value="" disabled={!canEdit || members.length === 0} onChange={(event) => addFallback(event.target.value)}><option value="">Choose an agent…</option>{members.filter((member) => member.agentId !== draft.orchestratorAgentId && !draft.fallbackAgentIds.includes(member.agentId)).map((member) => <option key={member.agentId} value={member.agentId}>{member.name} · {member.ownerDisplayName} · {member.deviceName}</option>)}</select>
        </label> : null}
      </div>
      </fieldset> : null}
      {canEdit ? <div className="team-orch-settings__actions"><Button variant="primary" size="sm" disabled={saving || (!snapshot.enabled && (!draft.orchestratorAgentId || !members.length))} busy={saving} onClick={() => void save()}>{enabled ? 'Save team settings' : 'Enable team project'}</Button></div> : null}
    </> : null}
  </section>;
}
