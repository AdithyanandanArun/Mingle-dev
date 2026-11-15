import { describe, expect, it, vi } from 'vitest';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeAdapter, type ContentQueryFn } from './claude/adapter.js';
import { createCodexAdapter, type CodexTimeouts } from './codex/adapter.js';
import { FakeChild, type FakeChildOptions, type Json } from './testing/fake-child.js';
import { makeSession, settings } from './testing/helpers.js';

const CODEX_THREAD = 'thr_native_compaction';
const CLAUDE_SESSION = 'claude_native_compaction';
const CODEX_FAST: Partial<CodexTimeouts> = {
  initializeMs: 300, threadMs: 300, turnStartMs: 300, interruptMs: 100, interruptGraceMs: 80,
  configReadMs: 100, shutdownGraceMs: 40, termMs: 60, killMs: 60,
};

const resolvedCodex = async () => ({ ok: true as const, executable: { path: '/fake/codex', version: '9.9.9', source: 'path' as const, skipped: [] } });
const resolvedClaude = async () => ({ ok: true as const, executable: { path: '/fake/claude', version: '2.1.292', source: 'npm-global' as const, skipped: [] } });

type CodexScript = NonNullable<FakeChildOptions['onMessage']>;

function codexServer(script: CodexScript): CodexScript {
  return (message, child) => {
    switch (message.method) {
      case 'initialize': return child.reply(message, { userAgent: 'fake' });
      case 'model/list': return child.reply(message, { data: [{
        model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol',
        supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({ reasoningEffort })),
      }], nextCursor: null });
      case 'thread/resume': return child.reply(message, { thread: { id: message.params.threadId } });
      case 'thread/start': return child.reply(message, { thread: { id: CODEX_THREAD }, model: message.params.model });
      default: return script(message, child);
    }
  };
}

function codexHarness(script: CodexScript) {
  const child = new FakeChild({ onMessage: codexServer(script) });
  const adapter = createCodexAdapter({
    spawn: () => child,
    resolveExecutable: resolvedCodex,
    env: { PATH: '/usr/bin', HOME: '/home/fake' },
    timeouts: CODEX_FAST,
  });
  return { adapter, child };
}

function codexCompactionEvents(child: FakeChild, threadId: string, turnId: string, itemId: string): void {
  child.notify('turn/started', { threadId, turn: { id: turnId } });
  child.notify('item/started', { threadId, turnId, item: { type: 'contextCompaction', id: itemId } });
  child.notify('item/completed', { threadId, turnId, item: { type: 'contextCompaction', id: itemId } });
}

/** Waits for a fake RPC response to traverse stdout and the adapter's JSON-RPC listener. */
function rpcAccepted(child: FakeChild): Promise<void> {
  return new Promise((resolve) => {
    let buffered = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      buffered += chunk.toString();
      for (let newline = buffered.indexOf('\n'); newline >= 0; newline = buffered.indexOf('\n')) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          if ((JSON.parse(line) as Json).result?.accepted === true) resolve();
        } catch { /* Ignore notifications and partial fixture lines. */ }
      }
    });
  });
}

type ClaudeMessage = Record<string, unknown>;

interface ClaudeFixtureOptions {
  commands?: unknown[];
  messages?: ClaudeMessage[];
  failure?: Error;
}

function claudeHarness(fixture: ClaudeFixtureOptions = {}) {
  const sent: SDKUserMessage[] = [];
  const calls: Parameters<ContentQueryFn>[0][] = [];
  const close = vi.fn();
  const queryWithContent: ContentQueryFn = (params) => {
    calls.push(params);
    const stream = (async function* () {
      if (typeof params.prompt !== 'string') {
        for await (const message of params.prompt) sent.push(message);
      }
      for (const message of fixture.messages ?? []) yield message;
      if (fixture.failure) throw fixture.failure;
    })();
    return Object.assign(stream, {
      close,
      initializationResult: async () => ({}),
      supportedCommands: async () => fixture.commands ?? [{ name: 'compact', builtin: true }],
    }) as never;
  };
  return {
    adapter: createClaudeAdapter({ queryWithContent, env: { PATH: '/usr/bin', HOME: '/home/fake' }, resolveExecutable: resolvedClaude }),
    calls,
    close,
    sent,
  };
}

function claudeSession() {
  return makeSession({ provider: 'claude', model: 'claude-sonnet-5-5', providerSessionId: CLAUDE_SESSION });
}

function codexSession() {
  return makeSession({ provider: 'codex', model: 'gpt-6.1-sol', providerSessionId: CODEX_THREAD });
}

