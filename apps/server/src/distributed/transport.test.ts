import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../util.ts';
import { fingerprintForPublicKeys, generateDeviceKeyMaterial, openEnvelope, sealEnvelope } from './crypto.ts';
import { RetryableTransportDeliveryError, TransportService } from './transport.ts';

const teamId = '737a46b3-42ac-4f5e-9f69-5bf451e4c1a2';
const secondTeamId = '837a46b3-42ac-4f5e-9f69-5bf451e4c1a2';
const userA = '220f8441-9dbe-49b2-928d-5f2f9db2eab6';
const userB = '6d34d2e2-4fed-4ed6-bc1f-32f22dbe6bf2';
const userOutside = 'ab12f39d-1d36-4937-8d20-f87f3e7a59f4';
const temporaryDirectories: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface CloudDevice {
  id: string; team_id: string; owner_id: string; name: string; signing_public_key: string; encryption_public_key: string;
  fingerprint: string; last_seen_at: string; revoked_at: string | null; created_at: string;
}
interface CloudLink { team_id: string; device_id: string; peer_device_id: string; peer_fingerprint: string; created_at: string }
interface CloudEnvelope {
  id: string; team_id: string; from_device_id: string; to_device_id: string; idempotency_key: string; kind: string;
  ciphertext: string; nonce: string; signature: string; created_at: string; expires_at: string; received_at: string;
}
type Row = Record<string, any>;
type Result = { data: any; error: { code?: string; message?: string } | null };

