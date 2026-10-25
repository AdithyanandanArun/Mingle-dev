import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../util.ts';
import { fingerprintForPublicKeys, generateDeviceKeyMaterial, openEnvelope, sealEnvelope } from './crypto.ts';
import { TransportService } from './transport.ts';

const teamId = '737a46b3-42ac-4f5e-9f69-5bf451e4c1a2';
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
  failEnvelopeWrites = 0;
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
  client(user: string): SupabaseClient { return { from: (table: string) => new MailboxQuery(this, user, table) } as unknown as SupabaseClient; }
  private isoNow(): string { return new Date(this.now()).toISOString(); }
  async execute(user: string, table: string, action: string, values: any, filters: Array<[string, string, unknown]>, range: [number, number] | null, order: Array<[string, boolean]>, returning: boolean): Promise<Result> {
    const rows = this.table(table);
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
    withAuthenticatedClient: async <T>(callback: (client: SupabaseClient, verifiedUser: User) => Promise<T>): Promise<T> => callback(cloud.client(id), user),
  };
}

function service(cloud: MailboxCloud, user: string, now: () => number = () => cloud.now(), changed?: () => void) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'mingle-transport-'));
  const db = new DatabaseSync(':memory:');
  temporaryDirectories.push(dataDir);
  databases.push(db);
  return new TransportService({
    account: account(cloud, user), store: { db }, dataDir,
    now, retryBaseMs: 100, syncIntervalMs: 60_000, changed,
  });
}

function postgresTimestamp(iso: string, subMillisecondMicros = '000'): string {
  return iso.replace(/\.(\d{3})Z$/, (_match, milliseconds: string) => `.${milliseconds}${subMillisecondMicros}+00:00`);
}

async function pairedServices(cloud = new MailboxCloud(), now: () => number = Date.now) {
  const first = service(cloud, userA, now);
  const second = service(cloud, userB, now);
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
        if (calls === 1) throw new Error('retry me');
      });
      await second.sync();
      expect(calls).toBe(1);
      const db = (second as unknown as { db: DatabaseSync }).db;
      expect(db.prepare('SELECT status, attempts FROM mingle_transport_inbox').get()).toMatchObject({ status: 'pending', attempts: 1 });
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

  it('rejects attempts to register from a user with no current team membership', async () => {
    const cloud = new MailboxCloud();
    const outsider = service(cloud, userOutside);
    try {
      await expect(outsider.register({ teamId, name: 'Untrusted' })).rejects.toBeInstanceOf(HttpError);
      expect(outsider.snapshot(teamId)).toMatchObject({ deviceId: null, devices: [], links: [], status: 'unregistered' });
    } finally { await outsider.close(); }
  });
});
