import { useEffect, useMemo, useRef, useState } from 'react';
import type { Message, SessionRun, ToolCall } from '@mingle/contracts';
import { Bookmark, Search, X } from 'lucide-react';

type SavedBookmark = { messageId: string; createdAt: string };
const BOOKMARK_LIMIT = 80;
const BOOKMARK_SESSION_LIMIT = 24;
const BOOKMARK_INDEX_KEY = 'mingle:conversation-bookmark-index:v1';
function key(projectId: string, sessionId: string) { return `mingle:conversation-bookmarks:${projectId}:${sessionId}`; }
function registerBookmarkKey(storageKey: string) {
  try {
    const prior: unknown = JSON.parse(localStorage.getItem(BOOKMARK_INDEX_KEY) ?? '[]');
    const indexed = Array.isArray(prior) ? prior.filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('mingle:conversation-bookmarks:')) : [];
    const legacy = indexed.length ? [] : Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((entry): entry is string => Boolean(entry?.startsWith('mingle:conversation-bookmarks:')));
    const keys = [storageKey, ...[...indexed, ...legacy].filter((entry) => entry !== storageKey)];
    const kept = keys.slice(0, BOOKMARK_SESSION_LIMIT);
    for (const stale of keys.slice(BOOKMARK_SESSION_LIMIT)) localStorage.removeItem(stale);
    localStorage.setItem(BOOKMARK_INDEX_KEY, JSON.stringify(kept));
    for (const savedKey of kept) {
      if (savedKey === storageKey) continue;
      try {
        const value: unknown = JSON.parse(localStorage.getItem(savedKey) ?? '[]');
        if (!Array.isArray(value)) { localStorage.removeItem(savedKey); continue; }
        const safe = value.filter((item) => !!item && typeof item.messageId === 'string' && item.messageId.length <= 200 && typeof item.createdAt === 'string')
          .slice(0, BOOKMARK_LIMIT).map((item) => ({ messageId: item.messageId, createdAt: item.createdAt }));
        if (value.some((item) => !!item && typeof item === 'object' && 'preview' in item)) localStorage.setItem(savedKey, JSON.stringify(safe));
      } catch { localStorage.removeItem(savedKey); }
    }
  } catch { /* Bookmark writes report storage failures at their call site. */ }
}
function readBookmarks(projectId: string, sessionId: string): SavedBookmark[] {
  try {
    const storageKey = key(projectId, sessionId);
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(value)) return [];
    const bookmarks = value.filter((item): item is SavedBookmark => !!item && typeof item.messageId === 'string' && item.messageId.length <= 200 && typeof item.createdAt === 'string')
      .slice(0, BOOKMARK_LIMIT).map(({ messageId, createdAt }) => ({ messageId, createdAt }));
    if (value.some((item) => !!item && typeof item === 'object' && 'preview' in item)) localStorage.setItem(storageKey, JSON.stringify(bookmarks));
    return bookmarks;
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
  const search = useRef<HTMLInputElement>(null);
  const section = useRef<HTMLElement>(null);
  const [activeResult, setActiveResult] = useState(-1);
  const { results, totalMatches } = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const matches = open && q ? messages.filter((message) => `${message.content}\n${message.id}\n${message.kind ?? ''}`.toLocaleLowerCase().includes(q)) : [];
    return { results: matches.slice(0, 100), totalMatches: matches.length };
  }, [messages, open, query]);
  useEffect(() => {
    setOpen(false); setQuery(''); setNotice(''); setActiveResult(-1);
    setBookmarks(readBookmarks(projectId, sessionId));
  }, [projectId, sessionId]);
  useEffect(() => { setActiveResult(-1); }, [query, sessionId]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => search.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => {
    const find = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'f') return;
      if (!section.current?.getClientRects().length || section.current.closest('[hidden], [inert]')) return;
      if ((event.target as HTMLElement)?.closest('.editor, .term, [role="dialog"]')) return;
      event.preventDefault(); setOpen(true); search.current?.focus(); search.current?.select();
    };
    window.addEventListener('keydown', find);
    return () => window.removeEventListener('keydown', find);
  }, []);
  const jump = async (messageId: string, runId?: string, callId?: string, review = false, changes = false) => {
    const selector = callId ? `[data-tool-call-id="${CSS.escape(callId)}"]` : runId ? changes ? `[data-run-changes-id="${CSS.escape(runId)}"]` : review ? `[data-run-review-id="${CSS.escape(runId)}"]` : `[data-run-id="${CSS.escape(runId)}"]` : `[data-message-id="${CSS.escape(messageId)}"]`;
    let target = document.querySelector<HTMLElement>(selector);
    if (!target && runId && review) target = document.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(runId)}"]`);
    if (!target) { setNotice('This message is not loaded. Load older messages to find it.'); return; }
    let parent = target.parentElement;
    while (parent) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
      parent = parent.parentElement;
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (!target.isConnected) { setNotice('This message is not loaded. Load older messages to find it.'); return; }
    target.scrollIntoView({ block: 'center' });
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    setNotice('');
  };
  const save = (message: Message) => {
    const next = [{ messageId: message.id, createdAt: new Date().toISOString() }, ...bookmarks.filter((item) => item.messageId !== message.id)].slice(0, BOOKMARK_LIMIT);
    try { registerBookmarkKey(key(projectId, sessionId)); localStorage.setItem(key(projectId, sessionId), JSON.stringify(next)); setBookmarks(next); setNotice('Bookmark saved on this device.'); }
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
        ...(run.changes ? [{ id: message.id, label: `Changes · ${run.changes.fileCount} files`, runId: run.id, review: reviewReady, changes: true, kind: 'changes' as const }] : []),
        ...calls.filter((call) => call.runId === run.id).slice(0, 20).map((call) => ({ id: message.id, callId: call.id, label: `Tool · ${call.name} · ${call.status}`, runId: run.id, kind: 'tool' as const }))] : [];
    }).slice(0, 100);
  }, [messages, open, runs, calls]);
  return <section ref={section} className="conversation-nav" aria-label="Conversation navigation">
    <button ref={trigger} type="button" className="btn btn--secondary btn--sm" aria-keyshortcuts="Control+f Meta+f" aria-controls={`conversation-nav-${sessionId}`} aria-expanded={open} onClick={() => { setOpen(!open); setNotice(''); }}><Search size={13} /> Find & bookmarks</button>
    {open ? <div id={`conversation-nav-${sessionId}`} className="conversation-nav__panel" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
      <div className="conversation-nav__heading"><strong>Conversation navigation</strong><button type="button" aria-label="Close conversation navigation" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={14} /></button></div>
      <label className="sr-only" htmlFor={`conversation-search-${sessionId}`}>Search loaded messages</label>
      <input ref={search} id={`conversation-search-${sessionId}`} type="search" maxLength={200} value={query} placeholder="Search loaded messages" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.nativeEvent.isComposing || !results.length) return;
        event.preventDefault();
        const next = (activeResult + (event.shiftKey ? -1 : 1) + results.length) % results.length;
        const message = results[next]!; setActiveResult(next);
        void jump(message.id).then(() => search.current?.focus({ preventScroll: true }));
      }} />
      <p className="conversation-nav__scope">Search loaded messages only · {messages.length.toLocaleString()} loaded</p>
      {query.trim() ? <p className="conversation-nav__scope" role="status">{totalMatches === 0 ? 'No matching loaded messages.' : `${activeResult >= 0 ? `Result ${activeResult + 1} of ` : ''}${totalMatches} matching messages${totalMatches > 100 ? ' · showing the first 100' : ''}. Enter for next, Shift+Enter for previous.`}</p> : null}
      {hasOlder ? <button type="button" className="conversation-nav__load" onClick={onLoadOlder}>Load older messages to expand search scope</button> : null}
      {query.trim() ? <ul aria-label="Search results">{results.map((message) => <li key={message.id}><button type="button" onClick={() => jump(message.id)}>{message.role} · {preview(message.content) || message.id}</button><button type="button" aria-label={`Bookmark message ${message.id}`} onClick={() => save(message)}><Bookmark size={13} /></button></li>)}</ul> : null}
      <h4>Bookmarks</h4>{bookmarks.length ? <ul>{bookmarks.map((item) => <li key={item.messageId}><button type="button" onClick={() => jump(item.messageId)}>{messages.find((message) => message.id === item.messageId) ? preview(messages.find((message) => message.id === item.messageId)!.content) || item.messageId : `Message · ${item.messageId}`}</button><button type="button" aria-label="Remove bookmark" onClick={() => remove(item.messageId)}><X size={13} /></button></li>)}</ul> : <p className="conversation-nav__scope">No bookmarks for this conversation.</p>}
      {landmarks.length ? <><h4>Tasks, tools & changes</h4><ul>{landmarks.map((item, index) => <li key={`${item.runId}:${item.kind}:${index}`}><button type="button" onClick={() => jump(item.id, item.runId, 'callId' in item ? item.callId : undefined, 'review' in item ? item.review : false, 'changes' in item && item.changes)}>{item.label}</button></li>)}</ul></> : null}
      {notice ? <p role="status" className="conversation-nav__scope">{notice}{notice.includes('not loaded') && hasOlder ? <> <button type="button" onClick={onLoadOlder}>Load older messages</button></> : null}</p> : null}
    </div> : null}
  </section>;
}
