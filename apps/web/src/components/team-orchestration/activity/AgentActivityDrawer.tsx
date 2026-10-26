import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronUp, CircleHelp, Clock3, FileCode2, Laptop, Loader2, ShieldAlert, X } from 'lucide-react';
import type { Provider, Session, SessionPlan, SessionRun, TeamAgentActivity, TeamAgentActivityEntry, TeamAgentState, ToolCall, UserQuestion } from '@mingle/contracts';
import { useMingle } from '../../../store/store';
import { errorMessage } from '../../../lib/api';
import type { DisplayMessage } from '../../../lib/conversation';
import { teamActivityApi } from './api';
import { AgentIdentity } from '../../group/AgentIdentity';
import { ApprovalCard, InternalDeliveryDisclosure, LegacyToolGroup, MessageRow, SessionPlanCard, UserQuestionCard } from '../../ConversationParts';
import { Markdown } from '../../Markdown';
import { RunActivity } from '../../RunActivity';
import { RunChanges } from '../../RunChanges';
import { ProviderMark } from '../../ui';
import './activity.css';

export interface ActivityAgent {
  agentId: string;
  handle: string;
  name: string;
  provider: Provider | null;
  model: string;
  local: boolean;
  ownerDisplayName: string;
  deviceName: string;
  role?: 'orchestrator' | 'worker' | 'idle';
  state: TeamAgentState;
  currentTask: string | null;
  sessionId?: string | null;
  failureMessage?: string | null;
}

const STATE_LABEL: Record<TeamAgentState, string> = {
  idle: 'Idle', queued: 'Queued', working: 'Working', 'awaiting-approval': 'Awaiting approval',
  'quota-exhausted': 'Quota exhausted', offline: 'Offline', paused: 'Paused', failed: 'Failed',
};
const EMPTY_MESSAGES: DisplayMessage[] = [];
const EMPTY_RUNS: SessionRun[] = [];
const EMPTY_TOOLS: ToolCall[] = [];
const EMPTY_PLANS: SessionPlan[] = [];
const EMPTY_QUESTIONS: UserQuestion[] = [];

function timeLabel(at: string): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : 'Time unavailable';
}

function revisionText(text: string): string {
  return text.replace(/\b([0-9a-f]{40,64})\b/gi, (revision) => `${revision.slice(0, 7)}…`);
}

function ageLabel(at: string, now: number): string {
  const date = Date.parse(at);
  if (!Number.isFinite(date)) return 'Last update time unavailable';
  const seconds = Math.max(0, Math.floor((now - date) / 1000));
  if (seconds < 5) return 'Last updated just now';
  if (seconds < 60) return `Last updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Last updated ${minutes}m ago`;
  return `Last updated ${Math.floor(minutes / 60)}h ago`;
}

function ActivityEntry({ entry }: { entry: TeamAgentActivityEntry }) {
  const className = `agent-activity__entry is-${entry.kind}`;
  if (entry.kind === 'request' || entry.kind === 'assistant') {
    return <article className={className} aria-label={entry.kind === 'request' ? 'Request received' : 'Assistant response'}>
      <header><strong>{entry.kind === 'request' ? 'Request' : 'Assistant'}</strong><time dateTime={entry.at} title={timeLabel(entry.at)}>{timeLabel(entry.at)}</time></header>
      <div className="agent-activity__markdown"><Markdown text={entry.text || '…'} /></div>
    </article>;
  }
  const Icon = entry.kind === 'tool' ? Laptop : entry.kind === 'approval' ? ShieldAlert : entry.kind === 'artifact' ? FileCode2 : entry.kind === 'error' ? AlertTriangle : entry.kind === 'status' ? Clock3 : CircleHelp;
  const label = entry.kind === 'tool' ? 'Tool' : entry.kind === 'approval' ? 'Approval' : entry.kind === 'artifact' ? 'Artifact' : entry.kind === 'error' ? 'Error' : 'Status';
  const detail = revisionText(entry.text);
  return <article className={className} aria-label={`${label}${entry.toolName ? `: ${entry.toolName}` : ''}`}>
    <Icon size={14} aria-hidden="true" />
    <div className="agent-activity__entry-main">
      <header><strong>{entry.kind === 'tool' ? entry.toolName || label : label}</strong>{entry.status ? <span className="agent-activity__entry-status">{entry.status}</span> : null}<time dateTime={entry.at} title={timeLabel(entry.at)}>{timeLabel(entry.at)}</time></header>
      <p>{detail}</p>
    </div>
  </article>;
}

