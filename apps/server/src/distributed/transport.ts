import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import {
  DistributedMessageKindSchema, LinkDeviceSchema, RegisterDeviceSchema, RevokeDeviceSchema,
  SendDistributedMessageSchema,
  type AuthenticatedTransportMessage, type DistributedDevice, type DistributedDeviceLink,
  type DistributedMessageKind, type DistributedOutboxItem, type LinkDeviceInput,
  type RegisterDeviceInput, type RevokeDeviceInput, type SendDistributedMessageInput,
  type TransportSnapshot, type TransportStatus,
} from '../../../../packages/contracts/src/devices.ts';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../util.ts';
import {
  canonicalJson, fingerprintForPublicKeys, generateDeviceKeyMaterial, MAX_DISTRIBUTED_PAYLOAD_BYTES,
  openEnvelope, restoreDeviceKeyMaterial, sealEnvelope, signDevicePayload,
  type DeviceKeyMaterial, type SignedEnvelope,
} from './crypto.ts';

const DEVICE_COLUMNS = 'id,team_id,owner_id,name,signing_public_key,encryption_public_key,fingerprint,last_seen_at,revoked_at,created_at';
const LINK_COLUMNS = 'team_id,device_id,peer_device_id,peer_fingerprint,created_at';
const ENVELOPE_COLUMNS = 'id,team_id,from_device_id,to_device_id,idempotency_key,kind,ciphertext,nonce,signature,created_at,expires_at,received_at';
// Keep a margin below the SQL seven-day maximum for network transit and database processing time.
const DEFAULT_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
const ONLINE_WINDOW_MS = 90_000;
const MAX_RETRY_MS = 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_MAILBOX_ROWS_PER_SYNC = 10_000;
const ALLOWED_CLOCK_SKEW_MS = 2 * 60 * 1000;

/** The account bridge is deliberately structural so transport can be built before AccountService is integrated. */
export interface AuthenticatedTransportAccount {
  withAuthenticatedClient<T>(callback: (client: SupabaseClient, user: User) => Promise<T>): Promise<T>;
  snapshot?(): { status?: string; user?: { id: string } | null };
}

export interface TransportStore { db: DatabaseSync }
export interface TransportServiceOptions {
  account: AuthenticatedTransportAccount;
  store: TransportStore;
  dataDir: string;
  changed?: () => void;
  now?: () => number;
  retryBaseMs?: number;
  wakeRetryBaseMs?: number;
  onlineWindowMs?: number;
  messageTtlMs?: number;
  syncIntervalMs?: number;
}

export type TransportMessageHandler = (message: AuthenticatedTransportMessage) => void | Promise<void>;

interface CloudError { code?: string; message?: string }
interface CloudResult<T> { data: T | null; error: CloudError | null }
interface CloudDeviceRow {
  id: string; team_id: string; owner_id: string; name: string; signing_public_key: string; encryption_public_key: string;
  fingerprint: string; last_seen_at: string | null; revoked_at: string | null; created_at: string;
}
interface CloudLinkRow { team_id: string; device_id: string; peer_device_id: string; peer_fingerprint: string; created_at: string }
interface CloudEnvelopeRow {
  id: string; team_id: string; from_device_id: string; to_device_id: string; idempotency_key: string; kind: string;
  ciphertext: string; nonce: string; signature: string; created_at: string; expires_at: string; received_at: string;
}
interface LocalDeviceRow { account_id: string; team_id: string; device_id: string; name: string; registered: number }
interface LocalEnvelopeRow {
  id: string; account_id: string; team_id: string; from_device_id: string; to_device_id: string;
  idempotency_key: string; kind: string; envelope_json: string; status: string; attempts: number;
  next_attempt_at: number; error: string | null; created_at: string; expires_at: string; received_at?: string;
}
interface StoredKeyFile {
  version: 1;
  accountId: string;
  signingPrivateKeyDer: string;
  signingPublicKeyDer: string;
  encryptionPrivateKeyDer: string;
  encryptionPublicKeyDer: string;
}

interface WakeSubscription {
  client: SupabaseClient;
  channel: ReturnType<SupabaseClient['channel']>;
}

interface TeamSyncState {
  promise: Promise<boolean>;
  again: boolean;
}

/**
 * Outbound-only, authenticated cloud mailbox. SQLite rows contain ciphertext and public metadata only;
 * private X25519/Ed25519 key material is kept in an account-scoped 0600 file under the runtime data dir.
 */
export class TransportService {
  private readonly db: DatabaseSync;
  private readonly handlers = new Set<TransportMessageHandler>();
  private readonly keyCache = new Map<string, DeviceKeyMaterial>();
  private activeAccountId: string | null = null;
  private status: TransportStatus = 'unregistered';
  private lastError: string | null = null;
  private lastSyncAt: number | null = null;
  private syncPromise: Promise<void> | null = null;
  /** Marks work started by an inbound message handler, which runs inside the current sync. */
  private readonly handlerScope = new AsyncLocalStorage<true>();
  private syncAgain = false;
  private deliveryPromise: Promise<void> = Promise.resolve();
  private readonly teamSyncs = new Map<string, TeamSyncState>();
  private readonly outboxSyncs = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private readonly wakeSubscriptions = new Map<string, WakeSubscription>();
  private readonly wakeRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly wakeRetryAttempts = new Map<string, number>();
  private readonly pendingWakeDeviceIds = new Set<string>();
  private closed = false;
  private readonly now: () => number;
  private readonly retryBaseMs: number;
  private readonly wakeRetryBaseMs: number;
  private readonly onlineWindowMs: number;
  private readonly messageTtlMs: number;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryTimerAt = Number.POSITIVE_INFINITY;

  constructor(private readonly options: TransportServiceOptions) {
    this.db = options.store.db;
    this.now = options.now ?? Date.now;
    this.retryBaseMs = Math.max(0, options.retryBaseMs ?? 1_000);
    this.wakeRetryBaseMs = Math.max(1, options.wakeRetryBaseMs ?? 1_000);
    this.onlineWindowMs = options.onlineWindowMs ?? ONLINE_WINDOW_MS;
    this.messageTtlMs = Math.min(DEFAULT_MESSAGE_TTL_MS, Math.max(1, options.messageTtlMs ?? DEFAULT_MESSAGE_TTL_MS));
    this.ensureTables();
  }

  /** Starts mailbox polling and optional Realtime wake subscriptions; no inbound listener or network port is opened. */
  start(): void {
    if (this.closed || this.timer) return;
    const intervalMs = this.options.syncIntervalMs ?? 3_000;
    void this.sync();
    this.timer = setInterval(() => { void this.sync(); }, Math.max(1_000, intervalMs));
    this.timer.unref();
  }

  snapshot(teamId?: string): TransportSnapshot {
    const accountId = this.currentAccountId();
    if (!accountId) return { deviceId: null, devices: [], links: [], outbox: [], status: 'signed-out', error: null };
    const localDevices = this.db.prepare(`SELECT * FROM mingle_transport_local_devices WHERE account_id = ?${teamId ? ' AND team_id = ?' : ''} ORDER BY team_id`)
      .all(...(teamId ? [accountId, teamId] : [accountId])) as unknown as LocalDeviceRow[];
    const chosen = localDevices.find((row) => row.registered === 1) ?? null;
    const devices = (this.db.prepare(`SELECT * FROM mingle_transport_devices_cache WHERE account_id = ?${teamId ? ' AND team_id = ?' : ''} ORDER BY created_at,id`)
      .all(...(teamId ? [accountId, teamId] : [accountId])) as Record<string, unknown>[]).map((row) => this.publicDevice(row));
    const links = (this.db.prepare(`SELECT * FROM mingle_transport_links_cache WHERE account_id = ?${teamId ? ' AND team_id = ?' : ''} ORDER BY created_at,device_id,peer_device_id`)
      .all(...(teamId ? [accountId, teamId] : [accountId])) as Record<string, unknown>[]).map((row) => this.publicLink(row));
    const outbox = (this.db.prepare(`SELECT id,team_id,to_device_id,kind,created_at,expires_at,status,attempts,error FROM mingle_transport_outbox
      WHERE account_id = ? AND kind != 'teamgroup.delivery.heartbeat'${teamId ? ' AND team_id = ?' : ''} ORDER BY created_at DESC LIMIT 100`)
      .all(...(teamId ? [accountId, teamId] : [accountId])) as Record<string, unknown>[]).map((row) => this.publicOutbox(row));
    const hasActiveDevice = localDevices.some((row) => row.registered === 1);
    let status = this.status;
    if (!hasActiveDevice) status = 'unregistered';
    else if (this.lastSyncAt !== null && this.now() - this.lastSyncAt > this.onlineWindowMs && status === 'ready') status = 'offline';
    return { deviceId: chosen?.device_id ?? null, devices, links, outbox, status, error: this.lastError };
  }

