import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, AtSign, Loader2, MessageCircle, RefreshCw, X } from 'lucide-react';
import type { TeamChatAgent, TeamChatMessage, TeamChatSnapshot } from '@mingle/contracts';
import { useMingle } from '../../store/store';
import { api, errorMessage } from '../../lib/api';
import { ProviderMark } from '../ui';
import { TeamConsentBanner } from '../team-orchestration/settings/TeamConsentBanner';
import { TeamPresenceBubble } from '../team-orchestration/activity/TeamPresenceBubble';
import './team-chat.css';

const clock = (value: string): string => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date) : '';
};
const labelFor = (message: TeamChatMessage): string => message.author.kind === 'human' ? message.author.displayName : message.author.agentName;

function DeliveryLabel({ message }: { message: TeamChatMessage }) {
  if (message.deliveryState === 'sending') return <span className="team-chat__state is-pending">Sending</span>;
  if (message.deliveryState === 'failed') return <span className="team-chat__state is-failed" title="This message is saved on this device; mailbox delivery failed.">Delivery failed</span>;
  if (message.runState === 'running') return <span className="team-chat__state is-running">Agent working</span>;
  if (message.runState === 'awaiting-approval') return <span className="team-chat__state is-pending">Waiting for owner approval</span>;
  if (message.runState === 'failed') return <span className="team-chat__state is-failed">Agent turn not started</span>;
  if (message.runState === 'interrupted') return <span className="team-chat__state is-failed">Interrupted</span>;
  if (message.runState === 'completed') return <span className="team-chat__state is-done">Turn complete</span>;
  return <span className="team-chat__state">Outbox queued</span>;
}

function MessageCard({ message }: { message: TeamChatMessage }) {
  const isAgent = message.author.kind === 'agent';
  const initials = labelFor(message).split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  return <article className={`team-chat__message${isAgent ? ' is-agent' : ' is-human'}`} aria-label={`${isAgent ? 'Agent' : 'Teammate'} message from ${labelFor(message)}`}>
    <div className="team-chat__avatar" aria-hidden="true">
      {isAgent ? <ProviderMark provider={message.author.kind === 'agent' ? message.author.provider : 'codex'} size={17} /> : initials || 'T'}
    </div>
    <div className="team-chat__message-main">
      <header className="team-chat__message-head">
        <strong>{labelFor(message)}</strong>
        {isAgent ? <span className="team-chat__agent-model">{message.author.kind === 'agent' ? message.author.model : ''}</span> : null}
        <time dateTime={message.createdAt}>{clock(message.createdAt)}</time>
      </header>
      <div className="team-chat__bubble">{message.body}</div>
      <footer className="team-chat__message-foot"><DeliveryLabel message={message} />{message.replyTo ? <span>Reply to team chat</span> : null}</footer>
    </div>
  </article>;
}

function triggerAt(value: string, caret: number): { start: number; end: number; query: string } | null {
  const prefix = value.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(prefix);
  if (!match) return null;
  return { start: match.index + match[0].lastIndexOf('@'), end: caret, query: match[1] ?? '' };
}