function useLocalConversation(session: Session | undefined) {
  const boot = useMingle((state) => state.boot);
  const streams = useMingle((state) => state.streams);
  const messages = useMemo(() => {
    if (!session || !boot) return EMPTY_MESSAGES;
    const rows = boot.messages.filter((message) => message.sessionId === session.id).map((message): DisplayMessage => {
      const stream = streams[message.id];
      const streamed = stream ? stream.base + stream.text : '';
      return {
        id: message.id, sessionId: message.sessionId, role: message.role,
        content: streamed.length > message.content.length ? streamed : message.content,
        createdAt: message.createdAt, kind: message.kind, runId: message.runId,
        live: (Boolean(stream) || message.kind === 'streaming') && session.status === 'running',
        attachments: message.attachments, contextRefs: message.contextRefs,
      };
    });
    const present = new Set(rows.map((message) => message.id));
    for (const [id, stream] of Object.entries(streams)) {
      if (stream.sessionId === session.id && !present.has(id)) rows.push({ id, sessionId: session.id, role: 'assistant', content: stream.base + stream.text, createdAt: '', live: session.status === 'running' });
    }
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }, [boot, session, streams]);
  const runs = useMemo(() => boot?.runs.filter((run) => run.sessionId === session?.id) ?? EMPTY_RUNS, [boot?.runs, session?.id]);
  const tools = useMemo(() => boot?.toolCalls.filter((call) => call.sessionId === session?.id) ?? EMPTY_TOOLS, [boot?.toolCalls, session?.id]);
  const approvals = useMemo(() => boot?.approvals.filter((approval) => approval.sessionId === session?.id) ?? [], [boot?.approvals, session?.id]);
  const plans = useMemo(() => {
    const rows = boot?.plans.filter((plan) => plan.sessionId === session?.id) ?? EMPTY_PLANS;
    const completed = rows.filter((plan) => plan.status === 'completed').at(-1);
    return [...rows.filter((plan) => plan.status !== 'completed'), ...(completed ? [completed] : [])];
  }, [boot?.plans, session?.id]);
  const questions = useMemo(() => {
    const rows = boot?.questions.filter((question) => question.sessionId === session?.id) ?? EMPTY_QUESTIONS;
    return [...rows.filter((question) => question.status !== 'pending').slice(-2), ...rows.filter((question) => question.status === 'pending')];
  }, [boot?.questions, session?.id]);
  return { messages, runs, tools, approvals, plans, questions };
}

function LocalConversation({ session }: { session: Session | undefined }) {
  const { messages, runs, tools, approvals, plans, questions } = useLocalConversation(session);
  const scroller = useRef<HTMLDivElement>(null);
  const follows = useRef(true);
  const olderHeight = useRef<number | null>(null);
  const byRun = useMemo(() => {
    const map = new Map<string, ToolCall[]>();
    for (const tool of tools) map.set(tool.runId, [...(map.get(tool.runId) ?? []), tool]);
    return map;
  }, [tools]);
  const runByMessage = useMemo(() => {
    const map = new Map<string, SessionRun[]>();
    for (const run of runs) map.set(run.userMessageId, [...(map.get(run.userMessageId) ?? []), run]);
    return map;
  }, [runs]);
  const messageIds = useMemo(() => new Set(messages.map((message) => message.id)), [messages]);
  const unplaced = runs.filter((run) => !messageIds.has(run.userMessageId)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    if (olderHeight.current !== null) {
      node.scrollTop += node.scrollHeight - olderHeight.current;
      olderHeight.current = null;
    } else if (follows.current) node.scrollTop = node.scrollHeight;
  }, [messages.length, messages.at(-1)?.content, runs.length, approvals.length, plans.length, questions.length]);

  if (!session) return <div className="agent-activity__empty"><strong>Local session unavailable</strong><span>The agent’s session details are not present on this device.</span></div>;
  const visible = messages.some((message) => message.role === 'user' || message.role === 'assistant') || runs.length > 0;
  return <div className="agent-activity__local-log" ref={scroller} role="log" aria-live="polite" aria-label={`Conversation with ${session.name}`} onScroll={(event) => {
    const node = event.currentTarget;
    follows.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  }}>
    {!visible ? <div className="agent-activity__empty"><strong>No conversation yet</strong><span>This local session has no recorded messages.</span></div> : null}
    {messages.map((message, index) => {
      if (message.role === 'tool') {
        if (messages[index - 1]?.role === 'tool') return null;
        const batch: DisplayMessage[] = [message];
        for (let next = index + 1; next < messages.length && messages[next]?.role === 'tool'; next++) batch.push(messages[next]!);
        return <LegacyToolGroup key={message.id} messages={batch} />;
      }
      if (message.role === 'user' && (message.kind === 'group-delivery' || message.kind === 'team-delivery')) return <Fragment key={message.id}>
        <InternalDeliveryDisclosure message={message} />
        {(runByMessage.get(message.id) ?? []).map((run) => <RunActivity key={run.id} run={run} initialCalls={byRun.get(run.id) ?? EMPTY_TOOLS} />)}
      </Fragment>;
      return <Fragment key={message.id}>
        <MessageRow m={message} provider={session.provider} />
        {message.role === 'user' ? (runByMessage.get(message.id) ?? []).map((run) => <RunActivity key={run.id} run={run} initialCalls={byRun.get(run.id) ?? EMPTY_TOOLS} />) : null}
        {message.role === 'assistant' ? runs.filter((run) => run.id === message.runId && run.status !== 'running').map((run) => <RunChanges key={`changes-${run.id}`} runId={run.id} summary={run.changes} />) : null}
      </Fragment>;
    })}
    {unplaced.map((run) => <Fragment key={run.id}><RunActivity run={run} initialCalls={byRun.get(run.id) ?? EMPTY_TOOLS} />{run.status !== 'running' ? <RunChanges runId={run.id} summary={run.changes} /> : null}</Fragment>)}
    {session.status === 'running' && !runs.some((run) => run.status === 'running') ? <div className="working" role="status"><span className="activity-shimmer">{session.provider} is working…</span></div> : null}
    {session.status === 'error' && session.error ? <div className="chat__error" role="alert"><strong>Session error</strong><span>{session.error}</span></div> : null}
    {approvals.filter((approval) => approval.status === 'pending').map((approval) => <ApprovalCard key={approval.id} approval={approval} provider={session.provider} />)}
    {plans.map((plan) => <SessionPlanCard key={plan.id} plan={plan} reviewReady={runs.some((run) => run.id === plan.runId && run.status === 'completed')} />)}
    {questions.map((question) => <UserQuestionCard key={question.id} question={question} />)}
  </div>;
}

