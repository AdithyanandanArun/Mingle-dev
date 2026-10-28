import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { expect, it } from 'vitest';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { GroupSnapshot, RunChanges } from '../../../../packages/contracts/src/index.ts';
import { TeamChatMessageSchema } from '../../../../packages/contracts/src/team-chat.ts';
import { canonicalJson, generateDeviceKeyMaterial, signDevicePayload } from '../distributed/crypto.ts';
import { openDatabase } from '../db.ts';
import { Store } from '../store.ts';
import { GroupRepo } from '../groups/repo.ts';
import { FakeProviders, makeRepo } from '../test-utils.ts';
import type { AccountService } from '../account/service.ts';
import type { DistributedWorkspaceService } from '../distributed/service.ts';
import type { ProjectCollaborationService } from '../project-collaboration/service.ts';
import { TeamChatService } from './service.ts';
import { decodeGroupView, encodeGroupView, projectGroupView } from './group-view.ts';

const HOST_ACCOUNT = '10000000-0000-4000-8000-000000000001';
const MEMBER_ACCOUNT = '10000000-0000-4000-8000-000000000002';
const OTHER_ACCOUNT = '10000000-0000-4000-8000-000000000003';
const TEAM = '20000000-0000-4000-8000-000000000001';
const SHARED = '30000000-0000-4000-8000-000000000001';
const HOST_DEVICE = '40000000-0000-4000-8000-000000000001';
const MEMBER_DEVICE = '40000000-0000-4000-8000-000000000002';
const OTHER_DEVICE = '40000000-0000-4000-8000-000000000003';
const HOST_PROJECT = 'project-group-view-host';
const MEMBER_PROJECT = 'project-group-view-member';
const hostKeys = generateDeviceKeyMaterial();
const memberKeys = generateDeviceKeyMaterial();
const otherKeys = generateDeviceKeyMaterial();