describe('native manual compaction adapters', () => {
  it('forwards context boundary and subsequent occupancy from native compaction', async () => {
    const events: unknown[] = [];
    const { adapter } = codexHarness((message, runtime) => {
      if (message.method !== 'thread/compact/start') return;
      runtime.reply(message, { accepted: true });
      codexCompactionEvents(runtime, CODEX_THREAD, 'compact-turn', 'compact-item');
      runtime.notify('thread/tokenUsage/updated', { threadId: CODEX_THREAD, tokenUsage: { last: { totalTokens: 200 }, modelContextWindow: 1000 } });
    });
    const result = await adapter.compact!({ session: codexSession(), settings, signal: new AbortController().signal, onContextEvent: event => events.push(event) });
    expect(result.status).toBe('completed');
    expect(events).toEqual([{ type: 'context.reset' }, { type: 'context.usage', usedTokens: 200, contextWindow: 1000, estimated: true, source: 'codex' }]);
  });

  it('Codex completes only after a fresh matching contextCompaction item starts and completes', async () => {
    const { adapter, child } = codexHarness((message, runtime) => {
      if (message.method === 'thread/compact/start') {
        runtime.reply(message, { accepted: true });
        codexCompactionEvents(runtime, CODEX_THREAD, 'compact_turn_1', 'compact_item_1');
      }
    });

    const result = await adapter.compact!({ session: codexSession(), settings, signal: new AbortController().signal });

    expect(child.requestsFor('thread/compact/start')).toHaveLength(1);
    expect(child.requestsFor('thread/compact/start')[0]?.params).toEqual({ threadId: CODEX_THREAD });
    expect(result).toMatchObject({ provider: 'codex', sessionId: 'session-1', status: 'completed', error: null });
    expect(child.closed).toBe(true);
  });

  it('Codex does not treat RPC acceptance or wrong-thread compaction items as completion, and exposes interruption', async () => {
    const controller = new AbortController();
    let child!: FakeChild;
    const { adapter, child: runtime } = codexHarness((message, process) => {
      if (message.method === 'thread/compact/start') {
        process.notify('turn/started', { threadId: 'another_thread', turn: { id: 'other_turn' } });
        process.notify('item/started', { threadId: 'another_thread', turnId: 'other_turn', item: { type: 'contextCompaction', id: 'other_item' } });
        process.notify('item/completed', { threadId: 'another_thread', turnId: 'other_turn', item: { type: 'contextCompaction', id: 'other_item' } });
        process.reply(message, { accepted: true });
      }
    });
    child = runtime;
    const accepted = rpcAccepted(child);
    const pending = adapter.compact!({ session: codexSession(), settings, signal: controller.signal });
    await accepted;
    controller.abort();

    const result = await pending;
    expect(result).toMatchObject({ provider: 'codex', status: 'failed', error: 'Compaction interrupted' });
    expect(result.message).toContain('interrupted');
    expect(child.closed).toBe(true);
  });

  it('Claude requires the built-in compact command, a compaction boundary, and a successful result', async () => {
    const boundary = { type: 'system', subtype: 'compact_boundary', session_id: CLAUDE_SESSION };
    const success = { type: 'result', subtype: 'success', is_error: false, session_id: CLAUDE_SESSION };

    for (const messages of [[boundary], [success]]) {
      const { adapter } = claudeHarness({ commands: [{ name: 'compact', builtin: true }], messages });
      const result = await adapter.compact!({ session: claudeSession(), settings, signal: new AbortController().signal });
      expect(result).toMatchObject({ status: 'failed', error: 'compaction_unconfirmed' });
    }

    const { adapter, calls, close, sent } = claudeHarness({
      commands: [{ name: 'compact', builtin: true }], messages: [boundary, success],
    });
    const result = await adapter.compact!({ session: claudeSession(), settings, signal: new AbortController().signal });

    expect(result).toMatchObject({ provider: 'claude', sessionId: 'session-1', status: 'completed', error: null });
    expect(calls[0]?.options).toMatchObject({ resume: CLAUDE_SESSION, permissionMode: 'default', tools: [], model: 'claude-sonnet-5-5' });
    expect(sent).toEqual([expect.objectContaining({
      type: 'user', parent_tool_use_id: null,
      message: expect.objectContaining({ role: 'user', content: '/compact' }),
      session_id: CLAUDE_SESSION,
    })]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('Claude rejects a non-built-in skill merely named compact without sending it', async () => {
    const { adapter, sent } = claudeHarness({ commands: [{ name: 'compact', builtin: false }] });

    const result = await adapter.compact!({ session: claudeSession(), settings, signal: new AbortController().signal });

    expect(result).toMatchObject({ status: 'unsupported', error: null });
    expect(result.message).toContain('does not advertise its built-in /compact command');
    expect(sent).toEqual([]);
  });

  it('Claude surfaces SDK rejection as a failed native compaction', async () => {
    const { adapter, sent } = claudeHarness({ failure: new Error('native SDK command rejected') });

    const result = await adapter.compact!({ session: claudeSession(), settings, signal: new AbortController().signal });

    expect(result).toMatchObject({ provider: 'claude', status: 'failed', error: expect.stringContaining('native SDK command rejected') });
    expect(sent).toHaveLength(1);
  });

  it('Claude refuses a compaction boundary from a different native conversation', async () => {
    const { adapter } = claudeHarness({ messages: [
      { type: 'system', subtype: 'init', session_id: 'another_claude_session' },
      { type: 'system', subtype: 'compact_boundary', session_id: 'another_claude_session' },
      { type: 'result', subtype: 'success', is_error: false, session_id: 'another_claude_session' },
    ] });

    const result = await adapter.compact!({ session: claudeSession(), settings, signal: new AbortController().signal });

    expect(result).toMatchObject({ provider: 'claude', status: 'failed', error: expect.stringContaining('resumed a different conversation') });
  });
});
