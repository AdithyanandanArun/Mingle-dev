import { useCallback, useEffect, useId, useRef, useState, type ClipboardEventHandler } from 'react';
import { Paperclip, RotateCcw, X } from 'lucide-react';
import { ATTACHMENT_LIMITS, type AttachmentRef } from '@mingle/contracts';
import { api, errorMessage } from '../lib/api';
import { cx } from '../lib/format';
import { usePresenceList } from '../lib/motion';

type Scope = { kind: 'session' | 'group'; id: string };
export interface DraftUpload {
  id: string; name: string; size: number; status: 'queued' | 'uploading' | 'failed'; previewUrl?: string; error?: string;
}
interface Upload extends DraftUpload { file: File }
interface DraftContext {
  key: string; scope: Scope; controller: AbortController; rows: AttachmentRef[]; uploads: Map<string, Upload>;
  operations: number; loading: boolean; loadError: string | null; queue: Promise<void>; load: Promise<void>;
}
interface DraftView { key: string; busy: boolean; loading: boolean; loadError: string | null; uploads: DraftUpload[] }

/** One serialized controller owns picker uploads, pasted images, deletion and restoration for this conversation. */
export function useAttachmentDraft(scope: Scope, attachments: AttachmentRef[], onChange: (value: AttachmentRef[]) => void, onError: (message: string | null) => void) {
  const key = `${scope.kind}:${scope.id}`;
  const renderKey = useRef(key);
  renderKey.current = key;
  const context = useRef<DraftContext | null>(null);
  const callbacks = useRef({ onChange, onError });
  callbacks.current = { onChange, onError };
  const [view, setView] = useState<DraftView>({ key, busy: true, loading: true, loadError: null, uploads: [] });
  const current = (ctx: DraftContext) => context.current === ctx && renderKey.current === ctx.key && !ctx.controller.signal.aborted;
  if (context.current?.key === key) context.current.rows = attachments;

  const publish = (ctx: DraftContext) => {
    if (!current(ctx)) return;
    setView({ key: ctx.key, busy: ctx.loading || ctx.operations > 0, loading: ctx.loading, loadError: ctx.loadError,
      uploads: [...ctx.uploads.values()].map(({ file: _file, ...item }) => item) });
  };
  const setRows = (ctx: DraftContext, rows: AttachmentRef[]) => {
    if (!current(ctx)) return;
    ctx.rows = rows; callbacks.current.onChange(rows);
  };
  const restore = async (ctx: DraftContext) => {
    if (!current(ctx)) return;
    ctx.loading = true; publish(ctx);
    try {
      const rows = await api.attachmentDrafts(ctx.scope, ctx.controller.signal);
      if (current(ctx)) { ctx.loadError = null; setRows(ctx, rows); }
    } catch (error) {
      if (current(ctx)) { ctx.loadError = errorMessage(error); callbacks.current.onError(ctx.loadError); }
    } finally { ctx.loading = false; publish(ctx); }
  };
  const enqueue = (ctx: DraftContext, operation: () => Promise<void>) => {
    ctx.operations++; publish(ctx);
    ctx.queue = ctx.queue.catch(() => undefined).then(async () => {
      await ctx.load;
      if (current(ctx)) await operation();
    }).catch((error) => { if (current(ctx)) callbacks.current.onError(errorMessage(error)); })
      .finally(() => { ctx.operations--; publish(ctx); });
  };
  const forgetUpload = (ctx: DraftContext, id: string) => {
    const item = ctx.uploads.get(id);
    if (!item) return;
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    ctx.uploads.delete(id); publish(ctx);
  };
  const upload = (ctx: DraftContext, item: Upload) => enqueue(ctx, async () => {
    if (!ctx.uploads.has(item.id)) return;
    item.status = 'uploading'; delete item.error; publish(ctx);
    try {
      if (ctx.loadError) await restore(ctx);
      if (!current(ctx)) return;
      if (ctx.loadError) throw new Error('Existing attachments could not be loaded. Retry when Mingle reconnects.');
      const row = await api.uploadAttachment(ctx.scope, item.file, ctx.controller.signal);
      if (!current(ctx)) return;
      setRows(ctx, [...ctx.rows, row]); forgetUpload(ctx, item.id);
    } catch (error) {
      if (!current(ctx)) return;
      item.status = 'failed'; item.error = errorMessage(error); publish(ctx); callbacks.current.onError(item.error);
    }
  });

  useEffect(() => {
    const ctx: DraftContext = { key, scope: { ...scope }, controller: new AbortController(), rows: [], uploads: new Map(),
      operations: 0, loading: true, loadError: null, queue: Promise.resolve(), load: Promise.resolve() };
    context.current = ctx; callbacks.current.onChange([]); ctx.load = restore(ctx);
    return () => {
      ctx.controller.abort();
      for (const item of ctx.uploads.values()) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      ctx.uploads.clear();
    };
  }, [key]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const ctx = context.current;
    if (!ctx || !current(ctx) || ctx.key !== key) return;
    callbacks.current.onError(null);
    for (const file of Array.from(files)) {
      const selected = [...ctx.uploads.values()];
      const limit = file.type.startsWith('image/') ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.fileBytes;
      let error: string | null = null;
      if (!file.size) error = `${file.name} is empty.`;
      else if (file.size > limit) error = `${file.name} is larger than the ${Math.round(limit / 1024 / 1024)} MiB attachment limit.`;
      else if (ctx.rows.length + selected.length >= ATTACHMENT_LIMITS.filesPerMessage) error = 'A message can include at most 10 attachments. Remove one or send first.';
      else if ([...ctx.rows, ...selected].reduce((sum, item) => sum + item.size, 0) + file.size > ATTACHMENT_LIMITS.totalBytes) error = 'A message can include at most 50 MiB of attachments.';
      if (error) { callbacks.current.onError(error); continue; }
      const item: Upload = { id: crypto.randomUUID(), file, name: file.name, size: file.size, status: 'queued',
        ...(file.type.startsWith('image/') && file.type !== 'image/svg+xml' ? { previewUrl: URL.createObjectURL(file) } : {}) };
      ctx.uploads.set(item.id, item); upload(ctx, item);
    }
  }, [key]);
  const remove = useCallback((id: string) => {
    const ctx = context.current;
    if (!ctx || !current(ctx) || ctx.key !== key) return;
    enqueue(ctx, async () => { await api.removeAttachment(id); if (current(ctx)) { setRows(ctx, ctx.rows.filter((row) => row.id !== id)); callbacks.current.onError(null); } });
  }, [key]);
  const retry = useCallback((id: string) => {
    const ctx = context.current;
    const item = ctx?.uploads.get(id);
    if (!ctx || !current(ctx) || ctx.key !== key || !item || item.status !== 'failed') return;
    item.status = 'queued'; delete item.error; callbacks.current.onError(null); upload(ctx, item);
  }, [key]);
  const forget = useCallback((id: string) => {
    const ctx = context.current;
    if (!ctx || !current(ctx) || ctx.key !== key || ctx.uploads.get(id)?.status === 'uploading') return;
    forgetUpload(ctx, id);
  }, [key]);
  const reload = useCallback(() => {
    const ctx = context.current;
    if (!ctx || !current(ctx) || ctx.key !== key) return;
    enqueue(ctx, async () => { await restore(ctx); });
  }, [key]);
  /** Acknowledge precisely the accepted files; an older send never clears a new draft or another conversation. */
  const sent = useCallback((ids: readonly string[]) => {
    const ctx = context.current;
    if (!ctx || !current(ctx) || ctx.key !== key) return;
    const accepted = new Set(ids);
    setRows(ctx, ctx.rows.filter((row) => !accepted.has(row.id)));
  }, [key]);
  const isBusy = useCallback(() => {
    const ctx = context.current;
    return !ctx || !current(ctx) || ctx.key !== key || ctx.loading || ctx.operations > 0;
  }, [key]);
  const onPaste: ClipboardEventHandler<HTMLTextAreaElement> = (event) => {
    const images = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!images.length) return;
    event.preventDefault();
    addFiles(images.map((file, index) => new File([file], file.name || `pasted-image-${Date.now()}-${index + 1}.png`, { type: file.type || 'image/png' })));
  };
  const visible = view.key === key ? view : { key, busy: true, loading: true, loadError: null, uploads: [] };
  return { ...visible, addFiles, remove, retry, forget, reload, sent, isBusy, onPaste };
}

