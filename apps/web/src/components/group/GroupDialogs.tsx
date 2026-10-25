import { useId, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { AgentConfiguration, GroupMode } from '@mingle/contracts';
import { useMingle } from '../../store/store';
import { api, errorMessage, type SessionPatch } from '../../lib/api';
import { shortPath } from '../../lib/format';
import {
  MODE_LABEL, ROLE_LABEL, activeMembers, effectiveTurnCeiling, isBusy, memberHasActiveWork, providerName, routingSummary, sameConfig, sessionConfig,
} from '../../lib/groups';
import { Button, Field, InlineError, Modal } from '../ui';
import { SelectMenu } from '../SelectMenu';
import { ConfigFields } from './ConfigFields';
import { Roster, type RosterEntry } from './AddAgentDialog';
import type { AutonomyMode, GroupRecoveryPolicy } from '../../lib/api';
import { useTeamStructure } from '../../lib/team-structure-context';

const MODES: GroupMode[] = ['cowork', 'orchestrated', 'current-leads'];
const AUTONOMY_OPTIONS = [
  { value: 'supervised', label: 'Supervised', description: 'Pause after each planned delegation batch for your review and acknowledgement.' },
  { value: 'balanced', label: 'Balanced', description: 'Finish the planned batch within scope; pause for scope changes, recorded stalls, or recovery decisions.' },
  { value: 'extended', label: 'Extended', description: 'Continue milestones within the original objective and limits; pause for scope changes or recorded stalls.' },
] as const;

/** Edits one member's saved session settings, only while that member has no active or queued work. */
export function MemberSettingsDialog({ groupId, memberId }: { groupId: string; memberId: string }) {
  const close = useMingle.getState().closeDialog;
  const connection = useMingle((s) => s.connection);
  const snapshot = useMingle((s) => s.boot?.groups?.find((g) => g.group.id === groupId));
  const member = snapshot?.members.find((m) => m.id === memberId);
  const session = useMingle((s) => s.boot?.sessions.find((x) => x.id === member?.sessionId));
  const idBase = useId();
  const [config, setConfig] = useState<AgentConfiguration | null>(() => (session ? sessionConfig(session) : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!snapshot || !member || !session || !config) {
    return <Modal title="Member settings" onClose={close} width={460}><p className="field__hint">This member is no longer in the group.</p></Modal>;
  }
  const locked = memberHasActiveWork(snapshot, member, session);
  const baseline = sessionConfig(session);
  const dirty = !sameConfig(baseline, config);
  const why = connection !== 'online' ? 'Reconnect to the server first.' : locked ? 'Settings can change only while this member is idle with no queued work.' : !dirty ? 'No changes to save.' : undefined;

  const save = async () => {
    if (why) return;
    const patch: SessionPatch = {};
    if (config.provider !== baseline.provider) patch.provider = config.provider;
    if (config.model !== baseline.model) patch.model = config.model;
    if (config.effort !== baseline.effort) patch.effort = config.effort;
    if (config.policy !== baseline.policy) patch.policy = config.policy;
    if (config.serviceTier !== baseline.serviceTier) patch.serviceTier = config.serviceTier;
    setBusy(true);
    setError(null);
    try {
      await api.updateSession(session.id, patch);
      await useMingle.getState().refreshNow();
      useMingle.getState().toast('success', `Updated @${member.handle}.`);
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`@${member.handle} settings`} description={`${ROLE_LABEL[member.role]} · ${session.name}`} onClose={close} width={620}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" busy={busy} disabled={Boolean(why)} why={why} onClick={() => void save()}>Save settings</Button></>}>
      <div className="form">
        <p className="field__hint">These are the saved settings of this member’s own session. Changing model or effort keeps its conversation; the provider can change only before a provider conversation exists.</p>
        <ConfigFields idPrefix={idBase} legend={`@${member.handle} configuration`} value={config} onChange={setConfig} lockProvider={Boolean(session.providerSessionId)} disabled={locked} />
        <div className="gd-facts">
          <div><span>Workspace</span><strong>{session.isolated ? 'Isolated worktree' : 'Project folder'}</strong><small>{session.branch ? `${session.branch} · ` : ''}{shortPath(session.worktreePath, 4)}</small></div>
        </div>
        {locked ? <div className="inline-warn" role="note"><AlertTriangle size={14} aria-hidden="true" /><span>@{member.handle} is {isBusy(session) ? session.status : 'waiting on queued work'}. Stop it or wait for it to finish before changing settings.</span></div> : null}
        {error ? <InlineError>{error}</InlineError> : null}
      </div>
    </Modal>
  );
}

/** Explicit, idle-time mode transition with the resulting roster and routing, using the supported UpdateGroup fields only. */
export function GroupModeDialog({ groupId }: { groupId: string }) {
  const close = useMingle.getState().closeDialog;
  const connection = useMingle((s) => s.connection);
  const sessions = useMingle((s) => s.boot?.sessions);
  const providers = useMingle((s) => s.boot?.providers);
  const snapshot = useMingle((s) => s.boot?.groups?.find((g) => g.group.id === groupId));
  const teamStructure = useTeamStructure();
  const resilientGroup = snapshot?.group;
  const idBase = useId();
  const members = useMemo(() => (snapshot ? activeMembers(snapshot) : []), [snapshot]);
  const [mode, setMode] = useState<GroupMode>(snapshot?.group.mode ?? 'cowork');
  const [lead, setLead] = useState<string>(() => snapshot?.group.orchestratorMemberId ?? members.find((m) => m.sessionId !== snapshot?.group.anchorSessionId)?.id ?? members[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limits, setLimits] = useState({ maxParallel: String(snapshot?.group.maxParallel ?? 2), maxTurns: String(snapshot?.group.maxTurns ?? 80), maxHops: String(snapshot?.group.maxHops ?? 6) });
  const [autonomyMode, setAutonomyMode] = useState<AutonomyMode>(resilientGroup?.autonomy?.mode ?? 'balanced');
  const [emergencyMode, setEmergencyMode] = useState<'inherit' | 'disabled' | 'custom'>(resilientGroup?.autonomy?.emergencyTurnLimit === null ? 'disabled' : typeof resilientGroup?.autonomy?.emergencyTurnLimit === 'number' ? 'custom' : 'inherit');
  const [emergencyLimit, setEmergencyLimit] = useState(resilientGroup?.autonomy?.emergencyTurnLimit == null ? '' : String(resilientGroup.autonomy.emergencyTurnLimit));
  const [automaticFallback, setAutomaticFallback] = useState(resilientGroup?.recoveryPolicy?.automaticFallback ?? false);
  const [allowUnverifiedQuotaFallback, setAllowUnverifiedQuotaFallback] = useState(Boolean(resilientGroup?.recoveryPolicy?.automaticFallback && resilientGroup.recoveryPolicy.allowUnverifiedQuotaFallback));
  const [leadFallbackMemberId, setLeadFallbackMemberId] = useState(resilientGroup?.recoveryPolicy?.leadFallbackMemberId ?? 'none');
  const [workerFallbacks, setWorkerFallbacks] = useState<Record<string, string>>(resilientGroup?.recoveryPolicy?.workerFallbacks ?? {});

  if (!snapshot || !providers || !sessions) return <Modal title="Change mode" onClose={close} width={460}><p className="field__hint">This group is no longer available.</p></Modal>;
  const group = snapshot.group;
  const needsLead = mode !== 'cowork';
  const anchorMember = members.find((member) => member.sessionId === group.anchorSessionId);
  const coordinators = members.filter((member) => member.sessionId !== group.anchorSessionId);
  const leadId = mode === 'current-leads' ? anchorMember?.id ?? null : mode === 'orchestrated' ? lead : null;
  const running = members.filter((m) => isBusy(sessions.find((s) => s.id === m.sessionId)));
  const runningDeliveries = snapshot.deliveries.filter((d) => d.status === 'running');
  const queued = snapshot.deliveries.filter((d) => d.status === 'queued');
  const unchanged = mode === group.mode && (!needsLead || leadId === group.orchestratorMemberId);
  const bounds = { maxParallel: { label: 'Simultaneous runs', min: 1, max: 6 }, maxTurns: { label: 'Automatic turns', min: 2, max: 10_000 }, maxHops: { label: 'Message hops', min: 1, max: 12 } } as const;
  type LimitKey = keyof typeof bounds;
  const limitKeys = Object.keys(bounds) as LimitKey[];
  const validLimit = (key: LimitKey) => limits[key].trim() !== '' && Number.isInteger(Number(limits[key])) && Number(limits[key]) >= bounds[key].min && Number(limits[key]) <= bounds[key].max;
  const limitsValid = limitKeys.every(validLimit);
  const limitsDirty = limitKeys.some((key) => Number(limits[key]) !== group[key]);
  const savedAutonomy = resilientGroup?.autonomy;
  const savedEmergency = savedAutonomy?.emergencyTurnLimit;
  const emergencyValid = emergencyMode !== 'custom' || (emergencyLimit.trim() !== '' && Number.isInteger(Number(emergencyLimit)) && Number(emergencyLimit) >= 2 && Number(emergencyLimit) <= 10_000);
  const effectiveTurns = effectiveTurnCeiling(
    Number(limits.maxTurns),
    emergencyMode === 'inherit' ? undefined : emergencyMode === 'disabled' ? null : emergencyValid ? Number(emergencyLimit) : null,
  );
  const effectiveTurnsLabel = !validLimit('maxTurns') ? 'set a valid automatic-turn limit' : emergencyMode === 'custom' && !emergencyValid ? 'set a valid emergency value' : effectiveTurns === null ? 'none' : String(effectiveTurns);
  const autonomyDirty = autonomyMode !== (savedAutonomy?.mode ?? 'balanced')
    || emergencyMode !== (savedEmergency === null ? 'disabled' : typeof savedEmergency === 'number' ? 'custom' : 'inherit')
    || (emergencyMode === 'custom' && Number(emergencyLimit) !== savedEmergency);
  const requestLead = [...snapshot.requests].reverse().find((item) => item.status === 'active' || item.status === 'paused')?.plannerMemberId;
  const fallbackLeadId = group.orchestratorMemberId ?? requestLead;
  const fallbackChoices = (exclude: string | undefined) => members.filter((member) => member.id !== exclude).map((member) => {
    const candidateSession = sessions.find((item) => item.id === member.sessionId);
    const workspace = candidateSession
      ? candidateSession.isolated ? `isolated worktree${candidateSession.branch ? ` · ${candidateSession.branch}` : ''}` : 'project folder'
      : 'workspace unavailable';
    const configuration = candidateSession
      ? `${providerName(candidateSession.provider)} · ${candidateSession.model} · ${candidateSession.effort} effort · ${candidateSession.policy} permissions · ${workspace} · existing conversation${member.held ? ' · paused by you' : ''}`
      : 'Session configuration unavailable';
    return { value: member.id, label: `@${member.handle}`, description: `${ROLE_LABEL[member.role]} · ${configuration}`, disabled: Boolean(member.held || !candidateSession) };
  });
  const hasFallbackSession = (memberId: string) => members.some((member) => member.id === memberId && !member.held && sessions.some((session) => session.id === member.sessionId));
  const leadFallbackValid = leadFallbackMemberId === 'none' || (hasFallbackSession(leadFallbackMemberId) && leadFallbackMemberId !== fallbackLeadId);
  const normalizedWorkerFallbacks = Object.fromEntries(Object.entries(workerFallbacks).filter(([source, target]) =>
    members.some((member) => member.id === source) && members.some((member) => member.id === target) && source !== target,
  ));
  const workerFallbackValid = Object.entries(normalizedWorkerFallbacks).every(([source, target]) => source !== target && hasFallbackSession(target));
  const hasAutomaticFallbackDestination = Object.values(normalizedWorkerFallbacks).some(hasFallbackSession)
    || (mode === 'orchestrated' && leadFallbackMemberId !== 'none' && leadFallbackValid);
  const coordinatorFallbackLabel = mode === 'cowork' ? 'Planner fallback' : mode === 'current-leads' ? 'Current lead fallback' : 'Coordinator fallback';
  const coordinatorFallbackHint = mode === 'cowork'
    ? 'Replaces only the affected request’s planner and keeps the other peers in Cowork.'
    : mode === 'current-leads'
      ? 'Replaces the current lead and switches to Orchestrated mode, retaining the original anchor and history.'
      : 'Replaces the coordinator while keeping the group in Orchestrated mode.';
  const nextRecoveryPolicy: GroupRecoveryPolicy = {
    automaticFallback, allowUnverifiedQuotaFallback: automaticFallback && allowUnverifiedQuotaFallback,
    leadFallbackMemberId: leadFallbackMemberId === 'none' ? null : leadFallbackMemberId,
    workerFallbacks: normalizedWorkerFallbacks,
  };
  const currentRecoveryPolicy: GroupRecoveryPolicy = {
    automaticFallback: resilientGroup?.recoveryPolicy?.automaticFallback ?? false,
    allowUnverifiedQuotaFallback: Boolean(resilientGroup?.recoveryPolicy?.automaticFallback && resilientGroup.recoveryPolicy.allowUnverifiedQuotaFallback),
    leadFallbackMemberId: resilientGroup?.recoveryPolicy?.leadFallbackMemberId ?? null,
    workerFallbacks: resilientGroup?.recoveryPolicy?.workerFallbacks ?? {},
  };
  const recoveryPolicyDirty = JSON.stringify(nextRecoveryPolicy) !== JSON.stringify(currentRecoveryPolicy);
  const policyValid = leadFallbackValid && workerFallbackValid && (!automaticFallback || hasAutomaticFallbackDestination);
  const settingsChanged = !unchanged || limitsDirty || autonomyDirty || recoveryPolicyDirty;
  const why = connection !== 'online' ? 'Reconnect to the server first.'
    : running.length || runningDeliveries.length ? 'Mode can change only while every member is idle. Wait for runs to finish or stop them.'
      : queued.length && !group.paused ? `${queued.length} queued ${queued.length === 1 ? 'delivery' : 'deliveries'} would be affected. Pause the group before changing its mode.`
        : !limitsValid ? 'Enter whole-number limits within the displayed ranges.'
          : !emergencyValid ? 'Enter a whole-number emergency ceiling from 2 to 10,000.'
            : !policyValid ? automaticFallback && !hasAutomaticFallbackDestination ? `Automatic fallback needs an active, unpaused worker destination${mode === 'orchestrated' ? ' or coordinator destination' : ''}.` : 'Choose an active, unpaused, different member for each configured fallback.'
          : needsLead && !leadId ? 'Choose which member coordinates.'
            : mode === 'orchestrated' && !coordinators.some((member) => member.id === leadId) ? 'Choose a coordinator other than the original session.'
              : !settingsChanged ? 'No changes to save.' : undefined;

  const roster: RosterEntry[] = members.map((member) => {
    const session = sessions.find((s) => s.id === member.sessionId);
    const teamMember = teamStructure.snapshot?.members.find((candidate) => candidate.agentId === member.id || candidate.sessionId === member.sessionId || candidate.handle === member.handle);
    return {
      key: member.id, handle: member.handle, role: !needsLead ? 'peer' : member.id === leadId ? 'orchestrator' : 'worker',
      note: member.role === (!needsLead ? 'peer' : member.id === leadId ? 'orchestrator' : 'worker') ? 'Unchanged' : `Was ${ROLE_LABEL[member.role].toLowerCase()}`,
      provider: teamMember?.provider ?? session?.provider, model: teamMember?.model ?? session?.model ?? '', effort: teamMember?.effort ?? session?.effort ?? '', policy: session?.policy ?? 'supervised', serviceTier: session?.serviceTier ?? 'standard',
      workspace: session ? (session.isolated ? 'Isolated worktree' : 'Project folder') : 'Unknown workspace',
      ...(teamMember && !teamMember.local ? { badge: `on ${teamMember.deviceName} · ${teamMember.ownerDisplayName}` } : {}),
    };
  });
  const routing = routingSummary(mode, roster.map((entry) => ({ handle: entry.handle, role: entry.role })));

  const apply = async () => {
    if (why) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateGroup(group.id, {
        ...(!unchanged ? { mode, ...(leadId ? { orchestratorMemberId: leadId } : {}) } : {}),
        ...(limitsDirty ? { maxParallel: Number(limits.maxParallel), maxTurns: Number(limits.maxTurns), maxHops: Number(limits.maxHops) } : {}),
        ...(autonomyDirty ? { autonomy: {
          ...(savedAutonomy ?? {}), mode: autonomyMode,
          ...(emergencyMode === 'disabled' ? { emergencyTurnLimit: null } : emergencyMode === 'custom' ? { emergencyTurnLimit: Number(emergencyLimit) } : { emergencyTurnLimit: undefined }),
        } } : {}),
        ...(recoveryPolicyDirty ? { recoveryPolicy: nextRecoveryPolicy } : {}),
      });
      const store = useMingle.getState();
      store.applyGroup(updated);
      await store.refreshNow();
      store.toast('success', 'Group settings saved. Resume explicitly when you are ready to continue paused work.');
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Group settings" description="Review routing, participants and automatic work limits. Completed history is kept." onClose={close} width={760}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" busy={busy} disabled={Boolean(why)} why={why} onClick={() => void apply()}>Apply settings</Button></>}>
      <div className="group-dialog form">
        <fieldset className="gm-list">
          <legend className="gd-h">Mode</legend>
          {MODES.map((value, index) => (
            <label key={value} className="gm-option">
              <input type="radio" name={`${idBase}-mode`} value={value} checked={mode === value} data-autofocus={index === 0 ? '' : undefined} onChange={() => { setMode(value); if (value === 'orchestrated' && !coordinators.some((member) => member.id === lead)) setLead(coordinators[0]?.id ?? ''); }} />
              <span><strong>{MODE_LABEL[value]}</strong><small>{value === 'cowork' ? 'You direct equal peers. Unaddressed messages reach every active peer.' : value === 'current-leads' ? 'The original session becomes the orchestrator and retains its existing context and configuration.' : 'Choose an existing member other than the original session to coordinate. This change creates no new agent.'}</small></span>
            </label>
          ))}
        </fieldset>
        {mode === 'orchestrated' ? (
          <Field label={mode === 'orchestrated' ? 'Orchestrator' : 'Lead agent'} htmlFor={`${idBase}-lead`}
            hint="Choose one of the current members. A separate orchestrator can only be created when a single session is first converted.">
            <SelectMenu id={`${idBase}-lead`} label="Coordinating member" value={lead} onChange={setLead} options={coordinators.map((m) => ({ value: m.id, label: `@${m.handle}`, description: ROLE_LABEL[m.role] }))} />
          </Field>
        ) : null}
        <section aria-label="Roster after the change">
          <h3 className="gd-h">After the change</h3>
          <Roster entries={roster} providers={providers} />
          <p className="gd-routing" role="status">{routing}</p>
        </section>
        <section className="group-limits" aria-labelledby={`${idBase}-limits`}>
          <h3 className="gd-h" id={`${idBase}-limits`}>Automatic work limits</h3>
          <p className="field__hint">Limits apply to this group. Raising a reached limit does not restart work: review the queue, then choose Resume.</p>
          <div className="group-limit-grid">
            {limitKeys.map((key) => <Field key={key} label={bounds[key].label} htmlFor={`${idBase}-${key}`} hint={`${bounds[key].min}–${bounds[key].max}`} error={validLimit(key) ? null : 'Enter a whole number in this range.'}>
              <input id={`${idBase}-${key}`} className="input group-limit-field" type="number" min={bounds[key].min} max={bounds[key].max} step={1} inputMode="numeric" value={limits[key]} disabled={busy} aria-invalid={!validLimit(key)} onChange={(event) => setLimits((current) => ({ ...current, [key]: event.target.value }))} />
            </Field>)}
          </div>
        </section>
        <section className="group-limits group-autonomy" aria-labelledby={`${idBase}-autonomy`}>
          <h3 className="gd-h" id={`${idBase}-autonomy`}>Autonomy and recovery</h3>
          <p className="field__hint">Coordination autonomy controls when the scheduler pauses for your input. It does not change a member’s provider, model, or permissions.</p>
          <Field label="Autonomy" htmlFor={`${idBase}-autonomy-mode`}>
            <SelectMenu id={`${idBase}-autonomy-mode`} label="Group autonomy" value={autonomyMode} disabled={busy} options={[...AUTONOMY_OPTIONS]} onChange={(value) => setAutonomyMode(value as AutonomyMode)} />
          </Field>
          <Field label="Emergency turn ceiling" htmlFor={`${idBase}-emergency-mode`} hint={emergencyMode === 'inherit' ? `Uses the automatic-turn limit (${limits.maxTurns}) for legacy compatibility.` : emergencyMode === 'disabled' ? 'No emergency turn ceiling; parallel-run and message-hop limits still apply.' : 'An explicit ceiling overrides the legacy automatic-turn limit.'}>
            <SelectMenu id={`${idBase}-emergency-mode`} label="Emergency turn ceiling" value={emergencyMode} disabled={busy} options={[{ value: 'inherit', label: 'Use automatic-turn limit' }, { value: 'disabled', label: 'No emergency ceiling' }, { value: 'custom', label: 'Custom ceiling' }]} onChange={(value) => setEmergencyMode(value as typeof emergencyMode)} />
          </Field>
          {emergencyMode === 'custom' ? <Field label="Emergency turns" htmlFor={`${idBase}-emergency-turns`} hint="Whole number from 2 to 10,000." error={emergencyValid ? null : 'Enter a whole number from 2 to 10,000.'}>
            <input id={`${idBase}-emergency-turns`} className="input group-limit-field" type="number" min={2} max={10_000} step={1} inputMode="numeric" value={emergencyLimit} disabled={busy} aria-invalid={!emergencyValid || undefined} onChange={(event) => setEmergencyLimit(event.target.value)} />
          </Field> : null}
          <p className="field__hint" role="status">Effective automatic-turn ceiling: {effectiveTurnsLabel}.</p>
          <div className="group-recovery-settings">
            <h4 className="gd-h">Configured fallback members</h4>
            <p className="field__hint">Choose an unpaused member. Handoff preserves source partial edits and checkpoint/dirty-path references; the destination uses its existing workspace. Files are not copied or merged, and permissions do not change. No fallback runs automatically unless you opt in below.</p>
            <Field label={coordinatorFallbackLabel} htmlFor={`${idBase}-lead-fallback`} hint={coordinatorFallbackHint}>
              <SelectMenu id={`${idBase}-lead-fallback`} label={coordinatorFallbackLabel} value={leadFallbackMemberId} displayValue={leadFallbackValid ? undefined : 'Unavailable member'} disabled={busy} options={[{ value: 'none', label: 'Not configured' }, ...fallbackChoices(fallbackLeadId)]} onChange={setLeadFallbackMemberId} />
            </Field>
            <details className="group-fallbacks">
              <summary>Worker fallbacks · {Object.keys(normalizedWorkerFallbacks).length} configured</summary>
              <div className="group-fallbacks__list">
                {members.map((member) => {
                  const options = [{ value: 'none', label: 'Not configured' }, ...fallbackChoices(member.id)];
                  const value = workerFallbacks[member.id] ?? 'none';
                  return <Field key={member.id} label={`When @${member.handle} needs reassignment`} htmlFor={`${idBase}-fallback-${member.id}`}>
                    <SelectMenu id={`${idBase}-fallback-${member.id}`} label={`Fallback member for @${member.handle}`} value={value} displayValue={options.some((option) => option.value === value) ? undefined : 'Unavailable member'} disabled={busy} options={options} onChange={(next) => setWorkerFallbacks((current) => {
                      const updated = { ...current };
                      if (next === 'none') delete updated[member.id]; else updated[member.id] = next;
                      return updated;
                    })} />
                  </Field>;
                })}
              </div>
            </details>
            <label className="group-recovery-settings__opt-in" htmlFor={`${idBase}-automatic-fallback`}>
              <input id={`${idBase}-automatic-fallback`} type="checkbox" checked={automaticFallback} disabled={busy} onChange={(event) => {
                const enabled = event.target.checked;
                setAutomaticFallback(enabled);
                if (!enabled) setAllowUnverifiedQuotaFallback(false);
              }} />
              <span><strong>Allow automatic quota fallback</strong><small>Use configured worker mappings for eligible known quota failures. Only Orchestrated mode can automatically use its coordinator fallback; Cowork planner replacement stays request-scoped, and Current agent lead replacement requires an explicit switch to Orchestrated. Unknown pools stay paused unless you enable the advanced option below.</small></span>
            </label>
            {automaticFallback && !hasAutomaticFallbackDestination ? <p className="field__hint" role="status">Automatic fallback needs an active, unpaused worker destination{mode === 'orchestrated' ? ' or coordinator destination' : ''}. Manual recovery remains available.</p> : null}
            {automaticFallback ? <label className="group-recovery-settings__opt-in is-advanced" htmlFor={`${idBase}-unverified-quota-fallback`}>
              <input id={`${idBase}-unverified-quota-fallback`} type="checkbox" checked={allowUnverifiedQuotaFallback} disabled={busy} onChange={(event) => setAllowUnverifiedQuotaFallback(event.target.checked)} />
              <span><strong>Allow one fallback attempt when quota pools are unreported</strong><small>Quota availability remains unverified. This permits one bounded attempt with the selected member’s existing workspace and permissions, without changing them; it does not prove quota availability. A known exhausted pool shared with the source, same-provider unknowns, held targets, and higher or incompatible permission policies remain blocked.</small></span>
            </label> : null}
          </div>
        </section>
        {queued.length ? <div className="inline-warn" role="note"><AlertTriangle size={14} aria-hidden="true" /><span>{queued.length} queued {queued.length === 1 ? 'delivery stays' : 'deliveries stay'} with {queued.length === 1 ? 'its' : 'their'} original {queued.length === 1 ? 'recipient' : 'recipients'}; review {queued.length === 1 ? 'it' : 'them'} after the change before resuming.</span></div> : null}
        {why && why !== 'No changes to save.' ? <p className="field__hint" role="status">{why}</p> : null}
        {error ? <InlineError>{error}</InlineError> : null}
      </div>
    </Modal>
  );
}