/** Small authenticated PostgREST model for exercising the production service against the migration's RLS rules. */
class MailboxCloud {
  readonly devices: CloudDevice[] = [];
  readonly links: CloudLink[] = [];
  readonly envelopes: CloudEnvelope[] = [];
  envelopeWriteError: Result['error'] = null;
  readonly members = new Map<string, Set<string>>([[teamId, new Set([userA, userB])]]);
  now: () => number = Date.now;
  authRttMs = 0;
  authRequests = 0;
  readonly authRequestsByUser = new Map<string, number>();
  postgrestRttMs = 0;
  postgrestRequests = 0;
  readonly postgrestRequestsByUser = new Map<string, number>();
  realtimeRttMs = 0;
  realtimeRequests = 0;
  failRealtimeSends = 0;
  failChannelSends = 0;
  failMemberRosterReads = 0;
  channelSendCalls = 0;
  readonly channelRemovals = new Map<string, number>();
  readonly inboxPullsByUserTeam = new Map<string, number>();
  lastWakePublishedAt = 0;
  failEnvelopeWrites = 0;
  readonly wakes: Array<{ channel: string; event: string; payload: unknown }> = [];
  readonly wakeSubscribeAttempts = new Map<string, number>();
  private readonly failedWakeSubscriptions = new Map<string, number>();
  private readonly wakeListeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly clients = new Map<string, SupabaseClient>();
  private heartbeatBlock: { teamId: string; entered: () => void; enteredPromise: Promise<void>; releasePromise: Promise<void>; release: () => void } | null = null;
  private memberRosterBlock: { teamId: string; entered: () => void; enteredPromise: Promise<void>; releasePromise: Promise<void>; release: () => void } | null = null;
  constructor(private readonly realtime = false) {}
  failWakeSubscriptions(user: string, count: number): void { this.failedWakeSubscriptions.set(user, count); }
  blockNextHeartbeat(teamId: string): { entered: Promise<void>; release: () => void } {
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    this.heartbeatBlock = { teamId, entered, enteredPromise, releasePromise, release };
    return { entered: enteredPromise, release };
  }
  blockNextMemberRoster(teamId: string): { entered: Promise<void>; release: () => void } {
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    this.memberRosterBlock = { teamId, entered, enteredPromise, releasePromise, release };
    return { entered: enteredPromise, release };
  }
  private active(user: string, team: string): boolean { return this.members.get(team)?.has(user) ?? false; }
  private device(id: string, team: string): CloudDevice | undefined { return this.devices.find((row) => row.id === id && row.team_id === team); }
  private owns(user: string, id: string, team: string): boolean { return this.device(id, team)?.owner_id === user; }
  private mutual(team: string, a: string, b: string): boolean {
    const left = this.device(a, team);
    const right = this.device(b, team);
    return Boolean(left && right && !left.revoked_at && !right.revoked_at && this.active(left.owner_id, team) && this.active(right.owner_id, team) &&
      this.links.some((link) => link.team_id === team && link.device_id === a && link.peer_device_id === b && link.peer_fingerprint === right.fingerprint) &&
      this.links.some((link) => link.team_id === team && link.device_id === b && link.peer_device_id === a && link.peer_fingerprint === left.fingerprint));
  }
  client(user: string): SupabaseClient {
    const existing = this.clients.get(user);
    if (existing) return existing;
    if (!this.realtime) {
      const client = { from: (table: string) => new MailboxQuery(this, user, table) } as unknown as SupabaseClient;
      this.clients.set(user, client);
      return client;
    }
    const channelsByTopic = new Map<string, { channel: any; listeners: Map<string, (payload: unknown) => void>; subscribed: boolean;
      callback: ((status: string) => void) | null; subscribedListeners: Map<string, Set<(payload: unknown) => void>> }>();
    const client = {
      from: (table: string) => new MailboxQuery(this, user, table),
      channel: (name: string) => {
        const existing = channelsByTopic.get(name);
        if (existing) return existing.channel;
        const cloud = this;
        const listeners = new Map<string, (payload: unknown) => void>();
        const state = { channel: null as any, listeners, subscribed: false, callback: null as ((status: string) => void) | null,
          subscribedListeners: new Map<string, Set<(payload: unknown) => void>>() };
        const deliver = (event: string, payload: unknown) => {
          cloud.wakes.push({ channel: name, event, payload: structuredClone(payload) });
          cloud.lastWakePublishedAt = performance.now();
          queueMicrotask(() => {
            for (const callback of [...(cloud.wakeListeners.get(`${name}:${event}`) ?? [])]) callback(payload);
          });
        };
        const channel: any = {
          on(_type: string, filter: { event: string }, callback: (payload: unknown) => void) {
            listeners.set(filter.event, (payload) => callback({ payload }));
            return channel;
          },
          subscribe(callback?: (status: string) => void) {
            cloud.wakeSubscribeAttempts.set(user, (cloud.wakeSubscribeAttempts.get(user) ?? 0) + 1);
            state.callback = callback ?? null;
            const failures = cloud.failedWakeSubscriptions.get(user) ?? 0;
            if (failures > 0) {
              cloud.failedWakeSubscriptions.set(user, failures - 1);
              queueMicrotask(() => callback?.('TIMED_OUT'));
              return channel;
            }
            queueMicrotask(() => {
              if (state.channel !== channel || !channelsByTopic.has(name)) return;
              state.subscribed = true;
              for (const [event, listener] of listeners) {
                const key = `${name}:${event}`;
                let eventListeners = cloud.wakeListeners.get(key);
                if (!eventListeners) { eventListeners = new Set(); cloud.wakeListeners.set(key, eventListeners); }
                eventListeners.add(listener);
                state.subscribedListeners.set(key, eventListeners);
              }
              callback?.('SUBSCRIBED');
            });
            return channel;
          },
          async httpSend(event: string, payload: unknown) {
            cloud.realtimeRequests++;
            if (cloud.realtimeRttMs > 0) await new Promise((resolve) => setTimeout(resolve, cloud.realtimeRttMs));
            if (cloud.failRealtimeSends > 0) {
              cloud.failRealtimeSends--;
              return { success: false, status: 503, error: 'simulated Realtime failure' };
            }
            deliver(event, payload);
            return { success: true };
          },
          async send(message: { type: string; event: string; payload: unknown }) {
            cloud.channelSendCalls++;
            if (message.type !== 'broadcast' || !state.subscribed) return 'error';
            if (cloud.failChannelSends > 0) {
              cloud.failChannelSends--;
              return 'error';
            }
            deliver(message.event, message.payload);
            return 'ok';
          },
          async unsubscribe() {
            state.subscribed = false;
            for (const [key, eventListeners] of state.subscribedListeners) {
              for (const listener of listeners.values()) eventListeners.delete(listener);
              if (!eventListeners.size) cloud.wakeListeners.delete(key);
            }
            state.subscribedListeners.clear();
            if (channelsByTopic.get(name)?.channel === channel) channelsByTopic.delete(name);
            cloud.channelRemovals.set(`${user}:${name}`, (cloud.channelRemovals.get(`${user}:${name}`) ?? 0) + 1);
            state.callback?.('CLOSED');
            return 'ok';
          },
        };
        state.channel = channel;
        channelsByTopic.set(name, state);
        return channel;
      },
      removeChannel: async (channel: any) => channel.unsubscribe?.() ?? 'ok',
    } as unknown as SupabaseClient;
    this.clients.set(user, client);
    return client;
  }
  private isoNow(): string { return new Date(this.now()).toISOString(); }
  async execute(user: string, table: string, action: string, values: any, filters: Array<[string, string, unknown]>, range: [number, number] | null, order: Array<[string, boolean]>, returning: boolean): Promise<Result> {
    this.postgrestRequests++;
    this.postgrestRequestsByUser.set(user, (this.postgrestRequestsByUser.get(user) ?? 0) + 1);
    if (this.postgrestRttMs > 0) await new Promise((resolve) => setTimeout(resolve, this.postgrestRttMs));
    const teamFilter = filters.find(([, column]) => column === 'team_id')?.[2];
    const blocked = this.heartbeatBlock;
    if (blocked && table === 'mingle_devices' && action === 'update' && blocked.teamId === teamFilter) {
      this.heartbeatBlock = null;
      blocked.entered();
      await blocked.releasePromise;
    }
    const memberBlock = this.memberRosterBlock;
    if (memberBlock && table === 'mingle_members' && action === 'select' && memberBlock.teamId === teamFilter) {
      this.memberRosterBlock = null;
      memberBlock.entered();
      await memberBlock.releasePromise;
    }
    if (table === 'mingle_members' && action === 'select' && this.failMemberRosterReads > 0) {
      this.failMemberRosterReads--;
      return { data: null, error: { code: '503', message: 'simulated roster refresh failure' } };
    }
    const rows = this.table(table);
    const inboxTeamId = filters.find(([, column]) => column === 'team_id')?.[2];
    if (table === 'mingle_envelopes' && action === 'select' && filters.some(([, column]) => column === 'to_device_id')) {
      const key = `${user}:${String(inboxTeamId)}`;
      this.inboxPullsByUserTeam.set(key, (this.inboxPullsByUserTeam.get(key) ?? 0) + 1);
    }
    if (action === 'insert' && table === 'mingle_envelopes' && this.envelopeWriteError) return { data: null, error: this.envelopeWriteError };
    if ((action === 'insert' || action === 'upsert') && table === 'mingle_envelopes' && this.failEnvelopeWrites > 0) {
      this.failEnvelopeWrites -= 1;
      return { data: null, error: { code: '503', message: 'simulated offline mailbox' } };
    }
    const matches = (row: Row) => filters.every(([op, key, expected]) => {
      if (op === 'gte') return String(row[key]) >= String(expected);
      if (op === 'is') return row[key] === expected;
      if (op === 'in') return (expected as unknown[]).includes(row[key]);
      return row[key] === expected;
    });
    if (action === 'select') {
      let visible = rows.filter((row) => matches(row) && this.canRead(user, table, row));
      for (const [key, ascending] of [...order].reverse()) visible.sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1));
      if (range) visible = visible.slice(range[0], range[1] + 1);
      return { data: structuredClone(visible), error: null };
    }
    if (action === 'insert' || action === 'upsert') {
      const items = (Array.isArray(values) ? values : [values]) as Row[];
      const inserted: Row[] = [];
      for (const item of items) {
        if (action === 'upsert' && table === 'mingle_envelopes' && this.envelopes.some((row) => row.team_id === item.team_id && row.from_device_id === item.from_device_id && row.to_device_id === item.to_device_id && row.idempotency_key === item.idempotency_key)) continue;
        const error = this.insert(user, table, item);
        if (error) return { data: null, error };
        if (returning) inserted.push(rows.at(-1)!);
      }
      return { data: returning ? inserted : null, error: null };
    }
    if (action === 'update') {
      const selected = rows.filter((row) => matches(row));
      if (table !== 'mingle_devices' || !Object.keys(values as Row).every((key) => ['last_seen_at', 'revoked_at'].includes(key))) return { data: null, error: { code: '42501', message: 'update not allowed' } };
      const updated: Row[] = [];
      for (const row of selected) {
        if (!this.active(user, row.team_id) || row.owner_id !== user || row.revoked_at) continue;
        if ('revoked_at' in values) row.revoked_at = values.revoked_at ? this.isoNow() : null;
        row.last_seen_at = this.isoNow();
        updated.push(structuredClone(row));
      }
      return { data: updated, error: null };
    }
    if (action === 'delete') {
      const removed = rows.filter((row) => matches(row) && (table === 'mingle_device_links'
        ? this.active(user, row.team_id) && this.owns(user, row.device_id, row.team_id) && !this.device(row.device_id, row.team_id)?.revoked_at
        : table === 'mingle_envelopes' && this.canRead(user, table, row)));
      const remove = new Set(removed);
      const remaining = rows.filter((row) => !remove.has(row));
      rows.splice(0, rows.length, ...remaining);
      return { data: removed, error: null };
    }
    return { data: null, error: { code: '0A000', message: 'unsupported test operation' } };
  }
  private table(table: string): Row[] {
    if (table === 'mingle_members') return [...this.members].flatMap(([team_id, users]) => [...users].map((user_id) => ({ team_id, user_id, revoked_at: null })));
    if (table === 'mingle_devices') return this.devices as unknown as Row[];
    if (table === 'mingle_device_links') return this.links as unknown as Row[];
    if (table === 'mingle_envelopes') return this.envelopes as unknown as Row[];
    throw new Error(`Unexpected table ${table}`);
  }
  private canRead(user: string, table: string, row: Row): boolean {
    if (!this.active(user, row.team_id)) return false;
    if (table === 'mingle_members' || table === 'mingle_devices') return true;
    if (table === 'mingle_device_links') return this.owns(user, row.device_id, row.team_id) || this.owns(user, row.peer_device_id, row.team_id);
    return row.to_device_id === this.devices.find((device) => device.team_id === row.team_id && device.owner_id === user && !device.revoked_at)?.id &&
      this.mutual(row.team_id, row.from_device_id, row.to_device_id) && Date.parse(row.expires_at) > this.now();
  }
  private insert(user: string, table: string, item: Row): { code: string; message: string } | null {
    if (!this.active(user, item.team_id)) return { code: '42501', message: 'not an active team member' };
    if (table === 'mingle_devices') {
      if (item.owner_id !== user || this.devices.some((row) => row.id === item.id)) return { code: '42501', message: 'device insert denied' };
      const row = { ...item, last_seen_at: this.isoNow(), created_at: this.isoNow(), revoked_at: null } as CloudDevice;
      this.devices.push(row);
      return null;
    }
    if (table === 'mingle_device_links') {
      const own = this.device(item.device_id, item.team_id);
      const peer = this.device(item.peer_device_id, item.team_id);
      if (!own || own.owner_id !== user || own.revoked_at || !peer || peer.revoked_at || peer.fingerprint !== item.peer_fingerprint || !this.active(peer.owner_id, item.team_id)) return { code: '42501', message: 'link insert denied' };
      if (this.links.some((row) => row.team_id === item.team_id && row.device_id === item.device_id && row.peer_device_id === item.peer_device_id)) return { code: '23505', message: 'duplicate link' };
      this.links.push({ ...item, created_at: this.isoNow() } as CloudLink);
      return null;
    }
    if (table === 'mingle_envelopes') {
      const sender = this.device(item.from_device_id, item.team_id);
      const recipient = this.device(item.to_device_id, item.team_id);
      if (!sender || sender.owner_id !== user || !recipient || sender.revoked_at || recipient.revoked_at || !this.active(recipient.owner_id, item.team_id) || !this.mutual(item.team_id, sender.id, recipient.id)) return { code: '42501', message: 'envelope insert denied' };
      if (this.envelopes.some((row) => row.team_id === item.team_id && row.from_device_id === item.from_device_id && row.to_device_id === item.to_device_id && row.idempotency_key === item.idempotency_key)) return { code: '23505', message: 'duplicate key value violates unique constraint "mingle_envelopes_team_id_from_device_id_to_device_id_idempo_key"' };
      this.envelopes.push({ ...item, received_at: this.isoNow() } as CloudEnvelope);
      return null;
    }
    return { code: '42501', message: 'insert denied' };
  }
}

