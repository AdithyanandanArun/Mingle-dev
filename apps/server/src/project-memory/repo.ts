import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  ProjectMemoryAuthor, ProjectMemoryEntry, ProjectMemoryFileRef, ProjectMemoryInjection, ProjectMemoryOp,
  ProjectMemoryRevision, ProjectMemoryRevisionSnapshot, ProjectMemorySourceRef,
} from '@mingle/contracts';
import { PROJECT_MEMORY_LIMITS } from '@mingle/contracts';

type Row = Record<string, unknown>;

export interface EntryRow {
  id: string; projectId: string; kind: ProjectMemoryEntry['kind']; title: string; body: string;
  status: ProjectMemoryEntry['status']; pinned: boolean; humanVerified: boolean; revision: number;
  retired: boolean; retiredAt: string | null; retiredByHuman: boolean;
  createdAt: string; updatedAt: string; author: ProjectMemoryAuthor; updatedBy: ProjectMemoryAuthor;
  files: ProjectMemoryFileRef[]; sources: ProjectMemorySourceRef[];
  titleKey: string; bodyKey: string; headRecordId: string; headAt: string; originDeviceId: string | null;
  stale: ProjectMemoryEntry['stale'];
}

export interface RevisionRow {
  recordId: string; entryId: string; projectId: string; revision: number; parentRevision: number | null; op: ProjectMemoryOp;
  at: string; createdAt: string; author: ProjectMemoryAuthor; note: string | null; snapshot: ProjectMemoryRevisionSnapshot;
  changed: ProjectMemoryRevision['changed']; received: boolean; authorDeviceId: string | null; signature: string | null;
  teamId: string | null; sharedProjectId: string | null; publishedAt: string | null;
}

export interface SyncStateRow { projectId: string; lastBackfillAt: string | null; lastReceivedAt: string | null; error: string | null; tombstoneFloorAt: string | null }

const json = <T>(value: unknown): T => JSON.parse(String(value)) as T;

function entryRow(row: Row): EntryRow {
  return {
    id: String(row.id), projectId: String(row.project_id), kind: row.kind as EntryRow['kind'], title: String(row.title), body: String(row.body),
    status: row.status as EntryRow['status'], pinned: row.pinned === 1, humanVerified: row.human_verified === 1, revision: Number(row.revision),
    retired: row.retired === 1, retiredAt: (row.retired_at as string | null) ?? null, retiredByHuman: row.retired_by_human === 1,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), author: json(row.author_json), updatedBy: json(row.updated_by_json),
    files: json(row.files_json), sources: json(row.sources_json), titleKey: String(row.title_key), bodyKey: String(row.body_key),
    headRecordId: String(row.head_record_id), headAt: String(row.head_at), originDeviceId: (row.origin_device_id as string | null) ?? null,
    stale: row.stale_json ? json(row.stale_json) : null,
  };
}

function revisionRow(row: Row): RevisionRow {
  return {
    recordId: String(row.record_id), entryId: String(row.entry_id), projectId: String(row.project_id), revision: Number(row.revision),
    parentRevision: row.parent_revision === null ? null : Number(row.parent_revision), op: row.op as ProjectMemoryOp,
    at: String(row.at), createdAt: String(row.created_at), author: json(row.author_json), note: (row.note as string | null) ?? null,
    snapshot: json(row.snapshot_json), changed: json(row.changed_json), received: row.received === 1,
    authorDeviceId: (row.author_device_id as string | null) ?? null, signature: (row.signature as string | null) ?? null,
    teamId: (row.team_id as string | null) ?? null, sharedProjectId: (row.shared_project_id as string | null) ?? null,
    publishedAt: (row.published_at as string | null) ?? null,
  };
}