  register(input: RegisterDeviceInput): Promise<DistributedDevice> {
    const request = RegisterDeviceSchema.parse(input);
    return this.withAccount(async (client, user, keys) => {
      let identity = this.ensureLocalIdentity(user.id, request);
      let existing = await this.query<CloudDeviceRow | null>(
        client.from('mingle_devices').select(DEVICE_COLUMNS).eq('team_id', request.teamId).eq('id', identity.device_id).maybeSingle(),
        'Device registration could not be checked in the cloud.',
      );
      if (existing?.revoked_at) {
        identity = this.rotateLocalIdentity(user.id, request);
        existing = null;
      }
      let row: CloudDeviceRow;
      if (existing) {
        if (existing.owner_id !== user.id) throw new HttpError(409, 'This device identifier belongs to another account.');
        if (existing.fingerprint !== keys.fingerprint || existing.signing_public_key !== keys.signingPublicKeyDer || existing.encryption_public_key !== keys.encryptionPublicKeyDer) {
          throw new HttpError(409, 'The registered device keys no longer match this runtime identity.');
        }
        if (existing.name !== request.name) throw new HttpError(409, 'Device names are immutable after registration; revoke and register a new device identity to rename it.');
        const updated = await this.query<CloudDeviceRow | null>(client.from('mingle_devices')
          .update({ last_seen_at: this.isoNow() }).eq('team_id', request.teamId).eq('id', identity.device_id)
          .eq('owner_id', user.id).is('revoked_at', null).select(DEVICE_COLUMNS).maybeSingle(),
        'Device registration could not be refreshed.');
        if (!updated) throw new HttpError(403, 'This account cannot refresh the registered device.');
        row = updated;
      } else {
        const created = await this.query<CloudDeviceRow | null>(client.from('mingle_devices').insert({
          id: identity.device_id, team_id: request.teamId, owner_id: user.id, name: request.name,
          signing_public_key: keys.signingPublicKeyDer, encryption_public_key: keys.encryptionPublicKeyDer,
          fingerprint: keys.fingerprint, last_seen_at: this.isoNow(), created_at: this.isoNow(),
        }).select(DEVICE_COLUMNS).maybeSingle(), 'Device registration failed. Confirm active team membership and cloud schema.');
        if (!created) throw new HttpError(502, 'The cloud did not confirm device registration.');
        row = created;
      }
      this.db.prepare('UPDATE mingle_transport_local_devices SET name = ?, registered = 1 WHERE account_id = ? AND team_id = ? AND device_id = ?')
        .run(request.name, user.id, request.teamId, identity.device_id);
      this.cacheDevice(user.id, row);
      this.markHealthy();
      return this.publicDevice(this.deviceCacheRow(user.id, request.teamId, identity.device_id)!);
    }).then(async (device) => { await this.sync(); return device; });
  }

  /** Adds this device's unilateral fingerprint pin; delivery is enabled only after the peer pins us too. */
  link(input: LinkDeviceInput): Promise<DistributedDeviceLink> {
    const request = LinkDeviceSchema.parse(input);
    return this.withAccount(async (client, user) => {
      const own = this.requireLocalDevice(user.id, request.teamId);
      if (own.device_id === request.deviceId) throw new HttpError(400, 'A device cannot be linked to itself.');
      const peer = await this.query<CloudDeviceRow | null>(client.from('mingle_devices').select(DEVICE_COLUMNS)
        .eq('team_id', request.teamId).eq('id', request.deviceId).maybeSingle(), 'The peer device could not be checked.');
      if (!peer || peer.revoked_at) throw new HttpError(404, 'The peer device is not active in this team.');
      if (fingerprintForPublicKeys(peer.signing_public_key, peer.encryption_public_key) !== peer.fingerprint || peer.fingerprint !== request.fingerprint) {
        throw new HttpError(409, 'Peer fingerprint verification failed. Compare the fingerprint before linking.');
      }
      const current = await this.query<CloudLinkRow | null>(client.from('mingle_device_links').select(LINK_COLUMNS)
        .eq('team_id', request.teamId).eq('device_id', own.device_id).eq('peer_device_id', peer.id).maybeSingle(), 'The device link could not be checked.');
      if (current && current.peer_fingerprint !== peer.fingerprint) {
        // Re-pairing is an explicit delete + insert because the cloud link table has no UPDATE grant.
        await this.query<unknown>(client.from('mingle_device_links').delete().eq('team_id', request.teamId)
          .eq('device_id', own.device_id).eq('peer_device_id', peer.id), 'The stale device fingerprint pin could not be removed.');
      }
      if (!current || current.peer_fingerprint !== peer.fingerprint) {
        const inserted = await this.query<CloudLinkRow | null>(client.from('mingle_device_links').insert({
          team_id: request.teamId, device_id: own.device_id, peer_device_id: peer.id,
          peer_fingerprint: peer.fingerprint, created_at: this.isoNow(),
        }).select(LINK_COLUMNS).maybeSingle(), 'Device linking failed. Confirm team membership and active device status.');
        if (!inserted) throw new HttpError(502, 'The cloud did not confirm the device link.');
      }
      await this.refreshTeam(client, user.id, request.teamId, own.device_id);
      const link = this.linkCacheRow(user.id, request.teamId, own.device_id, peer.id);
      if (!link) throw new HttpError(502, 'The cloud did not return the device link.');
      this.markHealthy();
      return this.publicLink(link);
    });
  }

  /** Revokes a device owned by this account, or removes this device's pin to another account's device. */
  revoke(input: RevokeDeviceInput): Promise<void> {
    const request = RevokeDeviceSchema.parse(input);
    return this.withAccount(async (client, user) => {
      const target = await this.query<CloudDeviceRow | null>(client.from('mingle_devices').select(DEVICE_COLUMNS)
        .eq('team_id', request.teamId).eq('id', request.deviceId).maybeSingle(), 'The device could not be checked for revocation.');
      if (!target) throw new HttpError(404, 'The device is not visible in this team.');
      if (target.owner_id === user.id) {
        if (!target.revoked_at) {
          const updated = await this.query<CloudDeviceRow | null>(client.from('mingle_devices')
            .update({ revoked_at: this.isoNow() }).eq('team_id', request.teamId).eq('id', request.deviceId)
            .eq('owner_id', user.id).is('revoked_at', null).select(DEVICE_COLUMNS).maybeSingle(),
          'Device revocation failed.');
          if (!updated) throw new HttpError(403, 'This account cannot revoke that device.');
          this.cacheDevice(user.id, updated);
        }
        this.db.prepare('UPDATE mingle_transport_local_devices SET registered = 0 WHERE account_id = ? AND team_id = ? AND device_id = ?')
          .run(user.id, request.teamId, request.deviceId);
        this.db.prepare(`UPDATE mingle_transport_outbox SET status = 'expired', error = 'Sender device was revoked.'
          WHERE account_id = ? AND team_id = ? AND from_device_id = ? AND status = 'queued'`)
          .run(user.id, request.teamId, request.deviceId);
        await this.query<unknown>(client.from('mingle_device_links').delete().eq('team_id', request.teamId).eq('device_id', request.deviceId), 'Device trust links could not be removed.');
      } else {
        const own = this.requireLocalDevice(user.id, request.teamId);
        await this.query<unknown>(client.from('mingle_device_links').delete().eq('team_id', request.teamId)
          .eq('device_id', own.device_id).eq('peer_device_id', request.deviceId), 'The peer device link could not be revoked.');
        this.db.prepare('DELETE FROM mingle_transport_links_cache WHERE account_id = ? AND team_id = ? AND device_id = ? AND peer_device_id = ?')
          .run(user.id, request.teamId, own.device_id, request.deviceId);
      }
      this.lastError = null;
    });
  }

