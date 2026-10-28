import { useEffect, useId, useLayoutEffect, useRef, useState, type TransitionEvent } from 'react';
import type { Approval, GroupMember, GroupSnapshot, ProviderInfo, Session, SessionRun, TeamAgentState, TeamStructureMember } from '@mingle/contracts';
import { configSummary, ROLE_LABEL } from '../../lib/groups';
import { memberPresence } from '../../lib/groupPresence';
import { formatElapsed } from '../../lib/activity';
import { teamAgentDisplayName, teamAgentMetadata } from '../../lib/team-agent-display';
import { teamConsentStatusLabel } from '../../lib/team-consent';
import { useMingle } from '../../store/store';
import { AgentIdentity } from './AgentIdentity';
import { AgentActivityDrawer, type ActivityAgent } from '../team-orchestration/activity/AgentActivityDrawer';

const ACTIVITY_STATE = {
  working: 'working', approval: 'awaiting-approval', queued: 'queued', paused: 'paused', error: 'failed',
  interrupted: 'paused', idle: 'idle', unavailable: 'offline', offline: 'offline',
} as const;
const TEAM_STATE_LABEL: Record<TeamAgentState, string> = {
  idle: 'Idle', queued: 'Queued', working: 'Working', 'awaiting-approval': 'Awaiting approval',
  'quota-exhausted': 'Quota exhausted', offline: 'Offline', paused: 'Paused', failed: 'Failed',
};

function useElapsed(startedAt: string | null, active: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, active]);
  if (!active || !startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  return formatElapsed(Math.max(0, now - start));
}

function PresenceRow({
  snapshot, member, session, runs, approvals, connection, providers, onOpen, teamMember,
}: {
  snapshot: GroupSnapshot; member: GroupMember; session: Session | undefined; runs: readonly SessionRun[];
  approvals: readonly Approval[]; connection: 'online' | 'connecting' | 'offline'; providers: readonly ProviderInfo[];
  onOpen: (agent: ActivityAgent) => void;
  teamMember?: TeamStructureMember;
}) {
  const presence = memberPresence({ snapshot, member, session, runs, approvals, connection });
  const isWorking = presence.working;
  const ownerPaused = Boolean(presence.state === 'paused' && teamMember && !teamMember.local && member.held);
  const currentLabel = ownerPaused ? 'Paused by owner' : presence.label;
  const elapsed = useElapsed(presence.startedAt, isWorking);
  const summary = session ? configSummary({ model: session.model, effort: session.effort, policy: session.policy, serviceTier: session.serviceTier ?? 'standard' }, providers, session.provider) : null;
  const currentTask = useMingle((state) => {
    const delivery = snapshot.deliveries.filter((item) => item.memberId === member.id && (item.status === 'queued' || item.status === 'running'))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    const assignment = delivery && snapshot.assignments.find((item) => item.deliveryId === delivery.id);
    return assignment ? state.boot?.tasks.find((task) => task.id === assignment.taskId)?.title ?? null : null;
  });
  const activityState = member.failure?.kind === 'quota_exhausted' ? 'quota-exhausted' : ACTIVITY_STATE[presence.state];
  const teamName = teamMember ? teamAgentDisplayName(teamMember.name, teamMember.ownerDisplayName, teamMember.provider) : null;
  const displayName = teamName ?? (session ? teamAgentDisplayName(session.name, 'Teammate', session.provider) : member.handle);
  const open = () => onOpen({
    agentId: teamMember?.agentId ?? member.id, handle: member.handle, name: displayName, provider: teamMember?.provider ?? session?.provider ?? null,
    model: teamMember?.model ?? session?.model ?? 'Model not reported', local: teamMember?.local ?? true, ownerDisplayName: teamMember?.ownerDisplayName ?? 'You', deviceName: teamMember?.deviceName ?? 'this device',
    role: member.role === 'peer' ? 'worker' : member.role, state: activityState,
    currentTask: teamMember?.currentTask ?? currentTask, sessionId: teamMember?.sessionId ?? member.sessionId, failureMessage: teamMember?.failure?.message ?? member.failure?.message ?? null,
  });
  return (
    <li className={`agent-presence__row is-${presence.state}`}>
      <button type="button" className="agent-presence__open" onClick={open} aria-label={`Open @${member.handle} conversation, ${currentLabel}`}>
        <div className="agent-presence__identity" title={ROLE_LABEL[member.role]}>
          <AgentIdentity handle={member.handle} identityKey={teamMember?.agentId ?? member.sessionId} provider={teamMember?.provider ?? session?.provider} />
          <span className="agent-presence__state" title={`${currentLabel}${elapsed ? ` · ${elapsed}` : ''}`} aria-label={`${currentLabel}${elapsed ? `, elapsed ${elapsed}` : ''}`}>
            <span className={isWorking ? 'activity-shimmer' : undefined}>{currentLabel}</span>
            {elapsed ? <time className="agent-presence__elapsed" dateTime={presence.startedAt ?? undefined} aria-live="off">{elapsed}</time> : null}
          </span>
        </div>
        {teamMember && !teamMember.local ? <><small className="agent-presence__device">{teamName}</small><small className="agent-presence__device">{teamAgentMetadata({ ownerDisplayName: teamMember.ownerDisplayName, provider: teamMember.provider, model: teamMember.model, deviceName: teamMember.deviceName })}</small></> : null}
        {summary && session ? <small className="agent-presence__model" title={`${summary.model} · ${summary.detail}`}>{summary.model} · {summary.detail.split(' · ')[0]}</small> : null}
        {teamMember && !summary ? <small className="agent-presence__model">{teamMember.model}{teamMember.effort ? ` · ${teamMember.effort} effort` : ''}</small> : null}
        {(ownerPaused ? 'The teammate owner paused this agent.' : teamMember?.currentTask ?? presence.detail) ? <small className="agent-presence__detail" title={ownerPaused ? 'The teammate owner paused this agent.' : teamMember?.currentTask ?? presence.detail ?? undefined}>{ownerPaused ? 'The teammate owner paused this agent.' : teamMember?.currentTask ?? presence.detail}</small> : null}
      </button>
    </li>
  );
}

