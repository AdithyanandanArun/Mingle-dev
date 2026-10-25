import { afterEach, expect, it } from 'vitest';
import type { Bootstrap, GroupSnapshot, MessageContextRef, ProviderCatalog } from '@mingle/contracts';
import { EXAMPLE_CLIENT_SESSION_ID, EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { buildMessageContext } from './message-context.ts';
import { deferred, startTestApp, waitFor, type TestApp } from './test-utils.ts';

let testApp: TestApp | undefined;
afterEach(async () => { await testApp?.cleanup(); testApp = undefined; });

it('returns after persisting session and group messages, with deferred context failures still visible', async () => {
  const t = testApp = await startTestApp();
  await t.api('POST', '/api/providers/refresh', {});
  await t.api('PATCH', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}`, { provider: 'claude', model: 'claude-sonnet-5-5' });
  const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
    sessionId: EXAMPLE_CONTRACT_SESSION_ID, mode: 'cowork',
    agent: { handle: 'claude2', isolated: true, configuration: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised' } },
  });
  expect(created.status).toBe(201);

  const session = t.app.store.getSession(EXAMPLE_CLIENT_SESSION_ID)!;
  const sessionRefs: MessageContextRef[] = [{ kind: 'file', sourceSessionId: session.id, path: 'README.md' }];
  const sessionPreflightStart = performance.now();
  await buildMessageContext(sessionRefs, session.worktreePath, (_sessionId, messageId) => t.app.store.getMessage(messageId));
  const sessionPreflightMs = performance.now() - sessionPreflightStart;
  const sessionSendStart = performance.now();
  const sessionResponse = await t.api('POST', `/api/sessions/${session.id}/messages`, { content: 'Read the attached project note.', contextRefs: sessionRefs });
  const sessionSendMs = performance.now() - sessionSendStart;
  expect(sessionResponse.status).toBe(202);
  expect(t.app.store.listMessages(session.id).some((message) => message.role === 'user' && message.content === 'Read the attached project note.')).toBe(true);

  const groupRefs: MessageContextRef[] = [{ kind: 'file', sourceSessionId: EXAMPLE_CONTRACT_SESSION_ID, path: 'README.md' }];
  const groupPreflightStart = performance.now();
  await buildMessageContext(groupRefs, t.app.store.getSession(EXAMPLE_CONTRACT_SESSION_ID)!.worktreePath,
    (_sessionId, messageId) => t.app.store.getMessage(messageId));
  const groupPreflightMs = performance.now() - groupPreflightStart;
  const groupSendStart = performance.now();
  const groupResponse = await t.api<GroupSnapshot>('POST', `/api/groups/${created.json.group.id}/messages`, {
    content: 'Read the attached group note.', recipients: [created.json.members[0]!.id], contextRefs: groupRefs,
  });
  const groupSendMs = performance.now() - groupSendStart;
  expect(groupResponse.status).toBe(202);
  const userMessage = groupResponse.json.messages.find((message) => message.kind === 'user' && message.content === 'Read the attached group note.');
  expect(userMessage).toBeDefined();

  const badGroupRefs: MessageContextRef[] = [{ kind: 'file', sourceSessionId: EXAMPLE_CONTRACT_SESSION_ID, path: '__missing_performance_fixture__.md' }];
  const rejectedContextResponse = await t.api<GroupSnapshot>('POST', `/api/groups/${created.json.group.id}/messages`, {
    content: 'Use the missing context file.', recipients: [created.json.members[0]!.id], contextRefs: badGroupRefs,
  });
  expect(rejectedContextResponse.status).toBe(202);
  const badUserMessage = rejectedContextResponse.json.messages.find((message) => message.kind === 'user' && message.content === 'Use the missing context file.');
  expect(badUserMessage).toBeDefined();
  const failedDelivery = await waitFor(() => t.app.groups.get(created.json.group.id).deliveries.find((delivery) => delivery.messageId === badUserMessage!.id && delivery.status === 'failed'));
  expect(failedDelivery.error).toMatch(/file|path|available|read/i);

  const bootstrap = (await t.api<Bootstrap>('GET', '/api/bootstrap')).json;
  const bootstrapBytes = Buffer.byteLength(JSON.stringify(bootstrap));
  const keyBytes = Object.fromEntries(Object.entries(bootstrap)
    .map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))] as const).sort((a, b) => b[1] - a[1]));
  console.info('send-performance', JSON.stringify({ sessionPreflightMs, sessionSendMs, groupPreflightMs, groupSendMs, bootstrapBytes, keyBytes }));

  expect(sessionSendMs).toBeLessThan(2_000);
  expect(groupSendMs).toBeLessThan(2_000);
});

it('measures accepted send while provider execution is delayed', async () => {
  const t = testApp = await startTestApp();
  const release = deferred();
  let providerStarted = false;
  t.fake.script = async (_options, emit) => {
    providerStarted = true;
    await release.promise;
    emit({ type: 'text', text: 'delayed fake provider result' });
  };
  const start = performance.now();
  const response = await t.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`, { content: 'Measure request to accepted response.' });
  const elapsedMs = performance.now() - start;
  expect(response.status).toBe(202);
  expect(response.json).toMatchObject({ accepted: true });
  expect(t.app.store.listMessages(EXAMPLE_CLIENT_SESSION_ID).some((message) => message.role === 'user' && message.content === 'Measure request to accepted response.')).toBe(true);
  expect(elapsedMs).toBeLessThan(2_000);
  console.info('delayed-send-performance', JSON.stringify({ elapsedMs, providerStartedByResponse: providerStarted }));
  release.resolve();
});

