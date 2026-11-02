import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthenticatedTransportMessage, DistributedDevice, ProjectMemorySyncRecord, Session } from '@mingle/contracts';
import { PROJECT_MEMORY_LIMITS } from '@mingle/contracts';
import { canonicalJson, generateDeviceKeyMaterial, signDevicePayload, type DeviceKeyMaterial } from '../distributed/crypto.ts';
import { openDatabase } from '../db.ts';
import { Store } from '../store.ts';
import { tmpDir } from '../test-utils.ts';
import { ProjectMemoryService, type AgentContext } from './service.ts';
import { ProjectMemoryTeamSync, causalProofPayload, signingPayload, type MemoryTransport } from './sync.ts';

const TEAM = randomUUID();
const SHARED = randomUUID();
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** In-memory stand-in for the encrypted mailbox: delivery is explicit so tests control ordering, loss and replay. */
class Mesh {
  nodes = new Map<string, Node>();
  links = new Set<string>(); // "a>b" means a pinned b; mutual needs both
  revoked = new Set<string>();
  members = new Set<string>();
  queue: AuthenticatedTransportMessage[] = [];
  log: AuthenticatedTransportMessage[] = [];
  rejected: string[] = [];
  held = false;
  failSends = false;

  link(a: Node, b: Node): void { this.links.add(`${a.deviceId}>${b.deviceId}`); this.links.add(`${b.deviceId}>${a.deviceId}`); }
  /** Delivers everything queued (including replies produced while delivering). */
  async deliver(): Promise<number> {
    let delivered = 0;
    while (this.queue.length) {
      const message = this.queue.shift()!;
      const target = this.nodes.get(message.toDeviceId);
      if (!target?.handler) continue;
      delivered++;
      try { await target.handler(message); } catch (error) { this.rejected.push(error instanceof Error ? error.message : String(error)); }
    }
    return delivered;
  }
  async redeliver(message: AuthenticatedTransportMessage): Promise<void> {
    this.queue.push(JSON.parse(JSON.stringify(message)));
    await this.deliver();
  }
}

class Node {
  readonly deviceId = randomUUID();
  readonly keys: DeviceKeyMaterial = generateDeviceKeyMaterial();
  handler: ((message: AuthenticatedTransportMessage) => void | Promise<void>) | null = null;
  readonly store: Store;
  readonly service: ProjectMemoryService;
  readonly sync: ProjectMemoryTeamSync;
  readonly root = tmpDir('mingle-memsync-');
  readonly projectId: string;
  sends = 0;
  authorizations = 0;
  snapshots = 0;

