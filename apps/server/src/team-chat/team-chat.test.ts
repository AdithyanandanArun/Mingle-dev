import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { canonicalJson, generateDeviceKeyMaterial, signDevicePayload } from '../distributed/crypto.ts';
import { openDatabase } from '../db.ts';
import { Store } from '../store.ts';
import { SessionRuntime } from '../runtime.ts';
import { TaskService } from '../tasks.ts';
import { FakeProviders, makeRepo } from '../test-utils.ts';
import type { AccountService } from '../account/service.ts';
import type { DistributedWorkspaceService } from '../distributed/service.ts';
import type { ProjectCollaborationService } from '../project-collaboration/service.ts';
import { TeamChatService } from './service.ts';

const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const OTHER_ACCOUNT = '10000000-0000-4000-8000-000000000002';
const TEAM = '20000000-0000-4000-8000-000000000001';
const SHARED = '30000000-0000-4000-8000-000000000001';
const DEVICE = '40000000-0000-4000-8000-000000000001';
const PEER = '40000000-0000-4000-8000-000000000002';
const OTHER_DEVICE = '40000000-0000-4000-8000-000000000003';
const UNKNOWN_AGENT = '50000000-0000-4000-8000-000000000003';
const PROJECT = 'project-chat-test';

const DEVICE_KEYS = generateDeviceKeyMaterial();
const PEER_KEYS = generateDeviceKeyMaterial();
const OTHER_DEVICE_KEYS = generateDeviceKeyMaterial();

