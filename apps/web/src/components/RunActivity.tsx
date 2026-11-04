import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Bot, ChevronRight, CircleAlert, FileCode2, Globe2, LoaderCircle, Search, Terminal, Wrench } from 'lucide-react';
import type { SessionRun, ToolCall, ToolCategory } from '@mingle/contracts';
import { api } from '../lib/api';
import { cx } from '../lib/format';
import { formatElapsed, runElapsed, runStatusLabel } from '../lib/activity';
import { mergeToolCalls, needsFullDetail, runActivitySummary, toolInputLabel, toolOutputLabel, toolRowFacts } from '../lib/toolRecords';

interface ToolNode { call: ToolCall; children: ToolNode[] }

function normalizeCommand(value: string): string {
  return value.trim().replace(/^(?:\$|❯)\s*/, '');
}

function toolTree(calls: readonly ToolCall[], runId: string): ToolNode[] {
  const members = calls.filter(call => call.runId === runId);
  const providerRows = new Map<string, ToolCall[]>();
  for (const call of members) {
    const rows = providerRows.get(call.providerId) ?? [];
    rows.push(call);
    providerRows.set(call.providerId, rows);
  }
  const parentById = new Map<string, string>();
  for (const call of members) {
    if (!call.parentProviderId || call.parentProviderId === call.providerId) continue;
    const possible = providerRows.get(call.parentProviderId);
    if (possible?.length === 1 && possible[0]?.id !== call.id) parentById.set(call.id, possible[0]!.id);
  }

  // Break malformed cycles so bad provider metadata cannot recurse forever or hide every row.
  for (const call of members) {
    const path: string[] = [];
    const seenAt = new Map<string, number>();
    let current: string | undefined = call.id;
    while (current) {
      const at = seenAt.get(current);
      if (at !== undefined) {
        for (const cyclic of path.slice(at)) parentById.delete(cyclic);
        break;
      }
      seenAt.set(current, path.length);
      path.push(current);
      current = parentById.get(current);
    }
  }

  const childrenById = new Map<string, ToolCall[]>();
  const roots: ToolCall[] = [];
  for (const call of members) {
    const parentId = parentById.get(call.id);
    if (!parentId) roots.push(call);
    else {
      const children = childrenById.get(parentId) ?? [];
      children.push(call);
      childrenById.set(parentId, children);
    }
  }
  const toNode = (call: ToolCall, path = new Set<string>()): ToolNode => {
    if (path.has(call.id)) return { call, children: [] };
    const next = new Set(path).add(call.id);
    return { call, children: (childrenById.get(call.id) ?? []).map(child => toNode(child, next)) };
  };
  return roots.map(call => toNode(call));
}

function categoryIcon(category: ToolCategory): ReactNode {
  if (category === 'command') return <Terminal size={13} aria-hidden="true" />;
  if (category === 'browser') return <Globe2 size={13} aria-hidden="true" />;
  if (category === 'search') return <Search size={13} aria-hidden="true" />;
  if (category === 'file') return <FileCode2 size={13} aria-hidden="true" />;
  if (category === 'agent') return <Bot size={13} aria-hidden="true" />;
  return <Wrench size={13} aria-hidden="true" />;
}

function Field({ label, value, code = false }: { label: string; value: string; code?: boolean }) {
  return <div className="run-tool__field"><span>{label}</span>{code ? <pre>{value}</pre> : <code>{value}</code>}</div>;
}

