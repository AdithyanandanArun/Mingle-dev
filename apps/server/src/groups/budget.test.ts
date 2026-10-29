import { afterEach, describe, expect, it } from 'vitest';
import type { GroupSnapshot } from '@mingle/contracts';
import { EXAMPLE_CLIENT_SESSION_ID } from '../example.ts';
import { startTestApp, waitFor, type TestApp } from '../test-utils.ts';

const apps: TestApp[] = [];
const boot = async () => {
  const app = await startTestApp();
  apps.push(app);
  await app.api('POST', '/api/providers/refresh', {});
  return app;
};
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

async function group(t: TestApp, autonomy: 'extended' | 'supervised') {
  const created = await t.api<any>('POST', '/api/groups', {
    sessionId: EXAMPLE_CLIENT_SESSION_ID,
    mode: 'current-leads',
    agent: { handle: 'budget-worker', isolated: true, configuration: {
      provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard',
    } },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const updated = await t.api('PATCH', `/api/groups/${created.json.group.id}`, { maxTurns: 2, maxHops: 1, autonomy: { mode: autonomy } });
  expect(updated.status).toBe(200);
  return t.app.groups.get(created.json.group.id);
}

async function runAssignments(t: TestApp, snapshot: GroupSnapshot, maxRuns: number) {
  const lead = snapshot.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
  const worker = snapshot.members.find((member) => member.id !== lead.id)!;
  let taskNumber = 0;
  t.fake.script = async (options, emit) => {
    const active = t.app.groups.get(snapshot.group.id).deliveries.find((delivery) => delivery.status === 'running' && delivery.memberId === snapshot.members.find((member) => member.sessionId === options.session.id)?.id);
    if (!active?.runId) throw new Error('Budget fixture run is missing its group delivery');
    const context = t.app.groups.contextForRun(options.session.id, active.runId);
    if (!context) throw new Error('Budget fixture run has no group context');
    if (options.session.id === lead.sessionId && taskNumber < maxRuns) {
      taskNumber++;
      t.app.groups.assign(context, {
        recipient: worker.handle,
        title: `Budget task ${taskNumber}`,
        objective: `Make a bounded sample update for iteration ${taskNumber}.`,
        acceptanceCriteria: 'The requested scoped update is present.',
        scope: [`budget-${taskNumber}.txt`],
        dependsOn: [],
        inputArtifacts: [],
      });
    }
    emit({ type: 'text', text: `Turn ${t.fake.runs.length} finished.` });
  };
  const result = await t.api('POST', `/api/groups/${snapshot.group.id}/messages`, { content: 'Run a bounded sequence of worker assignments.' });
  expect(result.status).toBe(202);
  await waitFor(() => t.app.runtime.activeCount() === 0 && !t.app.groups.get(snapshot.group.id).deliveries.some((delivery) => delivery.status === 'running'), 15_000, 'group budget turns to settle');
}

describe('full-access group budgets', () => {
  it('extends request turn and hop limits for result review while supervised groups retain their configured hold', async () => {
    const autonomous = await boot();
    const autonomousGroup = await group(autonomous, 'extended');
    await runAssignments(autonomous, autonomousGroup, 1);

    const extended = autonomous.app.groups.get(autonomousGroup.group.id);
    expect(autonomous.fake.runs).toHaveLength(3);
    expect(extended.group.paused).toBe(false);
    expect(extended.group.maxTurns).toBe(2);
    expect(extended.group.maxHops).toBe(1);
    expect(extended.requests[0]).toMatchObject({ autoTurnLimit: 4, autoMaxHops: 2 });
    expect(autonomous.app.store.listEvents().filter((event) => event.type === 'group.budget.auto-extended')).toHaveLength(1);

    const supervised = await boot();
    const supervisedGroup = await group(supervised, 'supervised');
    await runAssignments(supervised, supervisedGroup, 1);

    const held = supervised.app.groups.get(supervisedGroup.group.id);
    expect(supervised.fake.runs).toHaveLength(2);
    expect(held.group.paused).toBe(true);
    expect(held.requests[0]?.autoTurnLimit).toBeUndefined();
    expect(supervised.app.store.listEvents().some((event) => event.type === 'group.budget.auto-extended')).toBe(false);
  }, 30_000);

  it('pauses at the hard four-times turn ceiling instead of extending without bound', async () => {
    const t = await boot();
    const created = await group(t, 'extended');
    await t.api('PATCH', `/api/groups/${created.group.id}`, { maxHops: 12 });
    await runAssignments(t, created, 8);

    const snapshot = t.app.groups.get(created.group.id);
    expect(t.fake.runs).toHaveLength(8);
    expect(snapshot.group.paused).toBe(true);
    expect(snapshot.requests[0]).toMatchObject({ status: 'paused', autoTurnLimit: 8 });
    expect(snapshot.group.pauseReason).toMatch(/hard full-access ceiling of 8 model turns/i);
    const extensions = t.app.store.listEvents().filter((event) => event.type === 'group.budget.auto-extended');
    expect(extensions.length).toBeGreaterThanOrEqual(2);
    expect(extensions.some((event) => (event.payload.turns as { to?: number } | undefined)?.to === 8)).toBe(true);
    expect(extensions.every((event) => ((event.payload.turns as { to?: number } | undefined)?.to ?? 0) <= 8)).toBe(true);
    expect(t.app.store.listEvents().some((event) => event.type === 'group.budget.exhausted')).toBe(true);
  }, 30_000);
});
