import { afterEach, expect, it } from 'vitest';
import { EXAMPLE_CLIENT_SESSION_ID } from '../example.ts';
import { startTestApp, waitFor, type TestApp } from '../test-utils.ts';

const apps: TestApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

it('records push failures for the coordinator and sends remote workers a no-wake inbox notice', async () => {
  const t = await startTestApp(); apps.push(t);
  await t.api('POST', '/api/providers/refresh', {});
  const created = await t.api<any>('POST', '/api/groups', {
    sessionId: EXAMPLE_CLIENT_SESSION_ID, mode: 'current-leads',
    agent: { handle: 'notice-worker', isolated: true, configuration: {
      provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard',
    } },
  });
  expect(created.status).toBe(201);
  await t.api('PATCH', `/api/groups/${created.json.group.id}`, { autonomy: { mode: 'extended' } });
  const group = t.app.groups.get(created.json.group.id);
  const lead = group.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
  const worker = group.members.find((member) => member.id !== lead.id)!;
  const sharedProjectId = '30000000-0000-4000-8000-000000000099';
  t.app.store.db.prepare(`INSERT INTO mingle_team_proxy_sessions(session_id,team_id,shared_project_id,agent_id,owner_account_id,owner_device_id,handle)
    VALUES(?,?,?,?,?,?,?)`).run(worker.sessionId, '20000000-0000-4000-8000-000000000099', sharedProjectId,
    '10000000-0000-4000-8000-000000000099', '10000000-0000-4000-8000-000000000098', '40000000-0000-4000-8000-000000000099', worker.handle);
  t.fake.script = async (options, emit) => {
    const snapshot = t.app.groups.get(group.group.id);
    const member = snapshot.members.find((candidate) => candidate.sessionId === options.session.id)!;
    const delivery = snapshot.deliveries.find((candidate) => candidate.memberId === member.id && candidate.status === 'running')!;
    const context = t.app.groups.contextForRun(options.session.id, delivery.runId!)!;
    t.app.groups.recordIntegrationPublication(context, { branch: 'main', commitSha: 'a'.repeat(40), error: 'Origin rejected the push.' });
    const notified = t.app.groups.notifyIntegrationBranch(context, { branch: 'main', commitSha: 'a'.repeat(40) });
    expect(notified).toEqual([worker.handle]);
    emit({ type: 'text', text: 'The integration publication status was recorded.' });
  };

  expect((await t.api('POST', `/api/groups/${group.group.id}/messages`, { content: 'Record integration status.' })).status).toBe(202);
  await waitFor(() => t.app.runtime.activeCount() === 0, 10_000, 'integration status notice run');
  const snapshot = t.app.groups.get(group.group.id);
  const failure = snapshot.messages.find((message) => message.kind === 'status' && message.content.includes('Origin rejected the push.'));
  const notice = snapshot.messages.find((message) => message.kind === 'agent' && message.content.includes('Mingle will merge it into your branch'));
  expect(failure?.recipientMemberIds).toContain(lead.id);
  expect(notice).toMatchObject({ senderMemberId: lead.id, recipientMemberIds: [worker.id] });
  expect(t.app.store.db.prepare('SELECT COUNT(*) AS count FROM group_deliveries WHERE group_id=? AND member_id=? AND kind=?')
    .get(group.group.id, worker.id, 'message')).toEqual({ count: 0 });
  expect(t.app.store.listEvents().some((event) => event.type === 'group.integration.push-failed')).toBe(true);
  expect(t.app.store.listEvents().some((event) => event.type === 'group.integration.workers-notified'
    && event.payload.wakesWorkers === false)).toBe(true);
});
