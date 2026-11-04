import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Bootstrap, ServerEvent, SessionPlan, SessionSnapshot, ToolCall, UserQuestion } from '@mingle/contracts';
import { MAX_SCOPED_SESSIONS } from '@mingle/contracts';
import { GroupRepo } from './groups/repo.ts';
import { makeRepo, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

const toolCall = (runId: string, sessionId: string, n: number, output = 'x'.repeat(30)): ToolCall => ({
  id: `tool_${runId}_${n}`, runId, sessionId, providerId: `p${n}`, parentProviderId: null, name: 'Bash', category: 'command', status: 'completed',
  summary: `call ${n}`, command: `echo ${n}`, input: '{}', output, cwd: null, exitCode: 0, processId: null,
  startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 5,
});

/** A project with many sessions whose histories exceed every bootstrap cap, so slice equality is tested at the limits. */
async function workspace(sessionCount: number, messagesPer: number) {
  const t = await startTestApp();
  apps.push(t);
  const store = t.app.store;
  const project = store.insertProject({ name: 'Snapshot fixture (example)', path: makeRepo() });
  const sessions = Array.from({ length: sessionCount }, (_, index) => store.insertSession({
    projectId: project.id, name: `Example ${index}`, provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', policy: 'supervised', isolated: false, worktreePath: project.path, branch: 'main',
  }));
  store.tx(() => {
    for (const session of sessions) {
      for (let i = 0; i < messagesPer; i++) store.insertMessage({ sessionId: session.id, role: i % 2 ? 'assistant' : 'user', content: `${session.name} message ${i} ${'lorem ipsum '.repeat(20)}` });
    }
  });
  return { t, store, project, sessions };
}

const bootstrap = async (t: TestApp) => (await t.api<Bootstrap>('GET', '/api/bootstrap')).json;
const snapshot = async (t: TestApp, id: string) => t.api<SessionSnapshot>('GET', `/api/sessions/${id}/snapshot`);
const sliceOf = (boot: Bootstrap, id: string) => ({
  session: boot.sessions.find((session) => session.id === id),
  messages: boot.messages.filter((row) => row.sessionId === id),
  runs: boot.runs.filter((row) => row.sessionId === id),
  toolCalls: boot.toolCalls.filter((row) => row.sessionId === id),
  queuedMessages: (boot.queuedMessages ?? []).filter((row) => row.sessionId === id),
  approvals: boot.approvals.filter((row) => row.sessionId === id),
  plans: boot.plans.filter((row) => row.sessionId === id),
  questions: boot.questions.filter((row) => row.sessionId === id),
  workflows: (boot.workflows ?? []).filter((row) => row.sessionId === id),
  delegatedSubagents: (boot.delegatedSubagents ?? []).filter((row) => row.parentSessionId === id),
});
const sliceOfSnapshot = (snap: SessionSnapshot) => {
  const { sessionId: _s, eventCursor: _e, ...rest } = snap;
  return rest;
};

describe('GET /api/sessions/:id/snapshot', () => {
  it('returns exactly the rows a bootstrap carries for that session, including at every global cap', async () => {
    const { t, store, project, sessions } = await workspace(5, 30);
    const [busy, quiet, other] = sessions;
    // Messages beyond the 300-row window for one session.
    store.tx(() => { for (let i = 0; i < 320; i++) store.insertMessage({ sessionId: busy!.id, role: 'user', content: `bulk ${i}` }); });
    // 230 runs interleaved across sessions (global cap 200) with 1,100 tool calls (global cap 1,000), one run still running.
    store.tx(() => {
      for (let i = 0; i < 230; i++) {
        const owner = sessions[i % sessions.length]!;
        const message = store.insertMessage({ sessionId: owner.id, role: 'user', content: `run prompt ${i}` });
        const run = store.insertRun({ id: `run_${i}`, sessionId: owner.id, userMessageId: message.id, provider: 'claude', model: 'claude-sonnet-5-5', startedAt: new Date(2026, 10, 4, 10, 0, i % 60).toISOString() });
        if (i !== 7) store.finishRun(run.id, 'completed', 10);
        for (let n = 0; n < 5; n++) store.putToolCall(toolCall(run.id, owner.id, n, 'out '.repeat(i % 3 ? 10 : 700)));
      }
    });
    // 60 resolved approvals (global cap 50) plus pending ones that must never be capped.
    store.tx(() => {
      for (let i = 0; i < 60; i++) {
        const approval = store.insertApproval({ sessionId: sessions[i % 3]!.id, tool: 'Bash', description: `d${i}`, input: {} });
        store.resolveApproval(approval.id, i % 2 ? 'approved' : 'denied', 'host');
      }
      for (let i = 0; i < 70; i++) store.insertApproval({ sessionId: busy!.id, tool: 'Edit', description: `pending ${i}`, input: {} });
    });
    const plan = (id: string, sessionId: string, runId: string, status: SessionPlan['status']): SessionPlan => ({
      id, sessionId, runId, provider: 'claude', providerPlanId: id, explanation: 'Plan', steps: [{ id: 's1', title: 'Step', description: '', acceptanceCriteria: [], status: 'pending', dependsOn: [], providerId: 's1' }],
      revision: 1, approvedRevision: null, status, executionRunId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    store.saveSessionPlan(plan('plan_a', busy!.id, 'run_0', 'review'));
    store.saveSessionPlan(plan('plan_b', quiet!.id, 'run_1', 'completed'));
    const question: UserQuestion = { id: 'question_a', sessionId: other!.id, runId: 'run_2', provider: 'claude', tool: 'AskUserQuestion', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }], multiSelect: false, allowOther: false, secret: false }], status: 'pending', createdAt: new Date().toISOString(), resolvedAt: null };
    store.insertUserQuestion({ question, nativeRequestId: 'native-1' });
    store.enqueueMessage({ id: 'queued_a', sessionId: busy!.id, content: 'later', intent: 'normal', skills: [], attachmentIds: [], contextRefs: [] });
    store.updateSession(busy!.id, { status: 'running' });

    const boot = await bootstrap(t);
    // The fixture really exceeds every cap, otherwise equality would be vacuous.
    expect(boot.runs).toHaveLength(200);
    expect(boot.toolCalls).toHaveLength(1000);
    expect(boot.messages.filter((row) => row.sessionId === busy!.id)).toHaveLength(300);
    expect(boot.approvals.filter((row) => row.status !== 'pending')).toHaveLength(50);
    expect(project.id).toBeTruthy();

    for (const session of sessions) {
      const snap = await snapshot(t, session.id);
      expect(snap.status).toBe(200);
      expect(sliceOfSnapshot(snap.json)).toEqual(sliceOf(boot, session.id));
    }
    const busySnap = (await snapshot(t, busy!.id)).json;
    expect(busySnap.approvals.filter((row) => row.status === 'pending')).toHaveLength(70);
    expect(busySnap.queuedMessages.map((row) => row.id)).toEqual(['queued_a']);
    expect(busySnap.plans.map((row) => row.id)).toEqual(['plan_a']);
    expect(busySnap.eventCursor).toBeGreaterThanOrEqual(0);
  });

  it('is much smaller than a bootstrap and never runs provider discovery', async () => {
    const { t, store, sessions } = await workspace(30, 150);
    store.tx(() => {
      for (let i = 0; i < 60; i++) {
        const owner = sessions[i % sessions.length]!;
        const message = store.insertMessage({ sessionId: owner.id, role: 'user', content: `p${i}` });
        const run = store.insertRun({ id: `r${i}`, sessionId: owner.id, userMessageId: message.id, provider: 'claude', model: 'claude-sonnet-5-5', startedAt: new Date().toISOString() });
        store.finishRun(run.id, 'completed', 10);
        for (let n = 0; n < 8; n++) store.putToolCall(toolCall(run.id, owner.id, n, 'output '.repeat(80)));
      }
    });
    const bootBytes = JSON.stringify(await bootstrap(t)).length;
    const detections = t.fake.detections;
    const snap = await snapshot(t, sessions[3]!.id);
    const snapBytes = JSON.stringify(snap.json).length;
    expect(t.fake.detections).toBe(detections);
    expect(snapBytes).toBeLessThan(bootBytes / 20);
    // Recorded as fixture evidence in docs/single-agent-refinements.md.
    console.info(`[item4] 30 sessions x 150 messages, 60 runs, 480 tool calls: bootstrap ${bootBytes} bytes, session snapshot ${snapBytes} bytes (${(bootBytes / snapBytes).toFixed(1)}x)`);
  });

  it('refuses sessions whose state spans shared rows and reports unknown or archived sessions as missing', async () => {
    const { t, store, project, sessions } = await workspace(4, 3);
    const [anchor, member, proxy, solo] = sessions;
    const repo = new GroupRepo(store.db);
    repo.insertGroup({ id: 'group_a', projectId: project.id, title: 'Team', anchorSessionId: anchor!.id, mode: 'cowork', maxParallel: 2, maxTurns: 20, maxHops: 5 });
    repo.insertMember({ id: 'm1', groupId: 'group_a', sessionId: anchor!.id, handle: 'one', role: 'worker' });
    repo.insertMember({ id: 'm2', groupId: 'group_a', sessionId: member!.id, handle: 'two', role: 'worker' });
    store.db.prepare(`INSERT INTO mingle_team_proxy_sessions(session_id,team_id,shared_project_id,agent_id,owner_account_id,owner_device_id,handle) VALUES(?,?,?,?,?,?,?)`)
      .run(proxy!.id, 'team', 'shared', 'agent', 'owner', 'device', 'proxy');
    const helper = store.insertSession({ projectId: project.id, name: 'Helper', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', policy: 'supervised', isolated: false, worktreePath: project.path, branch: 'main', parentSessionId: solo!.id });

    for (const refused of [anchor!, member!, proxy!, helper]) {
      const result = await snapshot(t, refused.id);
      expect(result.status, refused.name).toBe(409);
      expect(typeof result.json).toBe('object');
    }
    expect((await snapshot(t, solo!.id)).status).toBe(200);
    expect((await snapshot(t, 'ses_missing')).status).toBe(404);
    expect((await snapshot(t, 'bad%20id')).status).toBe(404);
    store.archiveSession(solo!.id);
    expect((await snapshot(t, solo!.id)).status).toBe(404);
  });

  it('is read-only: it neither records events nor notifies clients', async () => {
    const { t, store, sessions } = await workspace(2, 3);
    const before = store.lastEventId();
    const frames: ServerEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws`);
    ws.on('message', (data) => frames.push(JSON.parse(data.toString()) as ServerEvent));
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 160));
    frames.length = 0;
    await snapshot(t, sessions[0]!.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    ws.close();
    expect(store.lastEventId()).toBe(before);
    expect(frames).toEqual([]);
  });
});

describe('state.changed scoping', () => {
  async function listen(t: TestApp) {
    const frames: Extract<ServerEvent, { type: 'state.changed' }>[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws`);
    ws.on('message', (data) => { const frame = JSON.parse(data.toString()) as ServerEvent; if (frame.type === 'state.changed') frames.push(frame); });
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    const settle = () => new Promise((resolve) => setTimeout(resolve, 160));
    // Startup (provider discovery, example seeding) may still be announcing; scoping is asserted on a quiet stream.
    await settle();
    frames.length = 0;
    return { frames, close: () => ws.close(), settle };
  }

  it('announces session-confined touches as one scoped frame and widens any other touch to a full change', async () => {
    const { t, store, sessions } = await workspace(MAX_SCOPED_SESSIONS + 3, 1);
    const probe = await listen(t);
    store.touch(sessions[0]!.id); store.touch(sessions[1]!.id); store.touch(sessions[0]!.id);
    await probe.settle();
    expect(probe.frames).toEqual([{ type: 'state.changed', scope: { sessionIds: [sessions[0]!.id, sessions[1]!.id] } }]);

    probe.frames.length = 0;
    store.touch(sessions[0]!.id); store.touch(); store.touch(sessions[2]!.id);
    await probe.settle();
    expect(probe.frames).toEqual([{ type: 'state.changed' }]);

    probe.frames.length = 0;
    for (const session of sessions) store.touch(session.id);
    await probe.settle();
    expect(sessions.length).toBeGreaterThan(MAX_SCOPED_SESSIONS);
    expect(probe.frames).toEqual([{ type: 'state.changed' }]);

    probe.frames.length = 0;
    store.touch(sessions[0]!.id);
    await probe.settle();
    expect(probe.frames).toEqual([{ type: 'state.changed', scope: { sessionIds: [sessions[0]!.id] } }]);
    probe.close();
  });

  it('scopes only allowlisted session events; lifecycle, task, group and unknown events stay full changes', async () => {
    const { t, store, project, sessions } = await workspace(2, 1);
    const probe = await listen(t);
    const emit = (type: string, sessionId: string | null) => store.recordEvent({ projectId: project.id, sessionId, type, summary: type });
    emit('approval.requested', sessions[0]!.id);
    emit('session.question.asked', sessions[1]!.id);
    emit('session.progress.status', sessions[0]!.id);
    emit('approval.requested', null);
    for (const type of ['session.run.started', 'session.run.completed', 'task.updated', 'group.created', 'session.workflow.started', 'team.agent.activity.updated', 'something.new']) emit(type, sessions[0]!.id);
    await waitFor(() => probe.frames.length >= 11 || undefined);
    const scoped = probe.frames.filter((frame) => frame.scope).map((frame) => [frame.event?.type, frame.scope?.sessionIds]);
    expect(scoped).toEqual([
      ['approval.requested', [sessions[0]!.id]],
      ['session.question.asked', [sessions[1]!.id]],
      ['session.progress.status', [sessions[0]!.id]],
    ]);
    // Every event frame still carries its record, scoped or not.
    expect(probe.frames.every((frame) => frame.event)).toBe(true);
    probe.close();
  });

  it('scopes high-rate run activity to its session while run start and finish stay full changes', async () => {
    const { t, sessions } = await workspace(2, 1);
    const target = sessions[0]!;
    t.fake.script = async (_options, emit) => {
      emit({ type: 'tool.activity', activity: { id: 'a', name: 'Bash', category: 'command', status: 'running', command: 'ls' } });
      await new Promise((resolve) => setTimeout(resolve, 120));
      emit({ type: 'tool.activity', activity: { id: 'a', name: 'Bash', category: 'command', status: 'completed', output: 'done' } });
      emit({ type: 'usage', inputTokens: 3, outputTokens: 4, costUsd: null });
      emit({ type: 'info', content: 'note' });
      await new Promise((resolve) => setTimeout(resolve, 120));
    };
    const probe = await listen(t);
    expect((await t.api('POST', `/api/sessions/${target.id}/messages`, { content: 'go' })).status).toBe(202);
    await waitFor(() => probe.frames.some((frame) => frame.event?.type === 'session.run.completed') || undefined, 8000);
    await probe.settle();
    const events = probe.frames.filter((frame) => frame.event);
    expect(events.filter((frame) => frame.event!.type.startsWith('session.run.')).every((frame) => !frame.scope)).toBe(true);
    const scoped = probe.frames.filter((frame) => frame.scope && !frame.event);
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((frame) => frame.scope!.sessionIds.length === 1 && frame.scope!.sessionIds[0] === target.id)).toBe(true);
    // The snapshot a client then loads carries what the run produced.
    const snap = (await snapshot(t, target.id)).json;
    expect(snap.toolCalls.find((call) => call.providerId === 'a')?.output).toBe('done');
    expect(snap.session.inputTokens).toBe(3);
    probe.close();
  });
});
