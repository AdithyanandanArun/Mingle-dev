import { afterEach, describe, expect, it } from 'vitest';
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

async function createGroup(t: TestApp, autonomy: 'extended' | 'supervised') {
  const created = await t.api<any>('POST', '/api/groups', {
    sessionId: EXAMPLE_CLIENT_SESSION_ID,
    mode: 'current-leads',
    agent: { handle: 'retry-worker', isolated: true, configuration: {
      provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard',
    } },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const patched = await t.api('PATCH', `/api/groups/${created.json.group.id}`, { autonomy: { mode: autonomy } });
  expect(patched.status).toBe(200);
  return t.app.groups.get(created.json.group.id);
}

describe('full-access uncertain delivery recovery', () => {
  it('captures and acknowledges a checkpoint, then makes one inspect-before-retry continuation', async () => {
    const t = await boot();
    const group = await createGroup(t, 'extended');
    let calls = 0;
    t.fake.script = async (_options, emit) => {
      calls++;
      if (calls === 1) throw new Error('The provider stopped after dispatch; side effects may have completed.');
      emit({ type: 'text', text: 'I inspected the current state and continued only the unfinished work.' });
    };

    const accepted = await t.api('POST', `/api/groups/${group.group.id}/messages`, { content: 'Make a scoped change and verify it.' });
    expect(accepted.status).toBe(202);
    await waitFor(() => calls === 2 && t.app.runtime.activeCount() === 0 && !t.app.groups.get(group.group.id).deliveries.some((delivery) => delivery.status === 'running'), 10_000, 'the single automatic continuation to finish');

    const snapshot = t.app.groups.get(group.group.id);
    const original = snapshot.deliveries.find((delivery) => delivery.status === 'failed')!;
    const successor = snapshot.deliveries.find((delivery) => delivery.id === original.recoveredByDeliveryId);
    expect(successor).toMatchObject({ status: 'completed', kind: 'result' });
    expect(t.fake.runs).toHaveLength(2);
    expect(t.fake.runs[1]?.prompt).toMatch(/inspect the saved checkpoint and current workspace state first/i);
    const checkpoint = t.app.store.db.prepare(`SELECT state,kind,payload_json FROM group_recovery_checkpoints WHERE group_id=?`).get(group.group.id) as { state: string; kind: string; payload_json: string };
    expect(checkpoint).toMatchObject({ state: 'acknowledged', kind: 'automatic-retry' });
    expect(JSON.parse(checkpoint.payload_json)).toMatchObject({ deliveryId: original.id, outcomeUnknown: true });
    const events = t.app.store.listEvents().filter((event) => event.payload.groupId === group.group.id);
    expect(events.some((event) => event.type === 'group.checkpoint.acknowledged')).toBe(true);
    expect(events.filter((event) => event.type === 'group.recovery.auto-retry')).toHaveLength(1);
  }, 15_000);

  it('leaves supervised uncertain failures waiting for a person', async () => {
    const t = await boot();
    const group = await createGroup(t, 'supervised');
    t.fake.script = async () => { throw new Error('The provider stopped after dispatch; side effects may have completed.'); };

    const accepted = await t.api('POST', `/api/groups/${group.group.id}/messages`, { content: 'Make a scoped change and verify it.' });
    expect(accepted.status).toBe(202);
    await waitFor(() => t.app.runtime.activeCount() === 0 && t.app.groups.get(group.group.id).deliveries.some((delivery) => delivery.status === 'failed'), 10_000, 'the supervised failure to settle');

    const snapshot = t.app.groups.get(group.group.id);
    expect(t.fake.runs).toHaveLength(1);
    expect(snapshot.requests[0]?.status).toBe('paused');
    expect(snapshot.group.recoveryState?.status).toBe('degraded');
    expect(t.app.store.db.prepare('SELECT COUNT(*) AS count FROM group_recovery_checkpoints WHERE group_id=?').get(group.group.id)).toEqual({ count: 0 });
    expect(t.app.store.listEvents().some((event) => event.type === 'group.recovery.auto-retry')).toBe(false);
  }, 15_000);

  it('retries the same agent only once, then falls back to another member and pauses when none remain', async () => {
    const t = await boot();
    const group = await createGroup(t, 'extended');
    t.fake.script = async () => { throw new Error('The provider stopped after dispatch; side effects may have completed.'); };

    const accepted = await t.api('POST', `/api/groups/${group.group.id}/messages`, { content: 'Make a scoped change and verify it.' });
    expect(accepted.status).toBe(202);
    // A request is briefly paused between each failure and its automatic recovery; settle on the final fallback outcome.
    await waitFor(() => {
      const current = t.app.groups.get(group.group.id);
      return t.app.store.listEvents().some((event) => event.type === 'group.delivery.auto-fallback')
        && t.app.runtime.activeCount() === 0 && current.requests[0]?.status === 'paused'
        && current.deliveries.length === 3 && current.deliveries.every((delivery) => delivery.status === 'failed');
    }, 10_000, 'the retry and fallback to fail and the request to pause');

    const snapshot = t.app.groups.get(group.group.id);
    const events = t.app.store.listEvents();
    // Original turn, one inspect-first retry on the same agent, then one fallback to the remaining member.
    expect(t.fake.runs).toHaveLength(3);
    expect(events.filter((event) => event.type === 'group.recovery.auto-retry')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'group.delivery.auto-fallback')).toHaveLength(1);
    expect(snapshot.deliveries.filter((delivery) => delivery.status === 'failed')).toHaveLength(3);
    expect(new Set(snapshot.deliveries.map((delivery) => delivery.memberId)).size).toBe(2);
  }, 15_000);
});
