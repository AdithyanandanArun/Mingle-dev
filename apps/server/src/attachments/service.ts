import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, chmodSync, mkdirSync, renameSync } from 'node:fs';
import { mkdir, open, opendir, rm, stat, unlink, type FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { ATTACHMENT_LIMITS, type AttachmentRef, type RunAttachment } from '@mingle/contracts';
import type { Store } from '../store.ts';
import type { Logger } from '../types.ts';
import { HttpError, badRequest, conflict, notFound, unprocessable } from '../util.ts';
import { AttachmentRepo, attachmentId, type AttachmentRow, type OwnerKind, type ScopeKind } from './repo.ts';
import { fileMimeType, isRasterType, sanitizeName, sniffRaster, stagedName } from './sniff.ts';

const MAX_CONCURRENT_UPLOADS = 8;
const DRAFT_TTL_MS = 24 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 30 * 60_000;
const SWEEP_BATCH = 200;
const ID_PATTERN = /^att_[a-f0-9]{32}$/;
const SNIFF_BYTES = 16;

export interface UploadScope { kind: ScopeKind; id: string }
export interface UploadInput { scope: UploadScope; name: string | undefined; declaredType: string | undefined }

const scopeKey = (scope: UploadScope): string => `${scope.kind}:${scope.id}`;

/**
 * Private attachment storage. Bytes live under `<dataDir>/attachments`, outside tracked source, as opaque files named by random IDs.
 * Clients only ever hold IDs; paths exist for the server and, briefly, a provider run's private staging directory.
 */
export class AttachmentService {
  readonly repo: AttachmentRepo;
  private readonly root: string;
  private readonly blobs: string;
  private readonly incoming: string;
  private readonly runs: string;
  private uploads = 0;
  private readonly uploadRequests = new Set<IncomingMessage>();
  private uploadDrain: Promise<void> | null = null;
  private resolveUploadDrain: (() => void) | null = null;
  private readonly inflight = new Map<string, number>();
  private readonly staging = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private sweepTask: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly store: Store, dataDir: string, private readonly log: Logger) {
    this.repo = new AttachmentRepo(store.db);
    this.root = path.join(dataDir, 'attachments');
    this.blobs = path.join(this.root, 'blobs');
    this.incoming = path.join(this.root, 'incoming');
    this.runs = path.join(this.root, 'runs');
    for (const dir of [this.root, this.blobs, this.incoming, this.runs]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { chmodSync(dir, 0o700); } catch { /* best effort on platforms without POSIX modes */ }
    }
  }

  /** Removes interrupted uploads and staging left by a previous process, then keeps abandoned drafts bounded. */
  start(): void {
    // Run directories are private to the previous process. Only old directories are eligible; startup never races a live stage.
    this.sweepTask = this.clearStaleRuns().then(() => this.sweep()).catch((error) => this.log('warn', 'Attachment cleanup failed', error));
    this.timer = setInterval(() => {
      this.sweepTask = this.sweepTask.then(() => this.clearStaleRuns()).then(() => this.sweep()).catch((error) => this.log('warn', 'Attachment cleanup failed', error));
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const drain = this.uploadDrain;
    for (const req of this.uploadRequests) req.destroy(new HttpError(503, 'Mingle is shutting down.'));
    await Promise.all([this.sweepTask, ...(drain ? [drain] : [])]);
  }

  // ---------------------------------------------------------------- scope and ownership

  /** The project a scope belongs to, or a 404 when the session or group is archived, missing or in a removed project. */
  private requireScope(scope: UploadScope): string {
    const visible = this.repo.scopeVisible(scope.kind, scope.id);
    if (!visible) throw notFound(scope.kind === 'session' ? 'Session not found' : 'Group not found');
    return visible.projectId;
  }

  // ---------------------------------------------------------------- upload

  /**
   * Streams one request body to a private temporary file, enforcing size limits while reading (not from the declared length),
   * validating images by signature, then records metadata. Everything is removed on overflow, abort or error.
   */
  async upload(req: IncomingMessage, input: UploadInput): Promise<AttachmentRef> {
    if (this.closed) throw new HttpError(503, 'Mingle is shutting down.');
    const projectId = this.requireScope(input.scope);
    const key = scopeKey(input.scope);
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > ATTACHMENT_LIMITS.fileBytes) throw this.tooLarge(ATTACHMENT_LIMITS.fileBytes);
    if (Number.isFinite(declared) && declared === 0) throw badRequest('The file is empty.');
    if (this.uploads >= MAX_CONCURRENT_UPLOADS) throw new HttpError(429, 'Too many uploads are in progress. Try again in a moment.');
    this.assertRoom(input.scope, this.inflight.get(key) ?? 0, 1);

    this.uploads++;
    this.uploadRequests.add(req);
    if (this.uploads === 1) this.uploadDrain = new Promise<void>((resolve) => { this.resolveUploadDrain = resolve; });
    this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
    const id = attachmentId();
    const tmp = path.join(this.incoming, `${id}.${randomBytes(4).toString('hex')}.part`);
    let handle: FileHandle | undefined;
    let finalPath: string | null = null;
    try {
      handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      const hash = createHash('sha256');
      let size = 0;
      let limit: number = ATTACHMENT_LIMITS.fileBytes;
      let head = Buffer.alloc(0);
      let sniffed = false;
      for await (const chunk of req as AsyncIterable<Buffer>) {
        if (this.closed) throw new HttpError(503, 'Mingle is shutting down.');
        if (!sniffed) {
          head = Buffer.concat([head, chunk.subarray(0, SNIFF_BYTES - head.length)]);
          // Signatures are decided from the first bytes so the smaller image limit applies while streaming.
          if (head.length >= 12) {
            sniffed = true;
            if (sniffRaster(head)) limit = ATTACHMENT_LIMITS.imageBytes;
          }
        }
        size += chunk.length;
        if (size > limit) {
          // Keep the connection from lingering for the rest of an oversized body.
          this.closeAfterResponse(req);
          throw this.tooLarge(limit);
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const result = await handle.write(chunk, offset, chunk.length - offset);
          if (!result.bytesWritten) throw new Error('Could not write uploaded file');
          offset += result.bytesWritten;
        }
      }
      if (size === 0) throw badRequest('The file is empty.');
      const raster = sniffRaster(head);
      if (raster && size > ATTACHMENT_LIMITS.imageBytes) throw this.tooLarge(ATTACHMENT_LIMITS.imageBytes);
      const claimed = (input.declaredType ?? '').split(';')[0]!.trim().toLowerCase();
      if (!raster && isRasterType(claimed)) throw new HttpError(415, `The file is not a valid ${claimed.slice(6).toUpperCase()} image.`);
      await handle.close();
      handle = undefined;

      const name = sanitizeName(input.name, ATTACHMENT_LIMITS.nameChars);
      const mimeType = raster ?? fileMimeType(name, input.declaredType);
      finalPath = this.blobPath(id);
      // The scope can disappear during a long upload; the metadata insert is the authority and may still refuse it.
      this.store.tx(() => {
        this.requireScope(input.scope);
        this.assertRoom(input.scope, 0, size);
        renameSync(tmp, finalPath!);
        this.repo.insert({ id, projectId, scopeKind: input.scope.kind, scopeId: input.scope.id, kind: raster ? 'image' : 'file', name, mimeType, size, sha256: hash.digest('hex') });
      });
      this.store.touch();
      const row = this.repo.getRow(id);
      if (!row) throw new Error('Uploaded attachment metadata was not saved');
      return this.ref(row);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(tmp).catch(() => undefined);
      if (finalPath) await unlink(finalPath).catch(() => undefined);
      throw error;
    } finally {
      this.uploads--;
      this.uploadRequests.delete(req);
      const left = (this.inflight.get(key) ?? 1) - 1;
      if (left <= 0) this.inflight.delete(key); else this.inflight.set(key, left);
      if (this.uploads === 0) { this.resolveUploadDrain?.(); this.resolveUploadDrain = null; this.uploadDrain = null; }
    }
  }

  private tooLarge(limit: number): HttpError {
    return new HttpError(413, `That file is larger than the ${Math.round(limit / (1024 * 1024))} MiB limit${limit === ATTACHMENT_LIMITS.imageBytes ? ' for images' : ''}.`);
  }

  private closeAfterResponse(req: IncomingMessage): void {
    const res = (req as IncomingMessage & { res?: ServerResponse }).res;
    try { res?.setHeader('Connection', 'close'); } catch { /* headers already sent */ }
  }

  /** Unsent files per conversation are bounded so abandoned uploads cannot fill the disk. */
  private assertRoom(scope: UploadScope, reservedCount: number, incomingBytes: number): void {
    const drafts = this.repo.drafts(scope.kind, scope.id);
    const count = drafts.length + reservedCount + (incomingBytes ? 1 : 0);
    const bytes = drafts.reduce((sum, row) => sum + row.size, 0) + incomingBytes;
    if (count > ATTACHMENT_LIMITS.filesPerMessage) throw conflict(`A message can include at most ${ATTACHMENT_LIMITS.filesPerMessage} files. Remove one or send first.`);
    if (bytes > ATTACHMENT_LIMITS.totalBytes) throw conflict(`A message can include at most ${Math.round(ATTACHMENT_LIMITS.totalBytes / (1024 * 1024))} MiB of files.`);
  }

  listDrafts(scope: UploadScope): AttachmentRef[] {
    this.requireScope(scope);
    return this.repo.drafts(scope.kind, scope.id).map((row) => this.ref(row));
  }

  // ---------------------------------------------------------------- send-time validation and linking

  /** Read-only check used before accepting a send, so a refusal never costs a model turn or the user's draft. */
  validate(scope: UploadScope, ids: readonly string[]): AttachmentRow[] {
    if (!ids.length) return [];
    if (new Set(ids).size !== ids.length) throw badRequest('An attachment appears twice in this message.');
    const projectId = this.requireScope(scope);
    const rows = this.repo.rowsByIds(ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids.map((id) => {
      const row = ID_PATTERN.test(id) ? byId.get(id) : undefined;
      // Another conversation's files are indistinguishable from missing ones.
      if (!row || row.scopeKind !== scope.kind || row.scopeId !== scope.id || row.projectId !== projectId) throw notFound('An attachment is no longer available. Remove it and attach the file again.');
      if (row.status !== 'draft') throw conflict(`“${row.name}” was already sent. Attach it again to reuse it.`);
      return row;
    });
    if (ordered.length > ATTACHMENT_LIMITS.filesPerMessage) throw unprocessable(`A message can include at most ${ATTACHMENT_LIMITS.filesPerMessage} files.`);
    if (ordered.reduce((sum, row) => sum + row.size, 0) > ATTACHMENT_LIMITS.totalBytes) throw unprocessable(`A message can include at most ${Math.round(ATTACHMENT_LIMITS.totalBytes / (1024 * 1024))} MiB of files.`);
    return ordered;
  }

  /** Validates again and links the files to their message. Run inside the transaction that inserts the message. */
  claim(scope: UploadScope, ids: readonly string[], ownerKind: OwnerKind, ownerId: string): AttachmentRow[] {
    const rows = this.validate(scope, ids);
    rows.forEach((row, position) => {
      if (!this.repo.link(row.id, ownerKind, ownerId, position)) throw conflict(`“${row.name}” was already sent.`);
    });
    return rows;
  }

  forOwner(ownerKind: OwnerKind, ownerId: string): AttachmentRow[] { return this.repo.forOwner(ownerKind, ownerId); }

  /** Copies one failed message's sent files into fresh draft rows for a new retry message. */
  async cloneMessageAttachments(sessionId: string, sourceMessageId: string): Promise<string[]> {
    const scope: UploadScope = { kind: 'session', id: sessionId };
    const projectId = this.requireScope(scope);
    const rows = this.repo.forOwner('message', sourceMessageId);
    if (!rows.length) return [];
    if (rows.length > ATTACHMENT_LIMITS.filesPerMessage || rows.reduce((sum, row) => sum + row.size, 0) > ATTACHMENT_LIMITS.totalBytes
      || rows.some((row) => row.size > (row.kind === 'image' ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.fileBytes))) {
      throw conflict('The failed message’s attachments exceed the current retry limits. Remove or resize the files before retrying.');
    }
    if (rows.some((row) => row.scopeKind !== 'session' || row.scopeId !== sessionId || row.projectId !== projectId)) {
      throw notFound('An attachment is no longer available for this session.');
    }

    const opened: Array<{ row: AttachmentRow; handle: FileHandle }> = [];
    const missing: string[] = [];
    for (const row of rows) {
      const handle = await this.openBlob(row).catch(() => undefined);
      if (handle) opened.push({ row, handle });
      else missing.push(row.name);
    }
    if (missing.length) {
      await Promise.all(opened.map(({ handle }) => handle.close().catch(() => undefined)));
      throw conflict(`The failed message’s attachments are missing from disk: ${missing.join(', ')}. Reattach the missing files before retrying.`);
    }

    const copied: Array<{ id: string; row: AttachmentRow }> = [];
    const createdPaths: string[] = [];
    try {
      for (const { row, handle } of opened) {
        const id = attachmentId();
        const target = this.blobPath(id);
        const output = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        createdPaths.push(target);
        try {
          const hash = createHash('sha256');
          const buffer = Buffer.allocUnsafe(64 * 1024);
          let position = 0;
          while (position < row.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, row.size - position), position);
            if (!bytesRead) throw conflict(`“${row.name}” is no longer available on disk. Reattach it before retrying.`);
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            let written = 0;
            while (written < chunk.length) {
              const result = await output.write(chunk, written, chunk.length - written, position + written);
              if (!result.bytesWritten) throw new Error('Could not clone failed-message attachment');
              written += result.bytesWritten;
            }
            position += bytesRead;
          }
          const info = await handle.stat();
          if (!info.isFile() || info.size !== row.size || hash.digest('hex') !== row.sha256) {
            throw conflict(`“${row.name}” changed on disk after it was uploaded. Reattach it before retrying.`);
          }
        } finally { await output.close(); }
        copied.push({ id, row });
      }

      this.store.tx(() => {
        if (this.requireScope(scope) !== projectId) throw notFound('Session not found');
        for (const { id, row } of copied) this.repo.insert({ id, projectId, scopeKind: 'session', scopeId: sessionId,
          kind: row.kind, name: row.name, mimeType: row.mimeType, size: row.size, sha256: row.sha256 });
      });
      this.store.touch();
      return copied.map(({ id }) => id);
    } catch (error) {
      await Promise.all(createdPaths.map((file) => unlink(file).catch(() => undefined)));
      throw error;
    } finally {
      await Promise.all(opened.map(({ handle }) => handle.close().catch(() => undefined)));
    }
  }

  ref(row: AttachmentRef): AttachmentRef {
    return { id: row.id, name: row.name, mimeType: row.mimeType, size: row.size, kind: row.kind, createdAt: row.createdAt };
  }

  /** Removes an unsent upload. Sent attachments belong to history and cannot be deleted. */
  async discard(id: string): Promise<void> {
    const row = ID_PATTERN.test(id) ? this.repo.getRow(id) : undefined;
    if (!row || !this.repo.scopeVisible(row.scopeKind, row.scopeId)) throw notFound('Attachment not found');
    if (row.status !== 'draft') throw conflict('This file is part of a sent message and is kept with the conversation.');
    if (this.repo.markDeleted(id)) await unlink(this.blobPath(id)).catch(() => undefined);
    this.store.touch();
  }

  // ---------------------------------------------------------------- serving

  async serve(req: IncomingMessage, res: ServerResponse, id: string, download: boolean): Promise<void> {
    const row = ID_PATTERN.test(id) ? this.repo.getRow(id) : undefined;
    const visible = row ? this.repo.scopeVisible(row.scopeKind, row.scopeId) : null;
    if (!row || !visible || visible.projectId !== row.projectId) throw notFound('Attachment not found');
    const handle = await this.openBlob(row).catch(() => null);
    if (!handle) throw notFound('The attachment file is no longer available.');
    // Only validated raster images render inline. Everything else, including SVG and HTML, is an opaque download.
    const inline = !download && row.kind === 'image' && isRasterType(row.mimeType);
    const encoded = encodeURIComponent(row.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    res.statusCode = 200;
    res.setHeader('Content-Type', inline ? row.mimeType : 'application/octet-stream');
    res.setHeader('Content-Length', row.size);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'none'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('ETag', `"${row.sha256}"`);
    if (req.method === 'HEAD') { await handle.close(); res.end(); return; }
    const stream = handle.createReadStream();
    await new Promise<void>((resolve) => {
      stream.on('error', () => { res.destroy(); resolve(); });
      res.on('close', () => { stream.destroy(); resolve(); });
      res.on('finish', () => resolve());
      stream.pipe(res);
    });
  }

  /** Opens a stored blob without following links and confirms it is the regular file that was recorded. */
  private async openBlob(row: AttachmentRow): Promise<FileHandle> {
    const handle = await open(this.blobPath(row.id), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== row.size) throw new Error('attachment file does not match its record');
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private blobPath(id: string): string {
    if (!ID_PATTERN.test(id)) throw notFound('Attachment not found');
    return path.join(this.blobs, id);
  }

  // ---------------------------------------------------------------- run staging

  /**
   * Copies the files linked to one message into a directory private to one provider run. A provider can then read exactly the
   * attachments its recipient was sent, from outside the project worktree, and nothing else. Call release() when the run ends.
   */
  async stage(runId: string, ownerKind: OwnerKind, ownerId: string): Promise<RunAttachment[]> {
    const rows = this.repo.forOwner(ownerKind, ownerId);
    if (!rows.length) return [];
    const dir = path.join(this.runs, runId.replace(/[^A-Za-z0-9_-]/g, ''));
    this.staging.add(dir);
    try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const staged: RunAttachment[] = [];
    for (const [index, row] of rows.entries()) {
      const target = path.join(dir, stagedName(index, row.name));
      const source = await this.openBlob(row).catch(() => { throw conflict(`“${row.name}” is no longer available on disk. Attach it again.`); });
      try {
        const hash = createHash('sha256');
        const reader = source.createReadStream();
        const out = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o400);
        try {
          for await (const chunk of reader as AsyncIterable<Buffer>) {
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
              const result = await out.write(chunk, offset, chunk.length - offset);
              if (!result.bytesWritten) throw new Error('Could not stage attachment');
              offset += result.bytesWritten;
            }
          }
        } finally { await out.close(); }
        if (hash.digest('hex') !== row.sha256) throw conflict(`“${row.name}” changed on disk after it was uploaded.`);
      } finally { await source.close().catch(() => undefined); }
      staged.push({ id: row.id, name: row.name, mimeType: row.mimeType, size: row.size, kind: row.kind, path: target });
    }
    return staged;
    } catch (error) {
      this.staging.delete(dir);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async release(runId: string): Promise<void> {
    const dir = path.join(this.runs, runId.replace(/[^A-Za-z0-9_-]/g, ''));
    this.staging.delete(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async clearStaleRuns(): Promise<void> {
    const directory = await opendir(this.runs).catch(() => null);
    if (!directory) return;
    let examined = 0;
    for await (const entry of directory) {
      if (++examined > SWEEP_BATCH) break;
      if (this.staging.has(path.join(this.runs, entry.name))) continue;
      const target = path.join(this.runs, entry.name);
      const info = await stat(target).catch(() => null);
      if (info && info.mtimeMs < Date.now() - 60 * 60_000) await rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- bounded cleanup

  /** Deletes abandoned drafts and interrupted uploads. Sent attachments and their messages are never touched. */
  async sweep(): Promise<void> {
    if (this.closed) return;
    const cutoff = new Date(Date.now() - DRAFT_TTL_MS).toISOString();
    for (const row of this.repo.staleDrafts(cutoff, SWEEP_BATCH)) {
      if (this.closed) return;
      if (this.repo.markDeleted(row.id)) await unlink(this.blobPath(row.id)).catch(() => undefined);
    }
    for (const id of this.repo.deletedIds(SWEEP_BATCH)) {
      if (this.closed) return;
      await unlink(this.blobPath(id)).catch(() => undefined);
      this.repo.purge(id);
    }
    const old = Date.now() - DRAFT_TTL_MS;
    const blobDirectory = await opendir(this.blobs).catch(() => null);
    let examined = 0;
    if (blobDirectory) for await (const entry of blobDirectory) {
      if (this.closed) return;
      if (++examined > SWEEP_BATCH) break;
      if (!ID_PATTERN.test(entry.name) || this.repo.isStored(entry.name)) continue;
      const file = path.join(this.blobs, entry.name);
      const info = await stat(file).catch(() => null);
      if (info && info.mtimeMs < old) await unlink(file).catch(() => undefined);
    }
    const incomingDirectory = await opendir(this.incoming).catch(() => null);
    examined = 0;
    if (incomingDirectory) for await (const entry of incomingDirectory) {
      if (this.closed) return;
      if (++examined > SWEEP_BATCH) break;
      const file = path.join(this.incoming, entry.name);
      const info = await stat(file).catch(() => null);
      if (info && info.mtimeMs < Date.now() - 60 * 60_000 && !this.uploads) await unlink(file).catch(() => undefined);
    }
  }
}