  /** Persists an encrypted envelope before attempting the cloud insert; returned id survives restarts. */
  send(input: SendDistributedMessageInput): Promise<string> {
    const request = SendDistributedMessageSchema.parse(input);
    let payloadJson: string;
    try { payloadJson = canonicalJson(request.payload); }
    catch { throw new HttpError(400, 'Distributed payload must be a finite JSON value.'); }
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_DISTRIBUTED_PAYLOAD_BYTES) throw new HttpError(413, 'Distributed payload exceeds the 256 KiB limit.');
    return this.withAccount(async (client, user, keys) => {
      const own = this.requireLocalDevice(user.id, request.teamId);
      if (own.registered !== 1) throw new HttpError(409, 'Register this device in the team before sending.');
      await this.refreshTeam(client, user.id, request.teamId, own.device_id);
      const peer = this.deviceCacheRow(user.id, request.teamId, request.toDeviceId);
      if (!peer || peer.revoked_at) throw new HttpError(409, 'The destination device is not currently active in the cached team roster. Sync and verify it before sending.');
      const peerFingerprint = fingerprintForPublicKeys(peer.signing_public_key, peer.encryption_public_key);
      if (peerFingerprint !== peer.fingerprint) throw new HttpError(409, 'The destination device key fingerprint is invalid.');
      const ownPin = this.linkCacheRow(user.id, request.teamId, own.device_id, request.toDeviceId);
      const peerPin = this.linkCacheRow(user.id, request.teamId, request.toDeviceId, own.device_id);
      if (!ownPin || ownPin.peer_fingerprint !== peer.fingerprint || !peerPin || peerPin.peer_fingerprint !== this.ownFingerprint(user.id, request.teamId)) {
        throw new HttpError(403, 'Device-to-device delivery requires both devices to pin each other\'s current fingerprints.');
      }
      const prior = this.db.prepare(`SELECT * FROM mingle_transport_outbox WHERE account_id = ? AND team_id = ? AND from_device_id = ? AND to_device_id = ? AND idempotency_key = ?`)
        .get(user.id, request.teamId, own.device_id, request.toDeviceId, request.idempotencyKey) as LocalEnvelopeRow | undefined;
      if (prior) {
        const old = JSON.parse(prior.envelope_json) as SignedEnvelope;
        if (old.kind !== request.kind) throw new HttpError(409, 'This idempotency key was already used for a different message kind.');
        const priorPayload = openEnvelope({ envelope: old, recipient: keys, senderSigningPublicKey: keys.signingPublicKeyDer, senderEncryptionPublicKey: peer.encryption_public_key });
        if (canonicalJson(priorPayload) !== canonicalJson(request.payload)) throw new HttpError(409, 'This idempotency key was already used for a different message.');
        return prior.id;
      }
      const createdAt = this.isoNow();
      const header = {
        id: randomUUID(), teamId: request.teamId, fromDeviceId: own.device_id, toDeviceId: request.toDeviceId,
        idempotencyKey: request.idempotencyKey, kind: request.kind, createdAt,
        expiresAt: new Date(this.now() + this.messageTtlMs).toISOString(),
      };
      const envelope = sealEnvelope({ header, payload: request.payload, sender: keys, recipientEncryptionPublicKey: peer.encryption_public_key });
      this.db.prepare(`INSERT INTO mingle_transport_outbox
        (id,account_id,team_id,from_device_id,to_device_id,idempotency_key,kind,envelope_json,status,attempts,next_attempt_at,error,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?, 'queued',0,?,NULL,?,?)`)
        .run(envelope.id, user.id, request.teamId, own.device_id, request.toDeviceId, request.idempotencyKey,
          request.kind, JSON.stringify(envelope), this.now(), envelope.createdAt, envelope.expiresAt);
      await this.flushOutbox(client, user.id, request.teamId, own.device_id);
      return envelope.id;
    });
  }

  /** Signs a bounded service-level statement with this account's registered team-device identity key. */
  signPayload(teamId: string, expectedDeviceId: string, payload: string): Promise<string> {
    if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > MAX_DISTRIBUTED_PAYLOAD_BYTES) {
      throw new HttpError(413, 'The device-signed payload exceeds the distributed payload limit.');
    }
    return this.withAccount(async (_client, user, keys) => {
      const own = this.requireLocalDevice(user.id, teamId);
      if (own.registered !== 1 || own.device_id !== expectedDeviceId) {
        throw new HttpError(409, 'The registered team device changed before signing.');
      }
      return signDevicePayload(payload, keys);
    });
  }

  /** Signs a locally accepted message using the already-verified account snapshot and local device key. */
  signPayloadLocal(teamId: string, expectedDeviceId: string, payload: string): string {
    if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > MAX_DISTRIBUTED_PAYLOAD_BYTES) {
      throw new HttpError(413, 'The device-signed payload exceeds the distributed payload limit.');
    }
    const accountId = this.currentAccountId();
    if (!accountId) throw new HttpError(401, 'Sign in to the Mingle account before sending team chat.');
    const own = this.requireLocalDevice(accountId, teamId);
    if (own.registered !== 1 || own.device_id !== expectedDeviceId) {
      throw new HttpError(409, 'The registered team device changed before signing.');
    }
    return signDevicePayload(payload, this.loadKeys(accountId));
  }

  onMessage(handler: TransportMessageHandler): () => void {
    if (this.closed) throw new Error('Transport service is closed.');
    this.handlers.add(handler);
    void this.sync();
    return () => this.handlers.delete(handler);
  }

  /** Pulls all teams registered by the active account, refreshes trust/presence, then drains durable inbox work. */
  sync(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.syncPromise && this.handlerScope.getStore()) {
      // A handler (or work it started) waiting for the sync that is delivering it would never finish.
      this.syncAgain = true;
      return Promise.resolve();
    }
    if (this.syncPromise) {
      // A caller requesting catch-up while a prior sync is in flight may have observed
      // a mailbox snapshot from just before a new INSERT. Coalesce one follow-up pass.
      this.syncAgain = true;
      return this.awaitSyncAndFollowUps(this.syncPromise);
    }
    const before = this.changeSignature();
    this.syncPromise = this.runSync().catch((error: unknown) => {
      this.recordFailure(this.isSignedIn() ? 'The distributed mailbox is temporarily unavailable.' : 'Sign in to the Mingle account to sync devices.');
      if (this.isSignedIn()) this.status = 'offline';
    }).finally(() => {
      this.notifyIfChanged(before);
      this.syncPromise = null;
      if (this.syncAgain && !this.closed) {
        this.syncAgain = false;
        void this.sync();
      }
    });
    return this.syncPromise;
  }

  private async awaitSyncAndFollowUps(first: Promise<void>): Promise<void> {
    await first;
    // A single coalesced follow-up satisfies this caller's request. Later wakes may
    // already have started another pass; do not make route callers wait for global idle.
    const followUp = this.syncPromise;
    if (followUp && followUp !== first) await followUp;
  }

  private wakeSync(deviceId?: string): void {
    if (this.closed) return;
    if (deviceId) this.pendingWakeDeviceIds.add(deviceId);
    if (this.syncPromise) {
      this.syncAgain = true;
      if (deviceId) {
        const accountId = this.currentAccountId();
        const local = accountId && this.localDevices(accountId).find((row) => row.registered === 1 && row.device_id === deviceId);
        if (accountId && local) void this.requestTeamSync(accountId, local);
      }
      return;
    }
    void this.sync();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryTimerAt = Number.POSITIVE_INFINITY;
    for (const timer of this.wakeRetryTimers.values()) clearTimeout(timer);
    this.wakeRetryTimers.clear();
    await this.syncPromise;
    await Promise.all([
      ...[...this.teamSyncs.values()].map((state) => state.promise),
      ...this.outboxSyncs.values(),
      this.deliveryPromise,
    ]);
    await Promise.allSettled([...this.wakeSubscriptions.values()].map(({ client, channel }) => client.removeChannel(channel)));
    this.wakeSubscriptions.clear();
    this.teamSyncs.clear();
    this.outboxSyncs.clear();
    this.wakeRetryAttempts.clear();
    this.pendingWakeDeviceIds.clear();
    this.handlers.clear();
    this.keyCache.clear();
  }

  private async runSync(): Promise<void> {
    const accountId = this.currentAccountId();
    if (!accountId) {
      // Preserve the authenticated error/status path while signed out or during account changes.
      await this.withAccount(async () => undefined, false);
      return;
    }
    this.lastError = null;
    const localDevices = this.localDevices(accountId).filter((row) => row.registered === 1);
    this.removeStaleWakeSubscriptions(accountId, localDevices);
    if (localDevices.length === 0) {
      // No device-specific callback below would otherwise verify this account snapshot.
      await this.withAccount(async (_client, user) => {
        if (user.id !== accountId) throw new HttpError(401, 'The signed-in account changed during mailbox synchronization.');
        this.activeAccountId = user.id;
        this.status = 'unregistered';
        this.lastError = null;
      }, false);
      return;
    }
    const urgentDevices = new Set(this.pendingWakeDeviceIds);
    this.pendingWakeDeviceIds.clear();
    localDevices.sort((left, right) => Number(urgentDevices.has(right.device_id)) - Number(urgentDevices.has(left.device_id)));

    // Inbox catch-up/dispatch and outbound retry draining are distinct work. A wake for
    // one team can start its bounded team task even while this pass is flushing another.
    await Promise.all(localDevices.map(async (local) => {
      if (!await this.requestTeamSync(accountId, local)) return;
      await this.flushLocalOutbox(accountId, local);
    }));

    if (this.currentAccountId() === accountId) {
      this.lastSyncAt = this.now();
      if (this.lastError) this.status = 'offline';
      else this.markHealthy();
    }
  }

  private teamSyncKey(accountId: string, local: LocalDeviceRow): string {
    return `${accountId}:${local.team_id}:${local.device_id}`;
  }

  private requestTeamSync(accountId: string, local: LocalDeviceRow): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const key = this.teamSyncKey(accountId, local);
    const current = this.teamSyncs.get(key);
    if (current) {
      current.again = true;
      return this.awaitTeamSyncAndFollowUps(key, current, current.promise);
    }
    const state: TeamSyncState = { promise: Promise.resolve(false), again: false };
    this.teamSyncs.set(key, state);
    this.startTeamSyncPass(key, state, accountId, local);
    return state.promise;
  }

  private startTeamSyncPass(key: string, state: TeamSyncState, accountId: string, local: LocalDeviceRow): void {
    const pass = this.syncTeamInbox(accountId, local).then(() => true).catch(() => {
      this.recordFailure('A team mailbox could not be synchronized.');
      return false;
    });
    state.promise = pass;
    void pass.then(() => {
      if (this.teamSyncs.get(key) !== state) return;
      if (state.again && !this.closed) {
        state.again = false;
        this.startTeamSyncPass(key, state, accountId, local);
      } else {
        this.teamSyncs.delete(key);
      }
    });
  }

  private async awaitTeamSyncAndFollowUps(key: string, state: TeamSyncState, first: Promise<boolean>): Promise<boolean> {
    const firstResult = await first;
    const followUp = this.teamSyncs.get(key) === state ? state.promise : null;
    return followUp && followUp !== first ? followUp : firstResult;
  }

  private async syncTeamInbox(accountId: string, local: LocalDeviceRow): Promise<void> {
    await this.withAccount(async (client, user) => {
      if (user.id !== accountId) throw new HttpError(401, 'The signed-in account changed during mailbox synchronization.');
      const own = this.requireLocalDevice(user.id, local.team_id);
      if (own.device_id !== local.device_id) throw new HttpError(409, 'The registered team device changed during mailbox synchronization.');
      this.ensureWakeSubscription(client, user.id, local.device_id);
      await this.refreshTeam(client, user.id, local.team_id, local.device_id);
      await this.pullInbox(client, user.id, local.team_id, local.device_id);
    }, false);

    // The authenticated-client callback has released before invoking application handlers.
    if (this.handlers.size > 0) await this.enqueuePendingDelivery(accountId, local.team_id);
  }

  private async flushLocalOutbox(accountId: string, local: LocalDeviceRow): Promise<void> {
    const hasDueOutbox = Boolean(this.db.prepare(`SELECT 1 FROM mingle_transport_outbox
      WHERE account_id = ? AND team_id = ? AND from_device_id = ? AND status = 'queued' AND next_attempt_at <= ? LIMIT 1`)
      .get(accountId, local.team_id, local.device_id, this.now()));
    if (!hasDueOutbox) return;
    const key = this.teamSyncKey(accountId, local);
    const current = this.outboxSyncs.get(key);
    if (current) return current;
    const operation = this.withAccount(async (client, user) => {
      if (user.id !== accountId) throw new HttpError(401, 'The signed-in account changed during mailbox synchronization.');
      const own = this.requireLocalDevice(user.id, local.team_id);
      if (own.device_id !== local.device_id) throw new HttpError(409, 'The registered team device changed during mailbox synchronization.');
      await this.flushOutbox(client, user.id, local.team_id, local.device_id);
    }, false).catch(() => {
      this.recordFailure('A team mailbox could not be synchronized.');
    }).finally(() => {
      if (this.outboxSyncs.get(key) === operation) this.outboxSyncs.delete(key);
    });
    this.outboxSyncs.set(key, operation);
    return operation;
  }

  private enqueuePendingDelivery(accountId: string, teamId: string): Promise<void> {
    const delivery = this.deliveryPromise.then(() => this.deliverPending(accountId, teamId));
    this.deliveryPromise = delivery.catch(() => undefined);
    return delivery;
  }

  private async refreshTeam(client: SupabaseClient, accountId: string, teamId: string, deviceId: string): Promise<void> {
    const heartbeat = await this.query<CloudDeviceRow | null>(client.from('mingle_devices')
      .update({ last_seen_at: this.isoNow() }).eq('team_id', teamId).eq('id', deviceId).eq('owner_id', accountId)
      .is('revoked_at', null).select(DEVICE_COLUMNS).maybeSingle(), 'The local device is no longer active in this team.');
    if (!heartbeat) {
      this.db.prepare('UPDATE mingle_transport_local_devices SET registered = 0 WHERE account_id = ? AND team_id = ? AND device_id = ?')
        .run(accountId, teamId, deviceId);
      this.db.prepare(`UPDATE mingle_transport_outbox SET status = 'expired', error = 'Sender device is no longer active.'
        WHERE account_id = ? AND team_id = ? AND from_device_id = ? AND status = 'queued'`)
        .run(accountId, teamId, deviceId);
      throw new HttpError(403, 'The local device is no longer active.');
    }
    const [devices, links] = await Promise.all([
      this.query<CloudDeviceRow[]>(client.from('mingle_devices').select(DEVICE_COLUMNS).eq('team_id', teamId).order('created_at', { ascending: true }), 'The team device roster could not be loaded.'),
      this.query<CloudLinkRow[]>(client.from('mingle_device_links').select(LINK_COLUMNS).eq('team_id', teamId).order('created_at', { ascending: true }), 'The team trust links could not be loaded.'),
    ]);
    const rows = (devices ?? []).map((row) => ({ ...row }));
    // The heartbeat response is authoritative for this device even if a policy omits it from the roster query.
    if (!rows.some((row) => row.id === deviceId)) rows.push(heartbeat);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM mingle_transport_devices_cache WHERE account_id = ? AND team_id = ?').run(accountId, teamId);
      for (const row of rows) this.insertCachedDevice(accountId, row);
      this.db.prepare('DELETE FROM mingle_transport_links_cache WHERE account_id = ? AND team_id = ?').run(accountId, teamId);
      for (const link of links ?? []) this.insertCachedLink(accountId, link, false);
      this.recomputeMutualLinks(accountId, teamId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.cacheDevice(accountId, heartbeat);
  }

  private async flushOutbox(client: SupabaseClient, accountId: string, teamId: string, deviceId: string): Promise<void> {
    const entries = this.db.prepare(`SELECT * FROM mingle_transport_outbox WHERE account_id = ? AND team_id = ? AND from_device_id = ? AND status = 'queued' AND next_attempt_at <= ? ORDER BY created_at,id LIMIT 100`)
      .all(accountId, teamId, deviceId, this.now()) as unknown as LocalEnvelopeRow[];
    for (const entry of entries) {
      if (Date.parse(entry.expires_at) <= this.now()) {
        this.db.prepare(`UPDATE mingle_transport_outbox SET status = 'expired', error = 'Message expired before delivery.' WHERE id = ? AND account_id = ?`).run(entry.id, accountId);
        continue;
      }
      const envelope = JSON.parse(entry.envelope_json) as SignedEnvelope;
      const record = this.toCloudEnvelope(envelope);
      try {
        // Senders cannot SELECT their outbound envelopes. PostgreSQL's conflict
        // path also applies SELECT RLS, so use an INSERT without RETURNING.
        // A unique conflict confirms this durable envelope's identity was already
        // submitted, including a retry after an uncertain network response.
        const { error } = await client.from('mingle_envelopes').insert(record);
        const duplicateIdentity = error?.code === '23505' && [
          'mingle_envelopes_pkey',
          'mingle_envelopes_team_id_from_device_id_to_device_id_idempo_key',
        ].some((constraint) => error.message === `duplicate key value violates unique constraint "${constraint}"`);
        if (error && !duplicateIdentity) throw new Error('cloud-insert');
        this.db.prepare(`UPDATE mingle_transport_outbox SET status = 'delivered', attempts = attempts + 1, next_attempt_at = 0, error = NULL WHERE id = ? AND account_id = ?`)
          .run(entry.id, accountId);
        this.broadcastWake(client, entry.to_device_id);
      } catch (error) {
        const attempts = entry.attempts + 1;
        const retry = Math.min(MAX_RETRY_MS, this.retryBaseMs * (2 ** Math.min(20, attempts - 1)));
        const message = 'Mailbox delivery is waiting for a cloud retry.';
        this.db.prepare(`UPDATE mingle_transport_outbox SET attempts = ?, next_attempt_at = ?, error = ? WHERE id = ? AND account_id = ? AND status = 'queued'`)
          .run(attempts, this.now() + retry, message, entry.id, accountId);
        this.lastError = message;
        this.status = 'offline';
        this.scheduleRetrySync(this.now() + retry);
      }
    }
  }

  private scheduleRetrySync(at: number): void {
    if (this.closed || (this.retryTimer && this.retryTimerAt <= at)) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimerAt = at;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryTimerAt = Number.POSITIVE_INFINITY;
      void this.sync();
    }, Math.max(1, at - this.now()));
    this.retryTimer.unref();
  }

  private wakeChannelName(deviceId: string): string {
    return `mingle-device-wake:${deviceId}`;
  }

  /** Empty public Realtime broadcasts carry only a wake hint; the authenticated mailbox remains authoritative. */
  private ensureWakeSubscription(client: SupabaseClient, accountId: string, deviceId: string): void {
    if (typeof client.channel !== 'function') return;
    const key = `${accountId}:${deviceId}`;
    const current = this.wakeSubscriptions.get(key);
    if (current?.client === client || this.wakeRetryTimers.has(key)) return;
    if (current) this.removeWakeSubscription(key, current);
    let channel: ReturnType<SupabaseClient['channel']> | null = null;
    try {
      channel = client.channel(this.wakeChannelName(deviceId), { config: { broadcast: { ack: false } } });
      const subscription = { client, channel };
      this.wakeSubscriptions.set(key, subscription);
      channel.on('broadcast', { event: 'wake' }, () => {
        // The channel contains no mailbox contents. Its only job is to nudge a read
        // from the recipient-owned RLS-protected table and re-run cryptographic checks.
        this.wakeSync(deviceId);
      });
      channel.subscribe((status) => {
        if (this.wakeSubscriptions.get(key)?.channel !== channel || this.closed) return;
        if (status === 'SUBSCRIBED') {
          this.wakeRetryAttempts.delete(key);
          // Catch up after initial join/rejoin so a send during connection setup is not
          // delayed until the periodic poll. Durable mailbox reads recover missed hints.
          this.wakeSync(deviceId);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.removeWakeSubscription(key, subscription);
          this.scheduleWakeRetry(key, accountId, deviceId);
        }
      });
    } catch {
      if (channel && this.wakeSubscriptions.get(key)?.channel === channel) {
        this.removeWakeSubscription(key, { client, channel });
      }
      // Realtime is an optional accelerator. Continue polling while retrying the join.
      this.scheduleWakeRetry(key, accountId, deviceId);
    }
  }

  private removeWakeSubscription(key: string, subscription: WakeSubscription): void {
    if (this.wakeSubscriptions.get(key)?.channel === subscription.channel) this.wakeSubscriptions.delete(key);
    void subscription.client.removeChannel(subscription.channel).catch(() => undefined);
  }

  private scheduleWakeRetry(key: string, accountId: string, deviceId: string): void {
    if (this.closed || this.wakeRetryTimers.has(key)) return;
    const attempts = (this.wakeRetryAttempts.get(key) ?? 0) + 1;
    this.wakeRetryAttempts.set(key, attempts);
    const delay = Math.min(MAX_RETRY_MS, this.wakeRetryBaseMs * (2 ** Math.min(20, attempts - 1)));
    const timer = setTimeout(() => {
      this.wakeRetryTimers.delete(key);
      if (this.closed || this.currentAccountId() !== accountId) return;
      this.wakeSync(deviceId);
    }, delay);
    timer.unref();
    this.wakeRetryTimers.set(key, timer);
  }

  private removeStaleWakeSubscriptions(accountId: string, devices: LocalDeviceRow[]): void {
    const desired = new Set(devices.map((device) => `${accountId}:${device.device_id}`));
    for (const [key, subscription] of this.wakeSubscriptions) {
      if (!desired.has(key)) this.removeWakeSubscription(key, subscription);
    }
    for (const [key, timer] of this.wakeRetryTimers) {
      if (desired.has(key)) continue;
      clearTimeout(timer);
      this.wakeRetryTimers.delete(key);
      this.wakeRetryAttempts.delete(key);
    }
    for (const key of this.wakeRetryAttempts.keys()) {
      if (!desired.has(key)) this.wakeRetryAttempts.delete(key);
    }
  }

  private broadcastWake(client: SupabaseClient, deviceId: string): void {
    // One REST request, without joining the channel: subscribing and removing a channel per message
    // re-entered removeChannel through the CLOSED status callback and overflowed the stack.
    let channel: ReturnType<SupabaseClient['channel']> | null = null;
    try {
      channel = client.channel(this.wakeChannelName(deviceId), { config: { broadcast: { ack: false } } });
      const sent = channel;
      void sent.httpSend('wake', {}).catch(() => undefined).finally(() => { void client.removeChannel(sent).catch(() => undefined); });
    } catch {
      // A missing or unavailable Realtime transport silently falls back to mailbox polling.
      if (channel) void client.removeChannel(channel).catch(() => undefined);
    }
  }

  private async pullInbox(client: SupabaseClient, accountId: string, teamId: string, deviceId: string): Promise<void> {
    const cutoff = new Date(this.now()).toISOString();
    let total = 0;
    while (total < MAX_MAILBOX_ROWS_PER_SYNC) {
      const rows = await this.query<CloudEnvelopeRow[]>(client.from('mingle_envelopes').select(ENVELOPE_COLUMNS)
        .eq('team_id', teamId).eq('to_device_id', deviceId).gte('expires_at', cutoff)
        .order('received_at', { ascending: true }).order('id', { ascending: true }).range(0, PAGE_SIZE - 1),
      'Incoming mailbox messages could not be loaded.');
      const page = rows ?? [];
      const durableIds: string[] = [];
      for (const row of page) {
        if (!this.persistIncoming(accountId, teamId, deviceId, row)) {
          this.lastError = 'An inbox item could not be durably saved; it will remain in the cloud mailbox for retry.';
          return;
        }
        durableIds.push(row.id);
      }
      if (durableIds.length > 0) {
        // Local inbox inserts commit before this recipient-owned cloud delete. If deletion fails,
        // the next page re-reads the rows and SQLite deduplication preserves pending work.
        const { error } = await client.from('mingle_envelopes').delete()
          .eq('team_id', teamId).eq('to_device_id', deviceId).in('id', durableIds);
        if (error) {
          this.lastError = 'A durably received mailbox item could not be acknowledged; it will be retried.';
          return;
        }
      }
      total += page.length;
      if (page.length < PAGE_SIZE) return;
    }
    const remaining = await this.query<Array<{ id: string }>>(client.from('mingle_envelopes').select('id')
      .eq('team_id', teamId).eq('to_device_id', deviceId).gte('expires_at', cutoff)
      .order('received_at', { ascending: true }).order('id', { ascending: true }).range(0, 0),
    'Remaining mailbox work could not be checked.');
    if (remaining?.length) this.lastError = 'The mailbox exceeds the per-sync scan limit; remaining messages will continue on the next sync.';
  }

  private async deliverPending(accountId: string, teamId: string): Promise<void> {
    if (this.currentAccountId() !== accountId) return;
    const pending = this.db.prepare(`SELECT * FROM mingle_transport_inbox WHERE account_id = ? AND team_id = ? AND status = 'pending' AND next_attempt_at <= ? ORDER BY received_at,id LIMIT 100`)
      .all(accountId, teamId, this.now()) as unknown as LocalEnvelopeRow[];
    for (const row of pending) {
      if (Date.parse(row.expires_at) <= this.now()) {
        this.db.prepare(`UPDATE mingle_transport_inbox SET status = 'rejected', error = 'Message expired before delivery.' WHERE account_id = ? AND team_id = ? AND id = ?`)
          .run(accountId, row.team_id, row.id);
        continue;
      }
      const envelope = JSON.parse(row.envelope_json) as SignedEnvelope;
      try {
        // Refresh authenticated membership, device revocation and both fingerprint pins for every
        // dispatch. RLS supplies the current account identity; cached presence is never authority.
        const { own, senderRow } = await this.withAccount(async (client, user) => {
          if (user.id !== accountId) throw new HttpError(401, 'The signed-in account changed during mailbox delivery.');
          const own = this.requireLocalDevice(user.id, row.team_id);
          if (own.device_id !== row.to_device_id) throw new Error('device-revoked');
          await this.refreshTeam(client, user.id, row.team_id, own.device_id);
          const senderRow = this.deviceCacheRow(user.id, row.team_id, row.from_device_id);
          if (senderRow) {
            const member = await this.query<{ user_id: string } | null>(client.from('mingle_members').select('user_id')
              .eq('team_id', row.team_id).eq('user_id', senderRow.owner_id).is('revoked_at', null).maybeSingle(), 'The sender membership could not be verified.');
            if (!member) throw new HttpError(403, 'The sender is no longer an active team member.');
          }
          return { own, senderRow };
        }, false);
        if (own.device_id !== row.to_device_id || !senderRow || senderRow.revoked_at ||
          fingerprintForPublicKeys(senderRow.signing_public_key, senderRow.encryption_public_key) !== senderRow.fingerprint) {
          throw new Error('device-revoked');
        }
        const ownFingerprint = this.ownFingerprint(accountId, row.team_id);
        const ownPin = this.linkCacheRow(accountId, row.team_id, own.device_id, row.from_device_id);
        const peerPin = this.linkCacheRow(accountId, row.team_id, row.from_device_id, own.device_id);
        if (!ownPin || ownPin.peer_fingerprint !== senderRow.fingerprint || !peerPin || peerPin.peer_fingerprint !== ownFingerprint) throw new Error('link-revoked');
        this.validateEnvelope(envelope, row.team_id, row.from_device_id, row.to_device_id);
        const keys = this.loadKeys(accountId);
        const payload = openEnvelope({ envelope, recipient: keys, senderSigningPublicKey: senderRow.signing_public_key, senderEncryptionPublicKey: senderRow.encryption_public_key });
        const message: AuthenticatedTransportMessage = {
          id: envelope.id, teamId: envelope.teamId, fromDeviceId: envelope.fromDeviceId,
          toDeviceId: envelope.toDeviceId, kind: DistributedMessageKindSchema.parse(envelope.kind) as DistributedMessageKind,
          payload,
        };
        const claim = this.db.prepare(`UPDATE mingle_transport_inbox SET status = 'dispatching' WHERE account_id = ? AND team_id = ? AND id = ? AND status = 'pending'`)
          .run(accountId, row.team_id, row.id);
        if (claim.changes !== 1) continue;
        for (const handler of this.handlers) await this.handlerScope.run(true, () => handler(message));
        this.db.prepare(`UPDATE mingle_transport_inbox SET status = 'handled', attempts = attempts + 1, next_attempt_at = 0, error = NULL WHERE account_id = ? AND team_id = ? AND id = ? AND status = 'dispatching'`)
          .run(accountId, row.team_id, row.id);
      } catch (error) {
        const rejected = (error instanceof Error && ['device-revoked', 'link-revoked'].includes(error.message)) ||
          (error instanceof HttpError && [401, 403, 404, 409].includes(error.status));
        const attempts = row.attempts + 1;
        const retry = Math.min(MAX_RETRY_MS, this.retryBaseMs * (2 ** Math.min(20, attempts - 1)));
        const reason = rejected ? 'Current account membership, sender device, or mutual trust is no longer active.' : 'Message authentication or handler delivery failed.';
        this.db.prepare(`UPDATE mingle_transport_inbox SET status = ?, attempts = ?, next_attempt_at = ?, error = ? WHERE account_id = ? AND team_id = ? AND id = ? AND status IN ('pending','dispatching')`)
          .run(rejected ? 'rejected' : 'pending', attempts, rejected ? 0 : this.now() + retry, reason, accountId, row.team_id, row.id);
        if (!rejected) this.lastError = reason;
        if (!rejected) this.scheduleRetrySync(this.now() + retry);
      }
    }
  }

  private persistIncoming(accountId: string, teamId: string, deviceId: string, row: CloudEnvelopeRow): boolean {
    let envelope: SignedEnvelope;
    let receivedAt: string;
    try {
      if (typeof row.received_at !== 'string') return false;
      envelope = this.fromCloudEnvelope(row);
      receivedAt = normalizePostgresInstantForOrder(row.received_at);
      if (envelope.teamId !== teamId || envelope.toDeviceId !== deviceId) return true;
      this.validateEnvelope(envelope, teamId, envelope.fromDeviceId, deviceId);
    } catch {
      // Invalid routes, timestamps and expired rows are acknowledged rather than blocking later mail.
      return true;
    }
    let sender: Record<string, any> | undefined;
    let keys: DeviceKeyMaterial;
    try {
      sender = this.deviceCacheRow(accountId, teamId, envelope.fromDeviceId);
      const own = this.deviceCacheRow(accountId, teamId, deviceId);
      if (!sender || !own || sender.revoked_at || own.revoked_at) return true;
      // Local database/key-store errors must leave the relay item available for a later retry.
      keys = this.loadKeys(accountId);
    } catch { return false; }
    try {
      // Reject cryptographic tampering before retaining even an inbox record.
      openEnvelope({ envelope, recipient: keys, senderSigningPublicKey: sender.signing_public_key, senderEncryptionPublicKey: sender.encryption_public_key });
    } catch { return true; }
    try {
      this.db.prepare(`INSERT OR IGNORE INTO mingle_transport_inbox
        (id,account_id,team_id,from_device_id,to_device_id,idempotency_key,kind,envelope_json,status,attempts,next_attempt_at,error,created_at,expires_at,received_at)
        VALUES (?,?,?,?,?,?,?,?, 'pending',0,0,NULL,?,?,?)`)
        .run(envelope.id, accountId, teamId, envelope.fromDeviceId, envelope.toDeviceId, envelope.idempotencyKey,
          envelope.kind, JSON.stringify(envelope), envelope.createdAt, envelope.expiresAt, receivedAt);
      return true;
    } catch { return false; }
  }

  private validateEnvelope(envelope: SignedEnvelope, teamId: string, fromDeviceId: string, toDeviceId: string): void {
    if (!isUuid(envelope.id) || !isUuid(envelope.teamId) || !isUuid(envelope.fromDeviceId) || !isUuid(envelope.toDeviceId) ||
      envelope.teamId !== teamId || envelope.fromDeviceId !== fromDeviceId || envelope.toDeviceId !== toDeviceId ||
      typeof envelope.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(envelope.idempotencyKey) ||
      !DistributedMessageKindSchema.safeParse(envelope.kind).success || typeof envelope.createdAt !== 'string' || typeof envelope.expiresAt !== 'string') {
      throw new Error('invalid-route');
    }
    const created = Date.parse(envelope.createdAt);
    const expires = Date.parse(envelope.expiresAt);
    if (!Number.isFinite(created) || !Number.isFinite(expires) || created > this.now() + ALLOWED_CLOCK_SKEW_MS ||
      expires <= this.now() || expires <= created || expires - created > this.messageTtlMs + ALLOWED_CLOCK_SKEW_MS) throw new Error('invalid-expiry');
  }

  private ensureLocalIdentity(accountId: string, input: RegisterDeviceInput): LocalDeviceRow {
    let row = this.db.prepare('SELECT * FROM mingle_transport_local_devices WHERE account_id = ? AND team_id = ?')
      .get(accountId, input.teamId) as unknown as LocalDeviceRow | undefined;
    if (!row) {
      const deviceId = randomUUID();
      this.db.prepare(`INSERT INTO mingle_transport_local_devices(account_id,team_id,device_id,name,registered) VALUES(?,?,?,?,0)`)
        .run(accountId, input.teamId, deviceId, input.name);
      row = this.db.prepare('SELECT * FROM mingle_transport_local_devices WHERE account_id = ? AND team_id = ?')
        .get(accountId, input.teamId) as unknown as LocalDeviceRow;
    }
    return row;
  }

  private localDevices(accountId: string): LocalDeviceRow[] {
    return this.db.prepare('SELECT * FROM mingle_transport_local_devices WHERE account_id = ? ORDER BY team_id')
      .all(accountId) as unknown as LocalDeviceRow[];
  }

  private rotateLocalIdentity(accountId: string, input: RegisterDeviceInput): LocalDeviceRow {
    const deviceId = randomUUID();
    this.db.prepare('UPDATE mingle_transport_local_devices SET device_id = ?, name = ?, registered = 0 WHERE account_id = ? AND team_id = ?')
      .run(deviceId, input.name, accountId, input.teamId);
    return this.db.prepare('SELECT * FROM mingle_transport_local_devices WHERE account_id = ? AND team_id = ?')
      .get(accountId, input.teamId) as unknown as LocalDeviceRow;
  }

  private requireLocalDevice(accountId: string, teamId: string): LocalDeviceRow {
    const row = this.db.prepare('SELECT * FROM mingle_transport_local_devices WHERE account_id = ? AND team_id = ?')
      .get(accountId, teamId) as LocalDeviceRow | undefined;
    if (!row || row.registered !== 1) throw new HttpError(409, 'Register this device in the team before using its mailbox.');
    return row;
  }

  private withAccount<T>(work: (client: SupabaseClient, user: User, keys: DeviceKeyMaterial) => Promise<T>, notify = true): Promise<T> {
    const before = notify ? this.changeSignature() : null;
    return this.options.account.withAuthenticatedClient(async (client, user) => {
      if (!user?.id || user.is_anonymous) throw new HttpError(401, 'A verified Mingle account is required for distributed devices.');
      if (this.activeAccountId && this.activeAccountId !== user.id) this.keyCache.delete(this.activeAccountId);
      this.activeAccountId = user.id;
      const keys = this.loadKeys(user.id);
      try {
        const result = await work(client, user, keys);
        if (!this.lastError) this.status = this.localDevices(user.id).some((row) => row.registered === 1) ? 'ready' : 'unregistered';
        return result;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        this.recordFailure('The authenticated cloud operation could not be completed.');
        throw new HttpError(502, 'The authenticated cloud operation could not be completed.');
      } finally { if (before !== null) this.notifyIfChanged(before); }
    });
  }

  /** Compare only durable state that affects the transport snapshot or received-message work. */
  private changeSignature(): string {
    const accountId = this.currentAccountId();
    if (!accountId) return JSON.stringify({ accountId: null, status: 'signed-out', error: null });
    const devices = (this.db.prepare('SELECT * FROM mingle_transport_devices_cache WHERE account_id = ? ORDER BY team_id,id')
      .all(accountId) as Record<string, unknown>[]).map((row) => {
      const { lastSeenAt: _lastSeenAt, ...device } = this.publicDevice(row);
      return device;
    });
    const links = this.db.prepare('SELECT team_id,device_id,peer_device_id,peer_fingerprint,created_at,mutual FROM mingle_transport_links_cache WHERE account_id = ? ORDER BY team_id,device_id,peer_device_id')
      .all(accountId);
    const outbox = this.db.prepare(`SELECT id,team_id,to_device_id,kind,created_at,expires_at,status,attempts,error
      FROM mingle_transport_outbox WHERE account_id = ? AND kind != 'teamgroup.delivery.heartbeat' ORDER BY created_at DESC,id DESC LIMIT 100`).all(accountId);
    const inbox = this.db.prepare(`SELECT id,team_id,from_device_id,to_device_id,kind,status,attempts,error,received_at
      FROM mingle_transport_inbox WHERE account_id = ? AND kind != 'teamgroup.delivery.heartbeat' ORDER BY received_at DESC,id DESC LIMIT 1000`).all(accountId);
    const localDevices = this.localDevices(accountId);
    const snapshot = this.snapshot();
    return JSON.stringify({ accountId, status: snapshot.status, error: snapshot.error, deviceId: snapshot.deviceId, localDevices, devices, links, outbox, inbox });
  }

  private notifyIfChanged(before: string): void {
    if (this.changeSignature() !== before) this.options.changed?.();
  }

  private loadKeys(accountId: string): DeviceKeyMaterial {
    const cached = this.keyCache.get(accountId);
    if (cached) return cached;
    const directory = path.join(this.options.dataDir, 'distributed', 'keys');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { chmodSync(directory, 0o700); } catch { /* Windows does not expose POSIX directory modes. */ }
    const file = path.join(directory, `${createHash('sha256').update(accountId).digest('hex')}.json`);
    let keys: DeviceKeyMaterial;
    if (existsSync(file)) {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Device key file must be a regular file.');
      try { chmodSync(file, 0o600); } catch { /* Windows does not expose POSIX file modes. */ }
      const saved = JSON.parse(readFileSync(file, 'utf8')) as StoredKeyFile;
      if (saved.version !== 1 || saved.accountId !== accountId) throw new Error('Device key file belongs to another account or version.');
      keys = restoreDeviceKeyMaterial(saved);
    } else {
      keys = generateDeviceKeyMaterial();
      const saved: StoredKeyFile = {
        version: 1, accountId, signingPrivateKeyDer: keys.signingPrivateKeyDer,
        signingPublicKeyDer: keys.signingPublicKeyDer, encryptionPrivateKeyDer: keys.encryptionPrivateKeyDer,
        encryptionPublicKeyDer: keys.encryptionPublicKeyDer,
      };
      const temporary = `${file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(saved), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      try { renameSync(temporary, file); } catch (error) { throw error; }
      try { chmodSync(file, 0o600); } catch { /* Windows does not expose POSIX file modes. */ }
    }
    this.keyCache.set(accountId, keys);
    return keys;
  }

  private cacheDevice(accountId: string, row: CloudDeviceRow): void {
    this.insertCachedDevice(accountId, row);
  }

  private insertCachedDevice(accountId: string, row: CloudDeviceRow): void {
    this.db.prepare(`INSERT INTO mingle_transport_devices_cache
      (account_id,team_id,id,owner_id,name,signing_public_key,encryption_public_key,fingerprint,last_seen_at,revoked_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,team_id,id) DO UPDATE SET
      owner_id=excluded.owner_id,name=excluded.name,signing_public_key=excluded.signing_public_key,encryption_public_key=excluded.encryption_public_key,
      fingerprint=excluded.fingerprint,last_seen_at=excluded.last_seen_at,revoked_at=excluded.revoked_at,created_at=excluded.created_at`)
      .run(accountId, row.team_id, row.id, row.owner_id, row.name, row.signing_public_key, row.encryption_public_key,
        row.fingerprint, row.last_seen_at, row.revoked_at, row.created_at);
  }

  private insertCachedLink(accountId: string, row: CloudLinkRow, mutual: boolean): void {
    this.db.prepare(`INSERT INTO mingle_transport_links_cache
      (account_id,team_id,device_id,peer_device_id,peer_fingerprint,created_at,mutual)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,team_id,device_id,peer_device_id) DO UPDATE SET
      peer_fingerprint=excluded.peer_fingerprint,created_at=excluded.created_at,mutual=excluded.mutual`)
      .run(accountId, row.team_id, row.device_id, row.peer_device_id, row.peer_fingerprint, row.created_at, mutual ? 1 : 0);
  }

  private recomputeMutualLinks(accountId: string, teamId: string): void {
    const links = this.db.prepare('SELECT * FROM mingle_transport_links_cache WHERE account_id = ? AND team_id = ?')
      .all(accountId, teamId) as Record<string, unknown>[];
    const devices = new Map((this.db.prepare('SELECT * FROM mingle_transport_devices_cache WHERE account_id = ? AND team_id = ?')
      .all(accountId, teamId) as Record<string, unknown>[]).map((row) => [String(row.id), row]));
    for (const link of links) {
      const peer = devices.get(String(link.peer_device_id));
      const reverse = links.find((candidate) => candidate.device_id === link.peer_device_id && candidate.peer_device_id === link.device_id);
      const own = devices.get(String(link.device_id));
      const mutual = Boolean(peer && own && !peer.revoked_at && !own.revoked_at &&
        link.peer_fingerprint === peer.fingerprint && reverse && reverse.peer_fingerprint === own.fingerprint);
      this.db.prepare('UPDATE mingle_transport_links_cache SET mutual = ? WHERE account_id = ? AND team_id = ? AND device_id = ? AND peer_device_id = ?')
        .run(mutual ? 1 : 0, accountId, teamId, String(link.device_id), String(link.peer_device_id));
    }
  }

  private deviceCacheRow(accountId: string, teamId: string, deviceId: string): Record<string, any> | undefined {
    return this.db.prepare('SELECT * FROM mingle_transport_devices_cache WHERE account_id = ? AND team_id = ? AND id = ?')
      .get(accountId, teamId, deviceId) as Record<string, any> | undefined;
  }

  private linkCacheRow(accountId: string, teamId: string, deviceId: string, peerDeviceId: string): Record<string, any> | undefined {
    return this.db.prepare('SELECT * FROM mingle_transport_links_cache WHERE account_id = ? AND team_id = ? AND device_id = ? AND peer_device_id = ?')
      .get(accountId, teamId, deviceId, peerDeviceId) as Record<string, any> | undefined;
  }

  private ownFingerprint(accountId: string, teamId: string): string | null {
    const own = this.requireLocalDevice(accountId, teamId);
    return (this.deviceCacheRow(accountId, teamId, own.device_id)?.fingerprint as string | undefined) ?? null;
  }

  private publicDevice(row: Record<string, unknown>): DistributedDevice {
    const lastSeenAt = typeof row.last_seen_at === 'string' ? row.last_seen_at : null;
    const revokedAt = typeof row.revoked_at === 'string' ? row.revoked_at : null;
    const age = lastSeenAt ? this.now() - Date.parse(lastSeenAt) : Number.POSITIVE_INFINITY;
    const status = revokedAt ? 'revoked' : age >= 0 && age <= this.onlineWindowMs ? 'online' : 'offline';
    return {
      id: String(row.id), teamId: String(row.team_id), ownerId: String(row.owner_id), name: String(row.name),
      signingPublicKey: String(row.signing_public_key), encryptionPublicKey: String(row.encryption_public_key),
      fingerprint: String(row.fingerprint), lastSeenAt, revokedAt,
      createdAt: String(row.created_at), status,
    };
  }

  private publicLink(row: Record<string, unknown>): DistributedDeviceLink {
    return {
      teamId: String(row.team_id), deviceId: String(row.device_id), peerDeviceId: String(row.peer_device_id),
      peerFingerprint: String(row.peer_fingerprint), createdAt: String(row.created_at), mutual: row.mutual === 1 || row.mutual === true,
    };
  }

  private publicOutbox(row: Record<string, unknown>): DistributedOutboxItem {
    return {
      id: String(row.id), teamId: String(row.team_id), toDeviceId: String(row.to_device_id),
      kind: String(row.kind) as DistributedMessageKind, createdAt: String(row.created_at), expiresAt: String(row.expires_at),
      status: String(row.status) as DistributedOutboxItem['status'], attempts: Number(row.attempts),
      error: typeof row.error === 'string' ? row.error : null,
    };
  }

  private async query<T>(request: PromiseLike<CloudResult<T>>, failureMessage: string): Promise<T | null> {
    const result = await request;
    if (result.error) {
      const error = new Error(failureMessage) as Error & { code?: string };
      error.code = result.error.code;
      throw error;
    }
    return result.data;
  }

  private toCloudEnvelope(envelope: SignedEnvelope): Omit<CloudEnvelopeRow, 'received_at'> {
    return {
      id: envelope.id, team_id: envelope.teamId, from_device_id: envelope.fromDeviceId, to_device_id: envelope.toDeviceId,
      idempotency_key: envelope.idempotencyKey, kind: envelope.kind, ciphertext: envelope.ciphertext,
      nonce: envelope.nonce, signature: envelope.signature, created_at: envelope.createdAt, expires_at: envelope.expiresAt,
    };
  }

  private fromCloudEnvelope(row: CloudEnvelopeRow): SignedEnvelope {
    return {
      id: row.id, teamId: row.team_id, fromDeviceId: row.from_device_id, toDeviceId: row.to_device_id,
      idempotencyKey: row.idempotency_key, kind: row.kind, ciphertext: row.ciphertext, nonce: row.nonce,
      signature: row.signature, createdAt: normalizePostgresInstant(row.created_at), expiresAt: normalizePostgresInstant(row.expires_at),
    };
  }

  private currentAccountId(): string | null {
    const current = this.options.account.snapshot?.();
    if (current) {
      if (current.status !== 'signed-in' || !current.user?.id) return null;
      return current.user.id;
    }
    return this.activeAccountId;
  }

  private isSignedIn(): boolean { return this.currentAccountId() !== null; }
  private isoNow(): string { return new Date(this.now()).toISOString(); }
  private markHealthy(): void { this.status = 'ready'; this.lastError = null; this.lastSyncAt = this.now(); }
  private recordFailure(message: string): void { this.status = 'error'; this.lastError = message; }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mingle_transport_local_devices (
        account_id TEXT NOT NULL, team_id TEXT NOT NULL, device_id TEXT NOT NULL, name TEXT NOT NULL,
        registered INTEGER NOT NULL DEFAULT 0 CHECK(registered IN (0,1)), PRIMARY KEY(account_id,team_id), UNIQUE(account_id,team_id,device_id)
      );
      CREATE TABLE IF NOT EXISTS mingle_transport_devices_cache (
        account_id TEXT NOT NULL, team_id TEXT NOT NULL, id TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        signing_public_key TEXT NOT NULL, encryption_public_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        last_seen_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL, PRIMARY KEY(account_id,team_id,id)
      );
      CREATE TABLE IF NOT EXISTS mingle_transport_links_cache (
        account_id TEXT NOT NULL, team_id TEXT NOT NULL, device_id TEXT NOT NULL, peer_device_id TEXT NOT NULL,
        peer_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, mutual INTEGER NOT NULL DEFAULT 0 CHECK(mutual IN (0,1)),
        PRIMARY KEY(account_id,team_id,device_id,peer_device_id)
      );
      CREATE TABLE IF NOT EXISTS mingle_transport_outbox (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, team_id TEXT NOT NULL, from_device_id TEXT NOT NULL, to_device_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, kind TEXT NOT NULL, envelope_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','delivered','expired')), attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        UNIQUE(account_id,team_id,from_device_id,to_device_id,idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS mingle_transport_outbox_due ON mingle_transport_outbox(account_id,status,next_attempt_at,created_at);
      CREATE TABLE IF NOT EXISTS mingle_transport_inbox (
        id TEXT NOT NULL, account_id TEXT NOT NULL, team_id TEXT NOT NULL, from_device_id TEXT NOT NULL, to_device_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, kind TEXT NOT NULL, envelope_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','dispatching','handled','rejected','uncertain')), attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, received_at TEXT NOT NULL,
        PRIMARY KEY(account_id,team_id,id), UNIQUE(account_id,team_id,from_device_id,to_device_id,idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS mingle_transport_inbox_due ON mingle_transport_inbox(account_id,status,next_attempt_at,created_at);
    `);
    // A crash while a handler was executing leaves an unknown outcome. Never replay that item;
    // the durable uncertain row is safer than running a potentially dispatched operation twice.
    this.db.prepare(`UPDATE mingle_transport_inbox SET status = 'uncertain', error = 'Handler outcome is unknown after an interrupted dispatch.' WHERE status = 'dispatching'`).run();
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** PostgREST returns timestamptz with offsets and variable precision; signatures use canonical JS UTC milliseconds. */
function normalizePostgresInstant(value: string): string {
  return parsePostgresInstant(value).milliseconds;
}

function normalizePostgresInstantForOrder(value: string): string {
  return parsePostgresInstant(value).microseconds;
}

function parsePostgresInstant(value: string): { milliseconds: string; microseconds: string } {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error('Mailbox timestamp is malformed.');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('Mailbox timestamp is invalid.');
  const fractional = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? '';
  const subMillisecondMicros = Number(fractional.slice(3, 6).padEnd(3, '0'));
  const milliseconds = new Date(timestamp).toISOString();
  const microseconds = milliseconds.replace(/Z$/, `${subMillisecondMicros.toString().padStart(3, '0')}Z`);
  return { milliseconds, microseconds };
}
