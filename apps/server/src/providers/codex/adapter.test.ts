import { describe, expect, it } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { createCodexAdapter, type CodexTimeouts } from './adapter.js';
import { FakeChild, type FakeChildOptions, type Json } from '../testing/fake-child.js';
import { makeRun, text, waitFor } from '../testing/helpers.js';

const FAST: Partial<CodexTimeouts> = { initializeMs: 300, threadMs: 300, turnStartMs: 300, interruptMs: 100, interruptGraceMs: 80, shutdownGraceMs: 40, termMs: 60, killMs: 60 };
const resolved = async () => ({ ok: true as const, executable: { path: '/fake/codex', version: '9.9.9', source: 'path' as const, skipped: [] } });

type Handler = (message: Json, child: FakeChild) => void;

/** Answers the setup handshake and delegates everything else to `script`. */
function server(script: Handler = () => undefined): NonNullable<FakeChildOptions['onMessage']> {
  return (message, child) => {
    switch (message.method) {
      case 'initialize': return child.reply(message, { userAgent: 'fake' });
      case 'model/list': return child.reply(message, { data: [{ model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({ reasoningEffort })) }], nextCursor: null });
      case 'thread/start': return child.reply(message, { thread: { id: 'thr_1' }, model: message.params.model });
      case 'thread/resume': return child.reply(message, { thread: { id: message.params.threadId } });
      case 'turn/start':
        child.reply(message, { turn: { id: 'turn_1', status: 'inProgress', items: [] } });
        return script(message, child);
      default: return script(message, child);
    }
  };
}

function setup(onMessage: NonNullable<FakeChildOptions['onMessage']>, childOptions: FakeChildOptions = {}, timeouts: Partial<CodexTimeouts> = FAST) {
  const child = new FakeChild({ ...childOptions, onMessage });
  const spawned: { file: string; args: string[]; options: SpawnOptions }[] = [];
  const adapter = createCodexAdapter({
    spawn: (file, args, options) => { spawned.push({ file, args, options }); return child; },
    resolveExecutable: resolved, env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-should-not-leak-0000', HOME: '/home/x' }, timeouts,
  });
  return { child, adapter, spawned };
}

const completed = (status = 'completed', error?: unknown) => ({ threadId: 'thr_1', turn: { id: 'turn_1', status, items: [], error } });

