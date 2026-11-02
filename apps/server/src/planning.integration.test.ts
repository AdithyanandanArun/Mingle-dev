import { afterEach, describe, expect, it } from 'vitest';
import type { GroupSnapshot, RunAttachment, RunOptions, SessionPlan, UserInputAnswers } from '@mingle/contracts';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { FakeProviders, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

const step = (id: string, title: string, dependsOn: string[] = []): SessionPlan['steps'][number] => ({
  id, providerId: null, title, description: `${title} details`, acceptanceCriteria: [`Complete ${title}`], dependsOn, status: 'pending',
});

describe('native plans and questions', () => {
  it('revises and approves exact plan revisions and carries original references and attachments into execution', async () => {
    const fake = new FakeProviders();
    const t = await startTestApp({ fake });
    apps.push(t);

    const session = (await t.api('GET', '/api/bootstrap')).json.sessions.find((row: any) => row.id === EXAMPLE_CONTRACT_SESSION_ID);
    const fileContents = 'The source contract requires stable pagination tokens.\n';
    writeFileSync(path.join(session.worktreePath, 'plan-input.md'), fileContents);
    const quoteText = 'The prior review confirms cursors remain opaque.';
    const quote = t.app.store.insertMessage({ sessionId: session.id, role: 'assistant', content: quoteText });
    const contextRefs = [
      { kind: 'quote' as const, sourceMessageId: quote.id, sourceSessionId: session.id, excerpt: 'cursors remain opaque' },
      { kind: 'file' as const, sourceSessionId: session.id, path: 'plan-input.md' },
    ];
    const upload = await fetch(`${t.url}/api/sessions/${session.id}/attachments`, {
      method: 'POST', headers: { 'content-type': 'text/plain', 'x-mingle-filename': 'pagination-notes.txt' },
      body: new Blob(['Keep page tokens stable.'], { type: 'text/plain' }),
    });
    expect(upload.status).toBe(201);
    const attachment = await upload.json() as { id: string; name: string };

    let planRun: RunOptions | undefined;
    let executionRun: RunOptions | undefined;
    let planAttachment: RunAttachment | undefined;
    let executionAttachment: RunAttachment | undefined;
    let planAttachmentBytes: Buffer | undefined;
    let executionAttachmentBytes: Buffer | undefined;
    fake.script = async (options, emit) => {
      const selected = options.attachments?.find((item) => item.id === attachment.id);
      if (options.intent === 'plan') {
        planRun = options;
        planAttachment = selected;
        if (selected) planAttachmentBytes = readFileSync(selected.path);
        emit({ type: 'session.plan', providerPlanId: 'native-plan-1', explanation: 'Preserve API compatibility.', steps: [step('a', 'Define cursor rules'), step('b', 'Update client handling', ['a'])] });
        emit({ type: 'text', text: 'Plan proposal is ready.' });
        return;
      }
      if (options.prompt.includes('Execute this user-approved Mingle plan.')) {
        executionRun = options;
        executionAttachment = selected;
        if (selected) executionAttachmentBytes = readFileSync(selected.path);
      }
      emit({ type: 'text', text: 'Completed the requested work.' });
    };

    const sent = await t.api('POST', `/api/sessions/${session.id}/messages`, {
      content: 'Plan the cursor compatibility update.', intent: 'plan', attachmentIds: [attachment.id], contextRefs,
    });
    expect(sent.status, JSON.stringify(sent.json)).toBe(202);
    const plan = await waitFor(() => {
      const current = t.app.store.listSessionPlans(session.id)[0];
      return current?.status === 'review' && t.app.runtime.activeCount() === 0 ? current : undefined;
    }, 5000, 'native plan review state');
    expect(planRun?.prompt).toContain('cursors remain opaque');
    expect(planRun?.prompt).toContain(fileContents.trim());
    expect(planAttachment).toMatchObject({ id: attachment.id, name: attachment.name, kind: 'file' });
    expect(planAttachmentBytes).toEqual(Buffer.from('Keep page tokens stable.'));

    const cycle = await t.api('PATCH', `/api/plans/${plan.id}`, {
      expectedRevision: 1,
      steps: [step('a', 'First', ['b']), step('b', 'Second', ['a'])],
    });
    expect(cycle.status).toBe(400);

    const revised = await t.api<SessionPlan>('PATCH', `/api/plans/${plan.id}`, {
      expectedRevision: 1,
      explanation: 'Keep the existing client contract.',
      steps: [step('b', 'Update client handling', ['a']), step('a', 'Define cursor rules'), step('c', 'Document compatibility', ['b'])],
    });
    expect(revised.status, JSON.stringify(revised.json)).toBe(200);
    expect(revised.json).toMatchObject({ revision: 2, status: 'review', approvedRevision: null });
    expect(revised.json.steps.map((item) => item.id)).toEqual(['b', 'a', 'c']);

    const staleEdit = await t.api('PATCH', `/api/plans/${plan.id}`, {
      expectedRevision: 1,
      steps: [step('a', 'An outdated edit')],
    });
    expect(staleEdit.status).toBe(409);

    const withoutRemovedStep = await t.api<SessionPlan>('PATCH', `/api/plans/${plan.id}`, {
      expectedRevision: 2,
      steps: [step('a', 'Define cursor rules'), step('b', 'Update client handling', ['a'])],
    });
    expect(withoutRemovedStep.status).toBe(200);
    expect(withoutRemovedStep.json).toMatchObject({ revision: 3, status: 'review' });
    expect((await t.api('POST', `/api/plans/${plan.id}/approve`, { revision: 2 })).status).toBe(409);
    expect((await t.api('POST', `/api/plans/${plan.id}/approve`, { revision: 3 })).status).toBe(200);
    const started = await t.api('POST', `/api/plans/${plan.id}/execute`, {});
    expect(started.status, JSON.stringify(started.json)).toBe(202);

    const completed = await waitFor(() => {
      const current = t.app.store.getSessionPlan(plan.id);
      return current?.status === 'completed' && t.app.runtime.activeCount() === 0 ? current : undefined;
    }, 5000, 'approved native plan execution');
    expect(completed.executionRunId).toBeTruthy();
    expect(executionRun?.prompt).toContain('Define cursor rules');
    expect(executionRun?.prompt).toContain('Update client handling');
    expect(executionRun?.prompt).toContain('cursors remain opaque');
    expect(executionRun?.prompt).toContain(fileContents.trim());
    expect(executionAttachment).toMatchObject({ id: attachment.id, name: attachment.name, kind: 'file' });
    expect(executionAttachmentBytes).toEqual(Buffer.from('Keep page tokens stable.'));
    expect(fake.runs.filter((run) => run.session.id === session.id)).toHaveLength(2);
  });

  it('answers only the active question and never persists secret-marked answers', async () => {
    const fake = new FakeProviders();
    const t = await startTestApp({ fake });
    apps.push(t);
    let received: UserInputAnswers | null | undefined;
    fake.script = async (options) => {
      received = await options.requestUserInput?.({
        nativeRequestId: 'request-1', tool: 'AskUserQuestion', questions: [
          { id: 'color', header: 'Theme', question: 'Which accent?', options: [{ label: 'Blue' }, { label: 'Green' }], multiSelect: false, allowOther: false, secret: false },
          { id: 'token', header: 'Access', question: 'Temporary access phrase', options: [], multiSelect: false, allowOther: true, secret: true },
        ],
      }) ?? null;
    };

    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'Continue setup.' })).status).toBe(202);
    const question = await waitFor(() => t.app.store.bootstrapQuestions().find((row) => row.status === 'pending'));
    const invalid = await t.api('POST', `/api/questions/${question.id}/answer`, { color: ['Blue'], token: ['short-lived phrase'], unexpected: ['extra'] });
    expect(invalid.status).toBe(400);
    expect(t.app.store.getUserQuestion(question.id)?.status).toBe('pending');

    const answered = await t.api('POST', `/api/questions/${question.id}/answer`, { color: ['Blue'], token: ['short-lived phrase'] });
    expect(answered.status).toBe(200);
    await waitFor(() => received !== undefined && t.app.runtime.activeCount() === 0);
    expect(received).toEqual({ color: ['Blue'], token: ['short-lived phrase'] });
    expect(t.app.store.getUserQuestion(question.id)).toMatchObject({
      status: 'answered', answers: { color: ['Blue'] },
    });
    expect(JSON.stringify(t.app.store.getUserQuestion(question.id))).not.toContain('short-lived phrase');
  });

  it('cancels a pending native question with its waiting provider run', async () => {
    const fake = new FakeProviders();
    const t = await startTestApp({ fake });
    apps.push(t);
    let received: UserInputAnswers | null | undefined;
    fake.script = async (options) => {
      received = await options.requestUserInput?.({
        nativeRequestId: 'request-cancel', tool: 'requestUserInput', questions: [
          { id: 'continue', question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false, allowOther: false, secret: false },
        ],
      }) ?? null;
    };

    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'Ask before continuing.' })).status).toBe(202);
    const question = await waitFor(() => t.app.store.bootstrapQuestions().find((row) => row.status === 'pending'));
    const cancelled = await t.api('POST', `/api/questions/${question.id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    await waitFor(() => received === null && t.app.runtime.activeCount() === 0);
    expect(t.app.store.getUserQuestion(question.id)).toMatchObject({ status: 'cancelled' });
  });
});

describe('group native planning', () => {
  it('targets one selected agent and preserves the original plan request inputs for approved execution', async () => {
    const fake = new FakeProviders();
    fake.detectProviders = async () => [
      { id: 'claude', name: 'Claude', available: true, version: 'fake', executable: '/fake/claude', reason: null,
        promptCapabilities: { image: true, embeddedContext: true }, models: [{ id: 'claude-sonnet-5-5', name: 'Claude fake', reasoningEfforts: ['low', 'medium', 'high'].map((id) => ({ id, label: id })), defaultReasoningEffort: 'high', inputModalities: ['text', 'image'] }] },
      { id: 'codex', name: 'Codex', available: true, version: 'fake', executable: '/fake/codex', reason: null,
        promptCapabilities: { image: true, embeddedContext: true }, models: [{ id: 'gpt-6.1-sol', name: 'Codex fake', reasoningEfforts: ['low', 'medium', 'high'].map((id) => ({ id, label: id })), defaultReasoningEffort: 'high', inputModalities: ['text', 'image'] }] },
    ];
    const t = await startTestApp({ fake });
    apps.push(t);
    expect((await t.api('POST', '/api/providers/refresh', {})).status).toBe(200);
    const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
      sessionId: EXAMPLE_CONTRACT_SESSION_ID, mode: 'current-leads', agent: { handle: 'plan-target', isolated: false, configuration: {
        provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', policy: 'supervised', serviceTier: 'standard',
      } },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const groupId = created.json.group.id;
    const anchor = created.json.members.find((member) => member.sessionId === created.json.group.anchorSessionId)!;
    const target = created.json.members.find((member) => member.handle === 'plan-target')!;
    const anchorSession = (await t.api('GET', '/api/bootstrap')).json.sessions.find((row: any) => row.id === anchor.sessionId);
    const fileContents = 'Group plan source file that must remain selected.\n';
    writeFileSync(path.join(anchorSession.worktreePath, 'group-plan-input.md'), fileContents);
    const quote = t.app.store.insertMessage({ sessionId: anchor.sessionId, role: 'assistant', content: 'The review says keep one client per cursor.' });
    const contextRefs = [
      { kind: 'quote' as const, sourceMessageId: quote.id, sourceSessionId: anchor.sessionId, sourceGroupId: groupId, excerpt: 'one client per cursor' },
      { kind: 'file' as const, sourceSessionId: anchor.sessionId, path: 'group-plan-input.md' },
    ];
    const attachmentBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const upload = await fetch(`${t.url}/api/groups/${groupId}/attachments`, {
      method: 'POST', headers: { 'content-type': 'image/png', 'x-mingle-filename': 'cursor-reference.png' },
      body: new Blob([attachmentBytes], { type: 'image/png' }),
    });
    expect(upload.status).toBe(201);
    const attachment = await upload.json() as { id: string; name: string };
    const planRuns: RunOptions[] = [];
    const executionRuns: RunOptions[] = [];
    const observedBytes: Buffer[] = [];
    fake.script = async (options, emit) => {
      const selected = options.attachments?.find((item) => item.id === attachment.id);
      if (selected) observedBytes.push(readFileSync(selected.path));
      if (options.intent === 'plan') {
        planRuns.push(options);
        emit({ type: 'session.plan', providerPlanId: 'group-plan-1', explanation: 'Keep cursor behavior stable.', steps: [step('one', 'Preserve compatibility')] });
        emit({ type: 'text', text: 'Targeted plan ready.' });
        return;
      }
      if (options.prompt.includes('Execute this user-approved Mingle plan.')) executionRuns.push(options);
      emit({ type: 'text', text: 'Group plan work completed.' });
    };

    const sent = await t.api<GroupSnapshot>('POST', `/api/groups/${groupId}/messages`, {
      content: 'Plan the compatibility change.', recipients: [target.id], intent: 'plan', attachmentIds: [attachment.id], contextRefs,
    });
    expect(sent.status, JSON.stringify(sent.json)).toBe(202);
    const plan = await waitFor(() => {
      const current = t.app.store.listSessionPlans(target.sessionId)[0];
      return current?.status === 'review' && t.app.runtime.activeCount() === 0 ? current : undefined;
    }, 5000, 'targeted group plan');
    expect(planRuns).toHaveLength(1);
    expect(planRuns[0]!.session.id).toBe(target.sessionId);
    expect(planRuns[0]!.prompt).toContain('one client per cursor');
    expect(planRuns[0]!.prompt).toContain(fileContents.trim());
    expect(planRuns[0]!.attachments?.map((item) => item.id)).toContain(attachment.id);
    expect(t.app.runtime.activeCount()).toBe(0);

    expect((await t.api('POST', `/api/plans/${plan.id}/approve`, { revision: 1 })).status).toBe(200);
    expect((await t.api('POST', `/api/plans/${plan.id}/execute`, {})).status).toBe(202);
    await waitFor(() => t.app.store.getSessionPlan(plan.id)?.status === 'completed' && t.app.runtime.activeCount() === 0, 5000, 'targeted group plan execution');
    expect(executionRuns).toHaveLength(1);
    expect(executionRuns[0]!.session.id).toBe(target.sessionId);
    expect(executionRuns[0]!.prompt).toContain('one client per cursor');
    expect(executionRuns[0]!.prompt).toContain(fileContents.trim());
    expect(executionRuns[0]!.attachments?.map((item) => item.id)).toContain(attachment.id);
    expect(observedBytes).toHaveLength(2);
    expect(observedBytes.every((bytes) => bytes.equals(attachmentBytes))).toBe(true);

    const snapshot = t.app.groups.get(groupId);
    const planRequest = snapshot.requests.find((request) => request.intent === 'plan')!;
    const executionRequest = snapshot.requests.find((request) => request.executionPlanId === plan.id)!;
    expect(planRequest).toMatchObject({ plannerMemberId: target.id, intent: 'plan' });
    expect(executionRequest).toMatchObject({ executionPlanId: plan.id });
    expect(snapshot.deliveries.filter((delivery) => delivery.requestId === planRequest.id || delivery.requestId === executionRequest.id)
      .every((delivery) => delivery.memberId === target.id)).toBe(true);
    expect(snapshot.members.find((member) => member.id === anchor.id)).toBeDefined();
  });
});
