import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, AtSign, Loader2, X } from 'lucide-react';
import { TeamAgentStateSchema, type Session, type TeamChatAgent, type TeamChatGroupView, type TeamChatMessage, type TeamSessionRef, type TeamStructureMember, type TeamStructureSnapshot } from '@mingle/contracts';
import { useMingle } from '../../store/store';
import { api, errorMessage } from '../../lib/api';
import { clockTime, cx } from '../../lib/format';
import { AgentPresenceRail } from '../group/AgentPresenceRail';
import { AgentIdentity } from '../group/AgentIdentity';
import { MessageRow } from '../ConversationParts';
import type { Speaker } from '../../lib/groupTimeline';
import { Markdown } from '../Markdown';
import { TeamConsentBanner } from '../team-orchestration/settings/TeamConsentBanner';
import { Popover } from '../git/Popover';
import { GitBar } from '../git/GitBar';
import { subscribeToTeamUpdates } from '../../lib/team-live-updates';
import { useTeamStructure } from '../../lib/team-structure-context';
import { cacheTeamChatSnapshot, clearCachedTeamChatSnapshot, getCachedTeamChatSnapshot, reconcileTeamChatSnapshot } from '../../lib/team-snapshots';
import './team-session.css';
import './team-session-premium.css';

const RUN_STATE_LABEL: Record<NonNullable<TeamChatMessage['runState']>, string> = {
  queued: 'Queued', running: 'Agent working', 'awaiting-approval': 'Waiting for approval',
  completed: 'Turn complete', failed: 'Agent turn failed', interrupted: 'Interrupted',
};
const EMPTY_SESSIONS: Session[] = [];

function canonicalHandle(agent: TeamChatAgent, member?: TeamStructureMember): string {
  if (member?.handle) return member.handle;
  const slug = agent.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28);
  return slug || agent.id.slice(0, 24);
}

type TeamSessionTimelineRow =
  | { type: 'team-chat'; createdAt: string; orderKey: string; message: TeamChatMessage }
  | { type: 'group'; createdAt: string; orderKey: string; entry: TeamChatGroupView['messages'][number] };

function isMirroredGroupEntry(entry: TeamChatGroupView['messages'][number], messages: readonly TeamChatMessage[]): boolean {
  const authorKind = entry.kind === 'user' ? 'human' : entry.kind === 'agent' ? 'agent' : null;
  if (!authorKind) return false;
  const sourceMessageId = entry.sourceMessageId ?? (entry.kind === 'user' ? entry.id : null);
  return messages.some((message) => message.author.kind === authorKind && (
    message.id === entry.id || Boolean(sourceMessageId && (message.id === sourceMessageId || message.source?.messageId === sourceMessageId))
  ));
}

function mergeTeamSessionTimeline(messages: readonly TeamChatMessage[], groupView: TeamChatGroupView | null): TeamSessionTimelineRow[] {
  const rows: TeamSessionTimelineRow[] = messages.map((message) => ({
    type: 'team-chat', createdAt: message.createdAt, orderKey: `team:${message.id}`, message,
  }));
  if (groupView) {
    for (const entry of groupView.messages) {
      if (isMirroredGroupEntry(entry, messages)) continue;
      rows.push({ type: 'group', createdAt: entry.createdAt, orderKey: `group:${String(entry.seq).padStart(12, '0')}:${entry.id}`, entry });
    }
  }
  return rows.sort((left, right) => {
    const timeDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return (Number.isFinite(timeDifference) ? timeDifference : 0) || left.orderKey.localeCompare(right.orderKey);
  });
}

