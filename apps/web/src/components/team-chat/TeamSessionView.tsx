import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, AtSign, Loader2, X } from 'lucide-react';
import { TeamAgentStateSchema, type Session, type TeamChatAgent, type TeamChatMessage, type TeamSessionRef, type TeamStructureMember, type TeamStructureSnapshot } from '@mingle/contracts';
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
import './team-session.css';

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

function TeamMessage({ message, teamSession, agents, members }: {
  message: TeamChatMessage; teamSession: TeamSessionRef; agents: readonly TeamChatAgent[]; members: readonly TeamStructureMember[];
}) {
  const memberById = new Map(members.map((member) => [member.agentId, member]));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const toLabel = (agentId: string) => {
    const agent = agentById.get(agentId);
    const member = memberById.get(agentId);
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
  const structureMember = memberById.get(author.agentId);
  const agent = agentById.get(author.agentId);
  const role: Speaker['role'] = structureMember?.role === 'orchestrator' ? 'orchestrator' : structureMember?.role === 'idle' ? 'peer' : 'worker';
  const speaker: Speaker = {
    memberId: author.agentId, sessionId: structureMember?.sessionId ?? teamSession.sessionId,
    handle: canonicalHandle(agent ?? { id: author.agentId, name: author.agentName, accountId: author.ownerAccountId, deviceId: '', projectId: '', sessionId: '', provider: author.provider, model: author.model, state: 'idle', local: false }, structureMember),
    role, removed: false,
  };
  const display = { id: message.id, sessionId: teamSession.sessionId, role: 'assistant' as const, content: message.body, createdAt: message.createdAt, live: false };
  return <div className="team-session__agent-message" data-message-id={message.id}>
    <MessageRow m={display} provider={author.provider} speaker={speaker} />
    {message.runState ? <div className={cx('team-session__message-state', message.runState === 'failed' && 'is-failed')}>{RUN_STATE_LABEL[message.runState]}</div> : null}
  </div>;
}

function TeamSessionComposer({ projectId, sessionId, agents, structure, onMessage, onSent }: {
  projectId: string; sessionId: string; agents: readonly TeamChatAgent[]; structure: TeamStructureSnapshot | null;
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
  const suggestions = useMemo(() => agents.map((agent) => ({
    agent, member: structure?.members.find((candidate) => candidate.agentId === agent.id),
  })), [agents, structure?.members]);
  const orchestratorId = structure?.settings?.orchestratorAgentId ?? structure?.members.find((member) => member.role === 'orchestrator')?.agentId;
  const orchestrator = suggestions.find((candidate) => candidate.agent.id === orchestratorId) ?? suggestions[0];
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
  const recipientIds = mentionedIds.length ? mentionedIds : orchestrator ? [orchestrator.agent.id] : [];

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
        }) : orchestrator ? <span className="recips__chip is-default"><AgentIdentity handle={canonicalHandle(orchestrator.agent, orchestrator.member)} identityKey={orchestrator.agent.id} provider={orchestrator.agent.provider} /></span> : null}
        {!mentionedIds.length ? <span className="recips__default">default: orchestrator</span> : null}
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
    {error ? <p className="composer__note is-error" role="alert">{error}</p> : connection !== 'online' ? <p className="composer__note" role="status">Reconnect to Mingle to send to the team session.</p> : null}
    <Popover anchor={pickerButton} open={pickerOpen} onClose={() => setPickerOpen(false)} label="Choose recipients" width={300} align="start" className="recips-pop">
      <fieldset className="recips-pop__list"><legend>Send to these agents</legend>
        {suggestions.map(({ agent, member }) => <label key={agent.id} className="check">
          <input type="checkbox" checked={picked.includes(agent.id)} onChange={() => setPicked((current) => current.includes(agent.id) ? current.filter((id) => id !== agent.id) : [...current, agent.id])} />
          <span><AgentIdentity handle={canonicalHandle(agent, member)} identityKey={agent.id} provider={agent.provider} /><small>{member?.role ?? (agent.local ? 'On this device' : 'Teammate')} · {agent.provider} · {agent.state}</small></span>
        </label>)}
      </fieldset>
      <div className="recips-pop__foot"><small>{picked.length ? `${picked.length} selected` : 'Nothing selected: default: orchestrator'}</small><button type="button" className="link-btn" disabled={!picked.length} onClick={() => setPicked([])}>Clear selection</button></div>
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
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof api.projectTeamChat>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follows = useRef(true);
  const olderHeight = useRef<number | null>(null);
  const refreshInFlight = useRef(false);
  const refreshAgain = useRef(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    if (refreshInFlight.current) { refreshAgain.current = true; return; }
    refreshInFlight.current = true;
    try {
      const latest = await api.projectTeamChat(projectId, { limit: 100 }, signal);
      if (signal?.aborted) return;
      setSnapshot((current) => {
        if (!current || current.project.sharedProjectId !== latest.project.sharedProjectId) return latest;
        const rows = new Map(latest.messages.map((message) => [message.id, message]));
        for (const message of current.messages) if (!rows.has(message.id)) rows.set(message.id, message);
        const messages = [...rows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(-200);
        return { ...latest, messages, hasMore: current.hasMore || latest.hasMore, nextBefore: latest.nextBefore ?? current.nextBefore };
      });
      setError(null);
    } finally {
      refreshInFlight.current = false;
      if (refreshAgain.current && !signal?.aborted) {
        refreshAgain.current = false;
        window.setTimeout(() => { void refresh(signal).catch(() => undefined); }, 0);
      }
    }
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null); setLoading(true); setError(null);
    void refresh(controller.signal).catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    const unsubscribe = subscribeToTeamUpdates(projectId, () => {
      void refresh(controller.signal).catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    });
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(controller.signal).catch(() => undefined); }, 60_000);
    const visibility = () => { if (document.visibilityState === 'visible') void refresh(controller.signal).catch(() => undefined); };
    document.addEventListener('visibilitychange', visibility);
    return () => { controller.abort(); unsubscribe(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [refresh]);

  const messages = snapshot?.messages ?? [];
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    if (olderHeight.current !== null) { node.scrollTop += node.scrollHeight - olderHeight.current; olderHeight.current = null; }
    else if (follows.current) node.scrollTop = node.scrollHeight;
  }, [messages.length, messages.at(-1)?.body, messages.at(-1)?.runState]);

  const loadOlder = async () => {
    if (!snapshot?.nextBefore || loadingOlder) return;
    olderHeight.current = scroller.current?.scrollHeight ?? null;
    setLoadingOlder(true); setError(null);
    try {
      const older = await api.projectTeamChat(projectId, { limit: 100, before: snapshot.nextBefore });
      setSnapshot((current) => current ? {
        ...current, messages: [...older.messages, ...current.messages.filter((message) => !older.messages.some((row) => row.id === message.id))],
        hasMore: older.hasMore, nextBefore: older.nextBefore,
      } : older);
    } catch (cause) { olderHeight.current = null; setError(errorMessage(cause)); }
    finally { setLoadingOlder(false); }
  };

  const agents = snapshot?.agents ?? [];
  const structureSnapshot = structure ?? teamStructure.snapshot;
  const members = structureSnapshot?.members ?? [];
  const teamStates = useMemo(() => Object.fromEntries(agents.flatMap((agent) => {
    const state = TeamAgentStateSchema.safeParse(agent.state);
    return state.success ? [[agent.id, state.data] as const] : [];
  })), [agents]);
  const empty = !loading && !messages.length;
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
              {snapshot?.hasMore ? <button type="button" className="team-session__load-older" onClick={() => void loadOlder()} disabled={loadingOlder || connection !== 'online'}>{loadingOlder ? <Loader2 size={13} className="spin" /> : null}Load older messages</button> : null}
              {loading && !snapshot ? <div className="chat__empty" role="status"><Loader2 size={18} className="spin" /><p>Opening the shared session…</p></div> : null}
              {empty ? <div className="chat__empty"><h3>Start the team session</h3><p>Send a message to the orchestrator or mention a teammate’s agent.</p></div> : null}
              {messages.map((message) => <TeamMessage key={message.id} message={message} teamSession={teamSession} agents={agents} members={members} />)}
              {error && !snapshot ? <div className="chat__error" role="alert"><strong>Team session unavailable</strong><span>{error}</span><button type="button" className="link-btn" onClick={() => { setLoading(true); void refresh().catch((cause) => setError(errorMessage(cause))).finally(() => setLoading(false)); }}>Retry</button></div> : null}
            </div>
          </div>
        </div>
        {error && snapshot ? <div className="chat__error team-session__error" role="alert"><span>{error}</span><button type="button" className="link-btn" onClick={() => void refresh().catch((cause) => setError(errorMessage(cause)))}>Retry</button></div> : null}
        <TeamSessionComposer projectId={projectId} sessionId={teamSession.sessionId} agents={agents} structure={structureSnapshot}
          onMessage={(sent) => setSnapshot((current) => current ? {
            ...current,
            messages: current.messages.some((message) => message.id === sent.id) ? current.messages : [...current.messages, sent].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(-200),
          } : current)}
          onSent={async () => { await refresh(); }} />
        <div className="composer-wrap"><GitBar project={project} session={null} /></div>
      </section>
      <AgentPresenceRail snapshot={null} members={[]} sessions={sessions} runs={[]} approvals={[]} connection={connection} providers={[]} hidden={contextOpen} teamMembers={members} teamStates={teamStates} projectId={projectId} />
    </div>
  </div>;
}