class MailboxQuery implements PromiseLike<Result> {
  private action = 'select';
  private values: any;
  private filters: Array<[string, string, unknown]> = [];
  private rangeValue: [number, number] | null = null;
  private orderValues: Array<[string, boolean]> = [];
  private returning = false;
  constructor(private readonly cloud: MailboxCloud, private readonly user: string, private readonly table: string) {}
  select(_columns?: string): this { if (this.action !== 'select') this.returning = true; return this; }
  insert(values: unknown): this { this.action = 'insert'; this.values = values; return this; }
  upsert(values: unknown, _options?: unknown): this { this.action = 'upsert'; this.values = values; return this; }
  update(values: unknown): this { this.action = 'update'; this.values = values; return this; }
  delete(): this { this.action = 'delete'; return this; }
  eq(column: string, value: unknown): this { this.filters.push(['eq', column, value]); return this; }
  is(column: string, value: unknown): this { this.filters.push(['is', column, value]); return this; }
  gte(column: string, value: unknown): this { this.filters.push(['gte', column, value]); return this; }
  order(column: string, options?: { ascending?: boolean }): this { this.orderValues.push([column, options?.ascending !== false]); return this; }
  range(from: number, to: number): this { this.rangeValue = [from, to]; return this; }
  in(column: string, values: unknown[]): this { this.filters.push(['in', column, values]); return this; }
  async maybeSingle(): Promise<Result> {
    const result = await this.execute();
    const values = Array.isArray(result.data) ? result.data : [];
    return { ...result, data: values[0] ?? null };
  }
  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
  private execute(): Promise<Result> { return this.cloud.execute(this.user, this.table, this.action, this.values, this.filters, this.rangeValue, this.orderValues, this.returning); }
}

function account(cloud: MailboxCloud, id: string) {
  const user = { id, app_metadata: { provider: 'google' }, user_metadata: {}, aud: 'authenticated', created_at: new Date().toISOString() } as User;
  return {
    snapshot: () => ({ status: 'signed-in', user: { id } }),
    withAuthenticatedClient: async <T>(callback: (client: SupabaseClient, verifiedUser: User) => Promise<T>): Promise<T> => {
      cloud.authRequests++;
      cloud.authRequestsByUser.set(id, (cloud.authRequestsByUser.get(id) ?? 0) + 1);
      if (cloud.authRttMs > 0) await new Promise((resolve) => setTimeout(resolve, cloud.authRttMs));
      return callback(cloud.client(id), user);
    },
  };
}

function service(cloud: MailboxCloud, user: string, now: () => number = () => cloud.now(), changed?: () => void, syncIntervalMs = 60_000, wakeRetryBaseMs = 1_000) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'mingle-transport-'));
  const db = new DatabaseSync(':memory:');
  temporaryDirectories.push(dataDir);
  databases.push(db);
  return new TransportService({
    account: account(cloud, user), store: { db }, dataDir,
    now, retryBaseMs: 100, syncIntervalMs, wakeRetryBaseMs, changed,
  });
}

function postgresTimestamp(iso: string, subMillisecondMicros = '000'): string {
  return iso.replace(/\.(\d{3})Z$/, (_match, milliseconds: string) => `.${milliseconds}${subMillisecondMicros}+00:00`);
}

async function pairedServices(cloud = new MailboxCloud(), now: () => number = Date.now, wakeRetryBaseMs = 1_000) {
  const first = service(cloud, userA, now, undefined, 60_000, wakeRetryBaseMs);
  const second = service(cloud, userB, now, undefined, 60_000, wakeRetryBaseMs);
  const a = await first.register({ teamId, name: 'Laptop' });
  const b = await second.register({ teamId, name: 'Desktop' });
  await first.link({ teamId, deviceId: b.id, fingerprint: b.fingerprint });
  await second.link({ teamId, deviceId: a.id, fingerprint: a.fingerprint });
  await first.sync();
  return { cloud, first, second, a, b };
}

describe('distributed envelope cryptography', () => {
  it('encrypts for the pinned X25519 peer and signs routing and ciphertext with Ed25519', () => {
    const sender = generateDeviceKeyMaterial();
    const recipient = generateDeviceKeyMaterial();
    const header = {
      id: '737a46b3-42ac-4f5e-9f69-5bf451e4c1a2', teamId, fromDeviceId: userA, toDeviceId: userB,
      idempotencyKey: 'message-1', kind: 'execution.request', createdAt: new Date(1_800_000_000_000).toISOString(),
      expiresAt: new Date(1_800_000_100_000).toISOString(),
    };
    const envelope = sealEnvelope({ header, payload: { message: 'private', seq: 4 }, sender, recipientEncryptionPublicKey: recipient.encryptionPublicKeyDer });
    expect(envelope.ciphertext).not.toContain('private');
    expect(fingerprintForPublicKeys(sender.signingPublicKeyDer, sender.encryptionPublicKeyDer)).toMatch(/^SHA-256:[a-f0-9]{64}$/);
    expect(openEnvelope({ envelope, recipient, senderSigningPublicKey: sender.signingPublicKeyDer, senderEncryptionPublicKey: sender.encryptionPublicKeyDer }))
      .toEqual({ message: 'private', seq: 4 });
    expect(() => openEnvelope({ envelope: { ...envelope, toDeviceId: userA }, recipient, senderSigningPublicKey: sender.signingPublicKeyDer, senderEncryptionPublicKey: sender.encryptionPublicKeyDer })).toThrow();
    expect(() => openEnvelope({ envelope: { ...envelope, signature: Buffer.alloc(64).toString('base64') }, recipient, senderSigningPublicKey: sender.signingPublicKeyDer, senderEncryptionPublicKey: sender.encryptionPublicKeyDer })).toThrow(/signature/);
  });
});

it('does not notify listeners during repeated idle syncs for a registered device', async () => {
  const cloud = new MailboxCloud();
  let notifications = 0;
  const transport = service(cloud, userA, Date.now, () => { notifications++; }, 1_000);
  await transport.register({ teamId, name: 'Idle laptop' });
  notifications = 0;
  transport.start();
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  await transport.close();
  expect(notifications).toBe(0);
});

it('lets a message handler request a sync without deadlocking the sync that delivers it', async () => {
  const cloud = new MailboxCloud();
  const { first, second, b } = await pairedServices(cloud);
  const handled: string[] = [];
  // Team chat routing sends status to peers, which syncs first; that used to wait on the delivering sync forever.
  const unsubscribe = second.onMessage(async (message) => { await second.sync(); handled.push(message.kind); });
  try {
    await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { content: 'route me' }, idempotencyKey: 'handler-sync' });
    await Promise.race([second.sync(), new Promise((_, reject) => setTimeout(() => reject(new Error('sync deadlocked')), 3_000))]);
    expect(handled).toEqual(['collaboration.message']);
    await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { content: 'and the next one' }, idempotencyKey: 'handler-sync-2' });
    await vi.waitFor(async () => {
      await Promise.race([second.sync(), new Promise((_, reject) => setTimeout(() => reject(new Error('later sync blocked')), 3_000))]);
      expect(handled).toEqual(['collaboration.message', 'collaboration.message']);
    }, { timeout: 5_000 });
  } finally {
    unsubscribe();
    await first.close();
    await second.close();
  }
});