describe('codex adapter', () => {
  it('runs a full turn: handshake, policy, streaming text, tools, approvals and usage', async () => {
    const run = makeRun({ session: { policy: 'balanced', effort: 'medium' }, prompt: 'Fix the bug' });
    const { child, adapter, spawned } = setup(server((message, c) => {
      if (message.method === 'turn/start') {
        c.notify('thread/tokenUsage/updated', { threadId: 'thr_1', turnId: 'turn_1', tokenUsage: { total: { inputTokens: 1000, outputTokens: 50 }, last: { inputTokens: 200, outputTokens: 50 } } });
        c.notify('item/agentMessage/delta', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'm1', delta: 'Looking' });
        c.notify('item/agentMessage/delta', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'm1', delta: ' now.' });
        c.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'commandExecution', id: 'c1', command: 'npm test', cwd: '/w', status: 'inProgress' } });
        c.serverRequest(7, 'item/commandExecution/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'c1', command: 'npm test', cwd: '/w' });
      } else if (message.id === 7) {
        c.notify('item/completed', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'commandExecution', id: 'c1', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: 'ok\n' } });
        c.notify('item/completed', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'agentMessage', id: 'm1', text: 'Looking now.' } });
        c.notify('item/completed', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'agentMessage', id: 'm2', text: 'Done.' } });
        c.notify('thread/tokenUsage/updated', { threadId: 'thr_1', turnId: 'turn_1', tokenUsage: { total: { inputTokens: 1500, outputTokens: 120 }, last: { inputTokens: 500, outputTokens: 70 } } });
        c.notify('turn/completed', completed());
      }
    }));
    await adapter.run(run.options);

    expect(spawned[0]).toMatchObject({ file: '/fake/codex', args: ['app-server'] });
    expect(spawned[0]?.options.cwd).toBe('/tmp/relay-test-worktree');
    expect((spawned[0]?.options.env as Record<string, string>).ANTHROPIC_API_KEY).toBeUndefined();

    const [init] = child.requestsFor('initialize');
    expect(init?.params.clientInfo.name).toBe('mingle');
    expect(init?.params.capabilities.experimentalApi).toBe(false);
    expect(child.received.map((m) => m.method).slice(0, 2)).toEqual(['initialize', 'initialized']);
    expect(child.requestsFor('thread/start')[0]?.params).toMatchObject({ model: 'gpt-6.1-sol', cwd: '/tmp/relay-test-worktree', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    const turn = child.requestsFor('turn/start')[0]?.params;
    expect(turn).toMatchObject({ threadId: 'thr_1', model: 'gpt-6.1-sol', effort: 'medium', approvalPolicy: 'on-request', input: [{ type: 'text', text: 'Fix the bug' }] });
    expect(turn.sandboxPolicy).toEqual({ type: 'workspaceWrite', writableRoots: ['/tmp/relay-test-worktree'], networkAccess: false });
    expect(child.responseFor(7)?.result).toEqual({ decision: 'accept' });

    expect(run.events[0]).toEqual({ type: 'session', providerSessionId: 'thr_1' });
    expect(text(run.events)).toBe('Looking now.\n\nDone.');
    expect(run.events.filter((e) => e.type === 'tool.activity').map((e) => e.activity)).toMatchObject([
      { id: 'c1', name: 'shell', category: 'command', status: 'running', command: 'npm test', cwd: '/w' },
      { id: 'c1', name: 'shell', category: 'command', status: 'completed', command: 'npm test', exitCode: 0, output: 'ok\n' },
    ]);
    expect(run.events.at(-1)).toEqual({ type: 'usage', inputTokens: 700, outputTokens: 120, costUsd: null });
    expect(run.approvals[0]).toMatchObject({ tool: 'shell', input: { command: 'npm test', cwd: '/w' } });
    expect(child.closed).toBe(true);
  });

  it('captures spawned Codex thread messages and tools under the spawning call only', async () => {
    const run = makeRun({ prompt: 'Investigate the auth flow' });
    const { child, adapter } = setup(server((message, c) => {
      if (message.method !== 'turn/start') return;
      c.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item: {
        type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', status: 'inProgress', senderThreadId: 'thr_1',
        receiverThreadIds: ['thr_child'], agentsStates: {}, prompt: 'Inspect auth', model: 'gpt-6.1-sol-mini',
      } });
      c.notify('item/agentMessage/delta', { threadId: 'thr_child', turnId: 'turn_child', itemId: 'child-message', delta: 'Auth code is in ' });
      c.notify('item/agentMessage/delta', { threadId: 'thr_child', turnId: 'turn_child', itemId: 'child-message', delta: 'the session service.' });
      c.notify('item/started', { threadId: 'thr_child', turnId: 'turn_child', item: { type: 'commandExecution', id: 'child-command', command: 'rg auth', cwd: '/workspace', status: 'inProgress' } });
      c.notify('item/commandExecution/outputDelta', { threadId: 'thr_child', turnId: 'turn_child', itemId: 'child-command', delta: 'src/session.ts\n' });
      c.notify('item/completed', { threadId: 'thr_child', turnId: 'turn_child', item: { type: 'commandExecution', id: 'child-command', command: 'rg auth', cwd: '/workspace', status: 'completed', exitCode: 0, aggregatedOutput: 'src/session.ts\n' } });
      c.notify('item/completed', { threadId: 'thr_child', turnId: 'turn_child', item: { type: 'agentMessage', id: 'child-message', text: 'Auth code is in the session service.' } });
      c.notify('item/completed', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', status: 'completed', senderThreadId: 'thr_1', receiverThreadIds: ['thr_child'], agentsStates: {}, prompt: 'Inspect auth', model: 'gpt-6.1-sol-mini', output: 'Auth flow located.' } });
      c.notify('item/agentMessage/delta', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'root-message', delta: 'Parent summary.' });
      c.notify('turn/completed', completed());
    }));

    await adapter.run(run.options);

    expect(text(run.events)).toBe('Parent summary.');
    expect(run.events.filter((event) => event.type === 'subagent.text')).toEqual([
      { type: 'subagent.text', parentId: 'spawn-1', messageId: 'thr_child:child-message', text: 'Auth code is in ' },
      { type: 'subagent.text', parentId: 'spawn-1', messageId: 'thr_child:child-message', text: 'the session service.' },
    ]);
    expect(run.events.filter((event) => event.type === 'tool.activity').map((event) => event.activity)).toContainEqual(expect.objectContaining({
      id: 'thr_child:child-command', name: 'shell', category: 'command', status: 'completed', parentId: 'spawn-1', output: 'src/session.ts\n',
    }));
    expect(run.events.filter((event) => event.type === 'tool.output')).toContainEqual({ type: 'tool.output', id: 'thr_child:child-command', delta: 'src/session.ts\n' });
    expect(run.events.filter((event) => event.type === 'tool.activity').map((event) => event.activity)).toContainEqual(expect.objectContaining({
      id: 'spawn-1', category: 'agent', input: expect.stringContaining('gpt-6.1-sol-mini'), output: 'Auth flow located.',
    }));
  });

  it('uses the read-only sandbox for supervised sessions', async () => {
    const run = makeRun({ session: { policy: 'supervised' } });
    const { child, adapter } = setup(server((m, c) => { if (m.method === 'turn/start') c.notify('turn/completed', completed()); }));
    await adapter.run(run.options);
    expect(child.requestsFor('thread/start')[0]?.params.sandbox).toBe('read-only');
    expect(child.requestsFor('turn/start')[0]?.params.sandboxPolicy).toEqual({ type: 'readOnly' });
  });

  it('resumes the stored thread and fails loudly instead of starting a new one', async () => {
    const ok = makeRun({ session: { providerSessionId: 'thr_old' } });
    const a = setup(server((m, c) => { if (m.method === 'turn/start') c.notify('turn/completed', { threadId: 'thr_old', turn: { id: 'turn_1', status: 'completed', items: [] } }); }));
    await a.adapter.run(ok.options);
    expect(a.child.requestsFor('thread/resume')[0]?.params).toMatchObject({ threadId: 'thr_old', excludeTurns: true, model: 'gpt-6.1-sol' });
    expect(a.child.requestsFor('thread/start')).toHaveLength(0);

    const bad = makeRun({ session: { providerSessionId: 'thr_gone' } });
    const b = setup((message, c) => {
      if (message.method === 'initialize') c.reply(message, {});
      if (message.method === 'model/list') c.reply(message, { data: [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({ reasoningEffort })) }] });
      if (message.method === 'thread/resume') c.fail(message, -32600, 'no rollout found for thread id thr_gone');
    });
    await expect(b.adapter.run(bad.options)).rejects.toMatchObject({ code: 'resume_failed', message: expect.stringContaining('no rollout found') });
    expect(b.child.requestsFor('thread/start')).toHaveLength(0);
    expect(b.child.requestsFor('turn/start')).toHaveLength(0);
    expect(bad.events).toEqual([]);
  });

  it('answers approvals with the documented decisions and denies on every failure path', async () => {
    const run = makeRun({ approve: (request) => { if (request.tool === 'shell') throw new Error('host broke'); return request.tool !== 'file_change'; } });
    const { child, adapter } = setup(server((message, c) => {
      if (message.method === 'turn/start') {
        c.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: 'src/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@' }] } });
        c.serverRequest(1, 'item/commandExecution/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'c1', command: 'curl x' });
        c.serverRequest(2, 'item/fileChange/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'f1', grantRoot: '/etc' });
        c.serverRequest(3, 'item/permissions/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'p1', permissions: { network: { enabled: true } } });
        c.serverRequest(4, 'item/commandExecution/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'n1', networkApprovalContext: { host: 'example.com', protocol: 'https' } });
        c.serverRequest(5, 'mcpServer/elicitation/request', { threadId: 'thr_1', serverName: 'docs', message: 'pick one' });
        c.serverRequest(6, 'item/tool/requestUserInput', { threadId: 'thr_1', questions: [] });
        c.serverRequest(8, 'execCommandApproval', { conversationId: 'thr_1', callId: 'x', command: ['ls'], cwd: '/w', parsedCmd: [] });
      }
      if (message.id === 8 && message.method === undefined) c.notify('turn/completed', completed());
    }));
    await adapter.run(run.options);
    const answer = (id: number) => child.responseFor(id);
    expect(answer(1)?.result).toEqual({ decision: 'decline' }); // callback threw: fail closed
    expect(answer(2)?.result).toEqual({ decision: 'decline' });
    expect(answer(3)?.result).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
    expect(answer(4)?.result).toEqual({ decision: 'accept' });
    expect(answer(5)?.result).toEqual({ action: 'decline', content: null });
    expect(answer(6)).toMatchObject({ error: { code: -32601 } });
    expect(answer(8)?.result).toEqual({ decision: 'denied' }); // legacy exec approval is a shell call; the callback threw, so fail closed
  });

  it('denies a legacy exec approval when the host says no', async () => {
    const run = makeRun({ approve: () => false });
    const { child, adapter } = setup(server((message, c) => {
      if (message.method === 'turn/start') c.serverRequest(9, 'applyPatchApproval', { conversationId: 'thr_1', callId: 'y', fileChanges: { 'a.txt': {} } });
      if (message.id === 9 && message.method === undefined) c.notify('turn/completed', completed());
    }));
    await adapter.run(run.options);
    expect(child.responseFor(9)?.result).toEqual({ decision: 'denied' });
    expect(run.approvals[0]).toMatchObject({ tool: 'file_change' });
  });

  it('describes file changes and extra grants in the approval prompt', async () => {
    const run = makeRun({ approve: () => false });
    const { child, adapter } = setup(server((message, c) => {
      if (message.method === 'turn/start') {
        c.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ patch @@' }] } });
        c.serverRequest(2, 'item/fileChange/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'f1', grantRoot: '/srv/data', reason: 'needs write' });
      }
      if (message.id === 2 && message.method === undefined) c.notify('turn/completed', completed());
    }));
    await adapter.run(run.options);
    expect(child.responseFor(2)?.result).toEqual({ decision: 'decline' });
    expect(run.approvals[0]?.description).toContain('update src/a.ts');
    expect(run.approvals[0]?.description).toContain('/srv/data');
    expect(run.approvals[0]?.input).toMatchObject({ grantRoot: '/srv/data', changes: [{ path: 'src/a.ts', kind: 'update', diff: '@@ patch @@' }] });
  });

  it('interrupts an active turn with turn/interrupt and rejects with AbortError', async () => {
    const run = makeRun();
    const { child, adapter } = setup(server((message, c) => {
      if (message.method === 'turn/start') c.notify('item/agentMessage/delta', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'm', delta: 'working' });
      if (message.method === 'turn/interrupt') { c.reply(message, {}); c.notify('turn/completed', completed('interrupted')); }
    }));
    const promise = adapter.run(run.options);
    await waitFor(() => text(run.events) === 'working');
    run.controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(child.requestsFor('turn/interrupt')[0]?.params).toEqual({ threadId: 'thr_1', turnId: 'turn_1' });
    expect(child.signals).toEqual([]); // exited by itself once stdin closed
    expect(child.closed).toBe(true);
  });

  it('escalates SIGTERM then SIGKILL when Codex ignores the interrupt', async () => {
    const run = makeRun();
    const { child, adapter } = setup(server(), { diesOn: ['SIGKILL'], exitsOnStdinEnd: false });
    const promise = adapter.run(run.options);
    await waitFor(() => child.requestsFor('turn/start').length === 1);
    run.controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(child.requestsFor('turn/interrupt')).toHaveLength(1);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(child.closed).toBe(true);
  });

  it('aborts during setup without ever starting a turn', async () => {
    const run = makeRun();
    const { child, adapter } = setup((message) => { if (message.method === 'initialize') run.controller.abort(); });
    await expect(adapter.run(run.options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(child.requestsFor('turn/start')).toHaveLength(0);
    expect(child.closed).toBe(true);
  });

  it('rejects immediately for an already aborted signal without spawning', async () => {
    const run = makeRun();
    run.controller.abort();
    const { adapter, spawned } = setup(server());
    await expect(adapter.run(run.options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawned).toHaveLength(0);
  });

  it('rejects when the process exits mid-turn and reports redacted stderr', async () => {
    const run = makeRun();
    const { adapter } = setup(server((message, c) => {
      if (message.method === 'turn/start') {
        c.log('panic: ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop leaked while Authorization: Bearer abcdefghijklmnopqrstuvwx\n');
        setTimeout(() => c.exit(101), 10);
      }
    }));
    const error = await adapter.run(run.options).catch((e: Error) => e);
    expect(error).toMatchObject({ code: 'process_exited' });
    expect((error as Error).message).toContain('code 101');
    expect((error as Error).message).toContain('panic');
    expect((error as Error).message).not.toMatch(/abcdefghijklmnop/);
  });

  it('rejects pending requests when the process dies during initialize', async () => {
    const run = makeRun();
    const { adapter } = setup((message, c) => { if (message.method === 'initialize') { c.log('config error: bad toml'); c.exit(2); } });
    await expect(adapter.run(run.options)).rejects.toMatchObject({ code: 'process_exited', message: expect.stringContaining('bad toml') });
  });

  it('times out a silent initialize and cleans up the process', async () => {
    const run = makeRun();
    const { child, adapter } = setup(() => undefined);
    await expect(adapter.run(run.options)).rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('initialize') });
    expect(child.closed).toBe(true);
  });

  it('reports a spawn failure', async () => {
    const run = makeRun();
    const child = new FakeChild();
    const adapter = createCodexAdapter({ spawn: () => { setImmediate(() => child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }))); return child; }, resolveExecutable: resolved, env: {}, timeouts: FAST });
    await expect(adapter.run(run.options)).rejects.toMatchObject({ code: 'process_exited', message: expect.stringContaining('ENOENT') });
  });

  it('surfaces an unavailable executable', async () => {
    const adapter = createCodexAdapter({ resolveExecutable: async () => ({ ok: false, reason: 'No working codex executable found.', skipped: [] }), env: {} });
    await expect(adapter.run(makeRun().options)).rejects.toMatchObject({ code: 'executable_unavailable' });
  });

  it('fails with the server error details when the turn fails', async () => {
    const run = makeRun();
    const { adapter } = setup(server((m, c) => {
      if (m.method === 'turn/start') {
        c.notify('error', { threadId: 'thr_1', turnId: 'turn_1', willRetry: true, error: { message: 'stream dropped' } });
        c.notify('turn/completed', completed('failed', { message: 'Usage limit reached', codexErrorInfo: 'usageLimitExceeded' }));
      }
    }));
    await expect(adapter.run(run.options)).rejects.toMatchObject({ code: 'turn_failed', message: 'Usage limit reached [usageLimitExceeded]' });
    expect(run.events.some((e) => e.type === 'info' && e.content.includes('stream dropped'))).toBe(true);
  });

  it('steers the active native turn with expected thread and turn ids', async () => {
    const run = makeRun(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const { child, adapter } = setup(server((m, c) => {
      if (m.method === 'turn/start') { void gate.then(() => c.notify('turn/completed', completed())); }
      if (m.method === 'turn/steer') c.reply(m, {});
    }));
    const running = adapter.run(run.options);
    await waitFor(() => child.requestsFor('turn/start').length === 1);
    await adapter.steer!('Please focus on the failing test');
    expect(child.requestsFor('turn/steer')[0]?.params).toEqual({ threadId: 'thr_1', input: [{ type: 'text', text: 'Please focus on the failing test', text_elements: [] }], expectedTurnId: 'turn_1' });
    release(); await running;
  });

  it('stops the run instead of accepting a service-side model substitution', async () => {
    const run = makeRun();
    const { child, adapter } = setup(server((m, c) => {
      if (m.method === 'turn/start') c.notify('model/rerouted', { threadId: 'thr_1', turnId: 'turn_1', fromModel: 'gpt-6.1-sol', toModel: 'gpt-5.6-luna', reason: 'highRiskCyberActivity' });
      if (m.method === 'turn/interrupt') { c.reply(m, {}); c.notify('turn/completed', completed('interrupted')); }
    }));
    await expect(adapter.run(run.options)).rejects.toMatchObject({ code: 'model_substitution' });
    expect(child.requestsFor('turn/interrupt')).toHaveLength(1);
  });

  it('ignores notifications for other threads and tolerates malformed lines', async () => {
    const run = makeRun();
    const { child, adapter } = setup(server((m, c) => {
      if (m.method === 'turn/start') {
        c.stdout.write('not json at all\n');
        c.notify('item/agentMessage/delta', { threadId: 'other', turnId: 'x', itemId: 'z', delta: 'LEAK' });
        c.notify('turn/completed', { threadId: 'other', turn: { id: 'x', status: 'failed', items: [] } });
        c.notify('item/agentMessage/delta', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'm', delta: 'mine' });
        c.notify('turn/completed', completed());
      }
    }));
    await adapter.run(run.options);
    expect(text(run.events)).toBe('mine');
    expect(run.events.some((e) => e.type === 'info' && e.content.includes('non-JSON'))).toBe(true);
    expect(child.closed).toBe(true);
  });
});