export function TeamChatPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const connection = useMingle((state) => state.connection);
  const sessions = useMingle((state) => state.boot?.sessions ?? []);
  const [snapshot, setSnapshot] = useState<TeamChatSnapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [mentionTrigger, setMentionTrigger] = useState<{ start: number; end: number; query: string } | null>(null);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importSessionId, setImportSessionId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const wasAtBottom = useRef(true);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const latest = await api.projectTeamChat(projectId, { limit: 100 }, signal);
    setSnapshot((current) => {
      if (!current || current.project.sharedProjectId !== latest.project.sharedProjectId) return latest;
      const incoming = new Map(latest.messages.map((message) => [message.id, message]));
      for (const message of current.messages) if (!incoming.has(message.id)) incoming.set(message.id, message);
      const messages = [...incoming.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(-200);
      return { ...latest, messages, hasMore: current.hasMore || latest.hasMore, nextBefore: latest.nextBefore ?? current.nextBefore };
    });
    setError(null);
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null); setLoading(true); setError(null);
    void refresh(controller.signal).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(controller.signal).catch(() => undefined); }, 15_000);
    let stateTimer: number | undefined;
    const onStateChange = () => {
      window.clearTimeout(stateTimer);
      stateTimer = window.setTimeout(() => { if (document.visibilityState === 'visible') void refresh(controller.signal).catch(() => undefined); }, 250);
    };
    window.addEventListener('mingle:state-changed', onStateChange);
    return () => { controller.abort(); window.clearInterval(timer); window.clearTimeout(stateTimer); window.removeEventListener('mingle:state-changed', onStateChange); };
  }, [refresh]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.requestAnimationFrame(() => composer.current?.focus());
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = oldOverflow; };
  }, [onClose]);

  const visibleAgents = snapshot?.agents ?? [];
  const suggestions = useMemo(() => {
    if (!mentionTrigger) return [];
    const query = mentionTrigger.query.toLocaleLowerCase();
    return visibleAgents.filter((agent) => agent.name.toLocaleLowerCase().includes(query)).slice(0, 8);
  }, [mentionTrigger, visibleAgents]);
  const projectSessions = sessions.filter((session) => session.projectId === projectId);
  const messages = snapshot?.messages ?? [];

  useEffect(() => {
    if (wasAtBottom.current) {
      const node = scroller.current;
      if (node) node.scrollTop = node.scrollHeight;
    }
  }, [messages.length, messages.at(-1)?.body, messages.at(-1)?.runState]);

  const close = () => { onClose(); };
  const updateDraft = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.currentTarget.value;
    setDraft(value);
    setMentionTrigger(triggerAt(value, event.currentTarget.selectionStart));
    setActiveSuggestion(0);
  };
  const selectMention = (agent: TeamChatAgent) => {
    const trigger = mentionTrigger;
    if (!trigger) return;
    const value = `${draft.slice(0, trigger.start)}@${agent.name} ${draft.slice(trigger.end)}`;
    setDraft(value);
    setMentionIds((current) => current.includes(agent.id) ? current : [...current, agent.id]);
    setMentionTrigger(null);
    setActiveSuggestion(0);
    requestAnimationFrame(() => {
      if (!composer.current) return;
      const caret = trigger.start + agent.name.length + 2;
      composer.current.focus(); composer.current.setSelectionRange(caret, caret);
    });
  };
  const send = async () => {
    const body = draft.trim();
    if (!body || sending || connection !== 'online') return;
    setSending(true); setError(null);
    try {
      await api.sendTeamChatMessage(projectId, { body, mentions: mentionIds });
      setDraft(''); setMentionIds([]); setMentionTrigger(null);
      await refresh();
      composer.current?.focus();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setSending(false); }
  };
  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length && mentionTrigger) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setActiveSuggestion((activeSuggestion + 1) % suggestions.length); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActiveSuggestion((activeSuggestion + suggestions.length - 1) % suggestions.length); return; }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); selectMention(suggestions[activeSuggestion]!); return; }
      if (event.key === 'Escape') { setMentionTrigger(null); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
  };
  const loadOlder = async () => {
    if (!snapshot?.nextBefore || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await api.projectTeamChat(projectId, { limit: 100, before: snapshot.nextBefore });
      setSnapshot((current) => current ? {
        ...current, messages: [...older.messages, ...current.messages.filter((message) => !older.messages.some((old) => old.id === message.id))],
        hasMore: older.hasMore, nextBefore: older.nextBefore,
      } : older);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setLoadingOlder(false); }
  };
  const importHistory = async () => {
    if (!importSessionId || importing || connection !== 'online') return;
    setImporting(true); setError(null);
    try {
      const result = await api.importTeamChatHistory(projectId, importSessionId);
      await refresh();
      useMingle.getState().toast('success', result.imported ? `Shared ${result.imported} session messages to team chat.` : 'This session history was already shared.');
      if (result.truncated) useMingle.getState().toast('info', 'Only the latest 200 durable user and assistant messages were shared.');
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setImporting(false); }
  };

  const dialog = <div className="team-chat__veil">
    <section className="team-chat" role="dialog" aria-modal="true" aria-labelledby="team-chat-title">
      <TeamConsentBanner projectId={projectId} />
      <TeamPresenceBubble projectId={projectId} />
      <header className="team-chat__topbar">
        <div className="team-chat__title-icon"><MessageCircle size={18} /></div>
        <div className="team-chat__title-copy"><h1 id="team-chat-title">Team chat</h1><span>{snapshot?.project.name ?? 'Shared project'} · {snapshot?.members.length ?? '—'} teammates · {visibleAgents.length} agents</span></div>
        <label className="team-chat__history-action"><span>Share this session's history</span>
          <select value={importSessionId} onChange={(event) => setImportSessionId(event.target.value)} aria-label="Session to share to team chat" disabled={!projectSessions.length}>
            <option value="">Choose session…</option>{projectSessions.map((session) => <option key={session.id} value={session.id}>{session.name}</option>)}
          </select>
          <button type="button" className="team-chat__history-button" onClick={() => void importHistory()} disabled={!importSessionId || importing || connection !== 'online'}>
            {importing ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Share history
          </button>
        </label>
        <button type="button" className="team-chat__close" onClick={close} aria-label="Close team chat"><X size={17} /></button>
      </header>

      <div className="team-chat__connection" role="status" aria-live="polite">
        {snapshot?.transport.status !== 'ready' ? <span className="is-warning"><i />Mailbox {snapshot?.transport.status ?? (connection === 'online' ? 'unavailable' : 'disconnected')}{snapshot?.transport.error ? ` · ${snapshot.transport.error}` : ''}</span>
          : snapshot.transport.linkedDeviceCount === 0 ? <span className="is-warning"><i />No mutually linked teammate devices. Messages stay on this device until devices are linked.</span>
            : <span className={snapshot.transport.onlineDeviceCount ? 'is-healthy' : 'is-warning'}><i />{snapshot.transport.onlineDeviceCount} linked device{snapshot.transport.onlineDeviceCount === 1 ? '' : 's'} online · {snapshot.transport.linkedDeviceCount} linked total</span>}
        {snapshot?.transport.peers.length ? <span className="team-chat__peer-status">{snapshot.transport.peers.filter((peer) => peer.linked).map((peer) => `${peer.name}: ${peer.status}`).join(' · ')}</span> : null}
      </div>

      <div className="team-chat__timeline" ref={scroller} role="log" aria-live="polite" aria-label="Team chat messages" onScroll={(event) => {
        const node = event.currentTarget;
        wasAtBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
      }}>
        {snapshot?.hasMore ? <button type="button" className="team-chat__load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? <Loader2 size={13} className="spin" /> : <ArrowDown size={13} />} Load older messages</button> : null}
        {loading && !snapshot ? <div className="team-chat__empty"><Loader2 size={20} className="spin" /><span>Opening the shared conversation…</span></div> : null}
        {!loading && !messages.length ? <div className="team-chat__empty"><MessageCircle size={24} /><strong>Start your team's conversation</strong><span>Messages sync through linked, encrypted team devices. Mention an agent to ask it to work.</span></div> : null}
        {messages.map((message) => <MessageCard key={message.id} message={message} />)}
      </div>

      {error ? <div className="team-chat__error" role="alert">{error}<button type="button" onClick={() => void refresh().catch((reason) => setError(errorMessage(reason)))}>Retry</button></div> : null}
      <form className="team-chat__composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        {mentionIds.length ? <div className="team-chat__mention-chips" aria-label="Mentioned agents">{mentionIds.map((id) => {
          const agent = visibleAgents.find((item) => item.id === id);
          return agent ? <span className="team-chat__mention-chip" key={id}><AtSign size={12} />{agent.name}<button type="button" aria-label={`Remove ${agent.name} mention`} onClick={() => setMentionIds((current) => current.filter((item) => item !== id))}><X size={11} /></button></span> : null;
        })}</div> : null}
        {mentionTrigger && suggestions.length ? <div className="team-chat__suggestions" role="listbox" aria-label="Mention an agent">{suggestions.map((agent, index) => <button type="button" role="option" aria-selected={index === activeSuggestion} key={agent.id} onMouseDown={(event) => event.preventDefault()} onClick={() => selectMention(agent)}>
          <ProviderMark provider={agent.provider} size={16} /><span><strong>{agent.name}</strong><small>{agent.local ? 'On this device' : `Teammate · ${agent.state}`}</small></span><kbd>↵</kbd>
        </button>)}</div> : null}
        <textarea ref={composer} value={draft} onChange={updateDraft} onKeyDown={onComposerKey} placeholder="Message your team… Use @ to mention an agent" aria-label="Team chat message" rows={2} disabled={connection !== 'online'} />
        <div className="team-chat__composer-foot"><span>Enter to send · Shift+Enter for a new line</span><button type="submit" className="team-chat__send" disabled={!draft.trim() || sending || connection !== 'online'} aria-label="Send team chat message">{sending ? <Loader2 size={15} className="spin" /> : <ArrowUp size={15} />}</button></div>
      </form>
    </section>
  </div>;
  return createPortal(dialog, document.body);
}
