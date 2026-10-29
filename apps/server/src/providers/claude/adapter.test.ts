import { describe, expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeAdapter, type QueryFn } from './adapter.js';
import { makeRun, text, waitFor } from '../testing/helpers.js';

const resolved = async () => ({ ok: true as const, executable: { path: '/fake/claude', version: '2.1.292', source: 'npm-global' as const, skipped: [] } });
const ENV = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-api03-test-key-000000', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-should-be-removed', HOME: '/home/x' };

type Msg = Record<string, unknown>;
const init = (extra: Msg = {}): Msg => ({ type: 'system', subtype: 'init', session_id: 'sess-1', apiKeySource: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5', ...extra });
const streamText = (...deltas: string[]): Msg[] => [
  { type: 'stream_event', session_id: 'sess-1', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg-1' } } },
  { type: 'stream_event', session_id: 'sess-1', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  ...deltas.map((text) => ({ type: 'stream_event', session_id: 'sess-1', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })),
];
const success = (extra: Msg = {}): Msg => ({
  type: 'result', subtype: 'success', is_error: false, result: 'final', session_id: 'sess-1', total_cost_usd: 0.0123,
  usage: { input_tokens: 1, output_tokens: 1 },
  modelUsage: { 'claude-sonnet-5-5': { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 900, cacheCreationInputTokens: 10, costUSD: 0.0123 } },
  ...extra,
});

function adapterFor(messages: Msg[] | ((params: { prompt: string; options: Options }) => AsyncGenerator<unknown, void>), env: NodeJS.ProcessEnv = ENV) {
  const calls: { prompt: string; options: Options }[] = [];
  const closes = vi.fn();
  const query: QueryFn = (params) => {
    calls.push(params);
    const generator = typeof messages === 'function' ? messages(params) : (async function* () { for (const message of messages) yield message; })();
    return Object.assign(generator, { close: closes }) as never;
  };
  return { adapter: createClaudeAdapter({ query, env, resolveExecutable: resolved }), calls, closes };
}

describe('claude adapter', () => {
  it('streams text once, maps tools and usage, and passes model, effort, policy and credentials explicitly', async () => {
    const run = makeRun({ session: { provider: 'claude', model: 'claude-opus-5-5', effort: 'low', policy: 'balanced', providerSessionId: 'sess-1', worktreePath: '/work/tree' }, prompt: 'Refactor' });
    const { adapter, calls, closes } = adapterFor([
      init(),
      ...streamText('Hel', 'lo'),
      { type: 'assistant', session_id: 'sess-1', parent_tool_use_id: null, message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'assistant', session_id: 'sess-1', parent_tool_use_id: null, message: { id: 'msg-1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la' } }] } },
      { type: 'user', session_id: 'sess-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'file.txt' }] }] } },
      ...streamText('Done'),
      success(),
    ]);
    await adapter.run(run.options);

    const { prompt, options } = calls[0]!;
    expect(prompt).toBe('Refactor');
    expect(options).toMatchObject({
      cwd: '/work/tree', model: 'claude-opus-5-5', effort: 'low', permissionMode: 'acceptEdits', resume: 'sess-1',
      includePartialMessages: true, pathToClaudeCodeExecutable: '/fake/claude', settingSources: ['project'], settings: { disableAllHooks: true },
    });
    expect(options.fallbackModel).toBeUndefined();
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.env?.ANTHROPIC_API_KEY).toBe(ENV.ANTHROPIC_API_KEY);
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    expect(run.events[0]).toEqual({ type: 'session', providerSessionId: 'sess-1' });
    expect(text(run.events)).toBe('Hello\n\nDone');
    expect(run.events.filter((e) => e.type === 'tool.activity').map((e) => e.activity)).toMatchObject([
      { id: 'tu1', name: 'Bash', category: 'command', status: 'running', command: 'ls -la' },
      { id: 'tu1', name: 'Bash', category: 'command', status: 'completed', output: 'file.txt' },
    ]);
    expect(run.events.at(-1)).toEqual({ type: 'usage', inputTokens: 1010, outputTokens: 40, costUsd: 0.0123 });
    expect(closes).toHaveBeenCalled();
  });

  it('uses default permission mode for supervised sessions and emits assistant text that was not streamed', async () => {
    const run = makeRun({ session: { provider: 'claude', policy: 'supervised' } });
    const { adapter, calls } = adapterFor([
      init(),
      { type: 'assistant', session_id: 'sess-1', parent_tool_use_id: null, message: { id: 'm9', content: [{ type: 'text', text: 'No streaming here' }] } },
      success(),
    ]);
    await adapter.run(run.options);
    expect(calls[0]!.options.permissionMode).toBe('default');
    expect(text(run.events)).toBe('No streaming here');
  });

  it('captures Claude subagent assistant text by parent tool use without adding it to the main transcript', async () => {
    const run = makeRun({ session: { provider: 'claude' } });
    const { adapter } = adapterFor([
      init(),
      { type: 'assistant', session_id: 'sess-1', parent_tool_use_id: null, message: { id: 'root', content: [{ type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'Explore auth', subagent_type: 'Explore', model: 'claude-haiku-4-5-20251001', prompt: 'Find the auth flow' } }] } },
      { type: 'stream_event', session_id: 'sess-1', parent_tool_use_id: 'task-1', event: { type: 'message_start', message: { id: 'child-message' } } },
      { type: 'stream_event', session_id: 'sess-1', parent_tool_use_id: 'task-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Auth lives in ' } } },
      { type: 'stream_event', session_id: 'sess-1', parent_tool_use_id: 'task-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the session service.' } } },
      { type: 'assistant', session_id: 'sess-1', parent_tool_use_id: 'task-1', message: { id: 'child-message', content: [{ type: 'text', text: 'Auth lives in the session service.' }] } },
      { type: 'assistant', session_id: 'sess-1', parent_tool_use_id: 'task-1', message: { content: [{ type: 'text', text: 'One additional detail.' }] } },
      success({ result: '' }),
    ]);

    await adapter.run(run.options);

    expect(text(run.events)).toBe('');
    expect(run.events.filter((event) => event.type === 'subagent.text')).toEqual([
      { type: 'subagent.text', parentId: 'task-1', messageId: 'child-message', text: 'Auth lives in ' },
      { type: 'subagent.text', parentId: 'task-1', messageId: 'child-message', text: 'the session service.' },
      { type: 'subagent.text', parentId: 'task-1', messageId: 'message-1', text: 'One additional detail.' },
    ]);
  });

  it('keeps a background Agent launch running, routes task text, and completes from task_notification', async () => {
    const run = makeRun({ session: { provider: 'claude' } });
    const { adapter } = adapterFor([
      init(),
      { type: 'assistant', session_id: 'sess-1', parent_tool_use_id: null, message: { id: 'root', content: [{ type: 'tool_use', id: 'agent-use-1', name: 'Agent', input: { description: 'Explore auth', subagent_type: 'Explore', prompt: 'Trace auth', run_in_background: true } }] } },
      { type: 'user', session_id: 'sess-1', message: { content: [{ type: 'tool_result', tool_use_id: 'agent-use-1', content: [{ type: 'text', text: 'Async agent launched successfully (agent_id: task-1).' }] }] }, tool_use_result: { backgroundTaskId: 'task-1' } },
      { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'agent-use-1', is_backgrounded: true, session_id: 'sess-1' },
      { type: 'stream_event', session_id: 'sess-1', parent_tool_use_id: 'task-1', event: { type: 'message_start', message: { id: 'child-message' } } },
      { type: 'stream_event', session_id: 'sess-1', parent_tool_use_id: 'task-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Auth routes are in session.ts.' } } },
      { type: 'assistant', session_id: 'sess-1', parent_tool_use_id: 'task-1', message: { id: 'child-message', content: [{ type: 'text', text: 'Auth routes are in session.ts.' }] } },
      { type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', output_file: '/tmp/task-output.txt', summary: 'Auth route review finished.', usage: { duration_ms: 1800 }, session_id: 'sess-1' },
      success({ result: '' }),
    ]);

    await adapter.run(run.options);

    const activities = run.events.filter((event) => event.type === 'tool.activity' && event.activity.id === 'agent-use-1');
    expect(activities.at(-1)).toMatchObject({ type: 'tool.activity', activity: { status: 'completed' } });
    expect(activities.slice(0, -1).every((event) => event.type === 'tool.activity' && event.activity.status === 'running')).toBe(true);
    expect(activities.at(-1)).toMatchObject({ type: 'tool.activity', activity: { output: 'Auth route review finished.', summary: 'Auth route review finished.' } });
    expect(activities[1]).toMatchObject({ type: 'tool.activity', activity: { input: expect.stringContaining('"backgroundTaskId":"task-1"') } });
    expect(run.events).toContainEqual({ type: 'subagent.text', parentId: 'agent-use-1', messageId: 'child-message', text: 'Auth routes are in session.ts.' });
  });

  it('completes a foreground Agent whose answer mentions background work', async () => {
    const run = makeRun({ session: { provider: 'claude' } });
    const { adapter } = adapterFor([
      init(),
      { type: 'assistant', session_id: 'sess-1', parent_tool_use_id: null, message: { id: 'root', content: [{ type: 'tool_use', id: 'agent-use-2', name: 'Agent', input: { description: 'Start worker', prompt: 'Start the queue worker' } }] } },
      { type: 'user', session_id: 'sess-1', message: { content: [{ type: 'tool_result', tool_use_id: 'agent-use-2', content: [{ type: 'text', text: 'Started the queue worker; it is running in the background (task id: q-7).' }] }] } },
      success({ result: '' }),
    ]);

    await adapter.run(run.options);

    const activities = run.events.filter((event) => event.type === 'tool.activity' && event.activity.id === 'agent-use-2');
    expect(activities.at(-1)).toMatchObject({ type: 'tool.activity', activity: { status: 'completed' } });
    expect(activities.at(-1)).not.toMatchObject({ activity: { input: expect.stringContaining('backgroundTaskId') } });
  });

  it('maps canUseTool onto requestApproval and fails closed', async () => {
    const decisions: boolean[] = [true, false];
    const run = makeRun({ approve: (request) => { if (request.tool === 'Write') throw new Error('boom'); return decisions.shift() ?? false; } });
    let canUseTool!: NonNullable<Options['canUseTool']>;
    const { adapter } = adapterFor((params) => (async function* () {
      canUseTool = params.options.canUseTool!;
      yield init();
      yield success();
    })());
    await adapter.run(run.options);
    const ctx = (signal = new AbortController().signal) => ({ signal, toolUseID: 't', requestId: 'r' });
    const input = { command: 'git push' };
    expect(await canUseTool('Bash', input, ctx())).toEqual({ behavior: 'allow', updatedInput: input });
    expect(await canUseTool('Bash', input, ctx())).toMatchObject({ behavior: 'deny', message: expect.stringContaining('denied') });
    expect(await canUseTool('Write', { file_path: '/x', content: 'y'.repeat(10_000) }, ctx())).toMatchObject({ behavior: 'deny' });
    expect(run.approvals[0]).toMatchObject({ tool: 'Bash', description: 'Run command: git push', input });
    expect((run.approvals[2]?.input.content as string).length).toBeLessThan(5_000); // long inputs are shortened for display
    expect(run.approvals[2]?.description).toBe('Write file /x');

    const askCount = run.approvals.length;
    expect(await canUseTool('AskUserQuestion', { questions: [] }, ctx())).toMatchObject({ behavior: 'deny' });
    expect(run.approvals).toHaveLength(askCount); // never forwarded: there is no UI for it
  });

  it('denies and interrupts when a pending approval is aborted', async () => {
    const run = makeRun({ approve: () => new Promise<boolean>(() => undefined) });
    let canUseTool!: NonNullable<Options['canUseTool']>;
    const { adapter } = adapterFor((params) => (async function* () {
      canUseTool = params.options.canUseTool!;
      yield init();
      await new Promise((resolve) => params.options.abortController!.signal.addEventListener('abort', resolve));
    })());
    const promise = adapter.run(run.options);
    await waitFor(() => canUseTool !== undefined);
    const pending = canUseTool('Bash', { command: 'sleep 99' }, { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' });
    await waitFor(() => run.approvals.length === 1);
    run.controller.abort();
    expect(await pending).toMatchObject({ behavior: 'deny', interrupt: true });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('propagates abort to the SDK controller and closes the query', async () => {
    const run = makeRun({ session: { provider: 'claude', model: 'claude-sonnet-5-5' } });
    const { adapter, closes, calls } = adapterFor((params) => (async function* () {
      yield init();
      await new Promise((resolve) => params.options.abortController!.signal.addEventListener('abort', resolve));
      throw Object.assign(new Error('Claude Code process aborted by user'), { name: 'AbortError' });
    })());
    const promise = adapter.run(run.options);
    await waitFor(() => calls.length === 1 && run.events.length > 0);
    run.controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls[0]!.options.abortController!.signal.aborted).toBe(true);
    expect(closes).toHaveBeenCalled();
  });

  it('passes an existing Claude Code OAuth token to the SDK without requiring an API key', async () => {
    const { adapter, calls } = adapterFor([init({ apiKeySource: 'oauth' }), success()], { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'existing-cli-token' });
    await adapter.run(makeRun().options);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('existing-cli-token');
    expect(calls[0]!.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('lets Claude Code use its saved login and accepts the OAuth credential source', async () => {
    const run = makeRun();
    const { adapter, calls } = adapterFor([init({ apiKeySource: 'oauth' }), ...streamText('Hello'), success()], { PATH: '/usr/bin', HOME: '/home/x', ANTHROPIC_API_KEY: '  ' });
    await adapter.run(run.options);
    expect(calls[0]!.options.env?.HOME).toBe('/home/x');
    expect(calls[0]!.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(text(run.events)).toBe('Hello');
  });

  it('rejects a resumed session that initializes as a different native conversation', async () => {
    const run = makeRun({ session: { provider: 'claude', providerSessionId: 'selected-session' } });
    const { adapter, closes } = adapterFor([init({ session_id: 'other-session' }), success()]);

    await expect(adapter.run(run.options)).rejects.toMatchObject({ code: 'resume_failed', message: expect.stringContaining('different conversation') });
    expect(closes).toHaveBeenCalled();
    expect(run.events.some((event) => event.type === 'session')).toBe(false);
  });

  it('turns error results into errors with the SDK detail', async () => {
    const run = makeRun();
    const { adapter } = adapterFor([init(), { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: sess-0'], session_id: 'sess-1', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } }]);
    await expect(adapter.run(run.options)).rejects.toMatchObject({ code: 'claude_error_during_execution', message: expect.stringContaining('No conversation found') });
    expect(run.events.at(-1)).toMatchObject({ type: 'usage' });
  });

  it('treats an is_error success result as a failure', async () => {
    const { adapter } = adapterFor([init(), { type: 'assistant', session_id: 's', parent_tool_use_id: null, error: 'authentication_failed', message: { id: 'm', content: [{ type: 'text', text: 'Invalid API key' }] } }, success({ is_error: true, result: 'Invalid API key' })]);
    const run = makeRun();
    await expect(adapter.run(run.options)).rejects.toMatchObject({ message: expect.stringContaining('authentication_failed') });
    expect(text(run.events)).toBe('');
  });

  it('stops when Claude switches to a fallback model', async () => {
    const run = makeRun();
    const { adapter } = adapterFor([init(), { type: 'system', subtype: 'model_refusal_fallback', original_model: 'claude-sonnet-5-5', fallback_model: 'claude-haiku-4-5-20251001' }, success()]);
    await expect(adapter.run(run.options)).rejects.toMatchObject({ code: 'model_substitution' });
  });

  it('fails if the stream ends without a result and redacts stderr', async () => {
    const run = makeRun();
    const { adapter } = adapterFor((params) => (async function* () {
      params.options.stderr?.(`boot failure with key ${ENV.ANTHROPIC_API_KEY}\n`);
      yield init();
    })());
    const error = await adapter.run(run.options).catch((e: Error) => e);
    expect(error).toMatchObject({ code: 'no_result' });
    expect((error as Error).message).toContain('boot failure');
    expect((error as Error).message).not.toContain(ENV.ANTHROPIC_API_KEY);
  });

  it('wraps SDK exceptions without leaking the key', async () => {
    const { adapter } = adapterFor(() => (async function* () { yield init(); throw new Error(`spawn failed using ${ENV.ANTHROPIC_API_KEY}`); })());
    const error = await adapter.run(makeRun().options).catch((e: Error) => e);
    expect(error).toMatchObject({ code: 'claude_failed' });
    expect((error as Error).message).not.toContain(ENV.ANTHROPIC_API_KEY);
  });

  it('reports retries and unavailable executables', async () => {
    const run = makeRun();
    const { adapter } = adapterFor([init(), { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, error: 'overloaded', error_status: 529 }, success()]);
    await adapter.run(run.options);
    expect(run.events.some((e) => e.type === 'info' && e.content.includes('retry 1 of 3'))).toBe(true);

    const missing = createClaudeAdapter({ env: ENV, query: (() => { throw new Error('not reached'); }) as never, resolveExecutable: async () => ({ ok: false, reason: 'No working claude executable found.', skipped: [] }) });
    await expect(missing.run(makeRun().options)).rejects.toMatchObject({ code: 'executable_unavailable' });
  });
});
