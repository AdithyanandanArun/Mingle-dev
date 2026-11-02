import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { EntryRow, MemoryRepo } from './repo.ts';
import { checkMemoryPath } from './safety.ts';
import { resolveInside } from '../paths.ts';

export const MAX_HASH_BYTES = 2 * 1024 * 1024;

export type FileState = { kind: 'ok'; hash: string } | { kind: 'missing' } | { kind: 'unknown' };

/** SHA-256 prefix of a regular file inside `root` (symlinks resolved and contained, protected names refused). */
export async function hashProjectFile(root: string, rel: string): Promise<FileState> {
  try {
    const checked = checkMemoryPath(rel);
    if (!checked.ok) return { kind: 'unknown' };
    const resolved = await resolveInside(root, checked.path);
    const stat = await fsp.stat(resolved.real);
    if (!stat.isFile() || stat.size > MAX_HASH_BYTES) return { kind: 'unknown' };
    return { kind: 'ok', hash: createHash('sha256').update(await fsp.readFile(resolved.real)).digest('hex').slice(0, 32) };
  } catch (error) {
    const status = (error as { status?: number }).status;
    return status === 404 || (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unknown' };
  }
}

interface CacheEntry { mtimeMs: number; size: number; state: FileState }
interface ScanState { lastEnd: number; cursor: number; flight?: Promise<string[]> }

export interface ScanOptions { force?: boolean; budgetMs?: number }

/**
 * Marks entries stale when a referenced file no longer matches what was recorded. Work is bounded three ways: referenced paths are
 * de-duplicated across entries, hashes are cached against the file's (mtime, size) so unchanged files cost one stat, and every scan has a
 * wall-clock budget after which it stops and resumes from the same position next time.
 */
export class StaleScanner {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly state = new Map<string, ScanState>();

  constructor(private readonly repo: MemoryRepo, private readonly options: {
    now: () => number; budgetMs?: number; minIntervalMs?: number; concurrency?: number; maxCache?: number;
    nowIso: () => string;
  }) {}

  private async current(root: string, rel: string): Promise<FileState> {
    const key = `${root}\0${rel}`;
    let stat;
    try { stat = await fsp.stat(path.join(root, ...rel.split('/'))); }
    catch (error) { this.cache.delete(key); return (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'unknown' }; }
    const hit = this.cache.get(key);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.state;
    const state = await hashProjectFile(root, rel);
    if (state.kind !== 'unknown') {
      this.cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, state });
      const max = this.options.maxCache ?? 10_000;
      if (this.cache.size > max) for (const old of [...this.cache.keys()].slice(0, Math.ceil(max / 5))) this.cache.delete(old);
    }
    return state;
  }

  /** Returns the ids of entries whose stale state changed. */
  scan(project: { id: string; path: string }, options: ScanOptions = {}): Promise<string[]> {
    const state = this.state.get(project.id) ?? { lastEnd: 0, cursor: 0 };
    this.state.set(project.id, state);
    if (state.flight) return state.flight;
    if (!options.force && Date.now() - state.lastEnd < (this.options.minIntervalMs ?? 3_000)) return Promise.resolve([]);
    const flight = this.run(project, state, options.budgetMs ?? this.options.budgetMs ?? 200)
      .finally(() => { state.lastEnd = Date.now(); delete state.flight; });
    state.flight = flight;
    return flight;
  }

  private async run(project: { id: string; path: string }, scan: ScanState, budgetMs: number): Promise<string[]> {
    const entries = this.repo.listEntries(project.id, 'live').filter((entry) => entry.files.length);
    if (!entries.length) return [];
    const unique = [...new Set(entries.flatMap((entry) => entry.files.map((file) => file.path)))].sort();
    const start = unique.length ? scan.cursor % unique.length : 0;
    const order = [...unique.slice(start), ...unique.slice(0, start)];
    const deadline = Date.now() + budgetMs;
    const concurrency = this.options.concurrency ?? 32;
    const known = new Map<string, FileState>();
    let done = 0;
    while (done < order.length && Date.now() < deadline) {
      const batch = order.slice(done, done + concurrency);
      const states = await Promise.all(batch.map((rel) => this.current(project.path, rel)));
      batch.forEach((rel, index) => known.set(rel, states[index]!));
      done += batch.length;
    }
    scan.cursor = done >= order.length ? 0 : (start + done) % unique.length;
    const changed: string[] = [];
    const now = this.options.nowIso();
    for (const entry of entries) {
      const next = this.evaluate(entry, known, now);
      if (next === undefined) continue;
      const strip = (value: EntryRow['stale']) => JSON.stringify(value && { reason: value.reason, paths: value.paths });
      if (strip(next) === strip(entry.stale)) continue;
      this.repo.setStale(entry.id, next);
      changed.push(entry.id);
    }
    return changed;
  }

  /** `undefined` leaves the entry's state alone (not enough was checked to clear it). */
  private evaluate(entry: EntryRow, known: Map<string, FileState>, now: string): EntryRow['stale'] | undefined {
    const moved: string[] = [];
    let checked = 0;
    for (const file of entry.files) {
      const state = known.get(file.path);
      if (!state || state.kind === 'unknown') continue;
      checked++;
      if (state.kind === 'missing' || (state.hash !== file.revision && state.hash !== file.baseRevision)) moved.push(file.path);
    }
    if (moved.length) {
      const deleted = moved.filter((rel) => known.get(rel)?.kind === 'missing').length;
      const reason = `${moved.length} referenced file${moved.length === 1 ? '' : 's'} changed${deleted ? ` (${deleted} deleted)` : ''} since this was recorded`;
      return { since: entry.stale?.since ?? now, reason, paths: moved.slice(0, 8) };
    }
    return checked === entry.files.length ? null : undefined;
  }

  forget(projectId: string): void { this.state.delete(projectId); }
}