function cloudClient(): SupabaseClient {
  return {
    from(table: string) {
      const filters = new Map<string, unknown>();
      const builder: any = {
        select() { return builder; },
        eq(key: string, value: unknown) { filters.set(key, value); return builder; },
        is() { return builder; },
        in(key: string, value: unknown) { filters.set(key, value); return builder; },
        limit() { return builder; },
        maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) { return Promise.resolve({ data: rows(), error: null }).then(resolve, reject); },
      };
      const rows = () => {
        const id = filters.get('id');
        const userId = filters.get('user_id');
        if (table === 'mingle_devices') {
          const devices = [
            { id: DEVICE, owner_id: ACCOUNT, signing_public_key: DEVICE_KEYS.signingPublicKeyDer, encryption_public_key: DEVICE_KEYS.encryptionPublicKeyDer, fingerprint: DEVICE_KEYS.fingerprint, revoked_at: null },
            { id: PEER, owner_id: ACCOUNT, signing_public_key: PEER_KEYS.signingPublicKeyDer, encryption_public_key: PEER_KEYS.encryptionPublicKeyDer, fingerprint: PEER_KEYS.fingerprint, revoked_at: null },
            { id: OTHER_DEVICE, owner_id: OTHER_ACCOUNT, signing_public_key: OTHER_DEVICE_KEYS.signingPublicKeyDer, encryption_public_key: OTHER_DEVICE_KEYS.encryptionPublicKeyDer, fingerprint: OTHER_DEVICE_KEYS.fingerprint, revoked_at: null },
          ];
          if (Array.isArray(id)) return devices.filter((device) => id.includes(device.id));
          return devices.filter((device) => device.id === id);
        }
        if (table === 'mingle_projects') return filters.get('id') === SHARED && filters.get('team_id') === TEAM ? [{ id: SHARED }] : [];
        if (table === 'mingle_members') {
          const allowed = [ACCOUNT, OTHER_ACCOUNT];
          if (Array.isArray(userId)) return (userId as string[]).filter((value) => allowed.includes(value)).map((value) => ({ user_id: value }));
          return typeof userId === 'string' && allowed.includes(userId) ? [{ user_id: userId }] : [];
        }
        return [];
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

function fixture(withAgent = false) {
  const store = new Store(openDatabase(':memory:'));
  const projectPath = makeRepo();
  const project = store.insertProject({ id: PROJECT, name: 'Shared', path: projectPath });
  store.db.exec(`CREATE TABLE mingle_project_collaboration_sources (local_project_id TEXT,owner_id TEXT,team_id TEXT,shared_project_id TEXT,leader_device_id TEXT);
    CREATE TABLE mingle_project_collaboration_joins (local_project_id TEXT,account_id TEXT,team_id TEXT,shared_project_id TEXT,device_id TEXT);
    INSERT INTO mingle_project_collaboration_sources VALUES ('${PROJECT}','${ACCOUNT}','${TEAM}','${SHARED}','${DEVICE}');`);
  const session = withAgent ? store.insertSession({ projectId: project.id, name: 'Local agent', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: false, worktreePath: projectPath, branch: null }) : null;
  let receive: ((envelope: any) => Promise<void>) | null = null;
  const outgoing: Array<{ teamId: string; toDeviceId: string; kind: string; payload: unknown; idempotencyKey: string }> = [];
  let allowPeer = true;
  let transportGate: Promise<void> | null = null;
  const transportSnapshot = () => ({
    deviceId: DEVICE, status: 'ready' as const, error: null,
    devices: [
      { id: DEVICE, teamId: TEAM, ownerId: ACCOUNT, name: 'Local', revokedAt: null, status: 'online' },
      { id: PEER, teamId: TEAM, ownerId: ACCOUNT, name: 'Peer', revokedAt: null, status: 'online' },
    ],
    links: [{ teamId: TEAM, deviceId: DEVICE, peerDeviceId: PEER, peerFingerprint: 'SHA-256:peer', createdAt: new Date().toISOString(), mutual: true }],
  });
  const transport = {
    snapshot: () => transportSnapshot(),
    sync: async () => { if (transportGate) await transportGate; },
    send: async (entry: typeof outgoing[number]) => { outgoing.push(entry); return `envelope-${outgoing.length}`; },
    signPayloadLocal: (teamId: string, expectedDeviceId: string, payload: string) => {
      if (teamId !== TEAM || expectedDeviceId !== DEVICE) throw new Error('unexpected signing device');
      return signDevicePayload(payload, DEVICE_KEYS);
    },
    signPayload: async (teamId: string, expectedDeviceId: string, payload: string) => {
      if (teamId !== TEAM || expectedDeviceId !== DEVICE) throw new Error('unexpected signing device');
      return signDevicePayload(payload, DEVICE_KEYS);
    },
    onMessage: (handler: (envelope: any) => Promise<void>) => { receive = handler; return () => { receive = null; }; },
  };
  const fake = new FakeProviders();
  const runtime = new SessionRuntime(store, { broadcast() {} } as any, fake, new TaskService(store), () => undefined,
    { abortGraceMs: 250, flushIntervalMs: 10 });
  const collaboration = {
    async snapshot() {
      return {
        project: { teamId: TEAM, sharedProjectId: SHARED, name: 'Shared', repositoryUrl: 'https://example.test/team.git' },
        members: [
          { accountId: ACCOUNT, displayName: 'Ada', email: null, role: 'leader', status: 'active' },
          { accountId: OTHER_ACCOUNT, displayName: 'Sam', email: null, role: 'member', status: 'active' },
        ],
        agents: session ? [{ id: session.id, name: session.name, accountId: ACCOUNT, deviceId: DEVICE,
          projectId: PROJECT, sessionId: session.id, provider: session.provider, model: session.model, state: 'idle' }] : [],
        invitations: [], email: { configured: false },
      };
    },
  };
  const account = {
    snapshot() { return { status: 'signed-in', user: { id: ACCOUNT, name: 'Ada' } }; },
    async withAuthenticatedClient<T>(work: (client: SupabaseClient, user: User) => Promise<T>) {
      return work(cloudClient(), { id: ACCOUNT, email: 'ada@example.test', aud: 'authenticated', created_at: '2026-01-01T00:00:00Z', app_metadata: {}, user_metadata: { full_name: 'Ada' } } as unknown as User);
    },
  };
  const distributed = {
    transport,
    async authorizeTeam({ peerDeviceId }: { teamId: string; peerDeviceId?: string }) {
      if (!allowPeer || (peerDeviceId && peerDeviceId !== PEER)) throw new Error('inactive peer membership');
    },
  };
  const service = new TeamChatService({ store, account: account as unknown as AccountService,
    distributed: distributed as unknown as DistributedWorkspaceService,
    collaboration: collaboration as unknown as ProjectCollaborationService });
  return {
    store, project, session, service, outgoing, runtimeCalls: fake.runs, account, collaboration, distributed,
    receive: (envelope: any) => {
      if (!receive) throw new Error('No team chat transport listener');
      return receive(envelope);
    },
    setPeerAllowed(value: boolean) { allowPeer = value; },
    holdTransport(gate: Promise<void>) { transportGate = gate; },
    remoteMessage(message: Record<string, any>, deviceId = PEER, keys = PEER_KEYS): Record<string, any> {
      const author = message.author.kind === 'human'
        ? { kind: 'human', accountId: message.author.accountId }
        : { kind: 'agent', agentId: message.author.agentId, ownerAccountId: message.author.ownerAccountId };
      const payload = canonicalJson({
        domain: 'mingle-team-chat-message-v1', id: message.id, teamId: message.teamId,
        sharedProjectId: message.sharedProjectId, author, body: message.body, mentions: message.mentions,
        replyTo: message.replyTo ?? null, createdAt: message.createdAt, source: message.source ?? null,
        authorDeviceId: deviceId,
      });
      return { ...message, authorDeviceId: deviceId, authorSignature: signDevicePayload(payload, keys) };
    },
    async close() { await service.close(); await runtime.shutdown(); store.db.close(); rmSync(projectPath, { recursive: true, force: true }); },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const untilAt = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= untilAt) throw new Error('Timed out waiting for team-chat state.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it('fans out authenticated human messages, deduplicates by message ID, and rejects a revoked sender link', async () => {
  const f = fixture();
  try {
    const message = await f.service.send(PROJECT, { body: 'Shared note', mentions: [] });
    expect(message).toMatchObject({ author: { kind: 'human', accountId: ACCOUNT, displayName: 'Ada' }, deliveryState: 'sending' });
    expect(message.authorDeviceId).toBe(DEVICE);
    expect(message.authorSignature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    await until(() => f.outgoing.some((entry) => entry.kind === 'teamchat.message'));
    expect(f.outgoing).toHaveLength(1);
    expect(f.outgoing[0]).toMatchObject({ kind: 'teamchat.message', toDeviceId: PEER });

    const received = f.remoteMessage({ ...message, id: randomUUID(), author: { kind: 'human', accountId: ACCOUNT, displayName: 'Forged display name' }, body: 'Peer authored note' });
    const envelope = { id: randomUUID(), teamId: TEAM, fromDeviceId: PEER, toDeviceId: DEVICE, kind: 'teamchat.message', payload: received };
    await f.receive(envelope);
    await f.receive({ ...envelope, id: randomUUID() });
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM team_chat_messages WHERE id=?').get(received.id)).toEqual({ n: 1 });
    expect(f.store.db.prepare('SELECT author_json FROM team_chat_messages WHERE id=?').get(received.id)).toEqual({
      author_json: JSON.stringify({ kind: 'human', accountId: ACCOUNT, displayName: 'Ada' }),
    });

    f.setPeerAllowed(false);
    const forged = f.remoteMessage({ ...received, id: randomUUID(), body: 'revoked sender message' });
    await expect(f.receive({ ...envelope, id: randomUUID(), payload: forged })).rejects.toThrow(/inactive peer/);
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM team_chat_messages WHERE body=?').get('revoked sender message')).toEqual({ n: 0 });
  } finally { await f.close(); }
});

it('returns from a human send before transport sync completes', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.holdTransport(gate);
  try {
    const response = await Promise.race([
      f.service.send(PROJECT, { body: 'Quick local acceptance', mentions: [] }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('The send waited on transport.')), 100)),
    ]);
    expect(response.deliveryState).toBe('sending');
  } finally { release(); await f.close(); }
});

it('accepts a team-chat message without waiting for account, collaboration, or mailbox network work', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const options = (f.service as unknown as { options: {
    account: AccountService; collaboration: ProjectCollaborationService;
  } }).options;
  const authenticated = options.account.withAuthenticatedClient.bind(options.account);
  const snapshot = options.collaboration.snapshot.bind(options.collaboration);
  options.account.withAuthenticatedClient = (async <T>(work: (client: SupabaseClient, user: User) => Promise<T>) => {
    await gate;
    return authenticated(work);
  }) as AccountService['withAuthenticatedClient'];
  options.collaboration.snapshot = (async (projectId: string) => {
    await gate;
    return snapshot(projectId);
  }) as ProjectCollaborationService['snapshot'];
  try {
    const accepted = await Promise.race([
      f.service.send(PROJECT, { body: 'Accepted locally first', mentions: [] }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('The team-chat send waited for network work.')), 100)),
    ]);
    expect(accepted.deliveryState).toBe('sending');
    expect(f.store.db.prepare('SELECT body FROM team_chat_messages WHERE id=?').get(accepted.id)).toEqual({ body: 'Accepted locally first' });
  } finally { release(); await f.close(); }
});

