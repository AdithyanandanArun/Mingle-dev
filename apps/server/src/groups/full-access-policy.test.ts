import { afterEach, expect, it } from 'vitest';
import type { GroupSnapshot, ProviderInfo } from '@mingle/contracts';
import { EXAMPLE_CLIENT_SESSION_ID } from '../example.ts';
import { FakeProviders, startTestApp, waitFor, type TestApp } from '../test-utils.ts';

const apps: TestApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

it('uses full-access native policy for local group runs only when the provider advertises it', async () => {
  const fake = new FakeProviders();
  const provider: ProviderInfo = { id: 'claude', name: 'Claude', available: true, version: 'fake', executable: '/fake/claude', reason: null,
    policies: ['supervised', 'full-access'], models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet', policies: ['supervised', 'full-access'] }] };
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

  const limitedProvider: ProviderInfo = { ...provider, policies: ['supervised'], models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet', policies: ['supervised'] }] };
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
