import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import type { SessionPlan } from '@mingle/contracts';
import { EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { deferred, FakeProviders, startTestApp, tmpDir, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const dataDirs: string[] = [];
async function boot(dataDir: string, options: Parameters<typeof startTestApp>[0] = {}): Promise<TestApp> {
  const testApp = await startTestApp({ dataDir, keepData: true, ...options });
  apps.push(testApp);
  return testApp;
}
function dataDir(): string {
  const dir = tmpDir('mingle-session-resume-');
  dataDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
  while (dataDirs.length) rmSync(dataDirs.pop()!, { recursive: true, force: true });
});

function seedActiveRun(testApp: TestApp, options: { task?: boolean; startedAt?: string } = {}): { runId: string; taskId: string | null } {
  const store = testApp.app.store;
  const session = store.getSession(EXAMPLE_CONTRACT_SESSION_ID)!;
  const runId = randomUUID();
  const taskId = options.task ? randomUUID() : null;
  const startedAt = options.startedAt ?? new Date(Date.now() - 60_000).toISOString();
  store.tx(() => {
    store.updateSession(session.id, { status: 'running', provider: 'claude', model: 'claude-sonnet-5-5', providerSessionId: null });
    const userMessage = store.insertMessage({ sessionId: session.id, role: 'user', content: 'Please implement the saved request.' });
    store.insertRun({ id: runId, sessionId: session.id, userMessageId: userMessage.id, provider: 'claude', model: 'claude-sonnet-5-5', startedAt });
    if (taskId) store.insertTask({ id: taskId, projectId: session.projectId, title: 'Implement saved request', description: '', acceptanceCriteria: '', sessionId: session.id, dependsOn: [], status: 'running' });
    store.recordEvent({ projectId: session.projectId, sessionId: session.id, type: 'session.run.started', summary: 'Run started', payload: { runId, taskId } });
  });
  return { runId, taskId };
}

const resumeEvents = (testApp: TestApp) => testApp.app.store.listEvents().filter((event) => event.type === 'session.run.resumed' || event.type === 'session.run.resume-skipped');

describe('automatic session resume after restart', () => {
  it('starts one continuation, restores task linkage, and does not repeat it on a second restart', async () => {
    const dir = dataDir();
    const before = await boot(dir);
    const interrupted = seedActiveRun(before, { task: true });
    await before.cleanup();
    apps.splice(apps.indexOf(before), 1);

    const gate = deferred<void>();
    const resumed = await boot(dir);
    resumed.fake.script = async (_options, emit) => { await gate.promise; emit({ type: 'text', text: 'Continued from the existing files.' }); };
    await waitFor(() => resumed.fake.runs.length === 1, 5000, 'automatic continuation run');

    const options = resumed.fake.runs[0]!;
    expect(options.prompt).toContain('Continue the previous task');
    expect(options.session.providerSessionId).toBeNull();
    expect(options.prompt).toContain('Please implement the saved request.');
    const continuation = resumed.app.store.listMessages(EXAMPLE_CONTRACT_SESSION_ID).find((message) => message.kind === 'remote-recovery');
    expect(continuation?.content).toContain('Continue the previous task');
    expect(resumed.app.store.getTask(interrupted.taskId!)?.status).toBe('running');
    expect(resumeEvents(resumed)).toContainEqual(expect.objectContaining({ type: 'session.run.resumed', payload: expect.objectContaining({ interruptedRunId: interrupted.runId, taskId: interrupted.taskId }) }));
    gate.resolve();
    await waitFor(() => resumed.app.runtime.activeCount() === 0, 5000, 'continuation completion');
    expect(resumed.app.store.getTask(interrupted.taskId!)?.status).toBe('review');
    await resumed.cleanup();
    apps.splice(apps.indexOf(resumed), 1);

    const secondRestart = await boot(dir);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondRestart.fake.runs).toHaveLength(0);
    expect(secondRestart.app.store.db.prepare('SELECT state,attempts FROM session_resume_queue WHERE run_id=?').get(interrupted.runId)).toEqual({ state: 'resumed', attempts: 1 });
  });

  it('continues an interrupted, still-approved session plan through plan execution', async () => {
    const dir = dataDir();
    const before = await boot(dir);
    const interrupted = seedActiveRun(before);
    const session = before.app.store.getSession(EXAMPLE_CONTRACT_SESSION_ID)!;
    const generationMessage = before.app.store.insertMessage({ sessionId: session.id, role: 'user', content: 'Plan a small implementation.' });
    const generationRunId = randomUUID();
    const now = new Date().toISOString();
    before.app.store.insertRun({ id: generationRunId, sessionId: session.id, userMessageId: generationMessage.id, provider: 'claude', model: 'claude-sonnet-5-5', startedAt: now });
    before.app.store.finishRun(generationRunId, 'completed', 100, now);
    const plan: SessionPlan = {
      id: randomUUID(), sessionId: session.id, runId: generationRunId, provider: 'claude', providerPlanId: 'native-plan',
      explanation: 'Build the requested small feature.', steps: [{ id: 'step-one', providerId: null, title: 'Implement the feature', description: 'Inspect and edit the project.', acceptanceCriteria: ['The feature works.'], dependsOn: [], status: 'pending' }],
      revision: 1, approvedRevision: 1, status: 'executing', executionRunId: interrupted.runId, createdAt: now, updatedAt: now,
    };
    before.app.store.saveSessionPlan(plan);
    await before.cleanup();
    apps.splice(apps.indexOf(before), 1);

    const gate = deferred<void>();
    const restarted = await boot(dir);
    restarted.fake.script = async (_options, emit) => { await gate.promise; emit({ type: 'text', text: 'Plan continued.' }); };
    await waitFor(() => restarted.fake.runs.length === 1, 5000, 'approved plan continuation');
    expect(restarted.fake.runs[0]?.prompt).toContain('Execute this user-approved Mingle plan');
    expect(restarted.app.store.listMessages(session.id).some((message) => message.kind === 'plan-execution')).toBe(true);
    expect(restarted.app.store.listMessages(session.id).some((message) => message.kind === 'remote-recovery')).toBe(false);
    gate.resolve();
    await waitFor(() => restarted.app.runtime.activeCount() === 0, 5000, 'plan continuation completion');
    expect(restarted.app.store.listSessionPlans(session.id).find((saved) => saved.id === plan.id)?.status).toBe('completed');
  });

  it('does not resume a compaction-uncertain session without an active run record', async () => {
    const dir = dataDir();
    const before = await boot(dir);
    before.app.store.updateSession(EXAMPLE_CONTRACT_SESSION_ID, { status: 'running' });
    await before.cleanup();
    apps.splice(apps.indexOf(before), 1);

    const restarted = await boot(dir);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(restarted.fake.runs).toHaveLength(0);
    expect(restarted.app.store.listEvents().some((event) => event.type === 'session.compaction.interrupted')).toBe(true);
    expect(restarted.app.store.queuedSessionResumes()).toHaveLength(0);
  });

  it('does not start a continuation for a run that is older than 24 hours', async () => {
    const dir = dataDir();
    const before = await boot(dir);
    seedActiveRun(before, { startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
    await before.cleanup();
    apps.splice(apps.indexOf(before), 1);
    const restarted = await boot(dir);
    await waitFor(() => resumeEvents(restarted).some((event) => event.type === 'session.run.resume-skipped'));
    expect(resumeEvents(restarted).find((event) => event.type === 'session.run.resume-skipped')?.payload.reason).toBe('interrupted-run-expired');
    expect(restarted.fake.runs).toHaveLength(0);
  });

  it('does not run an owner-device team delivery without checking that the host still considers it live', async () => {
    const dir = dataDir();
    const before = await boot(dir);
    const interrupted = seedActiveRun(before);
    const now = new Date().toISOString();
    before.app.store.db.prepare(`INSERT INTO mingle_team_device_deliveries
      (delivery_id,shared_project_id,agent_id,session_id,request_json,status,run_id,created_at,updated_at)
      VALUES(?,?,?,?,?,'running',?,?,?)`).run(randomUUID(), randomUUID(), randomUUID(), EXAMPLE_CONTRACT_SESSION_ID, '{}', interrupted.runId, now, now);
    await before.cleanup();
    apps.splice(apps.indexOf(before), 1);

    const restarted = await boot(dir);
    await waitFor(() => resumeEvents(restarted).some((event) => event.type === 'session.run.resume-skipped'));
    expect(resumeEvents(restarted).find((event) => event.type === 'session.run.resume-skipped')?.payload.reason).toBe('team-owner-delivery-requires-live-host-check');
    expect(restarted.fake.runs).toHaveLength(0);
  });

  it('leaves a balanced group paused when automatic restart continuation is disabled', async () => {
    const dir = dataDir();
    const before = await boot(dir);
    await before.api('POST', '/api/providers/refresh', {});
    await before.api('PATCH', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}`, { provider: 'claude', model: 'claude-sonnet-5-5' });
    const created = await before.api('POST', '/api/groups', {
      sessionId: EXAMPLE_CONTRACT_SESSION_ID, mode: 'current-leads',
      agent: { handle: 'resume-worker', isolated: true, configuration: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard' } },
    });
    expect(created.status).toBe(201);
    before.app.store.updateSettings({ autoResumeOnRestart: false });
    before.fake.script = async (options, emit) => {
      await Promise.race([new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true })), new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
      if (!options.signal.aborted) emit({ type: 'text', text: 'Completed before restart.' });
    };
    expect((await before.api('POST', `/api/groups/${created.json.group.id}/messages`, { content: 'Continue the grouped implementation.' })).status).toBe(202);
    await waitFor(() => before.app.groups.get(created.json.group.id).deliveries.find((delivery) => delivery.status === 'running'));
    const interrupted = before.app.store.activeRuns()[0]!;
    await before.cleanup();
    apps.splice(apps.indexOf(before), 1);

    const restarted = await boot(dir);
    await waitFor(() => restarted.app.groups.get(created.json.group.id).deliveries.some((delivery) => delivery.status === 'interrupted'));
    const snapshot = restarted.app.groups.get(created.json.group.id);
    const delivery = snapshot.deliveries.find((row) => row.runId === interrupted.id);
    expect(delivery?.status).toBe('interrupted');
    if (!delivery) throw new Error('The interrupted group delivery was not retained.');
    expect(restarted.app.store.db.prepare('SELECT retryable FROM group_deliveries WHERE id=?').get(delivery.id)).toEqual({ retryable: 1 });
    expect(restarted.fake.runs).toHaveLength(0);
  });

  it('requeues one supervised group delivery after restart with an inspect-first continuation', async () => {
    const dir = dataDir();
    const before = await boot(dir);
    await before.api('POST', '/api/providers/refresh', {});
    await before.api('PATCH', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}`, { provider: 'claude', model: 'claude-sonnet-5-5' });
    const created = await before.api('POST', '/api/groups', {
      sessionId: EXAMPLE_CONTRACT_SESSION_ID, mode: 'current-leads',
      agent: { handle: 'supervised-resume-worker', isolated: true, configuration: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard' } },
    });
    expect(created.status).toBe(201);
    const groupId = (created.json as { group: { id: string } }).group.id;
    before.fake.script = async (options) => {
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
    };
    expect((await before.api('POST', `/api/groups/${groupId}/messages`, { content: 'Continue the supervised grouped implementation.' })).status).toBe(202);
    await waitFor(() => before.app.groups.get(groupId).deliveries.find((delivery) => delivery.status === 'running'));
    const interrupted = before.app.store.activeRuns()[0]!;
    await before.cleanup();
    apps.splice(apps.indexOf(before), 1);

    const restarted = await boot(dir);
    await waitFor(() => restarted.fake.runs.length === 1 && restarted.app.runtime.activeCount() === 0
      && !restarted.app.groups.get(groupId).deliveries.some((delivery) => delivery.status === 'running'), 10_000, 'supervised group continuation');
    const snapshot = restarted.app.groups.get(groupId);
    const original = snapshot.deliveries.find((delivery) => delivery.runId === interrupted.id)!;
    const successor = snapshot.deliveries.find((delivery) => delivery.id === original.recoveredByDeliveryId);
    expect(original.status).toBe('interrupted');
    expect(successor).toMatchObject({ status: 'completed' });
    expect(restarted.fake.runs[0]?.prompt).toMatch(/inspect the saved recovery checkpoint and current state first/i);
    expect(restarted.app.store.listEvents().some((event) => event.type === 'group.delivery.resumed'
      && event.payload.interruptedDeliveryId === original.id)).toBe(true);
  }, 20_000);

  it('requeues one interrupted local group delivery after restart when the group is full access', async () => {
    const dir = dataDir();
    const before = await boot(dir);
    await before.api('POST', '/api/providers/refresh', {});
    await before.api('PATCH', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}`, { provider: 'claude', model: 'claude-sonnet-5-5' });
    const created = await before.api('POST', '/api/groups', {
      sessionId: EXAMPLE_CONTRACT_SESSION_ID, mode: 'current-leads',
      agent: { handle: 'auto-resume-worker', isolated: true, configuration: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard' } },
    });
    expect(created.status).toBe(201);
    await before.api('PATCH', `/api/groups/${created.json.group.id}`, { autonomy: { mode: 'extended' } });
    before.fake.script = async (options) => {
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
    };
    expect((await before.api('POST', `/api/groups/${created.json.group.id}/messages`, { content: 'Continue the grouped implementation.' })).status).toBe(202);
    await waitFor(() => before.app.groups.get(created.json.group.id).deliveries.find((delivery) => delivery.status === 'running'));
    const interrupted = before.app.store.activeRuns()[0]!;
    await before.cleanup();
    apps.splice(apps.indexOf(before), 1);

    const restarted = await boot(dir);
    await waitFor(() => restarted.fake.runs.length === 1 && restarted.app.runtime.activeCount() === 0
      && !restarted.app.groups.get(created.json.group.id).deliveries.some((delivery) => delivery.status === 'running'), 10_000, 'full-access group continuation');
    const snapshot = restarted.app.groups.get(created.json.group.id);
    const original = snapshot.deliveries.find((delivery) => delivery.runId === interrupted.id)!;
    const successor = snapshot.deliveries.find((delivery) => delivery.id === original.recoveredByDeliveryId);
    expect(original.status).toBe('interrupted');
    expect(successor).toMatchObject({ status: 'completed', kind: 'result' });
    expect(restarted.fake.runs[0]?.prompt).toMatch(/inspect the saved recovery checkpoint and current state first/i);
    expect(restarted.app.store.listEvents().some((event) => event.type === 'group.delivery.restart-retry')).toBe(true);
  }, 20_000);

  it('skips an archived session and records the reason', async () => {
    const dir = dataDir();
    const before = await boot(dir);
    seedActiveRun(before);
    await before.cleanup();
    apps.splice(apps.indexOf(before), 1);

    const detection = deferred<Awaited<ReturnType<FakeProviders['detectProviders']>>>();
    const fake = new FakeProviders();
    fake.detectProviders = async () => detection.promise;
    const restarted = await boot(dir, { fake });
    restarted.app.store.archiveSession(EXAMPLE_CONTRACT_SESSION_ID);
    detection.resolve([{
      id: 'claude', name: 'Claude', available: true, version: 'fake', executable: '/fake/claude', reason: null,
      models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet' }],
    }]);
    await waitFor(() => resumeEvents(restarted).some((event) => event.type === 'session.run.resume-skipped'));
    expect(restarted.fake.runs).toHaveLength(0);
    expect(resumeEvents(restarted).find((event) => event.type === 'session.run.resume-skipped')?.payload.reason).toBe('session-archived-or-missing');
  });

  it('skips when the provider is unavailable and when automatic resume is disabled', async () => {
    const unavailableDir = dataDir();
    const beforeUnavailable = await boot(unavailableDir);
    seedActiveRun(beforeUnavailable);
    await beforeUnavailable.cleanup();
    apps.splice(apps.indexOf(beforeUnavailable), 1);
    const unavailableFake = new FakeProviders();
    unavailableFake.detectProviders = async () => [];
    const unavailable = await boot(unavailableDir, { fake: unavailableFake });
    await waitFor(() => resumeEvents(unavailable).some((event) => event.type === 'session.run.resume-skipped'));
    expect(resumeEvents(unavailable).find((event) => event.type === 'session.run.resume-skipped')?.payload.reason).toBe('provider-unavailable');
    expect(unavailable.fake.runs).toHaveLength(0);

    const disabledDir = dataDir();
    const beforeDisabled = await boot(disabledDir);
    seedActiveRun(beforeDisabled);
    beforeDisabled.app.store.updateSettings({ autoResumeOnRestart: false });
    await beforeDisabled.cleanup();
    apps.splice(apps.indexOf(beforeDisabled), 1);
    const disabled = await boot(disabledDir);
    await waitFor(() => resumeEvents(disabled).some((event) => event.type === 'session.run.resume-skipped'));
    expect(resumeEvents(disabled).find((event) => event.type === 'session.run.resume-skipped')?.payload.reason).toBe('disabled-by-setting');
    expect(disabled.fake.runs).toHaveLength(0);
  });
});
