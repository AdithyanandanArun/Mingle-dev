import { afterEach, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import type { AdapterEvent, GroupSnapshot, Provider, ProviderInfo, RunOptions } from '@mingle/contracts';
import { EXAMPLE_CONTRACT_SESSION_ID } from '../example.ts';
import { ProviderError, type DispatchAwareOptions } from '../providers/common.ts';
import { deferred, runGit, startTestApp, tmpDir, waitFor, type TestApp } from '../test-utils.ts';

const apps: TestApp[] = [];
const dataDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.cleanup();
  while (dataDirs.length) rmSync(dataDirs.pop()!, { recursive: true, force: true });
});

const available = (id: Provider, model: string): ProviderInfo => ({ id, name: id, available: true, version: 'fake', executable: `/fake/${id}`, reason: null,
  models: [{ id: model, name: model, policies: ['supervised', 'full-access'], reasoningEfforts: [{ id: 'high', label: 'High' }] }], policies: ['supervised', 'full-access'] });

async function createLocalGroup(t: TestApp, mode: 'current-leads' | 'orchestrated' = 'current-leads', count = 1, extraProviders: Provider[] = ['claude', 'opencode']) {
  t.fake.detectProviders = async () => [available('claude', 'claude-sonnet-5-5'), available('codex', 'gpt-5-codex'), available('opencode', 'opencode-model')];
  await t.api('POST', '/api/providers/refresh', {});
  await t.api('PATCH', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}`, { provider: 'claude', model: 'claude-sonnet-5-5' });
  const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
    sessionId: EXAMPLE_CONTRACT_SESSION_ID, mode,
    agent: { handle: 'codex1', isolated: true, configuration: { provider: 'codex', model: 'gpt-5-codex', effort: 'high', policy: 'supervised', serviceTier: 'standard' } },
    ...(mode === 'orchestrated' ? { orchestrator: { provider: 'codex', model: 'gpt-5-codex', effort: 'high', policy: 'supervised', serviceTier: 'standard' } } : {}),
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const groupId = created.json.group.id;
  const workers = [created.json.members.find((member) => member.role === 'worker')!];
  for (let index = 0; index < count - 1; index++) {
    const id: Provider = extraProviders[index] ?? 'opencode';
    const handle = id === 'claude' ? `claude${index + 2}` : id === 'codex' ? `codex${index + 2}` : `openagent${index + 1}`;
    const added = await t.api<GroupSnapshot>('POST', `/api/groups/${groupId}/agents`, {
      handle, isolated: true,
      configuration: { provider: id, model: id === 'claude' ? 'claude-sonnet-5-5' : id === 'codex' ? 'gpt-5-codex' : 'opencode-model', effort: 'high', policy: 'supervised', serviceTier: 'standard' },
    });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
    workers.push(added.json.members.find((member) => member.handle === handle)!);
  }
  return { groupId, group: created.json.group, members: created.json.members, workers };
}

async function assignTask(t: TestApp, groupId: string, sourceHandle: string,
  workerScript: (options: RunOptions, emit: (event: AdapterEvent) => void) => Promise<void>, objective = 'Record the current source state.') {
  t.fake.script = async (options, emit) => {
    if (options.session.id !== EXAMPLE_CONTRACT_SESSION_ID) return workerScript(options, emit);
    const delivery = t.app.groups.get(groupId).deliveries.find((row) => row.status === 'running' && row.kind === 'request');
    if (!delivery) { emit({ type: 'text', text: 'Coordinator result complete.' }); return; }
    const context = t.app.groups.contextForRun(options.session.id, delivery.runId!)!;
    t.app.groups.assign(context, {
      recipient: sourceHandle, title: 'Inspect existing file', objective,
      acceptanceCriteria: 'Keep the change isolated to source-only.txt.', scope: ['source-only.txt'], dependsOn: [], inputArtifacts: [],
    });
    emit({ type: 'text', text: 'Assignment created.' });
  };
  const sent = await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Inspect the repository state.' });
  expect(sent.status).toBe(202);
}

it('automatically reassigns a Full-access quota failure to another provider with branch, commit and partial text', async () => {
  const t = await startTestApp(); apps.push(t);
  const group = await createLocalGroup(t, 'current-leads', 3, ['claude', 'codex']);
  const source = group.workers[0]!;
  const target = group.workers.find((member) => member.handle === 'claude2')!;
  await t.api('PATCH', `/api/groups/${group.groupId}`, { autonomy: { mode: 'extended' } });
  let targetPrompt = '';
  let sourceCommitted = false;
  const workerScript = async (options: RunOptions, emit: (event: AdapterEvent) => void) => {
    if (options.session.id === source.sessionId) {
      emit({ type: 'text', text: 'Partial implementation notes from the failed run.' });
      if (!sourceCommitted) {
        writeFileSync(`${options.session.worktreePath}/source-only.txt`, 'committed worker progress\n');
        runGit(options.session.worktreePath, 'add', 'source-only.txt');
        runGit(options.session.worktreePath, 'commit', '-m', 'record worker progress');
        sourceCommitted = true;
      }
      (options as typeof options & DispatchAwareOptions).onDispatchState?.('dispatched');
      throw new ProviderError('Account quota exhausted.', { code: 'quota_exhausted', outcomeKnown: true });
    }
    if (options.session.id === target.sessionId) { targetPrompt = options.prompt; emit({ type: 'text', text: 'Continued from the failed worker commit.' }); return; }
    emit({ type: 'text', text: 'Unexpected member run.' });
  };
  await assignTask(t, group.groupId, source.handle, workerScript);
  try { await waitFor(() => t.fake.runs.some((run) => run.session.id === target.sessionId), 8000, 'Full-access fallback run'); }
  catch { throw new Error(JSON.stringify({ snapshot: t.app.groups.get(group.groupId), events: t.app.store.listEvents().filter((event) => event.payload.groupId === group.groupId), runs: t.fake.runs.map((run) => run.session.id) })); }
  const snapshot = t.app.groups.get(group.groupId);
  const fallback = t.app.store.listEvents().find((event) => event.type === 'group.delivery.auto-fallback' && event.payload.groupId === group.groupId);
  expect(fallback?.payload).toMatchObject({ fromMemberId: source.id, toMemberId: target.id, failureKind: 'quota_exhausted' });
  expect(targetPrompt).toContain('Committed local work: branch');
  expect(targetPrompt).toContain('cherry-pick');
  expect(targetPrompt).toContain('Partial implementation notes from the failed run.');
  expect(snapshot.assignments[0]).toMatchObject({ toMemberId: target.id, scope: ['source-only.txt'] });
  expect(snapshot.messages.some((message) => message.kind === 'status' && message.content.includes('reassigned'))).toBe(true);
  await waitFor(() => t.app.groups.get(group.groupId).requests.at(-1)?.status === 'completed', 5000, 'first request to settle');
  expect(t.app.groups.getMemberHealth(group.groupId).find((health) => health.memberId === source.id)).toMatchObject({ state: 'cooldown', reason: 'Provider quota exhausted' });
  const now = Date.now();
  let clockReads = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now + 16 * 60_000 + clockReads++);
  expect(t.app.groups.getMemberHealth(group.groupId).find((health) => health.memberId === source.id)?.state).not.toBe('cooldown');

  const reopenedProvider = group.workers.find((member) => member.handle === 'codex3')!;
  const secondFailureScript = async (options: RunOptions, emit: (event: AdapterEvent) => void) => {
    if (options.session.id === target.sessionId) {
      (options as typeof options & DispatchAwareOptions).onDispatchState?.('dispatched');
      throw new ProviderError('Account quota exhausted.', { code: 'quota_exhausted', outcomeKnown: true });
    }
    if (options.session.id === reopenedProvider.sessionId) { emit({ type: 'text', text: 'Codex provider cooldown expired.' }); return; }
  };
  await assignTask(t, group.groupId, target.handle, secondFailureScript, 'Continue after the first fallback.');
  await waitFor(() => t.fake.runs.some((run) => run.session.id === reopenedProvider.sessionId), 10_000, 'provider cooldown expiry fallback');
  expect(t.app.groups.get(group.groupId).assignments.at(-1)).toMatchObject({ toMemberId: reopenedProvider.id });
}, 20_000);

it('keeps supervised failures visible without automatically dispatching a replacement', async () => {
  const t = await startTestApp(); apps.push(t);
  const group = await createLocalGroup(t, 'current-leads', 2);
  const source = group.workers[0]!;
  const target = group.workers.find((member) => member.handle === 'claude2')!;
  const workerScript = async (options: RunOptions) => {
    if (options.session.id === source.sessionId) {
      (options as typeof options & DispatchAwareOptions).onDispatchState?.('dispatched');
      throw new ProviderError('Account quota exhausted.', { code: 'quota_exhausted', outcomeKnown: true });
    }
  };
  await assignTask(t, group.groupId, source.handle, workerScript as (options: RunOptions, emit: (event: AdapterEvent) => void) => Promise<void>);
  await waitFor(() => t.app.groups.get(group.groupId).deliveries.some((delivery) => delivery.memberId === source.id && delivery.status === 'failed'), 6000, 'supervised failure');
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(t.fake.runs.some((run) => run.session.id === target.sessionId)).toBe(false);
  expect(t.app.store.listEvents().some((event) => event.type === 'group.delivery.auto-fallback' && event.payload.groupId === group.groupId)).toBe(false);
}, 15_000);

it('persists provider cooldowns across restart and prunes them at their injected expiry time', async () => {
  const dir = tmpDir('mingle-group-cooldown-'); dataDirs.push(dir);
  let clock = Date.now();
  const before = await startTestApp({ dataDir: dir, keepData: true, groupNow: () => clock }); apps.push(before);
  const group = await createLocalGroup(before, 'current-leads', 2);
  const source = group.workers[0]!;
  await assignTask(before, group.groupId, source.handle, async (options) => {
    if (options.session.id === source.sessionId) {
      (options as typeof options & DispatchAwareOptions).onDispatchState?.('dispatched');
      throw new ProviderError('Account quota exhausted.', { code: 'quota_exhausted', outcomeKnown: true });
    }
});



  await waitFor(() => before.app.groups.get(group.groupId).deliveries.some((delivery) => delivery.memberId === source.id && delivery.status === 'failed'), 6000, 'quota failure cooldown');
  expect(before.app.groups.getMemberHealth(group.groupId).find((health) => health.memberId === source.id)).toMatchObject({
    state: 'cooldown', reason: 'Provider quota exhausted', until: new Date(clock + 15 * 60_000).toISOString(),
  });
  expect(before.app.store.db.prepare('SELECT group_id,member_id,provider,reason,until FROM group_provider_cooldowns').get()).toMatchObject({
    group_id: group.groupId, member_id: source.id, provider: 'codex', reason: 'Provider quota exhausted',
  });
  await before.cleanup(); apps.splice(apps.indexOf(before), 1);

  const restarted = await startTestApp({ dataDir: dir, keepData: true, groupNow: () => clock }); apps.push(restarted);
  expect(restarted.app.groups.getMemberHealth(group.groupId).find((health) => health.memberId === source.id)).toMatchObject({ state: 'cooldown', reason: 'Provider quota exhausted' });
  clock += 15 * 60_000 + 1;
  expect(restarted.app.groups.getMemberHealth(group.groupId).find((health) => health.memberId === source.id)?.state).not.toBe('cooldown');
  expect(restarted.app.store.db.prepare('SELECT COUNT(*) AS count FROM group_provider_cooldowns').get()).toEqual({ count: 0 });
}, 20_000);


it('allows adding another idle agent while an existing group delivery is running', async () => {
  const t = await startTestApp(); apps.push(t);
  const group = await createLocalGroup(t, 'current-leads', 2);
  const running = deferred<void>();
  const finish = deferred<void>();
  t.fake.script = async (_options, emit) => { running.resolve(); await finish.promise; emit({ type: 'text', text: 'Finished.' }); };
  await t.api('POST', `/api/groups/${group.groupId}/messages`, { content: 'Keep working while another agent is added.' });
  await running.promise;
  const added = await t.api<GroupSnapshot>('POST', `/api/groups/${group.groupId}/agents`, {
    handle: 'newagent', isolated: true,
    configuration: { provider: 'opencode', model: 'opencode-model', effort: 'high', policy: 'supervised', serviceTier: 'standard' },
  });
  expect(added.status, JSON.stringify(added.json)).toBe(201);
  expect(added.json.members.some((member) => member.handle === 'newagent' && member.role === 'worker')).toBe(true);
  expect(t.fake.runs).toHaveLength(1);
  finish.resolve();
});

it('replaces a failed Full-access coordinator using the best available worker', async () => {
  const t = await startTestApp(); apps.push(t);
  const group = await createLocalGroup(t, 'orchestrated', 3);
  await t.api('PATCH', `/api/groups/${group.groupId}`, { autonomy: { mode: 'extended' } });
  const coordinator = group.members.find((member) => member.role === 'orchestrator')!;
  const worker = group.workers.find((member) => member.handle === 'claude2')!;
  t.fake.script = async (options, emit) => {
    if (options.session.id === coordinator.sessionId) {
      (options as typeof options & DispatchAwareOptions).onDispatchState?.('dispatched');
      throw new ProviderError('Account quota exhausted.', { code: 'quota_exhausted', outcomeKnown: true });
    }
    emit({ type: 'text', text: 'Taking over coordination.' });
  };
  const sent = await t.api('POST', `/api/groups/${group.groupId}/messages`, { content: 'Continue the project work.' });
  expect(sent.status).toBe(202);
  try { await waitFor(() => t.app.groups.get(group.groupId).group.orchestratorMemberId === worker.id, 8000, 'coordinator replacement'); }
  catch { throw new Error(JSON.stringify({ snapshot: t.app.groups.get(group.groupId), events: t.app.store.listEvents().filter((event) => event.payload.groupId === group.groupId), runs: t.fake.runs.map((run) => run.session.id) })); }
  expect(t.app.store.listEvents().some((event) => event.type === 'group.coordinator.fallback' && event.payload.toMemberId === worker.id)).toBe(true);
}, 15_000);

it('pauses after two automatic task fallbacks and after a second stalled attempt', async () => {
  const t = await startTestApp(); apps.push(t);
  const group = await createLocalGroup(t, 'current-leads', 3);
  await t.api('PATCH', `/api/groups/${group.groupId}`, { autonomy: { mode: 'extended' } });
  const source = group.workers[0]!;
  const bySession = new Map(group.workers.map((member) => [member.sessionId, member]));
  const workerScript = async (options: RunOptions, emit: (event: AdapterEvent) => void) => {
    const member = bySession.get(options.session.id);
    if (!member) { emit({ type: 'text', text: 'Unexpected coordinator execution.' }); return; }
    if (member.id === source.id) {
      (options as typeof options & DispatchAwareOptions).onDispatchState?.('dispatched');
      throw new ProviderError('Account quota exhausted.', { code: 'quota_exhausted', outcomeKnown: true });
    }
    emit({ type: 'text', text: `Partial notes from ${member.handle}.` });
    (options as typeof options & DispatchAwareOptions).onDispatchState?.('dispatched');
    throw new ProviderError('Account quota exhausted.', { code: 'quota_exhausted', outcomeKnown: true });
  };
  await assignTask(t, group.groupId, source.handle, workerScript);
  await waitFor(() => t.app.groups.get(group.groupId).group.paused, 12_000, 'fallback limit blocker');
  expect(t.app.groups.get(group.groupId).group.pauseReason).toContain('2 automatic fallback limit');
  expect(t.app.store.listEvents().filter((event) => event.type === 'group.delivery.auto-fallback' && event.payload.groupId === group.groupId)).toHaveLength(2);

  const stallApp = await startTestApp(); apps.push(stallApp);
  const stallGroup = await createLocalGroup(stallApp, 'current-leads', 2);
  await stallApp.api('PATCH', `/api/groups/${stallGroup.groupId}`, { autonomy: { mode: 'extended' } });
  const stalledWorker = stallGroup.workers[0]!;
  const fallbackWorker = stallGroup.workers.find((member) => member.handle === 'claude2')!;
  let stallRuns = 0;
  const stallWorkerScript = async (options: RunOptions, emit: (event: AdapterEvent) => void) => {
    if (options.session.id === stalledWorker.sessionId) {
      stallRuns++;
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
      return;
    }
    if (options.session.id === fallbackWorker.sessionId) { emit({ type: 'text', text: 'Continued after two stalls.' }); return; }
  };
  await assignTask(stallApp, stallGroup.groupId, stalledWorker.handle, stallWorkerScript);
  await waitFor(() => stallRuns === 1, 6000, 'first stalled delivery');
  const future = Date.now() + 11 * 60_000;
  stallApp.app.groups.sweepStalledDeliveries(future);
  await waitFor(() => stallRuns === 2, 8000, 'one same-agent stall retry');
  expect(stallApp.app.store.listEvents().filter((event) => event.type === 'group.delivery.stalled')).toHaveLength(1);
  stallApp.app.groups.sweepStalledDeliveries(Date.now() + 22 * 60_000);
  await waitFor(() => stallApp.fake.runs.some((run) => run.session.id === fallbackWorker.sessionId), 10_000, 'fallback after stall retry');
  expect(stallApp.app.store.listEvents().filter((event) => event.type === 'group.delivery.stalled')).toHaveLength(2);
}, 35_000);

it('does not classify a delivery waiting on approval as stalled', async () => {
  const t = await startTestApp(); apps.push(t);
  const group = await createLocalGroup(t);
  const worker = group.workers[0]!;
  const runStarted = deferred<void>();
  t.fake.script = async (options) => {
    runStarted.resolve();
    await options.requestApproval({ tool: 'Bash', description: 'Run a command', input: { command: 'true' } });
  };
  const sent = await t.api('POST', `/api/groups/${group.groupId}/messages`, { content: 'Wait for human approval.', recipients: [worker.id] });
  expect(sent.status).toBe(202);
  await runStarted.promise;
  await waitFor(() => t.app.store.pendingApprovals(worker.sessionId).length > 0, 5000, 'pending approval');
  t.app.groups.sweepStalledDeliveries(Date.now() + 11 * 60_000);
  expect(t.app.store.listEvents().some((event) => event.type === 'group.delivery.stalled')).toBe(false);
}, 15_000);

it('resets the stall clock when a running command emits tool activity', async () => {
  const t = await startTestApp(); apps.push(t);
  const group = await createLocalGroup(t);
  const worker = group.workers[0]!;
  const runStarted = deferred<void>();
  const continueTool = deferred<void>();
  const finishRun = deferred<void>();
  t.fake.script = async (options, emit) => {
    if (options.session.id !== worker.sessionId) { emit({ type: 'text', text: 'Request completed.' }); return; }
    emit({ type: 'tool.activity', activity: { id: 'long-command', name: 'Bash', category: 'command', status: 'running', command: 'run a long check' } });
    runStarted.resolve();
    await continueTool.promise;
    emit({ type: 'tool.output', id: 'long-command', delta: 'Still working...' });
    await finishRun.promise;
  };
  const sent = await t.api('POST', `/api/groups/${group.groupId}/messages`, { content: 'Run the long check.', recipients: [worker.id] });
  expect(sent.status).toBe(202);
  await runStarted.promise;
  const startedAt = Date.now();
  t.app.groups.sweepStalledDeliveries(startedAt + 9 * 60_000);
  continueTool.resolve();
  await waitFor(() => t.app.store.bootstrapToolCalls(t.app.store.bootstrapRuns().map((run) => run.id)).some((tool) => tool.providerId === 'long-command' && tool.output.includes('Still working')), 5000, 'tool output activity');
  t.app.groups.sweepStalledDeliveries(startedAt + 11 * 60_000);
  expect(t.app.store.listEvents().some((event) => event.type === 'group.delivery.stalled')).toBe(false);
  finishRun.resolve();
  await waitFor(() => t.app.runtime.activeCount() === 0, 5000, 'long command run completion');
}, 15_000);
