import { createHash, randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { DistributedDevice, DistributedDeviceLink, ProjectMemorySharing, ProjectMemorySyncRecord, AuthenticatedTransportMessage } from '@mingle/contracts';
import { PROJECT_MEMORY_MESSAGE_KINDS, ProjectMemorySyncRecordSchema, ProjectMemorySyncRequestSchema, ProjectMemorySyncResponseSchema } from '@mingle/contracts';
import { canonicalJson, verifyDevicePayload } from '../distributed/crypto.ts';
import type { Store } from '../store.ts';
import { HttpError } from '../util.ts';
import type { RevisionRow } from './repo.ts';
import type { MemoryTeamHooks, ProjectMemoryService } from './service.ts';

/** The slice of the existing encrypted device transport this layer uses. No new cloud calls are made here. */
export interface MemoryTransport {
  snapshot(teamId?: string): { deviceId: string | null; devices: DistributedDevice[]; links: DistributedDeviceLink[] };
  send(input: { teamId: string; toDeviceId: string; kind: string; payload: unknown; idempotencyKey: string }): Promise<string>;
  signPayload(teamId: string, expectedDeviceId: string, payload: string): Promise<string>;
  onMessage(handler: (message: AuthenticatedTransportMessage) => void | Promise<void>): () => void;
}

export interface MemoryAuthority {
  /** Fresh cloud authorization of the peer (membership, device and mutual links); used only when a team message arrives. */
  authorizeTeam(input: { teamId: string; peerDeviceId?: string }): Promise<void>;
  /** Active members of the project's team, from the existing collaboration service. */
  members(localProjectId: string): Promise<Array<{ accountId: string }>>;
  localAccountId(): string | null;
}

export interface MemorySyncOptions {
  store: Store; service: ProjectMemoryService; transport: MemoryTransport; authority: MemoryAuthority;
  now?: () => number; log?: (level: 'info' | 'warn' | 'error', message: string, error?: unknown) => void;
  verify?: (payload: string, signature: string, publicKey: string) => boolean;
  /** Backoff for retrying unpublished records; only armed while there is unpublished work. */
  retryBaseMs?: number;
  /** Minimum spacing between history requests served to one peer. */
  requestRateMs?: number;
}

interface Binding { teamId: string; sharedProjectId: string }
interface PendingRequest { projectId: string; peerDeviceId: string; expiresAt: number; batchCount: number | null; batches: Set<number>; records: number }

const REQUEST_EXPIRY_MS = 2 * 60_000;
const BACKFILL_COOLDOWN_MS = 30_000;
const RESPONSE_RECORD_CEILING = 400;
const BATCH_RECORDS = 50;
const BATCH_BYTES = 150 * 1024;
const MAX_PENDING = 50;
const REQUEST_RATE_MS = 10_000;
const MAX_ROWS_PER_PUBLISH = 100;

export function signingPayload(record: Omit<ProjectMemorySyncRecord, 'signature'>): string {
  return canonicalJson({
    domain: 'mingle-project-memory-record-v1', id: record.id, entryId: record.entryId, revision: record.revision, parentRevision: record.parentRevision,
    op: record.op, at: record.at, teamId: record.teamId, sharedProjectId: record.sharedProjectId, author: record.author, note: record.note,
    content: record.content, createdAt: record.createdAt, authorDeviceId: record.authorDeviceId,
    ...(record.lineage ? { lineage: record.lineage } : {}),
  });
}

function permanent(error: unknown): boolean {
  return error instanceof ZodError || (error instanceof HttpError && error.status < 500 && error.status !== 429 && error.status !== 408);
}

/**
 * Replicates project memory between a user's team devices over the existing authenticated, encrypted transport. It is entirely
 * event-driven: it runs on local writes, topology changes, project opens and process start, and only retries while unpublished work exists.
 */
export class ProjectMemoryTeamSync implements MemoryTeamHooks {
  private readonly now: () => number;
  private readonly verify: (payload: string, signature: string, publicKey: string) => boolean;
  private readonly flights = new Map<string, Promise<void>>();
  private readonly queued = new Map<string, Promise<void>>();
  private readonly retries = new Map<string, { timer: NodeJS.Timeout; attempt: number }>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestedAt = new Map<string, number>();
  private readonly peerRequestAt = new Map<string, number>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly unsubscribeTransport: () => void;
  private readonly unsubscribeStore: () => void;
  private topologyTimer: NodeJS.Timeout | null = null;
  private topologyKey = '';
  private closed = false;

  constructor(private readonly options: MemorySyncOptions) {
    this.now = options.now ?? Date.now;
    this.verify = options.verify ?? verifyDevicePayload;
    options.service.attachTeam(this);
    this.unsubscribeTransport = options.transport.onMessage((message) => this.onEnvelope(message));
    // Cheap local topology check, debounced: store touches are frequent while busy and absent while idle.
    this.unsubscribeStore = options.store.subscribe((event) => { if (!event) this.scheduleTopologyCheck(); });
    this.scheduleTopologyCheck();
  }

  private log(level: 'info' | 'warn' | 'error', message: string, error?: unknown): void { this.options.log?.(level, message, error); }
  private iso(): string { return new Date(this.now()).toISOString(); }

  // ---- binding & identity (local SQLite only) ------------------------------------------------------------------

  bindingFor(projectId: string): Binding | null {
    const account = this.options.authority.localAccountId();
    if (!account) return null;
    try {
      const source = this.options.store.db.prepare('SELECT team_id, shared_project_id FROM mingle_project_collaboration_sources WHERE local_project_id=? AND owner_id=?')
        .get(projectId, account) as { team_id: string; shared_project_id: string } | undefined;
      if (source) return { teamId: source.team_id, sharedProjectId: source.shared_project_id };
      const joins = this.options.store.db.prepare('SELECT team_id, shared_project_id, device_id FROM mingle_project_collaboration_joins WHERE local_project_id=? AND account_id=?')
        .all(projectId, account) as Array<{ team_id: string; shared_project_id: string; device_id: string }>;
      const join = joins.find((row) => this.options.transport.snapshot(row.team_id).deviceId === row.device_id);
      return join ? { teamId: join.team_id, sharedProjectId: join.shared_project_id } : null;
    } catch { return null; } // collaboration tables do not exist until that service starts
  }

  private projectFor(teamId: string, sharedProjectId: string): string | null {
    const account = this.options.authority.localAccountId();
    if (!account) return null;
    try {
      const source = this.options.store.db.prepare('SELECT local_project_id FROM mingle_project_collaboration_sources WHERE team_id=? AND shared_project_id=? AND owner_id=?')
        .get(teamId, sharedProjectId, account) as { local_project_id: string } | undefined;
      const local = this.options.transport.snapshot(teamId).deviceId;
      const join = source ? undefined : this.options.store.db.prepare(
        'SELECT local_project_id FROM mingle_project_collaboration_joins WHERE team_id=? AND shared_project_id=? AND account_id=? AND device_id=?')
        .get(teamId, sharedProjectId, account, local ?? '') as { local_project_id: string } | undefined;
      const id = source?.local_project_id ?? join?.local_project_id;
      return id && this.options.store.getProject(id) ? id : null;
    } catch { return null; }
  }

  private peers(teamId: string): string[] {
    const snap = this.options.transport.snapshot(teamId);
    if (!snap.deviceId) return [];
    return snap.devices.filter((device) => device.id !== snap.deviceId && !device.revokedAt && snap.links.some((link) =>
      link.deviceId === snap.deviceId && link.peerDeviceId === device.id && link.mutual)).map((device) => device.id);
  }

  identity(projectId: string): { accountId: string | null; deviceId: string | null } {
    const binding = this.bindingFor(projectId);
    return { accountId: this.options.authority.localAccountId(), deviceId: binding ? this.options.transport.snapshot(binding.teamId).deviceId : null };
  }

  sharing(projectId: string): ProjectMemorySharing {
    const binding = this.bindingFor(projectId);
    const state = this.options.service.repo.syncState(projectId);
    if (!binding) {
      return { shared: false, teamId: null, sharedProjectId: null, localDeviceId: null, peerCount: 0, unpublished: 0, lastBackfillAt: state.lastBackfillAt,
        lastReceivedAt: state.lastReceivedAt, error: null };
    }
    return {
      shared: true, teamId: binding.teamId, sharedProjectId: binding.sharedProjectId, localDeviceId: this.options.transport.snapshot(binding.teamId).deviceId,
      peerCount: this.peers(binding.teamId).length, unpublished: this.options.service.repo.unpublishedCount(projectId),
      lastBackfillAt: state.lastBackfillAt, lastReceivedAt: state.lastReceivedAt, error: state.error,
    };
  }

  // ---- publishing ----------------------------------------------------------------------------------------------

  localRevision(projectId: string): void {
    if (this.closed || !this.bindingFor(projectId)) return;
    this.track(this.publish(projectId).catch(() => undefined));
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.work.add(promise);
    void promise.finally(() => this.work.delete(promise)).catch(() => undefined);
    return promise;
  }

  /** Signs and sends unpublished local revisions to every mutually linked teammate device. */
  publish(projectId: string): Promise<void> {
    const running = this.flights.get(projectId);
    if (running) {
      // A revision written while a flight is in progress may have been missed by it: run exactly one more pass afterwards.
      const queued = this.queued.get(projectId);
      if (queued) return queued;
      const next = running.catch(() => undefined).then(() => { this.queued.delete(projectId); return this.publish(projectId); });
      this.queued.set(projectId, next);
      return next;
    }
    const flight = this.publishNow(projectId).finally(() => this.flights.delete(projectId));
    this.flights.set(projectId, flight);
    return flight;
  }

  private async publishNow(projectId: string): Promise<void> {
    const binding = this.bindingFor(projectId);
    const { repo } = this.options.service;
    if (!binding || this.closed) return;
    const { teamId, sharedProjectId } = binding;
    try {
      const deviceId = this.options.transport.snapshot(teamId).deviceId;
      if (!deviceId) throw new Error('Register this device with the team to share project memory.');
      const peers = this.peers(teamId);
      for (const row of repo.unpublished(projectId, MAX_ROWS_PER_PUBLISH)) {
        let record: ProjectMemorySyncRecord;
        if (row.signature && row.teamId === teamId && row.sharedProjectId === sharedProjectId && row.authorDeviceId === deviceId) {
          record = this.options.service.toSyncRecord(row, teamId, sharedProjectId, deviceId, row.signature);
        } else {
          // Fill in the attribution that was unknown when an unregistered or signed-out device wrote the revision.
          const author = { ...row.author, deviceId: row.author.deviceId ?? deviceId, accountId: row.author.accountId ?? this.options.authority.localAccountId() } as RevisionRow['author'];
          const unsigned: Omit<ProjectMemorySyncRecord, 'signature'> = {
            id: row.recordId, entryId: row.entryId, revision: row.revision, parentRevision: row.parentRevision, op: row.op, at: row.at,
            teamId, sharedProjectId, author, note: row.note, content: row.snapshot, createdAt: row.createdAt, authorDeviceId: deviceId,
            lineage: row.lineage,
          };
          const signature = await this.options.transport.signPayload(teamId, deviceId, signingPayload(unsigned));
          repo.markSigned(row.recordId, teamId, sharedProjectId, deviceId, signature, author);
          record = ProjectMemorySyncRecordSchema.parse({ ...unsigned, signature });
        }
        for (const peer of peers) {
          await this.options.transport.send({ teamId, toDeviceId: peer, kind: 'projectmemory.record', payload: record, idempotencyKey: `pmem:${record.id}:${peer}` });
        }
        repo.markPublished(row.recordId, this.iso());
      }
      repo.patchSyncState(projectId, { error: null });
      this.clearRetry(projectId);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 280) : 'Project memory could not be sent to teammates.';
      repo.patchSyncState(projectId, { error: message });
      this.armRetry(projectId);
      this.log('warn', `Project memory publish failed for ${projectId}`, error);
    }
  }

  private armRetry(projectId: string): void {
    if (this.closed || this.retries.has(projectId) || !this.options.service.repo.unpublishedCount(projectId)) return;
    const attempt = (this.retries.get(projectId)?.attempt ?? 0) + 1;
    const delay = Math.min(5 * 60_000, (this.options.retryBaseMs ?? 15_000) * 2 ** Math.min(attempt - 1, 5));
    const timer = setTimeout(() => {
      this.retries.delete(projectId);
      this.track(this.publish(projectId).catch(() => undefined));
    }, delay);
    timer.unref();
    this.retries.set(projectId, { timer, attempt });
  }

  private clearRetry(projectId: string): void {
    const retry = this.retries.get(projectId);
    if (retry) { clearTimeout(retry.timer); this.retries.delete(projectId); }
  }

  // ---- backfill ------------------------------------------------------------------------------------------------

  /** Asks every linked teammate device for records this device lacks. Returns the number of peers asked. */
  async requestBackfill(projectId: string, force = false): Promise<number> {
    const binding = this.bindingFor(projectId);
    if (!binding || this.closed) return 0;
    const last = this.requestedAt.get(projectId) ?? 0;
    if (!force && this.now() - last < BACKFILL_COOLDOWN_MS) return 0;
    this.requestedAt.set(projectId, this.now());
    const { teamId, sharedProjectId } = binding;
    const deviceId = this.options.transport.snapshot(teamId).deviceId;
    if (!deviceId) return 0;
    this.expire();
    let asked = 0;
    const since = this.options.service.backfillSince(projectId);
    for (const peer of this.peers(teamId)) {
      if (this.pending.size >= MAX_PENDING) break;
      const request = ProjectMemorySyncRequestSchema.parse({ sharedProjectId, requestId: randomUUID(), since });
      const key = this.pendingKey(teamId, sharedProjectId, peer, request.requestId);
      this.pending.set(key, { projectId, peerDeviceId: peer, expiresAt: this.now() + REQUEST_EXPIRY_MS, batchCount: null, batches: new Set(), records: 0 });
      try {
        await this.options.transport.send({ teamId, toDeviceId: peer, kind: 'projectmemory.sync.request', payload: request, idempotencyKey: `pmem-req:${request.requestId}:${peer}` });
        asked++;
      } catch (error) {
        this.pending.delete(key);
        this.options.service.repo.patchSyncState(projectId, { error: error instanceof Error ? error.message.slice(0, 280) : 'Backfill request failed.' });
      }
    }
    if (asked) this.options.service.repo.patchSyncState(projectId, { lastBackfillAt: this.iso() });
    return asked;
  }

  private pendingKey(teamId: string, sharedProjectId: string, peer: string, requestId: string): string { return `${teamId}:${sharedProjectId}:${peer}:${requestId}`; }
  private async requestWanted(projectId: string, teamId: string, sharedProjectId: string, peer: string, ids: string[]): Promise<void> {
    const wanted = [...new Set(ids)].slice(0, 20).filter((id) => !this.options.service.repo.lineageFor(id));
    if (!wanted.length || this.pending.size >= MAX_PENDING) return;
    const request = ProjectMemorySyncRequestSchema.parse({ sharedProjectId, requestId: randomUUID(), since: null, want: wanted });
    const key = this.pendingKey(teamId, sharedProjectId, peer, request.requestId);
    this.pending.set(key, { projectId, peerDeviceId: peer, expiresAt: this.now() + REQUEST_EXPIRY_MS, batchCount: null, batches: new Set(), records: 0 });
    try {
      await this.options.transport.send({ teamId, toDeviceId: peer, kind: 'projectmemory.sync.request', payload: request, idempotencyKey: `pmem-want:${request.requestId}:${peer}` });
    } catch (error) {
      this.pending.delete(key);
      this.log('warn', `Project memory ancestry request failed for ${projectId}`, error);
    }
  }
  private expire(): void { for (const [key, entry] of this.pending) if (entry.expiresAt <= this.now()) this.pending.delete(key); }

  /** Opening a project's memory is an explicit local event: flush anything pending and ask for missed records (rate-limited). */
  projectOpened(projectId: string): void {
    if (this.closed || !this.bindingFor(projectId)) return;
    this.track(this.publish(projectId).then(() => this.requestBackfill(projectId)).then(() => undefined).catch(() => undefined));
  }

  // ---- topology events -----------------------------------------------------------------------------------------

  private scheduleTopologyCheck(): void {
    if (this.closed || this.topologyTimer) return;
    this.topologyTimer = setTimeout(() => { this.topologyTimer = null; this.checkTopology(); }, 2_000);
    this.topologyTimer.unref();
  }

  private checkTopology(): void {
    if (this.closed) return;
    const projects = this.options.service.repo.projectsWithMemory();
    const parts: string[] = [];
    for (const projectId of projects) {
      const binding = this.bindingFor(projectId);
      if (binding) parts.push(`${projectId}:${binding.teamId}:${binding.sharedProjectId}:${this.options.transport.snapshot(binding.teamId).deviceId}:${this.peers(binding.teamId).sort().join(',')}`);
    }
    const key = parts.sort().join('|');
    if (key === this.topologyKey) return;
    const first = this.topologyKey === '';
    this.topologyKey = key;
    if (first && !key) return;
    for (const projectId of projects) this.projectOpened(projectId);
  }

  // ---- receiving -----------------------------------------------------------------------------------------------

  private onEnvelope(message: AuthenticatedTransportMessage): Promise<void> | void {
    if (!(PROJECT_MEMORY_MESSAGE_KINDS as readonly string[]).includes(message.kind)) return undefined;
    return this.track(this.receive(message).catch((error: unknown) => {
      if (permanent(error)) { this.log('warn', `Rejected ${message.kind}: ${error instanceof Error ? error.message : 'invalid'}`); return; }
      throw error;
    }));
  }

  private roster(teamId: string): { snap: ReturnType<MemoryTransport['snapshot']>; byId: Map<string, DistributedDevice> } {
    const snap = this.options.transport.snapshot(teamId);
    return { snap, byId: new Map(snap.devices.map((device) => [device.id, device])) };
  }

  /** Common sender authority: addressed to us, mutually linked active device, fresh cloud authorization, exact project binding, active member. */
  private async authorizeSender(envelope: AuthenticatedTransportMessage, sharedProjectId: string): Promise<{ projectId: string; ownerId: string; members: Set<string> }> {
    const { snap, byId } = this.roster(envelope.teamId);
    if (!snap.deviceId || envelope.toDeviceId !== snap.deviceId) throw new HttpError(403, 'Project memory envelope is not addressed to this device.');
    const sender = byId.get(envelope.fromDeviceId);
    if (!sender || sender.revokedAt || !snap.links.some((link) => link.deviceId === snap.deviceId && link.peerDeviceId === sender.id && link.mutual)) {
      throw new HttpError(403, 'The sender is not an active, mutually linked team device.');
    }
    const projectId = this.projectFor(envelope.teamId, sharedProjectId);
    if (!projectId) throw new HttpError(403, 'This shared project is not bound to a local project on this device.');
    await this.options.authority.authorizeTeam({ teamId: envelope.teamId, peerDeviceId: envelope.fromDeviceId });
    const members = new Set((await this.options.authority.members(projectId)).map((member) => member.accountId));
    if (!members.has(sender.ownerId)) throw new HttpError(403, 'The sender account is not an active member of this shared project.');
    return { projectId, ownerId: sender.ownerId, members };
  }

  /** Verifies the author's device registration and signature; `relayed` records may come from any active team device. */
  private verifyRecord(record: ProjectMemorySyncRecord, teamId: string, members: Set<string>, expectedDevice: string | null): void {
    const { byId } = this.roster(teamId);
    if (record.teamId !== teamId) throw new HttpError(400, 'Memory record belongs to another team.');
    if (expectedDevice && record.authorDeviceId !== expectedDevice) throw new HttpError(403, 'A direct memory record must be signed by its sending device.');
    const device = byId.get(record.authorDeviceId);
    if (!device || device.revokedAt) throw new HttpError(403, 'The authoring device is unknown or revoked.');
    if (!members.has(device.ownerId)) throw new HttpError(403, 'The authoring account is not an active team member.');
    const claimed = record.author.accountId;
    if (claimed !== null && claimed !== device.ownerId) throw new HttpError(403, 'The record claims an author account that does not own the signing device.');
    if (record.author.deviceId !== null && record.author.deviceId !== device.id) throw new HttpError(403, 'The record claims a different authoring device.');
    const { signature, ...unsigned } = record;
    if (!this.verify(signingPayload(unsigned), signature, device.signingPublicKey)) throw new HttpError(403, 'The memory record signature is invalid.');
  }

  private async receive(envelope: AuthenticatedTransportMessage): Promise<void> {
    if (this.closed) return;
    if (envelope.kind === 'projectmemory.record') {
      const record = ProjectMemorySyncRecordSchema.parse(envelope.payload);
      const { projectId, members } = await this.authorizeSender(envelope, record.sharedProjectId);
      this.verifyRecord(record, envelope.teamId, members, envelope.fromDeviceId);
      this.options.service.applyRemote(projectId, record);
      const missingParent = record.lineage?.parentId;
      if (missingParent && !this.options.service.repo.lineageFor(missingParent)) {
        await this.requestWanted(projectId, envelope.teamId, record.sharedProjectId, envelope.fromDeviceId, [missingParent]);
      }
      return;
    }
    if (envelope.kind === 'projectmemory.sync.request') {
      const request = ProjectMemorySyncRequestSchema.parse(envelope.payload);
      const { projectId } = await this.authorizeSender(envelope, request.sharedProjectId);
      const rateKey = `${envelope.teamId}:${request.sharedProjectId}:${envelope.fromDeviceId}`;
      if (!request.want?.length) {
        if (this.now() - (this.peerRequestAt.get(rateKey) ?? 0) < (this.options.requestRateMs ?? REQUEST_RATE_MS)) return; // a redundant valid request is consumed
        this.peerRequestAt.set(rateKey, this.now());
        if (this.peerRequestAt.size > 1_000) this.peerRequestAt.delete(this.peerRequestAt.keys().next().value!);
      }
      await this.publish(projectId); // make sure our own revisions are signed before serving history
      const { repo } = this.options.service;
      const rows = request.want?.length
        ? repo.signedRecordsByIds(projectId, request.sharedProjectId, request.want)
        : request.since === null
        ? repo.signedHeads(projectId, request.sharedProjectId, RESPONSE_RECORD_CEILING + 1)
        : repo.signedRecordsSince(projectId, request.sharedProjectId, request.since, RESPONSE_RECORD_CEILING + 1);
      const more = rows.length > RESPONSE_RECORD_CEILING;
      const records = rows.slice(0, RESPONSE_RECORD_CEILING).map((row) => this.options.service.toSyncRecord(row, row.teamId!, row.sharedProjectId!, row.authorDeviceId!, row.signature!));
      const batches = this.batches(request.sharedProjectId, request.requestId, records, more);
      for (const batch of batches) {
        const digest = createHash('sha256').update(JSON.stringify(batch)).digest('hex').slice(0, 32);
        await this.options.transport.send({ teamId: envelope.teamId, toDeviceId: envelope.fromDeviceId, kind: 'projectmemory.sync.response', payload: batch,
          idempotencyKey: `pmem-resp:${request.requestId}:${batch.batchIndex}:${digest}` });
      }
      return;
    }
    if (envelope.kind === 'projectmemory.sync.response') {
      const response = ProjectMemorySyncResponseSchema.parse(envelope.payload);
      this.expire();
      const key = this.pendingKey(envelope.teamId, response.sharedProjectId, envelope.fromDeviceId, response.requestId);
      const pending = this.pending.get(key);
      if (!pending) throw new HttpError(403, 'The memory sync response was not requested from this peer or has expired.');
      if (pending.batchCount !== null && pending.batchCount !== response.batchCount) throw new HttpError(400, 'The sync batch count changed.');
      if (pending.batches.has(response.batchIndex)) return;
      if (pending.records + response.records.length > RESPONSE_RECORD_CEILING) throw new HttpError(413, 'The sync response exceeds its limit.');
      const { projectId, members } = await this.authorizeSender(envelope, response.sharedProjectId);
      if (projectId !== pending.projectId) throw new HttpError(403, 'The sync response is outside the requesting project.');
      let skipped = 0;
      for (const record of response.records) {
        try {
          if (record.sharedProjectId !== response.sharedProjectId) throw new HttpError(400, 'A record belongs to another shared project.');
          this.verifyRecord(record, envelope.teamId, members, null);
          this.options.service.applyRemote(projectId, record);
          const missingParent = record.lineage?.parentId;
          if (missingParent && !this.options.service.repo.lineageFor(missingParent)) {
            await this.requestWanted(projectId, envelope.teamId, response.sharedProjectId, envelope.fromDeviceId, [missingParent]);
          }
        } catch (error) {
          if (!permanent(error)) throw error;
          skipped++;
          this.log('warn', `Skipped a backfilled memory record: ${error instanceof Error ? error.message : 'invalid'}`);
        }
      }
      pending.batchCount = response.batchCount;
      pending.batches.add(response.batchIndex);
      pending.records += response.records.length;
      if (pending.batches.size === pending.batchCount) {
        this.pending.delete(key);
        this.options.service.repo.patchSyncState(projectId, { error: skipped ? `${skipped} received memory record(s) were rejected.` : null });
        if (response.more) this.track(this.requestBackfill(projectId, true).then(() => undefined).catch(() => undefined));
      }
      return;
    }
    throw new HttpError(400, 'Unsupported project memory message.');
  }

  private batches(sharedProjectId: string, requestId: string, records: ProjectMemorySyncRecord[], more: boolean) {
    const chunks: ProjectMemorySyncRecord[][] = [];
    let current: ProjectMemorySyncRecord[] = [];
    for (const record of records) {
      const candidate = [...current, record];
      if (current.length && (candidate.length > BATCH_RECORDS || Buffer.byteLength(canonicalJson(candidate)) > BATCH_BYTES)) { chunks.push(current); current = [record]; }
      else current = candidate;
    }
    if (current.length || !chunks.length) chunks.push(current);
    if (chunks.length > 200) throw new HttpError(413, 'The memory sync response needs too many batches.');
    return chunks.map((chunk, batchIndex) => ProjectMemorySyncResponseSchema.parse({
      sharedProjectId, requestId, batchIndex, batchCount: chunks.length, more: more && batchIndex === chunks.length - 1, records: chunk,
    }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeTransport();
    this.unsubscribeStore();
    if (this.topologyTimer) clearTimeout(this.topologyTimer);
    for (const retry of this.retries.values()) clearTimeout(retry.timer);
    this.retries.clear();
    await Promise.allSettled([...this.work]);
    this.options.service.attachTeam(null);
  }
}
