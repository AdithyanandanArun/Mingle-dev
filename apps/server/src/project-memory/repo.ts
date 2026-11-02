import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  ProjectMemoryAuthor, ProjectMemoryEntry, ProjectMemoryFileRef, ProjectMemoryInjection, ProjectMemoryOp,
  ProjectMemoryRevision, ProjectMemoryRevisionSnapshot, ProjectMemorySourceRef,
} from '@mingle/contracts';
import type { ProjectMemoryCausalProof, ProjectMemoryLineage } from '@mingle/contracts';
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
  lineage?: ProjectMemoryLineage; causalProof?: ProjectMemoryCausalProof; causalValid: boolean;
}

export interface SyncStateRow { projectId: string; lastBackfillAt: string | null; lastReceivedAt: string | null; error: string | null; tombstoneFloorAt: string | null }

/** Body-free material retained for a locally authored revision until its device can sign the ancestry proof. */
export interface CausalProofBasis {
  recordId: string; entryId: string; parentId: string | null; parentRevision: number | null; revision: number;
  op: ProjectMemoryOp; authorKind: ProjectMemoryAuthor['kind']; author: ProjectMemoryAuthor;
  controlId: string | null; epoch: number; pinned: boolean; retired: boolean; humanVerified: boolean;
}

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
    lineage: row.lineage_json ? json(row.lineage_json) : undefined,
    causalProof: row.causal_proof_json ? json(row.causal_proof_json) : undefined,
    causalValid: row.causal_state === 'valid',
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
        author_device_id TEXT, signature TEXT, team_id TEXT, shared_project_id TEXT, published_at TEXT, lineage_json TEXT, causal_proof_json TEXT, causal_state TEXT
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
      CREATE TABLE IF NOT EXISTS mingle_project_memory_retired_ids (project_id TEXT NOT NULL, entry_id TEXT NOT NULL, retired_at TEXT NOT NULL, PRIMARY KEY(project_id,entry_id));
      CREATE TABLE IF NOT EXISTS mingle_project_memory_causality (record_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, parent_id TEXT, control_id TEXT, epoch INTEGER NOT NULL, human INTEGER NOT NULL, proof_json TEXT, valid INTEGER NOT NULL DEFAULT 0);
    `);
    const cols = this.db.prepare('PRAGMA table_info(mingle_project_memory_revisions)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'lineage_json')) this.db.exec('ALTER TABLE mingle_project_memory_revisions ADD COLUMN lineage_json TEXT');
    if (!cols.some((c) => c.name === 'causal_proof_json')) this.db.exec('ALTER TABLE mingle_project_memory_revisions ADD COLUMN causal_proof_json TEXT');
    if (!cols.some((c) => c.name === 'causal_state')) this.db.exec("ALTER TABLE mingle_project_memory_revisions ADD COLUMN causal_state TEXT NOT NULL DEFAULT 'legacy'");
    const causalCols = this.db.prepare('PRAGMA table_info(mingle_project_memory_causality)').all() as Array<{ name: string }>;
    if (!causalCols.some((c) => c.name === 'proof_json')) this.db.exec('ALTER TABLE mingle_project_memory_causality ADD COLUMN proof_json TEXT');
    if (!causalCols.some((c) => c.name === 'valid')) this.db.exec('ALTER TABLE mingle_project_memory_causality ADD COLUMN valid INTEGER NOT NULL DEFAULT 0');
    if (!causalCols.some((c) => c.name === 'basis_json')) this.db.exec('ALTER TABLE mingle_project_memory_causality ADD COLUMN basis_json TEXT');
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
      (record_id,entry_id,project_id,revision,parent_revision,op,at,created_at,author_json,note,snapshot_json,changed_json,received,author_device_id,signature,team_id,shared_project_id,published_at,lineage_json,causal_proof_json,causal_state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(record.recordId, record.entryId, record.projectId, record.revision, record.parentRevision, record.op, record.at, record.createdAt,
        JSON.stringify(record.author), record.note, JSON.stringify(record.snapshot), JSON.stringify(record.changed), record.received ? 1 : 0,
        record.authorDeviceId, record.signature, record.teamId, record.sharedProjectId, record.publishedAt, record.lineage ? JSON.stringify(record.lineage) : null,
        record.causalProof ? JSON.stringify(record.causalProof) : null, record.causalProof ? (record.causalValid ? 'valid' : 'pending') : 'legacy');
    if (record.causalProof) this.saveCausalProof(record.causalProof, record.causalValid);
    // Local pre-proof rows are trusted durable state. A legacy peer's signed lineage is still an assertion, not a validated ancestry chain.
    else if (record.lineage && !record.received) {
      const basis: CausalProofBasis = {
        recordId: record.recordId, entryId: record.entryId, parentId: record.lineage.parentId, parentRevision: record.parentRevision,
        revision: record.revision, op: record.op, authorKind: record.author.kind, author: record.author,
        controlId: record.lineage.controlId, epoch: record.lineage.epoch, pinned: record.snapshot.pinned,
        retired: record.snapshot.retired, humanVerified: record.snapshot.humanVerified,
      };
      this.db.prepare(`INSERT OR REPLACE INTO mingle_project_memory_causality
        (record_id,entry_id,parent_id,control_id,epoch,human,proof_json,valid,basis_json) VALUES (?,?,?,?,?,?,NULL,1,?)`)
        .run(record.recordId, record.entryId, record.lineage.parentId, record.lineage.controlId, record.lineage.epoch,
          record.author.kind === 'human' ? 1 : 0, JSON.stringify(basis));
    }
  }

  lineageFor(id: string): ProjectMemoryLineage | undefined {
    const proof = this.causalProofFor(id);
    if (proof?.valid) return { parentId: proof.proof.parentId, controlId: proof.proof.controlId, epoch: proof.proof.epoch };
    const row = this.one('SELECT parent_id,control_id,epoch FROM mingle_project_memory_causality WHERE record_id=? AND valid=1', id);
    return row ? { parentId: (row.parent_id as string | null) ?? null, controlId: (row.control_id as string | null) ?? null, epoch: Number(row.epoch) } : undefined;
  }
  causalProofFor(id: string): { proof: ProjectMemoryCausalProof; valid: boolean; invalid: boolean } | undefined {
    const row = this.one('SELECT proof_json,valid FROM mingle_project_memory_causality WHERE record_id=?', id);
    return row?.proof_json ? { proof: json(row.proof_json), valid: row.valid === 1, invalid: row.valid === 2 } : undefined;
  }
  saveCausalProof(proof: ProjectMemoryCausalProof, valid: boolean): void {
    this.db.prepare('INSERT INTO mingle_project_memory_causality (record_id,entry_id,parent_id,control_id,epoch,human,proof_json,valid) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET proof_json=excluded.proof_json,valid=MAX(valid,excluded.valid)')
      .run(proof.recordId, proof.entryId, proof.parentId, proof.controlId, proof.epoch, proof.authorKind === 'human' ? 1 : 0, JSON.stringify(proof), valid ? 1 : 0);
    this.db.prepare('UPDATE mingle_project_memory_revisions SET causal_proof_json=?,causal_state=? WHERE record_id=?')
      .run(JSON.stringify(proof), valid ? 'valid' : 'pending', proof.recordId);
  }
  markCausalValid(recordId: string): void {
    this.db.prepare("UPDATE mingle_project_memory_revisions SET causal_state='valid' WHERE record_id=?").run(recordId);
    this.db.prepare('UPDATE mingle_project_memory_causality SET valid=1 WHERE record_id=?').run(recordId);
  }
  markCausalInvalid(recordId: string): void {
    this.db.prepare("UPDATE mingle_project_memory_revisions SET causal_state='invalid' WHERE record_id=?").run(recordId);
    // 0 = pending, 1 = valid, 2 = permanently invalid; invalid proofs must not be retried by pending resolution.
    this.db.prepare('UPDATE mingle_project_memory_causality SET valid=2 WHERE record_id=?').run(recordId);
  }
  pendingCausalProofs(entryId: string): ProjectMemoryCausalProof[] {
    return this.all('SELECT proof_json FROM mingle_project_memory_causality WHERE entry_id=? AND valid=0 AND proof_json IS NOT NULL', entryId)
      .flatMap((row) => row.proof_json ? [json<ProjectMemoryCausalProof>(row.proof_json)] : []);
  }
  pendingCausalRecords(entryId: string): RevisionRow[] {
    return this.all("SELECT * FROM mingle_project_memory_revisions WHERE entry_id=? AND causal_state='pending' ORDER BY revision,at,record_id", entryId).map(revisionRow);
  }
  causalProofs(ids: string[]): ProjectMemoryCausalProof[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.all(`SELECT proof_json FROM mingle_project_memory_causality WHERE valid=1 AND record_id IN (${placeholders})`, ...ids)
      .flatMap((row) => row.proof_json ? [json<ProjectMemoryCausalProof>(row.proof_json)] : []);
  }
  unsignedCausalProofBases(projectId: string, ids: string[]): CausalProofBasis[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.all(`SELECT c.basis_json FROM mingle_project_memory_causality c
      JOIN mingle_project_memory_entries e ON e.id=c.entry_id
      WHERE e.project_id=? AND c.record_id IN (${placeholders}) AND c.proof_json IS NULL AND c.valid=1`, projectId, ...ids)
      .flatMap((row) => row.basis_json ? [json<CausalProofBasis>(row.basis_json)] : []);
  }
  validRecords(entryId: string): RevisionRow[] {
    return this.all("SELECT * FROM mingle_project_memory_revisions WHERE entry_id=? AND causal_state IN ('valid','legacy') ORDER BY revision,at,record_id", entryId).map(revisionRow);
  }
  entryRecordById(recordId: string): RevisionRow | undefined { return this.getRecord(recordId); }
  hasRetiredId(projectId: string, entryId: string): boolean { return Boolean(this.one('SELECT 1 AS x FROM mingle_project_memory_retired_ids WHERE project_id=? AND entry_id=?', projectId, entryId)); }
  markRetiredId(projectId: string, entryId: string, at: string): void { this.db.prepare('INSERT OR IGNORE INTO mingle_project_memory_retired_ids VALUES (?,?,?)').run(projectId, entryId, at); }

  /** Newest first. */
  listRecords(entryId: string, limit: number, offset: number): RevisionRow[] {
    return this.all('SELECT * FROM mingle_project_memory_revisions WHERE entry_id=? ORDER BY revision DESC, at DESC, record_id DESC LIMIT ? OFFSET ?', entryId, limit, offset).map(revisionRow);
  }
  countRecords(entryId: string): number { return Number(this.one('SELECT COUNT(*) AS n FROM mingle_project_memory_revisions WHERE entry_id=?', entryId)?.n ?? 0); }

  /** Preserve the first body, selected head and unresolved descendants; fill the remaining budget with recent history. */
  pruneRecords(entryId: string, keep = PROJECT_MEMORY_LIMITS.maxRevisionsPerEntry): number {
    const rows = this.listRecords(entryId, Number.MAX_SAFE_INTEGER, 0);
    const protectedIds = new Set<string>();
    const head = this.getEntry(entryId);
    if (head) protectedIds.add(head.headRecordId);
    const first = rows.at(-1);
    if (first) protectedIds.add(first.recordId);
    for (const row of this.pendingCausalRecords(entryId)) protectedIds.add(row.recordId);
    const retained = new Set(protectedIds);
    for (const row of rows) { if (retained.size >= keep) break; retained.add(row.recordId); }
    const remove = this.db.prepare('DELETE FROM mingle_project_memory_revisions WHERE entry_id=? AND record_id=?');
    let count = 0;
    for (const row of rows) if (!retained.has(row.recordId)) count += Number(remove.run(entryId, row.recordId).changes);
    return count;
  }

  markSigned(recordId: string, teamId: string, sharedProjectId: string, authorDeviceId: string, signature: string, author: ProjectMemoryAuthor, proof?: ProjectMemoryCausalProof): void {
    this.db.prepare('UPDATE mingle_project_memory_revisions SET team_id=?, shared_project_id=?, author_device_id=?, signature=?, author_json=?,causal_proof_json=? WHERE record_id=?')
      .run(teamId, sharedProjectId, authorDeviceId, signature, JSON.stringify(author), proof ? JSON.stringify(proof) : null, recordId);
    if (proof) this.saveCausalProof(proof, true);
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
  signedRecordsByIds(projectId: string, sharedProjectId: string, ids: string[]): RevisionRow[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.all(`SELECT * FROM mingle_project_memory_revisions WHERE project_id=? AND shared_project_id=? AND signature IS NOT NULL AND record_id IN (${placeholders})`,
      projectId, sharedProjectId, ...ids).map(revisionRow);
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