export function AgentActivityDrawer({ projectId, agent, onClose }: { projectId: string; agent: ActivityAgent; onClose: () => void }) {
  const connection = useMingle((state) => state.connection);
  const session = useMingle((state) => agent.local && agent.sessionId ? state.boot?.sessions.find((item) => item.id === agent.sessionId) : undefined);
  const [activity, setActivity] = useState<TeamAgentActivity | null>(null);
  const [loading, setLoading] = useState(!agent.local);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follows = useRef(true);
  const olderHeight = useRef<number | null>(null);
  const activityState = activity?.state ?? agent.state;
  const live = activityState === 'working' || activityState === 'queued' || activityState === 'awaiting-approval';
  const local = agent.local && Boolean(agent.sessionId);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (local) return;
    if (connection !== 'online') { setLoading(false); return; }
    try {
      const latest = await teamActivityApi.activity(projectId, agent.agentId, undefined, signal);
      setActivity((current) => {
        if (!current || current.agentId !== latest.agentId) return latest;
        const incoming = new Map(current.entries.map((entry) => [entry.id, entry]));
        for (const entry of latest.entries) incoming.set(entry.id, entry);
        const entries = [...incoming.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(-500);
        return { ...latest, entries, nextCursor: latest.nextCursor ?? current.nextCursor };
      });
      setError(null);
    } catch (cause) {
      if (!signal?.aborted) setError(errorMessage(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [agent.agentId, connection, local, projectId]);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.requestAnimationFrame(() => closeButton.current?.focus({ preventScroll: true }));
    return () => {
      document.body.style.overflow = oldOverflow;
      const previous = previousFocus.current;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      else document.getElementById('main')?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (local) return;
    const controller = new AbortController();
    setActivity(null); setLoading(true); setError(null);
    void refresh(controller.signal);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(controller.signal);
    }, live ? 2_500 : 12_000);
    const stateChange = () => { if (document.visibilityState === 'visible') void refresh(controller.signal); };
    const visibility = () => { if (document.visibilityState === 'visible') void refresh(controller.signal); };
    window.addEventListener('mingle:state-changed', stateChange);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      controller.abort(); window.clearInterval(interval);
      window.removeEventListener('mingle:state-changed', stateChange);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [agent.agentId, live, local, projectId, refresh]);

  useEffect(() => {
    if (!agent.local && activity?.mirroredAt) {
      const timer = window.setInterval(() => setNow(Date.now()), 1000);
      return () => window.clearInterval(timer);
    }
    return;
  }, [activity?.mirroredAt, agent.local]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    if (olderHeight.current !== null) {
      node.scrollTop += node.scrollHeight - olderHeight.current;
      olderHeight.current = null;
    } else if (follows.current) node.scrollTop = node.scrollHeight;
  }, [activity?.entries.length, activity?.entries.at(-1)?.text, activity?.state, local, session?.id]);

  const loadEarlier = async () => {
    if (!activity?.nextCursor || loadingOlder || connection !== 'online') return;
    const node = scroller.current;
    olderHeight.current = node?.scrollHeight ?? null;
    setLoadingOlder(true); setError(null);
    try {
      const older = await teamActivityApi.activity(projectId, agent.agentId, activity.nextCursor);
      setActivity((current) => {
        if (!current) return older;
        const entries = new Map(current.entries.map((entry) => [entry.id, entry]));
        for (const entry of older.entries) entries.set(entry.id, entry);
        return { ...current, ...older, entries: [...entries.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(-500) };
      });
    } catch (cause) {
      olderHeight.current = null;
      setError(errorMessage(cause));
    } finally { setLoadingOlder(false); }
  };

  const currentState: TeamAgentState = connection !== 'online' ? 'offline' : local && session?.status === 'running' ? 'working'
    : local && session?.status === 'waiting' ? 'awaiting-approval' : local && session?.status === 'error' ? agent.state === 'quota-exhausted' ? 'quota-exhausted' : 'failed'
      : activity?.state ?? agent.state;
  const task = agent.currentTask;
  const entries = activity?.entries ?? [];
  const headingId = `agent-activity-title-${agent.agentId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const deviceLabel = agent.local ? 'This device' : `On ${agent.ownerDisplayName}’s ${agent.deviceName}`;

  const content = <div className="agent-activity__veil" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} className="agent-activity" role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])') ?? []).filter((item) => item.offsetParent !== null);
        if (!focusable.length) { event.preventDefault(); panel.current?.focus(); return; }
        const first = focusable[0]!; const last = focusable.at(-1)!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <header className="agent-activity__head">
        {agent.provider ? <ProviderMark provider={agent.provider} size={20} /> : null}
        <div className="agent-activity__title">
          <h2 id={headingId}><AgentIdentity handle={agent.handle} identityKey={agent.sessionId ?? agent.agentId} provider={agent.provider} /></h2>
          <span>{agent.model || 'Model not reported'} · {deviceLabel}</span>
        </div>
        <span className={`agent-activity__state is-${currentState}`} role="status"><i aria-hidden="true" />{STATE_LABEL[currentState]}</span>
        <button ref={closeButton} type="button" className="agent-activity__close" onClick={onClose} aria-label="Close agent conversation"><X size={17} /></button>
      </header>
      {task ? <div className="agent-activity__task"><strong>Current task</strong><span>{task}</span></div> : null}
      {!agent.local && activity?.mirroredAt ? <div className="agent-activity__mirrored"><Clock3 size={12} aria-hidden="true" />{ageLabel(activity.mirroredAt, now)}</div> : null}
      {connection !== 'online' ? <div className="agent-activity__notice is-offline" role="status">Offline · showing the last conversation data available on this device.</div> : null}
      {!agent.local && error ? <div className="agent-activity__notice is-error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>Retry</button></div> : null}
      {agent.failureMessage && currentState === 'failed' ? <div className="agent-activity__notice is-error" role="alert">{agent.failureMessage}</div> : null}
      {local ? <LocalConversation session={session} /> : <div className="agent-activity__timeline" ref={scroller} role="log" aria-live="polite" aria-label={`Conversation with @${agent.handle}`} onScroll={(event) => {
        const node = event.currentTarget;
        follows.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      }}>
        {activity?.nextCursor ? <button type="button" className="agent-activity__load" disabled={loadingOlder || connection !== 'online'} onClick={() => void loadEarlier()}>
          {loadingOlder ? <Loader2 size={13} className="spin" /> : <ChevronUp size={13} />} Load earlier activity
        </button> : null}
        {loading && !activity ? <div className="agent-activity__empty"><Loader2 size={18} className="spin" /><span>Loading the agent’s conversation…</span></div> : null}
        {!loading && !activity && error ? <div className="agent-activity__empty"><strong>Activity unavailable</strong><span>The server could not load this agent’s conversation.</span><button type="button" onClick={() => { setLoading(true); void refresh(); }}>Retry</button></div> : null}
        {!loading && !activity && !error && connection !== 'online' ? <div className="agent-activity__empty"><strong>Conversation unavailable offline</strong><span>No activity has been cached for this agent in this window.</span></div> : null}
        {activity && !entries.length ? <div className="agent-activity__empty"><strong>No mirrored activity yet</strong><span>Requests and updates will appear here when this agent reports them.</span></div> : null}
        {entries.map((entry) => <ActivityEntry key={entry.id} entry={entry} />)}
      </div>}
    </section>
  </div>;

  return createPortal(content, document.body);
}