it('returns before asynchronous selected-skill discovery completes', async () => {
  const t = testApp = await startTestApp();
  await t.api('PATCH', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}`, { provider: 'claude', model: 'claude-sonnet-5-5' });
  const catalog = deferred<ProviderCatalog>();
  const originalCatalog = t.app.providers.catalog.bind(t.app.providers);
  let catalogStarted = false;
  let catalogCompleted = false;
  t.app.providers.catalog = async () => {
    catalogStarted = true;
    const result = await catalog.promise;
    catalogCompleted = true;
    return result;
  };

  const start = performance.now();
  const response = await t.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`, {
    content: 'Run with the selected skill.', skills: ['slow-skill'],
  });
  const elapsedMs = performance.now() - start;
  expect(response.status).toBe(202);
  expect(t.app.store.listMessages(EXAMPLE_CLIENT_SESSION_ID).some((message) => message.role === 'user' && message.content === 'Run with the selected skill.')).toBe(true);
  expect(catalogCompleted).toBe(false);
  expect(elapsedMs).toBeLessThan(2_000);

  catalog.resolve({ commands: [], skills: [{ id: 'slow-skill', name: 'Slow skill', description: 'Delayed test skill', source: 'provider', enabled: true }], warnings: [] });
  await waitFor(() => catalogStarted && !t.app.runtime.isActive(EXAMPLE_CLIENT_SESSION_ID));
  expect(catalogCompleted).toBe(true);
  expect(t.fake.runs.at(-1)?.skills).toMatchObject([{ id: 'slow-skill', name: 'Slow skill' }]);
  t.app.providers.catalog = originalCatalog;
  console.info('skill-send-performance', JSON.stringify({ elapsedMs, catalogCompletedByResponse: false }));
});

it('queues group provider actions before catalog discovery completes', async () => {
  const t = testApp = await startTestApp();
  await t.api('POST', '/api/providers/refresh', {});
  await t.api('PATCH', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}`, { provider: 'claude', model: 'claude-sonnet-5-5' });
  const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
    sessionId: EXAMPLE_CONTRACT_SESSION_ID, mode: 'cowork',
    agent: { handle: 'claude2', isolated: true, configuration: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised' } },
  });
  expect(created.status).toBe(201);
  const target = created.json.members.find((member) => member.handle === 'claude2')!;
  const catalog = deferred<ProviderCatalog>();
  const originalCatalog = t.app.providers.catalog.bind(t.app.providers);
  let catalogStarted = false;
  let catalogCompleted = false;
  t.app.providers.catalog = async () => {
    catalogStarted = true;
    const result = await catalog.promise;
    catalogCompleted = true;
    return result;
  };
  const input = {
    content: 'Run the delayed action.', clientMessageId: 'delayed-catalog-action',
    invocation: { kind: 'skill' as const, id: 'slow-skill', name: 'slow-skill', arguments: '', recipient: target.id },
  };
  const startedAt = performance.now();
  const request = t.api<GroupSnapshot>('POST', `/api/groups/${created.json.group.id}/messages`, input);
  let timeout: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    request,
    new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 1_500); }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!result) {
    catalog.resolve({ commands: [], skills: [{ id: 'slow-skill', name: 'Slow skill', description: 'Delayed test skill', source: 'provider', enabled: true }], warnings: [] });
    await request;
    throw new Error('The group send waited for provider catalog discovery before replying.');
  }
  const elapsedMs = performance.now() - startedAt;
  expect(result.status).toBe(202);
  expect(result.json.deliveries.some((delivery) => delivery.memberId === target.id && delivery.status === 'queued')).toBe(true);
  expect(catalogCompleted).toBe(false);
  catalog.resolve({ commands: [], skills: [{ id: 'slow-skill', name: 'slow-skill', description: 'Delayed test skill', source: 'provider', enabled: true }], warnings: [] });
  await waitFor(() => t.fake.runs.some((run) => run.invocation?.skill?.id === 'slow-skill') && !t.app.runtime.isActive(target.sessionId));
  expect(catalogStarted).toBe(true);
  expect(catalogCompleted).toBe(true);
  expect(t.fake.runs.at(-1)?.invocation).toMatchObject({ skill: { id: 'slow-skill', name: 'slow-skill' } });
  t.app.providers.catalog = originalCatalog;
  console.info('group-action-send-performance', JSON.stringify({ elapsedMs, catalogCompletedByResponse: false }));
});