it('rejects forged backfill authors, unsolicited responses, and unrostered agent identities before persistence', async () => {
  const f = fixture();
  try {
    await f.service.snapshot(PROJECT, { limit: 100 });
    await until(() => f.outgoing.some((entry) => entry.kind === 'teamchat.sync.request'));
    const request = f.outgoing.find((entry) => entry.kind === 'teamchat.sync.request')!.payload as { requestId: string };
    const forgedBackfill = f.remoteMessage({
      id: randomUUID(), teamId: TEAM, sharedProjectId: SHARED,
      author: { kind: 'human', accountId: OTHER_ACCOUNT, displayName: 'Sam' }, body: 'Forged as another member',
      mentions: [], createdAt: new Date().toISOString(), deliveryState: 'sent', runState: null,
    }, OTHER_DEVICE, PEER_KEYS);
    const response = { sharedProjectId: SHARED, requestId: request.requestId, batchIndex: 0, batchCount: 1, messages: [forgedBackfill] };
    await expect(f.receive({ id: randomUUID(), teamId: TEAM, fromDeviceId: PEER, toDeviceId: DEVICE,
      kind: 'teamchat.sync.response', payload: response })).rejects.toThrow(/signature is invalid/);
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM team_chat_messages WHERE body=?').get('Forged as another member')).toEqual({ n: 0 });

    const validBackfill = f.remoteMessage({
      id: randomUUID(), teamId: TEAM, sharedProjectId: SHARED,
      author: { kind: 'human', accountId: ACCOUNT, displayName: 'Ignored peer value' }, body: 'Verified relayed history',
      mentions: [], createdAt: new Date().toISOString(), deliveryState: 'sent', runState: null,
    });
    await f.receive({ id: randomUUID(), teamId: TEAM, fromDeviceId: PEER, toDeviceId: DEVICE,
      kind: 'teamchat.sync.response', payload: { ...response, messages: [validBackfill] } });
    expect(f.store.db.prepare('SELECT author_json FROM team_chat_messages WHERE id=?').get(validBackfill.id)).toEqual({
      author_json: JSON.stringify({ kind: 'human', accountId: ACCOUNT, displayName: 'Ada' }),
    });

    const validPeerMessage = f.remoteMessage({
      id: randomUUID(), teamId: TEAM, sharedProjectId: SHARED,
      author: { kind: 'human', accountId: ACCOUNT, displayName: 'Peer supplied name' }, body: 'Unsolicited history',
      mentions: [], createdAt: new Date().toISOString(), deliveryState: 'sent', runState: null,
    });
    await expect(f.receive({ id: randomUUID(), teamId: TEAM, fromDeviceId: PEER, toDeviceId: DEVICE,
      kind: 'teamchat.sync.response', payload: { ...response, requestId: randomUUID(), messages: [validPeerMessage] } }))
      .rejects.toThrow(/not requested/);

    const fakeAgent = f.remoteMessage({
      id: randomUUID(), teamId: TEAM, sharedProjectId: SHARED,
      author: { kind: 'agent', agentId: UNKNOWN_AGENT, agentName: 'Pretend agent', ownerAccountId: ACCOUNT, provider: 'claude', model: 'claude-sonnet-5-5' },
      body: 'Agent impersonation', mentions: [], createdAt: new Date().toISOString(), deliveryState: 'sent', runState: null,
    });
    await expect(f.receive({ id: randomUUID(), teamId: TEAM, fromDeviceId: PEER, toDeviceId: DEVICE,
      kind: 'teamchat.message', payload: fakeAgent })).rejects.toThrow(/not published/);
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM team_chat_messages WHERE body IN (?,?)')
      .get('Unsolicited history', 'Agent impersonation')).toEqual({ n: 0 });
  } finally { await f.close(); }
});

