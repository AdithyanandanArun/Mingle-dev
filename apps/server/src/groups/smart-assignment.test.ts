import { afterEach, expect, it } from 'vitest';
import type { AdapterEvent, GroupSnapshot, Provider, ProviderInfo, RunOptions } from '@mingle/contracts';
import { EXAMPLE_CONTRACT_SESSION_ID } from '../example.ts';
import { deferred, startTestApp, waitFor, type TestApp } from '../test-utils.ts';

const apps: TestApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

const available = (id: Provider, model: string): ProviderInfo => ({
  id, name: id, available: true, version: 'fake', executable: `/fake/${id}`, reason: null,
  models: [{ id: model, name: model, policies: ['supervised', 'full-access'], reasoningEfforts: [{ id: 'high', label: 'High' }] }],
  policies: ['supervised', 'full-access'],
});

async function createGroup(t: TestApp, workers: Array<{ handle: string; provider: Provider; model: string }> = [
  { handle: 'codex1', provider: 'codex', model: 'gpt-5-codex' }, { handle: 'openagent', provider: 'opencode', model: 'opencode-model' },
]) {
  t.fake.detectProviders = async () => [available('claude', 'claude-sonnet-5-5'), available('codex', 'gpt-5-codex'),
    available('opencode', 'opencode-model'), available('antigravity', 'gemini-3.8-flash')];
  await t.api('POST', '/api/providers/refresh', {});
  await t.api('PATCH', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}`, { provider: 'claude', model: 'claude-sonnet-5-5' });
  const [first, ...rest] = workers;
  if (!first) throw new Error('A worker is required');
  const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
    sessionId: EXAMPLE_CONTRACT_SESSION_ID, mode: 'current-leads',
    agent: { handle: first.handle, isolated: true, configuration: { provider: first.provider, model: first.model, effort: 'high', policy: 'supervised', serviceTier: 'standard' } },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const groupId = created.json.group.id;
  for (const { handle, provider, model } of rest) {
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
  let toolRoster: unknown;
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
      toolRoster = t.app.groups.members(context);
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
  const detailedWorker = (toolRoster as { members: Array<Record<string, unknown>> }).members.find((row) => row.handle === firstWorker.handle)!;
  expect(detailedWorker).toMatchObject({
    provider: 'codex', model: 'gpt-5-codex', effort: 'high', device: 'this device', load: { running: 0, queued: 2 },
    health: { state: 'ok' },
  });
  expect(detailedWorker.activeScopes).toEqual(expect.arrayContaining([
    expect.objectContaining({ paths: ['src/shared.ts'] }), expect.objectContaining({ paths: ['src/shared.ts'] }),
  ]));
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

it('auto-picks the current scope owner for continuity even when that member has a higher load', async () => {
  const t = await startTestApp(); apps.push(t);
  const { groupId, snapshot } = await createGroup(t, [
    { handle: 'claude2', provider: 'claude', model: 'claude-sonnet-5-5' }, { handle: 'codex1', provider: 'codex', model: 'gpt-5-codex' },
  ]);
  const lead = snapshot.members.find((member) => member.sessionId === EXAMPLE_CONTRACT_SESSION_ID)!;
  const continuityOwner = snapshot.members.find((member) => member.handle === 'claude2')!;
  const started = deferred<void>();
  const release = deferred<void>();
  let autoResult: unknown;
  let firstRequestId: string | null = null;
  t.fake.script = async (options: RunOptions, emit: (event: AdapterEvent) => void) => {
    if (options.session.id === continuityOwner.sessionId) {
      started.resolve();
      await release.promise;
      emit({ type: 'text', text: 'Continuity owner finished.' });
      return;
    }
    if (options.session.id !== EXAMPLE_CONTRACT_SESSION_ID) { emit({ type: 'text', text: 'Worker turn finished.' }); return; }
    const delivery = t.app.groups.get(groupId).deliveries.find((candidate) => candidate.memberId === lead.id && candidate.status === 'running');
    const context = delivery?.runId ? t.app.groups.contextForRun(options.session.id, delivery.runId) : undefined;
    if (context && delivery?.kind === 'request') {
      if (firstRequestId === null) {
        firstRequestId = context.requestId;
        t.app.groups.assign(context, assignment(continuityOwner.handle, 'existing source task'));
      } else if (context.requestId !== firstRequestId) {
        autoResult = t.app.groups.assign(context, { ...assignment('auto', 'continue source directory'), scope: ['src/next.ts'] });
      }
    }
    emit({ type: 'text', text: 'Coordinator turn finished.' });
  };

  expect((await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Start the source task.' })).status).toBe(202);
  await started.promise;
  expect((await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Continue nearby source work.' })).status).toBe(202);
  await waitFor(() => autoResult, 8_000, 'automatic continuity assignment');
  expect(autoResult).toMatchObject({ recipient: continuityOwner.handle, status: 'queued' });
  expect(autoResult).toMatchObject({ selection: expect.stringContaining(`Auto-picked @${continuityOwner.handle}: scope continuity in src`) });
  expect(t.app.store.listEvents().some((event) => event.type === 'group.assignment.auto-picked'
    && event.payload.memberId === continuityOwner.id && String(event.payload.reason).includes('scope continuity in src'))).toBe(true);
  release.resolve();
});

it('auto-pick skips held, cooldown and unavailable members and prefers a different running provider among equals', async () => {
  const t = await startTestApp(); apps.push(t);
  const { groupId, snapshot } = await createGroup(t, [
    { handle: 'claude2', provider: 'claude', model: 'claude-sonnet-5-5' },
    { handle: 'codex1', provider: 'codex', model: 'gpt-5-codex' },
    { handle: 'openagent', provider: 'opencode', model: 'opencode-model' },
    { handle: 'gemini1', provider: 'antigravity', model: 'gemini-3.8-flash' },
  ]);
  const lead = snapshot.members.find((member) => member.sessionId === EXAMPLE_CONTRACT_SESSION_ID)!;
  const held = snapshot.members.find((member) => member.handle === 'claude2')!;
  const cooled = snapshot.members.find((member) => member.handle === 'codex1')!;
  const unavailable = snapshot.members.find((member) => member.handle === 'openagent')!;
  const picked = snapshot.members.find((member) => member.handle === 'gemini1')!;
  t.app.groups.stopMember(groupId, held.id);
  const cooldowns = (t.app.groups as unknown as { providerCooldowns: Map<Provider, { until: number; reason: string; kind: string }> }).providerCooldowns;
  cooldowns.set('codex', { until: Date.now() + 60_000, reason: 'test cooldown', kind: 'quota_exhausted' });
  t.fake.detectProviders = async () => [available('claude', 'claude-sonnet-5-5'), available('codex', 'gpt-5-codex'),
    { ...available('opencode', 'opencode-model'), available: false, reason: 'test unavailable' }, available('antigravity', 'gemini-3.8-flash')];
  await t.api('POST', '/api/providers/refresh', {});

  let autoResult: unknown;
  t.fake.script = async (options: RunOptions, emit: (event: AdapterEvent) => void) => {
    if (options.session.id === EXAMPLE_CONTRACT_SESSION_ID) {
      const delivery = t.app.groups.get(groupId).deliveries.find((candidate) => candidate.memberId === lead.id && candidate.status === 'running');
      const context = delivery?.runId ? t.app.groups.contextForRun(options.session.id, delivery.runId) : undefined;
      if (context && delivery?.kind === 'request') autoResult = t.app.groups.assign(context, assignment('auto', 'choose available agent'));
    }
    emit({ type: 'text', text: 'Turn finished.' });
  };
  expect((await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Choose an available agent.' })).status).toBe(202);
  await waitFor(() => autoResult, 8_000, 'automatic assignment after eligibility filtering');
  expect(autoResult).toMatchObject({ recipient: picked.handle, status: 'queued' });
  expect(String((autoResult as { selection: string }).selection)).toContain(`Auto-picked @${picked.handle}`);
  expect([held, cooled, unavailable].every((member) => member.id !== picked.id)).toBe(true);
});

it('uses provider diversity to break equal-load automatic assignment ties', async () => {
  const t = await startTestApp(); apps.push(t);
  const { groupId, snapshot } = await createGroup(t, [
    { handle: 'claude2', provider: 'claude', model: 'claude-sonnet-5-5' }, { handle: 'codex1', provider: 'codex', model: 'gpt-5-codex' },
  ]);
  const lead = snapshot.members.find((member) => member.sessionId === EXAMPLE_CONTRACT_SESSION_ID)!;
  const preferred = snapshot.members.find((member) => member.handle === 'codex1')!;
  let autoResult: unknown;
  t.fake.script = async (options: RunOptions, emit: (event: AdapterEvent) => void) => {
    if (options.session.id === EXAMPLE_CONTRACT_SESSION_ID) {
      const delivery = t.app.groups.get(groupId).deliveries.find((candidate) => candidate.memberId === lead.id && candidate.status === 'running');
      const context = delivery?.runId ? t.app.groups.contextForRun(options.session.id, delivery.runId) : undefined;
      if (context && delivery?.kind === 'request') autoResult = t.app.groups.assign(context, assignment('auto', 'diverse task'));
    }
    emit({ type: 'text', text: 'Turn finished.' });
  };
  expect((await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Choose a diverse provider.' })).status).toBe(202);
  await waitFor(() => autoResult, 8_000, 'automatic provider-diverse assignment');
  expect(autoResult).toMatchObject({ recipient: preferred.handle, status: 'queued' });
  expect(String((autoResult as { selection: string }).selection)).toContain('provider diversity');
});