  constructor(readonly mesh: Mesh, readonly accountId: string, kind: 'owner' | 'joined', options: { retryBaseMs?: number; bind?: boolean } = {}) {
    mkdirSync(path.join(this.root, 'src'), { recursive: true });
    writeFileSync(path.join(this.root, 'src/a.ts'), 'export const a = 1;\n');
    this.store = new Store(openDatabase(':memory:'));
    this.projectId = this.store.insertProject({ name: `Shared ${kind}`, path: this.root }).id;
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS mingle_project_collaboration_sources (
        local_project_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL,
        leader_device_id TEXT, leader_fingerprint TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mingle_project_collaboration_joins (
        invitation_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, device_id TEXT NOT NULL, local_project_id TEXT NOT NULL, team_id TEXT NOT NULL,
        shared_project_id TEXT NOT NULL, session_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, created_at TEXT NOT NULL);`);
    if (options.bind !== false) this.bind(kind);
    this.service = new ProjectMemoryService(this.store, { scanMinIntervalMs: 0, localUser: () => ({ accountId: this.accountId, displayName: `User ${this.accountId.slice(0, 4)}` }) });
    const node = this;
    const transport: MemoryTransport = {
      snapshot: () => { node.snapshots++; return { deviceId: node.deviceId, devices: [...mesh.nodes.values()].map((n) => n.publicDevice()),
        links: [...mesh.links].map((pair) => { const [deviceId, peerDeviceId] = pair.split('>'); return { teamId: TEAM, deviceId: deviceId!, peerDeviceId: peerDeviceId!, peerFingerprint: 'SHA-256:' + '0'.repeat(64), createdAt: '', mutual: mesh.links.has(`${peerDeviceId}>${deviceId}`) }; }) }; },
      send: async (input) => {
        node.sends++;
        if (mesh.failSends) throw new Error('relay unreachable');
        const message: AuthenticatedTransportMessage = { id: randomUUID(), teamId: input.teamId, fromDeviceId: node.deviceId, toDeviceId: input.toDeviceId,
          kind: input.kind as AuthenticatedTransportMessage['kind'], payload: JSON.parse(JSON.stringify(input.payload)) };
        mesh.log.push(message);
        mesh.queue.push(message);
        return message.id;
      },
      signPayload: async (_team, _device, payload) => signDevicePayload(payload, node.keys),
      onMessage: (handler) => { node.handler = handler; return () => { node.handler = null; }; },
    };
    this.sync = new ProjectMemoryTeamSync({
      store: this.store, service: this.service, transport, retryBaseMs: options.retryBaseMs, requestRateMs: 0,
      log: (level, message) => { if (level === 'warn' && /^(Rejected|Skipped)/.test(message)) mesh.rejected.push(message); },
      authority: {
        authorizeTeam: async ({ peerDeviceId }) => { node.authorizations++; if (peerDeviceId && mesh.revoked.has(peerDeviceId)) throw Object.assign(new Error('revoked'), { status: 403, name: 'HttpError' }); },
        members: async () => [...mesh.members].map((accountId) => ({ accountId })),
        localAccountId: () => this.accountId,
      },
    });
    mesh.nodes.set(this.deviceId, this);
    mesh.members.add(accountId);
    cleanup.push(async () => { await this.sync.close(); this.service.close(); });
  }

  bind(kind: 'owner' | 'joined'): void {
    const now = new Date().toISOString();
    if (kind === 'owner') this.store.db.prepare('INSERT INTO mingle_project_collaboration_sources VALUES (?,?,?,?,?,?,?,?)').run(this.projectId, this.accountId, TEAM, SHARED, this.deviceId, null, now, now);
    else this.store.db.prepare('INSERT INTO mingle_project_collaboration_joins VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), this.accountId, this.deviceId, this.projectId, TEAM, SHARED, 'ses', 'claude', 'm', 'medium', now);
  }

  publicDevice(): DistributedDevice {
    return { id: this.deviceId, teamId: TEAM, ownerId: this.accountId, name: 'dev', signingPublicKey: this.keys.signingPublicKeyDer, encryptionPublicKey: this.keys.encryptionPublicKeyDer,
      fingerprint: this.keys.fingerprint, lastSeenAt: null, revokedAt: this.mesh.revoked.has(this.deviceId) ? new Date().toISOString() : null, createdAt: '', status: 'online' };
  }

  agent(name = 'Agent'): AgentContext {
    const session: Session = this.store.insertSession({ projectId: this.projectId, name, provider: 'codex', model: 'gpt-x', effort: 'medium', policy: 'balanced', isolated: false, worktreePath: this.root, branch: null });
    const message = this.store.insertMessage({ sessionId: session.id, role: 'user', content: 'go' });
    const runId = `run_${randomUUID().slice(0, 8)}`;
    this.store.insertRun({ id: runId, sessionId: session.id, userMessageId: message.id, provider: 'codex', model: 'gpt-x', startedAt: new Date().toISOString() });
    return { session, runId };
  }

  async settle(): Promise<void> { await this.sync.publish(this.projectId); }
  heads() { return this.service.repo.listEntries(this.projectId, 'all'); }
}

async function pair(options: { bindB?: boolean } = {}) {
  const mesh = new Mesh();
  const a = new Node(mesh, randomUUID(), 'owner');
  const b = new Node(mesh, randomUUID(), 'joined', { bind: options.bindB });
  mesh.link(a, b);
  return { mesh, a, b };
}

describe('team project memory sync (two-device fixture)', () => {
  it('backfills a late-bound project after more than 50 offline writes and pruned unsigned ancestors', async () => {
    const mesh = new Mesh();
    const a = new Node(mesh, randomUUID(), 'owner', { bind: false });
    const { entry: created } = await a.service.agentRemember(a.agent(), { kind: 'fact', title: 'Offline ancestry', body: 'Initial offline value.' });
    let entry = created;
    let prunedAncestorId = '';
    for (let i = 1; i <= 64; i++) {
      entry = (await a.service.agentUpdate(a.agent(), { id: entry.id, body: `Offline value ${i}.` })).entry;
      if (i === 2) prunedAncestorId = entry.headRecordId;
    }
    expect(a.service.repo.countRecords(entry.id)).toBeLessThanOrEqual(PROJECT_MEMORY_LIMITS.maxRevisionsPerEntry);
    expect(a.service.repo.getRecord(prunedAncestorId)).toBeUndefined();
    expect(a.service.repo.unpublishedCount(a.projectId)).toBe(a.service.repo.countRecords(entry.id));

    a.bind('owner');
    const c = new Node(mesh, randomUUID(), 'joined');
    mesh.link(a, c);
    expect(await c.sync.requestBackfill(c.projectId, true)).toBe(1);
    await mesh.deliver();

    expect(c.service.repo.getEntry(entry.id)).toMatchObject({ headRecordId: entry.headRecordId, revision: entry.revision, body: entry.body });
    expect(c.service.repo.pendingCausalRecords(entry.id)).toHaveLength(0);
    expect(mesh.rejected).toEqual([]);
  }, 30_000);

  it('replicates create, update, human pin and retire in both directions with attribution intact', async () => {
    const { mesh, a, b } = await pair();
    const ctx = a.agent('Alpha agent');
    const created = await a.service.agentRemember(ctx, { kind: 'decision', title: 'Adopt the outbox pattern', body: 'Publish events through an outbox table.', files: ['src/a.ts'], evidence: 'evidenced' });
    await a.settle();
    await mesh.deliver();

    const onB = b.service.repo.getEntry(created.entry.id)!;
    expect(onB).toMatchObject({ title: 'Adopt the outbox pattern', status: 'evidenced', revision: 1, originDeviceId: a.deviceId, projectId: b.projectId });
    expect(onB.author).toMatchObject({ kind: 'agent', name: 'Alpha agent', provider: 'codex', model: 'gpt-x', accountId: a.accountId, deviceId: a.deviceId });
    expect(onB.files[0]!.path).toBe('src/a.ts');
    expect((await b.service.list(b.projectId, { include: 'live', limit: 10 } as never)).entries[0]).toMatchObject({ origin: { local: false, deviceId: a.deviceId } });
    expect(a.service.sharing(a.projectId)).toMatchObject({ shared: true, teamId: TEAM, sharedProjectId: SHARED, peerCount: 1, unpublished: 0, localDeviceId: a.deviceId });

    // B's person pins it; A sees the pin and its agent is now locked out.
    const pinned = await b.service.humanPatch(b.projectId, created.entry.id, { expectedRevision: 1, expectedHeadId: created.entry.headRecordId, pinned: true });
    await b.settle();
    await mesh.deliver();
    expect(a.service.repo.getEntry(created.entry.id)).toMatchObject({ pinned: true, revision: 2, originDeviceId: b.deviceId });
    await expect(a.service.agentUpdate(ctx, { id: created.entry.id, body: 'overwrite attempt' })).rejects.toThrow(/pinned/);
    expect(pinned.entry.updatedBy).toMatchObject({ kind: 'human', accountId: b.accountId, deviceId: b.deviceId });

    // Human unpins and retires on A; the tombstone reaches B.
    const unpinned = await a.service.humanPatch(a.projectId, created.entry.id, { expectedRevision: 2, expectedHeadId: a.service.repo.getEntry(created.entry.id)!.headRecordId, pinned: false });
    await a.service.humanPatch(a.projectId, created.entry.id, { expectedRevision: unpinned.entry.revision, expectedHeadId: unpinned.entry.headRecordId, lifecycle: 'retired', note: 'obsolete' });
    await a.settle();
    await mesh.deliver();
    expect(b.service.repo.getEntry(created.entry.id)).toMatchObject({ retired: true, revision: 4 });
    const history = b.service.history(b.projectId, created.entry.id, { limit: 20 }).revisions;
    expect(history.map((r) => r.op)).toEqual(['retire', 'pin', 'pin', 'create']);
    expect(history.every((r) => r.received === (r.author.deviceId !== b.deviceId))).toBe(true);
    expect(mesh.rejected).toEqual([]);
  });

  it('preserves a low-revision human control head across a full history, pruning and third-device backfill', async () => {
    const { mesh, a, b } = await pair();
    const ctx = a.agent();
    const { entry } = await a.service.agentRemember(ctx, { kind: 'fact', title: 'Protected pruned head', body: 'Original pinned value.' });
    await a.settle(); await mesh.deliver();
    const pin = await b.service.humanPatch(b.projectId, entry.id, { expectedRevision: 1, expectedHeadId: entry.headRecordId, pinned: true });
    await b.settle();
    const controls = mesh.queue.splice(0);
    for (let i = 0; i < 60; i++) {
      await a.service.agentUpdate(a.agent(), { id: entry.id, body: `Offline body version ${i}.` });
      await a.settle();
    }
    await mesh.deliver();
    mesh.queue.push(...controls); await mesh.deliver();
    for (const n of [a, b]) {
      expect(n.service.repo.getEntry(entry.id)).toMatchObject({ headRecordId: pin.entry.headRecordId, pinned: true, body: entry.body });
      expect(n.service.repo.getRecord(pin.entry.headRecordId)).toBeDefined();
      expect(n.service.repo.countRecords(entry.id)).toBeLessThanOrEqual(PROJECT_MEMORY_LIMITS.maxRevisionsPerEntry);
      n.service.repo.pruneRecords(entry.id);
      expect(n.service.repo.getRecord(pin.entry.headRecordId)).toBeDefined();
    }
    const c = new Node(mesh, randomUUID(), 'joined'); mesh.link(a, c);
    await c.sync.requestBackfill(c.projectId, true); await mesh.deliver();
    expect(c.service.repo.getEntry(entry.id)).toMatchObject({ headRecordId: pin.entry.headRecordId, pinned: true, body: entry.body });
    expect(mesh.rejected).toEqual([]);
  });

  it('is idempotent under replay and tolerates out-of-order delivery', async () => {
    const { mesh, a, b } = await pair();
    const ctx = a.agent();
    const created = await a.service.agentRemember(ctx, { kind: 'fact', title: 'Order independence', body: 'First revision of the fact.' });
    await a.service.agentUpdate(ctx, { id: created.entry.id, body: 'Second revision of the fact, rewritten.' });
    await a.service.agentUpdate(ctx, { id: created.entry.id, body: 'Third revision of the fact, rewritten again.' });
    await a.settle();
    const records = mesh.log.filter((m) => m.kind === 'projectmemory.record');
    expect(records).toHaveLength(3);
    mesh.queue = [];

    await mesh.redeliver(records[2]!); // missing ancestors are requested by exact ID; the head may advance as backfill resolves them
    await mesh.redeliver(records[0]!);
    await mesh.redeliver(records[1]!);
    expect(b.service.repo.getEntry(created.entry.id)).toMatchObject({ revision: 3, body: 'Third revision of the fact, rewritten again.' });
    const before = b.service.repo.countRecords(created.entry.id);
    expect(before).toBe(3);

    for (let i = 0; i < 3; i++) { for (const record of records) await mesh.redeliver(record!); }
    expect(b.service.repo.countRecords(created.entry.id)).toBe(before);
    expect(b.service.repo.liveCount(b.projectId)).toBe(1);
    expect(mesh.rejected).toEqual([]);
  });

  it('converges offline agent edits around human control epochs and ignores delayed pins after unpin', async () => {
    const { mesh, a, b } = await pair();
    const ctx = a.agent();
    const created = await a.service.agentRemember(ctx, { kind: 'fact', title: 'Human control', body: 'Initial shared value.' });
    await a.settle(); await mesh.deliver();

    await b.service.humanPatch(b.projectId, created.entry.id, { expectedRevision: 1, expectedHeadId: created.entry.headRecordId, pinned: true });
    await b.settle();
    const pin = mesh.log.findLast((m) => m.kind === 'projectmemory.record' && m.fromDeviceId === b.deviceId)!;
    await a.service.agentUpdate(ctx, { id: created.entry.id, body: 'Offline agent edit one.' });
    await a.service.agentUpdate(ctx, { id: created.entry.id, body: 'Offline agent edit two.' });
    await a.settle();
    const offlineAgentRecords = mesh.log.filter((m) => m.kind === 'projectmemory.record' && m.fromDeviceId === a.deviceId).slice(-2);

    // Different arrival order on each device retains both branches but the human pin wins on both.
    await mesh.redeliver(offlineAgentRecords[1]!);
    await mesh.redeliver(pin);
    await mesh.redeliver(offlineAgentRecords[0]!);
    expect(a.service.repo.getEntry(created.entry.id)).toMatchObject({ pinned: true, body: 'Initial shared value.' });
    expect(b.service.repo.getEntry(created.entry.id)).toMatchObject({ pinned: true, body: 'Initial shared value.' });
    expect(a.service.repo.countRecords(created.entry.id)).toBe(4);
    expect(b.service.repo.countRecords(created.entry.id)).toBe(4);

    await b.service.humanPatch(b.projectId, created.entry.id, { expectedRevision: 2, expectedHeadId: b.service.repo.getEntry(created.entry.id)!.headRecordId, pinned: false });
    await b.settle(); await mesh.deliver();
    const agentAfterUnpin = await a.service.agentUpdate(ctx, { id: created.entry.id, body: 'Agent edit after human unpin.' });
    await a.settle(); await mesh.deliver();
    await mesh.redeliver(pin); // stale delayed control record must not undo the unpin
    expect(agentAfterUnpin.entry.body).toBe('Agent edit after human unpin.');
    expect(a.service.repo.getEntry(created.entry.id)).toMatchObject({ pinned: false, body: 'Agent edit after human unpin.' });
    expect(b.service.repo.getEntry(created.entry.id)).toMatchObject({ pinned: false, body: 'Agent edit after human unpin.' });
    expect(mesh.rejected).toEqual([]);
  });

  it('keeps an agent descendant pending until its unseen human unpin proof arrives, then converges in either order', async () => {
    for (const agentFirst of [true, false]) {
      const { mesh, a, b } = await pair();
      const ctx = a.agent();
      const created = await a.service.agentRemember(ctx, { kind: 'fact', title: 'Ancestor delivery order', body: 'Before controls.' });
      await a.settle(); await mesh.deliver();
      await b.service.humanPatch(b.projectId, created.entry.id, { expectedRevision: 1, expectedHeadId: created.entry.headRecordId, pinned: true });
      await b.settle(); await mesh.deliver();

      const pinned = b.service.repo.getEntry(created.entry.id)!;
      const unpin = await a.service.humanPatch(a.projectId, created.entry.id, { expectedRevision: pinned.revision, expectedHeadId: pinned.headRecordId, pinned: false });
      await a.service.agentUpdate(ctx, { id: created.entry.id, expectedHeadId: unpin.entry.headRecordId, body: 'Descendant authored after the unpin.' });
      await a.settle();
      const fromA = mesh.log.filter((m) => m.kind === 'projectmemory.record' && m.fromDeviceId === a.deviceId && (m.payload as ProjectMemorySyncRecord).entryId === created.entry.id).slice(-2);
      const unpinRecord = fromA[0]!;
      const agentRecord = fromA[1]!;
      mesh.queue = [];

      if (agentFirst) {
        const receiveA = a.handler;
        a.handler = null; // leave the exact parent proof request pending so we can inspect quarantine before backfill
        await mesh.redeliver(agentRecord);
        expect(b.service.repo.pendingCausalRecords(created.entry.id)).toHaveLength(1);
        expect(b.service.repo.getEntry(created.entry.id)).toMatchObject({ pinned: true, body: 'Before controls.' });
        a.handler = receiveA;
        await mesh.redeliver(unpinRecord);
      } else {
        await mesh.redeliver(unpinRecord);
        await mesh.redeliver(agentRecord);
      }
      expect(a.service.repo.getEntry(created.entry.id)).toMatchObject({ pinned: false, body: 'Descendant authored after the unpin.' });
      expect(b.service.repo.getEntry(created.entry.id)).toMatchObject({ pinned: false, body: 'Descendant authored after the unpin.' });
      expect(b.service.repo.pendingCausalRecords(created.entry.id)).toHaveLength(0);
      expect(mesh.rejected).toEqual([]);
    }
  });

  it('chooses one signed human control branch before comparing descendant revisions', async () => {
    for (const descendantFirst of [true, false]) {
      const { mesh, a, b } = await pair();
      const ctx = a.agent();
      const created = await a.service.agentRemember(ctx, { kind: 'fact', title: 'Concurrent controls', body: 'Shared base.' });
      await a.settle(); await mesh.deliver();
      const pin = await b.service.humanPatch(b.projectId, created.entry.id, { expectedRevision: 1, expectedHeadId: created.entry.headRecordId, pinned: true });
      await b.settle();
      const pinRecord = mesh.log.filter((m) => m.kind === 'projectmemory.record' && m.fromDeviceId === b.deviceId).at(-1)!;
      const edit = await a.service.humanPatch(a.projectId, created.entry.id, { expectedRevision: 1, expectedHeadId: created.entry.headRecordId, body: 'Concurrent human edit branch.' });
      await a.service.agentUpdate(ctx, { id: created.entry.id, body: 'Agent descendant of human edit branch.' });
      await a.settle();
      const fromA = mesh.log.filter((m) => m.kind === 'projectmemory.record' && m.fromDeviceId === a.deviceId && (m.payload as ProjectMemorySyncRecord).entryId === created.entry.id).slice(-2);
      const humanEditRecord = fromA[0]!;
      const agentRecord = fromA[1]!;
      mesh.queue = [];

      if (descendantFirst) {
        const receiveA = a.handler;
        a.handler = null;
        await mesh.redeliver(agentRecord);
        a.handler = receiveA;
        await mesh.redeliver(humanEditRecord);
      } else {
        await mesh.redeliver(humanEditRecord);
        await mesh.redeliver(agentRecord);
      }
      await mesh.redeliver(pinRecord);
      const pinProof = (pinRecord.payload as ProjectMemorySyncRecord).causalProof!;
      const editProof = (humanEditRecord.payload as ProjectMemorySyncRecord).causalProof!;
      const winningControl = pinProof.controlId!.localeCompare(editProof.controlId!) > 0 ? pinProof.controlId : editProof.controlId;
      const aHead = a.service.repo.getEntry(created.entry.id)!;
      const bHead = b.service.repo.getEntry(created.entry.id)!;
      expect(aHead.headRecordId).toBe(bHead.headRecordId);
      expect(a.service.repo.lineageFor(aHead.headRecordId)?.controlId).toBe(winningControl);
      expect(b.service.repo.lineageFor(bHead.headRecordId)?.controlId).toBe(winningControl);
      expect(mesh.rejected).toEqual([]);
      expect(pin.entry.headRecordId).not.toBe(edit.entry.headRecordId);
    }
  });

  it('uses exact purged IDs for resurrection protection without blocking unrelated old offline creates', async () => {
    const { b } = await pair();
    const retiredId = randomUUID();
    b.service.repo.markRetiredId(b.projectId, retiredId, '2025-01-01T00:00:00.000Z');
    const offlineId = randomUUID();
    const at = '2020-01-01T00:00:00.000Z';
    const record: ProjectMemorySyncRecord = {
      id: randomUUID(), entryId: offlineId, revision: 1, parentRevision: null, op: 'create', at,
      teamId: TEAM, sharedProjectId: SHARED,
      author: { kind: 'human', displayName: 'Offline', accountId: b.accountId, deviceId: b.deviceId },
      note: null, content: { kind: 'fact', title: 'Old offline create', body: 'A valid entry created before unrelated compaction.', status: 'tentative', pinned: false, retired: false, humanVerified: true, files: [], sources: [] },
      createdAt: at, authorDeviceId: b.deviceId, signature: 'x'.repeat(80), lineage: { parentId: null, controlId: null, epoch: 1 },
    };
    expect(b.service.applyRemote(b.projectId, record)).toBe('applied');
    expect(b.service.applyRemote(b.projectId, { ...record, id: randomUUID(), entryId: retiredId })).toBe('ignored');
    expect(b.service.repo.getEntry(offlineId)?.title).toBe('Old offline create');
    expect(b.service.repo.getEntry(retiredId)).toBeUndefined();
  });

  it('relays legacy signatures with lineage still absent from the original signed payload', async () => {
    const { a, b } = await pair();
    const at = new Date().toISOString();
    const unsigned = {
      id: randomUUID(), entryId: randomUUID(), revision: 1, parentRevision: null, op: 'create' as const, at,
      teamId: TEAM, sharedProjectId: SHARED,
      author: { kind: 'human' as const, displayName: 'Legacy author', accountId: a.accountId, deviceId: a.deviceId }, note: null,
      content: { kind: 'fact' as const, title: 'Legacy signed payload', body: 'A record from before causal proofs.', status: 'tentative' as const,
        pinned: false, retired: false, humanVerified: true, files: [], sources: [] },
      createdAt: at, authorDeviceId: a.deviceId,
    };
    const legacy: ProjectMemorySyncRecord = { ...unsigned, signature: signDevicePayload(signingPayload(unsigned), a.keys) };
    expect(Object.hasOwn(legacy, 'lineage')).toBe(false);
    expect(b.service.applyRemote(b.projectId, legacy)).toBe('applied');
    const relayed = b.service.toSyncRecord(b.service.repo.getRecord(legacy.id)!, TEAM, SHARED, a.deviceId, legacy.signature);
    expect(Object.hasOwn(relayed, 'lineage')).toBe(false);
    expect(Object.hasOwn(relayed, 'causalProof')).toBe(false);
    expect(signingPayload(relayed)).toBe(signingPayload(legacy));
    expect(relayed.signature).toBe(legacy.signature);

    const assertedEntryId = randomUUID();
    const assertedLineage = { parentId: null, controlId: randomUUID(), epoch: 900_000 };
    const assertedUnsigned = { ...unsigned, id: randomUUID(), entryId: assertedEntryId, lineage: assertedLineage,
      content: { ...unsigned.content, title: 'Legacy asserted causal metadata', body: 'A different record with an untrusted old epoch.' } };
    const assertedLegacy: ProjectMemorySyncRecord = { ...assertedUnsigned, signature: signDevicePayload(signingPayload(assertedUnsigned), a.keys) };
    expect(b.service.applyRemote(b.projectId, assertedLegacy)).toBe('applied');
    expect(b.service.repo.lineageFor(assertedLegacy.id)).toBeUndefined();
    const controlled = await b.service.humanPatch(b.projectId, assertedEntryId, { expectedRevision: 1, expectedHeadId: assertedLegacy.id, body: 'A new validated control baseline.' });
    expect(b.service.repo.getRecord(controlled.entry.headRecordId)?.lineage).toMatchObject({ epoch: 1, controlId: controlled.entry.headRecordId });
  });

  it('rejects a correctly signed agent proof that invents a control epoch or human-only flags', async () => {
    const { mesh, a, b } = await pair();
    const ctx = a.agent();
    const created = await a.service.agentRemember(ctx, { kind: 'fact', title: 'Proof validation', body: 'Original value.' });
    await a.settle(); await mesh.deliver();
    await a.service.agentUpdate(ctx, { id: created.entry.id, body: 'Legitimate agent value.' });
    await a.settle();
    const message = mesh.log.filter((item) => item.kind === 'projectmemory.record' && item.fromDeviceId === a.deviceId).at(-1)!;
    const forged = structuredClone(message.payload) as ProjectMemorySyncRecord;
    const proof = forged.causalProof!;
    const lineage = { ...forged.lineage!, epoch: proof.epoch + 9, controlId: randomUUID() };
    const { signature: _oldProofSignature, ...proofFields } = { ...proof, ...lineage, pinned: true, humanVerified: true };
    forged.lineage = lineage;
    forged.content.pinned = true;
    forged.content.humanVerified = true;
    forged.causalProof = { ...proof, ...lineage, pinned: true, humanVerified: true,
      signature: signDevicePayload(causalProofPayload(proofFields), a.keys) };
    forged.signature = signDevicePayload(signingPayload({ ...forged, signature: undefined } as never), a.keys);
    mesh.queue = [];
    await mesh.redeliver({ ...message, id: randomUUID(), payload: forged });
    expect(b.service.repo.hasRecord(forged.id)).toBe(false);
    expect(b.service.repo.getEntry(created.entry.id)).toMatchObject({ pinned: false, humanVerified: false, body: 'Original value.' });
    expect(mesh.rejected.join(' ')).toMatch(/ancestry proof/i);
  });

  it('serves signed compact ancestry proofs after history pruning so a third device can validate a head', async () => {
    const { mesh, a, b } = await pair();
    const ctx = a.agent();
    let entry = (await a.service.agentRemember(ctx, { kind: 'fact', title: 'Pruned ancestry', body: 'Revision zero.' })).entry;
    await a.settle(); await mesh.deliver();
    for (let i = 1; i <= PROJECT_MEMORY_LIMITS.maxRevisionsPerEntry + 4; i++) {
      entry = (await a.service.humanPatch(a.projectId, entry.id, { expectedRevision: entry.revision, expectedHeadId: entry.headRecordId, body: `Revision ${i}.` })).entry;
      await a.settle(); await mesh.deliver();
    }
    expect(a.service.repo.countRecords(entry.id)).toBe(PROJECT_MEMORY_LIMITS.maxRevisionsPerEntry);
    expect(b.service.repo.countRecords(entry.id)).toBe(PROJECT_MEMORY_LIMITS.maxRevisionsPerEntry);

    const c = new Node(mesh, randomUUID(), 'joined');
    mesh.link(b, c);
    expect(await c.sync.requestBackfill(c.projectId, true)).toBe(1);
    await mesh.deliver();
    expect(c.service.repo.getEntry(entry.id)).toMatchObject({ revision: entry.revision, body: entry.body, headRecordId: entry.headRecordId });
    expect(c.service.repo.lineageFor(entry.headRecordId)).toMatchObject({ epoch: entry.revision - 1, controlId: entry.headRecordId });
    expect(mesh.rejected).toEqual([]);
  }, 30_000);

  it('rejects unauthorized senders, forged signatures and bad bindings', async () => {
    const { mesh, a, b } = await pair();
    const intruder = new Node(mesh, randomUUID(), 'joined');
    mesh.members.delete(intruder.accountId); // not an active team member
    mesh.link(intruder, b);
    const ctx = intruder.agent();
    await intruder.service.agentRemember(ctx, { kind: 'fact', title: 'Planted by non-member', body: 'Should never arrive anywhere.' });
    await intruder.settle();
    await mesh.deliver();
    expect(b.heads()).toHaveLength(0);
    expect(mesh.rejected.join(' ')).toMatch(/not an active member/);

    // A legitimate member's record, but tampered after signing.
    mesh.rejected.length = 0;
    const real = await a.service.agentRemember(a.agent(), { kind: 'fact', title: 'Honest entry from A', body: 'This is what A really wrote.' });
    await a.settle();
    const sent = mesh.log.filter((m) => m.kind === 'projectmemory.record' && m.toDeviceId === b.deviceId).at(-1)!;
    mesh.queue = [];
    const tampered = JSON.parse(JSON.stringify(sent)) as AuthenticatedTransportMessage<ProjectMemorySyncRecord>;
    tampered.payload.content.body = 'Tampered after signing by a relay.';
    await mesh.redeliver(tampered);
    expect(b.heads()).toHaveLength(0);
    expect(mesh.rejected.join(' ')).toMatch(/signature is invalid/);

    // A device cannot sign for another account's identity or another device.
    const stolen = JSON.parse(JSON.stringify(sent)) as AuthenticatedTransportMessage<ProjectMemorySyncRecord>;
    stolen.payload.author = { ...stolen.payload.author, accountId: b.accountId };
    stolen.payload.signature = signDevicePayload(signingPayload({ ...stolen.payload, signature: undefined } as never), a.keys);
    mesh.rejected.length = 0;
    await mesh.redeliver(stolen);
    expect(b.heads()).toHaveLength(0);
    expect(mesh.rejected.join(' ')).toMatch(/author account/);

    // Direct records must be signed by the device that sent them.
    const relayed = JSON.parse(JSON.stringify(sent)) as AuthenticatedTransportMessage;
    relayed.fromDeviceId = intruder.deviceId;
    mesh.rejected.length = 0;
    await mesh.redeliver(relayed);
    expect(b.heads()).toHaveLength(0);

    // Wrong shared project: no local binding on the receiver.
    const wrongProject = JSON.parse(JSON.stringify(sent)) as AuthenticatedTransportMessage<ProjectMemorySyncRecord>;
    wrongProject.payload.sharedProjectId = randomUUID();
    mesh.rejected.length = 0;
    await mesh.redeliver(wrongProject);
    expect(b.heads()).toHaveLength(0);
    expect(mesh.rejected.join(' ')).toMatch(/not bound/);

    // Not addressed to this device / not mutually linked / revoked.
    const misaddressed = JSON.parse(JSON.stringify(sent)) as AuthenticatedTransportMessage;
    misaddressed.toDeviceId = randomUUID();
    b.handler!(misaddressed);
    mesh.links.delete(`${b.deviceId}>${a.deviceId}`);
    mesh.rejected.length = 0;
    await mesh.redeliver(sent);
    expect(b.heads()).toHaveLength(0);
    expect(mesh.rejected.join(' ')).toMatch(/mutually linked/);
    mesh.links.add(`${b.deviceId}>${a.deviceId}`);
    mesh.revoked.add(a.deviceId);
    mesh.rejected.length = 0;
    await mesh.redeliver(sent);
    expect(b.heads()).toHaveLength(0);
    mesh.revoked.delete(a.deviceId);

    // After all that, the untouched original still applies once.
    await mesh.redeliver(sent);
    expect(b.heads().map((e) => e.id)).toEqual([real.entry.id]);
  });

  it('rejects signed peer records that carry secrets, unsafe paths or oversize/forged shape', async () => {
    const { mesh, a, b } = await pair();
    const ctx = a.agent();
    const ok = await a.service.agentRemember(ctx, { kind: 'fact', title: 'Template record for tampering', body: 'Benign content.' });
    await a.settle();
    const base = (mesh.log.find((m) => m.kind === 'projectmemory.record')!.payload as ProjectMemorySyncRecord);
    mesh.queue = [];
    const resend = async (patch: (record: ProjectMemorySyncRecord) => void) => {
      const record = JSON.parse(JSON.stringify(base)) as ProjectMemorySyncRecord;
      record.id = randomUUID(); record.entryId = randomUUID();
      patch(record);
      record.signature = signDevicePayload(signingPayload({ ...record, signature: undefined } as never), a.keys); // a valid signature over bad content
      mesh.queue.push({ id: randomUUID(), teamId: TEAM, fromDeviceId: a.deviceId, toDeviceId: b.deviceId, kind: 'projectmemory.record', payload: record });
      await mesh.deliver();
    };
    await resend((r) => { r.content.body = 'api_key = sk-abcdefghijklmnopqrstuvwxyz012345'; });
    await resend((r) => { r.content.files = [{ path: '../../etc/passwd', revision: 'a'.repeat(32), baseRevision: null, verifiedAt: new Date().toISOString() }]; });
    await resend((r) => { r.content.files = [{ path: '.env', revision: 'a'.repeat(32), baseRevision: null, verifiedAt: new Date().toISOString() }]; });
    await resend((r) => { r.at = new Date(Date.now() + 3_600_000).toISOString(); });
    await resend((r) => { r.op = 'create'; r.revision = 5; });
    await resend((r) => { r.content.title = 'bell\u0007 char'; });
    expect(b.heads().filter((e) => e.id !== ok.entry.id)).toHaveLength(0);
    expect(mesh.rejected.length).toBe(6);
  });

  it('applies the agent pin-lock and no-resurrection rules to peer records; humans can restore', async () => {
    const { mesh, a, b } = await pair();
    const ctx = a.agent();
    const created = await a.service.agentRemember(ctx, { kind: 'decision', title: 'Locked decision text', body: 'Humans own this one.' });
    await a.settle(); await mesh.deliver();
    await b.service.humanPatch(b.projectId, created.entry.id, { expectedRevision: 1, expectedHeadId: created.entry.headRecordId, pinned: true });
    await b.settle(); await mesh.deliver();
    expect(a.service.repo.getEntry(created.entry.id)!.pinned).toBe(true);

    // A peer agent record built on an old revision (e.g. a device that missed the pin) cannot override a pinned entry.
    const base = a.service.repo.getEntry(created.entry.id)!;
    const forgedAgent = (revision: number, retired: boolean, at: Date): ProjectMemorySyncRecord => {
      const record = { id: randomUUID(), entryId: created.entry.id, revision, parentRevision: revision - 1, op: 'update' as const, at: at.toISOString(), teamId: TEAM, sharedProjectId: SHARED,
        author: { ...base.author, accountId: a.accountId, deviceId: a.deviceId }, note: null, createdAt: at.toISOString(), authorDeviceId: a.deviceId,
        content: { kind: 'decision' as const, title: 'Hijacked', body: 'Overwritten by an agent.', status: 'tentative' as const, pinned: false, retired, humanVerified: false, files: [], sources: [] }, signature: '' };
      record.signature = signDevicePayload(signingPayload({ ...record, signature: undefined } as never), a.keys);
      return record;
    };
    await mesh.redeliver({ id: randomUUID(), teamId: TEAM, fromDeviceId: a.deviceId, toDeviceId: b.deviceId, kind: 'projectmemory.record', payload: forgedAgent(3, false, new Date()) });
    expect(b.service.repo.getEntry(created.entry.id)).toMatchObject({ title: 'Locked decision text', pinned: true, revision: 2 });

    // Human retires on B; later agent revisions cannot bring it back, but a person can.
    await b.service.humanPatch(b.projectId, created.entry.id, { expectedRevision: 2, expectedHeadId: b.service.repo.getEntry(created.entry.id)!.headRecordId, lifecycle: 'retired' });
    await mesh.redeliver({ id: randomUUID(), teamId: TEAM, fromDeviceId: a.deviceId, toDeviceId: b.deviceId, kind: 'projectmemory.record', payload: forgedAgent(9, false, new Date()) });
    expect(b.service.repo.getEntry(created.entry.id)).toMatchObject({ retired: true, revision: 3 });
    const restored = await b.service.humanPatch(b.projectId, created.entry.id, { expectedRevision: 3, expectedHeadId: b.service.repo.getEntry(created.entry.id)!.headRecordId, lifecycle: 'active' });
    expect(restored.entry.lifecycle).toBe('active');
  });

  it('backfills a device that was offline or newly linked, in bounded resumable batches, and serves relayed history', async () => {
    const mesh = new Mesh();
    const a = new Node(mesh, randomUUID(), 'owner');
    const b = new Node(mesh, randomUUID(), 'joined');
    // A writes before B is linked: nothing is sent, but every revision is signed and kept.
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) ids.push((await a.service.humanCreate(a.projectId, { kind: 'fact', title: `Offline fact ${i} topic${i}`, body: `Body number ${i} with unique marker m${i}${'z'.repeat(i % 7)}` })).entry.id);
    const ctx = a.agent();
    const edited = await a.service.agentRemember(ctx, { kind: 'gotcha', title: 'Written while B was away', body: 'Late edit for the offline device.', files: ['src/a.ts'], evidence: 'evidenced' });
    await a.settle();
    expect(mesh.log).toHaveLength(0);
    expect(a.service.sharing(a.projectId).unpublished).toBe(0);

    mesh.link(a, b);
    // The first request a joining device makes.
    expect(await b.sync.requestBackfill(b.projectId, true)).toBe(1);
    await mesh.deliver();
    expect(b.service.repo.liveCount(b.projectId)).toBe(121);
    expect(b.service.repo.getEntry(edited.entry.id)).toMatchObject({ originDeviceId: a.deviceId, status: 'evidenced' });
    const responses = mesh.log.filter((m) => m.kind === 'projectmemory.sync.response');
    expect(responses.length).toBeGreaterThanOrEqual(3);
    expect(responses.every((m) => (m.payload as { records: unknown[] }).records.length <= 50)).toBe(true);
    expect(b.service.sharing(b.projectId).lastBackfillAt).not.toBeNull();
    expect(mesh.rejected).toEqual([]);

    // An unsolicited, replayed or out-of-window response is refused.
    const before = mesh.rejected.length;
    await mesh.redeliver(responses[0]!);
    expect(mesh.rejected.length).toBeGreaterThan(before);
    expect(mesh.rejected.at(-1)).toMatch(/not requested/);

    // Incremental: only newer records are requested afterwards, and a third device learns A's history from B (relayed records keep A's signature).
    await sleep(5);
    const newer = await a.service.humanCreate(a.projectId, { kind: 'fact', title: 'Fresh after first sync', body: 'Only this should be sent next.' });
    mesh.links.clear(); // B is momentarily unreachable
    await a.settle();
    mesh.queue = [];
    mesh.link(a, b);
    const logSize = mesh.log.length;
    await b.sync.requestBackfill(b.projectId, true);
    await mesh.deliver();
    const incremental = mesh.log.slice(logSize).filter((m) => m.kind === 'projectmemory.sync.response').flatMap((m) => (m.payload as { records: ProjectMemorySyncRecord[] }).records);
    // Requests start 1 ms before the newest known record so a concurrent writer in that millisecond is included; duplicates are harmless.
    expect(incremental.map((r) => r.entryId)).toContain(newer.entry.id);
    expect(incremental.length).toBeLessThanOrEqual(2);

    const c = new Node(mesh, randomUUID(), 'joined');
    mesh.link(b, c); // C only trusts B, not A
    await c.sync.requestBackfill(c.projectId, true);
    await mesh.deliver();
    expect(c.service.repo.liveCount(c.projectId)).toBe(122);
    expect(c.service.repo.getEntry(edited.entry.id)).toMatchObject({ author: expect.objectContaining({ accountId: a.accountId }), originDeviceId: a.deviceId });
    expect(mesh.rejected.filter((message) => !/not requested/.test(message))).toEqual([]);
    void ids;
  });

  it('retries unpublished work with backoff only while work is pending and never polls when idle', async () => {
    const mesh = new Mesh();
    const a = new Node(mesh, randomUUID(), 'owner', { retryBaseMs: 25 });
    const b = new Node(mesh, randomUUID(), 'joined');
    mesh.link(a, b);
    mesh.failSends = true;
    await a.service.humanCreate(a.projectId, { kind: 'fact', title: 'Sent after an outage', body: 'The relay was down when this was written.' });
    await a.sync.publish(a.projectId);
    expect(a.service.sharing(a.projectId)).toMatchObject({ unpublished: 1, error: 'relay unreachable' });
    expect((a.sync as any).retries.size).toBe(1);
    await sleep(60);
    expect(a.sends).toBeGreaterThan(1); // retried on its own

    mesh.failSends = false;
    await waitUntil(() => a.service.sharing(a.projectId).unpublished === 0);
    await mesh.deliver();
    expect(b.service.repo.liveCount(b.projectId)).toBe(1);
    expect((a.sync as any).retries.size).toBe(0);
    expect(a.service.sharing(a.projectId).error).toBeNull();

    // Idle: no sends, no authorization calls, no transport reads, no timers.
    await sleep(50);
    const counters = () => [a.sends, b.sends, a.authorizations, b.authorizations, a.snapshots, b.snapshots].join(',');
    const settled = counters();
    await sleep(400);
    expect(counters()).toBe(settled);
    expect((a.sync as any).retries.size).toBe(0);
    expect(a.sync.sharing(a.projectId).unpublished).toBe(0);
  });

  it('keeps unshared projects local: no sends, no pending work, no retry timer', async () => {
    const mesh = new Mesh();
    const solo = new Node(mesh, randomUUID(), 'owner', { bind: false });
    await solo.service.humanCreate(solo.projectId, { kind: 'fact', title: 'Local only memory', body: 'This project is not team shared.' });
    await solo.sync.publish(solo.projectId);
    expect(solo.sends).toBe(0);
    expect(solo.service.sharing(solo.projectId)).toMatchObject({ shared: false, unpublished: 0, error: null });
    expect((solo.sync as any).retries.size).toBe(0);
    expect(await solo.sync.requestBackfill(solo.projectId, true)).toBe(0);
    expect(canonicalJson({ ok: true })).toBe('{"ok":true}');
  });
});

async function waitUntil(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await sleep(10);
  }
}
