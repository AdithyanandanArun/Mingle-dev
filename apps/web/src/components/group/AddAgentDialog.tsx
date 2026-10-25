import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Pause, Play } from 'lucide-react';
import type { AgentConfiguration, GroupMember, GroupMode, GroupSnapshot, ProviderInfo, Session, TeamAvailableAgentsSnapshot } from '@mingle/contracts';
import { useMingle } from '../../store/store';
import { api, errorMessage } from '../../lib/api';
import { teamSessionsApi } from '../../lib/team-sessions';
import { useTeamStructure } from '../../lib/team-structure-context';
import { shortPath } from '../../lib/format';
import {
  MODE_EXPLANATION, MODE_FLOW, MODE_LABEL, MODE_TAGLINE, ROLE_LABEL, activeMembers, allHandles, configSummary, defaultConfigFor, effortLabel, initialWorkerConfig,
  isBusy, normalizeConfig, policyLabel, providerAvailability, providerName, routingSummary, sameConfig, sessionConfig, suggestHandle, tierLabel, validateHandle,
} from '../../lib/groups';
import { Button, Field, InlineError, Modal, Switch } from '../ui';
import { ConfigFields } from './ConfigFields';
import { ModeDiagram, useDiagramMotion } from './ModeDiagrams';
import { AgentIdentity } from './AgentIdentity';

const MODES: GroupMode[] = ['cowork', 'orchestrated', 'current-leads'];
const TITLES: Record<GroupMode, string> = { cowork: 'Cowork', orchestrated: 'Orchestrated', 'current-leads': 'Current agent leads' };

export interface RosterEntry {
  key: string; handle: string; role: GroupMember['role']; note: string; provider?: ProviderInfo['id'];
  model: string; effort: string; policy: AgentConfiguration['policy']; serviceTier: string; workspace: string; badge?: string;
}

/** The effective choices for each participant, shown before anything is created. */
export function Roster({ entries, providers }: { entries: RosterEntry[]; providers: readonly ProviderInfo[] }) {
  return (
    <ul className="roster" aria-label="Participants">
      {entries.map((entry) => {
        const summary = entry.provider ? configSummary(entry, providers, entry.provider) : null;
        const availability = entry.provider ? providerAvailability(providers, entry.provider) : null;
        return (
          <li key={entry.key} className="roster__row">
              <div className="roster__who">
                <AgentIdentity handle={entry.handle || 'Orchestrator'} identityKey={entry.key} provider={entry.provider} role={ROLE_LABEL[entry.role]} prefix={Boolean(entry.handle)} />
                {entry.badge ? <span className="roster__badge">{entry.badge}</span> : null}
              <small>{entry.note}</small>
            </div>
            <div className="roster__detail">
              {entry.provider && summary ? <span>{providerName(entry.provider)} · {summary.model}</span> : <span>Provider unknown</span>}
              {summary ? <small>{summary.detail}</small> : null}
              {availability && !availability.available ? <small className="roster__warn">Unavailable: {availability.reason}</small> : null}
            </div>
            <div className="roster__detail"><span>{entry.workspace}</span></div>
          </li>
        );
      })}
    </ul>
  );
}

function workspaceOf(session: Session): string {
  return session.isolated ? `Isolated worktree${session.branch ? ` · ${session.branch}` : ''} · ${shortPath(session.worktreePath)}` : `Project folder · ${shortPath(session.worktreePath)}`;
}

function changeNotes(before: AgentConfiguration, after: AgentConfiguration, providers: readonly ProviderInfo[]): string[] {
  const notes: string[] = [];
  const name = (config: AgentConfiguration) => configSummary(config, providers, config.provider).model;
  if (before.model !== after.model) notes.push(`Model: ${name(before)} → ${name(after)}`);
  if (before.effort !== after.effort) notes.push(`Effort: ${effortLabel(before.effort)} → ${effortLabel(after.effort)}`);
  if (before.policy !== after.policy) notes.push(`Permissions: ${policyLabel(before.policy)} → ${policyLabel(after.policy)}`);
  if (before.serviceTier !== after.serviceTier) notes.push(`Service tier: ${tierLabel(before.serviceTier)} → ${tierLabel(after.serviceTier)}`);
  return notes;
}

