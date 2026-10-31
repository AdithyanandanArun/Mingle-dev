import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLE_CLIENT_SESSION_ID, EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { deferred, makeRepo, runGit, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const boot = async (options: Parameters<typeof startTestApp>[0] = {}) => { const t = await startTestApp(options); apps.push(t); return t; };
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

const session = async (t: TestApp, id = EXAMPLE_CONTRACT_SESSION_ID) => (await t.api('GET', '/api/bootstrap')).json.sessions.find((s: any) => s.id === id);
const messages = async (t: TestApp, id = EXAMPLE_CONTRACT_SESSION_ID) => (await t.api('GET', `/api/sessions/${id}/messages`)).json as any[];

describe('session creation', () => {
  it('creates isolated worktrees with unique branches, and explains non-repo and unborn failures', async () => {
    const t = await boot({ exampleWorkspace: false });
    const repo = makeRepo();
    const project = (await t.api('POST', '/api/projects', { name: 'repo', path: repo })).json;
    const body = { projectId: project.id, name: 'Same name', provider: 'claude', model: 'claude-sonnet-5-5' };
    const a = (await t.api('POST', '/api/sessions', body)).json;
    const b = (await t.api('POST', '/api/sessions', body)).json;
    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.branch).not.toBe(b.branch);
    expect(a.branch).toMatch(/^mingle\/same-name-/);
    expect(a.worktreePath).not.toBe(project.path);
    expect(t.app.store.db.prepare('SELECT base_revision FROM session_worktree_bases WHERE session_id=?').get(a.id))
      .toMatchObject({ base_revision: runGit(a.worktreePath, 'rev-parse', 'HEAD').trim() });

    const plain = (await t.api('POST', '/api/projects', { name: 'plain', path: (await import('./test-utils.ts')).tmpDir() })).json;
    const nonRepo = await t.api('POST', '/api/sessions', { ...body, projectId: plain.id });
    expect(nonRepo.status).toBe(422);
    expect(nonRepo.json.error).toMatch(/not a Git repository/);
    const direct = await t.api('POST', '/api/sessions', { ...body, projectId: plain.id, isolated: false });
    expect(direct.json).toMatchObject({ isolated: false, worktreePath: plain.path, branch: null });

    const { tmpDir, runGit: runGitForUnborn } = await import('./test-utils.ts');
    const unborn = tmpDir();
    runGitForUnborn(unborn, 'init', '-q');
    const emptyProject = (await t.api('POST', '/api/projects', { name: 'unborn', path: unborn })).json;
    const res = await t.api('POST', '/api/sessions', { ...body, projectId: emptyProject.id });
    expect(res.status).toBe(422);
    expect(res.json.error).toMatch(/no commits/);
  });

  it('renames and archives metadata without removing the worktree', async () => {
    const t = await boot();
    const s = await session(t);
    expect((await t.api('PATCH', `/api/sessions/${s.id}`, { name: 'Renamed' })).json.name).toBe('Renamed');
    expect((await t.api('DELETE', `/api/sessions/${s.id}`)).json).toEqual({ ok: true });
    const state = (await t.api('GET', '/api/bootstrap')).json;
    expect(state.sessions.find((x: any) => x.id === s.id)).toBeUndefined();
    expect(state.tasks.find((x: any) => x.id === 'tsk_example_contract').sessionId).toBeNull();
    expect((await import('node:fs')).existsSync(s.worktreePath)).toBe(true);
    expect((await t.api('POST', `/api/sessions/${s.id}/messages`, { content: 'hi' })).status).toBe(404);
  });
});