it('uses the published agent roster for agent metadata and enforces per-project history retention', async () => {
  const f = fixture(true);
  try {
    await f.service.snapshot(PROJECT, { limit: 100 });
    await until(() => f.outgoing.some((entry) => entry.kind === 'teamchat.sync.request'));
    const request = f.outgoing.find((entry) => entry.kind === 'teamchat.sync.request')!.payload as { requestId: string };
    const agent = f.session!;
    const signedFromRosterDevice = f.remoteMessage({
      id: randomUUID(), teamId: TEAM, sharedProjectId: SHARED,
      author: { kind: 'agent', agentId: agent.id, agentName: 'Forged agent name', ownerAccountId: ACCOUNT, provider: 'codex', model: 'forged-model' },
      body: 'Roster metadata wins', mentions: [], createdAt: new Date().toISOString(), deliveryState: 'sent', runState: 'completed',
    }, DEVICE, DEVICE_KEYS);
    await f.receive({ id: randomUUID(), teamId: TEAM, fromDeviceId: PEER, toDeviceId: DEVICE, kind: 'teamchat.sync.response',
      payload: { sharedProjectId: SHARED, requestId: request.requestId, batchIndex: 0, batchCount: 1, messages: [signedFromRosterDevice] } });
    expect(f.store.db.prepare('SELECT author_json FROM team_chat_messages WHERE id=?').get(signedFromRosterDevice.id)).toEqual({
      author_json: JSON.stringify({ kind: 'agent', agentId: agent.id, agentName: 'Local agent', ownerAccountId: ACCOUNT, provider: 'claude', model: 'claude-sonnet-5-5' }),
    });

    const seed = f.store.db.prepare(`INSERT INTO team_chat_messages
      (id,team_id,shared_project_id,author_json,body,mentions_json,created_at,delivery_state,run_state)
      VALUES (?,?,?,?,?,?,?,'sent',NULL)`);
    for (let index = 0; index < 10_000; index++) {
      seed.run(`quota-${String(index).padStart(5, '0')}`, TEAM, SHARED, JSON.stringify({ kind: 'human', accountId: ACCOUNT, displayName: 'Ada' }),
        'old retained record', '[]', new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString());
    }
    const newMessage = f.remoteMessage({
      id: randomUUID(), teamId: TEAM, sharedProjectId: SHARED,
      author: { kind: 'human', accountId: ACCOUNT, displayName: 'Ada' }, body: 'Within history quota', mentions: [],
      createdAt: new Date().toISOString(), deliveryState: 'sent', runState: null,
    });
    await f.receive({ id: randomUUID(), teamId: TEAM, fromDeviceId: PEER, toDeviceId: DEVICE, kind: 'teamchat.message', payload: newMessage });
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM team_chat_messages WHERE team_id=? AND shared_project_id=?').get(TEAM, SHARED)).toEqual({ n: 10_000 });
    expect(f.store.db.prepare('SELECT id FROM team_chat_messages WHERE id=?').get('quota-00000')).toBeUndefined();
  } finally { await f.close(); }
});

