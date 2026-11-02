import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { TeamMcpConnection } from '@mingle/contracts';
import type { GroupSnapshot, ProviderInfo } from '@mingle/contracts';
import { EXAMPLE_CLIENT_SESSION_ID } from '../example.ts';
import { FakeProviders, runGit, startTestApp, waitFor, type TestApp } from '../test-utils.ts';
import { writeFileSync } from 'node:fs';

const apps: TestApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

it('uses full-access native policy for local group runs only when the provider advertises it', async () => {
  const fake = new FakeProviders();
  const provider: ProviderInfo = { id: 'claude', name: 'Claude', available: true, version: 'fake', executable: '/fake/claude', reason: null,
    policies: ['supervised', 'full-access'], models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet', policies: ['supervised', 'full-access'],
      reasoningEfforts: [{ id: 'high', label: 'High' }], defaultReasoningEffort: 'high' }] };
  fake.detectProviders = async () => [provider];
  const t = await startTestApp({ fake });
  apps.push(t);
  await t.api('POST', '/api/providers/refresh', {});
  await t.api('PATCH', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}`, { provider: 'claude', model: 'claude-sonnet-5-5' });
  const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
    sessionId: EXAMPLE_CLIENT_SESSION_ID, mode: 'current-leads',
    agent: { handle: 'policy-worker', isolated: true, configuration: {
      provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard',
    } },
  });
  expect(created.status).toBe(201);
  await t.api('PATCH', `/api/groups/${created.json.group.id}`, { autonomy: { mode: 'extended' } });
  const worker = created.json.members.find((member) => member.role === 'worker')!;
  expect(t.app.store.getSession(worker.sessionId)?.policy).toBe('supervised');
  const observedPolicies: string[] = [];
  fake.script = async (options, emit) => { observedPolicies.push(options.session.policy); emit({ type: 'text', text: 'Done.' }); };

  const sent = await t.api('POST', `/api/groups/${created.json.group.id}/messages`, { content: 'Run with the group full-access policy.', recipients: [worker.id] });
  expect(sent.status).toBe(202);
  await waitFor(() => observedPolicies.length === 1 && t.app.runtime.activeCount() === 0, 10_000, 'full-access group run');

  expect(observedPolicies).toEqual(['full-access']);
  expect(t.app.store.getSession(worker.sessionId)?.policy).toBe('supervised');

  const limitedProvider: ProviderInfo = { ...provider, policies: ['supervised'], models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet', policies: ['supervised'],
    reasoningEfforts: [{ id: 'high', label: 'High' }], defaultReasoningEffort: 'high' }] };
  fake.detectProviders = async () => [limitedProvider];
  await t.api('POST', '/api/providers/refresh', {});
  const secondAnchor = await t.api<any>('POST', '/api/sessions', { projectId: t.app.store.getSession(EXAMPLE_CLIENT_SESSION_ID)!.projectId,
    name: 'Limited-policy integration', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: false });
  expect(secondAnchor.status).toBe(201);
  const limitedGroup = await t.api<GroupSnapshot>('POST', '/api/groups', {
    sessionId: secondAnchor.json.id, mode: 'current-leads',
    agent: { handle: 'limited-worker', isolated: true, configuration: {
      provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard',
    } },
  });
  expect(limitedGroup.status).toBe(201);
  await t.api('PATCH', `/api/groups/${limitedGroup.json.group.id}`, { autonomy: { mode: 'extended' } });
  const limitedWorker = limitedGroup.json.members.find((member) => member.role === 'worker')!;
  observedPolicies.length = 0;
  const limitedSent = await t.api('POST', `/api/groups/${limitedGroup.json.group.id}/messages`, { content: 'Keep the provider-native policy limit.', recipients: [limitedWorker.id] });
  expect(limitedSent.status).toBe(202);
  await waitFor(() => observedPolicies.length === 1 && t.app.runtime.activeCount() === 0, 10_000, 'provider-limited group run');
  expect(observedPolicies).toEqual(['supervised']);
});

async function callTeamTool(connection: TeamMcpConnection, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const client = new Client({ name: 'mingle-full-access-acceptance', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === 'text')?.text;
    if (result.isError) throw new Error(`${name} failed: ${text ?? 'no error details'}`);
    if (!text) return null;
    return JSON.parse(text);
  } finally { await client.close(); }
}

it('durably wakes a Full-access coordinator to accept a completed worker and integrate it without an approval callback', async () => {
  const fake = new FakeProviders();
  fake.detectProviders = async () => [{ id: 'claude', name: 'Claude', available: true, version: 'fake', executable: '/fake/claude', reason: null,
    policies: ['supervised', 'full-access'], models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet', policies: ['supervised', 'full-access'],
      reasoningEfforts: [{ id: 'high', label: 'High' }], defaultReasoningEffort: 'high' }] }];
  const t = await startTestApp({ fake });
  apps.push(t);
  await t.api('POST', '/api/providers/refresh', {});
  await t.api('PATCH', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}`, { provider: 'claude', model: 'claude-sonnet-5-5' });
  const integrationPath = t.app.store.getSession(EXAMPLE_CLIENT_SESSION_ID)!.worktreePath;
  runGit(integrationPath, 'config', 'user.name', 'Full access test');
  runGit(integrationPath, 'config', 'user.email', 'full-access-test@example.invalid');
  const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
    sessionId: EXAMPLE_CLIENT_SESSION_ID, mode: 'current-leads',
    agent: { handle: 'accept-worker', isolated: true, configuration: {
      provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard',
    } },
  });
  const groupId = created.json.group.id;
  await t.api('PATCH', `/api/groups/${groupId}`, { autonomy: { mode: 'extended' } });
  const worker = created.json.members.find((member) => member.role === 'worker')!;
  let taskId = '';
  let coordinatorRuns = 0;
  const observedPolicies: string[] = [];
  fake.script = async (options, emit) => {
    observedPolicies.push(options.session.policy);
    if (!options.teamMcp) throw new Error('The group run did not receive its Team MCP connection.');
    if (options.session.id === EXAMPLE_CLIENT_SESSION_ID) {
      coordinatorRuns++;
      if (coordinatorRuns === 1) {
        const assigned = await callTeamTool(options.teamMcp, 'team_assign', {
          recipient: worker.handle, title: 'Write an integrated marker', objective: 'Create marker.txt with the completed worker result.',
          acceptanceCriteria: 'marker.txt contains the worker result.', scope: ['marker.txt'],
        });
        taskId = assigned.taskId;
        emit({ type: 'text', text: 'Delegated the marker task; Mingle will wake me with its durable result.' });
        return;
      }
      if (!taskId || t.app.store.getTask(taskId)?.status !== 'review') throw new Error('The coordinator was not woken with the durable Review task.');
      const accepted = await callTeamTool(options.teamMcp, 'team_accept', {
        taskId, verificationSummary: 'Inspected marker.txt and verified it contains the expected worker result.',
      });
      if (accepted.status !== 'done') throw new Error('team_accept did not complete the verified task.');
      emit({ type: 'text', text: 'The verified worker result is integrated.' });
      return;
    }
    if (!taskId) throw new Error('The worker started before Mingle recorded its assignment.');
    await callTeamTool(options.teamMcp, 'team_status', { taskId, status: 'running' });
    const workerPath = options.session.worktreePath;
    writeFileSync(`${workerPath}/marker.txt`, 'completed worker result\n');
    runGit(workerPath, 'add', '--', 'marker.txt');
    runGit(workerPath, '-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'commit', '-m', 'Write marker');
    await callTeamTool(options.teamMcp, 'team_status', { taskId, status: 'review', note: 'The committed marker is ready for review.' });
    emit({ type: 'text', text: 'Committed marker.txt and left the assignment in Review.' });
  };

  const sent = await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Have a worker create marker.txt, review it, and integrate it.' });
  expect(sent.status).toBe(202);
  await waitFor(() => coordinatorRuns === 2 && t.app.runtime.activeCount() === 0, 10_000, 'coordinator acceptance follow-up');
  const finalTask = t.app.store.getTask(taskId);
  expect(finalTask?.status, JSON.stringify({ taskId, task: finalTask, group: t.app.groups.get(groupId), acceptances: t.app.store.db.prepare('SELECT * FROM group_assignment_acceptances').all() })).toBe('done');
  expect(observedPolicies).toEqual(['full-access', 'full-access', 'full-access']);
  expect(t.app.store.db.prepare('SELECT COUNT(*) AS count FROM approvals').get()).toEqual({ count: 0 });
  expect(t.app.store.db.prepare('SELECT verification_summary FROM group_assignment_acceptances WHERE assignment_id=(SELECT id FROM group_assignments WHERE task_id=?)')
    .get(taskId)).toMatchObject({ verification_summary: expect.stringContaining('Inspected marker.txt') });
  expect(runGit(integrationPath, 'show', 'HEAD:marker.txt')).toBe('completed worker result\n');
  expect(t.app.groups.get(groupId).requests[0]?.status).toBe('completed');
}, 30_000);
