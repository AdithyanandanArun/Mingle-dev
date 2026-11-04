import { useMemo, useRef, useState } from 'react';
import type { Message, SessionRun, ToolCall } from '@mingle/contracts';
import { Bookmark, Search, X } from 'lucide-react';

type SavedBookmark = { messageId: string; preview: string; createdAt: string };
const BOOKMARK_LIMIT = 80;
function key(projectId: string, sessionId: string) { return `mingle:conversation-bookmarks:${projectId}:${sessionId}`; }
function readBookmarks(projectId: string, sessionId: string): SavedBookmark[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(projectId, sessionId)) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is SavedBookmark => !!item && typeof item.messageId === 'string' && typeof item.preview === 'string' && typeof item.createdAt === 'string').slice(0, BOOKMARK_LIMIT);
  } catch { return []; }
}
function preview(text: string) {
  return text.replace(/\s+/g, ' ').trim()
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*[^\s,;]{6,}/gi, '[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[redacted]')
    .replace(/:\/\/[^\s/:]+:[^\s/@]+@/g, '://[redacted]@').slice(0, 120);
}

export function ConversationNavigation({ projectId, sessionId, messages, runs, calls, hasOlder, onLoadOlder }: {
  projectId: string; sessionId: string; messages: readonly Message[]; runs: readonly SessionRun[]; calls: readonly ToolCall[]; hasOlder: boolean; onLoadOlder: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [bookmarks, setBookmarks] = useState(() => readBookmarks(projectId, sessionId));
  const [notice, setNotice] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const results = useMemo(() => {
    if (!open) return [];
    const q = query.trim().toLocaleLowerCase();
    if (!q) return [];
    return messages.filter((message) => `${message.content}\n${message.id}\n${message.kind ?? ''}`.toLocaleLowerCase().includes(q)).slice(0, 100);
  }, [messages, open, query]);
  const jump = (messageId: string, runId?: string, callId?: string, review = false) => {
    const selector = callId ? `[data-tool-call-id="${CSS.escape(callId)}"]` : runId ? review ? `[data-run-review-id="${CSS.escape(runId)}"]` : `[data-run-id="${CSS.escape(runId)}"]` : `[data-message-id="${CSS.escape(messageId)}"]`;
    const target = document.querySelector<HTMLElement>(selector);
    if (!target) { setNotice('This message is not loaded. Load older messages to find it.'); return; }
    target.scrollIntoView({ block: 'center' });
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    setNotice('');
  };
  const save = (message: Message) => {
    const next = [{ messageId: message.id, preview: preview(message.content) || 'Attachment or empty message', createdAt: new Date().toISOString() }, ...bookmarks.filter((item) => item.messageId !== message.id)].slice(0, BOOKMARK_LIMIT);
    try { localStorage.setItem(key(projectId, sessionId), JSON.stringify(next)); setBookmarks(next); setNotice('Bookmark saved on this device.'); }
    catch { setNotice('Could not save bookmark in this browser.'); }
  };
  const remove = (id: string) => { const next = bookmarks.filter((item) => item.messageId !== id); try { localStorage.setItem(key(projectId, sessionId), JSON.stringify(next)); setBookmarks(next); } catch { setNotice('Could not update bookmarks in this browser.'); } };
  const landmarks = useMemo(() => {
    if (!open) return [];
    const byId = new Map(messages.map((message) => [message.id, message]));
    return runs.flatMap((run) => {
      const message = byId.get(run.userMessageId);
      const reviewReady = run.status !== 'running';
      return message ? [{ id: message.id, label: `${reviewReady ? 'Task' : 'Run'} · ${preview(message.content) || 'Run'}`, runId: run.id, review: reviewReady, kind: 'task' as const },
        ...(run.changes ? [{ id: message.id, label: `Changes · ${run.changes.fileCount} files`, runId: run.id, review: reviewReady, kind: 'changes' as const }] : []),
        ...calls.filter((call) => call.runId === run.id).slice(0, 20).map((call) => ({ id: message.id, callId: call.id, label: `Tool · ${call.name} · ${call.status}`, runId: run.id, kind: 'tool' as const }))] : [];
    }).slice(0, 100);
  }, [messages, open, runs, calls]);
  return <section className="conversation-nav" aria-label="Conversation navigation">
    <button ref={trigger} type="button" className="btn btn--secondary btn--sm" aria-expanded={open} onClick={() => { setOpen(!open); setNotice(''); }}><Search size={13} /> Find & bookmarks</button>
    {open ? <div className="conversation-nav__panel" onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } }}>
      <div className="conversation-nav__heading"><strong>Conversation navigation</strong><button type="button" aria-label="Close conversation navigation" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={14} /></button></div>
      <label className="sr-only" htmlFor={`conversation-search-${sessionId}`}>Search loaded messages</label>
      <input id={`conversation-search-${sessionId}`} type="search" maxLength={200} value={query} placeholder="Search loaded messages" onChange={(event) => setQuery(event.target.value)} />
      <p className="conversation-nav__scope">Search loaded messages only · {messages.length.toLocaleString()} loaded</p>
      {hasOlder ? <button type="button" className="conversation-nav__load" onClick={onLoadOlder}>Load older messages to expand search scope</button> : null}
      {query.trim() ? <ul aria-label="Search results">{results.map((message) => <li key={message.id}><button type="button" onClick={() => jump(message.id)}>{message.role} · {preview(message.content) || message.id}</button><button type="button" aria-label={`Bookmark message ${message.id}`} onClick={() => save(message)}><Bookmark size={13} /></button></li>)}</ul> : null}
      <h4>Bookmarks</h4>{bookmarks.length ? <ul>{bookmarks.map((item) => <li key={item.messageId}><button type="button" onClick={() => jump(item.messageId)}>{item.preview}</button><button type="button" aria-label="Remove bookmark" onClick={() => remove(item.messageId)}><X size={13} /></button></li>)}</ul> : <p className="conversation-nav__scope">No bookmarks for this conversation.</p>}
      {landmarks.length ? <><h4>Tasks, tools & changes</h4><ul>{landmarks.map((item, index) => <li key={`${item.runId}:${item.kind}:${index}`}><button type="button" onClick={() => jump(item.id, item.runId, 'callId' in item ? item.callId : undefined, 'review' in item ? item.review : false)}>{item.label}</button></li>)}</ul></> : null}
      {notice ? <p role="status" className="conversation-nav__scope">{notice}{notice.includes('not loaded') && hasOlder ? <> <button type="button" onClick={onLoadOlder}>Load older messages</button></> : null}</p> : null}
    </div> : null}
  </section>;
}