function ToolDetail({ node, activeRun, onFull }: { node: ToolNode; activeRun: boolean; onFull: (call: ToolCall) => void }) {
  const row = node.call;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const elapsedMs = row.durationMs ?? (row.status === 'running' && activeRun ? (() => {
    const started = Date.parse(row.startedAt);
    return Number.isFinite(started) ? Math.max(0, Date.now() - started) : null;
  })() : null);
  const title = row.summary.trim() || row.command?.trim() || row.name || 'Tool activity';
  const executing = activeRun && row.status === 'running';
  const facts = toolRowFacts(row, elapsedMs, node.children.length);

  // The complete record is loaded once per version of its content: only while this row is open, only after the call has
  // finished, and only while the held copy is a bounded preview. Snapshots that leave the content unchanged (other tools
  // changing, lifecycle-only updates) keep the fetched copy through the reconciler, so they neither erase it nor refetch it.
  // Each pass is fenced: closing, a newer content revision or unmounting ends the pass and ignores its late response.
  const wantsFull = open && needsFullDetail(row);
  const contentRevision = row.contentRevision ?? 0;
  useEffect(() => {
    if (!wantsFull) { setLoading(false); return; }
    let current = true;
    setLoading(true);
    setLoadError(false);
    void api.toolCall(row.id).then((full) => {
      if (!current) return;
      setLoading(false);
      onFull(full);
    }).catch(() => {
      if (!current) return;
      setLoading(false);
      setLoadError(true);
    });
    return () => { current = false; };
  }, [wantsFull, row.id, contentRevision, onFull]);

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    if (event.target !== event.currentTarget) return;
    setOpen(event.currentTarget.open);
    if (!event.currentTarget.open) setLoadError(false);
  };

  return (
    <details className={cx('run-tool', `run-tool--${row.category}`)} onToggle={onToggle}>
      <summary className="run-tool__summary">
        <ChevronRight size={12} className="run-tool__chevron" aria-hidden="true" />
        {categoryIcon(row.category)}
        <span className="run-tool__title" title={title}><span className={cx(executing && 'activity-shimmer')}>{title}</span></span>
        {row.command && normalizeCommand(row.command) !== normalizeCommand(title) ? <code className="run-tool__command" title={row.command}>{row.command}</code> : null}
        {facts.length ? <span className="run-tool__meta">{facts.join(' · ')}</span> : null}
        <span className={cx('run-tool__status', `is-${row.status}`, executing && 'activity-shimmer')}>{row.status}</span>
      </summary>
      <div className="run-tool__body">
        {loading ? <span className="run-tool__loading" role="status"><LoaderCircle size={13} className="run-tool__spin" /> Loading full output…</span> : null}
        {loadError ? <span className="run-tool__load-error" role="status"><CircleAlert size={13} /> Could not load full output. Showing the available record.</span> : null}
        <div className="run-tool__facts">
          {elapsedMs !== null ? <Field label="Duration" value={formatElapsed(elapsedMs)} /> : null}
          {row.exitCode !== null ? <Field label="Exit code" value={String(row.exitCode)} /> : null}
          {row.processId ? <Field label="Process" value={row.processId} /> : null}
          {row.cwd ? <Field label="Working directory" value={row.cwd} code /> : null}
          {row.command ? <Field label="Command" value={row.command} code /> : null}
        </div>
        {row.input ? <Field label={toolInputLabel(row)} value={row.input} code /> : null}
        {row.output ? <Field label={toolOutputLabel(row)} value={row.output} code /> : null}
        {node.children.length ? <div className="run-tool__children" aria-label="Child tool calls">{node.children.map(child => <ToolDetail key={child.call.id} node={child} activeRun={activeRun} onFull={onFull} />)}</div> : null}
      </div>
    </details>
  );
}

export function RunActivity({ run, initialCalls }: { run: SessionRun; initialCalls: ToolCall[] }) {
  const [now, setNow] = useState(() => Date.now());
  const [calls, setCalls] = useState<readonly ToolCall[]>(() => initialCalls);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const requested = useRef(false);
  const expanded = useRef(false);
  const requestGeneration = useRef(0);

  // Snapshots carry bounded previews: fold them in by revision so a fetched complete copy is never replaced by its own preview.
  useEffect(() => { setCalls(current => mergeToolCalls(current, initialCalls)); }, [initialCalls]);
  const acceptFull = useCallback((call: ToolCall) => { setCalls(current => mergeToolCalls(current, [call])); }, []);
  useEffect(() => () => { requestGeneration.current += 1; }, []);
  useEffect(() => {
    if (run.status !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.status]);

  const elapsed = runElapsed(run, now);
  const summary = useMemo(() => runActivitySummary(run, calls), [run, calls]);
  const tree = useMemo(() => toolTree(calls, run.id), [calls, run.id]);
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    if (event.target !== event.currentTarget) return;
    expanded.current = event.currentTarget.open;
    if (!event.currentTarget.open) {
      requestGeneration.current += 1;
      requested.current = false;
      setLoading(false);
      return;
    }
    if (requested.current) return;
    requested.current = true;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setLoadError(false);
    void api.runTools(run.id).then((all) => {
      if (generation !== requestGeneration.current || !expanded.current) return;
      setCalls(current => mergeToolCalls(current, all.filter(call => call.runId === run.id)));
    }).catch(() => {
      if (generation !== requestGeneration.current) return;
      setLoadError(true);
      requested.current = false;
    }).finally(() => { if (generation === requestGeneration.current) setLoading(false); });
  };

  return (
    <details className={cx('run-activity', `is-${run.status}`)} onToggle={onToggle}>
      <summary className="run-activity__summary">
        <span className={cx('run-activity__status', run.status === 'running' && 'activity-shimmer')} role={run.status === 'running' ? 'timer' : undefined} aria-live="off">{runStatusLabel(run, elapsed)}</span>
        {summary.length ? <span className={cx('run-activity__counts', run.status === 'running' && 'activity-shimmer')} title={summary.join(' · ')}>{summary.join(' · ')}</span> : null}
      </summary>
      <div className="run-activity__body">
        {!run.toolCount && !tree.length ? <p className="run-activity__empty">No tool calls were reported for this run.</p> : null}
        {loading ? <span className="run-tool__loading"><LoaderCircle size={13} className="run-tool__spin" /> Loading run activity…</span> : null}
        {loadError ? <span className="run-tool__load-error"><CircleAlert size={13} /> Could not refresh the full tool list. Showing available activity.</span> : null}
        {tree.length ? <div className="run-activity__tools">{tree.map(node => <ToolDetail key={node.call.id} node={node} activeRun={run.status === 'running'} onFull={acceptFull} />)}</div> : !loading && run.toolCount > 0 ? <p className="run-activity__empty">Tool details are not included in the current snapshot.</p> : null}
        {calls.length < run.toolCount ? <p className="run-activity__empty">Showing {calls.length} of {run.toolCount} reported tool calls. The per-run detail list returns at most 1,000 calls.</p> : null}
      </div>
    </details>
  );
}