it('orders Realtime and mailbox handler work per sender while unrelated senders proceed and handlers can send', async () => {
  const cloud = new MailboxCloud(true);
  const { first, second, a, b } = await pairedServices(cloud);
  cloud.members.get(teamId)!.add(userOutside);
  const third = service(cloud, userOutside);
  const c = await third.register({ teamId, name: 'Tablet' });
  await third.link({ teamId, deviceId: b.id, fingerprint: b.fingerprint });
  await second.link({ teamId, deviceId: c.id, fingerprint: c.fingerprint });
  await second.sync();
  await third.sync();

  let releaseFirst!: () => void;
  let markFirstEntered!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
  const started: string[] = [];
  const completed: string[] = [];
  let firstFinished = false;
  let secondStartedAfterFirstFinished = false;
  const unsubscribeSecond = second.onMessage(async (message) => {
    const text = (message.payload as { text?: string }).text;
    if (text === 'first') {
      started.push('first');
      markFirstEntered();
      await firstGate;
      await second.send({ teamId, toDeviceId: a.id, kind: 'collaboration.message', payload: { text: 'reply' }, idempotencyKey: 'ordered-handler-reply' });
      completed.push('first');
      firstFinished = true;
    } else if (message.fromDeviceId === c.id) {
      started.push('unrelated');
      await second.sync();
      completed.push('unrelated');
    } else {
      started.push('second');
      secondStartedAfterFirstFinished = firstFinished;
      completed.push('second');
    }
  });
  const unsubscribeFirst = first.onMessage((message) => {
    if ((message.payload as { text?: string }).text === 'reply') completed.push('reply');
  });
  try {
    await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { text: 'first' }, idempotencyKey: 'ordered-first' });
    await firstEntered;
    await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { text: 'second' }, idempotencyKey: 'ordered-second' });
    await third.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { text: 'independent sender' }, idempotencyKey: 'ordered-independent' });
    await vi.waitFor(() => expect(completed).toContain('unrelated'), { timeout: 1_000 });
    expect(started).toEqual(['first', 'unrelated']);
    expect(completed).not.toContain('second');

    releaseFirst();
    await vi.waitFor(() => expect(completed).toEqual(expect.arrayContaining(['first', 'second', 'reply'])), { timeout: 1_000 });
    expect(started.indexOf('second')).toBeGreaterThan(started.indexOf('first'));
    expect(secondStartedAfterFirstFinished).toBe(true);
  } finally {
    releaseFirst();
    unsubscribeSecond();
    unsubscribeFirst();
    await first.close();
    await second.close();
    await third.close();
  }
});

it('delivers a small encrypted envelope on a fingerprint-derived Realtime topic', async () => {
  const cloud = new MailboxCloud(true);
  const { first, second, b } = await pairedServices(cloud);
  const received: string[] = [];
  const unsubscribe = second.onMessage((message) => { received.push(message.kind); });
  try {
    await second.sync();
    const startedAt = performance.now();
    await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { content: 'private mailbox content' }, idempotencyKey: 'wake-now' });
    await vi.waitFor(() => expect(received).toEqual(['collaboration.message']), { timeout: 1_000 });
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(1_000); // No transport.start()/poll timer is running in this fixture.
    expect(cloud.wakes).toHaveLength(1);
    expect(cloud.wakes[0]!.channel).toMatch(/^mingle-team-device-envelope-v1:[a-f0-9]{64}$/);
    expect(cloud.wakes[0]!.channel).not.toContain(b.id);
    expect(cloud.wakes[0]!.event).toBe('envelope');
    expect(JSON.stringify(cloud.wakes)).not.toContain('private mailbox content');
  } finally {
    unsubscribe();
    await first.close();
    await second.close();
  }
});

it('reuses one subscribed recipient channel across sends and uses REST only before the join completes', async () => {
  const cloud = new MailboxCloud(true);
  const { first, second, b } = await pairedServices(cloud);
  const received: string[] = [];
  const unsubscribe = second.onMessage((message) => { received.push(message.id); });
  try {
    await second.sync();
    const subscribeAttemptsBefore = cloud.wakeSubscribeAttempts.get(userA) ?? 0;
    const restCallsBefore = cloud.realtimeRequests;
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push(await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message',
        payload: { index }, idempotencyKey: `persistent-send-${index}` }));
    }
    await vi.waitFor(() => expect(received).toEqual(ids), { timeout: 1_000 });
    expect(cloud.wakeSubscribeAttempts.get(userA)).toBe(subscribeAttemptsBefore + 1);
    expect(cloud.realtimeRequests - restCallsBefore).toBe(1);
    expect(cloud.channelSendCalls).toBe(3);
  } finally {
    unsubscribe();
    await first.close();
    await second.close();
  }
});

it('borrows an existing same-topic receiver subscription without replacing or removing it', async () => {
  const cloud = new MailboxCloud(true);
  const first = service(cloud, userA);
  try {
    const own = await first.register({ teamId, name: 'Receiver and sender' });
    await first.sync();
    await vi.waitFor(() => expect((first as unknown as { wakeSubscriptions: Map<string, { status: string | null }> })
      .wakeSubscriptions.get(`${userA}:${own.id}`)?.status).toBe('SUBSCRIBED'));
    const client = cloud.client(userA);
    const attempts = cloud.wakeSubscribeAttempts.get(userA);
    const privateTransport = first as unknown as {
      sendRealtime: (client: SupabaseClient, accountId: string, teamId: string, deviceId: string, fingerprint: string, event: string, payload: unknown) => Promise<boolean>;
      sendChannels: Map<SupabaseClient, Map<string, { sharedReceive: boolean }>>;
      realtimeChannelName: (fingerprint: string) => string;
    };
    expect(await privateTransport.sendRealtime(client, userA, teamId, own.id, own.fingerprint, 'wake', {})).toBe(true);
    expect(await privateTransport.sendRealtime(client, userA, teamId, own.id, own.fingerprint, 'wake', {})).toBe(true);
    const topic = privateTransport.realtimeChannelName(own.fingerprint);
    expect(privateTransport.sendChannels.get(client)?.get(topic)?.sharedReceive).toBe(true);
    expect(cloud.wakeSubscribeAttempts.get(userA)).toBe(attempts);
    expect(cloud.channelRemovals.get(`${userA}:${topic}`) ?? 0).toBe(0);
    expect((first as unknown as { wakeSubscriptions: Map<string, unknown> }).wakeSubscriptions.has(`${userA}:${own.id}`)).toBe(true);
  } finally { await first.close(); }
});

it('evicts an idle send channel and does not recurse when CLOSED is reported during removal', async () => {
  const cloud = new MailboxCloud(true);
  const { first, b } = await pairedServices(cloud);
  vi.useFakeTimers();
  try {
    await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { text: 'idle' }, idempotencyKey: 'idle-eviction' });
    const topic = cloud.wakes.find((wake) => wake.event === 'envelope')!.channel;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 + 1);
    expect(cloud.channelRemovals.get(`${userA}:${topic}`)).toBe(1);
    expect((first as unknown as { sendChannels: Map<SupabaseClient, Map<string, unknown>> }).sendChannels.get(cloud.client(userA))?.size ?? 0).toBe(0);
  } finally {
    vi.useRealTimers();
    await first.close();
  }
});

it('removes active send channels on close', async () => {
  const cloud = new MailboxCloud(true);
  const { first, second, b } = await pairedServices(cloud);
  try {
    await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { text: 'close' }, idempotencyKey: 'close-send-channel' });
    const topic = cloud.wakes.find((wake) => wake.event === 'envelope')!.channel;
    await first.close();
    expect(cloud.channelRemovals.get(`${userA}:${topic}`)).toBe(1);
    expect((first as unknown as { sendChannels: Map<SupabaseClient, Map<string, unknown>> }).sendChannels.get(cloud.client(userA))?.size ?? 0).toBe(0);
  } finally {
    await first.close();
    await second.close();
  }
});

it('falls back to httpSend when a subscribed websocket send fails', async () => {
  const cloud = new MailboxCloud(true);
  const { first, second, b } = await pairedServices(cloud);
  const received: string[] = [];
  const unsubscribe = second.onMessage((message) => { received.push(message.id); });
  try {
    await second.sync();
    const firstId = await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { n: 1 }, idempotencyKey: 'prime-websocket' });
    await vi.waitFor(() => expect(received).toEqual([firstId]), { timeout: 1_000 });
    const before = cloud.realtimeRequests;
    cloud.failChannelSends = 1;
    const secondId = await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { n: 2 }, idempotencyKey: 'websocket-send-failure' });
    await vi.waitFor(() => expect(received).toEqual([firstId, secondId]), { timeout: 1_000 });
    expect(cloud.realtimeRequests).toBe(before + 1);
  } finally {
    unsubscribe();
    await first.close();
    await second.close();
  }
});