it('posts completed team-device agent replies once with this device’s signature and idempotent source identity', async () => {
  const f = fixture(true);
  try {
    const [first, concurrent] = await Promise.all([
      f.service.postAgentReply(PROJECT, f.session!.id, 'The isolated task is complete.', null, 'delivery-chat-reply-1'),
      f.service.postAgentReply(PROJECT, f.session!.id, 'The isolated task is complete.', null, 'delivery-chat-reply-1'),
    ]);
    expect(concurrent.id).toBe(first.id);
    const retry = await f.service.postAgentReply(PROJECT, f.session!.id, 'The isolated task is complete.', null, 'delivery-chat-reply-1');
    expect(first).toMatchObject({
      author: { kind: 'agent', agentId: f.session!.id, ownerAccountId: ACCOUNT },
      body: 'The isolated task is complete.', deliveryState: 'sent', runState: 'completed',
      authorDeviceId: DEVICE,
    });
    expect(first.authorSignature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(retry.id).toBe(first.id);
    expect(f.store.db.prepare(`SELECT COUNT(*) AS count FROM team_chat_messages WHERE source_session_id=? AND source_message_id LIKE 'team-delivery:%'`)
      .get(f.session!.id)).toEqual({ count: 1 });
    expect(f.outgoing.filter((message) => message.kind === 'teamchat.message')).toHaveLength(2);
    expect(f.outgoing[0]?.idempotencyKey).toContain(first.id);
  } finally { await f.close(); }
});

it('rate-limits repeated sync requests from the same peer device', async () => {
  const f = fixture();
  try {
    const makeRequest = () => ({ id: randomUUID(), teamId: TEAM, fromDeviceId: PEER, toDeviceId: DEVICE,
      kind: 'teamchat.sync.request', payload: { sharedProjectId: SHARED, requestId: randomUUID(), since: null } });
    await f.receive(makeRequest());
    await expect(f.receive(makeRequest())).resolves.toBeUndefined();
    expect(f.outgoing.filter((entry) => entry.kind === 'teamchat.sync.response')).toHaveLength(1);
  } finally { await f.close(); }
});

it('backfills bounded message batches without starting local runs from team-chat mentions', async () => {
  const f = fixture(true);
  try {
    const author = JSON.stringify({ kind: 'human', accountId: ACCOUNT, displayName: 'Ada' });
    const insert = f.store.db.prepare(`INSERT INTO team_chat_messages
      (id,team_id,shared_project_id,author_json,body,mentions_json,created_at,delivery_state,run_state,author_device_id,author_signature)
      VALUES (?,?,?,?,?,?,?,'sent',NULL,?,?)`);
    for (let index = 0; index < 205; index++) {
      const id = `backfill-${String(index).padStart(3, '0')}`;
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      const signed = f.remoteMessage({ id, teamId: TEAM, sharedProjectId: SHARED, author: JSON.parse(author), body: `History ${index}`,
        mentions: [], createdAt, deliveryState: 'sent', runState: null }, DEVICE, DEVICE_KEYS);
      insert.run(id, TEAM, SHARED, author, `History ${index}`, '[]', createdAt, DEVICE, signed.authorSignature);
    }
    await f.receive({ id: randomUUID(), teamId: TEAM, fromDeviceId: PEER, toDeviceId: DEVICE, kind: 'teamchat.sync.request',
      payload: { sharedProjectId: SHARED, requestId: randomUUID(), since: null } });
    const reply = f.outgoing.find((entry) => entry.kind === 'teamchat.sync.response');
    expect(reply).toBeTruthy();
    const response = reply!.payload as { messages: unknown[] };
    expect(response.messages).toHaveLength(200);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(180 * 1024);

    const agentId = f.session!.id;
    const humanMessage = await f.service.send(PROJECT, { body: 'Please check this for the team.', mentions: [agentId] });
    expect(humanMessage.runState).toBeNull();
    await until(() => f.outgoing.some((entry) => entry.kind === 'teamchat.message'));
    expect(f.runtimeCalls).toHaveLength(0);
    expect((f.store.db.prepare('SELECT run_state FROM team_chat_messages WHERE id=?').get(humanMessage.id) as { run_state: string | null }).run_state).toBeNull();
  } finally { await f.close(); }
});

it('routes enabled team-chat requests through the orchestration host and signs local orchestrator replies', async () => {
  const f = fixture(true);
  const routed: Array<{ projectId: string; message: { body: string; mentions: string[] } }> = [];
  f.service.setOrchestration({
    async routeTeamChatMessage(projectId, message) {
      routed.push({ projectId, message });
      return 'routed';
    },
  });
  await f.service.send(PROJECT, { body: 'Plan a small fix', mentions: [] });
  await until(() => routed.length === 1);
  expect(routed).toHaveLength(1);
  expect(routed[0]).toMatchObject({ projectId: PROJECT, message: { body: 'Plan a small fix', mentions: [] } });
  expect(f.runtimeCalls).toEqual([]);

  await f.service.postOrchestratedAgentReply({ projectId: PROJECT, sourceMessageId: 'human-source', agentId: f.session!.id, content: 'I found the change.' });
  const snapshot = await f.service.snapshot(PROJECT, { limit: 20 });
  const reply = snapshot.messages.find((message) => message.author.kind === 'agent');
  expect(reply).toMatchObject({ body: 'I found the change.', replyTo: 'human-source', authorDeviceId: DEVICE, runState: 'completed' });
  expect(reply?.author.kind === 'agent' && reply.author.agentId).toBe(f.session!.id);
});

it('reuses the saved remote completion reply after notification replay and keeps distinct deliveries separate', async () => {
  const f = fixture(true);
  f.service.setOrchestration({ async routeTeamChatMessage() { return 'routed'; } });
  try {
    const human = await f.service.send(PROJECT, { body: 'Review both remote task results.', mentions: [] });
    const reply = { projectId: PROJECT, sourceMessageId: human.id, agentId: f.session!.id, content: 'The task is ready for review.', deliveryId: 'example-remote-delivery-1' };
    await Promise.all([f.service.postOrchestratedAgentReply(reply), f.service.postOrchestratedAgentReply(reply)]);
    // A new service has no in-memory reply flight; its only replay evidence is the saved row.
    const restarted = new TeamChatService({ store: f.store, account: f.account as unknown as AccountService,
      distributed: f.distributed as unknown as DistributedWorkspaceService,
      collaboration: f.collaboration as unknown as ProjectCollaborationService });
    try {
      await restarted.postOrchestratedAgentReply(reply);
      await restarted.postOrchestratedAgentReply({ ...reply, deliveryId: 'example-remote-delivery-2' });
      await expect(restarted.postOrchestratedAgentReply({ ...reply, content: 'Changed result under the same identity.' })).rejects.toMatchObject({ status: 409 });
    } finally { await restarted.close(); }
    const replies = (await f.service.snapshot(PROJECT, { limit: 20 })).messages.filter((message) => message.author.kind === 'agent');
    expect(replies).toHaveLength(2);
    expect(new Set(replies.map((message) => message.source?.messageId)).size).toBe(2);
    expect(replies.every((message) => message.body === reply.content && message.replyTo === human.id)).toBe(true);
    expect(f.runtimeCalls).toHaveLength(0);
  } finally { await f.close(); }
});

it('routes authenticated member-device mentions and untagged messages into the shared group path', async () => {
  const f = fixture(true);
  try {
    const routed: Array<{ body: string; mentions: string[] }> = [];
    f.service.setOrchestration({
      async routeTeamChatMessage(_projectId, message) { routed.push({ body: message.body, mentions: message.mentions }); return 'handled'; },
    });
    const base = { teamId: TEAM, sharedProjectId: SHARED,
      author: { kind: 'human' as const, accountId: ACCOUNT, displayName: 'Ada' }, createdAt: new Date().toISOString(), deliveryState: 'sent' as const, runState: null };
    const mentioned = f.remoteMessage({ ...base, id: randomUUID(), body: '@local please inspect this', mentions: [f.session!.id] });
    const untagged = f.remoteMessage({ ...base, id: randomUUID(), body: 'Continue using the group mode', mentions: [] });
    await f.receive({ id: randomUUID(), teamId: TEAM, fromDeviceId: PEER, toDeviceId: DEVICE, kind: 'teamchat.message', payload: mentioned });
    await f.receive({ id: randomUUID(), teamId: TEAM, fromDeviceId: PEER, toDeviceId: DEVICE, kind: 'teamchat.message', payload: untagged });
    expect(routed).toEqual([
      { body: '@local please inspect this', mentions: [f.session!.id] },
      { body: 'Continue using the group mode', mentions: [] },
    ]);
    expect(f.runtimeCalls).toHaveLength(0);
  } finally { await f.close(); }
});

it('persists and fans out a mirrored team-session source message only once', async () => {
  const f = fixture(true);
  try {
    const input = { projectId: PROJECT, sessionId: f.session!.id, sourceMessageId: 'group-message-1', content: 'Lead request', kind: 'human' as const };
    const first = await f.service.mirrorTeamSessionMessage(input);
    const second = await f.service.mirrorTeamSessionMessage(input);
    const agentReply = await f.service.mirrorTeamSessionMessage({ ...input, sourceMessageId: 'group-run:run-1', content: 'Agent final reply', kind: 'agent' });
    await until(() => f.outgoing.some((entry) => entry.kind === 'teamchat.message' && (entry.payload as { id?: string }).id === first?.id)
      && f.outgoing.some((entry) => entry.kind === 'teamchat.message' && (entry.payload as { id?: string }).id === agentReply?.id));
    expect(first?.id).toBe(second?.id);
    expect(agentReply?.author).toMatchObject({ kind: 'agent', agentId: input.sessionId, ownerAccountId: ACCOUNT });
    expect(f.store.db.prepare(`SELECT COUNT(*) AS n FROM team_chat_messages WHERE source_session_id=? AND source_message_id=?`)
      .get(input.sessionId, input.sourceMessageId)).toEqual({ n: 1 });
    expect(f.store.db.prepare(`SELECT COUNT(*) AS n FROM team_chat_messages WHERE source_session_id=? AND source_message_id=?`)
      .get(input.sessionId, 'group-run:run-1')).toEqual({ n: 1 });
    expect(f.outgoing.filter((entry) => entry.kind === 'teamchat.message' && (entry.payload as { id?: string }).id === first?.id)).toHaveLength(1);
  } finally { await f.close(); }
});

it('recovers saved completed replies after a restart without rerunning the agent, and fences account/revocation changes', async () => {
  const f = fixture(true);
  try {
    f.setPeerAllowed(false);
    const message = await f.service.postAgentReply(PROJECT, f.session!.id, 'Saved result awaiting delivery', null, 'restart-result-1');
    expect(f.store.db.prepare('SELECT delivery_state FROM team_chat_messages WHERE id=?').get(message.id)).toEqual({ delivery_state: 'failed' });
    await f.service.close();
    f.store.db.prepare("UPDATE team_chat_messages SET delivery_state='sending' WHERE id=?").run(message.id);
    f.setPeerAllowed(true);
    const restarted = new TeamChatService({ store: f.store, account: f.account as unknown as AccountService,
      distributed: { transport: {
        snapshot: () => ({ deviceId: OTHER_DEVICE }),
        onMessage: () => () => undefined,
      }} as unknown as DistributedWorkspaceService,
      collaboration: f.collaboration as unknown as ProjectCollaborationService });
    // A different device must never replay output signed by the previous device.
    try { await restarted.retryPendingReplies(); } finally { await restarted.close(); }
    expect(f.outgoing).toHaveLength(0);
    // Reopen the original fixture service identity around the same durable store.
    const original = f.service as unknown as { options: ConstructorParameters<typeof TeamChatService>[0] };
    const recovered = new TeamChatService(original.options);
    try {
      const snapshot = f.account.snapshot;
      f.account.snapshot = () => ({ status: 'signed-in', user: { id: OTHER_ACCOUNT, name: 'Sam' } });
      await recovered.retryPendingReplies();
      expect(f.outgoing).toHaveLength(0);
      f.account.snapshot = snapshot;
      f.setPeerAllowed(false);
      await recovered.retryPendingReplies();
      expect(f.outgoing).toHaveLength(0);
      f.setPeerAllowed(true);
      await Promise.all([recovered.retryPendingReplies(), recovered.retryPendingReplies()]);
      expect(f.outgoing).toHaveLength(1);
      expect(f.outgoing[0]).toMatchObject({ payload: { id: message.id, body: message.body,
        authorSignature: message.authorSignature }, idempotencyKey: `chat:${message.id}:initial:${PEER}` });
      expect(f.store.db.prepare('SELECT delivery_state FROM team_chat_messages WHERE id=?').get(message.id)).toEqual({ delivery_state: 'sent' });
      await recovered.retryPendingReplies();
      expect(f.outgoing).toHaveLength(1);
      expect(f.runtimeCalls).toHaveLength(0);
    } finally { await recovered.close(); }
  } finally { await f.close(); }
});

it('delivers replies using known peers without waiting for an unrelated mailbox drain', async () => {
  const f = fixture(true);
  let release!: () => void;
  f.holdTransport(new Promise<void>(resolve => { release = resolve; }));
  try {
    await Promise.race([
      f.service.postAgentReply(PROJECT, f.session!.id, 'Reply reaches known peers', null, 'cached-peer-reply'),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Reply waited for full mailbox sync')), 500)),
    ]);
    expect(f.outgoing).toHaveLength(1);
  } finally { release(); await f.close(); }
});

it('advances recovery past newer ineligible replies instead of starving older eligible output', async () => {
  const f = fixture(true);
  try {
    f.setPeerAllowed(false);
    const saved = await f.service.postAgentReply(PROJECT, f.session!.id, 'An older eligible result', null, 'fair-recovery-result');
    const author = JSON.stringify({ ...saved.author, agentId: UNKNOWN_AGENT });
    const insert = f.store.db.prepare(`INSERT INTO team_chat_messages
      (id,team_id,shared_project_id,author_json,body,mentions_json,reply_to,created_at,delivery_state,run_state,author_device_id,author_signature)
      VALUES (?,?,?,?,?,'[]',NULL,?,'failed','completed',?,?)`);
    for (let i = 0; i < 32; i++) insert.run(randomUUID(), TEAM, SHARED, author, 'Unpublished agent result',
      new Date(Date.now() + 1000 + i).toISOString(), DEVICE, saved.authorSignature!);
    f.setPeerAllowed(true);
    await f.service.retryPendingReplies();
    expect(f.outgoing).toHaveLength(0);
    await f.service.retryPendingReplies();
    expect(f.outgoing).toHaveLength(1);
    expect(f.outgoing[0]!.payload).toMatchObject({ id: saved.id, body: saved.body });
    expect(f.runtimeCalls).toHaveLength(0);
  } finally { await f.close(); }
});
