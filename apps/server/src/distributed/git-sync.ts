import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { TeamArtifactRefSchema } from '../../../../packages/contracts/src/team-orchestration.ts';
import {
  DistributedRequestDecisionSchema, GitBundleChunkSchema, GitIntegrationRequestSchema,
  GitTransferOfferSchema, GitTransferRequestSchema, GitTransferResultSchema,
} from '../../../../packages/contracts/src/remote-git.ts';
import type { DistributedDeviceEnvelope, GitIntegrationRequestInput, GitRequestSnapshot, GitSyncSnapshot as GitSyncSnapshotType, GitTransferRequestInput } from '../../../../packages/contracts/src/remote-git.ts';
import { conflict, errorMessage, nowIso } from '../util.ts';
import {
  bindProject, BUNDLE_CHUNK_BYTES, currentUser, dbOf,
  ensureCommonTables, fingerprintRepository, insertAudit, MAX_BUNDLE_BYTES, parseJson, resolveProjectBinding,
  repositoryGit, validateEnvelope,
} from './git-common.ts';
import type { DistributedServiceOptions } from './git-common.ts';

const TABLE = 'mingle_git_requests';
const AUDIT = 'mingle_git_audit';
const TEAM_ARTIFACT_TABLE = 'mingle_git_team_artifacts';
const TEAM_ARTIFACT_CHUNK_TABLE = 'mingle_git_team_artifact_chunks';
const TeamArtifactOfferSchema = z.object({
  transferId: z.string().regex(/^[0-9a-f]{64}$/), sharedProjectId: z.string().trim().min(1).max(200),
  deliveryId: z.string().trim().min(1).max(100), revision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i),
  baseRevision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i).nullable(),
  taskId: z.string().trim().min(1).max(100).optional(), path: z.string().min(1).max(4096).optional(),
  bundleSha256: z.string().regex(/^[0-9a-f]{64}$/i), bundleSizeBytes: z.number().int().positive().max(MAX_BUNDLE_BYTES),
  chunkCount: z.number().int().positive().max(128),
}).strict();
const TeamArtifactChunkSchema = z.object({
  transferId: z.string().regex(/^[0-9a-f]{64}$/), index: z.number().int().min(0).max(127),
  chunkCount: z.number().int().positive().max(128), data: z.string().min(1).max(350_000),
}).strict();
type TeamArtifactOffer = z.infer<typeof TeamArtifactOfferSchema>;
type TeamArtifactRef = z.infer<typeof TeamArtifactRefSchema>;
type TeamArtifactRow = {
  transfer_id: string; team_id: string; shared_project_id: string; delivery_id: string; source_device_id: string;
  peer_device_id: string; direction: 'incoming' | 'outgoing'; owner_id: string; status: string; offer_json: string;
  bundle_blob: Uint8Array | null; ref_name: string | null; created_at: string; updated_at: string;
};
interface GitRequestRow {
  id: string; team_id: string; shared_project_id: string; owner_id: string; peer_device_id: string;
  direction: 'incoming' | 'outgoing' | 'local'; kind: 'transfer' | 'integration'; status: string; operation_key: string | null;
  external_id: string | null; payload_json: string; request_digest: string; bundle_blob: Uint8Array | null;
  bundle_sha256: string | null; bundle_size_bytes: number | null; source_head: string | null; base_head: string | null;
  branch: string | null; expected_head: string | null; expected_fingerprint: string | null; conflict_paths_json: string;
  notices_json: string; source_approved: number; destination_approved: number; created_at: string; updated_at: string;
}

interface TransferOfferPayload {
  requestId: string; sharedProjectId: string; sourceHead: string; baseHead: string | null; branch: string | null;
  bundleSha256: string; bundleSizeBytes: number; chunkCount: number;
}

export interface GitSyncServiceOptions extends DistributedServiceOptions {}

