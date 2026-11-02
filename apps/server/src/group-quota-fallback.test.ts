import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { GroupSnapshot, ProviderInfo } from '@mingle/contracts';
import { ProviderError, type DispatchAwareOptions } from './providers/common.ts';
import { EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { startTestApp, waitFor, type TestApp } from './test-utils.ts';

let testApp: TestApp | undefined;
afterEach(async () => { await testApp?.cleanup(); testApp = undefined; });

it('captures dirty source references before sending quota fallback to an isolated target worktree', async () => {
  const t = testApp = await startTestApp();
  t.fake.detectProviders = async () => {
    const claude: ProviderInfo = { id: 'claude', name: 'Claude', available: true, version: 'fake', executable: '/fake/claude', reason: null, models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet', reasoningEfforts: ['low', 'medium', 'high'].map((id) => ({ id, label: id })), defaultReasoningEffort: 'high' }] };
    const codex: ProviderInfo = { id: 'codex', name: 'Codex', available: true, version: 'fake', executable: '/fake/codex', reason: null, models: [{ id: 'gpt-5-codex', name: 'Codex', reasoningEfforts: ['low', 'medium', 'high'].map((id) => ({ id, label: id })), defaultReasoningEffort: 'high' }] };
    return [claude, codex];
  };
  await t.api('POST', '/api/providers/refresh', {});
  expect((await t.api('PATCH', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}`, { provider: 'claude', model: 'claude-sonnet-5-5' })).status).toBe(200);
  const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
    sessionId: EXAMPLE_CONTRACT_SESSION_ID, mode: 'current-leads',
    agent: { handle: 'codex2', isolated: true, configuration: { provider: 'codex', model: 'gpt-5-codex', effort: 'high', policy: 'supervised', serviceTier: 'standard' } },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const groupId = created.json.group.id;
  const source = created.json.members.find((member) => member.handle === 'codex2')!;
  const targetAdded = await t.api<GroupSnapshot>('POST', `/api/groups/${groupId}/agents`, {
    handle: 'claude3', isolated: true, configuration: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard' },
  });
  expect(targetAdded.status, JSON.stringify(targetAdded.json)).toBe(201);
  const target = targetAdded.json.members.find((member) => member.handle === 'claude3')!;
  expect(source.sessionId).not.toBe(target.sessionId);
  const policyUpdate = await t.api('PATCH', `/api/groups/${groupId}`, {
    recoveryPolicy: { automaticFallback: true, allowUnverifiedQuotaFallback: true, workerFallbacks: { [source.id]: target.id } },
  });
  expect(policyUpdate.status, JSON.stringify(policyUpdate.json)).toBe(200);

  let sourceWorktree = '';
  let targetWorktree = '';
  let targetSawDirtyFile = false;
  let targetPrompt = '';
  t.fake.script = async (options, emit) => {
    if (options.session.id === EXAMPLE_CONTRACT_SESSION_ID) {
      const delivery = t.app.groups.get(groupId).deliveries.find((row) => row.status === 'running' && row.memberId === created.json.members[0]!.id)!;
      const context = t.app.groups.contextForRun(EXAMPLE_CONTRACT_SESSION_ID, delivery.runId!)!;
      t.app.groups.assign(context, {
        recipient: 'codex2', title: 'Inspect existing file', objective: 'Record the existing source state.',
        acceptanceCriteria: 'Keep the change isolated to source-only.txt.', scope: ['source-only.txt'], dependsOn: [], inputArtifacts: [],
      });
      emit({ type: 'text', text: 'Assignment created.' });
      return;
    }
    if (options.session.id === source.sessionId) {
      sourceWorktree = options.session.worktreePath;
      writeFileSync(path.join(sourceWorktree, 'source-only.txt'), 'uncommitted source work\n');
      (options as typeof options & DispatchAwareOptions).onDispatchState?.('dispatched');
      throw new ProviderError('Account quota exhausted.', { code: 'quota_exhausted', outcomeKnown: true });
    }
    if (options.session.id === target.sessionId) {
      targetWorktree = options.session.worktreePath;
      targetPrompt = options.prompt;
      targetSawDirtyFile = existsSync(path.join(options.session.worktreePath, 'source-only.txt'));
      emit({ type: 'text', text: 'Inspected the source checkpoint references.' });
      return;
    }
    emit({ type: 'text', text: 'Unexpected member run.' });
  };

  expect((await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Inspect the repository state.' })).status).toBe(202);
  await waitFor(() => t.fake.runs.some((run) => run.session.id === target.sessionId), 6000, 'quota fallback target run');
  expect(targetSawDirtyFile).toBe(false);
  expect(targetPrompt).toContain('source-only.txt');
  expect(targetPrompt).toContain('Fresh source recovery checkpoint');
  expect(targetPrompt).toContain('not copied into the replacement worktree');
  expect(sourceWorktree).not.toBe(targetWorktree);
  expect(t.app.groups.get(groupId).group.recoveryPolicy?.automaticFallback).toBe(false);
}, 15000);

it('captures a fresh checkpoint before an isolated coordinator successor takes over', async () => {
  const t = testApp = await startTestApp();
  t.fake.detectProviders = async () => {
    const claude: ProviderInfo = { id: 'claude', name: 'Claude', available: true, version: 'fake', executable: '/fake/claude', reason: null, models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet', reasoningEfforts: ['low', 'medium', 'high'].map((id) => ({ id, label: id })), defaultReasoningEffort: 'high' }] };
    const codex: ProviderInfo = { id: 'codex', name: 'Codex', available: true, version: 'fake', executable: '/fake/codex', reason: null, models: [{ id: 'gpt-5-codex', name: 'Codex', reasoningEfforts: ['low', 'medium', 'high'].map((id) => ({ id, label: id })), defaultReasoningEffort: 'high' }] };
    return [claude, codex];
  };
  await t.api('POST', '/api/providers/refresh', {});
  expect((await t.api('PATCH', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}`, { provider: 'claude', model: 'claude-sonnet-5-5' })).status).toBe(200);
  const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
    sessionId: EXAMPLE_CONTRACT_SESSION_ID, mode: 'orchestrated',
    agent: { handle: 'claude2', isolated: true, configuration: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard' } },
    orchestrator: { provider: 'codex', model: 'gpt-5-codex', effort: 'high', policy: 'supervised', serviceTier: 'standard' },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const groupId = created.json.group.id;
  const target = created.json.members.find((member) => member.handle === 'claude2')!;
  const source = created.json.members.find((member) => member.role === 'orchestrator')!;
  const policyUpdate = await t.api('PATCH', `/api/groups/${groupId}`, {
    recoveryPolicy: { automaticFallback: true, allowUnverifiedQuotaFallback: true, leadFallbackMemberId: target.id },
  });
  expect(policyUpdate.status, JSON.stringify(policyUpdate.json)).toBe(200);

  let sourceWorktree = '';
  let targetWorktree = '';
  let targetPrompt = '';
  let targetSawDirtyFile = false;
  t.fake.script = async (options, emit) => {
    if (options.session.id === source.sessionId) {
      sourceWorktree = options.session.worktreePath;
      writeFileSync(path.join(sourceWorktree, 'coordinator-only.txt'), 'uncommitted coordinator work\n');
      (options as typeof options & DispatchAwareOptions).onDispatchState?.('dispatched');
      throw new ProviderError('Account quota exhausted.', { code: 'quota_exhausted', outcomeKnown: true });
    }
    if (options.session.id === target.sessionId) {
      targetWorktree = options.session.worktreePath;
      targetPrompt = options.prompt;
      targetSawDirtyFile = existsSync(path.join(targetWorktree, 'coordinator-only.txt'));
      emit({ type: 'text', text: 'Reviewed source references and continued the request.' });
      return;
    }
    emit({ type: 'text', text: 'Unexpected member run.' });
  };

  expect((await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Continue the project work.' })).status).toBe(202);
  await waitFor(() => t.fake.runs.some((run) => run.session.id === target.sessionId), 6000, 'coordinator quota fallback run');
  expect(sourceWorktree).not.toBe(targetWorktree);
  expect(targetSawDirtyFile).toBe(false);
  expect(targetPrompt).toContain('coordinator-only.txt');
  expect(targetPrompt).toContain('Fresh source recovery checkpoint');
  expect(targetPrompt).toContain('not copied into the replacement worktree');
  expect(t.app.groups.get(groupId).group.orchestratorMemberId).toBe(target.id);
  expect(t.app.groups.get(groupId).group.recoveryPolicy).toMatchObject({ automaticFallback: false, leadFallbackMemberId: null });
}, 15000);