it('delivers from the durable mailbox when both websocket and REST realtime sends fail', async () => {
  const cloud = new MailboxCloud(true);
  const { first, second, b } = await pairedServices(cloud);
  const received: string[] = [];
  const unsubscribe = second.onMessage((message) => { received.push(message.id); });
  try {
    await second.sync();
    const primeId = await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { n: 1 }, idempotencyKey: 'prime-mailbox-fallback' });
    await vi.waitFor(() => expect(received).toEqual([primeId]), { timeout: 1_000 });
    const realtimeStart = cloud.wakes.length;
    cloud.failChannelSends = 1;
    cloud.failRealtimeSends = 1;
    const id = await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { n: 2 }, idempotencyKey: 'both-realtime-paths-fail' });
    await vi.waitFor(() => expect(received).toEqual([primeId, id]), { timeout: 1_000 });
    expect(cloud.wakes.slice(realtimeStart).map(({ event }) => event)).toEqual(['wake']);
    expect(first.snapshot(teamId).outbox.find((entry) => entry.id === id)).toMatchObject({ status: 'delivered' });
  } finally {
    unsubscribe();
    await first.close();
    await second.close();
  }
});

it('does not dispatch twice when the mailbox copy arrives after the live envelope', async () => {
  const cloud = new MailboxCloud(true);
  const { first, second, b } = await pairedServices(cloud);
  const received: string[] = [];
  const unsubscribe = second.onMessage((message) => { received.push(message.id); });
  try {
    await second.sync();
    const id = await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { content: 'dedupe race' }, idempotencyKey: 'realtime-mailbox-race' });
    await vi.waitFor(() => expect(received).toEqual([id]), { timeout: 1_000 });

    // Reintroduce the parallel mailbox copy after the recipient has handled Realtime.
    const wire = cloud.wakes.find((wake) => wake.event === 'envelope')!.payload as Record<string, string>;
    cloud.envelopes.push({
      id: wire.id!, team_id: wire.teamId!, from_device_id: wire.fromDeviceId!, to_device_id: wire.toDeviceId!,
      idempotency_key: wire.idempotencyKey!, kind: wire.kind!, ciphertext: wire.ciphertext!, nonce: wire.nonce!,
      signature: wire.signature!, created_at: wire.createdAt!, expires_at: wire.expiresAt!, received_at: new Date().toISOString(),
    });
    await second.sync();
    expect(received).toEqual([id]);
    expect((second as unknown as { db: DatabaseSync }).db.prepare('SELECT status FROM mingle_transport_inbox WHERE id = ?').get(id))
      .toMatchObject({ status: 'handled' });
  } finally {
    unsubscribe();
    await first.close();
    await second.close();
  }
});

it('falls back to a payload-free mailbox wake when the envelope broadcast fails', async () => {
  const cloud = new MailboxCloud(true);
  const { first, second, b } = await pairedServices(cloud);
  const received: string[] = [];
  const unsubscribe = second.onMessage((message) => { received.push(message.kind); });
  try {
    await second.sync();
    cloud.failRealtimeSends = 1;
    await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { text: 'mailbox fallback' }, idempotencyKey: 'realtime-send-failure' });
    await vi.waitFor(() => expect(received).toEqual(['collaboration.message']), { timeout: 1_000 });
    expect(cloud.wakes).toHaveLength(1);
    expect(cloud.wakes[0]).toMatchObject({ event: 'wake', payload: {} });
  } finally {
    unsubscribe();
    await first.close();
    await second.close();
  }
});

it('rejects a signed live envelope when the refreshed team member cache excludes its sender', async () => {
  const cloud = new MailboxCloud(true);
  const { first, second, b } = await pairedServices(cloud);
  const received: string[] = [];
  const unsubscribe = second.onMessage((message) => { received.push(message.id); });
  try {
    await second.sync();
    cloud.members.get(teamId)!.delete(userA);
    await second.sync();
    const id = await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { text: 'revoked sender' }, idempotencyKey: 'revoked-member-live' });
    await Promise.resolve();
    expect(received).toEqual([]);
    expect(cloud.envelopes).toHaveLength(0);
    expect(first.snapshot(teamId).outbox.find((entry) => entry.id === id)).toMatchObject({ status: 'queued' });
  } finally {
    unsubscribe();
    await first.close();
    await second.close();
  }
});

it('invalidates stale trust immediately and defers a just-revoked peer realtime envelope until refresh', async () => {
  const cloud = new MailboxCloud(true);
  const { first, second, b } = await pairedServices(cloud);
  const received: string[] = [];
  let releaseBlocked: (() => void) | null = null;
  const unsubscribe = second.onMessage((message) => { received.push(message.id); });
  try {
    await second.sync();
    const blocked = cloud.blockNextMemberRoster(teamId);
    releaseBlocked = blocked.release;
    second.invalidateTeamTrust(teamId);
    await blocked.entered;
    expect((second as unknown as { teamCacheRefreshedAt: Map<string, number> }).teamCacheRefreshedAt.has(`${userB}:${teamId}:${b.id}`)).toBe(false);
    cloud.members.get(teamId)!.delete(userA);

    // Sender A still has its short-lived local view. Its mailbox insert is denied, but its
    // signed Realtime envelope must be deferred by B while the invalidation refresh is in flight.
    await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { text: 'revoked during refresh' }, idempotencyKey: 'trust-invalidation-live' });
    expect(received).toEqual([]);
    blocked.release();
    releaseBlocked = null;
    await second.sync();
    expect(received).toEqual([]);
    expect(cloud.envelopes).toHaveLength(0);
    expect((second as unknown as { teamActiveMembers: Map<string, Set<string>> }).teamActiveMembers.get(`${userB}:${teamId}`)?.has(userA)).toBe(false);
  } finally {
    releaseBlocked?.();
    unsubscribe();
    await first.close();
    await second.close();
  }
});

it('uses the durable mailbox after a trust invalidation refresh fails', async () => {
  const cloud = new MailboxCloud(true);
  const { first, second, b } = await pairedServices(cloud);
  const received: string[] = [];
  let releaseBlocked: (() => void) | null = null;
  const unsubscribe = second.onMessage((message) => { received.push(message.id); });
  try {
    await second.sync();
    const blocked = cloud.blockNextMemberRoster(teamId);
    releaseBlocked = blocked.release;
    second.invalidateTeamTrust(teamId);
    await blocked.entered;
    cloud.failMemberRosterReads = 1;
    const id = await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { text: 'mailbox after refresh failure' }, idempotencyKey: 'trust-refresh-mailbox-fallback' });
    expect(received).toEqual([]);
    expect(cloud.envelopes).toHaveLength(1);
    blocked.release();
    releaseBlocked = null;
    await second.sync();
    await vi.waitFor(() => expect(received).toEqual([id]), { timeout: 1_000 });
    expect(cloud.envelopes).toHaveLength(0);
  } finally {
    releaseBlocked?.();
    unsubscribe();
    await first.close();
    await second.close();
  }
});

it.each(['collaboration.members', 'collaboration.device.revoked'])('automatically invalidates team trust after delivered %s messages', async (kind) => {
  const cloud = new MailboxCloud(true);
  const { first, second, b } = await pairedServices(cloud);
  const received: string[] = [];
  const unsubscribe = second.onMessage((message) => { received.push(message.kind); });
  try {
    await second.sync();
    const previousQueries = cloud.postgrestRequestsByUser.get(userB) ?? 0;
    await first.send({ teamId, toDeviceId: b.id, kind, payload: { version: 2 }, idempotencyKey: `trust-invalidation-${kind}` });
    await vi.waitFor(() => expect(received).toContain(kind), { timeout: 1_000 });
    await vi.waitFor(() => expect(cloud.postgrestRequestsByUser.get(userB) ?? 0).toBeGreaterThan(previousQueries), { timeout: 1_000 });
  } finally {
    unsubscribe();
    await first.close();
    await second.close();
  }
});

it.each(['execution.agents', 'teamgroup.structure'])('keeps team trust warm after delivered %s messages', async (kind) => {
  const cloud = new MailboxCloud(true);
  const { first, second, b } = await pairedServices(cloud);
  const received: string[] = [];
  const unsubscribe = second.onMessage((message) => { received.push(message.kind); });
  try {
    await second.sync();
    // Receiving any envelope clears its mailbox copy; compare against an ordinary chat message.
    const queriesFor = async (messageKind: string) => {
      const before = cloud.postgrestRequestsByUser.get(userB) ?? 0;
      await first.send({ teamId, toDeviceId: b.id, kind: messageKind, payload: { version: 2 }, idempotencyKey: `trust-warm-${messageKind}` });
      await vi.waitFor(() => expect(received).toContain(messageKind), { timeout: 1_000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return (cloud.postgrestRequestsByUser.get(userB) ?? 0) - before;
    };
    const baseline = await queriesFor('collaboration.message');
    expect(await queriesFor(kind)).toBe(baseline);
  } finally {
    unsubscribe();
    await first.close();
    await second.close();
  }
});

it('uses a payload-free wake for envelopes above the 64 KiB Realtime budget', async () => {
  const cloud = new MailboxCloud(true);
  const { first, second, b } = await pairedServices(cloud);
  const received: string[] = [];
  const unsubscribe = second.onMessage((message) => { received.push(message.kind); });
  try {
    await second.sync();
    await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { text: 'x'.repeat(60_000) }, idempotencyKey: 'realtime-large-fallback' });
    await vi.waitFor(() => expect(received).toEqual(['collaboration.message']), { timeout: 1_000 });
    expect(cloud.wakes.map(({ event, payload }) => ({ event, payload }))).toEqual([{ event: 'wake', payload: {} }]);
    expect(cloud.envelopes).toHaveLength(0);
  } finally {
    unsubscribe();
    await first.close();
    await second.close();
  }
});