export function AddAgentDialog({ sessionId }: { sessionId: string }) {
  const close = useMingle.getState().closeDialog;
  const boot = useMingle((s) => s.boot);
  const connection = useMingle((s) => s.connection);
  const session = boot?.sessions.find((item) => item.id === sessionId);
  const providers = boot?.providers;
  const settings = boot?.settings;
  const group: GroupSnapshot | undefined = useMemo(
    () => boot?.groups?.find((g) => g.members.some((m) => !m.removedAt && m.sessionId === sessionId) || g.group.anchorSessionId === sessionId),
    [boot?.groups, sessionId],
  );
  const project = boot?.projects.find((item) => item.id === session?.projectId);
  const projectId = project?.id;
  const teamStructure = useTeamStructure();
  const joining = Boolean(group);
  const idBase = useId();
  const motionRoot = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<'mode' | 'configure'>(joining ? 'configure' : 'mode');
  const [mode, setMode] = useState<GroupMode | null>(group?.group.mode ?? null);

  const existingHandle = useMemo(() => suggestHandle(session?.provider ?? settings?.defaultProvider ?? 'claude', []), [session?.provider, settings?.defaultProvider]);
  const takenHandles = useMemo(() => (group ? allHandles(group) : new Set([existingHandle])), [group, existingHandle]);
  const [agent, setAgent] = useState<AgentConfiguration | null>(() => (providers && settings ? initialWorkerConfig(settings, providers) : null));
  const [handle, setHandle] = useState(() => suggestHandle(agent?.provider ?? settings?.defaultProvider ?? 'codex', takenHandles));
  const [handleTouched, setHandleTouched] = useState(false);
  const [isolated, setIsolated] = useState(true);
  const [keepCurrent, setKeepCurrent] = useState<'keep' | 'change'>('keep');
  const [currentChange, setCurrentChange] = useState<AgentConfiguration | null>(() => (session ? sessionConfig(session) : null));
  const [orchestrator, setOrchestrator] = useState<AgentConfiguration | null>(() => (providers && settings
    ? normalizeConfig(settings.groupDefaults?.orchestrator ?? defaultConfigFor(settings.defaultProvider, settings, providers), providers, settings) : null));
  const [adjustOrchestrator, setAdjustOrchestrator] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharedProject, setSharedProject] = useState(false);
  const [teamAgents, setTeamAgents] = useState<TeamAvailableAgentsSnapshot | null>(null);
  const [teamAgentsLoading, setTeamAgentsLoading] = useState(false);
  const [teamAgentsError, setTeamAgentsError] = useState<string | null>(null);
  const [teamAgentBusyId, setTeamAgentBusyId] = useState<string | null>(null);
  const motion = useDiagramMotion(motionRoot, mode);

  const loadTeamAgents = useCallback(async (signal?: AbortSignal) => {
    if (!projectId || connection !== 'online') return;
    setTeamAgentsLoading(true);
    setTeamAgentsError(null);
    try {
      const collaboration = await api.projectCollaboration(projectId, signal);
      if (signal?.aborted) return;
      if (!collaboration.project) { setSharedProject(false); setTeamAgents(null); return; }
      setSharedProject(true);
      setTeamAgents(await teamSessionsApi.availableAgents(projectId, signal));
    } catch (cause) {
      if (!signal?.aborted) setTeamAgentsError(errorMessage(cause));
    } finally {
      if (!signal?.aborted) setTeamAgentsLoading(false);
    }
  }, [connection, projectId]);

  useEffect(() => {
    const controller = new AbortController();
    setSharedProject(false); setTeamAgents(null);
    void loadTeamAgents(controller.signal);
    return () => controller.abort();
  }, [loadTeamAgents]);

  // Another open window may convert or change this conversation while this dialog is open.
  useEffect(() => {
    if (group) { setMode(group.group.mode); setStep('configure'); }
  }, [group?.group.id, group?.group.mode]);

  // A suggested handle follows the chosen provider until the user edits it.
  useEffect(() => {
    if (!handleTouched && agent) setHandle(suggestHandle(agent.provider, takenHandles));
  }, [agent?.provider, handleTouched, takenHandles]);
  useEffect(() => {
    document.querySelector<HTMLElement>('.group-dialog [data-step-focus]')?.focus({ preventScroll: true });
  }, [step]);

  if (!session || !providers || !settings || !agent || !currentChange || !orchestrator) {
    return <Modal title="Add agent" onClose={close} width={460}><p className="field__hint">The session is no longer available.</p></Modal>;
  }

  const orchestratedConversion = !joining && mode === 'orchestrated';
  const roleOfNew: GroupMember['role'] = mode === 'cowork' ? 'peer' : 'worker';
  const handleError = validateHandle(handle, takenHandles);
  const newAvailability = providerAvailability(providers, agent.provider);
  const orchestratorAvailability = providerAvailability(providers, orchestrator.provider);
  const settingsOrchestrator = settings.groupDefaults?.orchestrator;
  const sessionBusy = isBusy(session);
  const changing = orchestratedConversion && keepCurrent === 'change';
  const baseline = sessionConfig(session);
  const currentEdited = changing && !sameConfig(baseline, currentChange);
  const notes = changing ? changeNotes(baseline, currentChange, providers) : [];

  const newEntry: RosterEntry = {
    key: 'new', handle: handle.trim().toLowerCase(), role: roleOfNew, note: 'New independent conversation', ...agent,
    workspace: isolated ? 'New isolated worktree · folder and branch are created when added' : `Project folder · ${project ? shortPath(project.path) : 'shared'}`,
  };
  let roster: RosterEntry[];
  if (group) {
    const existing = activeMembers(group).map<RosterEntry>((member) => {
      const memberSession = boot?.sessions.find((item) => item.id === member.sessionId);
      const teamMember = teamStructure.snapshot?.members.find((candidate) => candidate.agentId === member.id || candidate.sessionId === member.sessionId || candidate.handle === member.handle);
      return {
        key: member.id, handle: member.handle, role: member.role, note: 'Existing conversation', provider: memberSession?.provider,
        model: memberSession?.model ?? '', effort: memberSession?.effort ?? '', policy: memberSession?.policy ?? 'supervised', serviceTier: memberSession?.serviceTier ?? 'standard',
        workspace: memberSession ? workspaceOf(memberSession) : 'Unknown workspace',
        ...(teamMember && !teamMember.local ? { badge: `on ${teamMember.deviceName} · ${teamMember.ownerDisplayName}`, provider: teamMember.provider, model: teamMember.model, effort: teamMember.effort ?? '' } : {}),
      };
    });
    roster = [...existing, newEntry];
  } else {
    const shown = changing ? currentChange : baseline;
    const existingEntry: RosterEntry = {
      key: 'existing', handle: existingHandle, role: mode === 'current-leads' ? 'orchestrator' : mode === 'orchestrated' ? 'worker' : 'peer',
      note: `Existing conversation preserved${session.name ? ` · ${session.name}` : ''}`, ...shown, workspace: workspaceOf(session),
    };
    roster = [
      ...(orchestratedConversion ? [{ key: 'orchestrator', handle: '', role: 'orchestrator' as const, note: settingsOrchestrator ? 'Separate conversation · from Settings' : 'Separate conversation · chosen here', ...orchestrator, workspace: 'New isolated worktree' }] : []),
      existingEntry, newEntry,
    ];
  }
  const modeForRouting = mode ?? 'cowork';
  const routing = routingSummary(modeForRouting, roster.filter((entry) => entry.handle).map((entry) => ({ handle: entry.handle, role: entry.role })));

  const blocker = connection !== 'online' ? 'Reconnect to the server first.'
    : handleError ? handleError
      : !newAvailability.available ? `${providerName(agent.provider)} is unavailable: ${newAvailability.reason}`
        : orchestratedConversion && !orchestratorAvailability.available ? `The orchestrator’s provider is unavailable: ${orchestratorAvailability.reason}`
          : changing && sessionBusy ? 'The current agent is running; configuration can only change while it is idle.'
            : null;

  const submit = async () => {
    if (blocker || !mode || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = { configuration: agent, handle: handle.trim().toLowerCase(), isolated };
      let snapshot: GroupSnapshot;
      if (group) snapshot = await api.addGroupAgent(group.group.id, body);
      else {
        const { provider: _provider, ...currentConfiguration } = currentChange;
        void _provider;
        snapshot = await api.createGroup({
          sessionId, mode, agent: body,
          ...(orchestratedConversion ? { orchestrator } : {}),
          ...(currentEdited ? { currentConfiguration } : {}),
        });
      }
      const store = useMingle.getState();
      store.applyGroup(snapshot);
      await store.refreshNow();
      store.toast('success', `Added @${body.handle}. No model run was started.`);
      store.closeDialog();
      store.selectSession(snapshot.group.anchorSessionId);
      window.requestAnimationFrame(() => document.getElementById(`composer-${snapshot.group.anchorSessionId}`)?.focus());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const addTeammateAgent = async (agentId: string) => {
    if (!teamAgents?.canAdd || teamAgents.agents.find((agent) => agent.agentId === agentId)?.usable !== true || teamAgentBusyId) return;
    setTeamAgentBusyId(agentId);
    setError(null);
    try {
      const snapshot = group
        ? await teamSessionsApi.addToGroup(group.group.id, { agentId })
        : await teamSessionsApi.addToSession(sessionId, { agentId });
      const store = useMingle.getState();
      store.applyGroup(snapshot);
      await store.refreshNow();
      await teamStructure.refresh().catch(() => null);
      store.toast('success', `Added teammate agent to ${snapshot.group.title || 'the team session'}.`);
      store.closeDialog();
      store.selectSession(snapshot.group.anchorSessionId);
      window.requestAnimationFrame(() => document.getElementById(`composer-${snapshot.group.anchorSessionId}`)?.focus());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally { setTeamAgentBusyId(null); }
  };

  const title = joining ? 'Add agent' : step === 'mode' ? 'Add agent' : `Add agent · ${mode ? TITLES[mode] : ''}`;
  const description = joining ? `${MODE_LABEL[group!.group.mode]} conversation. The new agent joins with this mode.`
    : step === 'mode' ? 'Choose how the agents in this conversation work together.' : 'Review each participant before adding. Adding an agent creates configuration only; no model run starts.';

  const footer = step === 'mode'
    ? <><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" disabled={!mode} why="Choose how the agents work together" onClick={() => setStep('configure')}>Continue</Button></>
    : <>
      {!joining ? <Button variant="ghost" onClick={() => setStep('mode')} disabled={busy}>Back</Button> : null}
      <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
      <Button variant="primary" busy={busy} disabled={Boolean(blocker)} why={blocker ?? undefined} onClick={() => void submit()}>Add agent</Button>
    </>;

  return (
    <Modal title={title} description={description} onClose={close} footer={footer} width={step === 'mode' ? 1040 : 760}>
      <div className="group-dialog" ref={motionRoot}>
        {step === 'mode' ? (
          <>
            <div className="gm-head">
              <div><h3>How should these agents work together?</h3><p>Choose who coordinates this conversation.</p></div>
              <button type="button" className="gm-motion" aria-pressed={motion.paused} disabled={motion.reduced} onClick={motion.toggle}>
                {motion.paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
                {motion.reduced ? 'Reduced motion' : motion.paused ? 'Play motion' : 'Pause motion'}
              </button>
            </div>
            <fieldset className="gm-grid">
              <legend className="sr-only">Conversation mode</legend>
              {MODES.map((value, index) => (
                <Fragment key={value}>
                  <input className="sr-only gm-input" type="radio" name={`${idBase}-mode`} id={`${idBase}-${value}`} value={value} checked={mode === value}
                    data-step-focus={index === 0 ? '' : undefined} aria-describedby={`${idBase}-${value}-d`} onChange={() => setMode(value)} />
                  <label className="gm-card" htmlFor={`${idBase}-${value}`}>
                    <span className="gm-radio" aria-hidden="true" />
                    <span className="gm-title">{TITLES[value]}</span>
                    <span className="gm-tagline">{MODE_TAGLINE[value]}</span>
                    <ModeDiagram mode={value} existing={existingHandle} added={handle.trim().toLowerCase() || 'agent2'} />
                    <span className="gm-explain" id={`${idBase}-${value}-d`}>{MODE_EXPLANATION[value]}</span>
                    <span className="gm-flow" aria-hidden="true">{MODE_FLOW[value].map((label) => <span key={label}>{label}</span>)}</span>
                  </label>
                </Fragment>
              ))}
            </fieldset>
            <p className="gm-routing" role="status" aria-live="polite">
              {mode ? routing : 'Select a mode to preview its participants and routing.'}
            </p>
            <p className="field__hint">Illustrative flow. This preview starts no model calls and saves nothing.</p>
          </>
        ) : (
          <div className="form">
            <section aria-labelledby={`${idBase}-roster`}>
              <h3 className="gd-h" id={`${idBase}-roster`}>{mode ? `${TITLES[mode]} · ${roster.length} participants` : 'Participants'}</h3>
              <Roster entries={roster} providers={providers} />
              {!joining ? <p className="field__hint">The current agent’s handle is assigned when the group is created. The suggestion above reserves it so the new handle cannot collide.</p> : null}
              <p className="gd-routing" role="status">{routing}</p>
            </section>

            {orchestratedConversion ? (
              <>
                <fieldset className="gd-question">
                  <legend>Keep the current agent’s configuration?</legend>
                  <p className="field__hint">It will work under the orchestrator as a worker. You can choose a lighter model or lower effort, which applies to its existing conversation.</p>
                  <div className="gd-choices">
                    <label className="check"><input type="radio" name={`${idBase}-keep`} value="keep" checked={keepCurrent === 'keep'} onChange={() => setKeepCurrent('keep')} data-step-focus="" /><span>Keep current configuration</span></label>
                    <label className="check"><input type="radio" name={`${idBase}-keep`} value="change" checked={keepCurrent === 'change'} disabled={sessionBusy} onChange={() => setKeepCurrent('change')} /><span>Change configuration</span></label>
                  </div>
                  {sessionBusy ? <p className="field__hint">The current agent is running. Its configuration can change only while it is idle.</p> : null}
                  {changing ? (
                    <>
                      <ConfigFields idPrefix={`${idBase}-current`} legend="Current agent configuration" value={currentChange} lockProvider onChange={setCurrentChange} />
                      <div className="gd-diff" aria-label="Current and proposed settings">
                        <div><span>Current</span><strong>{configSummary(baseline, providers, baseline.provider).model}</strong><small>{configSummary(baseline, providers, baseline.provider).detail}</small></div>
                        <div><span>Proposed</span><strong>{configSummary(currentChange, providers, currentChange.provider).model}</strong><small>{configSummary(currentChange, providers, currentChange.provider).detail}</small></div>
                      </div>
                      {notes.length ? <div className="inline-warn" role="note"><AlertTriangle size={14} aria-hidden="true" /><span>This changes the current agent: {notes.join('; ')}. History and the provider conversation are kept.</span></div> : <p className="field__hint">No change from the current configuration.</p>}
                    </>
                  ) : null}
                </fieldset>

                <section className="gd-orch" aria-labelledby={`${idBase}-orch`}>
                  <h3 className="gd-h" id={`${idBase}-orch`}>Separate orchestrator</h3>
                  <p className="field__hint">{settingsOrchestrator ? 'Configured in Settings → Agents & orchestration. Review it here; changes below apply to this group only.' : 'No orchestrator default is saved in Settings → Agents & orchestration, so choose one here. It applies to this group only.'}</p>
                  <button type="button" className="link-btn" aria-expanded={adjustOrchestrator || !settingsOrchestrator} onClick={() => setAdjustOrchestrator((value) => !value)} hidden={!settingsOrchestrator}>
                    {adjustOrchestrator ? 'Hide orchestrator settings' : 'Adjust for this group'}
                  </button>
                  {adjustOrchestrator || !settingsOrchestrator ? <ConfigFields idPrefix={`${idBase}-orch`} legend="Orchestrator configuration" value={orchestrator} onChange={setOrchestrator} /> : null}
                </section>
              </>
            ) : null}

            <section aria-labelledby={`${idBase}-new`}>
              <h3 className="gd-h" id={`${idBase}-new`}>New agent</h3>
              <div className="form">
                <Field label="Handle" htmlFor={`${idBase}-handle`} error={handle ? handleError : null} hint="Messages reach this agent with @handle. Handles are unique in the conversation and are not reused after removal.">
                  <div className="gd-handle"><span aria-hidden="true">@</span>
                    <input id={`${idBase}-handle`} className="input input--mono" value={handle} maxLength={32} spellCheck={false} autoComplete="off" aria-invalid={Boolean(handle && handleError)}
                      data-step-focus={orchestratedConversion ? undefined : ''} onChange={(event) => { setHandleTouched(true); setHandle(event.target.value.replace(/^@/, '')); }}
                      onBlur={() => setHandle((value) => value.trim().toLowerCase())} />
                  </div>
                </Field>
                <ConfigFields idPrefix={`${idBase}-agent`} legend="New agent configuration" value={agent} onChange={setAgent} />
                <Switch checked={isolated} onChange={setIsolated} label="Isolated worktree"
                  description={isolated ? 'The agent edits its own Git worktree and branch, created when it is added. The project folder is untouched.' : `The agent edits the shared project folder${project ? ` (${shortPath(project.path)})` : ''}, so concurrent edits can collide with other agents.`} />
              </div>
            </section>
            {sharedProject && (teamAgents || teamAgentsLoading || teamAgentsError) ? <section className="team-agents-section" aria-labelledby={`${idBase}-team-agents`}>
              <div className="team-agents-section__heading"><div><h3 className="gd-h" id={`${idBase}-team-agents`}>Teammates’ agents</h3><p className="field__hint">Add an agent that runs on its owner’s computer. It joins this conversation just like a local agent.</p></div>
                {teamAgentsError ? <button type="button" className="link-btn" onClick={() => void loadTeamAgents()}>Retry</button> : null}
              </div>
              {teamAgentsLoading && !teamAgents ? <p className="field__hint" role="status">Loading available agents…</p> : null}
              {teamAgentsError ? <InlineError>{teamAgentsError}</InlineError> : null}
              {teamAgents?.canAdd === false ? <p className="team-agents-section__reason" role="note">{teamAgents.reason ?? 'You cannot add teammate agents from this device.'}</p> : null}
              {teamAgents && !teamAgents.agents.length ? <p className="field__hint">No teammates’ agents are available yet.</p> : null}
              {teamAgents?.agents.length ? <ul className="roster team-agent-roster" aria-label="Teammates’ agents">
                {teamAgents.agents.map((remote) => {
                  const disabledReason = !teamAgents.canAdd ? teamAgents.reason ?? 'You cannot add teammate agents from this device.' : !remote.usable ? remote.unusableReason ?? 'This agent cannot be added right now.' : undefined;
                  const unavailable = Boolean(disabledReason || teamAgentBusyId);
                  return <li className="roster__row team-agent-row" key={remote.agentId}>
                    <div className="roster__who"><AgentIdentity handle={remote.handle} identityKey={remote.agentId} provider={remote.provider} /><small>{remote.ownerDisplayName} · {remote.deviceName}</small></div>
                    <div className="roster__detail"><span>{providerName(remote.provider)} · {remote.model} · {remote.effort ?? 'effort not reported'}</span>{disabledReason ? <small className="roster__warn">{disabledReason}</small> : null}</div>
                    <div className="team-agent-row__action"><span className={`team-agent-online${remote.online ? ' is-online' : ''}`}><i aria-hidden="true" />{remote.online ? 'Online' : 'Offline'}</span>
                      <Button size="sm" disabled={unavailable} why={disabledReason ?? (teamAgentBusyId ? 'Adding another teammate agent…' : undefined)} busy={teamAgentBusyId === remote.agentId} onClick={() => void addTeammateAgent(remote.agentId)}>Add</Button>
                    </div>
                  </li>;
                })}
              </ul> : null}
            </section> : null}
            {error ? <InlineError>{error}</InlineError> : null}
            {blocker && !error && connection === 'online' && !handleError ? <p className="field__hint" role="status">{blocker}</p> : null}
          </div>
        )}
        {step === 'mode' && error ? <InlineError>{error}</InlineError> : null}
      </div>
    </Modal>
  );
}