let memberActive = true;

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function cloudClient(): SupabaseClient {
  return {
    from(table: string) {
      const filters = new Map<string, unknown>();
      const builder: any = {
        select() { return builder; },
        eq(key: string, value: unknown) { filters.set(key, value); return builder; },
        in(key: string, value: unknown) { filters.set(key, value); return builder; },
        is() { return builder; },
        limit() { return builder; },
        maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
        },
      };
      const rows = () => {
        if (table === 'mingle_devices') {
          const devices = [
            { id: HOST_DEVICE, owner_id: HOST_ACCOUNT, signing_public_key: hostKeys.signingPublicKeyDer, encryption_public_key: hostKeys.encryptionPublicKeyDer, fingerprint: hostKeys.fingerprint, revoked_at: null },
            { id: MEMBER_DEVICE, owner_id: MEMBER_ACCOUNT, signing_public_key: memberKeys.signingPublicKeyDer, encryption_public_key: memberKeys.encryptionPublicKeyDer, fingerprint: memberKeys.fingerprint, revoked_at: null },
            { id: OTHER_DEVICE, owner_id: OTHER_ACCOUNT, signing_public_key: otherKeys.signingPublicKeyDer, encryption_public_key: otherKeys.encryptionPublicKeyDer, fingerprint: otherKeys.fingerprint, revoked_at: null },
          ];
          const id = filters.get('id');
          return Array.isArray(id) ? devices.filter((device) => id.includes(device.id)) : devices.filter((device) => device.id === id);
        }
        if (table === 'mingle_projects') return filters.get('id') === SHARED && filters.get('team_id') === TEAM ? [{ id: SHARED }] : [];
        if (table === 'mingle_members') {
          const accountIds = [HOST_ACCOUNT, ...(memberActive ? [MEMBER_ACCOUNT] : []), OTHER_ACCOUNT];
          const userId = filters.get('user_id');
          if (Array.isArray(userId)) return userId.filter((id) => accountIds.includes(String(id))).map((id) => ({ user_id: id }));
          return typeof userId === 'string' && accountIds.includes(userId) ? [{ user_id: userId, role: userId === HOST_ACCOUNT ? 'owner' : 'member' }] : [];
        }
        return [];
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

function node({ projectId, accountId, deviceId, role }: { projectId: string; accountId: string; deviceId: string; role: 'host' | 'member' }) {
  const data = openDatabase(':memory:');
  const store = new Store(data);
  const root = makeRepo();
  const project = store.insertProject({ id: projectId, name: 'Example shared coffee project', path: root });
  data.exec(`CREATE TABLE IF NOT EXISTS mingle_project_collaboration_sources (
      local_project_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,team_id TEXT NOT NULL,shared_project_id TEXT NOT NULL,leader_device_id TEXT,leader_fingerprint TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE IF NOT EXISTS mingle_project_collaboration_joins (
      invitation_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,device_id TEXT NOT NULL,local_project_id TEXT NOT NULL,team_id TEXT NOT NULL,shared_project_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT 'example-member-session',provider TEXT NOT NULL DEFAULT 'claude',model TEXT NOT NULL DEFAULT 'example-model',effort TEXT NOT NULL DEFAULT 'high',created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z');
    CREATE TABLE IF NOT EXISTS mingle_team_device_structures (shared_project_id TEXT PRIMARY KEY,team_id TEXT,host_device_id TEXT,structure_json TEXT,version INTEGER,received_at TEXT);`);
  if (role === 'host') {
    data.prepare(`INSERT INTO mingle_project_collaboration_sources (local_project_id,owner_id,team_id,shared_project_id,leader_device_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(projectId, accountId, TEAM, SHARED, HOST_DEVICE, new Date().toISOString(), new Date().toISOString());
  } else {
    data.prepare(`INSERT INTO mingle_project_collaboration_joins (invitation_id,local_project_id,account_id,team_id,shared_project_id,device_id)
      VALUES (?,?,?,?,?,?)`).run('example-join', projectId, accountId, TEAM, SHARED, deviceId);
    data.prepare(`INSERT INTO mingle_team_device_structures (shared_project_id,team_id,host_device_id,structure_json,version,received_at)
      VALUES (?,?,?,?,?,?)`).run(SHARED, TEAM, HOST_DEVICE, '{}', 1, new Date().toISOString());
  }

  let receive: ((envelope: any) => Promise<void>) | null = null;
  const outgoing: any[] = [];
  let networkAllowed = true;
  const keys = deviceId === HOST_DEVICE ? hostKeys : deviceId === MEMBER_DEVICE ? memberKeys : otherKeys;
  const peerDevice = deviceId === HOST_DEVICE ? MEMBER_DEVICE : HOST_DEVICE;
  const peerOwner = peerDevice === HOST_DEVICE ? HOST_ACCOUNT : MEMBER_ACCOUNT;
  const transport = {
    snapshot: () => ({
      deviceId, status: 'ready' as const, error: null,
      devices: [
        { id: HOST_DEVICE, teamId: TEAM, ownerId: HOST_ACCOUNT, name: 'Example host', revokedAt: null, status: 'online' },
        { id: MEMBER_DEVICE, teamId: TEAM, ownerId: MEMBER_ACCOUNT, name: 'Example member', revokedAt: null, status: 'online' },
        { id: OTHER_DEVICE, teamId: TEAM, ownerId: OTHER_ACCOUNT, name: 'Example other member', revokedAt: null, status: 'online' },
      ],
      links: [{ teamId: TEAM, deviceId, peerDeviceId: peerDevice, peerFingerprint: 'SHA-256:example', createdAt: new Date().toISOString(), mutual: true }],
    }),
    sync: async () => undefined,
    send: async (entry: any) => {
      if (!networkAllowed) throw new Error('Example peer is offline.');
      const envelope = { ...entry, id: randomUUID(), fromDeviceId: deviceId, toDeviceId: entry.toDeviceId };
      outgoing.push(envelope);
      return envelope.id;
    },
    signPayloadLocal: (teamId: string, expectedDeviceId: string, payload: string) => {
      if (teamId !== TEAM || expectedDeviceId !== deviceId) throw new Error('Unexpected signing authority.');
      return signDevicePayload(payload, keys);
    },
    signPayload: async (teamId: string, expectedDeviceId: string, payload: string) => {
      if (teamId !== TEAM || expectedDeviceId !== deviceId) throw new Error('Unexpected signing authority.');
      return signDevicePayload(payload, keys);
    },
    onMessage: (handler: (envelope: any) => Promise<void>) => { receive = handler; return () => { receive = null; }; },
  };
  const collaboration = {
    async snapshot() {
      if (role === 'member' && !memberActive) throw new Error('The active team membership is no longer available.');
      return {
        project: { teamId: TEAM, sharedProjectId: SHARED, name: 'Example shared coffee project', repositoryUrl: 'https://example.invalid/coffee.git' },
        members: [
          { accountId: HOST_ACCOUNT, displayName: 'Example host', email: null, role: 'leader', status: 'active' },
          ...(memberActive ? [{ accountId: MEMBER_ACCOUNT, displayName: 'Example member', email: null, role: 'member', status: 'active' as const }] : []),
          { accountId: OTHER_ACCOUNT, displayName: 'Example other member', email: null, role: 'member', status: 'active' },
        ],
        agents: [], invitations: [], email: { configured: false },
      };
    },
  };
  const account = {
    snapshot() { return { status: 'signed-in', user: { id: accountId, name: accountId === HOST_ACCOUNT ? 'Example host' : 'Example member' } }; },
    async withAuthenticatedClient<T>(work: (client: SupabaseClient, user: User) => Promise<T>) {
      const user = { id: accountId, email: 'member@example.invalid', aud: 'authenticated', created_at: '2026-01-01T00:00:00Z', app_metadata: {}, user_metadata: {} } as unknown as User;
      return work(cloudClient(), user);
    },
  };
  const distributed = {
    transport,
    async authorizeTeam() { if (!networkAllowed) throw new Error('Example peer is offline.'); },
  };
  const service = new TeamChatService({ store, account: account as unknown as AccountService,
    distributed: distributed as unknown as DistributedWorkspaceService,
    collaboration: collaboration as unknown as ProjectCollaborationService });
  return {
    store, project, service, outgoing,
    async receive(envelope: any) { if (!receive) throw new Error('No receiver is registered.'); await receive(envelope); },
    setNetworkAllowed(value: boolean) { networkAllowed = value; },
    async close() { await service.close(); store.db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function sharedGroup(host: ReturnType<typeof node>): GroupSnapshot {
  const at = new Date().toISOString();
  const task = host.store.insertTask({ id: 'example-shared-task', projectId: host.project.id, title: 'Add order total', description: 'Example only', acceptanceCriteria: 'Example only', sessionId: null, dependsOn: [], status: 'review' });
  const session = host.store.insertSession({ id: 'example-private-session', projectId: host.project.id, name: 'Example private host agent', provider: 'claude', model: 'example-model', effort: 'high', policy: 'supervised', isolated: true, worktreePath: '/home/example/private/worktree', branch: 'example-private-branch' });
  const userRow = host.store.insertMessage({ sessionId: session.id, role: 'user', content: 'Example private provider prompt.' });
  host.store.insertRun({ id: 'example-shared-run', sessionId: session.id, userMessageId: userRow.id, provider: 'claude', model: 'example-model', startedAt: at });
  host.store.finishRun('example-shared-run', 'completed', 1000, at);
  const changes: RunChanges = {
    summary: { status: 'available', capturedAt: at, fileCount: 1, files: [{ path: 'src/order.ts', status: 'M', additions: 2, deletions: 1, binary: false }], additions: 2, deletions: 1, truncated: false, notices: [] },
    diff: 'example diff', diffTruncated: false,
  };
  host.store.setRunChanges('example-shared-run', changes);
  return {
    group: { id: 'example-shared-group', projectId: host.project.id, title: 'Example shared session', anchorSessionId: 'private-anchor', mode: 'orchestrated', orchestratorMemberId: 'lead-member', paused: false, pauseReason: null, maxParallel: 2, maxTurns: 80, maxHops: 6, createdAt: at, updatedAt: at },
    members: [
      { id: 'lead-member', groupId: 'example-shared-group', sessionId: 'private-anchor', handle: 'espresso-lead', role: 'orchestrator', joinedAt: at, removedAt: null },
      { id: 'worker-member', groupId: 'example-shared-group', sessionId: 'private-worker', handle: 'barista', role: 'worker', joinedAt: at, removedAt: null },
    ],
    messages: [
      { id: 'example-human-request', seq: 1, groupId: 'example-shared-group', senderMemberId: null, recipientMemberIds: ['lead-member'], kind: 'user', content: 'Add a total to each order row.', requestId: 'example-request', replyToId: null, sourceMessageId: null, sourceRunId: null, createdAt: at },
      { id: 'example-assignment', seq: 2, groupId: 'example-shared-group', senderMemberId: 'lead-member', recipientMemberIds: ['worker-member'], kind: 'assignment', content: 'Add an order total to each rendered order row.', requestId: 'example-request', replyToId: 'example-human-request', sourceMessageId: null, sourceRunId: null, createdAt: at },
    ],
    requests: [{ id: 'example-request', groupId: 'example-shared-group', messageId: 'example-human-request', plannerMemberId: 'lead-member', status: 'completed', turnsUsed: 2, createdAt: at, intent: 'normal' }],
    deliveries: [{ id: 'example-delivery', groupId: 'example-shared-group', requestId: 'example-request', messageId: 'example-assignment', memberId: 'worker-member', kind: 'assignment', status: 'completed', runId: 'example-shared-run', hop: 1, error: null, createdAt: at, updatedAt: at }],
    assignments: [{ id: 'example-assignment-record', groupId: 'example-shared-group', requestId: 'example-request', fromMemberId: 'lead-member', toMemberId: 'worker-member', taskId: task.id, deliveryId: 'example-delivery', scope: ['src/order.ts'], createdAt: at }],
  };
}

it('projects member-origin human mirror IDs only from the same bound shared project', async () => {
  const host = node({ projectId: HOST_PROJECT, accountId: HOST_ACCOUNT, deviceId: HOST_DEVICE, role: 'host' });
  try {
    const snapshot = sharedGroup(host);
    const session = host.store.insertSession({ projectId: HOST_PROJECT, name: 'Example lead', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: false, worktreePath: host.project.path, branch: null });
    const repo = new GroupRepo(host.store.db);
    repo.insertGroup({ ...snapshot.group, anchorSessionId: session.id });
    const insertChat = host.store.db.prepare(`INSERT INTO team_chat_messages
      (id,team_id,shared_project_id,author_json,body,mentions_json,created_at,delivery_state)
      VALUES (?,?,?,?,?,'[]',?,'sent')`);
    const ids = [
      ['member-human-source', SHARED, 'human'],
      ['other-project-source', 'other-shared-project', 'human'],
      ['agent-source', SHARED, 'agent'],
    ] as const;
    snapshot.messages = ids.map(([id, sharedProjectId, kind]) => {
      insertChat.run(id, TEAM, sharedProjectId, JSON.stringify({ kind }), 'Identical text is not identity.', snapshot.group.createdAt);
      return repo.insertMessage({ groupId: snapshot.group.id, senderMemberId: null, recipients: [], kind: 'user', content: 'Identical text is not identity.', clientMessageId: `teamchat-${id}` });
    });
    const view = projectGroupView(snapshot, host.store, 1);
    expect(view.messages.map((message) => message.sourceMessageId)).toEqual(['member-human-source', null, null]);
  } finally { await host.close(); }
});

it('publishes only bounded shared group routing, assignment, task, result and relative-change metadata to an active member', async () => {
  memberActive = true;
  const host = node({ projectId: HOST_PROJECT, accountId: HOST_ACCOUNT, deviceId: HOST_DEVICE, role: 'host' });
  const member = node({ projectId: MEMBER_PROJECT, accountId: MEMBER_ACCOUNT, deviceId: MEMBER_DEVICE, role: 'member' });
  try {
    host.service.setSharedGroupSnapshotProvider(async () => sharedGroup(host));
    await host.service.snapshot(HOST_PROJECT, { limit: 50 });
    const message = host.outgoing.find((envelope) => envelope.kind === 'teamchat.group-view');
    expect(message).toBeTruthy();
    await member.receive(message);

    const received = await member.service.snapshot(MEMBER_PROJECT, { limit: 50 });
    const view = received.groupView;
    expect(view).toMatchObject({
      group: { id: 'example-shared-group', mode: 'orchestrated' },
      routing: { mode: 'orchestrated', defaultRecipientHandles: ['espresso-lead'] },
      requests: [{ id: 'example-request', status: 'completed' }],
      assignments: [{ title: 'Add order total', taskStatus: 'review', toHandle: 'barista', scope: ['src/order.ts'] }],
      result: { status: 'review', changedPaths: ['src/order.ts'] },
    });
    expect(view?.messages.map((row) => row.kind)).toContain('assignment');
    expect(received.messages.some((row) => row.kind === 'group-view')).toBe(false);
    expect(JSON.stringify(view)).not.toContain('/home/example/private/worktree');
    expect(JSON.stringify(view)).not.toContain('example-private-session');

    const sameVersion = message.payload;
    const forgedView = { ...view!, version: view!.version + 1 };
    const body = (await import('./group-view.ts')).encodeGroupView(forgedView);
    const createdAt = new Date(Date.now() + 1000).toISOString();
    const source = sameVersion.source;
    const unsigned = TeamChatMessageSchema.parse({ ...sameVersion, id: `other-${randomUUID()}`, author: { kind: 'system', deviceId: OTHER_DEVICE, displayName: 'Mingle' }, body, createdAt,
      source, authorDeviceId: OTHER_DEVICE, authorSignature: 'x'.repeat(88), deliveryState: 'sent' });
    const signing = canonicalJson({
      domain: 'mingle-team-chat-message-v1', id: unsigned.id, teamId: unsigned.teamId, sharedProjectId: unsigned.sharedProjectId,
      author: { kind: 'system', deviceId: OTHER_DEVICE }, body: unsigned.body, mentions: unsigned.mentions,
      replyTo: unsigned.replyTo ?? null, createdAt: unsigned.createdAt, kind: 'group-view', source: unsigned.source ?? null, authorDeviceId: OTHER_DEVICE,
    });
    const forged = TeamChatMessageSchema.parse({ ...unsigned, authorSignature: signDevicePayload(signing, otherKeys) });
    await expect(member.receive({ id: randomUUID(), teamId: TEAM, fromDeviceId: OTHER_DEVICE, toDeviceId: MEMBER_DEVICE, kind: 'teamchat.group-view', payload: forged }))
      .rejects.toThrow(/registered project-host device/i);

    memberActive = false;
    await expect(member.receive(message)).rejects.toThrow(/active team membership/i);
    await expect(member.service.snapshot(MEMBER_PROJECT, { limit: 50 })).rejects.toThrow(/membership/i);
  } finally {
    memberActive = true;
    await Promise.all([host.close(), member.close()]);
  }
});

it('preserves request-level failed/interrupted outcomes even when recorded deliveries completed', async () => {
  const host = node({ projectId: HOST_PROJECT, accountId: HOST_ACCOUNT, deviceId: HOST_DEVICE, role: 'host' });
  try {
    const base = sharedGroup(host);
    for (const [requestStatus, expectedStatus] of [['failed', 'failed'], ['interrupted', 'stopped'], ['expired', 'unknown']] as const) {
      const snapshot = structuredClone(base) as unknown as GroupSnapshot;
      (snapshot.requests[0] as unknown as { status: string }).status = requestStatus;
      if (requestStatus === 'failed' || requestStatus === 'interrupted') {
        (snapshot.deliveries[0] as unknown as { status: string }).status = 'running';
      }
      const projected = projectGroupView(snapshot, host.store, 1);
      expect(projected.result?.status, `request status ${requestStatus}`).toBe(expectedStatus);
      expect(projected.result?.title).not.toBe('Team finished responding');
    }
    const completedWhilePaused = structuredClone(base) as unknown as GroupSnapshot;
    completedWhilePaused.group.paused = true;
    expect(projectGroupView(completedWhilePaused, host.store, 1).result?.status).toBe('review');
  } finally { await host.close(); }
});

it('preserves full Cowork routing and recipient metadata for the maximum 64-member group', async () => {
  const host = node({ projectId: HOST_PROJECT, accountId: HOST_ACCOUNT, deviceId: HOST_DEVICE, role: 'host' });
  try {
    const snapshot = sharedGroup(host);
    snapshot.group.mode = 'cowork';
    snapshot.group.orchestratorMemberId = null;
    for (let index = 2; index < 64; index++) {
      const original = snapshot.members[1]!;
      snapshot.members.push({ ...original, id: `worker-member-${index}`, handle: `barista-${index}` });
    }
    snapshot.messages[0]!.recipientMemberIds = snapshot.members.map((member) => member.id);
    const projected = projectGroupView(snapshot, host.store, 1);
    expect(projected.members).toHaveLength(64);
    expect(projected.routing.defaultRecipientHandles).toHaveLength(64);
    expect(projected.messages[0]?.recipientHandles).toHaveLength(64);
  } finally { await host.close(); }
});

it('bounds both compressed body size and inflated UTF-8 bytes while preserving latest routing and result', async () => {
  const host = node({ projectId: HOST_PROJECT, accountId: HOST_ACCOUNT, deviceId: HOST_DEVICE, role: 'host' });
  try {
    const snapshot = sharedGroup(host);
    const repeatedMultibyteText = '🧋'.repeat(1_500);
    const requestMessage = snapshot.messages[0]!;
    snapshot.messages = [requestMessage, ...Array.from({ length: 49 }, (_, index) => ({
      ...requestMessage, id: `maximum-history-${index}`, seq: index + 2, kind: 'status' as const,
      senderMemberId: 'worker-member', recipientMemberIds: [], content: repeatedMultibyteText,
    }))];
    const view = projectGroupView(snapshot, host.store, 1);
    expect(Buffer.byteLength(JSON.stringify(view), 'utf8')).toBeGreaterThan(160_000);

    const encoded = encodeGroupView(view);
    expect(encoded.length).toBeLessThanOrEqual(18_000);
    const prefix = 'team-group-view:v1:';
    const unpacked = inflateRawSync(Buffer.from(encoded.slice(prefix.length), 'base64'), { maxOutputLength: 160_000 });
    expect(unpacked.byteLength).toBeLessThanOrEqual(160_000);
    const decoded = decodeGroupView(encoded);
    expect(decoded.messages.length).toBeLessThan(50);
    expect(decoded.messages.at(-1)).toMatchObject({ id: 'maximum-history-48', content: repeatedMultibyteText });
    expect(decoded.routing).toEqual(view.routing);
    expect(decoded.result).toEqual(view.result);
  } finally { await host.close(); }
});

it('debounces group events, suppresses unchanged/feedback updates, backfills views for a later member, and clears pending work on close', async () => {
  memberActive = true;
  const host = node({ projectId: HOST_PROJECT, accountId: HOST_ACCOUNT, deviceId: HOST_DEVICE, role: 'host' });
  const member = node({ projectId: MEMBER_PROJECT, accountId: MEMBER_ACCOUNT, deviceId: MEMBER_DEVICE, role: 'member' });
  try {
    const snapshot = sharedGroup(host);
    host.service.setSharedGroupSnapshotProvider(async () => snapshot);
    await host.service.snapshot(HOST_PROJECT, { limit: 20 });
    const initialCount = host.outgoing.filter((entry) => entry.kind === 'teamchat.group-view').length;
    expect(initialCount).toBe(1);
    await host.service.snapshot(HOST_PROJECT, { limit: 20 });
    expect(host.outgoing.filter((entry) => entry.kind === 'teamchat.group-view')).toHaveLength(initialCount);

    snapshot.messages.push({ id: 'example-progress-update', seq: 3, groupId: snapshot.group.id, senderMemberId: 'worker-member', recipientMemberIds: [], kind: 'status',
      content: 'The example task is ready for review.', requestId: 'example-request', replyToId: null, sourceMessageId: null, sourceRunId: null, createdAt: new Date().toISOString() });
    host.store.recordEvent({ projectId: HOST_PROJECT, type: 'group.message.sent', summary: 'Example shared group changed', payload: { groupId: snapshot.group.id } });
    host.store.recordEvent({ projectId: HOST_PROJECT, type: 'group.delivery.completed', summary: 'Example shared delivery changed', payload: { groupId: snapshot.group.id } });
    await waitFor(() => host.outgoing.filter((entry) => entry.kind === 'teamchat.group-view').length > initialCount, 'one debounced group-view update');
    await new Promise((resolve) => setTimeout(resolve, 240));
    const updated = host.outgoing.filter((entry) => entry.kind === 'teamchat.group-view');
    expect(updated).toHaveLength(initialCount + 1);

    // The member has not received a direct update. Opening its team chat triggers the existing signed history backfill.
    const beforeBackfill = await member.service.snapshot(MEMBER_PROJECT, { limit: 20 });
    expect(beforeBackfill.groupView).toBeFalsy();
    await waitFor(() => member.outgoing.some((entry) => entry.kind === 'teamchat.sync.request'), 'member history request');
    const request = member.outgoing.find((entry) => entry.kind === 'teamchat.sync.request')!;
    await host.receive(request);
    await waitFor(() => host.outgoing.some((entry) => entry.kind === 'teamchat.sync.response'), 'signed group-view backfill response');
    const response = host.outgoing.find((entry) => entry.kind === 'teamchat.sync.response')!;
    await member.receive(response);
    const afterBackfill = await member.service.snapshot(MEMBER_PROJECT, { limit: 20 });
    expect(afterBackfill.groupView?.messages.some((message) => message.id === 'example-progress-update')).toBe(true);

    // A hidden-view persistence event is team.chat.updated, not a group event, so it cannot loop into another publish.
    const deliveredCount = host.outgoing.filter((entry) => entry.kind === 'teamchat.group-view').length;
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(host.outgoing.filter((entry) => entry.kind === 'teamchat.group-view')).toHaveLength(deliveredCount);

    snapshot.messages.push({ id: 'example-close-pending', seq: 4, groupId: snapshot.group.id, senderMemberId: null, recipientMemberIds: [], kind: 'status',
      content: 'This update is intentionally cancelled by service close.', requestId: 'example-request', replyToId: null, sourceMessageId: null, sourceRunId: null, createdAt: new Date().toISOString() });
    host.store.recordEvent({ projectId: HOST_PROJECT, type: 'group.message.sent', summary: 'Pending update before close', payload: { groupId: snapshot.group.id } });
    await host.service.close();
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(host.outgoing.filter((entry) => entry.kind === 'teamchat.group-view')).toHaveLength(deliveredCount);
  } finally {
    await Promise.all([host.close(), member.close()]);
  }
});

it('seeds an idle existing group when the member opens history without a host read or a new group event', async () => {
  memberActive = true;
  const host = node({ projectId: HOST_PROJECT, accountId: HOST_ACCOUNT, deviceId: HOST_DEVICE, role: 'host' });
  const member = node({ projectId: MEMBER_PROJECT, accountId: MEMBER_ACCOUNT, deviceId: MEMBER_DEVICE, role: 'member' });
  try {
    const snapshot = sharedGroup(host);
    host.service.setSharedGroupSnapshotProvider(async () => snapshot);
    expect(host.outgoing).toHaveLength(0);
    expect((await member.service.snapshot(MEMBER_PROJECT, { limit: 20 })).groupView).toBeFalsy();
    await waitFor(() => member.outgoing.some((entry) => entry.kind === 'teamchat.sync.request'), 'member opening idle history');
    await host.receive(member.outgoing.find((entry) => entry.kind === 'teamchat.sync.request')!);
    const response = host.outgoing.find((entry) => entry.kind === 'teamchat.sync.response');
    expect(response?.payload.messages.some((message: { kind?: string }) => message.kind === 'group-view')).toBe(true);
    // Deliberately do not deliver the direct fan-out; the requested backfill
    // alone must contain the current authenticated routing and result records.
    await member.receive(response);
    expect((await member.service.snapshot(MEMBER_PROJECT, { limit: 20 })).groupView).toMatchObject({
      group: { id: snapshot.group.id }, routing: { defaultRecipientHandles: ['espresso-lead'] },
      result: { status: 'review' },
    });
  } finally { await Promise.all([host.close(), member.close()]); }
});

it('syncs member chat back to the host without relaying a received host-only view', async () => {
  memberActive = true;
  const host = node({ projectId: HOST_PROJECT, accountId: HOST_ACCOUNT, deviceId: HOST_DEVICE, role: 'host' });
  const member = node({ projectId: MEMBER_PROJECT, accountId: MEMBER_ACCOUNT, deviceId: MEMBER_DEVICE, role: 'member' });
  try {
    const snapshot = sharedGroup(host);
    host.service.setSharedGroupSnapshotProvider(async () => snapshot);
    await host.service.snapshot(HOST_PROJECT, { limit: 20 });
    await member.receive(host.outgoing.find((entry) => entry.kind === 'teamchat.group-view'));
    await member.service.send(MEMBER_PROJECT, { body: 'Example member reply after reconnect.', mentions: [] });
    await waitFor(() => host.outgoing.some((entry) => entry.kind === 'teamchat.sync.request'), 'host history request');
    await member.receive(host.outgoing.find((entry) => entry.kind === 'teamchat.sync.request'));
    const response = member.outgoing.find((entry) => entry.kind === 'teamchat.sync.response');
    expect(response?.payload.messages.some((message: { kind?: string }) => message.kind === 'group-view')).toBe(false);
    expect(response?.payload.messages.some((message: { body: string }) => message.body === 'Example member reply after reconnect.')).toBe(true);
    await host.receive(response);
    expect((await host.service.snapshot(HOST_PROJECT, { limit: 20 })).messages.some((message) => message.body === 'Example member reply after reconnect.')).toBe(true);
  } finally { await Promise.all([host.close(), member.close()]); }
});

it('recovers an unchanged view after failed fan-out through member-opened authenticated backfill without a host snapshot', async () => {
  memberActive = true;
  const host = node({ projectId: HOST_PROJECT, accountId: HOST_ACCOUNT, deviceId: HOST_DEVICE, role: 'host' });
  const member = node({ projectId: MEMBER_PROJECT, accountId: MEMBER_ACCOUNT, deviceId: MEMBER_DEVICE, role: 'member' });
  try {
    host.service.setSharedGroupSnapshotProvider(async () => sharedGroup(host));
    host.setNetworkAllowed(false);
    const failedFanout = await host.service.snapshot(HOST_PROJECT, { limit: 20 });
    expect(failedFanout.groupView).toBeTruthy();
    expect(host.outgoing.some((entry) => entry.kind === 'teamchat.group-view')).toBe(false);
    expect(host.store.db.prepare(`SELECT delivery_state FROM team_chat_messages WHERE source_session_id='team-group-view'`).get()).toEqual({ delivery_state: 'failed' });

    // Reconnect only the mailbox. No host GET/snapshot occurs after the first failed send.
    host.setNetworkAllowed(true);
    const memberSnapshot = await member.service.snapshot(MEMBER_PROJECT, { limit: 20 });
    expect(memberSnapshot.groupView).toBeFalsy();
    await waitFor(() => member.outgoing.some((entry) => entry.kind === 'teamchat.sync.request'), 'reconnected member backfill request');
    const request = member.outgoing.find((entry) => entry.kind === 'teamchat.sync.request')!;
    await host.receive(request);
    await waitFor(() => host.outgoing.some((entry) => entry.kind === 'teamchat.sync.response'), 'persisted view replay');
    const response = host.outgoing.find((entry) => entry.kind === 'teamchat.sync.response')!;
    await member.receive(response);
    const recovered = await member.service.snapshot(MEMBER_PROJECT, { limit: 20 });
    expect(recovered.groupView?.group.id).toBe('example-shared-group');
    expect(recovered.groupView?.assignments[0]?.title).toBe('Add order total');
    expect(host.outgoing.some((entry) => entry.kind === 'teamchat.group-view')).toBe(false);
  } finally {
    await Promise.all([host.close(), member.close()]);
  }
});
