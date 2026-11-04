import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, FileDiff, FolderOpen, X } from 'lucide-react';
import type { RunChangedFile, RunChanges as RunChangesData, RunChangesSummary } from '@mingle/contracts';
import { api, errorMessage } from '../lib/api';
import { parseDiff } from '../lib/diff';
import { usePresence, useRetainedPresence } from '../lib/motion';

type Tree = { name: string; path: string; file?: RunChangedFile; children: Map<string, Tree> };

function fileTree(files: RunChangedFile[]): Tree[] {
  const roots = new Map<string, Tree>();
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let map = roots;
    let node: Tree | undefined;
    let prefix = '';
    parts.forEach((part, index) => {
      prefix = prefix ? `${prefix}/${part}` : part;
      node = map.get(part);
      if (!node) { node = { name: part, path: prefix, children: new Map() }; map.set(part, node); }
      if (index === parts.length - 1) node.file = file;
      map = node.children;
    });
  }
  const compress = (node: Tree): Tree => {
    let current = { ...node, children: new Map([...node.children].map(([key, value]) => [key, compress(value)])) };
    while (!current.file && current.children.size === 1) {
      const child = [...current.children.values()][0]!;
      if (child.file) break;
      current = { ...child, name: `${current.name}/${child.name}` };
    }
    return current;
  };
  return [...roots.values()].map(compress).sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name));
}

function treeTotals(node: Tree): { files: number; additions: number | null; deletions: number | null } {
  if (node.file) return { files: 1, additions: node.file.additions, deletions: node.file.deletions };
  return [...node.children.values()].reduce((totals, child) => {
    const childTotals = treeTotals(child);
    return { files: totals.files + childTotals.files, additions: totals.additions === null || childTotals.additions === null ? null : totals.additions + childTotals.additions, deletions: totals.deletions === null || childTotals.deletions === null ? null : totals.deletions + childTotals.deletions };
  }, { files: 0, additions: 0 as number | null, deletions: 0 as number | null });
}

const count = (value: number | null) => value === null ? '—' : value.toLocaleString();

function DiffView({ data }: { data: RunChangesData }) {
  const files = useMemo(() => parseDiff(data.diff), [data.diff]);
  return <div className="run-diff__content">
    {data.summary.files.map(file => {
      const patch = files.find(candidate => candidate.path === file.path);
      return <section className="run-diff-file" key={file.path}>
        <header><span className={`run-diff-file__status run-diff-file__status--${file.status.toLowerCase()}`}>{file.status}</span><code title={file.path}>{file.path}</code><span><b className="add">+{count(file.additions)}</b> <b className="del">−{count(file.deletions)}</b></span></header>
        {file.binary || patch?.binary ? <p className="run-diff__note">Binary file changed. Line counts are unavailable.</p> : patch?.lines.length ? <div className="run-diff-lines" role="table" aria-label={`Saved diff for ${file.path}`}>
          {patch.lines.slice(0, 1500).map((line, index) => <div key={index} role="row" className={`run-diff-line run-diff-line--${line.kind}`}>
            <span aria-hidden="true">{line.oldNo ?? ''}</span><span aria-hidden="true">{line.newNo ?? ''}</span><span aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span><code>{line.text || ' '}</code>
          </div>)}
          {patch.lines.length > 1500 ? <p className="run-diff__note">Showing the first 1,500 lines for this file.</p> : null}
        </div> : <p className="run-diff__note">Textual diff is unavailable for this file.</p>}
      </section>;
    })}
    {data.diffTruncated ? <p className="run-diff__note run-diff__note--warning">The saved patch was truncated. Some diff content is not shown.</p> : null}
    {data.summary.truncated ? <p className="run-diff__note run-diff__note--warning">The saved file list is truncated. Some changed files are not shown.</p> : null}
    {data.summary.notices.map((notice, index) => <p key={index} className="run-diff__note">{notice}</p>)}
  </div>;
}