/** Local-owner-controlled bundle handoff and explicitly approved repository integration. */
export class GitSyncService {
  private readonly db: DatabaseSync;
  constructor(private readonly options: GitSyncServiceOptions) {
    this.db = dbOf(options.store);
    ensureCommonTables(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        peer_device_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing','local')),
        kind TEXT NOT NULL CHECK(kind IN ('transfer','integration')), status TEXT NOT NULL, operation_key TEXT,
        external_id TEXT, payload_json TEXT NOT NULL, request_digest TEXT NOT NULL, bundle_blob BLOB,
        bundle_sha256 TEXT, bundle_size_bytes INTEGER, source_head TEXT, base_head TEXT, branch TEXT,
        expected_head TEXT, expected_fingerprint TEXT, conflict_paths_json TEXT NOT NULL DEFAULT '[]',
        notices_json TEXT NOT NULL DEFAULT '[]', source_approved INTEGER NOT NULL DEFAULT 0, destination_approved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(direction,peer_device_id,external_id), UNIQUE(owner_id,team_id,shared_project_id,kind,operation_key)
      );
      CREATE INDEX IF NOT EXISTS mingle_git_requests_recent ON ${TABLE}(team_id, shared_project_id, created_at);
      CREATE TABLE IF NOT EXISTS mingle_git_chunks (
        request_id TEXT NOT NULL REFERENCES ${TABLE}(id), chunk_index INTEGER NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY(request_id,chunk_index)
      );
      CREATE TABLE IF NOT EXISTS ${AUDIT} (
        id TEXT PRIMARY KEY, request_id TEXT, action TEXT NOT NULL, actor_device_id TEXT, digest TEXT,
        details_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS mingle_git_audit_no_update BEFORE UPDATE ON ${AUDIT} BEGIN SELECT RAISE(ABORT, 'Git audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS mingle_git_audit_no_delete BEFORE DELETE ON ${AUDIT} BEGIN SELECT RAISE(ABORT, 'Git audit is append-only'); END;
      CREATE TABLE IF NOT EXISTS ${TEAM_ARTIFACT_TABLE} (
        transfer_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
        source_device_id TEXT NOT NULL, peer_device_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
        owner_id TEXT NOT NULL, status TEXT NOT NULL, offer_json TEXT NOT NULL, bundle_blob BLOB,
        ref_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(direction,source_device_id,transfer_id)
      );
      CREATE INDEX IF NOT EXISTS mingle_git_team_artifact_delivery ON ${TEAM_ARTIFACT_TABLE}(team_id,shared_project_id,delivery_id);
      CREATE TABLE IF NOT EXISTS ${TEAM_ARTIFACT_CHUNK_TABLE} (
        transfer_id TEXT NOT NULL REFERENCES ${TEAM_ARTIFACT_TABLE}(transfer_id), chunk_index INTEGER NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY(transfer_id,chunk_index)
      );
    `);
    this.recoverDispatched();
  }

  private recoverDispatched(): void {
    const rows = this.db.prepare(`SELECT id FROM ${TABLE} WHERE status IN ('dispatched','importing')`).all() as Array<{ id: string }>;
    for (const { id } of rows) {
      this.db.prepare(`UPDATE ${TABLE} SET status='unknown', updated_at=? WHERE id=?`).run(nowIso(), id);
      insertAudit(this.db, AUDIT, { requestId: id, action: 'recovered-unknown', details: { reason: 'A transfer or Git mutation was active during restart; it will not be replayed.' } });
    }
  }

  async bindProject(input: unknown) { return bindProject(this.options, this.db, input); }

  async snapshot(teamId?: string): Promise<GitSyncSnapshotType> {
    const owner = await currentUser(this.options.account);
    if (teamId) await this.options.authorizeTeam({ teamId });
    const scopeRows = this.db.prepare(`SELECT team_id,peer_device_id FROM ${TABLE} WHERE owner_id=?${teamId ? ' AND team_id=?' : ''}`)
      .all(...(teamId ? [owner.id, teamId] : [owner.id])) as Array<{ team_id: string; peer_device_id: string }>;
    const bindingScopes = this.db.prepare(`SELECT DISTINCT team_id FROM mingle_distributed_project_bindings WHERE owner_id=?${teamId ? ' AND team_id=?' : ''}`)
      .all(...(teamId ? [owner.id, teamId] : [owner.id])) as Array<{ team_id: string }>;
    const allowedTeams = new Set<string>();
    for (const id of new Set([...scopeRows.map((row) => row.team_id), ...bindingScopes.map((row) => row.team_id)])) {
      try { await this.options.authorizeTeam({ teamId: id }); allowedTeams.add(id); } catch { /* revoked teams are omitted from snapshots */ }
    }
    const allowedPeers = new Set(scopeRows.filter((row) => allowedTeams.has(row.team_id)).map((row) => `${row.team_id}\0${row.peer_device_id}`));
    for (const row of scopeRows) {
      if (!allowedTeams.has(row.team_id)) continue;
      try { await this.options.authorizeTeam({ teamId: row.team_id, peerDeviceId: row.peer_device_id }); }
      catch { allowedPeers.delete(`${row.team_id}\0${row.peer_device_id}`); }
    }
    const teamIds = [...allowedTeams];
    if (!teamIds.length) return { bindings: [], requests: [], audit: [] };
    const teamPlaceholders = teamIds.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT team_id,shared_project_id,local_project_id,canonical_path,owner_id,updated_at
      FROM mingle_distributed_project_bindings WHERE owner_id=? AND team_id IN (${teamPlaceholders}) ORDER BY updated_at DESC LIMIT 500`)
      .all(owner.id, ...teamIds) as Array<Record<string, unknown>>;
    const requests = (this.db.prepare(`SELECT * FROM ${TABLE} WHERE owner_id=? AND team_id IN (${teamPlaceholders}) ORDER BY created_at DESC LIMIT 500`)
      .all(owner.id, ...teamIds) as unknown as GitRequestRow[]).filter((row) => allowedPeers.has(`${row.team_id}\0${row.peer_device_id}`));
    const requestIds = new Set(requests.map((row) => row.id));
    const auditRows = this.db.prepare(`SELECT a.id,a.request_id,a.action,a.actor_device_id,a.digest,a.details_json,a.created_at
      FROM ${AUDIT} a JOIN ${TABLE} r ON r.id=a.request_id WHERE r.owner_id=? AND r.team_id IN (${teamPlaceholders}) ORDER BY a.rowid DESC LIMIT 2000`)
      .all(owner.id, ...teamIds) as Array<Record<string, unknown>>;
    const audit = auditRows.filter((row) => requestIds.has(row.request_id as string)).slice(0, 500).map((row) => ({
      id: row.id as string, requestId: (row.request_id as string | null) ?? null, action: row.action as string,
      actorDeviceId: (row.actor_device_id as string | null) ?? null, digest: (row.digest as string | null) ?? null,
      details: parseJson<Record<string, unknown>>(row.details_json, 'audit details'), createdAt: row.created_at as string,
    }));
    return {
      bindings: rows.map((row) => ({ teamId: row.team_id as string, sharedProjectId: row.shared_project_id as string,
        localProjectId: row.local_project_id as string, canonicalPath: row.canonical_path as string,
        ownerId: row.owner_id as string, updatedAt: row.updated_at as string })),
      requests: requests.map((row) => this.mapRequest(row)), audit,
    };
  }

  async request(input: GitTransferRequestInput | unknown): Promise<GitRequestSnapshot> {
    const parsed = GitTransferRequestSchema.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid Git transfer request: ${parsed.error.issues[0]?.message ?? 'schema validation failed'}`);
    const request = parsed.data;
    const owner = await currentUser(this.options.account);
    const deviceId = this.localDeviceId(request.teamId);
    if (request.toDeviceId === deviceId) throw new Error('A Git transfer must target another linked device.');
    await this.options.authorizeTeam({ teamId: request.teamId, peerDeviceId: request.toDeviceId });
    const existing = request.idempotencyKey ? this.findOperation(owner.id, request.teamId, request.sharedProjectId, 'transfer', request.idempotencyKey) : undefined;
    if (existing) {
      const prior = parseJson<TransferOfferPayload>(existing.payload_json, 'transfer offer');
      if (existing.peer_device_id !== request.toDeviceId || prior.sourceHead !== request.expectedHead.toLowerCase()
        || prior.baseHead !== (request.baseHead?.toLowerCase() ?? null) || (request.branch !== undefined && prior.branch !== request.branch)) {
        throw conflict('This idempotency key was already used for a different Git transfer request.');
      }
      return this.mapRequest(existing);
    }
    const binding = await resolveProjectBinding(this.options, this.db, request, owner.id);
    const state = await fingerprintRepository(binding.canonicalPath, this.options.repository);
    if (state.head.toLowerCase() !== request.expectedHead.toLowerCase()) throw conflict('Repository HEAD changed before the Git bundle was prepared. Refresh and retry.');
    if (request.baseHead) {
      const ancestor = await repositoryGit(this.options.repository, binding.canonicalPath, ['merge-base', '--is-ancestor', request.baseHead, request.expectedHead], { allowFailure: true });
      if (ancestor.code !== 0) throw conflict('The bundle base must be an ancestor of the selected source HEAD.');
    }
    const branch = request.branch ?? state.branch;
    if (branch) {
      const valid = await repositoryGit(this.options.repository, binding.canonicalPath, ['check-ref-format', `refs/heads/${branch}`], { allowFailure: true, maxOutputBytes: 4096 });
      if (valid.code !== 0) throw new Error('Branch label is not a valid Git branch name.');
    }
    const id = randomUUID().replaceAll('-', '');
    const temp = await mkdtemp(path.join(os.tmpdir(), 'mingle-git-bundle-'));
    const bundlePath = path.join(temp, 'handoff.bundle');
    let bundle: Buffer;
    try {
      // A named ref ensures bundle advertises a head even when the selected commit is supplied by object ID.
      const sourceRef = state.branch ? `refs/heads/${state.branch}` : request.expectedHead;
      const revs = request.baseHead ? [sourceRef, `^${request.baseHead}`] : [sourceRef];
      await repositoryGit(this.options.repository, binding.canonicalPath, ['bundle', 'create', bundlePath, ...revs], { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
      bundle = await readFile(bundlePath);
    } finally { await rm(temp, { recursive: true, force: true }); }
    if (bundle.length === 0 || bundle.length > MAX_BUNDLE_BYTES) throw new Error(`Git bundle size must be between 1 byte and ${MAX_BUNDLE_BYTES} bytes.`);
    const bundleSha256 = createHash('sha256').update(bundle).digest('hex');
    const chunkCount = Math.ceil(bundle.length / BUNDLE_CHUNK_BYTES);
    const payload: TransferOfferPayload = {
      requestId: id, sharedProjectId: request.sharedProjectId, sourceHead: request.expectedHead.toLowerCase(),
      baseHead: request.baseHead?.toLowerCase() ?? null, branch: branch ?? null,
      bundleSha256, bundleSizeBytes: bundle.length, chunkCount,
    };
    const digest = digestOf(payload);
    const at = nowIso();
    this.db.prepare(`INSERT INTO ${TABLE}(id,team_id,shared_project_id,owner_id,peer_device_id,direction,kind,status,operation_key,
      external_id,payload_json,request_digest,bundle_blob,bundle_sha256,bundle_size_bytes,source_head,base_head,branch,
      expected_head,expected_fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,'outgoing','transfer','awaiting-source-approval',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, request.teamId, request.sharedProjectId, owner.id, request.toDeviceId, request.idempotencyKey ?? null, id,
        JSON.stringify(payload), digest, bundle, bundleSha256, bundle.length, payload.sourceHead, payload.baseHead, payload.branch,
        state.head, state.fingerprint, at, at);
    insertAudit(this.db, AUDIT, { requestId: id, action: 'offer-created', actorDeviceId: deviceId, digest, details: { bundleSha256, bundleSizeBytes: bundle.length, sourceHead: payload.sourceHead } });
    try {
      await this.options.transport.send({ teamId: request.teamId, toDeviceId: request.toDeviceId, kind: 'git.offer', payload, idempotencyKey: `git:${id}:offer` });
    } catch (error) {
      this.setStatus(id, 'failed', { notices: [`Offer could not be sent: ${errorMessage(error).slice(0, 300)}`] });
      insertAudit(this.db, AUDIT, { requestId: id, action: 'offer-send-failed', actorDeviceId: deviceId, digest });
      throw error;
    }
    this.options.changed?.();
    return this.mapRequest(this.requireRow(id));
  }

  async requestIntegration(input: GitIntegrationRequestInput | unknown): Promise<GitRequestSnapshot> {
    const parsed = GitIntegrationRequestSchema.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid Git integration request: ${parsed.error.issues[0]?.message ?? 'schema validation failed'}`);
    const request = parsed.data;
    const owner = await currentUser(this.options.account);
    await this.options.authorizeTeam({ teamId: request.teamId });
    const existing = request.idempotencyKey ? this.findOperation(owner.id, request.teamId, request.sharedProjectId, 'integration', request.idempotencyKey) : undefined;
    if (existing) {
      await this.options.authorizeTeam({ teamId: existing.team_id, peerDeviceId: existing.peer_device_id });
      const prior = parseJson<{ incomingRequestId: string; action: 'merge' | 'push'; expectedHead: string; expectedFingerprint: string; remoteName: string | null }>(existing.payload_json, 'integration approval');
      if (prior.incomingRequestId !== request.incomingRequestId || prior.action !== request.action
        || prior.expectedHead !== request.expectedHead.toLowerCase() || prior.expectedFingerprint !== request.expectedFingerprint.toLowerCase()
        || prior.remoteName !== (request.remoteName ?? null)) {
        throw conflict('This idempotency key was already used for a different Git integration request.');
      }
      return this.mapRequest(existing);
    }
    const transfer = this.requireRow(request.incomingRequestId);
    await this.options.authorizeTeam({ teamId: transfer.team_id, peerDeviceId: transfer.peer_device_id });
    const binding = await resolveProjectBinding(this.options, this.db, request, owner.id);
    if (transfer.direction !== 'incoming' || transfer.kind !== 'transfer' || transfer.team_id !== request.teamId || transfer.shared_project_id !== request.sharedProjectId || transfer.status !== 'imported') {
      throw conflict('The selected incoming bundle has not been imported and reviewed on this device.');
    }
    const state = await fingerprintRepository(binding.canonicalPath, this.options.repository);
    if (state.head !== transfer.expected_head || state.fingerprint !== transfer.expected_fingerprint) {
      throw conflict('The target repository changed after conflict inspection. Import a fresh offer against the current HEAD before requesting integration.');
    }
    if (state.head.toLowerCase() !== request.expectedHead.toLowerCase() || state.fingerprint !== request.expectedFingerprint) throw conflict('Repository HEAD or fingerprint changed; refresh the repository review before requesting integration.');
    if (request.action === 'merge') {
      if (state.dirty) throw conflict('Merge approval requires a clean owner project. Commit or save local edits first.');
      const conflicts = parseJson<string[]>(transfer.conflict_paths_json, 'conflict paths');
      if (conflicts.length) throw conflict('This bundle has overlapping changes. Resolve them in a separate local review before asking to merge.');
    } else {
      await this.assertPushRemote(binding.canonicalPath, request.remoteName!);
      if (!state.branch) throw conflict('Push approval requires the owner project to be on a named branch.');
    }
    const payload = { incomingRequestId: transfer.id, action: request.action, expectedHead: state.head, expectedFingerprint: state.fingerprint, remoteName: request.remoteName ?? null };
    const digest = digestOf(payload);
    const id = randomUUID().replaceAll('-', '');
    const at = nowIso();
    this.db.prepare(`INSERT INTO ${TABLE}(id,team_id,shared_project_id,owner_id,peer_device_id,direction,kind,status,operation_key,
      external_id,payload_json,request_digest,source_head,expected_head,expected_fingerprint,branch,created_at,updated_at)
      VALUES (?,?,?,?,?,'local','integration','awaiting-source-approval',?,NULL,?,?,?,?,?,?,?,?)`)
      .run(id, request.teamId, request.sharedProjectId, owner.id, transfer.peer_device_id, request.idempotencyKey ?? null,
        JSON.stringify(payload), digest, transfer.source_head, state.head, state.fingerprint, state.branch, at, at);
    insertAudit(this.db, AUDIT, { requestId: id, action: 'integration-approval-requested', actorDeviceId: this.localDeviceId(request.teamId), digest,
      details: { incomingRequestId: transfer.id, action: request.action, expectedHead: state.head, expectedFingerprint: state.fingerprint, remoteName: request.remoteName ?? null } });
    this.options.changed?.();
    return this.mapRequest(this.requireRow(id));
  }

  async decide(input: unknown) {
    const parsed = DistributedRequestDecisionSchema.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid Git decision: ${parsed.error.issues[0]?.message ?? 'schema validation failed'}`);
    const decision = parsed.data;
    const owner = await currentUser(this.options.account);
    const row = this.requireRow(decision.requestId);
    await this.options.authorizeTeam({ teamId: row.team_id, peerDeviceId: row.peer_device_id });
    if (row.owner_id !== owner.id) throw conflict('This Git request is not owned by the signed-in account on this device.');
    if (row.request_digest !== decision.expectedDigest) throw conflict('The Git request changed after review. Reload before deciding.');
    if (decision.decision === 'approved' && row.status !== 'awaiting-destination-approval' && row.status !== 'awaiting-source-approval') return this.mapRequest(row);
    if (row.status === 'awaiting-destination-approval' && row.direction === 'incoming') return this.decideImport(row, decision.decision, owner.id);
    if (row.status === 'awaiting-source-approval' && (row.direction === 'outgoing' || row.direction === 'local')) {
      if (row.kind === 'integration') return this.decideIntegration(row, decision.decision, owner.id);
      return this.decideTransferSource(row, decision.decision, owner.id);
    }
    throw conflict(`Git request is no longer awaiting an owner decision (state: ${row.status}).`);
  }