const TeamMessage = memo(function TeamMessage({ message, teamSession, agents, members }: {
  message: TeamChatMessage; teamSession: TeamSessionRef; agents: readonly TeamChatAgent[]; members: readonly TeamStructureMember[];
}) {
  if (message.author.kind === 'system') return null;
  const memberById = new Map(members.map((member) => [member.agentId, member]));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const toLabel = (agentId: string) => {
    const agent = agentById.get(agentId) ?? agents.find((candidate) => candidate.sessionId === agentId);
    const canonicalId = agent?.id ?? agentId;
    const member = memberById.get(canonicalId);
    return agent ? <AgentIdentity key={agentId} handle={canonicalHandle(agent, member)} identityKey={agentId} provider={member?.provider ?? agent.provider} /> : null;
  };
  const createdAt = <time className="msg__time" dateTime={message.createdAt} title={clockTime(message.createdAt)}>{clockTime(message.createdAt)}</time>;
  if (message.author.kind === 'human') return <article className="msg msg--user" aria-label={`Message from ${message.author.displayName}`} data-message-id={message.id}>
    <div className="msg__bubble"><Markdown text={message.body} /></div>
    {message.mentions.length ? <div className="msg__to">To {message.mentions.map(toLabel)}</div> : null}
    {message.deliveryState === 'failed' ? <div className="team-session__message-state is-failed">Delivery failed</div> : null}
    {message.deliveryState === 'sending' ? <div className="team-session__message-state">Sending</div> : null}
    {createdAt}
  </article>;

  const author = message.author;
  const agent = agentById.get(author.agentId) ?? agents.find((candidate) => candidate.sessionId === author.agentId);
  const structureMember = memberById.get(agent?.id ?? author.agentId);
  const role: Speaker['role'] = structureMember?.role === 'orchestrator' ? 'orchestrator' : structureMember?.role === 'idle' ? 'peer' : 'worker';
  const speaker: Speaker = {
    memberId: agent?.id ?? author.agentId, sessionId: structureMember?.sessionId ?? agent?.sessionId ?? teamSession.sessionId,
    handle: canonicalHandle(agent ?? { id: author.agentId, name: author.agentName, accountId: author.ownerAccountId, deviceId: '', projectId: '', sessionId: '', provider: author.provider, model: author.model, state: 'idle', local: false }, structureMember),
    role, removed: false,
  };
  const display = { id: message.id, sessionId: teamSession.sessionId, role: 'assistant' as const, content: message.body, createdAt: message.createdAt, live: false };
  return <div className="team-session__agent-message" data-message-id={message.id}>
    <MessageRow m={display} provider={author.provider} speaker={speaker} />
    {message.runState ? <div className={cx('team-session__message-state', message.runState === 'failed' && 'is-failed')}>{RUN_STATE_LABEL[message.runState]}</div> : null}
  </div>;
});

const MODE_NAME: Record<TeamChatGroupView['group']['mode'], string> = {
  cowork: 'Cowork', orchestrated: 'Orchestrated', 'current-leads': 'Current agent leads',
};
const TASK_STATE: Record<TeamChatGroupView['assignments'][number]['taskStatus'], string> = {
  backlog: 'Backlog', ready: 'Ready', running: 'Running', blocked: 'Blocked', review: 'Needs review', done: 'Accepted', unknown: 'Unknown',
};
const RESULT_STATE: Record<NonNullable<TeamChatGroupView['result']>['status'], string> = {
  pending: 'Waiting to start', 'in-progress': 'In progress', paused: 'Paused', failed: 'Failed', stopped: 'Stopped',
  blocked: 'Blocked', 'follow-up': 'Follow-up needed', review: 'Ready for review', accepted: 'Accepted', responded: 'Responded', unknown: 'Outcome unavailable',
};

