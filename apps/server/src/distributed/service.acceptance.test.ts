import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { DatabaseSync as NativeDatabaseSync } from 'node:sqlite';
import { EXAMPLE_CLIENT_SESSION_ID } from '../example.ts';
import { startTestApp, waitFor, type TestApp } from '../test-utils.ts';
import type { RemoteExecutionProgress } from './execution.ts';
import { DistributedWorkspaceService } from './service.ts';

const apps: TestApp[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.cleanup();
});

it('preserves a completed recovery run when a later local run starts before the progress flush', async () => {
  const t = await startTestApp({ env: {} });
  apps.push(t);
  await t.app.providers.refresh();
  const events: RemoteExecutionProgress[] = [];
  const callbacks: Array<() => void> = [];
  const heldTimers: NodeJS.Timeout[] = [];
  const originalTimeout = globalThis.setTimeout;
  // Hold only the production progress coalescer; real HTTP, runtime and SQLite remain active.
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay !== 500) return Reflect.apply(originalTimeout, globalThis, [callback, delay, ...args]);
    callbacks.push(callback);
    const timer = originalTimeout(() => {}, 60_000);
    timer.unref();
    heldTimers.push(timer);
    return timer;
  }) as typeof setTimeout);
  const adapter = t.app.distributed as unknown as {
    subscribeProgress(id: string, listener: (event: RemoteExecutionProgress) => void): () => void;
  };
  const unsubscribe = adapter.subscribeProgress(EXAMPLE_CLIENT_SESSION_ID, (event) => events.push(event));
  try {
    t.fake.script = async (_options, emit) => { emit({ type: 'text', text: 'Approved recovery result' }); };
    const first = t.app.runtime.start(EXAMPLE_CLIENT_SESSION_ID, 'approved recovery');
    await waitFor(() => !t.app.runtime.isActive(EXAMPLE_CLIENT_SESSION_ID));
    t.fake.script = async (_options, emit) => { emit({ type: 'text', text: 'Later local result' }); };
    const second = t.app.runtime.start(EXAMPLE_CLIENT_SESSION_ID, 'later local work');
    await waitFor(() => !t.app.runtime.isActive(EXAMPLE_CLIENT_SESSION_ID));
    expect(first).not.toBe(second);
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!();
    expect(events).toContainEqual(expect.objectContaining({ runId: first, kind: 'result', status: 'completed', summary: 'Approved recovery result' }));
    expect(events.filter((event) => event.runId === first)).toHaveLength(1);
    // A repeated change notification cannot duplicate a terminal result.
    t.app.store.touch();
    callbacks.shift()?.();
    expect(events.filter((event) => event.runId === first)).toHaveLength(1);
  } finally {
    unsubscribe();
    for (const timer of heldTimers) clearTimeout(timer);
  }
});

