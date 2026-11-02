import { afterEach, describe, expect, it } from 'vitest';
import type { AppSettings, AttachmentRef, GroupSnapshot, ProviderCatalog, ProviderInfo, RunAttachment, RunOptions, Session } from '@mingle/contracts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EXAMPLE_CLIENT_SESSION_ID } from './example.ts';
import { ProviderError, type DispatchAwareOptions } from './providers/common.js';
import { FakeProviders, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

function imageCapableProviders(): FakeProviders {
  const fake = new FakeProviders();
  fake.detectProviders = async () => [
    { id: 'claude', name: 'Claude', available: true, version: 'fake', executable: '/fake/claude', reason: null,
      promptCapabilities: { image: true, embeddedContext: true },
      models: [{ id: 'claude-sonnet-5-5', name: 'Claude fake', reasoningEfforts: ['low', 'medium', 'high'].map((id) => ({ id, label: id })), defaultReasoningEffort: 'high', inputModalities: ['text', 'image'] }] },
    { id: 'codex', name: 'Codex', available: true, version: 'fake', executable: '/fake/codex', reason: null,
      policies: ['supervised'], promptCapabilities: { image: true, embeddedContext: true },
      models: [{ id: 'gpt-6.1-sol', name: 'Codex fake', reasoningEfforts: ['low', 'medium', 'high'].map((id) => ({ id, label: id })), defaultReasoningEffort: 'high', policies: ['supervised'], inputModalities: ['text', 'image'] }] },
  ] satisfies ProviderInfo[];
  return fake;
}

describe('recovery input preservation', () => {
  it('revalidates and preserves an addressed native skill through a safe retry', async () => {
    const fake = imageCapableProviders();
    (fake as FakeProviders & { getCatalog: (session: Session, settings: AppSettings) => Promise<ProviderCatalog> }).getCatalog = async () => ({
      commands: [], warnings: [], skills: [{ id: 'codex:build-review', name: 'build-review', description: 'Review a code change.', source: 'provider', enabled: true, path: '/fake/skills/build-review' }],
    });
    const t = await startTestApp({ fake });
    apps.push(t);
    await t.api('POST', '/api/providers/refresh', {});
    const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
      sessionId: EXAMPLE_CLIENT_SESSION_ID, mode: 'current-leads', agent: { handle: 'skill-target', isolated: false, configuration: {
        provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', policy: 'supervised', serviceTier: 'standard',
      } },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const groupId = created.json.group.id;
    const target = created.json.members.find((member) => member.handle === 'skill-target')!;
    let attempts = 0;
    let retriedRun: RunOptions | undefined;
    fake.script = async (options, emit) => {
      if (options.session.id === target.sessionId && ++attempts === 1) {
        (options as RunOptions & DispatchAwareOptions).onDispatchState?.('not-dispatched');
        throw new ProviderError('The provider stopped before running the selected skill.', {
          providerCode: 'usageLimitExceeded', outcomeKnown: true, continuationSafety: 'safe',
        });
      }
      if (options.session.id === target.sessionId) retriedRun = options;
      emit({ type: 'text', text: 'The selected skill completed.' });
    };

    const message = await t.api('POST', `/api/groups/${groupId}/messages`, {
      content: 'Review the compatibility changes.', invocation: {
        kind: 'skill', id: 'codex:build-review', name: 'build-review', arguments: 'focus on pagination', recipient: target.id,
      },
    });
    expect(message.status, JSON.stringify(message.json)).toBe(202);
    const failed = await waitFor(() => {
      const delivery = t.app.groups.get(groupId).deliveries.find((row) => row.memberId === target.id && row.status === 'failed');
      return delivery && t.app.runtime.activeCount() === 0 ? delivery : undefined;
    }, 5000, 'safe native skill failure');
    const retried = await t.api('POST', `/api/groups/${groupId}/recovery`, {
      action: 'retry-delivery', deliveryId: failed.id, idempotencyKey: `retry-skill-${failed.id}`,
    });
    expect(retried.status, JSON.stringify(retried.json)).toBe(200);
    await waitFor(() => retriedRun && t.app.runtime.activeCount() === 0, 5000, 'retried native skill');

    expect(attempts).toBe(2);
    expect(retriedRun!.invocation).toMatchObject({
      kind: 'skill', name: 'build-review', arguments: 'focus on pagination',
      skill: { id: 'codex:build-review', path: '/fake/skills/build-review' },
    });
    expect(retriedRun!.prompt).toContain('Review the compatibility changes.');
    const snapshot = t.app.groups.get(groupId);
    const original = snapshot.deliveries.find((row) => row.id === failed.id)!;
    const request = snapshot.requests.find((row) => row.id === original.requestId)!;
    expect(snapshot.messages.find((row) => row.id === request.messageId)?.invocation).toMatchObject({
      kind: 'skill', name: 'build-review', arguments: 'focus on pagination', memberId: target.id,
    });
  });

  it('preserves selected quote, file, and upload inputs through isolated coordinator handover', async () => {
    const fake = imageCapableProviders();
    const t = await startTestApp({ fake });
    apps.push(t);
    await t.api('POST', '/api/providers/refresh', {});

    const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
      sessionId: EXAMPLE_CLIENT_SESSION_ID, mode: 'current-leads',
      agent: { handle: 'codex-recovery', isolated: true, configuration: {
        provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', policy: 'supervised', serviceTier: 'standard',
      } },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const initial = created.json;
    const groupId = initial.group.id;
    const source = initial.members.find((member) => member.sessionId === initial.group.anchorSessionId)!;
    const target = initial.members.find((member) => member.handle === 'codex-recovery')!;
    const sourceSession = (await t.api('GET', '/api/bootstrap')).json.sessions.find((session: any) => session.id === source.sessionId);
    expect((await t.api('PATCH', `/api/groups/${groupId}`, { recoveryPolicy: {
      automaticFallback: true, allowUnverifiedQuotaFallback: true, leadFallbackMemberId: target.id, workerFallbacks: {},
    } })).status).toBe(200);

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const upload = await fetch(`${t.url}/api/groups/${groupId}/attachments`, {
      method: 'POST', headers: { 'content-type': 'image/png', 'x-mingle-filename': 'reference.png' },
      body: new Blob([png], { type: 'image/png' }),
    });
    expect(upload.status).toBe(201);
    const attachment = await upload.json() as AttachmentRef;
    const objective = 'Inspect the uploaded reference image and summarize its visible shape.';
    const quoteText = 'Keep the earlier finding: the reference contains one blue square.';
    const quotedMessage = t.app.store.insertMessage({ sessionId: source.sessionId, role: 'assistant', content: quoteText });
    const fileContents = 'Recovery must retain the original checked-in specification.\n';
    writeFileSync(path.join(sourceSession.worktreePath, 'recovery-reference.md'), fileContents);
    const contextRefs = [
      { kind: 'quote' as const, sourceMessageId: quotedMessage.id, sourceSessionId: source.sessionId, sourceGroupId: groupId, excerpt: 'one blue square' },
      { kind: 'file' as const, sourceSessionId: source.sessionId, path: 'recovery-reference.md' },
    ];
    let sourceRun: RunOptions | undefined;
    let sourceImage: RunAttachment | undefined;
    let targetRun: RunOptions | undefined;
    let targetImage: RunAttachment | undefined;
    let targetImageExistedDuringRun = false;
    let targetImageBytesDuringRun: Buffer | undefined;
    fake.script = async (options, emit) => {
      if (options.session.id === source.sessionId) {
        sourceRun = options;
        sourceImage = options.attachments?.find((item) => item.id === attachment.id);
        (options as RunOptions & DispatchAwareOptions).onDispatchState?.('dispatched');
        throw new ProviderError('Account quota exhausted.', {
          providerCode: 'usageLimitExceeded', outcomeKnown: true, continuationSafety: 'safe',
        });
      }
      if (options.session.id === target.sessionId) {
        targetRun = options;
        targetImage = options.attachments?.find((item) => item.id === attachment.id);
        if (targetImage) {
          targetImageExistedDuringRun = existsSync(targetImage.path);
          if (targetImageExistedDuringRun) targetImageBytesDuringRun = readFileSync(targetImage.path);
        }
        emit({ type: 'text', text: 'The replacement inspected the original reference image.' });
      }
    };

    expect((await t.api('POST', `/api/groups/${groupId}/messages`, { content: objective, attachmentIds: [attachment.id], contextRefs })).status).toBe(202);
    const recovered = await waitFor(() => {
      const snapshot = t.app.groups.get(groupId);
      const original = snapshot.deliveries.find((delivery) => delivery.memberId === source.id && delivery.status === 'failed');
      const successor = original?.recoveredByDeliveryId
        ? snapshot.deliveries.find((delivery) => delivery.id === original.recoveredByDeliveryId)
        : undefined;
      return original && successor?.status === 'completed' && t.app.runtime.activeCount() === 0
        ? { snapshot, original, successor } : undefined;
    }, 5000, 'isolated coordinator continuation to complete');

    expect(sourceRun?.prompt).toContain(objective);
    expect(sourceImage).toMatchObject({ id: attachment.id, kind: 'image', mimeType: 'image/png' });
    expect(targetRun).toBeDefined();
    expect(fake.runs.filter((run) => run.session.id === target.sessionId)).toHaveLength(1);
    expect(targetRun!.prompt).toContain(objective);
    expect(targetRun!.prompt).toContain('one blue square');
    expect(targetRun!.prompt).toContain(fileContents.trim());
    expect(targetImage).toMatchObject({ id: attachment.id, kind: 'image', mimeType: 'image/png', name: 'reference.png' });
    expect(targetImageExistedDuringRun).toBe(true);
    expect(targetImageBytesDuringRun).toEqual(png);
    expect(path.relative(targetRun!.session.worktreePath, targetImage!.path)).toMatch(/^\.\.(?:[\\/]|$)/);

    expect(recovered.successor).toMatchObject({ status: 'completed', kind: 'result', memberId: target.id });
    expect(recovered.original.recoveredByDeliveryId).toBe(recovered.successor.id);
    expect(recovered.snapshot.deliveries.filter((delivery) => delivery.id === recovered.original.recoveredByDeliveryId)).toHaveLength(1);
    const request = recovered.snapshot.requests.find((item) => item.id === recovered.original.requestId)!;
    const originalMessage = recovered.snapshot.messages.find((message) => message.id === request.messageId)!;
    expect(originalMessage.content).toContain(objective);
    expect(originalMessage.contextRefs).toEqual(contextRefs);
    expect(originalMessage.attachments).toContainEqual(expect.objectContaining({ id: attachment.id, name: 'reference.png', mimeType: 'image/png' }));
    const bootstrap = (await t.api('GET', '/api/bootstrap')).json;
    const targetSession = bootstrap.sessions.find((session: any) => session.id === target.sessionId);
    expect(sourceSession).toMatchObject({ provider: 'claude', policy: 'supervised' });
    expect(targetSession).toMatchObject({ provider: 'codex', policy: sourceSession.policy });
  });

  it('preserves selected context when a safe failed delivery is explicitly retried', async () => {
    const fake = imageCapableProviders();
    const t = await startTestApp({ fake });
    apps.push(t);
    await t.api('POST', '/api/providers/refresh', {});
    const configuration = { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard' };
    const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
      sessionId: EXAMPLE_CLIENT_SESSION_ID, mode: 'current-leads',
      agent: { handle: 'retry-worker', isolated: false, configuration },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const initial = created.json;
    const groupId = initial.group.id;
    const lead = initial.members.find((member) => member.sessionId === initial.group.anchorSessionId)!;
    const leadSession = (await t.api('GET', '/api/bootstrap')).json.sessions.find((session: any) => session.id === lead.sessionId);
    const quoteText = 'The prior answer identifies the stable interface as v2.';
    const quotedMessage = t.app.store.insertMessage({ sessionId: lead.sessionId, role: 'assistant', content: quoteText });
    const fileContents = 'Retry input: preserve the v2 compatibility behavior.\n';
    writeFileSync(path.join(leadSession.worktreePath, 'retry-reference.md'), fileContents);
    const contextRefs = [
      { kind: 'quote' as const, sourceMessageId: quotedMessage.id, sourceSessionId: lead.sessionId, sourceGroupId: groupId, excerpt: 'stable interface as v2' },
      { kind: 'file' as const, sourceSessionId: lead.sessionId, path: 'retry-reference.md' },
    ];
    let attempts = 0;
    let retriedRun: RunOptions | undefined;
    fake.script = async (options, emit) => {
      if (options.session.id === lead.sessionId && ++attempts === 1) {
        (options as RunOptions & DispatchAwareOptions).onDispatchState?.('not-dispatched');
        throw new ProviderError('The provider returned a safe, known failure.', {
          providerCode: 'usageLimitExceeded', outcomeKnown: true, continuationSafety: 'safe',
        });
      }
      if (options.session.id === lead.sessionId) {
        retriedRun = options;
        emit({ type: 'text', text: 'Retried with the selected original context.' });
      }
    };

    expect((await t.api('POST', `/api/groups/${groupId}/messages`, {
      content: 'Make the change while preserving compatibility.', contextRefs,
    })).status).toBe(202);
    const failed = await waitFor(() => {
      const delivery = t.app.groups.get(groupId).deliveries.find((row) => row.memberId === lead.id && row.status === 'failed');
      return delivery && t.app.runtime.activeCount() === 0 ? delivery : undefined;
    }, 5000, 'safe failed delivery');
    const retry = await t.api('POST', `/api/groups/${groupId}/recovery`, {
      action: 'retry-delivery', deliveryId: failed.id, idempotencyKey: `retry-context-${failed.id}`,
    });
    expect(retry.status, JSON.stringify(retry.json)).toBe(200);
    await waitFor(() => retriedRun && t.app.runtime.activeCount() === 0, 5000, 'retry with original context');

    expect(attempts).toBe(2);
    expect(retriedRun!.prompt).toContain('stable interface as v2');
    expect(retriedRun!.prompt).toContain(fileContents.trim());
    const snapshot = t.app.groups.get(groupId);
    const original = snapshot.deliveries.find((delivery) => delivery.id === failed.id)!;
    const successor = snapshot.deliveries.find((delivery) => delivery.id === original.recoveredByDeliveryId);
    expect(successor).toMatchObject({ status: 'completed', kind: 'result', memberId: lead.id });
    const request = snapshot.requests.find((row) => row.id === original.requestId)!;
    expect(snapshot.messages.find((message) => message.id === request.messageId)?.contextRefs).toEqual(contextRefs);
  });

  it('preserves original inputs when a failed assignment is manually reassigned', async () => {
    const fake = imageCapableProviders();
    const t = await startTestApp({ fake });
    apps.push(t);
    await t.api('POST', '/api/providers/refresh', {});

    const configuration = { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard' };
    const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
      sessionId: EXAMPLE_CLIENT_SESSION_ID, mode: 'current-leads',
      agent: { handle: 'source-worker', isolated: false, configuration },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const initial = created.json;
    const groupId = initial.group.id;
    const lead = initial.members.find((member) => member.sessionId === initial.group.anchorSessionId)!;
    const source = initial.members.find((member) => member.handle === 'source-worker')!;
    const added = await t.api('POST', `/api/groups/${groupId}/agents`, {
      handle: 'replacement-worker', isolated: false, configuration,
    });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
    const target = t.app.groups.get(groupId).members.find((member) => member.handle === 'replacement-worker')!;
    const bootstrap = (await t.api('GET', '/api/bootstrap')).json;
    const leadSession = bootstrap.sessions.find((session: any) => session.id === lead.sessionId);

    const uploadBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const upload = await fetch(`${t.url}/api/groups/${groupId}/attachments`, {
      method: 'POST', headers: { 'content-type': 'image/png', 'x-mingle-filename': 'handoff.png' },
      body: new Blob([uploadBytes], { type: 'image/png' }),
    });
    expect(upload.status).toBe(201);
    const attachment = await upload.json() as AttachmentRef;
    const quoteText = 'The earlier review confirms the boundary is 42 pixels.';
    const quotedMessage = t.app.store.insertMessage({ sessionId: lead.sessionId, role: 'assistant', content: quoteText });
    const fileContents = 'Reassigned work must retain this selected specification.\n';
    writeFileSync(path.join(leadSession.worktreePath, 'handoff-reference.md'), fileContents);
    const contextRefs = [
      { kind: 'quote' as const, sourceMessageId: quotedMessage.id, sourceSessionId: lead.sessionId, sourceGroupId: groupId, excerpt: 'boundary is 42 pixels' },
      { kind: 'file' as const, sourceSessionId: lead.sessionId, path: 'handoff-reference.md' },
    ];
    const objective = 'Implement the requested reference-aware change.';
    let taskId: string | undefined;
    let targetRun: RunOptions | undefined;
    let targetImage: RunAttachment | undefined;
    let targetImageBytes: Buffer | undefined;
    fake.script = async (options, emit) => {
      if (options.session.id === lead.sessionId) {
        const active = t.app.groups.get(groupId).deliveries.find((delivery) => delivery.status === 'running' && delivery.memberId === lead.id);
        if (!active?.runId) throw new Error('Lead delivery was not bound to its provider run');
        const context = t.app.groups.contextForRun(lead.sessionId, active.runId);
        if (!context) throw new Error('Lead group context is unavailable');
        const assignment = t.app.groups.assign(context, {
          recipient: source.handle, title: 'Preserve recovery inputs', objective,
          acceptanceCriteria: 'The replacement uses all original selected references.', scope: ['handoff-reference.md'], dependsOn: [], inputArtifacts: [],
        }) as { taskId?: string; status?: string };
        taskId = assignment.taskId;
        expect(assignment.status).toBe('queued');
        emit({ type: 'text', text: 'Assigned the work to the source worker.' });
        return;
      }
      if (options.session.id === source.sessionId) {
        (options as RunOptions & DispatchAwareOptions).onDispatchState?.('dispatched');
        throw new ProviderError('The source worker stopped after a safe, known outcome.', {
          providerCode: 'usageLimitExceeded', outcomeKnown: true, continuationSafety: 'safe',
        });
      }
      if (options.session.id === target.sessionId) {
        targetRun = options;
        targetImage = options.attachments?.find((item) => item.id === attachment.id);
        if (targetImage && existsSync(targetImage.path)) targetImageBytes = readFileSync(targetImage.path);
        emit({ type: 'text', text: 'The replacement continued from the original selected inputs.' });
      }
    };

    expect((await t.api('POST', `/api/groups/${groupId}/messages`, {
      content: objective, attachmentIds: [attachment.id], contextRefs,
    })).status).toBe(202);
    const failed = await waitFor(() => {
      const delivery = t.app.groups.get(groupId).deliveries.find((row) => row.memberId === source.id && row.status === 'failed');
      return delivery && t.app.runtime.activeCount() === 0 ? delivery : undefined;
    }, 5000, 'source assignment failure');
    expect(taskId).toBeTruthy();
    expect((await t.api('POST', `/api/groups/${groupId}/recovery`, {
      action: 'fallback-delivery', deliveryId: failed.id, replacementMemberId: target.id,
      idempotencyKey: `reassign-inputs-${failed.id}`,
    })).status).toBe(200);
    await waitFor(() => targetRun && t.app.runtime.activeCount() === 0, 5000, 'reassigned worker to complete');

    expect(targetRun!.prompt).toContain('boundary is 42 pixels');
    expect(targetRun!.prompt).toContain(fileContents.trim());
    expect(targetImage).toMatchObject({ id: attachment.id, kind: 'image', mimeType: 'image/png', name: 'handoff.png' });
    expect(targetImageBytes).toEqual(uploadBytes);
    expect(targetRun!.prompt).toContain(objective);
    const snapshot = t.app.groups.get(groupId);
    const original = snapshot.deliveries.find((delivery) => delivery.id === failed.id)!;
    const successor = snapshot.deliveries.find((delivery) => delivery.id === original.recoveredByDeliveryId);
    expect(successor).toMatchObject({ status: 'completed', kind: 'assignment', memberId: target.id });
    expect(snapshot.assignments).toContainEqual(expect.objectContaining({ taskId, toMemberId: target.id }));
    const request = snapshot.requests.find((row) => row.id === original.requestId)!;
    expect(snapshot.messages.find((message) => message.id === request.messageId)?.contextRefs).toEqual(contextRefs);
  });
});
