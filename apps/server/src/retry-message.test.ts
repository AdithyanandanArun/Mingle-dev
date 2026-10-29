import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Message, ProviderInfo, RunOptions } from '@mingle/contracts';
import { EXAMPLE_CLIENT_SESSION_ID, EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { FakeProviders, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

const providers = (): ProviderInfo[] => [
  { id: 'codex', name: 'Codex', available: true, version: 'test', executable: '/fake/codex', reason: null,
    models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1', policies: ['supervised'] }], policies: ['supervised'] },
  { id: 'claude', name: 'Claude', available: true, version: 'test', executable: '/fake/claude', reason: null,
    models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', policies: ['supervised'] }], policies: ['supervised'] },
];

async function boot(fake = new FakeProviders()): Promise<TestApp> {
  fake.detectProviders = async () => providers();
  const t = await startTestApp({ fake });
  apps.push(t);
  await t.api('GET', '/api/bootstrap');
  return t;
}

async function upload(t: TestApp, sessionId: string, name = 'retry-notes.txt', bytes = 'Keep the uploaded context.') {
  const response = await fetch(`${t.url}/api/sessions/${sessionId}/attachments`, {
    method: 'POST', headers: { 'content-type': 'text/plain', 'x-mingle-filename': name }, body: new Blob([bytes], { type: 'text/plain' }),
  });
  expect(response.status).toBe(201);
  return await response.json() as { id: string; name: string };
}

function seedFailedMessage(t: TestApp, sessionId: string, attachmentId?: string): Message {
  const session = t.app.store.getSession(sessionId)!;
  const quote = t.app.store.insertMessage({ sessionId, role: 'assistant', content: 'Keep the compatibility note intact.' });
  const contextRefs = [{ kind: 'quote' as const, sourceMessageId: quote.id, sourceSessionId: sessionId, excerpt: 'compatibility note intact' }];
  const runId = `run_${randomUUID().replaceAll('-', '')}`;
  let message!: Message;
  t.app.store.tx(() => {
    message = t.app.store.insertMessage({ sessionId, role: 'user', content: 'Retry this exact request with its saved context.', contextRefs });
    t.app.store.insertRun({ id: runId, sessionId, userMessageId: message.id, provider: session.provider, model: session.model, startedAt: new Date().toISOString() });
    t.app.store.db.prepare('UPDATE messages SET run_id=? WHERE id=?').run(runId, message.id);
    if (attachmentId) t.app.attachments.repo.link(attachmentId, 'message', message.id, 0);
    t.app.store.finishRun(runId, 'failed', 20);
    t.app.store.updateSession(sessionId, { status: 'error', error: 'Simulated failed run' });
  });
  return t.app.store.getMessage(message.id)!;
}

it('clones failed-message attachments and context refs and starts on the switched provider with pending handoff', async () => {
  const fake = new FakeProviders();
  const t = await boot(fake);
  const sessionId = EXAMPLE_CONTRACT_SESSION_ID;
  const attachment = await upload(t, sessionId);
  const original = seedFailedMessage(t, sessionId, attachment.id);
  const switched = await t.api('PATCH', `/api/sessions/${sessionId}`, { provider: 'claude', model: 'claude-sonnet-5-5' });
  expect(switched.status).toBe(200);
  expect(switched.json.handoffPendingAt).toEqual(expect.any(String));

  let retryRun: RunOptions | undefined;
  let retryBytes: Buffer | undefined;
  fake.script = async (options, emit) => {
    retryRun = options;
    const staged = options.attachments?.[0];
    if (staged) retryBytes = readFileSync(staged.path);
    emit({ type: 'text', text: 'Continued with the saved file.' });
  };
  const response = await t.api('POST', `/api/sessions/${sessionId}/messages/${original.id}/retry`, {});
  expect(response.status, JSON.stringify(response.json)).toBe(202);
  await waitFor(() => retryRun && t.app.runtime.activeCount() === 0, 5000, 'message retry');

  const retried = t.app.store.listMessages(sessionId).find((message) => message.role === 'user' && message.runId !== original.runId
    && message.content === original.content)!;
  expect(retried.contextRefs).toEqual(original.contextRefs);
  expect(retried.attachments).toHaveLength(1);
  expect(retried.attachments?.[0]).toMatchObject({ name: attachment.name });
  expect(retried.attachments?.[0]?.id).not.toBe(attachment.id);
  expect(retryBytes).toEqual(Buffer.from('Keep the uploaded context.'));
  expect(retryRun?.session.provider).toBe('claude');
  expect(retryRun?.prompt).toContain('Mingle context handoff');
  expect(t.app.store.getSession(sessionId)?.handoffPendingAt).toBeNull();
});

it('returns a named error when a failed message attachment is missing on disk', async () => {
  const t = await boot();
  const sessionId = EXAMPLE_CONTRACT_SESSION_ID;
  const attachment = await upload(t, sessionId, 'missing-design.md');
  const original = seedFailedMessage(t, sessionId, attachment.id);
  rmSync(path.join(t.app.config.dataDir, 'attachments', 'blobs', attachment.id));

  const response = await t.api('POST', `/api/sessions/${sessionId}/messages/${original.id}/retry`, {});
  expect(response.status).toBe(409);
  expect(response.json.error).toContain('missing-design.md');
  expect(response.json.error).toContain('Reattach');
  expect(t.fake.runs).toHaveLength(0);
});

it('rejects a failed user message from a different session', async () => {
  const t = await boot();
  const original = seedFailedMessage(t, EXAMPLE_CONTRACT_SESSION_ID);
  const response = await t.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages/${original.id}/retry`, {});
  expect(response.status).toBe(404);
  expect(response.json.error).toContain('Message not found in this session');
  expect(t.fake.runs).toHaveLength(0);
});

it('allows retry only for the latest failed user message in a session', async () => {
  const t = await boot();
  const older = seedFailedMessage(t, EXAMPLE_CONTRACT_SESSION_ID);
  const latest = seedFailedMessage(t, EXAMPLE_CONTRACT_SESSION_ID);
  expect(older.id).not.toBe(latest.id);

  const response = await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages/${older.id}/retry`, {});
  expect(response.status).toBe(409);
  expect(response.json.error).toContain('latest failed user message');
  expect(t.fake.runs).toHaveLength(0);
});