describe('provider runs', () => {
  it('persists and drains queued messages in order after a run ends', async () => {
    const t=await boot(); const gate=deferred(); t.fake.script=async()=>{await gate.promise;};
    await t.api('POST',`/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`,{content:'first'});
    await waitFor(()=>t.fake.runs.length===1);
    const a=await t.api('POST',`/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`,{content:'second'});
    const b=await t.api('POST',`/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`,{content:'third'});
    expect(a.json.queued).toBeTruthy(); expect(b.json.queued).toBeTruthy();
    expect((await t.api('GET','/api/bootstrap')).json.queuedMessages.map((m:any)=>m.content)).toEqual(['second','third']);
    gate.resolve(); await waitFor(()=>t.fake.runs.length===3);
    expect(t.fake.runs.map((r:any)=>r.prompt)).toEqual(expect.arrayContaining(['second','third']));
  });
  it('resolves queued skills into the provider run options', async () => {
    const t = await boot(); const gate = deferred(); t.fake.script = async () => { await gate.promise; };
    t.fake.catalogSkills = [{ id: 'skill:review', name: 'review', description: 'Review changes', source: 'user', enabled: true, path: '/skills/review' }];
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'first' });
    await waitFor(() => t.fake.runs.length === 1);
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'use review', skills: ['skill:review'] });
    gate.resolve();
    await waitFor(() => t.fake.runs.length === 2);
    expect(t.fake.runs[1]?.skills).toMatchObject([{ id: 'skill:review', enabled: true }]);
  });
  it('keeps queued attachments until drain, binds them to the run, and discards them on removal', async () => {
    const t = await boot(); const gate = deferred(); t.fake.script = async () => { await gate.promise; };
    const sid = EXAMPLE_CONTRACT_SESSION_ID;
    await t.api('POST', `/api/sessions/${sid}/messages`, { content: 'first' }); await waitFor(() => t.fake.runs.length === 1);
    const uploaded = await t.upload(`/api/sessions/${sid}/attachments`, Buffer.from('queue attachment'), 'queued.txt');
    const queued = await t.api('POST', `/api/sessions/${sid}/messages`, { content: 'with file', attachmentIds: [uploaded.json.id] });
    expect(queued.status, JSON.stringify(queued.json)).toBe(202); expect(queued.json.queued).toBeTruthy();
    expect(t.app.attachments.forOwner('message', queued.json.queued.id)).toHaveLength(1);
    gate.resolve(); await waitFor(() => t.fake.runs.length === 2);
    expect(t.fake.runs[1]?.attachments).toMatchObject([{ name: 'queued.txt' }]);
    const startedMessage = t.app.store.listMessages(sid).find((message: any) => message.role === 'user' && message.content === 'with file')!;
    expect(t.app.attachments.forOwner('message', startedMessage.id)).toHaveLength(1);

    const secondGate = deferred(); t.fake.script = async () => { await secondGate.promise; };
    await t.api('POST', `/api/sessions/${sid}/messages`, { content: 'second' }); await waitFor(() => t.fake.runs.length === 3);
    const uploaded2 = await t.upload(`/api/sessions/${sid}/attachments`, Buffer.from('remove attachment'), 'remove.txt');
    const removable = await t.api('POST', `/api/sessions/${sid}/messages`, { content: 'remove me', attachmentIds: [uploaded2.json.id] });
    expect(removable.status, JSON.stringify(removable.json)).toBe(202); expect(removable.json.queued).toBeTruthy();
    const removed = await t.api('DELETE', `/api/sessions/${sid}/queue/${removable.json.queued.id}`);
    expect(removed.status, JSON.stringify(removed.json)).toBe(200);
    expect(t.app.attachments.repo.getRow(uploaded2.json.id)).toBeUndefined();
    secondGate.resolve();
  });
  it('send-now waits for provider cleanup before starting the selected item', async () => {
    const t = await boot({ runtime: { abortGraceMs: 40 } }); const gate = deferred();
    t.fake.script = async () => { await gate.promise; };
    const sid = EXAMPLE_CONTRACT_SESSION_ID;
    await t.api('POST', `/api/sessions/${sid}/messages`, { content: 'first' }); await waitFor(() => t.fake.runs.length === 1);
    const queued = await t.api('POST', `/api/sessions/${sid}/messages`, { content: 'next' });
    await t.api('POST', `/api/sessions/${sid}/queue/${queued.json.queued.id}/send-now`);
    await waitFor(async () => (await session(t, sid)).status === 'interrupted');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(t.fake.runs).toHaveLength(1);
    gate.resolve(); await waitFor(() => t.fake.runs.length === 2);
  });
  it('requeues a failed automatic drain at the front and records a notice', async () => {
    const t = await boot(); const gate = deferred(); const sid = EXAMPLE_CONTRACT_SESSION_ID;
    t.fake.script = async () => { await gate.promise; };
    await t.api('POST', `/api/sessions/${sid}/messages`, { content: 'first' }); await waitFor(() => t.fake.runs.length === 1);
    const first = await t.api('POST', `/api/sessions/${sid}/messages`, { content: 'drain fails' });
    const second = await t.api('POST', `/api/sessions/${sid}/messages`, { content: 'later' });
    (await import('node:fs')).rmSync((await session(t, sid)).worktreePath, { recursive: true, force: true });
    gate.resolve();
    await waitFor(() => t.app.store.listQueuedMessages(sid).length === 2);
    expect(t.app.store.listQueuedMessages(sid).map((item) => item.id)).toEqual([first.json.queued.id, second.json.queued.id]);
    await waitFor(() => t.app.store.listEvents().some((event: any) => event.sessionId === sid && event.type === 'session.queue.start-failed'));
    expect(t.app.store.listEvents().some((event: any) => event.sessionId === sid && event.type === 'session.queue.start-failed')).toBe(true);
  });
  it('streams deltas durably, finalises messages and tracks usage', async () => {
    const t = await boot();
    const gate = deferred();
    t.fake.script = async (_o, emit) => { emit({ type: 'text', text: 'Hel' }); emit({ type: 'text', text: 'lo' }); await gate.promise; emit({ type: 'text', text: '!' }); emit({ type: 'usage', inputTokens: 7, outputTokens: 3, costUsd: null }); };
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'go' });
    // Partial text is durable before the run ends (flush interval is 20ms in tests).
    const partial = await waitFor(async () => (await messages(t)).find((m) => m.role === 'assistant' && m.content === 'Hello'));
    expect(partial.kind).toBe('streaming');
    expect((await session(t)).status).toBe('running');
    gate.resolve();
    await waitFor(async () => (await session(t)).status === 'idle');
    const final = (await messages(t)).filter((m) => m.role === 'assistant');
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ content: 'Hello!' });
    expect(final[0].kind).toBeUndefined();
    expect(await session(t)).toMatchObject({ inputTokens: 7, outputTokens: 3, costUsd: null });
    expect(t.fake.runs[0]!.session.worktreePath).toBe((await session(t)).worktreePath);
  });

  it('queues concurrent sends without overlapping provider promises', async () => {
    const t = await boot();
    const gate = deferred();
    t.fake.script = async () => { if(t.fake.runs.length===1) await gate.promise; };
    const url = `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`;
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => t.api('POST', url, { content: `msg ${i}` })));
    expect(results.filter((r) => r.status === 202)).toHaveLength(6);
    expect(results.slice(1).every((r) => Boolean(r.json.queued))).toBe(true);
    await waitFor(() => t.fake.runs.length === 1);
    expect(t.fake.runs).toHaveLength(1);
    gate.resolve();
    await waitFor(async () => t.fake.runs.length===6 && (await session(t)).status === 'idle' && t.app.runtime.activeCount() === 0);
    const next = await t.api('POST', url, { content: 'again' });
    expect(next.status).toBe(202); // allowed after completion
    await waitFor(async () => t.fake.runs.length === 7);
  }, 15000);

  it('cancels a run, keeps partial text, and settles as interrupted', async () => {
    const t = await boot();
    t.fake.script = async (o, emit) => {
      emit({ type: 'text', text: 'working…' });
      await new Promise<void>((_, reject) => o.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'go' });
    await waitFor(async () => (await messages(t)).some((message) => message.role === 'assistant' && message.content === 'working…'));
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/interrupt`)).json).toEqual({ ok: true });
    await waitFor(async () => (await session(t)).status === 'interrupted');
    const partial = (await messages(t)).find((m) => m.role === 'assistant');
    expect(partial).toMatchObject({ content: 'working…', kind: 'partial' });
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/interrupt`)).json).toEqual({ ok: true }); // idempotent
    await waitFor(() => t.app.runtime.activeCount() === 0);
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'retry' })).status).toBe(202);
  });

  it('keeps an unresponsive adapter locked after declaring its visible run interrupted', async () => {
    const t = await boot();
    const cleanup = deferred();
    t.fake.script = async () => { await cleanup.promise; };
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'go' });
    await waitFor(() => t.fake.runs.length === 1);
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/interrupt`);
    await waitFor(async () => (await session(t)).status === 'interrupted', 3000);
    expect(t.app.runtime.activeCount()).toBe(1);
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'too soon' })).status).toBe(409);
    cleanup.resolve();
    await waitFor(() => t.app.runtime.activeCount() === 0);
    t.fake.script = async () => undefined;
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'after cleanup' })).status).toBe(202);
  });

  it('cancels before provider dispatch when interrupted during run setup', async () => {
    const t = await boot();
    t.app.runtime.start(EXAMPLE_CONTRACT_SESSION_ID, 'cancel during setup');
    expect(t.app.runtime.interrupt(EXAMPLE_CONTRACT_SESSION_ID)).toBe(true);
    await waitFor(async () => (await session(t)).status === 'interrupted');
    expect(t.fake.runs).toHaveLength(0);
    await waitFor(() => t.app.runtime.activeCount() === 0);
  });

  it('records adapter failures (sync and async) with redacted errors and lets the session run again', async () => {
    const t = await boot();
    t.fake.script = async () => { throw new Error('boom sk-ant-api03-SECRETSECRETSECRET'); };
    const url = `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`;
    const first = await t.api('POST', url, { content: 'go' });
    expect(first.status).toBe(202);
    await waitFor(async () => (await session(t)).status === 'error' && t.app.runtime.activeCount() === 0);
    const failed = await session(t);
    expect(failed.error).toContain('boom');
    expect(failed.error).not.toContain('SECRETSECRET');
    expect((await messages(t)).some((m) => m.kind === 'error')).toBe(true);
    t.fake.createAdapter = () => { throw new Error('no adapter'); };
    const second = await t.api('POST', url, { content: 'again' });
    expect(second.status).toBe(202);
    await waitFor(async () => (await session(t)).error === 'no adapter' && t.app.runtime.activeCount() === 0);
    expect((await session(t)).status).toBe('error');
  });

  it('isolates sessions: one run does not block or leak into another', async () => {
    const t = await boot();
    const gate = deferred();
    t.fake.script = async (o, emit) => { emit({ type: 'text', text: `from ${o.session.id}` }); if (o.session.id === EXAMPLE_CONTRACT_SESSION_ID) await gate.promise; };
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'a' });
    await t.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`, { content: 'b' });
    await waitFor(async () => (await session(t, EXAMPLE_CLIENT_SESSION_ID)).status === 'idle');
    expect((await session(t)).status).toBe('running');
    expect((await messages(t, EXAMPLE_CLIENT_SESSION_ID)).map((m) => m.content)).toContain(`from ${EXAMPLE_CLIENT_SESSION_ID}`);
    expect((await messages(t)).map((m) => m.content)).not.toContain(`from ${EXAMPLE_CLIENT_SESSION_ID}`);
    gate.resolve();
  });

  it('refuses to start when the worktree is gone', async () => {
    const t = await boot();
    const s = await session(t);
    (await import('node:fs')).rmSync(s.worktreePath, { recursive: true, force: true });
    const res = await t.api('POST', `/api/sessions/${s.id}/messages`, { content: 'hi' });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/worktree/);
    expect(t.fake.runs).toHaveLength(0);
  });
});

