import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, History, Pin, RefreshCw, Search } from 'lucide-react';
import { errorMessage } from '../../lib/api';
import { useMingle, useProject } from '../../store/store';
import { Button, EmptyState, IconButton, InlineError, Spinner } from '../ui';
import type { ProjectMemoryListResponse, ProjectMemoryRevision } from '@mingle/contracts';
import { memoryApi, type MemoryRecord } from '../project-memory/memory-api';
import '../project-memory/project-memory.css';

export function ProjectMemory({ active }: { active: boolean }) {
  const project = useProject();
  const projectId = project?.id;
  const signal = useMingle((state) => state.boot?.events.reduce((latest, event) => event.projectId === projectId && ['memory.updated', 'memory.stale'].includes(event.type) ? Math.max(latest, event.id) : latest, 0));
  const [query, setQuery] = useState('');
  const [includeRetired, setIncludeRetired] = useState(false);
  const [snapshot, setSnapshot] = useState<ProjectMemoryListResponse | null>(null);
  const [entries, setEntries] = useState<MemoryRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<{ id: string; entries: ProjectMemoryRevision[] } | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const currentScope = useRef(projectId);
  const scopeEpoch = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => () => { scopeEpoch.current++; }, [projectId, active]);
  currentScope.current = projectId;

  const load = useCallback(async (cursor?: string | null) => {
    if (!projectId || !active) return;
    const requestId = ++generation.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    try {
      const result = await memoryApi.list(projectId, query, includeRetired, cursor, request.signal);
      if (requestId !== generation.current) return;
      setEntries((previous) => cursor ? [...previous, ...result.entries.filter((entry) => !previous.some((saved) => saved.id === entry.id))] : result.entries);
      setSnapshot(result);
      setError(null);
    } catch (cause) {
      if (requestId === generation.current && !request.signal.aborted) setError(errorMessage(cause));
    } finally { if (requestId === generation.current) setLoading(false); }
  }, [projectId, active, query, includeRetired]);

  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    setEntries([]); setSnapshot(null); setError(null); setNotice(null); setSelected(null); setHistory(null); setQuery(''); setBusy(null); setIncludeRetired(false);
    return () => { generation.current++; controller.current?.abort(); };
  }, [projectId]);
  useEffect(() => {
    if (!active) { generation.current++; controller.current?.abort(); setLoading(false); return; }
    const timer = window.setTimeout(() => void load(), 180);
    return () => { window.clearTimeout(timer); generation.current++; controller.current?.abort(); };
  }, [active, load, signal]);

  const mutate = async (entry: MemoryRecord, patch: Parameters<typeof memoryApi.patch>[2]) => {
    if (!projectId || busy) return;
    const scope = projectId;
    const epoch = scopeEpoch.current;
    const isCurrent = () => currentScope.current === scope && scopeEpoch.current === epoch && activeRef.current;
    setBusy(entry.id);
    try {
      const result = await memoryApi.patch(scope, entry, patch);
      if (!isCurrent()) return;
      setSelected(null); setHistory(null); setNotice(result.notices.join(' ') || null);
      await load();
    } catch (cause) { if (isCurrent()) setError(errorMessage(cause)); }
    finally { if (isCurrent()) setBusy(null); }
  };
  const showHistory = async (entry: MemoryRecord) => {
    if (!projectId || busy) return;
    const scope = projectId;
    const epoch = scopeEpoch.current;
    const isCurrent = () => currentScope.current === scope && scopeEpoch.current === epoch && activeRef.current;
    setBusy(entry.id);
    try {
      const result = await memoryApi.history(scope, entry.id);
      if (isCurrent()) setHistory({ id: entry.id, entries: result.revisions });
    } catch (cause) { if (isCurrent()) setError(errorMessage(cause)); }
    finally { if (isCurrent()) setBusy(null); }
  };

  if (!project) return <EmptyState title="No project selected">Open a project to view its memory.</EmptyState>;
  return <div className="project-memory panel-col" aria-label="Project memory">
    <header className="project-memory__intro"><BookOpen size={17} /><div><strong>Project memory</strong><p>Agents remember and recall useful project knowledge automatically.</p></div><IconButton label="Refresh project memory" onClick={() => void load()} disabled={loading}><RefreshCw size={14} /></IconButton></header>
    <label className="project-memory__search"><Search size={14} /><input aria-label="Search project memory" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search decisions, conventions, gotchas…" maxLength={200} /></label>
    <div className="project-memory__filter"><label><input type="checkbox" checked={includeRetired} onChange={(event) => { setIncludeRetired(event.target.checked); setSelected(null); setHistory(null); }} /> Retired entries</label>{snapshot?.sharing.shared ? <span title={snapshot.sharing.error ?? undefined}>{snapshot.sharing.unpublished ? `${snapshot.sharing.unpublished} changes queued` : 'Shared with team'}</span> : <span>Local project</span>}</div>
    <div className="project-memory__list panel-scroll" aria-busy={loading}>
      {notice ? <p className="project-memory__notice" role="status">{notice}</p> : null}
      {snapshot?.sharing.error ? <p className="project-memory__notice" role="status">Memory is saved locally. Team sharing: {snapshot.sharing.error}</p> : null}
      {error ? <InlineError onRetry={() => void load()}>{error}</InlineError> : null}
      {loading && !entries.length ? <Spinner label="Loading project memory" /> : null}
      {!loading && !error && !entries.length ? <EmptyState icon={<BookOpen size={22} />} title={query ? 'No matching memories' : includeRetired ? 'No retired memories' : 'Knowledge builds as you work'}>{query ? 'Try a different search.' : 'Decisions, discoveries, and project conventions will appear here with their sources. You can inspect or correct them anytime.'}</EmptyState> : null}
      {entries.map((entry) => <article className="project-memory__entry" key={entry.id}>
        <div className="project-memory__meta"><span>{entry.kind}</span><span>{entry.lifecycle === 'stale' ? 'Needs verification' : entry.lifecycle === 'retired' ? 'Retired' : entry.status === 'evidenced' ? 'References checked' : 'Tentative'}</span>{entry.pinned ? <Pin size={12} aria-label="Pinned" /> : null}</div>
        <h3>{entry.title}</h3>
        {selected === entry.id ? <form onSubmit={(event) => { event.preventDefault(); void mutate(entry, { body: draft }); }}><textarea aria-label={`Edit ${entry.title}`} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={1500} rows={5} /><div className="project-memory__actions"><Button type="submit" size="sm" busy={busy === entry.id} disabled={!draft.trim()}>Save correction</Button><Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Cancel</Button></div></form> : <p className="project-memory__content">{entry.body}</p>}
        {entry.files.length ? <ul className="project-memory__paths" aria-label="Related files">{entry.files.map(({ path }) => <li key={path}><code>{path}</code></li>)}</ul> : null}
        {entry.stale ? <p className="project-memory__source">{entry.stale.reason}</p> : null}
        <p className="project-memory__source">{entry.updatedBy.kind === 'agent' ? `Agent: ${entry.updatedBy.name}` : entry.updatedBy.displayName} · Revision {entry.revision}{!entry.origin.local ? ' · From teammate device' : ''}</p>
        {entry.sources.length ? <details className="project-memory__sources"><summary>Source references</summary><ul>{entry.sources.map((source, index) => <li key={`${source.type}:${source.ref}:${index}`}><span>{source.type}</span> <code>{source.ref}</code>{source.type === 'command' ? <small> · recorded exit 0</small> : null}</li>)}</ul></details> : null}
        <div className="project-memory__actions">
          <Button size="sm" variant="ghost" disabled={!!busy} title="Agents preserve pinned entries until you unpin them" onClick={() => void mutate(entry, { pinned: !entry.pinned })}>{entry.pinned ? 'Unpin' : 'Pin'}</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { setSelected(entry.id); setDraft(entry.body); }}>Correct</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void showHistory(entry)}><History size={12} /> History</Button>
          {entry.lifecycle === 'stale' ? <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void mutate(entry, { lifecycle: 'active' })}>Still true</Button> : null}
          {entry.lifecycle !== 'retired' ? <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void mutate(entry, { lifecycle: 'retired' })}>Retire</Button> : <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void mutate(entry, { lifecycle: 'active' })}>Restore</Button>}
        </div>
        {history?.id === entry.id ? <div className="project-memory__history"><div><strong>Entry history</strong><Button size="sm" variant="ghost" onClick={() => setHistory(null)}>Close</Button></div>{history.entries.map((revision) => <section key={revision.id}><small>Revision {revision.revision}</small><p>{revision.snapshot.body}</p></section>)}</div> : null}
      </article>)}
      {snapshot?.nextCursor ? <Button size="sm" onClick={() => void load(snapshot.nextCursor)} busy={loading}>Load more ({entries.length} of {snapshot.total})</Button> : null}
    </div>
  </div>;
}