function TeamPresenceRow({ member, state = member.state, onOpen }: { member: TeamStructureMember; state?: TeamAgentState; onOpen: (agent: ActivityAgent) => void }) {
  const displayName = teamAgentDisplayName(member.name, member.ownerDisplayName, member.provider);
  const stateLabel = member.consent === 'needs-reconsent' ? teamConsentStatusLabel(member.consent, member.ownerDisplayName, member.local)
    : state === 'paused' && !member.local ? 'Paused by owner' : TEAM_STATE_LABEL[state];
  const open = () => onOpen({
    agentId: member.agentId, handle: member.handle, name: displayName, provider: member.provider, model: member.model,
    local: member.local, ownerDisplayName: member.ownerDisplayName, deviceName: member.deviceName, role: member.role,
    state, currentTask: member.currentTask, sessionId: member.sessionId, failureMessage: member.failure?.message ?? null,
  });
  return <li className={`agent-presence__row is-${state}`}>
    <button type="button" className="agent-presence__open" onClick={open} aria-label={`Open @${member.handle} conversation, ${stateLabel}`}>
      <div className="agent-presence__identity" title={member.role}>
        <AgentIdentity handle={member.handle} identityKey={member.agentId} provider={member.provider} role={member.role === 'orchestrator' ? 'Orchestrator' : undefined} />
        <span className="agent-presence__state"><span className={state === 'working' ? 'activity-shimmer' : undefined}>{stateLabel}</span></span>
      </div>
      {!member.local ? <><small className="agent-presence__device">{displayName}</small><small className="agent-presence__device">{teamAgentMetadata({ ownerDisplayName: member.ownerDisplayName, provider: member.provider, model: member.model, deviceName: member.deviceName })}</small></> : null}
      <small className="agent-presence__model">{member.model}{member.effort ? ` · ${member.effort} effort` : ''}</small>
      {member.currentTask ? <small className="agent-presence__detail" title={member.currentTask}>{member.currentTask}</small> : null}
    </button>
  </li>;
}