  async onEnvelope(envelopeInput: DistributedDeviceEnvelope | unknown): Promise<void> {
    const envelope = validateEnvelope(envelopeInput, (teamId) => this.localDeviceId(teamId));
    const ownDeviceId = this.localDeviceId(envelope.teamId);
    if (envelope.fromDeviceId === ownDeviceId) throw new Error('A device cannot process its own distributed envelope.');
    await this.options.authorizeTeam({ teamId: envelope.teamId, peerDeviceId: envelope.fromDeviceId });
    const owner = await currentUser(this.options.account);
    switch (envelope.kind) {
      case 'git.team-artifact.offer': return this.receiveTeamArtifactOffer(envelope, owner.id);
      case 'git.team-artifact.chunk': return this.receiveTeamArtifactChunk(envelope, owner.id);
      case 'git.offer': return this.receiveOffer(envelope, owner.id);
      case 'git.import-approved': return this.receiveImportApproval(envelope, owner.id);
      case 'git.bundle.chunk': return this.receiveChunk(envelope, owner.id);
      case 'git.result': return this.receiveTransferResult(envelope, owner.id);
      default: throw new Error(`Unsupported Git transport kind: ${envelope.kind}`);
    }
  }

  /**
   * Export one committed team-run revision to its integration device. Team consent and the durable delivery
   * authorization replace the interactive approval used by an ordinary user-requested Git handoff.
   * Receivers' base availability is not trusted, so the bundle deliberately includes all history reachable
   * from the selected commit; it is still constrained by the ordinary 16 MiB / 128-chunk boundary.
   */
  async exportTeamArtifact(input: {
    teamId: string; sharedProjectId: string; sourceWorktreePath: string; revision: string; baseRevision?: string;
    toDeviceId: string; deliveryId: string; taskId?: string; path?: string;
  }): Promise<TeamArtifactRef> {
    const revisionInput = normalizeObjectId(input.revision, 'revision');
    const baseRevision = input.baseRevision ? normalizeObjectId(input.baseRevision, 'base revision') : null;
    const owner = await currentUser(this.options.account);
    const localDeviceId = this.localDeviceId(input.teamId);
    if (input.toDeviceId === localDeviceId) throw conflict('A team artifact must target another linked device.');
    await this.authorizeTeamArtifact({ teamId: input.teamId, sharedProjectId: input.sharedProjectId,
      deliveryId: input.deliveryId, peerDeviceId: input.toDeviceId, direction: 'export' });
    const binding = await resolveProjectBinding(this.options, this.db,
      { teamId: input.teamId, sharedProjectId: input.sharedProjectId, peerDeviceId: input.toDeviceId }, owner.id);
    const sourcePath = await realpath(input.sourceWorktreePath);
    await this.assertSameRepository(binding.canonicalPath, sourcePath);
    const resolved = await repositoryGit(this.options.repository, sourcePath,
      ['rev-parse', '--verify', '--end-of-options', `${revisionInput}^{commit}`], { maxOutputBytes: 4096 });
    const revision = normalizeObjectId(line(resolved.stdout), 'resolved revision');
    if (revision !== revisionInput) throw conflict('The team artifact revision did not resolve to the claimed commit.');
    const reachable = await repositoryGit(this.options.repository, sourcePath,
      ['merge-base', '--is-ancestor', revision, 'HEAD'], { allowFailure: true, maxOutputBytes: 4096 });
    if (reachable.code !== 0) throw conflict('The team artifact commit is not reachable from the producing worktree HEAD.');
    if (baseRevision) {
      const base = await repositoryGit(this.options.repository, sourcePath,
        ['merge-base', '--is-ancestor', baseRevision, revision], { allowFailure: true, maxOutputBytes: 4096 });
      if (base.code !== 0) throw conflict('The team artifact base must be an ancestor of its revision.');
    }

    const transferId = createHash('sha256').update(`${input.teamId}\0${input.sharedProjectId}\0${input.deliveryId}\0${input.toDeviceId}\0${revision}\0${input.taskId ?? ''}\0${input.path ?? ''}`).digest('hex');
    const refName = teamArtifactRef(input.sharedProjectId, input.deliveryId, revision);
    const existing = this.teamArtifactRow(transferId);
    if (existing) {
      const offer = TeamArtifactOfferSchema.parse(parseJson<unknown>(existing.offer_json, 'team artifact offer'));
      if (existing.direction !== 'outgoing' || existing.peer_device_id !== input.toDeviceId || offer.revision !== revision
        || offer.deliveryId !== input.deliveryId || offer.sharedProjectId !== input.sharedProjectId || offer.taskId !== input.taskId || offer.path !== input.path) {
        throw conflict('This team artifact transfer ID is already bound to different content or delivery authority.');
      }
      if (existing.status !== 'sent') throw conflict('The prior team artifact transfer has an uncertain or failed delivery state; it will not be replayed automatically.');
      return TeamArtifactRefSchema.parse({ revision, ...(input.path ? { path: input.path } : {}), ...(input.taskId ? { taskId: input.taskId } : {}), transferId, ref: refName });
    }

    const temp = await mkdtemp(path.join(os.tmpdir(), 'mingle-team-artifact-'));
    const bundleRepository = path.join(temp, 'source.git');
    const bundlePath = path.join(temp, 'team-artifact.bundle');
    const sourceRef = `refs/mingle/team-export/${randomUUID().replaceAll('-', '')}`;
    let bundle: Buffer;
    try {
      // Work in a temporary shared bare clone so a temporary export ref never enters the user's refs.
      // A bare clone has no checkout, so repository filters and checkout hooks are not invoked.
      await repositoryGit(this.options.repository, sourcePath,
        ['clone', '--bare', '--shared', '--no-hardlinks', '--quiet', sourcePath, bundleRepository], { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
      await repositoryGit(this.options.repository, bundleRepository, ['update-ref', sourceRef, revision], { maxOutputBytes: 4096 });
      await repositoryGit(this.options.repository, bundleRepository, ['bundle', 'create', bundlePath, sourceRef], { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
      const size = (await stat(bundlePath)).size;
      if (size === 0 || size > MAX_BUNDLE_BYTES) throw new Error(`Team artifact bundle size must be between 1 byte and ${MAX_BUNDLE_BYTES} bytes.`);
      bundle = await readFile(bundlePath);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    if (!bundle.length || bundle.length > MAX_BUNDLE_BYTES) throw new Error(`Team artifact bundle size must be between 1 byte and ${MAX_BUNDLE_BYTES} bytes.`);
    const offer = TeamArtifactOfferSchema.parse({ transferId, sharedProjectId: input.sharedProjectId, deliveryId: input.deliveryId,
      revision, baseRevision, ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.path ? { path: input.path } : {}),
      bundleSha256: createHash('sha256').update(bundle).digest('hex'),
      bundleSizeBytes: bundle.length, chunkCount: Math.ceil(bundle.length / BUNDLE_CHUNK_BYTES) });
    const at = nowIso();
    this.db.prepare(`INSERT INTO ${TEAM_ARTIFACT_TABLE}(transfer_id,team_id,shared_project_id,delivery_id,source_device_id,peer_device_id,
      direction,owner_id,status,offer_json,bundle_blob,ref_name,created_at,updated_at) VALUES(?,?,?,?,?,?,'outgoing',?,'sending',?,?,?, ?,?)`)
      .run(transferId, input.teamId, input.sharedProjectId, input.deliveryId, localDeviceId, input.toDeviceId,
        owner.id, JSON.stringify(offer), bundle, refName, at, at);
    try {
      await this.authorizeTeamArtifact({ teamId: input.teamId, sharedProjectId: input.sharedProjectId,
        deliveryId: input.deliveryId, peerDeviceId: input.toDeviceId, direction: 'export' });
      await this.options.transport.send({ teamId: input.teamId, toDeviceId: input.toDeviceId, kind: 'git.team-artifact.offer',
        payload: offer, idempotencyKey: `team-artifact:${transferId}:offer` });
      for (let index = 0; index < offer.chunkCount; index++) {
        await this.authorizeTeamArtifact({ teamId: input.teamId, sharedProjectId: input.sharedProjectId,
          deliveryId: input.deliveryId, peerDeviceId: input.toDeviceId, direction: 'export' });
        const chunk = bundle.subarray(index * BUNDLE_CHUNK_BYTES, Math.min(bundle.length, (index + 1) * BUNDLE_CHUNK_BYTES));
        await this.options.transport.send({ teamId: input.teamId, toDeviceId: input.toDeviceId, kind: 'git.team-artifact.chunk',
          payload: { transferId, index, chunkCount: offer.chunkCount, data: chunk.toString('base64') },
          idempotencyKey: `team-artifact:${transferId}:chunk:${index}` });
      }
      this.db.prepare(`UPDATE ${TEAM_ARTIFACT_TABLE} SET status='sent',updated_at=? WHERE transfer_id=?`).run(nowIso(), transferId);
    } catch (error) {
      this.db.prepare(`UPDATE ${TEAM_ARTIFACT_TABLE} SET status='unknown',updated_at=? WHERE transfer_id=?`).run(nowIso(), transferId);
      throw error;
    }
    this.options.changed?.();
    return TeamArtifactRefSchema.parse({ revision, ...(input.path ? { path: input.path } : {}), ...(input.taskId ? { taskId: input.taskId } : {}), transferId, ref: refName });
  }

  /** Verify a received artifact and install its tip only under a deterministic isolated ref. */
  async importTeamArtifact(input: {
    teamId: string; sharedProjectId: string; deliveryId: string; artifact: unknown; sourceDeviceId?: string;
  }): Promise<TeamArtifactRef> {
    const artifact = TeamArtifactRefSchema.parse(input.artifact);
    if (!artifact.transferId) throw conflict('A team artifact reference is missing its transfer ID.');
    const owner = await currentUser(this.options.account);
    const row = this.teamArtifactRow(artifact.transferId);
    if (!row || row.direction !== 'incoming' || row.team_id !== input.teamId || row.shared_project_id !== input.sharedProjectId
      || row.delivery_id !== input.deliveryId || row.owner_id !== owner.id || (input.sourceDeviceId && row.source_device_id !== input.sourceDeviceId)) {
      throw conflict('The team artifact transfer does not match this project, delivery, or authenticated sender.');
    }
    await this.authorizeTeamArtifact({ teamId: row.team_id, sharedProjectId: row.shared_project_id,
      deliveryId: row.delivery_id, peerDeviceId: row.source_device_id, direction: 'import' });
    const offer = TeamArtifactOfferSchema.parse(parseJson<unknown>(row.offer_json, 'team artifact offer'));
    if (artifact.revision.toLowerCase() !== offer.revision.toLowerCase() || offer.deliveryId !== input.deliveryId
      || offer.sharedProjectId !== input.sharedProjectId || artifact.path !== offer.path || artifact.taskId !== offer.taskId) {
      throw conflict('The team artifact reference differs from its authenticated transfer offer.');
    }
    const refName = teamArtifactRef(input.sharedProjectId, input.deliveryId, offer.revision);
    if (artifact.ref && artifact.ref !== refName) throw conflict('The team artifact reference names an unexpected isolated ref.');
    if (row.status !== 'ready' && row.status !== 'imported') throw conflict('The complete verified team artifact bundle has not arrived yet.');
    const binding = await resolveProjectBinding(this.options, this.db, { teamId: row.team_id, sharedProjectId: row.shared_project_id, peerDeviceId: row.source_device_id }, owner.id);
    if (row.status === 'imported') {
      const imported = await repositoryGit(this.options.repository, binding.canonicalPath,
        ['rev-parse', '--verify', `${refName}^{commit}`], { maxOutputBytes: 4096 });
      if (line(imported.stdout).toLowerCase() !== offer.revision.toLowerCase()) throw conflict('The previously imported team artifact ref no longer resolves to its recorded tip.');
      return TeamArtifactRefSchema.parse({ ...artifact, ref: refName });
    }
    const temp = await mkdtemp(path.join(os.tmpdir(), 'mingle-team-artifact-import-'));
    const bundlePath = path.join(temp, 'received.bundle');
    try {
      const bundle = Buffer.from(row.bundle_blob ?? []);
      if (bundle.length !== offer.bundleSizeBytes || createHash('sha256').update(bundle).digest('hex') !== offer.bundleSha256) {
        throw conflict('The received team artifact bundle failed its stored size or SHA-256 check.');
      }
      await writeFile(bundlePath, bundle, { mode: 0o600, flag: 'wx' });
      await this.verifyTeamArtifactBundle(binding.canonicalPath, bundlePath, offer);
      const currentRef = await repositoryGit(this.options.repository, binding.canonicalPath,
        ['show-ref', '--verify', '--quiet', refName], { allowFailure: true, maxOutputBytes: 4096 });
      if (currentRef.code === 0) {
        const currentTip = await repositoryGit(this.options.repository, binding.canonicalPath,
          ['rev-parse', '--verify', `${refName}^{commit}`], { maxOutputBytes: 4096 });
        if (line(currentTip.stdout).toLowerCase() !== offer.revision.toLowerCase()) throw conflict('The isolated team artifact ref already exists with a different tip.');
      } else {
        await repositoryGit(this.options.repository, binding.canonicalPath,
          ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', bundlePath, `${offer.revision}:${refName}`],
          { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
      }
      const imported = await repositoryGit(this.options.repository, binding.canonicalPath,
        ['rev-parse', '--verify', `${refName}^{commit}`], { maxOutputBytes: 4096 });
      if (line(imported.stdout).toLowerCase() !== offer.revision.toLowerCase()) throw conflict('Imported team artifact ref does not resolve to the exact advertised revision.');
      this.db.prepare(`UPDATE ${TEAM_ARTIFACT_TABLE} SET status='imported',ref_name=?,updated_at=? WHERE transfer_id=? AND status='ready'`)
        .run(refName, nowIso(), artifact.transferId);
      this.options.changed?.();
      return TeamArtifactRefSchema.parse({ ...artifact, ref: refName });
    } finally { await rm(temp, { recursive: true, force: true }); }
  }

  private async receiveTeamArtifactOffer(envelope: DistributedDeviceEnvelope, ownerId: string): Promise<void> {
    const parsed = TeamArtifactOfferSchema.safeParse(envelope.payload);
    if (!parsed.success) throw new Error('Malformed team artifact offer.');
    const offer = parsed.data;
    if (offer.chunkCount !== Math.ceil(offer.bundleSizeBytes / BUNDLE_CHUNK_BYTES)) throw conflict('Team artifact chunk dimensions do not match its bounded size.');
    await this.authorizeTeamArtifact({ teamId: envelope.teamId, sharedProjectId: offer.sharedProjectId,
      deliveryId: offer.deliveryId, peerDeviceId: envelope.fromDeviceId, direction: 'import' });
    await resolveProjectBinding(this.options, this.db,
      { teamId: envelope.teamId, sharedProjectId: offer.sharedProjectId, peerDeviceId: envelope.fromDeviceId }, ownerId);
    const existing = this.teamArtifactRow(offer.transferId);
    if (existing) {
      if (existing.direction !== 'incoming' || existing.source_device_id !== envelope.fromDeviceId
        || JSON.stringify(TeamArtifactOfferSchema.parse(parseJson<unknown>(existing.offer_json, 'team artifact offer'))) !== JSON.stringify(offer)) {
        throw conflict('A duplicate team artifact offer changed its authenticated payload.');
      }
      return;
    }
    const at = nowIso();
    this.db.prepare(`INSERT INTO ${TEAM_ARTIFACT_TABLE}(transfer_id,team_id,shared_project_id,delivery_id,source_device_id,peer_device_id,
      direction,owner_id,status,offer_json,bundle_blob,ref_name,created_at,updated_at) VALUES(?,?,?,?,?,?,'incoming',?,'receiving',?,NULL,NULL,?,?)`)
      .run(offer.transferId, envelope.teamId, offer.sharedProjectId, offer.deliveryId, envelope.fromDeviceId,
        this.localDeviceId(envelope.teamId), ownerId, JSON.stringify(offer), at, at);
    this.options.changed?.();
  }

  private async receiveTeamArtifactChunk(envelope: DistributedDeviceEnvelope, ownerId: string): Promise<void> {
    const parsed = TeamArtifactChunkSchema.safeParse(envelope.payload);
    if (!parsed.success) throw new Error('Malformed team artifact chunk.');
    const chunk = parsed.data;
    const row = this.teamArtifactRow(chunk.transferId);
    if (!row || row.direction !== 'incoming' || row.owner_id !== ownerId || row.source_device_id !== envelope.fromDeviceId) throw conflict('Team artifact chunk has no matching authenticated offer.');
    await this.authorizeTeamArtifact({ teamId: row.team_id, sharedProjectId: row.shared_project_id,
      deliveryId: row.delivery_id, peerDeviceId: envelope.fromDeviceId, direction: 'import' });
    await resolveProjectBinding(this.options, this.db, row, ownerId);
    const offer = TeamArtifactOfferSchema.parse(parseJson<unknown>(row.offer_json, 'team artifact offer'));
    if (chunk.chunkCount !== offer.chunkCount || chunk.index >= offer.chunkCount) throw conflict('Team artifact chunk dimensions differ from the authenticated offer.');
    const bytes = Buffer.from(chunk.data, 'base64');
    if (!bytes.length || bytes.length > BUNDLE_CHUNK_BYTES || bytes.toString('base64') !== chunk.data) throw new Error('Team artifact chunk is not canonical bounded base64.');
    const expectedSize = chunk.index === offer.chunkCount - 1 ? offer.bundleSizeBytes - (offer.chunkCount - 1) * BUNDLE_CHUNK_BYTES : BUNDLE_CHUNK_BYTES;
    if (bytes.length !== expectedSize) throw conflict('Team artifact chunk has an unexpected size.');
    const existingChunk = this.db.prepare(`SELECT data FROM ${TEAM_ARTIFACT_CHUNK_TABLE} WHERE transfer_id=? AND chunk_index=?`)
      .get(chunk.transferId, chunk.index) as { data: Uint8Array } | undefined;
    if (existingChunk) {
      if (!Buffer.from(existingChunk.data).equals(bytes)) {
        this.db.prepare(`UPDATE ${TEAM_ARTIFACT_TABLE} SET status='failed',updated_at=? WHERE transfer_id=?`).run(nowIso(), chunk.transferId);
        throw conflict('A duplicate team artifact chunk changed its bytes.');
      }
      return;
    }
    if (row.status !== 'receiving') throw conflict('The team artifact transfer is no longer receiving chunks.');
    this.db.prepare(`INSERT INTO ${TEAM_ARTIFACT_CHUNK_TABLE}(transfer_id,chunk_index,data) VALUES(?,?,?)`).run(chunk.transferId, chunk.index, bytes);
    const chunks = this.db.prepare(`SELECT chunk_index,data FROM ${TEAM_ARTIFACT_CHUNK_TABLE} WHERE transfer_id=? ORDER BY chunk_index`)
      .all(chunk.transferId) as Array<{ chunk_index: number; data: Uint8Array }>;
    if (chunks.length !== offer.chunkCount) { this.options.changed?.(); return; }
    const bundle = Buffer.concat(chunks.map((item) => Buffer.from(item.data)));
    if (bundle.length !== offer.bundleSizeBytes || createHash('sha256').update(bundle).digest('hex') !== offer.bundleSha256) {
      this.db.prepare(`UPDATE ${TEAM_ARTIFACT_TABLE} SET status='failed',updated_at=? WHERE transfer_id=?`).run(nowIso(), chunk.transferId);
      throw conflict('Team artifact bundle failed its advertised size or SHA-256 check.');
    }
    const binding = await resolveProjectBinding(this.options, this.db, row, ownerId);
    const temp = await mkdtemp(path.join(os.tmpdir(), 'mingle-team-artifact-verify-'));
    const bundlePath = path.join(temp, 'received.bundle');
    try {
      await writeFile(bundlePath, bundle, { mode: 0o600, flag: 'wx' });
      await this.verifyTeamArtifactBundle(binding.canonicalPath, bundlePath, offer);
      this.db.prepare(`UPDATE ${TEAM_ARTIFACT_TABLE} SET status='ready',bundle_blob=?,updated_at=? WHERE transfer_id=? AND status='receiving'`)
        .run(bundle, nowIso(), chunk.transferId);
    } catch (error) {
      this.db.prepare(`UPDATE ${TEAM_ARTIFACT_TABLE} SET status='failed',updated_at=? WHERE transfer_id=?`).run(nowIso(), chunk.transferId);
      throw error;
    } finally { await rm(temp, { recursive: true, force: true }); }
    this.options.changed?.();
  }

  private async verifyTeamArtifactBundle(root: string, bundlePath: string, offer: TeamArtifactOffer): Promise<void> {
    await repositoryGit(this.options.repository, root, ['bundle', 'verify', bundlePath], { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
    const listed = await repositoryGit(this.options.repository, root, ['bundle', 'list-heads', bundlePath], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    const advertised = listed.stdout.toString('utf8').split(/\r?\n/).filter(Boolean).map((entry) => entry.trim().split(/\s+/, 1)[0]?.toLowerCase());
    if (!advertised.includes(offer.revision.toLowerCase())) throw conflict('Team artifact bundle does not advertise the exact claimed revision.');
  }

  private async assertSameRepository(projectRoot: string, worktreePath: string): Promise<void> {
    const commonDir = async (cwd: string) => {
      const result = await repositoryGit(this.options.repository, cwd, ['rev-parse', '--git-common-dir'], { maxOutputBytes: 4096 });
      const value = line(result.stdout);
      if (!value || value.includes('\0')) throw conflict('Git returned an invalid repository common directory.');
      return realpath(path.resolve(cwd, value));
    };
    const [expected, actual] = await Promise.all([commonDir(projectRoot), commonDir(worktreePath)]);
    if (expected !== actual) throw conflict('Team artifact source worktree does not belong to the owner-bound shared project repository.');
  }

  private async authorizeTeamArtifact(input: { teamId: string; sharedProjectId: string; deliveryId: string; peerDeviceId: string; direction: 'export' | 'import' }): Promise<void> {
    await this.options.authorizeTeam({ teamId: input.teamId, peerDeviceId: input.peerDeviceId });
    if (!this.options.authorizeTeamArtifact) throw conflict('Team artifact delivery ownership could not be verified on this device.');
    await this.options.authorizeTeamArtifact(input);
  }

  private teamArtifactRow(transferId: string): TeamArtifactRow | undefined {
    return this.db.prepare(`SELECT * FROM ${TEAM_ARTIFACT_TABLE} WHERE transfer_id=?`).get(transferId) as TeamArtifactRow | undefined;
  }

  private async receiveOffer(envelope: DistributedDeviceEnvelope, ownerId: string): Promise<void> {
    const parsed = GitTransferOfferSchema.safeParse(envelope.payload);
    if (!parsed.success) throw new Error('Malformed Git bundle offer.');
    const offer = parsed.data;
    if (offer.chunkCount !== Math.ceil(offer.bundleSizeBytes / BUNDLE_CHUNK_BYTES)) {
      throw new Error('Git bundle offer chunk dimensions do not match its bounded size.');
    }
    if (offer.sharedProjectId.length > 200) throw new Error('Invalid shared project ID.');
    const binding = await resolveProjectBinding(this.options, this.db, { teamId: envelope.teamId, sharedProjectId: offer.sharedProjectId, peerDeviceId: envelope.fromDeviceId }, ownerId);
    const existing = this.db.prepare(`SELECT * FROM ${TABLE} WHERE direction='incoming' AND peer_device_id=? AND external_id=?`).get(envelope.fromDeviceId, offer.requestId) as GitRequestRow | undefined;
    const digest = digestOf(offer);
    if (existing) {
      if (existing.request_digest !== digest) throw conflict('A duplicate Git offer changed its immutable payload.');
      return;
    }
    const state = await fingerprintRepository(binding.canonicalPath, this.options.repository);
    const at = nowIso();
    const localId = randomUUID().replaceAll('-', '');
    const notices = ['Review the source device, bundle hash, size, source HEAD and local target HEAD before approving import.'];
    this.db.prepare(`INSERT INTO ${TABLE}(id,team_id,shared_project_id,owner_id,peer_device_id,direction,kind,status,operation_key,
      external_id,payload_json,request_digest,bundle_sha256,bundle_size_bytes,source_head,base_head,branch,expected_head,
      expected_fingerprint,notices_json,created_at,updated_at) VALUES (?,?,?,?,?,'incoming','transfer','awaiting-destination-approval',NULL,?,?,?,?,?,?,?,?,?,?,?, ?,?)`)
      .run(localId, envelope.teamId, offer.sharedProjectId, ownerId, envelope.fromDeviceId, offer.requestId,
        JSON.stringify(offer), digest, offer.bundleSha256, offer.bundleSizeBytes, offer.sourceHead, offer.baseHead, offer.branch,
        state.head, state.fingerprint, JSON.stringify(notices), at, at);
    insertAudit(this.db, AUDIT, { requestId: localId, action: 'offer-received', actorDeviceId: envelope.fromDeviceId, digest,
      details: { sourceRequestId: offer.requestId, bundleSha256: offer.bundleSha256, bundleSizeBytes: offer.bundleSizeBytes, sourceHead: offer.sourceHead, expectedHead: state.head } });
    this.options.changed?.();
  }

  private async decideImport(row: GitRequestRow, decision: 'approved' | 'denied', ownerId: string): Promise<GitRequestSnapshot> {
    const binding = await resolveProjectBinding(this.options, this.db, row, ownerId);
    if (decision === 'denied') {
      if (!this.transition(row.id, 'awaiting-destination-approval', 'denied', 'import-denied', this.localDeviceId(row.team_id), row.request_digest)) return this.mapRequest(this.requireRow(row.id));
      await this.sendEnvelope(row, 'git.result', { requestId: row.external_id, status: 'failed', conflictPaths: [], message: 'Destination owner denied import.' }, `git:${row.external_id}:result-denied`);
      return this.mapRequest(this.requireRow(row.id));
    }
    const current = await fingerprintRepository(binding.canonicalPath, this.options.repository);
    if (current.head !== row.expected_head || current.fingerprint !== row.expected_fingerprint) {
      this.transition(row.id, 'awaiting-destination-approval', 'stale', 'import-approval-stale', this.localDeviceId(row.team_id), row.request_digest,
        { reason: 'The owner project changed after the import offer was reviewed.' });
      throw conflict('The local project changed after review. A fresh Git offer is required.');
    }
    if (!this.transition(row.id, 'awaiting-destination-approval', 'awaiting-bundle', 'import-approved', this.localDeviceId(row.team_id), row.request_digest,
      { expectedHead: current.head, expectedFingerprint: current.fingerprint }, 'destination_approved=1')) return this.mapRequest(this.requireRow(row.id));
    await this.sendEnvelope(row, 'git.import-approved', { requestId: row.external_id }, `git:${row.external_id}:import-approved`);
    this.options.changed?.();
    return this.mapRequest(this.requireRow(row.id));
  }

  private async decideTransferSource(row: GitRequestRow, decision: 'approved' | 'denied', ownerId: string): Promise<GitRequestSnapshot> {
    const binding = await resolveProjectBinding(this.options, this.db, row, ownerId);
    if (decision === 'denied') {
      if (!this.transition(row.id, 'awaiting-source-approval', 'denied', 'source-transfer-denied', this.localDeviceId(row.team_id), row.request_digest, {}, 'bundle_blob=NULL')) return this.mapRequest(this.requireRow(row.id));
      return this.mapRequest(this.requireRow(row.id));
    }
    const state = await fingerprintRepository(binding.canonicalPath, this.options.repository);
    if (state.head !== row.expected_head || state.fingerprint !== row.expected_fingerprint) {
      this.transition(row.id, 'awaiting-source-approval', 'stale', 'source-transfer-stale', this.localDeviceId(row.team_id), row.request_digest,
        { reason: 'Source HEAD or project state changed since the bundle offer was created.' }, 'bundle_blob=NULL');
      throw conflict('Source project changed after the transfer was prepared. Create a fresh transfer request.');
    }
    const payload = parseJson<TransferOfferPayload>(row.payload_json, 'transfer offer');
    if (createHash('sha256').update(row.bundle_blob ?? Buffer.alloc(0)).digest('hex') !== payload.bundleSha256) throw conflict('Prepared bundle failed its stored hash check.');
    if (row.status !== 'awaiting-source-approval') throw conflict('Transfer is no longer awaiting source approval.');
    if (!this.transition(row.id, 'awaiting-source-approval', 'approved', 'source-transfer-approved', this.localDeviceId(row.team_id), row.request_digest,
      { bundleSha256: payload.bundleSha256, bundleSizeBytes: payload.bundleSizeBytes }, 'source_approved=1')) return this.mapRequest(this.requireRow(row.id));
    // Destination approval may arrive before or after the source owner approves.
    const refreshed = this.requireRow(row.id);
    if (refreshed.destination_approved) await this.sendBundle(refreshed, payload);
    this.options.changed?.();
    return this.mapRequest(this.requireRow(row.id));
  }

  private async decideIntegration(row: GitRequestRow, decision: 'approved' | 'denied', ownerId: string): Promise<GitRequestSnapshot> {
    const binding = await resolveProjectBinding(this.options, this.db, row, ownerId);
    const payload = parseJson<{ incomingRequestId: string; action: 'merge' | 'push'; expectedHead: string; expectedFingerprint: string; remoteName: string | null }>(row.payload_json, 'integration approval');
    if (decision === 'denied') {
      if (!this.transition(row.id, 'awaiting-source-approval', 'denied', 'integration-denied', this.localDeviceId(row.team_id), row.request_digest)) return this.mapRequest(this.requireRow(row.id));
      return this.mapRequest(this.requireRow(row.id));
    }
    const current = await fingerprintRepository(binding.canonicalPath, this.options.repository);
    if (current.head !== payload.expectedHead || current.fingerprint !== payload.expectedFingerprint) {
      this.transition(row.id, 'awaiting-source-approval', 'stale', 'integration-approval-stale', this.localDeviceId(row.team_id), row.request_digest,
        { reason: 'HEAD, working tree, or local Git configuration changed after approval was requested.' });
      throw conflict('Repository HEAD, working tree or Git configuration changed after review. Request a new integration approval.');
    }
    const incoming = this.requireRow(payload.incomingRequestId);
    if (incoming.direction !== 'incoming' || incoming.kind !== 'transfer' || incoming.status !== 'imported' || incoming.team_id !== row.team_id || incoming.shared_project_id !== row.shared_project_id) {
      throw conflict('The incoming Git bundle is no longer eligible for integration.');
    }
    if (payload.action === 'merge') {
      if (current.dirty) throw conflict('Merge approval requires a clean project.');
      await this.assertNoExternalMergeHelpers(binding.canonicalPath, incoming.source_head!);
    } else {
      await this.assertPushRemote(binding.canonicalPath, payload.remoteName!);
      if (!current.branch) throw conflict('Push requires a named local branch.');
    }
    await this.options.authorizeTeam({ teamId: row.team_id, peerDeviceId: row.peer_device_id });
    if (!this.transition(row.id, 'awaiting-source-approval', 'dispatched', `${payload.action}-dispatched`, this.localDeviceId(row.team_id), row.request_digest,
      { expectedHead: current.head, expectedFingerprint: current.fingerprint, remoteName: payload.remoteName })) return this.mapRequest(this.requireRow(row.id));
    this.options.changed?.();
    try {
      let resultHead = current.head;
      if (payload.action === 'merge') {
        const isAncestor = await repositoryGit(this.options.repository, binding.canonicalPath, ['merge-base', '--is-ancestor', current.head, incoming.source_head!], { allowFailure: true });
        if (isAncestor.code === 0) {
          await repositoryGit(this.options.repository, binding.canonicalPath, ['-c', 'commit.gpgSign=false', 'merge', '--ff-only', `refs/mingle/incoming/${incoming.id}`], { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
        } else {
          await repositoryGit(this.options.repository, binding.canonicalPath, ['-c', 'commit.gpgSign=false', 'merge', '--no-edit', '--no-ff', `refs/mingle/incoming/${incoming.id}`], { timeoutMs: 60_000, maxOutputBytes: 128 * 1024, env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } });
        }
        resultHead = (await fingerprintRepository(binding.canonicalPath, this.options.repository)).head;
      } else {
        const branch = current.branch!;
        const valid = await repositoryGit(this.options.repository, binding.canonicalPath, ['check-ref-format', `refs/heads/${branch}`], { allowFailure: true, maxOutputBytes: 4096 });
        if (valid.code !== 0) throw new Error('Current branch name is invalid for an explicit push refspec.');
        await repositoryGit(this.options.repository, binding.canonicalPath, ['push', '--porcelain', payload.remoteName!, `HEAD:refs/heads/${branch}`], {
          timeoutMs: 120_000, maxOutputBytes: 64 * 1024,
          env: { GIT_SSH_COMMAND: 'ssh -F /dev/null -o BatchMode=yes' },
        });
      }
      this.setStatus(row.id, 'completed');
      insertAudit(this.db, AUDIT, { requestId: row.id, action: `${payload.action}-completed`, actorDeviceId: this.localDeviceId(row.team_id), digest: row.request_digest,
        details: { head: resultHead } });
    } catch (error) {
      const message = errorMessage(error).slice(0, 800);
      const outcome = /exceeded \d+ms/.test(message) ? 'unknown' : 'failed';
      this.setStatus(row.id, outcome, { notices: [message] });
      insertAudit(this.db, AUDIT, { requestId: row.id, action: `${payload.action}-${outcome}`, actorDeviceId: this.localDeviceId(row.team_id), digest: row.request_digest, details: { message } });
      throw error;
    }
    this.options.changed?.();
    return this.mapRequest(this.requireRow(row.id));
  }

  private async receiveImportApproval(envelope: DistributedDeviceEnvelope, ownerId: string): Promise<void> {
    const raw = envelope.payload as { requestId?: unknown };
    if (!raw || typeof raw.requestId !== 'string' || raw.requestId.length > 200) throw new Error('Malformed Git import approval.');
    const row = this.db.prepare(`SELECT * FROM ${TABLE} WHERE direction='outgoing' AND kind='transfer' AND peer_device_id=? AND id=?`).get(envelope.fromDeviceId, raw.requestId) as GitRequestRow | undefined;
    if (!row) throw new Error('Git import approval does not match an outgoing transfer to this device.');
    await resolveProjectBinding(this.options, this.db, row, ownerId);
    if (row.status === 'denied' || row.status === 'stale' || row.status === 'failed') return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare(`UPDATE ${TABLE} SET destination_approved=1,updated_at=? WHERE id=? AND destination_approved=0`).run(nowIso(), row.id);
      if (Number(update.changes) === 1) insertAudit(this.db, AUDIT, { requestId: row.id, action: 'destination-import-approved', actorDeviceId: envelope.fromDeviceId, digest: row.request_digest });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const refreshed = this.requireRow(row.id);
    if (refreshed.source_approved) await this.sendBundle(refreshed, parseJson<TransferOfferPayload>(refreshed.payload_json, 'transfer offer'));
    this.options.changed?.();
  }

  private async sendBundle(row: GitRequestRow, offer: TransferOfferPayload): Promise<void> {
    if (row.status !== 'approved') return;
    const binding = await resolveProjectBinding(this.options, this.db, row, row.owner_id);
    const sourceState = await fingerprintRepository(binding.canonicalPath, this.options.repository);
    if (sourceState.head !== row.expected_head || sourceState.fingerprint !== row.expected_fingerprint) {
      this.transition(row.id, 'approved', 'stale', 'bundle-source-changed-before-send', this.localDeviceId(row.team_id), row.request_digest,
        { reason: 'Source HEAD, working tree, or local Git configuration changed after approval.' }, 'bundle_blob=NULL');
      this.setStatus(row.id, 'stale', { clearBundle: true, notices: ['Source HEAD, working tree, or local Git configuration changed after approval. Create a fresh handoff.'] });
      return;
    }
    const bundle = Buffer.from(row.bundle_blob ?? []);
    if (bundle.length !== offer.bundleSizeBytes || createHash('sha256').update(bundle).digest('hex') !== offer.bundleSha256) throw conflict('Prepared Git bundle no longer matches its signed offer.');
    if (!this.transition(row.id, 'approved', 'dispatched', 'bundle-dispatch-started', this.localDeviceId(row.team_id), row.request_digest,
      { bundleSha256: offer.bundleSha256, bundleSizeBytes: offer.bundleSizeBytes, chunkCount: offer.chunkCount })) return;
    try {
      for (let index = 0; index < offer.chunkCount; index++) {
        await this.options.authorizeTeam({ teamId: row.team_id, peerDeviceId: row.peer_device_id });
        const chunk = bundle.subarray(index * BUNDLE_CHUNK_BYTES, Math.min(bundle.length, (index + 1) * BUNDLE_CHUNK_BYTES));
        await this.options.transport.send({ teamId: row.team_id, toDeviceId: row.peer_device_id, kind: 'git.bundle.chunk',
          payload: { requestId: offer.requestId, index, chunkCount: offer.chunkCount, data: chunk.toString('base64') },
          idempotencyKey: `git:${offer.requestId}:chunk:${index}` });
      }
      this.setStatus(row.id, 'completed');
      insertAudit(this.db, AUDIT, { requestId: row.id, action: 'bundle-dispatched', actorDeviceId: this.localDeviceId(row.team_id), digest: row.request_digest,
        details: { bundleSha256: offer.bundleSha256, bundleSizeBytes: offer.bundleSizeBytes, chunkCount: offer.chunkCount } });
    } catch (error) {
      // The mailbox may have accepted a prefix before an acknowledgement was lost; never guess or replay after restart.
      this.setStatus(row.id, 'unknown', { notices: ['Bundle delivery was interrupted. Some chunks may have reached the destination; create a fresh handoff after reviewing both devices.'] });
      insertAudit(this.db, AUDIT, { requestId: row.id, action: 'bundle-dispatch-unknown', actorDeviceId: this.localDeviceId(row.team_id), digest: row.request_digest });
      throw error;
    } finally { this.options.changed?.(); }
  }

  private async receiveChunk(envelope: DistributedDeviceEnvelope, ownerId: string): Promise<void> {
    const parsed = GitBundleChunkSchema.safeParse(envelope.payload);
    if (!parsed.success) throw new Error('Malformed Git bundle chunk.');
    const chunk = parsed.data;
    const row = this.db.prepare(`SELECT * FROM ${TABLE} WHERE direction='incoming' AND kind='transfer' AND peer_device_id=? AND external_id=?`).get(envelope.fromDeviceId, chunk.requestId) as GitRequestRow | undefined;
    if (!row) throw new Error('Git bundle chunk has no matching transfer offer.');
    await resolveProjectBinding(this.options, this.db, row, ownerId);
    const offer = GitTransferOfferSchema.parse(parseJson<unknown>(row.payload_json, 'transfer offer'));
    if (row.status !== 'awaiting-bundle' && row.status !== 'receiving') return;
    if (chunk.chunkCount !== offer.chunkCount || chunk.index >= offer.chunkCount) throw conflict('Git bundle chunk dimensions differ from the approved offer.');
    const bytes = Buffer.from(chunk.data, 'base64');
    if (!bytes.length || bytes.length > BUNDLE_CHUNK_BYTES || bytes.toString('base64') !== chunk.data) throw new Error('Git bundle chunk is not canonical bounded base64.');
    const expectedChunkSize = chunk.index === offer.chunkCount - 1 ? offer.bundleSizeBytes - (offer.chunkCount - 1) * BUNDLE_CHUNK_BYTES : BUNDLE_CHUNK_BYTES;
    if (bytes.length !== expectedChunkSize) throw conflict('Git bundle chunk has an unexpected size.');
    const stored = this.db.prepare('SELECT data FROM mingle_git_chunks WHERE request_id=? AND chunk_index=?').get(row.id, chunk.index) as { data: Uint8Array } | undefined;
    if (stored) {
      if (!Buffer.from(stored.data).equals(bytes)) {
        this.setStatus(row.id, 'failed', { notices: ['A duplicate bundle chunk carried different bytes.'] });
        insertAudit(this.db, AUDIT, { requestId: row.id, action: 'chunk-tamper', actorDeviceId: envelope.fromDeviceId, digest: row.request_digest, details: { index: chunk.index } });
        throw conflict('A duplicate bundle chunk changed its bytes.');
      }
      return;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO mingle_git_chunks(request_id,chunk_index,data) VALUES (?,?,?)').run(row.id, chunk.index, bytes);
      this.db.prepare(`UPDATE ${TABLE} SET status='receiving',updated_at=? WHERE id=? AND status='awaiting-bundle'`).run(nowIso(), row.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const chunks = this.db.prepare('SELECT chunk_index,data FROM mingle_git_chunks WHERE request_id=? ORDER BY chunk_index').all(row.id) as Array<{ chunk_index: number; data: Uint8Array }>;
    if (chunks.length !== offer.chunkCount) { this.options.changed?.(); return; }
    const bundle = Buffer.concat(chunks.map((item) => Buffer.from(item.data)));
    if (bundle.length !== offer.bundleSizeBytes || createHash('sha256').update(bundle).digest('hex') !== offer.bundleSha256) {
      this.setStatus(row.id, 'failed', { notices: ['Bundle hash or byte length does not match the owner-approved offer.'] });
      insertAudit(this.db, AUDIT, { requestId: row.id, action: 'bundle-hash-mismatch', actorDeviceId: envelope.fromDeviceId, digest: row.request_digest,
        details: { receivedBytes: bundle.length, expectedBytes: offer.bundleSizeBytes } });
      await this.sendEnvelope(row, 'git.result', { requestId: offer.requestId, status: 'failed', conflictPaths: [], message: 'Bundle hash verification failed.' }, `git:${offer.requestId}:result-failed`);
      return;
    }
    if (!this.transition(row.id, 'receiving', 'importing', 'bundle-import-dispatched', this.localDeviceId(row.team_id), row.request_digest,
      { bundleSha256: offer.bundleSha256, bundleSizeBytes: bundle.length })) return;
    try {
      const report = await this.importBundle(row, offer, bundle);
      this.setStatus(row.id, report.status, { conflictPaths: report.conflictPaths, notices: report.notices });
      insertAudit(this.db, AUDIT, { requestId: row.id, action: `bundle-${report.status}`, actorDeviceId: this.localDeviceId(row.team_id), digest: row.request_digest,
        details: { conflictPaths: report.conflictPaths, expectedHead: row.expected_head } });
      await this.sendEnvelope(row, 'git.result', { requestId: offer.requestId, status: report.status, conflictPaths: report.conflictPaths, message: report.notices[0] }, `git:${offer.requestId}:result-${report.status}`);
    } catch (error) {
      const message = errorMessage(error).slice(0, 800);
      this.setStatus(row.id, 'failed', { notices: [message] });
      insertAudit(this.db, AUDIT, { requestId: row.id, action: 'bundle-import-failed', actorDeviceId: this.localDeviceId(row.team_id), digest: row.request_digest, details: { message } });
      await this.sendEnvelope(row, 'git.result', { requestId: offer.requestId, status: 'failed', conflictPaths: [], message }, `git:${offer.requestId}:result-failed`).catch(() => undefined);
    }
    this.options.changed?.();
  }

  private async importBundle(row: GitRequestRow, offer: TransferOfferPayload, bundle: Buffer): Promise<{ status: 'imported' | 'conflict' | 'stale'; conflictPaths: string[]; notices: string[] }> {
    const binding = await resolveProjectBinding(this.options, this.db, row, row.owner_id);
    const current = await fingerprintRepository(binding.canonicalPath, this.options.repository);
    if (current.head !== row.expected_head || current.fingerprint !== row.expected_fingerprint) {
      return { status: 'stale', conflictPaths: [], notices: ['Owner project changed while the approved bundle was arriving. The bundle is isolated in a Mingle ref; review against the current HEAD before integrating.'] };
    }
    const temp = await mkdtemp(path.join(os.tmpdir(), 'mingle-git-import-'));
    const bundlePath = path.join(temp, 'incoming.bundle');
    const worktreePath = path.join(temp, 'inspect-worktree');
    const ref = `refs/mingle/incoming/${row.id}`;
    try {
      await writeFile(bundlePath, bundle, { mode: 0o600, flag: 'wx' });
      await repositoryGit(this.options.repository, binding.canonicalPath, ['bundle', 'verify', bundlePath], { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
      const listed = await repositoryGit(this.options.repository, binding.canonicalPath, ['bundle', 'list-heads', bundlePath], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
      const advertised = listed.stdout.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => line.trim().split(/\s+/, 1)[0]?.toLowerCase());
      if (!advertised.includes(offer.sourceHead.toLowerCase())) throw new Error('Bundle does not advertise the exact source HEAD in its approved offer.');
      const existing = await repositoryGit(this.options.repository, binding.canonicalPath, ['show-ref', '--verify', '--quiet', ref], { allowFailure: true, maxOutputBytes: 4096 });
      if (existing.code === 0) throw conflict('The isolated destination ref already exists; this import will not overwrite it.');
      await repositoryGit(this.options.repository, binding.canonicalPath, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', bundlePath, `${offer.sourceHead}:${ref}`], { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
      const importedHead = await repositoryGit(this.options.repository, binding.canonicalPath, ['rev-parse', '--verify', `${ref}^{commit}`], { maxOutputBytes: 4096 });
      if (importedHead.stdout.toString('utf8').trim().toLowerCase() !== offer.sourceHead.toLowerCase()) throw new Error('Imported Git ref does not resolve to the approved source HEAD.');

      // The temporary worktree owns a separate index and performs only read-tree/diff inspection. No project files or shared index are checked out.
      await repositoryGit(this.options.repository, binding.canonicalPath, ['worktree', 'add', '--detach', '--no-checkout', worktreePath, current.head], { timeoutMs: 30_000, maxOutputBytes: 32 * 1024 });
      await repositoryGit(this.options.repository, worktreePath, ['read-tree', current.head], { maxOutputBytes: 32 * 1024 });
      const intoCurrent = await repositoryGit(this.options.repository, binding.canonicalPath, ['merge-base', '--is-ancestor', offer.sourceHead, current.head], { allowFailure: true, maxOutputBytes: 4096 });
      if (intoCurrent.code === 0) return { status: 'imported', conflictPaths: [], notices: ['The source HEAD is already contained in the owner project; it remains available only under the isolated Mingle ref.'] };
      const currentIntoSource = await repositoryGit(this.options.repository, binding.canonicalPath, ['merge-base', '--is-ancestor', current.head, offer.sourceHead], { allowFailure: true, maxOutputBytes: 4096 });
      if (currentIntoSource.code === 0) return { status: 'imported', conflictPaths: [], notices: ['The bundle can be fast-forwarded after a separate owner-approved integration request.'] };
      const mergeBase = await repositoryGit(this.options.repository, binding.canonicalPath, ['merge-base', current.head, offer.sourceHead], { allowFailure: true, maxOutputBytes: 4096 });
      if (mergeBase.code !== 0) return { status: 'conflict', conflictPaths: ['<unrelated histories>'], notices: ['The source and destination have no common ancestor; automatic conflict-free integration is unavailable.'] };
      const base = mergeBase.stdout.toString('utf8').trim();
      const [localFiles, incomingFiles] = await Promise.all([
        repositoryGit(this.options.repository, binding.canonicalPath, ['diff', '--name-only', '-z', '--no-renames', base, current.head, '--'], { maxOutputBytes: 2 * 1024 * 1024 }),
        repositoryGit(this.options.repository, binding.canonicalPath, ['diff', '--name-only', '-z', '--no-renames', base, offer.sourceHead, '--'], { maxOutputBytes: 2 * 1024 * 1024 }),
      ]);
      const localPaths = localFiles.stdout.toString('utf8').split('\0').filter(Boolean);
      const sourcePaths = incomingFiles.stdout.toString('utf8').split('\0').filter(Boolean);
      const changedLocally = new Set(localPaths);
      const conflicts = [...new Set(sourcePaths.filter((candidate) => [...changedLocally].some((existingPath) =>
        existingPath === candidate || existingPath.startsWith(`${candidate}/`) || candidate.startsWith(`${existingPath}/`))))].slice(0, 500);
      return conflicts.length
        ? { status: 'conflict', conflictPaths: conflicts, notices: ['Overlapping path changes are conservatively marked for manual conflict review. No project files were changed.'] }
        : { status: 'imported', conflictPaths: [], notices: ['No overlapping changed paths were found. Review the isolated ref and request a separate owner-approved merge or push.'] };
    } finally {
      await repositoryGit(this.options.repository, binding.canonicalPath, ['worktree', 'remove', '--force', worktreePath], { allowFailure: true, timeoutMs: 20_000, maxOutputBytes: 32 * 1024 }).catch(() => undefined);
      await rm(temp, { recursive: true, force: true });
    }
  }

  private async receiveTransferResult(envelope: DistributedDeviceEnvelope, ownerId: string): Promise<void> {
    const parsed = GitTransferResultSchema.safeParse(envelope.payload);
    if (!parsed.success) throw new Error('Malformed Git import result.');
    const result = parsed.data;
    const row = this.db.prepare(`SELECT * FROM ${TABLE} WHERE direction='outgoing' AND kind='transfer' AND peer_device_id=? AND id=?`).get(envelope.fromDeviceId, result.requestId) as GitRequestRow | undefined;
    if (!row) throw new Error('Git result does not match an outgoing transfer to this device.');
    await resolveProjectBinding(this.options, this.db, row, ownerId);
    const notices = result.message ? [result.message] : [];
    this.setStatus(row.id, result.status, { conflictPaths: result.conflictPaths, notices });
    insertAudit(this.db, AUDIT, { requestId: row.id, action: 'destination-result-received', actorDeviceId: envelope.fromDeviceId, digest: row.request_digest,
      details: { status: result.status, conflictPaths: result.conflictPaths } });
    this.options.changed?.();
  }

  private async assertPushRemote(root: string, remoteName: string): Promise<void> {
    if (remoteName === '.' || remoteName.startsWith('-') || /[\u0000-\u001f\u007f\s]/.test(remoteName)) throw new Error('Invalid configured remote name.');
    const result = await repositoryGit(this.options.repository, root, ['remote', 'get-url', '--push', '--all', remoteName], { maxOutputBytes: 8192 });
    const configured = result.stdout.toString('utf8').trim().split(/\r?\n/).filter(Boolean);
    if (configured.length !== 1) throw new Error('Push requires exactly one configured push destination.');
    const urlText = configured[0]!;
    if (urlText.length > 2048 || /[\u0000-\u0020\u007f]/.test(urlText)) throw new Error('Configured push remote URL is not a supported safe URL.');
    let valid = false;
    try {
      const url = new URL(urlText);
      valid = ['https:', 'ssh:'].includes(url.protocol) && Boolean(url.hostname) && !url.password && !url.search && !url.hash && (url.protocol === 'ssh:' || !url.username);
    } catch {
      const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):([A-Za-z0-9._~/-]+)$/.exec(urlText);
      valid = Boolean(scp && scp[2] && !scp[2].startsWith('-') && !scp[2].includes('..'));
    }
    if (!valid) throw new Error('Push is limited to one credential-free HTTPS or SSH destination; file, helper and ext protocols are disabled.');
  }

  private async assertNoExternalMergeHelpers(root: string, incomingHead: string): Promise<void> {
    const config = await repositoryGit(this.options.repository, root, ['config', '--local', '--null', '--get-regexp', '^merge\\..*\\.driver$'], { allowFailure: true, maxOutputBytes: 64 * 1024 });
    if (config.code === 0 && config.stdout.length > 0) throw conflict('This repository configures external merge drivers; owner-approved distributed merge is disabled for it.');
    for (const commit of [await repositoryGit(this.options.repository, root, ['rev-parse', 'HEAD'], { maxOutputBytes: 4096 }).then((r) => r.stdout.toString('utf8').trim()), incomingHead]) {
      const files = await repositoryGit(this.options.repository, root, ['ls-tree', '-r', '--name-only', '-z', commit], { maxOutputBytes: 2 * 1024 * 1024 });
      if (files.outputTruncated) throw conflict('Repository has too many paths for safe merge-driver inspection.');
      for (const file of files.stdout.toString('utf8').split('\0').filter((name) => name.endsWith('.gitattributes'))) {
        const contents = await repositoryGit(this.options.repository, root, ['show', `${commit}:${file}`], { maxOutputBytes: 256 * 1024 });
        if (contents.outputTruncated || /(?:^|\s)merge\s*=\s*(?!text(?:\s|$)|binary(?:\s|$)|union(?:\s|$)|default(?:\s|$))[^\s#]+/m.test(contents.stdout.toString('utf8'))) {
          throw conflict('Distributed merge is disabled for custom merge attributes or oversized attributes files.');
        }
        if (/(?:^|\s)filter\s*=/m.test(contents.stdout.toString('utf8'))) throw conflict('Distributed merge is disabled for repository filter attributes.');
      }
    }
    const filters = await repositoryGit(this.options.repository, root, ['config', '--local', '--null', '--get-regexp', '^filter\\..*\\.(?:clean|smudge|process)$'], { allowFailure: true, maxOutputBytes: 64 * 1024 });
    if (filters.code === 0 && filters.stdout.length > 0) throw conflict('This repository configures external content filters; distributed merge is disabled for it.');
  }

  private async sendEnvelope(row: GitRequestRow, kind: string, payload: unknown, idempotencyKey: string): Promise<void> {
    await this.options.authorizeTeam({ teamId: row.team_id, peerDeviceId: row.peer_device_id });
    await this.options.transport.send({ teamId: row.team_id, toDeviceId: row.peer_device_id, kind, payload, idempotencyKey });
  }

  private localDeviceId(teamId: string): string {
    const id = this.options.transport.snapshot(teamId).deviceId;
    if (!id || typeof id !== 'string') throw conflict('This device has not registered distributed transport yet.');
    return id;
  }

  private findOperation(ownerId: string, teamId: string, projectId: string, kind: 'transfer' | 'integration', key: string): GitRequestRow | undefined {
    return this.db.prepare(`SELECT * FROM ${TABLE} WHERE owner_id=? AND team_id=? AND shared_project_id=? AND kind=? AND operation_key=?`).get(ownerId, teamId, projectId, kind, key) as GitRequestRow | undefined;
  }

  private requireRow(id: string): GitRequestRow {
    const row = this.getRow(id);
    if (!row) throw conflict('Git request was not found on this device.');
    return row;
  }

  private getRow(id: string): GitRequestRow | undefined {
    return this.db.prepare(`SELECT * FROM ${TABLE} WHERE id=?`).get(id) as GitRequestRow | undefined;
  }

  private setStatus(id: string, status: string, options: { notices?: string[]; conflictPaths?: string[]; clearBundle?: boolean } = {}): void {
    const row = this.requireRow(id);
    const notices = options.notices ?? parseJson<string[]>(row.notices_json, 'request notices');
    const conflicts = options.conflictPaths ?? parseJson<string[]>(row.conflict_paths_json, 'conflict paths');
    this.db.prepare(`UPDATE ${TABLE} SET status=?,notices_json=?,conflict_paths_json=?,bundle_blob=CASE WHEN ? THEN NULL ELSE bundle_blob END,updated_at=? WHERE id=?`)
      .run(status, JSON.stringify(notices), JSON.stringify(conflicts), Number(options.clearBundle ?? false), nowIso(), id);
    this.options.changed?.();
  }

  /** Atomic compare-and-set plus append-only audit claim for at-most-once state transitions. */
  private transition(id: string, expected: string, next: string, action: string, actorDeviceId: string, digest: string,
    details: Record<string, unknown> = {}, extraSet = ''): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare(`UPDATE ${TABLE} SET status=?,${extraSet ? `${extraSet},` : ''}updated_at=? WHERE id=? AND status=?`)
        .run(next, nowIso(), id, expected);
      const changed = Number(update.changes) === 1;
      if (changed) insertAudit(this.db, AUDIT, { requestId: id, action, actorDeviceId, digest, details });
      this.db.exec('COMMIT');
      if (changed) this.options.changed?.();
      return changed;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private mapRequest(row: GitRequestRow): GitRequestSnapshot {
    const payload = parseJson<Record<string, unknown>>(row.payload_json, 'request payload');
    return {
      id: row.id, teamId: row.team_id, sharedProjectId: row.shared_project_id, direction: row.direction,
      peerDeviceId: row.peer_device_id, kind: row.kind, status: row.status as GitRequestSnapshot['status'], requestDigest: row.request_digest,
      ...(row.source_head ? { sourceHead: row.source_head } : {}), baseHead: row.base_head, branch: row.branch,
      ...(row.bundle_sha256 ? { bundleSha256: row.bundle_sha256 } : {}), ...(row.bundle_size_bytes ? { bundleSizeBytes: row.bundle_size_bytes } : {}),
      expectedHead: row.expected_head, ...(row.expected_fingerprint ? { expectedFingerprint: row.expected_fingerprint } : {}),
      ...(row.kind === 'integration' && payload.action ? { action: payload.action as 'merge' | 'push' } : {}),
      ...(row.kind === 'integration' && payload.remoteName ? { remoteName: payload.remoteName as string } : {}),
      conflictPaths: parseJson<string[]>(row.conflict_paths_json, 'conflict paths'), notices: parseJson<string[]>(row.notices_json, 'request notices'),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
}

function digestOf(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function normalizeObjectId(value: string, label: string): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) throw new Error(`Invalid team artifact ${label}.`);
  return value.toLowerCase();
}

function line(value: Buffer): string {
  const text = value.toString('utf8');
  return text.endsWith('\n') ? text.slice(0, -1).replace(/\r$/, '') : text;
}

function teamArtifactRef(sharedProjectId: string, deliveryId: string, revision: string): string {
  const segment = (value: string) => `${value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 36) || 'team'}-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
  return `refs/mingle/team/${segment(sharedProjectId)}/${segment(deliveryId)}/${revision.toLowerCase()}`;
}