it('catches up after a transient Realtime join timeout and retries without waiting for mailbox polling', async () => {
  const cloud = new MailboxCloud(true);
  cloud.failWakeSubscriptions(userB, 1);
  const { first, second, b } = await pairedServices(cloud, Date.now, 20);
  const received: string[] = [];
  const unsubscribe = second.onMessage((message) => { received.push(message.kind); });
  try {
    await vi.waitFor(() => expect(cloud.wakeSubscribeAttempts.get(userB)).toBeGreaterThanOrEqual(2), { timeout: 1_000 });
    const startedAt = performance.now();
    await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { content: 'retry path' }, idempotencyKey: 'wake-retry' });
    await vi.waitFor(() => expect(received).toEqual(['collaboration.message']), { timeout: 1_000 });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(cloud.wakes.some((wake) => wake.event === 'envelope')).toBe(true);
  } finally {
    unsubscribe();
    await first.close();
    await second.close();
  }
});

it('handles a small realtime envelope in about two simulated 90ms network turns', async () => {
  const cloud = new MailboxCloud(true);
  const { first, second, b } = await pairedServices(cloud);
  const received: string[] = [];
  const unsubscribe = second.onMessage((message) => { received.push(message.kind); });
  try {
    await second.sync(); // Finish subscription and initial catch-up before enabling artificial network RTT.
    cloud.authRequests = 0;
    cloud.authRequestsByUser.clear();
    cloud.postgrestRequests = 0;
    cloud.postgrestRequestsByUser.clear();
    cloud.realtimeRequests = 0;
    cloud.inboxPullsByUserTeam.set(`${userB}:${teamId}`, 0);
    cloud.authRttMs = 90;
    cloud.postgrestRttMs = 90;
    cloud.realtimeRttMs = 90;
    const sendStartedAt = performance.now();
    await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { content: 'simulated WAN' }, idempotencyKey: 'wake-90ms-rtt' });
    const publishedAt = cloud.lastWakePublishedAt;
    await vi.waitFor(() => expect(received).toEqual(['collaboration.message']), { timeout: 1_000 });
    const wakeToHandlerMs = performance.now() - publishedAt;
    const sendToHandlerMs = performance.now() - sendStartedAt;
    expect(wakeToHandlerMs).toBeLessThan(90 * 1.5);
    expect(sendToHandlerMs).toBeLessThan(90 * 2.5);
    expect(cloud.authRequestsByUser.get(userB) ?? 0).toBe(0);
    expect(cloud.inboxPullsByUserTeam.get(`${userB}:${teamId}`) ?? 0).toBe(0);
    expect(cloud.wakes.at(-1)?.event).toBe('envelope');
    console.info(`Realtime transport latency: ${sendToHandlerMs.toFixed(1)} ms at 90 ms simulated per-request RTT`);
    // This is a local deterministic mock with per-request delay, not an Internet/Supabase measurement.
  } finally {
    cloud.realtimeRttMs = 0;
    cloud.postgrestRttMs = 0;
    cloud.authRttMs = 0;
    unsubscribe();
    await first.close();
    await second.close();
  }
});

it('dispatches a ready team inbox while another team heartbeat is still blocked', async () => {
  const cloud = new MailboxCloud(true);
  cloud.members.set(secondTeamId, new Set([userA, userB]));
  const { first, second, b } = await pairedServices(cloud);
  let releaseBlockedHeartbeat: (() => void) | null = null;
  try {
    const a2 = await first.register({ teamId: secondTeamId, name: 'Laptop second team' });
    const b2 = await second.register({ teamId: secondTeamId, name: 'Desktop second team' });
    await first.link({ teamId: secondTeamId, deviceId: b2.id, fingerprint: b2.fingerprint });
    await second.link({ teamId: secondTeamId, deviceId: a2.id, fingerprint: a2.fingerprint });
    await second.sync();

    const handled = new Promise<string>((resolve) => {
      const unsubscribe = second.onMessage((message) => {
        if (message.teamId === teamId) {
          unsubscribe();
          resolve(message.kind);
        }
      });
    });
    await second.sync();
    cloud.inboxPullsByUserTeam.set(`${userB}:${teamId}`, 0);
    const blocked = cloud.blockNextHeartbeat(secondTeamId);
    releaseBlockedHeartbeat = blocked.release;
    const syncBeforeWake = second.sync();
    await Promise.all([
      blocked.entered,
      vi.waitFor(() => expect(cloud.inboxPullsByUserTeam.get(`${userB}:${teamId}`)).toBeGreaterThanOrEqual(1), { timeout: 1_000 }),
    ]);
    await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { content: 'ready team' }, idempotencyKey: 'ready-team-first' });
    expect(await Promise.race([
      handled,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('new message waited for another team heartbeat')), 1_000)),
    ])).toBe('collaboration.message');
    expect((second as unknown as { syncPromise: Promise<void> | null }).syncPromise).not.toBeNull();
    releaseBlockedHeartbeat?.();
    releaseBlockedHeartbeat = null;
    await syncBeforeWake;
  } finally {
    releaseBlockedHeartbeat?.();
    await first.close();
    await second.close();
  }
});

it('resolves an explicit sync after one catch-up pass even when later wakes queue another pass', async () => {
  const cloud = new MailboxCloud();
  const { second } = await pairedServices(cloud);
  let releaseFirst: (() => void) | null = null;
  let releaseSecond: (() => void) | null = null;
  let releaseThird: (() => void) | null = null;
  try {
    const firstBlock = cloud.blockNextHeartbeat(teamId);
    releaseFirst = firstBlock.release;
    const initialSync = second.sync();
    await firstBlock.entered;

    const requestedCatchup = second.sync();
    const secondBlock = cloud.blockNextHeartbeat(teamId);
    releaseFirst();
    await secondBlock.entered;

    const thirdBlock = cloud.blockNextHeartbeat(teamId);
    releaseSecond = secondBlock.release;
    releaseThird = thirdBlock.release;
    const laterWake = second.sync();
    releaseSecond();
    await thirdBlock.entered;

    await Promise.race([
      requestedCatchup,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('sync waited for global idle after repeated wakes')), 1_000)),
    ]);
    expect((second as unknown as { syncPromise: Promise<void> | null }).syncPromise).not.toBeNull();
    releaseThird();
    await Promise.all([initialSync, laterWake]);
  } finally {
    releaseFirst?.();
    releaseSecond?.();
    releaseThird?.();
    await second.close();
  }
});