export function AgentPresenceRail({
  snapshot, members, sessions, runs, approvals, connection, providers, hidden = false, teamMembers = [], teamStates = {}, projectId, expandAtWidth = 960,
}: {
  snapshot: GroupSnapshot | null; members: readonly GroupMember[]; sessions: readonly Session[]; runs: readonly SessionRun[];
  approvals: readonly Approval[]; connection: 'online' | 'connecting' | 'offline'; providers: readonly ProviderInfo[];
  hidden?: boolean;
  teamMembers?: readonly TeamStructureMember[];
  teamStates?: Readonly<Record<string, TeamAgentState>>;
  projectId?: string;
  /** Shared member chat keeps its roster visible at narrower desktop widths. */
  expandAtWidth?: number;
}) {
  const panel = useRef<HTMLElement>(null);
  const head = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const preference = useRef<boolean | null>(null);
  const resizeFrame = useRef<number | null>(null);
  const resizeVersion = useRef(0);
  const [expanded, setExpanded] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<ActivityAgent | null>(null);
  const presence = snapshot ? members.map((member) => memberPresence({
    snapshot, member, session: sessions.find((session) => session.id === member.sessionId), runs, approvals, connection,
  })) : teamMembers.map((member) => {
    const state = teamStates[member.agentId] ?? member.state;
    return {
      working: state === 'working', queuedCount: state === 'queued' ? 1 : 0,
      state: state === 'awaiting-approval' ? 'approval' : state === 'failed' ? 'error' : state,
      label: TEAM_STATE_LABEL[state], startedAt: null, detail: member.currentTask,
    };
  });
  const workingCount = presence.filter((state) => state.working).length;
  const queuedCount = presence.reduce((total, state) => total + state.queuedCount, 0);
  const needsApproval = presence.some((state) => state.state === 'approval' || state.state === 'awaiting-approval');
  const otherState = presence.find((state) => ['error', 'unavailable', 'paused', 'interrupted', 'offline', 'failed', 'quota-exhausted'].includes(state.state));
  const activity = needsApproval ? 'Needs approval'
    : workingCount ? `${workingCount} working${queuedCount ? ` · ${queuedCount} queued` : ''}`
      : queuedCount ? `${queuedCount} queued`
        : otherState?.label ?? (presence.length ? 'All idle' : 'No agents');
  const caption = connection === 'connecting' ? 'Reconnecting' : connection === 'offline' ? 'Offline'
    : expanded ? (snapshot ? members.length : teamMembers.length) : activity;

  useEffect(() => () => {
    resizeVersion.current++;
    if (resizeFrame.current !== null) window.cancelAnimationFrame(resizeFrame.current);
  }, []);

  useLayoutEffect(() => {
    const container = panel.current?.parentElement;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const transcript = container.querySelector<HTMLElement>('.chat__scroll');
    const update = () => {
      // Follow the visible transcript, including when a growing composer consumes more height.
      const availableHeight = Math.max(0, (transcript?.clientHeight ?? container.clientHeight) - 24);
      panel.current?.style.setProperty('--agent-presence-max-height', `${Math.min(280, availableHeight)}px`);
    };
    const updateDefault = () => {
      const availableHeight = Math.max(0, (transcript?.clientHeight ?? container.clientHeight) - 24);
      if (preference.current === null) setExpanded(container.clientWidth >= expandAtWidth && availableHeight >= 240);
    };
    update();
    updateDefault();
    // Context pane width transitions must not switch the bubble's expansion midway through its fade.
    window.addEventListener('resize', updateDefault);
    const observer = new ResizeObserver(update);
    observer.observe(container);
    if (transcript) observer.observe(transcript);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateDefault);
    };
  }, [expandAtWidth]);

  const toggle = () => {
    const next = !expanded;
    preference.current = next;
    const element = panel.current;
    if (!element) { setExpanded(next); return; }

    const version = ++resizeVersion.current;
    if (resizeFrame.current !== null) window.cancelAnimationFrame(resizeFrame.current);
    resizeFrame.current = null;
    const currentHeight = element.getBoundingClientRect().height;
    element.style.height = `${currentHeight}px`;
    element.getBoundingClientRect();
    setExpanded(next);

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const cap = Number.parseFloat(window.getComputedStyle(element).maxHeight);
    const limit = Number.isFinite(cap) ? cap : Number.POSITIVE_INFINITY;
    const collapsedHeight = Math.min(limit, Math.max(38, (head.current?.offsetHeight ?? 34) + 2));
    if (reduced) {
      element.style.height = next ? 'auto' : `${collapsedHeight}px`;
      return;
    }
    resizeFrame.current = window.requestAnimationFrame(() => {
      resizeFrame.current = null;
      if (version !== resizeVersion.current || !panel.current) return;
      const currentCap = Number.parseFloat(window.getComputedStyle(element).maxHeight);
      const currentLimit = Number.isFinite(currentCap) ? currentCap : Number.POSITIVE_INFINITY;
      // The flex list shrinks inside the frozen outer height. Measure its own
      // scroll content, rather than the already clipped outer card.
      const naturalHeight = (head.current?.offsetHeight ?? 34) + (list.current?.scrollHeight ?? 0) + 2;
      const target = next ? Math.min(naturalHeight, currentLimit) : collapsedHeight;
      element.style.height = `${target}px`;
    });
  };

  const settleSize = (event: TransitionEvent<HTMLElement>) => {
    const element = panel.current;
    if (!element || event.target !== element || event.propertyName !== 'height') return;
    const target = Number.parseFloat(element.style.height);
    if (!Number.isFinite(target) || Math.abs(element.getBoundingClientRect().height - target) > 1) return;
    if (expanded) element.style.height = 'auto';
  };

  return (
    <>
    <aside ref={panel} onTransitionEnd={settleSize} className={`agent-presence${expanded ? ' is-expanded' : ' is-collapsed'}${hidden ? ' is-hidden' : ''}`} aria-label="Agent presence" aria-hidden={hidden} inert={hidden}>
      <header ref={head} className="agent-presence__head">
        <strong>Agents</strong>
        <span>{caption}</span>
        <button type="button" className="agent-presence__toggle" aria-label={expanded ? 'Collapse agent presence' : 'Expand agent presence'} aria-expanded={expanded} aria-controls={listId} onClick={toggle}>
          <span aria-hidden="true">{expanded ? '−' : '+'}</span>
        </button>
      </header>
      <ul ref={list} className="agent-presence__list" id={listId} aria-hidden={!expanded} inert={!expanded}>
        {snapshot ? members.map((member) => {
          const teamMember = teamMembers.find((candidate) => candidate.agentId === member.id || candidate.sessionId === member.sessionId || candidate.handle === member.handle);
          return <PresenceRow key={member.id} snapshot={snapshot} member={member} session={sessions.find((item) => item.id === member.sessionId)} runs={runs} approvals={approvals} connection={connection} providers={providers} onOpen={setSelectedAgent} teamMember={teamMember} />;
        }) : teamMembers.map((member) => <TeamPresenceRow key={member.agentId} member={member} state={teamStates[member.agentId]} onOpen={setSelectedAgent} />)}
      </ul>
    </aside>
    {selectedAgent ? <AgentActivityDrawer key={`${selectedAgent.agentId}:${selectedAgent.sessionId ?? ''}`} projectId={snapshot?.group.projectId ?? projectId ?? ''} agent={selectedAgent} onClose={() => setSelectedAgent(null)} /> : null}
    </>
  );
}