describe('approvals', () => {
  const pending = async (t: TestApp) => (await t.api('GET', '/api/bootstrap')).json.approvals.filter((a: any) => a.status === 'pending');

  it('routes approval requests to the host and resumes the run with the decision', async () => {
    const t = await boot();
    const decisions: boolean[] = [];
    t.fake.script = async (o) => {
      decisions.push(await o.requestApproval({ tool: 'Bash', description: 'run tests', input: { command: 'pnpm test' } }));
      decisions.push(await o.requestApproval({ tool: 'Edit', description: 'edit file', input: {} }));
    };
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'go' });
    const first = (await waitFor(async () => (await pending(t))[0]));
    expect(first).toMatchObject({ tool: 'Bash', input: { command: 'pnpm test' }, sessionId: EXAMPLE_CONTRACT_SESSION_ID });
    expect((await session(t)).status).toBe('waiting');
    expect((await t.api('POST', `/api/approvals/${first.id}`, { decision: 'approved' })).json.status).toBe('approved');
    expect((await t.api('POST', `/api/approvals/${first.id}`, { decision: 'denied' })).status).toBe(409); // already decided
    const second = await waitFor(async () => (await pending(t))[0]);
    await t.api('POST', `/api/approvals/${second.id}`, { decision: 'denied' });
    await waitFor(async () => (await session(t)).status === 'idle');
    expect(decisions).toEqual([true, false]);
  });

  it('denies pending approvals on interrupt and rejects them as stale afterwards', async () => {
    const t = await boot();
    let result: boolean | null = null;
    t.fake.script = async (o) => { result = await o.requestApproval({ tool: 'Bash', description: 'x', input: {} }); };
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'go' });
    const approval = await waitFor(async () => (await pending(t))[0]);
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/interrupt`);
    await waitFor(async () => result === false);
    await waitFor(async () => (await session(t)).status === 'interrupted');
    const stored = (await t.api('GET', '/api/bootstrap')).json.approvals.find((a: any) => a.id === approval.id);
    expect(stored.status).toBe('denied');
    const late = await t.api('POST', `/api/approvals/${approval.id}`, { decision: 'approved' });
    expect(late.status).toBe(409);
    expect((await t.api('GET', '/api/events')).json.map((e: any) => e.type)).toContain('approval.denied');
    expect((await t.api('POST', '/api/approvals/missing', { decision: 'approved' })).status).toBe(404);
    expect((await t.api('POST', `/api/approvals/${approval.id}`, { decision: 'maybe' })).status).toBe(400);
  });

  it('answers approval requests made after cancellation with a denial', async () => {
    const t = await boot();
    let late: boolean | null = null;
    t.fake.script = async (o) => {
      await new Promise<void>((resolve) => o.signal.addEventListener('abort', () => resolve(), { once: true }));
      late = await o.requestApproval({ tool: 'Bash', description: 'late', input: {} });
    };
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'go' });
    await waitFor(async () => t.fake.runs.length === 1);
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/interrupt`);
    await waitFor(async () => late === false);
    expect(await pending(t)).toHaveLength(0);
  });
});