export function AttachmentDrafts({ scope, disabled, busy, onFiles }: {
  scope: Scope; disabled?: boolean; busy: boolean;
  onFiles: (files: FileList | File[]) => void;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  return <div className="attachment-drafts" data-scope={scope.id}>
    <input ref={input} id={inputId} type="file" multiple className="sr-only" onChange={(event) => { onFiles(event.currentTarget.files ?? []); event.currentTarget.value = ''; }} />
    <button type="button" className="attachment-drafts__button" aria-label="Attach files" title="Attach files" disabled={disabled || busy} onClick={() => input.current?.click()}><Paperclip size={15} aria-hidden="true" /></button>
  </div>;
}

export function AttachmentTray({ attachments, disabled, busy, uploads = [], onRemove, onRetry, onForget, loading, loadError, onReload }: {
  attachments: AttachmentRef[]; disabled?: boolean; busy: boolean;
  onRemove: (id: string) => void;
  uploads?: DraftUpload[]; onRetry?: (id: string) => void; onForget?: (id: string) => void;
  loading?: boolean; loadError?: string | null; onReload?: () => void;
}) {
  const attachmentRows = usePresenceList(attachments);
  const uploadRows = usePresenceList(uploads);
  const showTray = attachmentRows.length > 0 || uploadRows.length > 0 || Boolean(loadError);
  return showTray ? <div className="attachment-tray" role="group" aria-label="Message attachments">
    {attachmentRows.map(({ item: file, closing }) => <div className={cx('attachment-drafts__item', file.kind === 'image' && 'is-image', closing && 'is-closing')} key={file.id} title={file.name} aria-hidden={closing || undefined} inert={closing}>
      {file.kind === 'image' ? <img src={api.attachmentUrl(file.id)} alt={file.name} /> : <span className="attachment-drafts__file">{file.name}</span>}
      <button type="button" aria-label={`Remove ${file.name}`} title="Remove attachment" disabled={closing || disabled || busy} onClick={() => onRemove(file.id)}><X size={12} aria-hidden="true" /></button>
    </div>)}
    {uploadRows.map(({ item, closing }) => <div className={cx('attachment-drafts__upload', item.status === 'failed' && 'has-error', closing && 'is-closing')} key={item.id} aria-hidden={closing || undefined} inert={closing}>
      {item.previewUrl ? <img src={item.previewUrl} alt="" /> : null}
      <div><span className="attachment-drafts__file" title={item.name}>{item.name}</span><span className="attachment-drafts__state" role="status">{item.status === 'failed' ? item.error || 'Upload failed' : item.status === 'uploading' ? 'Uploading…' : 'Queued'}</span></div>
      {item.status === 'failed' && onRetry ? <button type="button" className="attachment-drafts__button" disabled={closing || disabled} aria-label={`Retry ${item.name}`} title="Retry upload" onClick={() => onRetry(item.id)}><RotateCcw size={13} aria-hidden="true" /></button> : null}
      {onForget ? <button type="button" className="attachment-drafts__button" disabled={closing || disabled || item.status === 'uploading'} aria-label={`Remove ${item.name}`} title="Remove attachment" onClick={() => onForget(item.id)}><X size={13} aria-hidden="true" /></button> : null}
    </div>)}
    {loading ? <span className="attachment-drafts__state" role="status">Loading attachments…</span> : busy && !uploads.length ? <span className="attachment-drafts__state" role="status">Updating attachments…</span> : null}
    {loadError ? <div className="attachment-drafts__load-error"><span>Could not restore attachments.</span>{onReload ? <button type="button" className="link-btn" disabled={disabled || busy} onClick={onReload}>Retry</button> : null}</div> : null}
  </div> : null;
}