/** Persistence for project memory. All tables are `mingle_project_memory_*` and created idempotently. */
export class MemoryRepo {
  constructor(readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mingle_project_memory_entries (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, human_verified INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL, retired INTEGER NOT NULL DEFAULT 0, retired_at TEXT, retired_by_human INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, author_json TEXT NOT NULL, updated_by_json TEXT NOT NULL,
        files_json TEXT NOT NULL, sources_json TEXT NOT NULL, title_key TEXT NOT NULL, body_key TEXT NOT NULL,
        head_record_id TEXT NOT NULL, head_at TEXT NOT NULL, origin_device_id TEXT, stale_json TEXT
      );
      CREATE INDEX IF NOT EXISTS mingle_project_memory_entries_project ON mingle_project_memory_entries(project_id, retired, pinned, updated_at DESC);
      CREATE TABLE IF NOT EXISTS mingle_project_memory_revisions (
        record_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
        parent_revision INTEGER, op TEXT NOT NULL, at TEXT NOT NULL, created_at TEXT NOT NULL, author_json TEXT NOT NULL,
        note TEXT, snapshot_json TEXT NOT NULL, changed_json TEXT NOT NULL, received INTEGER NOT NULL DEFAULT 0,
        author_device_id TEXT, signature TEXT, team_id TEXT, shared_project_id TEXT, published_at TEXT
      );
      CREATE INDEX IF NOT EXISTS mingle_project_memory_revisions_entry ON mingle_project_memory_revisions(entry_id, revision DESC, at DESC);
      CREATE INDEX IF NOT EXISTS mingle_project_memory_revisions_project ON mingle_project_memory_revisions(project_id, at, record_id);
      CREATE TABLE IF NOT EXISTS mingle_project_memory_injections (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL,
        at TEXT NOT NULL, query TEXT NOT NULL, entries_json TEXT NOT NULL, chars INTEGER NOT NULL, truncated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mingle_project_memory_injections_session ON mingle_project_memory_injections(session_id, seq DESC);
      CREATE TABLE IF NOT EXISTS mingle_project_memory_sync (
        project_id TEXT PRIMARY KEY, last_backfill_at TEXT, last_received_at TEXT, error TEXT, tombstone_floor_at TEXT
      );
    `);
  }

  tx<T>(fn: () => T): T {
    this.db.exec('SAVEPOINT memory_tx');
    try { const value = fn(); this.db.exec('RELEASE memory_tx'); return value; }
    catch (error) { this.db.exec('ROLLBACK TO memory_tx'); this.db.exec('RELEASE memory_tx'); throw error; }
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...params) as Row | undefined; }

  getEntry(id: string): EntryRow | undefined { const row = this.one('SELECT * FROM mingle_project_memory_entries WHERE id=?', id); return row ? entryRow(row) : undefined; }
  listEntries(projectId: string, include: 'live' | 'retired' | 'all' = 'all'): EntryRow[] {
    const clause = include === 'live' ? 'AND retired=0' : include === 'retired' ? 'AND retired=1' : '';
    return this.all(`SELECT * FROM mingle_project_memory_entries WHERE project_id=? ${clause} ORDER BY pinned DESC, updated_at DESC, id`, projectId).map(entryRow);
  }
  liveCount(projectId: string): number { return Number(this.one('SELECT COUNT(*) AS n FROM mingle_project_memory_entries WHERE project_id=? AND retired=0', projectId)?.n ?? 0); }
  tombstoneCount(projectId: string): number { return Number(this.one('SELECT COUNT(*) AS n FROM mingle_project_memory_entries WHERE project_id=? AND retired=1', projectId)?.n ?? 0); }

  upsertEntry(entry: EntryRow): void {
    this.db.prepare(`INSERT INTO mingle_project_memory_entries
      (id,project_id,kind,title,body,status,pinned,human_verified,revision,retired,retired_at,retired_by_human,created_at,updated_at,author_json,updated_by_json,
       files_json,sources_json,title_key,body_key,head_record_id,head_at,origin_device_id,stale_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,body=excluded.body,status=excluded.status,pinned=excluded.pinned,
        human_verified=excluded.human_verified,revision=excluded.revision,retired=excluded.retired,retired_at=excluded.retired_at,
        retired_by_human=excluded.retired_by_human,updated_at=excluded.updated_at,updated_by_json=excluded.updated_by_json,
        files_json=excluded.files_json,sources_json=excluded.sources_json,title_key=excluded.title_key,body_key=excluded.body_key,
        head_record_id=excluded.head_record_id,head_at=excluded.head_at,origin_device_id=excluded.origin_device_id,stale_json=excluded.stale_json`)
      .run(entry.id, entry.projectId, entry.kind, entry.title, entry.body, entry.status, entry.pinned ? 1 : 0, entry.humanVerified ? 1 : 0, entry.revision,
        entry.retired ? 1 : 0, entry.retiredAt, entry.retiredByHuman ? 1 : 0, entry.createdAt, entry.updatedAt, JSON.stringify(entry.author),
        JSON.stringify(entry.updatedBy), JSON.stringify(entry.files), JSON.stringify(entry.sources), entry.titleKey, entry.bodyKey,
        entry.headRecordId, entry.headAt, entry.originDeviceId, entry.stale ? JSON.stringify(entry.stale) : null);
  }

  setStale(id: string, stale: EntryRow['stale']): void {
    this.db.prepare('UPDATE mingle_project_memory_entries SET stale_json=? WHERE id=?').run(stale ? JSON.stringify(stale) : null, id);
  }

  deleteEntry(id: string): void {
    this.db.prepare('DELETE FROM mingle_project_memory_revisions WHERE entry_id=?').run(id);
    this.db.prepare('DELETE FROM mingle_project_memory_entries WHERE id=?').run(id);
  }

  /** Oldest tombstones beyond the cap, oldest first. */
  excessTombstones(projectId: string, keep: number): EntryRow[] {
    return this.all(`SELECT * FROM mingle_project_memory_entries WHERE project_id=? AND retired=1 ORDER BY retired_at ASC, id ASC LIMIT
      MAX(0, (SELECT COUNT(*) FROM mingle_project_memory_entries WHERE project_id=? AND retired=1) - ?)`, projectId, projectId, keep).map(entryRow);
  }

  hasRecord(recordId: string): boolean { return Boolean(this.one('SELECT 1 AS x FROM mingle_project_memory_revisions WHERE record_id=?', recordId)); }
  getRecord(recordId: string): RevisionRow | undefined { const row = this.one('SELECT * FROM mingle_project_memory_revisions WHERE record_id=?', recordId); return row ? revisionRow(row) : undefined; }
  entryRecordForRevision(entryId: string, revision: number): RevisionRow[] {
    return this.all('SELECT * FROM mingle_project_memory_revisions WHERE entry_id=? AND revision=? ORDER BY at, record_id', entryId, revision).map(revisionRow);
  }

  insertRecord(record: RevisionRow): void {
    this.db.prepare(`INSERT INTO mingle_project_memory_revisions
      (record_id,entry_id,project_id,revision,parent_revision,op,at,created_at,author_json,note,snapshot_json,changed_json,received,author_device_id,signature,team_id,shared_project_id,published_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(record.recordId, record.entryId, record.projectId, record.revision, record.parentRevision, record.op, record.at, record.createdAt,
        JSON.stringify(record.author), record.note, JSON.stringify(record.snapshot), JSON.stringify(record.changed), record.received ? 1 : 0,
        record.authorDeviceId, record.signature, record.teamId, record.sharedProjectId, record.publishedAt);
  }

  /** Newest first. */
  listRecords(entryId: string, limit: number, offset: number): RevisionRow[] {
    return this.all('SELECT * FROM mingle_project_memory_revisions WHERE entry_id=? ORDER BY revision DESC, at DESC, record_id DESC LIMIT ? OFFSET ?', entryId, limit, offset).map(revisionRow);
  }
  countRecords(entryId: string): number { return Number(this.one('SELECT COUNT(*) AS n FROM mingle_project_memory_revisions WHERE entry_id=?', entryId)?.n ?? 0); }

  /** Keeps the first revision and the newest `keep - 1`; returns the number of rows removed. */
  pruneRecords(entryId: string, keep = PROJECT_MEMORY_LIMITS.maxRevisionsPerEntry): number {
    const result = this.db.prepare(`DELETE FROM mingle_project_memory_revisions WHERE entry_id=? AND record_id NOT IN (
      SELECT record_id FROM mingle_project_memory_revisions WHERE entry_id=? ORDER BY revision DESC, at DESC, record_id DESC LIMIT ?)
      AND record_id != (SELECT record_id FROM mingle_project_memory_revisions WHERE entry_id=? ORDER BY revision ASC, at ASC, record_id ASC LIMIT 1)`)
      .run(entryId, entryId, keep - 1, entryId);
    return Number(result.changes);
  }

  markSigned(recordId: string, teamId: string, sharedProjectId: string, authorDeviceId: string, signature: string, author: ProjectMemoryAuthor): void {
    this.db.prepare('UPDATE mingle_project_memory_revisions SET team_id=?, shared_project_id=?, author_device_id=?, signature=?, author_json=? WHERE record_id=?')
      .run(teamId, sharedProjectId, authorDeviceId, signature, JSON.stringify(author), recordId);
  }
  markPublished(recordId: string, at: string): void {
    this.db.prepare('UPDATE mingle_project_memory_revisions SET published_at=? WHERE record_id=?').run(at, recordId);
  }
  projectsWithMemory(): string[] {
    return this.all('SELECT DISTINCT project_id FROM mingle_project_memory_entries').map((row) => String(row.project_id));
  }
  /** Local unpublished records, oldest first. */
  unpublished(projectId: string, limit: number): RevisionRow[] {
    return this.all('SELECT * FROM mingle_project_memory_revisions WHERE project_id=? AND received=0 AND published_at IS NULL ORDER BY at, record_id LIMIT ?', projectId, limit).map(revisionRow);
  }
  unpublishedCount(projectId: string): number {
    return Number(this.one('SELECT COUNT(*) AS n FROM mingle_project_memory_revisions WHERE project_id=? AND received=0 AND published_at IS NULL', projectId)?.n ?? 0);
  }
  projectsWithUnpublished(): string[] {
    return this.all('SELECT DISTINCT project_id FROM mingle_project_memory_revisions WHERE received=0 AND published_at IS NULL').map((row) => String(row.project_id));
  }
  /** Signed records served to teammates, oldest first. `since` is exclusive. */
  signedRecordsSince(projectId: string, sharedProjectId: string, since: string | null, limit: number): RevisionRow[] {
    return this.all(`SELECT * FROM mingle_project_memory_revisions WHERE project_id=? AND shared_project_id=? AND signature IS NOT NULL
      AND author_device_id IS NOT NULL AND (? IS NULL OR at > ?) ORDER BY at, record_id LIMIT ?`, projectId, sharedProjectId, since, since, limit).map(revisionRow);
  }
  signedHeads(projectId: string, sharedProjectId: string, limit: number): RevisionRow[] {
    return this.all(`SELECT r.* FROM mingle_project_memory_revisions r JOIN mingle_project_memory_entries e ON e.head_record_id=r.record_id
      WHERE e.project_id=? AND r.shared_project_id=? AND r.signature IS NOT NULL AND r.author_device_id IS NOT NULL ORDER BY r.at, r.record_id LIMIT ?`,
    projectId, sharedProjectId, limit).map(revisionRow);
  }
  latestRecordAt(projectId: string): string | null {
    return (this.one('SELECT MAX(at) AS at FROM mingle_project_memory_revisions WHERE project_id=?', projectId)?.at as string | null) ?? null;
  }

  syncState(projectId: string): SyncStateRow {
    const row = this.one('SELECT * FROM mingle_project_memory_sync WHERE project_id=?', projectId);
    return { projectId, lastBackfillAt: (row?.last_backfill_at as string | null) ?? null, lastReceivedAt: (row?.last_received_at as string | null) ?? null,
      error: (row?.error as string | null) ?? null, tombstoneFloorAt: (row?.tombstone_floor_at as string | null) ?? null };
  }
  patchSyncState(projectId: string, patch: Partial<Omit<SyncStateRow, 'projectId'>>): void {
    const next = { ...this.syncState(projectId), ...patch };
    this.db.prepare(`INSERT INTO mingle_project_memory_sync (project_id,last_backfill_at,last_received_at,error,tombstone_floor_at) VALUES (?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET last_backfill_at=excluded.last_backfill_at,last_received_at=excluded.last_received_at,error=excluded.error,tombstone_floor_at=excluded.tombstone_floor_at`)
      .run(projectId, next.lastBackfillAt, next.lastReceivedAt, next.error, next.tombstoneFloorAt);
  }

  insertInjection(projectId: string, injection: ProjectMemoryInjection, keep = 200): void {
    this.db.prepare('INSERT INTO mingle_project_memory_injections (project_id,session_id,run_id,at,query,entries_json,chars,truncated) VALUES (?,?,?,?,?,?,?,?)')
      .run(projectId, injection.sessionId, injection.runId, injection.at, injection.query, JSON.stringify(injection.entries), injection.chars, injection.truncated ? 1 : 0);
    this.db.prepare(`DELETE FROM mingle_project_memory_injections WHERE project_id=? AND seq NOT IN (
      SELECT seq FROM mingle_project_memory_injections WHERE project_id=? ORDER BY seq DESC LIMIT ?)`).run(projectId, projectId, keep);
  }
  listInjections(sessionId: string, limit: number): ProjectMemoryInjection[] {
    return this.all('SELECT * FROM mingle_project_memory_injections WHERE session_id=? ORDER BY seq DESC LIMIT ?', sessionId, limit).map((row) => ({
      runId: String(row.run_id), sessionId: String(row.session_id), at: String(row.at), query: String(row.query),
      entries: json(row.entries_json), chars: Number(row.chars), truncated: row.truncated === 1,
    }));
  }
}