const SharedGroupEntry = memo(function SharedGroupEntry({ entry, view, members, agents }: {
  entry: TeamChatGroupView['messages'][number]; view: TeamChatGroupView;
  members: readonly TeamStructureMember[]; agents: readonly TeamChatAgent[];
}) {
  const structureMember = members.find((member) => member.handle === entry.senderHandle);
  const groupMember = view.members.find((member) => member.handle === entry.senderHandle);
  const agent = structureMember ? agents.find((candidate) => candidate.id === structureMember.agentId) : undefined;
  const deliveries = view.deliveries.filter((delivery) => delivery.messageId === entry.id);
  const assignments = view.assignments.filter((assignment) => assignment.deliveryId && deliveries.some((delivery) => delivery.id === assignment.deliveryId));
  const time = <time className="msg__time" dateTime={entry.createdAt} title={clockTime(entry.createdAt)}>{clockTime(entry.createdAt)}</time>;
  if (entry.kind === 'user') return <article className="msg msg--user team-session__group-message" data-group-message-id={entry.id}>
    <div className="msg__bubble"><Markdown text={entry.content} /></div>
    {entry.recipientHandles.length ? <div className="msg__to">To {entry.recipientHandles.map((handle) => <span className="handle" key={handle}>@{handle} </span>)}</div> : null}
    {deliveries.length ? <SharedDeliveryStates deliveries={deliveries} /> : null}{time}
  </article>;

  if (entry.kind === 'assignment' || entry.kind === 'artifact') return <section className="group-card team-session__group-card" aria-label={entry.kind === 'assignment' ? 'Shared assignment' : 'Shared artifact'} data-group-message-id={entry.id}>
    <header><span className="group-card__kind">{entry.kind === 'assignment' ? 'Assignment' : 'Artifact'}</span><span className="group-card__route">{entry.senderHandle ? `@${entry.senderHandle}` : 'Shared group'}{entry.recipientHandles.length ? <> → {entry.recipientHandles.map((handle) => `@${handle}`).join(', ')}</> : null}</span></header>
    <div className="group-card__body">{entry.content ? <Markdown text={entry.content} /> : assignments.length
      ? <p>Task details are summarized from the shared task record below.</p> : <p>Shared task summary not reported.</p>}</div>
    {assignments.map((assignment) => <div className="group-card__meta" key={assignment.id}>
      <span><strong>{assignment.title}</strong> · {TASK_STATE[assignment.taskStatus]}</span>
      {assignment.scope.length ? <ul aria-label="Shared assignment scope">{assignment.scope.map((path) => <li key={path}><code>{path}</code></li>)}</ul> : null}
    </div>)}
    {deliveries.length ? <SharedDeliveryStates deliveries={deliveries} /> : null}{time}
  </section>;

  const role: Speaker['role'] = groupMember?.role ?? (structureMember?.role === 'orchestrator' ? 'orchestrator'
    : structureMember?.role === 'idle' ? 'peer' : 'worker');
  const speaker: Speaker | null = entry.senderHandle ? {
    memberId: structureMember?.agentId ?? entry.senderHandle, sessionId: structureMember?.sessionId ?? agent?.sessionId ?? entry.senderHandle,
    handle: entry.senderHandle, role, removed: groupMember?.removed ?? false,
  } : null;
  if (entry.kind === 'status') return <section className="team-session__group-status" role="note" aria-label="Shared group progress" data-group-message-id={entry.id}>
    {speaker ? <AgentIdentity handle={speaker.handle} identityKey={speaker.sessionId} provider={structureMember?.provider ?? agent?.provider} role={speaker.role === 'orchestrator' ? 'Orchestrator' : undefined} /> : null}
    <Markdown text={entry.content} />{deliveries.length ? <SharedDeliveryStates deliveries={deliveries} /> : null}{time}
  </section>;
  return <article className="msg msg--assistant team-session__group-message" aria-label={speaker ? `Shared group response from @${speaker.handle}` : 'Shared group response'} data-group-message-id={entry.id}>
    <div className="msg__main">
      {speaker ? <AgentIdentity handle={speaker.handle} identityKey={speaker.sessionId} provider={structureMember?.provider ?? agent?.provider} role={speaker.role === 'orchestrator' ? 'Orchestrator' : undefined} /> : null}
      <div className="msg__content"><Markdown text={entry.content} /></div>
      {deliveries.length ? <SharedDeliveryStates deliveries={deliveries} /> : null}{time}
    </div>
  </article>;
});

function SharedDeliveryStates({ deliveries }: { deliveries: TeamChatGroupView['deliveries'] }) {
  return <ul className="deliveries" aria-label="Shared delivery status">
    {deliveries.map((delivery) => <li key={delivery.id} className={`delivery is-${delivery.status}`}>
      <i aria-hidden="true" /><span className="handle">@{delivery.handle}</span><span>{delivery.status}{delivery.hop ? ` · hop ${delivery.hop}` : ''}</span>
      {delivery.error ? <span className="sr-only">{delivery.error}</span> : null}
    </li>)}
  </ul>;
}

