import { afterEach, expect, it } from 'vitest';
import type { AdapterEvent, GroupSnapshot, Provider, ProviderInfo, RunOptions } from '@mingle/contracts';
import { EXAMPLE_CONTRACT_SESSION_ID } from '../example.ts';
import { startTestApp, waitFor, type TestApp } from '../test-utils.ts';

const apps: TestApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

const available = (id: Provider, model: string): ProviderInfo => ({
  id, name: id, available: true, version: 'fake', executable: `/fake/${id}`, reason: null,
  models: [{ id: model, name: model, policies: ['supervised', 'full-access'], reasoningEfforts: [{ id: 'high', label: 'High' }] }],
  policies: ['supervised', 'full-access'],
});

async function createGroup(t: TestApp) {
  t.fake.detectProviders = async () => [available('claude', 'claude-sonnet-5-5'), available('codex', 'gpt-5-codex'), available('opencode', 'opencode-model')];
  await t.api('POST', '/api/providers/refresh', {});
  await t.api('PATCH', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}`, { provider: 'claude', model: 'claude-sonnet-5-5' });
  const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
    sessionId: EXAMPLE_CONTRACT_SESSION_ID, mode: 'current-leads',
    agent: { handle: 'codex1', isolated: true, configuration: { provider: 'codex', model: 'gpt-5-codex', effort: 'high', policy: 'supervised', serviceTier: 'standard' } },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const groupId = created.json.group.id;
  for (const [handle, provider, model] of [['openagent', 'opencode', 'opencode-model']] as const) {
    const added = await t.api<GroupSnapshot>('POST', `/api/groups/${groupId}/agents`, {
      handle, isolated: true, configuration: { provider, model, effort: 'high', policy: 'supervised', serviceTier: 'standard' },
    });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
  }
  return { groupId, snapshot: t.app.groups.get(groupId) };
}

function assignment(recipient: string, title: string) {
  return {
    recipient, title, objective: `Implement ${title}.`, acceptanceCriteria: 'Keep the change inside src/shared.ts.',
    scope: ['src/shared.ts'], dependsOn: [], inputArtifacts: [],
  };
}

it('rejects cross-member overlapping scopes, allows same-member queues, then releases a settled scope', async () => {
  const t = await startTestApp(); apps.push(t);
  const { groupId, snapshot } = await createGroup(t);
  const lead = snapshot.members.find((member) => member.sessionId === EXAMPLE_CONTRACT_SESSION_ID)!;
  const firstWorker = snapshot.members.find((member) => member.handle === 'codex1')!;
  const secondWorker = snapshot.members.find((member) => member.handle === 'openagent')!;
  expect(t.app.store.getSession(firstWorker.sessionId)?.worktreePath).not.toBe(t.app.store.getSession(secondWorker.sessionId)?.worktreePath);

  let firstRequestId: string | null = null;
  let conflictError = '';
  let settledScopeAssignment: unknown;
  t.fake.script = async (options: RunOptions, emit: (event: AdapterEvent) => void) => {
    if (options.session.id !== EXAMPLE_CONTRACT_SESSION_ID) { emit({ type: 'text', text: 'Worker turn finished.' }); return; }
    const current = t.app.groups.get(groupId).deliveries.find((delivery) => delivery.memberId === lead.id && delivery.status === 'running');
    const context = current?.runId ? t.app.groups.contextForRun(options.session.id, current.runId) : undefined;
    if (!context || current?.kind !== 'request') { emit({ type: 'text', text: 'Coordinator turn finished.' }); return; }
    if (firstRequestId === null) {
      firstRequestId = context.requestId;
      t.app.groups.assign(context, assignment(firstWorker.handle, 'first scoped task'));
      t.app.groups.assign(context, assignment(firstWorker.handle, 'second same-owner task'));
      try { t.app.groups.assign(context, assignment(secondWorker.handle, 'conflicting task')); }
      catch (error) { conflictError = error instanceof Error ? error.message : String(error); }
    } else if (context.requestId !== firstRequestId) {
      settledScopeAssignment = t.app.groups.assign(context, assignment(secondWorker.handle, 'task after scope release'));
    }
    emit({ type: 'text', text: 'Coordinator turn finished.' });
  };

  expect((await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Split the scoped work.' })).status).toBe(202);
  await waitFor(() => {
    const current = t.app.groups.get(groupId);
    return current.assignments.length === 2 && current.assignments.every((item) => current.deliveries.find((delivery) => delivery.id === item.deliveryId)?.status === 'completed');
  }, 8_000, 'both same-member assignments to finish');

  const firstSnapshot = t.app.groups.get(groupId);
  expect(firstSnapshot.assignments.map((item) => item.toMemberId)).toEqual([firstWorker.id, firstWorker.id]);
  const firstTaskId = firstSnapshot.assignments[0]!.taskId;
  expect(conflictError).toContain(`@${firstWorker.handle}`);
  expect(conflictError).toContain(firstTaskId);
  expect(conflictError).toContain('src/shared.ts');
  expect(conflictError).toContain('Assign this work to');
  const conflictEvent = t.app.store.listEvents().find((event) => event.type === 'group.assignment.scope-conflict');
  expect(conflictEvent?.payload).toMatchObject({
    requestingMemberId: lead.id, conflictingMemberId: firstWorker.id, taskId: firstTaskId, overlappingPaths: ['src/shared.ts', 'src/shared.ts'],
  });
  expect(JSON.stringify(conflictEvent?.payload)).not.toContain('Split the scoped work');

  for (const item of firstSnapshot.assignments) t.app.store.updateTask(item.taskId, { status: 'done' });
  expect((await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Continue with the next task.' })).status).toBe(202);
  await waitFor(() => Boolean(settledScopeAssignment), 8_000, 'new assignment after prior scope is settled');
  expect(settledScopeAssignment).toMatchObject({ recipient: secondWorker.handle, status: 'queued' });
});