it('delivers invalidation to connected browsers without exposing distributed payloads', async () => {
  const t = await startTestApp({ exampleWorkspace: false, env: {} });
  apps.push(t);
  const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws`, { origin: t.url });
  const received: unknown[] = [];
  ws.on('message', (message) => received.push(JSON.parse(message.toString())));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  try {
    t.app.store.touch();
    await waitFor(() => received.length > 0);
    expect(received).toEqual([{ type: 'state.changed' }]);
    expect(t.fake.runs).toEqual([]);
    const snapshot = await t.api('GET', '/api/distributed/snapshot');
    expect(snapshot.status).toBe(200);
    expect(snapshot.json.execution.requests).toEqual([]);
  } finally { ws.close(); }
});

it('cannot bypass remote owner authorization through the ordinary native approval HTTP route', async () => {
  const t = await startTestApp({ env: {} });
  apps.push(t);
  await t.app.providers.refresh();
  const decisions: boolean[] = [];
  t.fake.script = async (options) => {
    decisions.push(await options.requestApproval({ tool: 'Bash', description: 'Inspect disposable repository', input: { command: 'git status' } }));
  };
  const runId = t.app.runtime.start(EXAMPLE_CLIENT_SESSION_ID, 'test owner approval');
  const approval = await waitFor(() => t.app.store.pendingApprovals(EXAMPLE_CLIENT_SESSION_ID)[0]);
  // Seed a dispatched request at the durable integration boundary; no remote provider or cloud is used.
  const row = {
    id: 'remote-test', team_id: 'team-test', shared_project_id: 'shared-test', source_device_id: 'source-test',
    source_owner_id: 'source-owner', target_device_id: 'target-test', target_owner_id: 'target-owner', source_session_id: 'source-session',
    agent_id: 'agent-test', target_session_id: EXAMPLE_CLIENT_SESSION_ID, content: 'test', mode: 'provider-failure',
    evidence_json: '{}', target_config_digest: 'a'.repeat(64), request_digest: 'b'.repeat(64), state: 'dispatched', run_id: runId,
    idempotency_key: 'test-owner-approval', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  t.app.store.db.prepare(`INSERT INTO mingle_remote_requests (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`)
    .run(...Object.values(row));
  const response = await t.api('POST', `/api/approvals/${approval.id}`, { decision: 'approved' });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
  expect(t.app.store.getApproval(approval.id)?.status).toBe('pending');
  expect(decisions).toEqual([]);
  expect(t.app.runtime.isActive(EXAMPLE_CLIENT_SESSION_ID)).toBe(true);
  await t.app.runtime.interrupt(EXAMPLE_CLIENT_SESSION_ID);
  await waitFor(() => !t.app.runtime.isActive(EXAMPLE_CLIENT_SESSION_ID));
  expect(decisions).toEqual([false]);
});

it('rechecks delivery, owner consent, and exact terminal completion authority at the artifact receiver', async () => {
  const db = new NativeDatabaseSync(':memory:');
  const store = { db };
  try {
    store.db.exec(`CREATE TABLE mingle_team_host_projects(team_id TEXT,shared_project_id TEXT,host_device_id TEXT,owner_account_id TEXT);
      CREATE TABLE mingle_team_host_deliveries(delivery_id TEXT,team_id TEXT,shared_project_id TEXT,group_id TEXT,session_id TEXT,
        agent_id TEXT,owner_account_id TEXT,owner_device_id TEXT,status TEXT,run_id TEXT,failure_json TEXT);
      CREATE TABLE mingle_team_host_roster(team_id TEXT,shared_project_id TEXT,agent_id TEXT,removed_at TEXT);
      CREATE TABLE mingle_team_host_consents(team_id TEXT,shared_project_id TEXT,agent_id TEXT,state TEXT,owner_account_id TEXT,owner_device_id TEXT);`);
    store.db.prepare('INSERT INTO mingle_team_host_projects VALUES(?,?,?,?)').run('team-auth', 'project-auth', 'host-device', 'host-owner');
    store.db.prepare('INSERT INTO mingle_team_host_deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('delivery-auth', 'team-auth', 'project-auth', 'group-auth', 'session-auth', 'agent-auth', 'owner-auth', 'owner-device', 'running', 'run-auth', null);
    store.db.prepare('INSERT INTO mingle_team_host_roster VALUES(?,?,?,NULL)').run('team-auth', 'project-auth', 'agent-auth');
    store.db.prepare('INSERT INTO mingle_team_host_consents VALUES(?,?,?,?,?,?)')
      .run('team-auth', 'project-auth', 'agent-auth', 'granted', 'owner-auth', 'owner-device');
    const receiver = Object.create(DistributedWorkspaceService.prototype) as DistributedWorkspaceService;
    Object.assign(receiver, {
      options: { store }, transport: { snapshot: () => ({ deviceId: 'host-device' }) }, authorizeTeam: async () => undefined,
    });
    const authorize = Reflect.get(receiver, 'authorizeTeamArtifact').bind(receiver) as (input: Record<string, unknown>) => Promise<void>;
    const mcp = { teamId: 'team-auth', sharedProjectId: 'project-auth', deliveryId: 'delivery-auth', peerDeviceId: 'owner-device',
      direction: 'import', purpose: 'mcp', stage: 'bundle' };
    await expect(authorize(mcp)).resolves.toBeUndefined();
    store.db.prepare("UPDATE mingle_team_host_deliveries SET status='interrupted' WHERE delivery_id=?").run('delivery-auth');
    await expect(authorize(mcp)).rejects.toThrow(/delivery ended/i);
    store.db.prepare("UPDATE mingle_team_host_deliveries SET status='running' WHERE delivery_id=?").run('delivery-auth');
    store.db.prepare("UPDATE mingle_team_host_consents SET state='revoked' WHERE agent_id=?").run('agent-auth');
    await expect(authorize(mcp)).rejects.toThrow(/active owner device/i);
    store.db.prepare("UPDATE mingle_team_host_consents SET state='granted' WHERE agent_id=?").run('agent-auth');

    const terminal = { ...mcp, purpose: 'terminal', transferId: 'a'.repeat(64), revision: 'b'.repeat(40), path: 'out.ts', taskId: 'task-auth' };
    await expect(authorize({ ...terminal, stage: 'bundle' })).resolves.toBeUndefined();
    await expect(authorize({ ...terminal, stage: 'consume' })).rejects.toThrow(/not part of this delivery/);
    const completionIntent = { kind: 'team-completion', artifacts: [{ source: {
      transferId: terminal.transferId, revision: terminal.revision, path: terminal.path, taskId: terminal.taskId,
    } }] };
    store.db.prepare('UPDATE mingle_team_host_deliveries SET failure_json=? WHERE delivery_id=?')
      .run(JSON.stringify(completionIntent), 'delivery-auth');
    await expect(authorize({ ...terminal, stage: 'consume' })).resolves.toBeUndefined();
  } finally { db.close(); }
});