const SharedGroupResult = memo(function SharedGroupResult({ result }: { result: NonNullable<TeamChatGroupView['result']> }) {
  return <section className={`team-session__result is-${result.status}`} aria-label="Latest shared group result">
    <div className="team-session__result-head"><strong>{result.title}</strong><span>{RESULT_STATE[result.status]}</span></div>
    <p>{result.summary}</p>
    {result.facts.length ? <ul>{result.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul> : null}
    {result.changedPaths.length ? <details><summary>Changed relative paths ({result.changedPaths.length})</summary><ul>{result.changedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></details> : null}
    <small>Task state and changed paths are shared records. A completed turn does not mean the work was accepted.</small>
  </section>;
});

function TeamSessionComposer({ projectId, sessionId, agents, structure, groupView, onMessage, onSent }: {
  projectId: string; sessionId: string; agents: readonly TeamChatAgent[]; structure: TeamStructureSnapshot | null;
  groupView: TeamChatGroupView | null;
  onMessage: (message: TeamChatMessage) => void; onSent: () => Promise<unknown>;
}) {
  const draft = useMingle((state) => state.drafts[sessionId] ?? '');
  const connection = useMingle((state) => state.connection);
  const input = useRef<HTMLTextAreaElement>(null);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const pickerId = `team-session-recipients-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const [picked, setPicked] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestions = useMemo(() => agents.flatMap((agent) => {
    const member = structure?.members.find((candidate) => candidate.agentId === agent.id);
    const handle = canonicalHandle(agent, member);
    if (groupView && (!member || !groupView.members.some((candidate) => !candidate.removed && candidate.handle === handle))) return [];
    return [{ agent, member }];
  }), [agents, groupView, structure?.members]);
  const orchestratorId = structure?.settings?.orchestratorAgentId ?? structure?.members.find((member) => member.role === 'orchestrator')?.agentId;
  const orchestrator = suggestions.find((candidate) => candidate.agent.id === orchestratorId) ?? suggestions[0];
  const defaultTargets = groupView
    ? groupView.routing.defaultRecipientHandles.flatMap((handle) => suggestions.filter((candidate) => canonicalHandle(candidate.agent, candidate.member) === handle))
    : orchestrator ? [orchestrator] : [];
  const cursor = Math.min(caret, draft.length);
  const before = draft.slice(0, cursor);
  const mentionMatch = /(?:^|[\s([{"'“‘,;:!?])@([A-Za-z0-9_-]*)$/.exec(before);
  const trigger = mentionMatch ? `@${mentionMatch[1] ?? ''}` : '';
  const triggerStart = cursor - trigger.length;
  const matching = mentionMatch ? suggestions.filter(({ agent, member }) => canonicalHandle(agent, member).toLowerCase().startsWith((mentionMatch[1] ?? '').toLowerCase())).slice(0, 8) : [];
  const pickerOpenForMention = focused && matching.length > 0 && trigger !== dismissed;
  const typedIds = suggestions.filter(({ agent, member }) => {
    const handle = canonicalHandle(agent, member).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[\\s([{"'“‘,;:!?])@${handle}(?=$|[\\s.,!?;:)\\]}])`, 'i').test(draft);
  }).map(({ agent }) => agent.id);
  const mentionedIds = [...new Set([...picked, ...typedIds])];
  const recipientIds = mentionedIds.length ? mentionedIds : defaultTargets.map((target) => target.agent.id);

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(element.scrollHeight, 260)}px`;
  }, [draft]);

  const setDraft = (value: string) => useMingle.getState().setDraft(sessionId, value);
  const selectSuggestion = (index: number) => {
    const target = matching[index];
    if (!target) return;
    const handle = canonicalHandle(target.agent, target.member);
    const value = `${draft.slice(0, triggerStart)}@${handle} ${draft.slice(cursor)}`;
    const nextCaret = triggerStart + handle.length + 2;
    setDraft(value);
    setPicked((current) => current.includes(target.agent.id) ? current : [...current, target.agent.id]);
    setCaret(nextCaret);
    setDismissed(null);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(nextCaret, nextCaret); });
  };
  const send = async () => {
    const body = draft.trim();
    if (!body || sending || connection !== 'online' || !recipientIds.length) return;
    setSending(true); setError(null);
    try {
      const sent = await api.sendTeamChatMessage(projectId, { body, mentions: mentionedIds });
      onMessage(sent);
      setDraft(''); setPicked([]); setCaret(0);
      try { await onSent(); } catch { /* accepted sends remain cleared if the mirror refresh is delayed */ }
      input.current?.focus();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSending(false); }
  };

  return <div className="composer-wrap">
    <form className="composer composer--group" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <div className="recips" role="group" aria-label="Recipients">
        <span className="recips__label">To</span>
        {mentionedIds.length ? mentionedIds.map((id) => {
          const target = suggestions.find((candidate) => candidate.agent.id === id);
          if (!target) return null;
          const handle = canonicalHandle(target.agent, target.member);
          return <span className="recips__chip is-mention" key={id}><AgentIdentity handle={handle} identityKey={id} provider={target.agent.provider} />
            {picked.includes(id) ? <button type="button" aria-label={`Remove @${handle} from recipients`} onClick={() => setPicked((current) => current.filter((value) => value !== id))}><X size={10} aria-hidden="true" /></button> : null}
          </span>;
        }) : defaultTargets.map(({ agent, member }) => <span className="recips__chip is-default" key={agent.id}><AgentIdentity handle={canonicalHandle(agent, member)} identityKey={agent.id} provider={agent.provider} /></span>)}
        {!mentionedIds.length ? <span className="recips__default">{groupView ? `${MODE_NAME[groupView.routing.mode]} · default route` : 'default: orchestrator'}</span> : null}
        <button ref={pickerButton} type="button" className="recips__pick" aria-haspopup="dialog" aria-expanded={pickerOpen} onClick={() => setPickerOpen((value) => !value)}><AtSign size={12} aria-hidden="true" /> Choose</button>
        {picked.length ? <button type="button" className="recips__clear" onClick={() => setPicked([])}>Clear selection</button> : null}
      </div>
      <label className="sr-only" htmlFor={`composer-${sessionId}`}>Message the team session</label>
      <textarea ref={input} id={`composer-${sessionId}`} className="composer__input" rows={1} value={draft}
        role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={pickerOpenForMention}
        aria-controls={pickerOpenForMention ? pickerId : undefined} aria-activedescendant={pickerOpenForMention ? `${pickerId}-option-${activeSuggestion}` : undefined}
        placeholder="Message the team session — @handle targets an agent…"
        onChange={(event) => { setDraft(event.currentTarget.value); setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length); setActiveSuggestion(0); }}
        onFocus={(event) => { setFocused(true); setCaret(event.currentTarget.selectionStart ?? 0); }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onBlur={(event) => { if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('.composer-picker-empty'))) setFocused(false); }}
        onKeyDown={(event) => {
          if (pickerOpenForMention && !event.nativeEvent.isComposing) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActiveSuggestion((index) => (index + (event.key === 'ArrowDown' ? 1 : matching.length - 1)) % matching.length); return; }
            if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) { event.preventDefault(); selectSuggestion(activeSuggestion); return; }
            if (event.key === 'Escape') { event.preventDefault(); setDismissed(trigger); return; }
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
        }} />
      {pickerOpenForMention ? <div className="composer-picker" id={pickerId} role="listbox" aria-label="Mention an agent">
        {matching.map(({ agent, member }, index) => <div key={agent.id} role="option" id={`${pickerId}-option-${index}`} aria-selected={index === activeSuggestion} className={cx('composer-picker__item', index === activeSuggestion && 'is-active')}
          onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActiveSuggestion(index)} onClick={() => selectSuggestion(index)}>
          <span className="composer-picker__name"><AgentIdentity handle={canonicalHandle(agent, member)} identityKey={agent.id} provider={agent.provider} /></span>
          <span className="composer-picker__description">{agent.provider} · {agent.model} · {member?.deviceName ?? 'Teammate agent'}</span>
        </div>)}
      </div> : null}
      <div className="composer__bar"><div className="composer__controls" />
        <div className="composer__send"><button type="submit" className="sendbtn" disabled={!draft.trim() || sending || connection !== 'online' || !recipientIds.length} aria-label="Send team session message" title={connection !== 'online' ? 'Reconnect to send' : !recipientIds.length ? 'No teammate agents are available' : 'Send message'}>
          {sending ? <Loader2 size={14} className="spin" /> : <ArrowUp size={15} />}
        </button></div>
      </div>
    </form>
    {error ? <p className="composer__note is-error" role="alert">{error}</p> : connection !== 'online' ? <p className="composer__note" role="status">Reconnect to Mingle to send to the team session.</p>
      : groupView?.group.paused ? <p className="composer__note" role="status">The shared group is paused. Messages may wait in its queue until the group host resumes it.</p> : null}
    <Popover anchor={pickerButton} open={pickerOpen} onClose={() => setPickerOpen(false)} label="Choose recipients" width={300} align="start" className="recips-pop">
      <fieldset className="recips-pop__list"><legend>Send to these agents</legend>
        {suggestions.map(({ agent, member }) => <label key={agent.id} className="check">
          <input type="checkbox" checked={picked.includes(agent.id)} onChange={() => setPicked((current) => current.includes(agent.id) ? current.filter((id) => id !== agent.id) : [...current, agent.id])} />
          <span><AgentIdentity handle={canonicalHandle(agent, member)} identityKey={agent.id} provider={agent.provider} /><small>{member?.role ?? (agent.local ? 'On this device' : 'Teammate')} · {agent.provider} · {agent.state}</small></span>
        </label>)}
      </fieldset>
      <div className="recips-pop__foot"><small>{picked.length ? `${picked.length} selected` : groupView ? `Nothing selected: ${MODE_NAME[groupView.routing.mode]} default route` : 'Nothing selected: default: orchestrator'}</small><button type="button" className="link-btn" disabled={!picked.length} onClick={() => setPicked([])}>Clear selection</button></div>
    </Popover>
  </div>;
}

export function TeamSessionView({ projectId, teamSession, structure }: {
  projectId: string; teamSession: TeamSessionRef; structure: TeamStructureSnapshot | null;
}) {
  const project = useMingle((state) => state.boot?.projects.find((item) => item.id === projectId));
  const sessions = useMingle((state) => state.boot?.sessions ?? EMPTY_SESSIONS);
  const connection = useMingle((state) => state.connection);
  const contextOpen = useMingle((state) => state.contextOpen);
  const teamStructure = useTeamStructure();
  const cachedSnapshot = getCachedTeamChatSnapshot(projectId, teamSession.groupId);
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof api.projectTeamChat>> | null>(() => cachedSnapshot?.snapshot ?? null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follows = useRef(true);
  const olderHeight = useRef<number | null>(null);
  const refreshSequence = useRef(0);
  const refreshInFlight = useRef<number | null>(null);
  const refreshAgain = useRef(false);
  const accountScope = useRef<{ projectId: string; accountId: string } | null>(cachedSnapshot?.accountScope ?? null);

  useEffect(() => {
    const scope = accountScope.current;
    if (snapshot && scope?.projectId === projectId) {
      cacheTeamChatSnapshot(projectId, teamSession.groupId, snapshot, scope.accountId);
    }
  }, [projectId, snapshot, teamSession.groupId]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    if (refreshInFlight.current !== null) { refreshAgain.current = true; return; }
    const requestId = ++refreshSequence.current;
    refreshInFlight.current = requestId;
    try {
      const [account, latestResult] = await Promise.all([
        api.account(signal),
        api.projectTeamChat(projectId, { limit: 100 }, signal)
          .then((value) => ({ value } as const), (cause: unknown) => ({ cause } as const)),
      ]);
      const accountId = account.status === 'signed-in' ? account.user?.id ?? null : null;
      if (signal?.aborted || useMingle.getState().activeProjectId !== projectId) return;
      const priorScope = accountScope.current;
      if (priorScope && (priorScope.projectId !== projectId || priorScope.accountId !== accountId)) {
        clearCachedTeamChatSnapshot(projectId, teamSession.groupId);
        setSnapshot(null);
      }
      if (!accountId) {
        accountScope.current = null;
        clearCachedTeamChatSnapshot(projectId, teamSession.groupId);
        setSnapshot(null);
        throw new Error('Sign in to the invited team account to view this shared conversation.');
      }
      const requestScope = priorScope?.projectId === projectId && priorScope.accountId === accountId
        ? priorScope : { projectId, accountId };
      accountScope.current = requestScope;
      if (signal?.aborted) return;
      const confirmedAccount = await api.account(signal);
      if (signal?.aborted) return;
      const confirmedAccountId = confirmedAccount.status === 'signed-in' ? confirmedAccount.user?.id ?? null : null;
      if (confirmedAccountId !== accountId || accountScope.current !== requestScope || useMingle.getState().activeProjectId !== projectId) {
        if (accountScope.current === requestScope && confirmedAccountId !== accountId) {
          accountScope.current = confirmedAccountId ? { projectId, accountId: confirmedAccountId } : null;
          clearCachedTeamChatSnapshot(projectId, teamSession.groupId);
          setSnapshot(null);
          throw new Error('The signed-in team account changed while this conversation was loading. Refresh to continue.');
        }
        return;
      }
      if ('cause' in latestResult) throw latestResult.cause;
      setSnapshot((current) => reconcileTeamChatSnapshot(current, latestResult.value));
      setError(null);
    } finally {
      if (refreshInFlight.current === requestId) {
        refreshInFlight.current = null;
        if (refreshAgain.current && !signal?.aborted) {
          refreshAgain.current = false;
          window.setTimeout(() => { void refresh(signal).catch(() => undefined); }, 0);
        }
      }
    }
  }, [projectId, teamSession.groupId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void refresh(controller.signal).catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    const unsubscribe = subscribeToTeamUpdates(projectId, () => {
      void refresh(controller.signal).catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    }, { kinds: ['chat'], debounceMs: 200 });
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(controller.signal).catch(() => undefined); }, 60_000);
    const visibility = () => { if (document.visibilityState === 'visible') void refresh(controller.signal).catch(() => undefined); };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      controller.abort();
      refreshAgain.current = false;
      refreshInFlight.current = null;
      unsubscribe(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility);
    };
  }, [refresh, teamSession.groupId]);

  const structureSnapshot = structure ?? teamStructure.snapshot;
  const snapshotMatchesProject = Boolean(structureSnapshot?.projectId === projectId && snapshot?.project.sharedProjectId === structureSnapshot.sharedProjectId);
  const activeSnapshot = snapshotMatchesProject ? snapshot : null;
  const messages = activeSnapshot?.messages ?? [];
  const agents = activeSnapshot?.agents ?? [];
  const members = structureSnapshot?.members ?? [];
  const groupView = activeSnapshot?.groupView?.group.id === teamSession.groupId ? activeSnapshot.groupView : null;
  const timeline = useMemo(() => mergeTeamSessionTimeline(messages, groupView), [messages, groupView]);
  const latestTimelineRow = timeline.at(-1);
  const latestTimelineContent = latestTimelineRow?.type === 'team-chat' ? latestTimelineRow.message.body : latestTimelineRow?.entry.content;
  const latestTimelineRunState = latestTimelineRow?.type === 'team-chat' ? latestTimelineRow.message.runState : undefined;
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    if (olderHeight.current !== null) { node.scrollTop += node.scrollHeight - olderHeight.current; olderHeight.current = null; }
    else if (follows.current) node.scrollTop = node.scrollHeight;
  }, [timeline.length, latestTimelineRow?.createdAt, latestTimelineContent, latestTimelineRunState, activeSnapshot?.groupView?.version]);

  const loadOlder = async () => {
    if (!activeSnapshot?.nextBefore || loadingOlder) return;
    const requestScope = accountScope.current;
    if (!requestScope || requestScope.projectId !== projectId || useMingle.getState().activeProjectId !== projectId) return;
    olderHeight.current = scroller.current?.scrollHeight ?? null;
    setLoadingOlder(true); setError(null);
    try {
      const older = await api.projectTeamChat(projectId, { limit: 100, before: activeSnapshot.nextBefore });
      const account = await api.account();
      const accountId = account.status === 'signed-in' ? account.user?.id ?? null : null;
      if (accountScope.current !== requestScope || accountId !== requestScope.accountId || useMingle.getState().activeProjectId !== projectId) {
        olderHeight.current = null;
        if (accountScope.current === requestScope && accountId !== requestScope.accountId) {
          accountScope.current = accountId ? { projectId, accountId } : null;
          clearCachedTeamChatSnapshot(projectId, teamSession.groupId);
          setSnapshot(null);
        }
        return;
      }
      setSnapshot((current) => current ? {
        ...current, messages: [...older.messages, ...current.messages.filter((message) => !older.messages.some((row) => row.id === message.id))],
        hasMore: older.hasMore, nextBefore: older.nextBefore,
      } : older);
    } catch (cause) { olderHeight.current = null; setError(errorMessage(cause)); }
    finally { setLoadingOlder(false); }
  };

  const teamStates = useMemo(() => Object.fromEntries(agents.flatMap((agent) => {
    const state = TeamAgentStateSchema.safeParse(agent.state);
    return state.success ? [[agent.id, state.data] as const] : [];
  })), [agents]);
  const empty = !loading && !timeline.length && !groupView?.result;
  if (!project) return <div className="chat chat--group"><div className="chat__empty"><h3>Team session unavailable</h3><p>This project is no longer available.</p></div></div>;

  return <div className="chat chat--group chat--team-session">
    <div className="group-body">
      <section className="group-body__conversation" aria-label="Team session conversation">
        <TeamConsentBanner projectId={projectId} />
        <div className="group-transcript">
          <div className="chat__scroll" ref={scroller} role="log" aria-live="polite" aria-label={`Team session: ${teamSession.title}`} onScroll={(event) => {
            const node = event.currentTarget;
            follows.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          }}>
            <div className="chat__inner">
              {activeSnapshot?.hasMore ? <button type="button" className="team-session__load-older" onClick={() => void loadOlder()} disabled={loadingOlder || connection !== 'online'}>{loadingOlder ? <Loader2 size={13} className="spin" /> : null}Load older messages</button> : null}
              {loading && !snapshot ? <div className="chat__empty" role="status"><Loader2 size={18} className="spin" /><p>Opening the shared session…</p></div> : null}
              {empty ? <div className="chat__empty"><h3>Start the team session</h3><p>Send a message to the orchestrator or mention a teammate’s agent.</p></div> : null}
              {groupView ? <>
                <section className="team-session__group-routing" aria-label="Shared group routing">
                  <strong>{MODE_NAME[groupView.routing.mode]}</strong>
                  <span>Unaddressed messages → {groupView.routing.defaultRecipientHandles.length ? groupView.routing.defaultRecipientHandles.map((handle) => `@${handle}`).join(', ') : 'no default agent reported'}</span>
                  {groupView.group.paused ? <span className="team-session__paused">Paused · messages may wait for the host to resume the group</span> : null}
                </section>
                {timeline.length ? <section className="team-session__group-feed" aria-label="Shared conversation timeline">
                  {timeline.map((row) => row.type === 'team-chat'
                    ? <TeamMessage key={`team:${row.message.id}`} message={row.message} teamSession={teamSession} agents={agents} members={members} />
                    : <SharedGroupEntry key={`group:${row.entry.id}`} entry={row.entry} view={groupView} members={members} agents={agents} />)}
                </section> : null}
                {groupView.result ? <SharedGroupResult result={groupView.result} /> : null}
              </> : messages.map((message) => <TeamMessage key={message.id} message={message} teamSession={teamSession} agents={agents} members={members} />)}
              {error && !activeSnapshot ? <div className="chat__error" role="alert"><strong>Team session unavailable</strong><span>{error}</span><button type="button" className="link-btn" onClick={() => { setLoading(true); void refresh().catch((cause) => setError(errorMessage(cause))).finally(() => setLoading(false)); }}>Retry</button></div> : null}
            </div>
          </div>
        </div>
        {error && activeSnapshot ? <div className="chat__error team-session__error" role="alert"><span>{error}</span><button type="button" className="link-btn" onClick={() => void refresh().catch((cause) => setError(errorMessage(cause)))}>Retry</button></div> : null}
        <TeamSessionComposer projectId={projectId} sessionId={teamSession.sessionId} agents={agents} structure={structureSnapshot} groupView={groupView}
          onMessage={(sent) => setSnapshot((current) => current ? {
            ...current,
            messages: current.messages.some((message) => message.id === sent.id) ? current.messages : [...current.messages, sent].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(-200),
          } : current)}
          onSent={async () => { await refresh(); }} />
        <div className="composer-wrap"><GitBar project={project} session={null} /></div>
      </section>
      <AgentPresenceRail snapshot={null} members={[]} sessions={sessions} runs={[]} approvals={[]} connection={connection} providers={[]} hidden={contextOpen} teamMembers={members} teamStates={teamStates} projectId={projectId} expandAtWidth={600} />
    </div>
  </div>;
}