function SavedDiffDialog({ runId, initialPath, onClose, open, closing }: { runId: string; initialPath?: string; onClose: () => void; open: boolean; closing: boolean }) {
  const [data, setData] = useState<RunChangesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const focusReturned = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const load = () => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setLoading(true); setError(null);
    void api.runChanges(runId, abort.signal).then(value => { if (!abort.signal.aborted) setData(value); }).catch(reason => {
      if (!abort.signal.aborted) setError(errorMessage(reason));
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
  };
  const restoreFocus = () => {
    if (focusReturned.current) return;
    focusReturned.current = true;
    if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (!open) { restoreFocus(); return; }
    focusReturned.current = false;
    return restoreFocus;
  }, [open]);
  useEffect(() => {
    if (!open) { controller.current?.abort(); return; }
    load();
    return () => controller.current?.abort();
  }, [runId, open]);
  useLayoutEffect(() => {
    if (!open) return;
    const element = dialog.current;
    if (!element) return;
    const focusables = () => [...element.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')];
    focusables()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') {
        const items = focusables(); const first = items[0]; const last = items.at(-1);
        if (!element.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, open]);
  const visible = initialPath && data ? { ...data, summary: { ...data.summary, files: data.summary.files.filter(file => file.path === initialPath) } } : data;
  return createPortal(<div className={`run-diff-backdrop${closing ? ' is-closing' : ''}`} aria-hidden={closing || undefined} inert={closing} onMouseDown={event => { if (!closing && event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} className="run-diff-dialog" role="dialog" aria-modal="true" aria-labelledby="run-diff-title">
      <header className="run-diff-dialog__head"><div><span className="run-changes__eyebrow">Saved run changes</span><h2 id="run-diff-title">{initialPath ?? 'Run diff'}</h2></div><button className="run-changes__icon" type="button" onClick={onClose} aria-label="Close saved diff"><X size={17} /></button></header>
      <div className="run-diff-dialog__body">
        {loading ? <p className="run-diff__note" role="status">Loading saved diff…</p> : error ? <div className="run-diff-error" role="alert"><p>{error}</p><button type="button" onClick={load}>Try again</button></div> : visible ? <DiffView data={visible} /> : null}
      </div>
    </section>
  </div>, document.body);
}

function FileRows({ nodes, onOpen }: { nodes: Tree[]; onOpen: (path: string) => void }) {
  return <ul className="run-changes__tree">{nodes.map(node => node.file ? <li key={node.path}><button className="run-changes__file" type="button" onClick={() => onOpen(node.file!.path)} title={node.file.path}>
    <span className={`run-changes__status run-changes__status--${node.file.status.toLowerCase()}`}>{node.file.status}</span><span className="run-changes__filename">{node.name}</span><span className="run-changes__counts"><b className="add">+{count(node.file.additions)}</b><b className="del">−{count(node.file.deletions)}</b></span>
  </button></li> : <li key={node.path}>{(() => { const totals = treeTotals(node); return <details className="run-changes__folder"><summary><ChevronRight size={13} /><FolderOpen size={14} /><span>{node.name}</span><span className="run-changes__counts"><b className="add">+{count(totals.additions)}</b><b className="del">−{count(totals.deletions)}</b><span>{totals.files} {totals.files === 1 ? 'file' : 'files'}</span></span></summary><FileRows nodes={[...node.children.values()]} onOpen={onOpen} /></details>; })()}</li>)}</ul>;
}

/**
 * Saved changes for one run. `embedded` places the same file list and saved-diff dialog inside the completion review card (the
 * card supplies the surrounding frame and heading) so a run never shows two change lists.
 */
export function RunChanges({ runId, summary, embedded = false }: { runId: string; summary?: RunChangesSummary | null; embedded?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const { present: bodyPresent, closing: bodyClosing } = usePresence(expanded);
  const [dialog, setDialog] = useState<{ path?: string } | null>(null);
  const nodes = useMemo(() => fileTree(summary?.files ?? []), [summary?.files]);
  const onClose = useCallback(() => setDialog(null), []);
  const dialogValue = useMemo(() => dialog ? { runId, ...dialog } : null, [runId, dialog]);
  const { value: retainedDialog, present: dialogPresent, closing: dialogClosing, key: dialogKey } = useRetainedPresence(dialogValue, 160);
  if (!summary || (summary.status === 'available' && summary.fileCount === 0)) return null;
  const open = (path?: string) => setDialog({ path });
  return <>
    <section className={`run-changes${embedded ? ' run-changes--embedded' : ''}`} aria-label="Changes saved for this run">
      {summary.status === 'unavailable' ? <><div className="run-changes__head"><span>Changes unavailable</span><span className="run-changes__quiet">This run’s change summary could not be captured.</span></div>{summary.notices.map((notice, index) => <p className="run-changes__notice" key={index}>{notice}</p>)}</> : <>
        <header className="run-changes__head"><button type="button" className="run-changes__expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><ChevronDown size={14} className={expanded ? '' : 'is-collapsed'} /><span>{summary.fileCount} changed {summary.fileCount === 1 ? 'file' : 'files'}</span><span className="run-changes__counts"><b className="add">+{summary.additions}</b><b className="del">−{summary.deletions}</b></span></button><button type="button" className="run-changes__open" onClick={() => open()}><FileDiff size={14} />{embedded ? 'Review changes' : 'Open diff'}</button></header>
        {bodyPresent ? <div className={`run-changes__body-frame${bodyClosing ? ' is-closing' : ''}`} aria-hidden={bodyClosing || undefined} inert={bodyClosing}><div className="run-changes__body"><FileRows nodes={nodes} onOpen={open} />{summary.truncated ? <p className="run-changes__notice">The file list is truncated. Some changed files are not shown.</p> : null}{summary.notices.map((notice, index) => <p className="run-changes__notice" key={index}>{notice}</p>)}</div></div> : null}
      </>}
    </section>
    {dialogPresent && retainedDialog ? <SavedDiffDialog key={dialogKey} runId={retainedDialog.runId} initialPath={retainedDialog.path} open={Boolean(dialog)} closing={dialogClosing} onClose={onClose} /> : null}
  </>;
}