describe('TransportService authenticated mailbox', () => {
  it('keeps idle sync quiet and notifies once when an outbox row changes', async () => {
    const cloud = new MailboxCloud();
    let notifications = 0;
    const first = service(cloud, userA, () => cloud.now(), () => { notifications++; });
    const second = service(cloud, userB);
    try {
      const a = await first.register({ teamId, name: 'Laptop' });
      const b = await second.register({ teamId, name: 'Desktop' });
      await first.link({ teamId, deviceId: b.id, fingerprint: b.fingerprint });
      await second.link({ teamId, deviceId: a.id, fingerprint: a.fingerprint });
      await first.sync();
      notifications = 0;

      await first.sync();
      await first.sync();
      await first.sync();
      expect(notifications).toBe(0);

      await first.send({ teamId, toDeviceId: b.id, kind: 'teamgroup.delivery.heartbeat', payload: { deliveryId: 'heartbeat-1' }, idempotencyKey: 'heartbeat-1' });
      expect(notifications).toBe(0);
      expect(first.snapshot(teamId).outbox.some((item) => item.kind === 'teamgroup.delivery.heartbeat')).toBe(false);

      await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { content: 'new durable message' }, idempotencyKey: 'notify-once' });
      expect(notifications).toBe(1);
      await first.sync();
      expect(notifications).toBe(1);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('keeps unrelated uniqueness failures queued instead of claiming successful delivery', async () => {
    const { cloud, first, second, b } = await pairedServices();
    try {
      cloud.envelopeWriteError = { code: '23505', message: 'duplicate key value violates unique constraint "unrelated_future_constraint"' };
      await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { content: 'Example queued message' }, idempotencyKey: 'unknown-constraint' });
      expect(first.snapshot(teamId).outbox[0]).toMatchObject({ status: 'queued', attempts: 1 });
      expect(cloud.envelopes).toHaveLength(0);
    } finally { await first.close(); await second.close(); }
  });

  it('requires active membership and mutual fingerprint pins, then durably deduplicates accepted messages', async () => {
    const { cloud, first, second, b } = await pairedServices();
    const received: unknown[] = [];
    let unsubscribe: () => void = () => {};
    try {
      const input = { teamId, toDeviceId: b.id, kind: 'execution.request' as const, payload: { requestId: 'request-1' }, idempotencyKey: 'request-1' };
      const id = await first.send(input);
      expect(await first.send(input)).toBe(id);
      await expect(first.send({ ...input, payload: { requestId: 'different' } })).rejects.toMatchObject({ status: 409 });
      await expect(first.send({ ...input, kind: 'collaboration.message', payload: input.payload })).rejects.toMatchObject({ status: 409 });
      expect(first.snapshot(teamId).outbox[0]).toMatchObject({ status: 'delivered' });
      expect(cloud.envelopes).toHaveLength(1);
      expect(cloud.envelopes[0]!.ciphertext).not.toContain('request-1');
      // PostgreSQL/PostgREST timestamps may use +00:00 and more fractional digits than JS Date.
      cloud.envelopes[0]!.created_at = postgresTimestamp(cloud.envelopes[0]!.created_at);
      cloud.envelopes[0]!.expires_at = postgresTimestamp(cloud.envelopes[0]!.expires_at);
      cloud.envelopes[0]!.received_at = postgresTimestamp(cloud.envelopes[0]!.received_at);
      unsubscribe = second.onMessage(async (message) => { received.push(message); });
      await second.sync();
      await second.sync();
      expect(received).toEqual([{ id, teamId, fromDeviceId: first.snapshot(teamId).deviceId, toDeviceId: b.id, kind: 'execution.request', payload: { requestId: 'request-1' } }]);
      expect(first.snapshot(teamId).outbox[0]).toMatchObject({ id, status: 'delivered', attempts: 1 });
    } finally {
      unsubscribe();
      await first.close();
      await second.close();
    }
  });

  it('rejects a locally persisted message after sender membership is revoked', async () => {
    const cloud = new MailboxCloud();
    const { first, second, b } = await pairedServices(cloud);
    try {
      await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { text: 'queued before revocation' }, idempotencyKey: 'sender-revoked' });
      await second.sync();
      cloud.members.get(teamId)!.delete(userA);
      const delivered: unknown[] = [];
      const unsubscribe = second.onMessage((message) => { delivered.push(message); });
      await second.sync();
      unsubscribe();
      expect(delivered).toEqual([]);
      const db = (second as unknown as { db: DatabaseSync }).db;
      expect(db.prepare('SELECT status FROM mingle_transport_inbox').get()).toMatchObject({ status: 'rejected' });
    } finally { await first.close(); await second.close(); }
  });

  it('keeps cloud retries queued and rechecks recipient membership before dispatch', async () => {
    let clock = 1_800_000_000_000;
    const cloud = new MailboxCloud();
    cloud.now = () => clock;
    const { first, second, b } = await pairedServices(cloud, () => clock);
    try {
      cloud.failEnvelopeWrites = 1;
      const id = await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { text: 'hi' }, idempotencyKey: 'retry-1' });
      expect(first.snapshot(teamId).outbox[0]).toMatchObject({ id, status: 'queued', attempts: 1 });
      clock += 200;
      await first.sync();
      expect(first.snapshot(teamId).outbox[0]).toMatchObject({ id, status: 'delivered', attempts: 2 });
      await second.sync(); // Persist but do not dispatch while no handler is registered.
      cloud.members.get(teamId)!.delete(userB);
      const delivered: unknown[] = [];
      const unsubscribe = second.onMessage((message) => { delivered.push(message); });
      await second.sync();
      unsubscribe();
      expect(delivered).toEqual([]);
      expect(second.snapshot(teamId).deviceId).toBeNull();
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('rejects malformed PostgreSQL timestamps without invoking a handler', async () => {
    const { cloud, first, second, b } = await pairedServices();
    const delivered: unknown[] = [];
    try {
      await first.send({ teamId, toDeviceId: b.id, kind: 'execution.request', payload: { requestId: 'bad-time' }, idempotencyKey: 'bad-time-1' });
      cloud.envelopes[0]!.created_at = 'not-a-postgres-timestamp';
      const unsubscribe = second.onMessage((message) => { delivered.push(message); });
      await second.sync();
      unsubscribe();
      expect(delivered).toEqual([]);
      expect(cloud.envelopes).toHaveLength(0);
      expect((second as unknown as { db: DatabaseSync }).db.prepare('SELECT * FROM mingle_transport_inbox').all()).toHaveLength(0);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('keeps handler failures durable and retries them after the backoff', async () => {
    let clock = Date.now();
    const cloud = new MailboxCloud();
    cloud.now = () => clock;
    const { first, second, b } = await pairedServices(cloud, () => clock);
    let calls = 0;
    try {
      await first.send({ teamId, toDeviceId: b.id, kind: 'execution.request', payload: { requestId: 'handler-retry' }, idempotencyKey: 'handler-retry-1' });
      await second.sync();
      const unsubscribe = second.onMessage(async () => {
        calls += 1;
        if (calls === 1) throw new RetryableTransportDeliveryError('Team artifact chunk has no matching authenticated offer yet.');
      });
      await second.sync();
      expect(calls).toBe(1);
      const db = (second as unknown as { db: DatabaseSync }).db;
      expect(db.prepare('SELECT status, attempts, error FROM mingle_transport_inbox').get()).toMatchObject({
        status: 'pending', attempts: 1, error: 'Team artifact chunk has no matching authenticated offer yet.',
      });
      clock += 200;
      await second.sync();
      await second.sync();
      unsubscribe();
      expect(calls).toBe(2);
      expect(db.prepare('SELECT status, attempts FROM mingle_transport_inbox').get()).toMatchObject({ status: 'handled', attempts: 2 });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('permanently rejects handler authorization conflicts with the sanitized actual error', async () => {
    const { first, second, b } = await pairedServices();
    try {
      await first.send({ teamId, toDeviceId: b.id, kind: 'git.team-artifact.chunk', payload: { transferId: 'x' }, idempotencyKey: 'handler-rejected-reason' });
      await second.sync();
      const unsubscribe = second.onMessage(() => {
        throw new HttpError(409, 'Team artifact chunk has no matching authenticated offer.');
      });
      await second.sync();
      unsubscribe();
      const db = (second as unknown as { db: DatabaseSync }).db;
      expect(db.prepare('SELECT status, attempts, error FROM mingle_transport_inbox').get()).toMatchObject({
        status: 'rejected', attempts: 1, error: 'Team artifact chunk has no matching authenticated offer.',
      });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('rejects queued work after either side revokes its fingerprint pin', async () => {
    const { cloud, first, second, a, b } = await pairedServices();
    const delivered: unknown[] = [];
    try {
      await first.send({ teamId, toDeviceId: b.id, kind: 'execution.request', payload: { requestId: 'revoked-pin' }, idempotencyKey: 'revoked-pin-1' });
      await second.sync();
      await second.revoke({ teamId, deviceId: a.id });
      const unsubscribe = second.onMessage((message) => { delivered.push(message); });
      await second.sync();
      unsubscribe();
      expect(delivered).toEqual([]);
      const db = (second as unknown as { db: DatabaseSync }).db;
      expect(db.prepare('SELECT status FROM mingle_transport_inbox').get()).toMatchObject({ status: 'rejected' });
      await first.sync();
      await expect(first.send({ teamId, toDeviceId: b.id, kind: 'execution.request', payload: {}, idempotencyKey: 'revoked-pin-2' })).rejects.toMatchObject({ status: 403 });
      expect(cloud.links).toHaveLength(1);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('delivers in server mailbox receive order rather than peer-created timestamp order', async () => {
    let clock = Date.now();
    const cloud = new MailboxCloud();
    cloud.now = () => clock;
    const { first, second, b } = await pairedServices(cloud, () => clock);
    const messages: string[] = [];
    try {
      const firstId = await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { n: 1 }, idempotencyKey: 'order-1' });
      clock += 1_000;
      const secondId = await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { n: 2 }, idempotencyKey: 'order-2' });
      const sameMillisecond = new Date(clock).toISOString();
      cloud.envelopes[0]!.received_at = postgresTimestamp(sameMillisecond, '900');
      cloud.envelopes[1]!.received_at = postgresTimestamp(sameMillisecond, '100');
      cloud.envelopes.reverse(); // Model arbitrary physical row order; relay received_at is authoritative.
      await second.sync();
      const unsubscribe = second.onMessage((message) => { messages.push(message.id); });
      await second.sync();
      unsubscribe();
      expect(messages).toEqual([secondId, firstId]);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('does not repeat an inbox dispatch whose prior outcome became uncertain at restart', async () => {
    const { cloud, first, second, b } = await pairedServices();
    try {
      await first.send({ teamId, toDeviceId: b.id, kind: 'execution.request', payload: { requestId: 'uncertain' }, idempotencyKey: 'uncertain-1' });
      await second.sync();
      const db = (second as unknown as { db: DatabaseSync }).db;
      db.prepare(`UPDATE mingle_transport_inbox SET status = 'dispatching' WHERE account_id = ?`).run(userB);
      const dataDir = (second as unknown as { options: { dataDir: string } }).options.dataDir;
      const restarted = new TransportService({ account: account(cloud, userB), store: { db }, dataDir });
      const attempts: unknown[] = [];
      const unsubscribe = restarted.onMessage((message) => { attempts.push(message); });
      await restarted.sync();
      unsubscribe();
      expect(attempts).toEqual([]);
      expect(db.prepare('SELECT status FROM mingle_transport_inbox').get()).toMatchObject({ status: 'uncertain' });
      await restarted.close();
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('advances past the 10,000-row scan cap by acknowledging durable rows', async () => {
    const { cloud, first, second, b } = await pairedServices();
    const now = new Date().toISOString();
    try {
      const senderId = first.snapshot(teamId).deviceId!;
      for (let index = 0; index < 10_005; index += 1) {
        const suffix = index.toString(16).padStart(12, '0');
        cloud.envelopes.push({
          id: `00000000-0000-4000-8000-${suffix}`, team_id: teamId, from_device_id: senderId, to_device_id: b.id,
          idempotency_key: `old-${index}`, kind: 'execution.request', ciphertext: 'tampered', nonce: 'AA==', signature: 'AA==',
          created_at: now, expires_at: new Date(Date.now() + 60_000).toISOString(), received_at: new Date(Date.now() + index).toISOString(),
        });
      }
      await second.sync();
      expect(cloud.envelopes).toHaveLength(5);
      await second.sync();
      expect(cloud.envelopes).toHaveLength(0);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('delivers only the newest queued roster from a sender and closes superseded copies after it was handled', async () => {
    const { first, second, b } = await pairedServices();
    const shared = '11111111-2222-4333-8444-555555555555';
    const delivered: Array<{ kind: string; payload: unknown }> = [];
    try {
      for (let version = 1; version <= 5; version += 1) {
        await first.send({ teamId, toDeviceId: b.id, kind: 'execution.agents', payload: { sharedProjectId: shared, version },
          idempotencyKey: `agents:${shared}:${version}:${b.id}:1` });
        if (version === 2) await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { note: 'kept' }, idempotencyKey: 'between-rosters' });
      }
      await second.sync();
      const unsubscribe = second.onMessage((message) => { delivered.push({ kind: message.kind, payload: message.payload }); });
      await second.sync();
      unsubscribe();
      expect(delivered).toEqual([
        { kind: 'execution.agents', payload: { sharedProjectId: shared, version: 5 } },
        { kind: 'collaboration.message', payload: { note: 'kept' } },
      ]);
      const db = (second as unknown as { db: DatabaseSync }).db;
      const rows = db.prepare("SELECT idempotency_key, status, error FROM mingle_transport_inbox WHERE kind = 'execution.agents' ORDER BY idempotency_key").all();
      expect(rows.map((row) => row.status)).toEqual(['handled', 'handled', 'handled', 'handled', 'handled']);
      expect(rows.filter((row) => row.error === 'Superseded by a newer roster from the same device.')).toHaveLength(4);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('coalesces rosters by their authenticated payload version rather than idempotency metadata', async () => {
    const { first, second, b } = await pairedServices();
    const shared = '11111111-2222-4333-8444-777777777777';
    const delivered: number[] = [];
    try {
      // The outer envelope metadata is signed, but the sender controls it independently of its payload.
      // A mismatched high key version must not hide the legitimate newer roster.
      await first.send({ teamId, toDeviceId: b.id, kind: 'execution.agents', payload: { sharedProjectId: shared, version: 1 },
        idempotencyKey: `agents:${shared}:99:${b.id}:1` });
      await first.send({ teamId, toDeviceId: b.id, kind: 'execution.agents', payload: { sharedProjectId: shared, version: 2 },
        idempotencyKey: `agents:${shared}:2:${b.id}:1` });
      await second.sync();
      const unsubscribe = second.onMessage((message) => { delivered.push((message.payload as { version: number }).version); });
      await second.sync();
      unsubscribe();
      expect(delivered).toEqual([2]);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('keeps older rosters queued when the newest copy fails to deliver', async () => {
    const { first, second, b } = await pairedServices();
    const shared = '11111111-2222-4333-8444-666666666666';
    const versions: unknown[] = [];
    try {
      for (let version = 1; version <= 3; version += 1) {
        await first.send({ teamId, toDeviceId: b.id, kind: 'execution.agents', payload: { sharedProjectId: shared, version },
          idempotencyKey: `agents:${shared}:${version}:${b.id}:1` });
      }
      await second.sync();
      const unsubscribe = second.onMessage((message) => {
        const version = (message.payload as { version: number }).version;
        versions.push(version);
        if (version === 3) throw new Error('handler unavailable');
      });
      await second.sync();
      unsubscribe();
      expect(versions).toEqual([3, 1, 2]);
      const db = (second as unknown as { db: DatabaseSync }).db;
      expect(db.prepare("SELECT count(*) AS superseded FROM mingle_transport_inbox WHERE error LIKE 'Superseded%'").get()).toEqual({ superseded: 0 });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('returns from registering in a new team without waiting for another team\'s mailbox backlog', async () => {
    const { cloud, first, second, b } = await pairedServices();
    const otherTeam = '9b1d7f5e-3c2a-4e8f-9d6b-1a2b3c4d5e6f';
    cloud.members.set(otherTeam, new Set([userA, userB]));
    let release = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered = () => {};
    const handlerEntered = new Promise<void>((resolve) => { entered = resolve; });
    try {
      await first.send({ teamId, toDeviceId: b.id, kind: 'collaboration.message', payload: { backlog: true }, idempotencyKey: 'backlog-1' });
      const unsubscribe = second.onMessage(async (message) => {
        if (message.teamId !== teamId) return;
        entered();
        await blocked;
      });
      const backlog = second.sync();
      await handlerEntered;
      const registered = await Promise.race([
        second.register({ teamId: otherTeam, name: 'Desktop' }).then((device) => device.teamId),
        new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 2_000)),
      ]);
      expect(registered).toBe(otherTeam);
      release();
      await backlog;
      unsubscribe();
    } finally {
      release();
      await first.close();
      await second.close();
    }
  });

  it('rejects attempts to register from a user with no current team membership', async () => {
    const cloud = new MailboxCloud();
    const outsider = service(cloud, userOutside);
    try {
      await expect(outsider.register({ teamId, name: 'Untrusted' })).rejects.toBeInstanceOf(HttpError);
      expect(outsider.snapshot(teamId)).toMatchObject({ deviceId: null, devices: [], links: [], status: 'unregistered' });
    } finally { await outsider.close(); }
  });
});
