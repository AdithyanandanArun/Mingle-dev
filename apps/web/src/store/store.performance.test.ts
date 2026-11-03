import { afterEach, describe, expect, it, vi } from 'vitest';

const { bootstrap, rememberProject } = vi.hoisted(() => ({ bootstrap: vi.fn(), rememberProject: vi.fn().mockResolvedValue({}) }));
vi.mock('../lib/api', () => ({ api: { bootstrap, rememberProject }, errorMessage: (error: unknown) => String(error) }));

let useMingle: typeof import('./store').useMingle | undefined;
afterEach(() => {
  bootstrap.mockReset();
  rememberProject.mockClear();
  useMingle?.setState({
    boot: null, bootError: null, bootLoading: true, staleError: null,
    activeProjectId: null, sessionByProject: {}, selectedTeamSessionByProject: {}, teamSessionsByProject: {},
  });
  vi.useRealTimers();
});

it('coalesces refresh bursts and enforces a one-second floor between scheduled bootstraps', async () => {
  vi.useFakeTimers();
  const { createRefreshScheduler } = await import('./store');
  const refresh = vi.fn();
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  const scheduler = createRefreshScheduler(() => { lastStartedAt = Date.now(); refresh(); }, () => lastStartedAt);
  try {
    for (let index = 0; index < 10; index++) scheduler.schedule();
    await vi.advanceTimersByTimeAsync(159);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    for (let index = 0; index < 10; index++) scheduler.schedule();
    await vi.advanceTimersByTimeAsync(899);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  } finally {
    scheduler.cancel();
  }
});

it('keeps one bootstrap in flight, makes one trailing fetch, and skips an unchanged state update', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  const store = await import('./store');
  useMingle = store.useMingle;
  let resolveFirst: (value: unknown) => void = () => undefined;
  let resolveTrailing: (value: unknown) => void = () => undefined;
  bootstrap
    .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveTrailing = resolve; }));

  const payload = {
    projects: [], sessions: [], messages: [], tasks: [], events: [], approvals: [], plans: [], questions: [], providers: [],
    settings: {}, version: 'test', runs: [], toolCalls: [],
  };
  let updates = 0;
  const unsubscribe = store.useMingle.subscribe(() => { updates++; });
  try {
    const first = store.useMingle.getState().refreshNow();
    const joined = store.useMingle.getState().refreshNow();
    expect(bootstrap).toHaveBeenCalledTimes(1);

    resolveFirst(payload);
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
    expect(updates).toBe(1);
    resolveTrailing(payload);
    await Promise.all([first, joined]);

    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(updates).toBe(1);
  } finally {
    unsubscribe();
  }
});

it('preserves a selected remote team session across a bootstrap refresh', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  const store = await import('./store');
  useMingle = store.useMingle;
  const projectId = 'remote-team-project';
  const remoteSessionId = 'remote-team-session';
  const groupId = 'remote-team-group';
  const at = '2026-10-28T12:00:00.000Z';
  const payload = {
    projects: [{ id: projectId, name: 'Example shared project', path: '/example/shared', createdAt: at, isExample: false }],
    sessions: [{
      id: 'local-session', projectId, name: 'Local session', provider: 'codex', model: 'gpt-5-codex', effort: 'medium',
      status: 'idle', policy: 'supervised', isolated: false, worktreePath: '/example/shared', branch: null,
      providerSessionId: null, createdAt: at, updatedAt: at, error: null, inputTokens: 0, outputTokens: 0,
      costUsd: null, pinned: false, unread: false,
    }],
    messages: [], tasks: [], events: [], approvals: [], plans: [], questions: [], providers: [], settings: {},
    version: 'remote-selection-test', runs: [], toolCalls: [],
  };
  bootstrap.mockResolvedValueOnce(payload);
  store.useMingle.setState({
    activeProjectId: projectId,
    sessionByProject: { [projectId]: remoteSessionId },
    selectedTeamSessionByProject: {},
    teamSessionsByProject: { [projectId]: {
      teamSession: { groupId, sessionId: remoteSessionId, title: 'Shared conversation' }, hostIsThisDevice: false,
    } },
  });

  await store.useMingle.getState().refreshNow();

  expect(store.useMingle.getState().sessionByProject[projectId]).toBe(remoteSessionId);

  store.useMingle.setState({
    activeProjectId: null, teamSessionsByProject: {}, selectedTeamSessionByProject: { [projectId]: remoteSessionId },
  });
  store.useMingle.getState().selectProject(projectId);
  expect(store.useMingle.getState().sessionByProject[projectId]).toBe(remoteSessionId);
});

it('does not let a continuous event stream postpone the refresh forever', async () => {
  vi.useFakeTimers();
  const { createRefreshScheduler } = await import('./store');
  const refresh = vi.fn();
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  const scheduler = createRefreshScheduler(() => { lastStartedAt = Date.now(); refresh(); }, () => lastStartedAt);
  try {
    // Before the bounded wait this stream of events 100 ms apart never let the 160 ms debounce expire.
    for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(refresh).toHaveBeenCalledTimes(5);
  } finally {
    scheduler.cancel();
  }
});

describe('long single-agent session hot paths', () => {
  const at = '2026-10-28T12:00:00.000Z';
  const filler = (length: number, seed: string): string => `${seed} `.repeat(Math.ceil(length / (seed.length + 1))).slice(0, length);
  const payload = (overrides: Record<string, unknown> = {}, tweak?: (boot: ReturnType<typeof baseBoot>) => void) => {
    const boot = baseBoot();
    tweak?.(boot);
    return JSON.parse(JSON.stringify({ ...boot, ...overrides })) as ReturnType<typeof baseBoot>;
  };
  function baseBoot() {
    return {
      projects: [{ id: 'p', name: 'p', path: '/p', createdAt: at, isExample: false }],
      sessions: [{
        id: 's', projectId: 'p', name: 'Long session', provider: 'codex', model: 'm', effort: 'medium', status: 'running', policy: 'supervised',
        isolated: false, worktreePath: '/p', branch: null, providerSessionId: null, createdAt: at, updatedAt: at, error: null,
        inputTokens: 0, outputTokens: 0, costUsd: null, pinned: false, unread: false,
      }],
      messages: Array.from({ length: 300 }, (_, index) => ({
        id: `m${index}`, sessionId: 's', role: index % 2 ? 'assistant' : 'user', content: filler(6_000, `message ${index}`), createdAt: at, runId: `r${index % 50}`,
      })),
      tasks: [], approvals: [], plans: [], questions: [],
      providers: [{ id: 'codex', name: 'Codex', available: true, version: '1', executable: 'codex', reason: null, models: [] }],
      events: Array.from({ length: 500 }, (_, index) => ({ id: index + 1, projectId: 'p', sessionId: 's', type: 'run.updated', summary: `event ${index}`, payload: { index }, createdAt: at })),
      settings: {}, version: 'long-session',
      runs: Array.from({ length: 50 }, (_, index) => ({
        id: `r${index}`, sessionId: 's', userMessageId: `m${index}`, provider: 'codex', model: 'm', status: 'completed', startedAt: at, finishedAt: at,
        durationMs: 5, toolCount: 3, toolCounts: { command: 3 },
      })),
      toolCalls: Array.from({ length: 400 }, (_, index) => ({
        id: `t${index}`, runId: `r${index % 50}`, sessionId: 's', providerId: `pt${index}`, parentProviderId: null, name: 'bash', category: 'command',
        status: 'completed', summary: 'ls', command: 'ls', input: filler(500, 'in'), output: filler(2_000, `out ${index}`), cwd: '/p', exitCode: 0,
        processId: null, startedAt: at, finishedAt: at, durationMs: 3,
      })),
    };
  }

  class FakeSocket {
    static OPEN = 1;
    static instances: FakeSocket[] = [];
    readyState = 0;
    sent: unknown[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { FakeSocket.instances.push(this); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }

  async function startStore() {
    vi.resetModules();
    FakeSocket.instances = [];
    const storage = new Map<string, string>();
    const writes: string[] = [];
    const win = Object.assign(new EventTarget(), {
      location: { search: '', protocol: 'http:', host: 'test' },
      setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
      clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
      requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    });
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { writes.push(value); storage.set(key, value); } });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', { addEventListener() { /* unused */ }, removeEventListener() { /* unused */ }, visibilityState: 'visible' });
    vi.stubGlobal('location', win.location);
    vi.stubGlobal('WebSocket', FakeSocket);
    const store = await import('./store');
    useMingle = store.useMingle;
    return { ...store, win, writes, socket: () => FakeSocket.instances[0] };
  }

  async function serialized<T>(run: () => Promise<T>): Promise<{ result: T; calls: number; chars: number }> {
    const original = JSON.stringify;
    let calls = 0;
    let chars = 0;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((...args: Parameters<typeof JSON.stringify>) => {
      const text = original(...args);
      calls++;
      chars += text?.length ?? 0;
      return text;
    }) as typeof JSON.stringify);
    try { return { result: await run(), calls, chars }; } finally { spy.mockRestore(); }
  }

  const nodes = (value: unknown): number => (value && typeof value === 'object'
    ? 1 + Object.values(value).reduce<number>((sum, item) => sum + nodes(item), 0) : 0);

  afterEach(() => vi.useRealTimers());

  it('compares an unchanged bootstrap structurally: no whole-body serialization, one visit per node, no update', async () => {
    const { useMingle: store } = await startStore();
    const { reconcileStats, resetReconcileStats } = await import('./bootstrapState');
    bootstrap.mockResolvedValueOnce(payload());
    await store.getState().refreshNow();
    const first = store.getState().boot!;
    let updates = 0;
    const unsubscribe = store.subscribe(() => { updates++; });
    try {
      const body = payload();
      bootstrap.mockResolvedValueOnce(body);
      resetReconcileStats();
      const { calls, chars } = await serialized(() => store.getState().refreshNow());
      // Previously: one 3.0 million character JSON.stringify of the body on every refresh.
      expect(chars).toBeLessThan(1_000);
      expect(calls).toBeLessThanOrEqual(1);
      expect(reconcileStats.objectComparisons).toBeLessThanOrEqual(nodes(body));
      expect(reconcileStats.indexBuilds).toBe(0);
      expect(updates).toBe(0);
      expect(store.getState().boot).toBe(first);
    } finally {
      unsubscribe();
    }
  });

  it('replaces only what changed, keeps canonical references, and never serializes the changed bootstrap', async () => {
    const { useMingle: store, writes } = await startStore();
    const { reconcileStats, resetReconcileStats } = await import('./bootstrapState');
    bootstrap.mockResolvedValueOnce(payload());
    await store.getState().refreshNow();
    const before = store.getState().boot!;
    const persistedWrites = writes.length;

    const changed = payload({ version: 'long-session-2' }, (boot) => {
      boot.messages[299] = { ...boot.messages[299], content: `${boot.messages[299].content} more words` };
      boot.toolCalls[10] = { ...boot.toolCalls[10], output: 'rewritten' };
    });
    bootstrap.mockResolvedValueOnce(changed);
    resetReconcileStats();
    const { calls, chars } = await serialized(() => store.getState().refreshNow());
    const after = store.getState().boot!;

    // Previously: 1,104 JSON.stringify calls and 3.05 million characters for this same one-message change.
    expect(chars).toBeLessThan(1_000);
    expect(calls).toBeLessThanOrEqual(1);
    expect(reconcileStats.indexBuilds).toBe(0);
    expect(after).not.toBe(before);
    expect(after.messages[299].content).toContain('more words');
    expect(after.messages.slice(0, 299).every((message, index) => message === before.messages[index])).toBe(true);
    expect(after.toolCalls[10].output).toBe('rewritten');
    expect(after.toolCalls.filter((_, index) => index !== 10).every((call) => before.toolCalls.includes(call))).toBe(true);
    expect(after.events).toBe(before.events);
    expect(after.runs).toBe(before.runs);
    expect(after.sessions).toBe(before.sessions);
    expect(after.settings).toBe(before.settings);
    // Selection state did not change, so persisted UI state is not rewritten to local storage (previously once per refresh).
    expect(writes.length).toBe(persistedWrites);
  });

  it('follows the sliding message and event windows without building lookup maps', async () => {
    const { useMingle: store } = await startStore();
    const { reconcileStats, resetReconcileStats } = await import('./bootstrapState');
    bootstrap.mockResolvedValueOnce(payload());
    await store.getState().refreshNow();
    const before = store.getState().boot!;
    const slid = payload({ version: 'slid' }, (boot) => {
      boot.messages = [...boot.messages.slice(1), { ...boot.messages[0], id: 'm300', content: 'newest' }];
      boot.events = [...boot.events.slice(1), { ...boot.events[0], id: 501, summary: 'newest' }];
    });
    bootstrap.mockResolvedValueOnce(slid);
    resetReconcileStats();
    await store.getState().refreshNow();
    const after = store.getState().boot!;
    expect(reconcileStats.indexBuilds).toBe(0);
    expect(after.messages.slice(0, 299).every((message, index) => message === before.messages[index + 1])).toBe(true);
    expect(after.messages[299].id).toBe('m300');
    expect(after.events.slice(0, 499).every((event, index) => event === before.events[index + 1])).toBe(true);
  });

  it('keeps bootstrap fields the web does not know yet and stabilizes their unchanged records', async () => {
    const { useMingle: store } = await startStore();
    const workflow = (id: string, status: string) => ({ id, sessionId: 's', status, steps: [{ id: `${id}-1`, status }] });
    bootstrap.mockResolvedValueOnce(payload({ sessionWorkflows: [workflow('w1', 'running'), workflow('w2', 'done')], queuedMessages: [{ id: 'q1', sessionId: 's', content: 'later' }] }));
    await store.getState().refreshNow();
    const first = store.getState().boot as unknown as { sessionWorkflows: ReturnType<typeof workflow>[]; queuedMessages: unknown[] };
    expect(first.sessionWorkflows).toEqual([workflow('w1', 'running'), workflow('w2', 'done')]);

    bootstrap.mockResolvedValueOnce(payload({ sessionWorkflows: [workflow('w1', 'done'), workflow('w2', 'done')], queuedMessages: [{ id: 'q1', sessionId: 's', content: 'later' }] }));
    await store.getState().refreshNow();
    const second = store.getState().boot as unknown as typeof first;
    expect(second.sessionWorkflows[0]).toEqual(workflow('w1', 'done'));
    expect(second.sessionWorkflows[1]).toBe(first.sessionWorkflows[1]);
    expect(second.queuedMessages).toBe(first.queuedMessages);
  });

  it('keeps pending optimistic messages with their context references until the saved copy arrives', async () => {
    const { useMingle: store, win } = await startStore();
    bootstrap.mockResolvedValue(payload());
    store.getState().init();
    await vi.waitFor(() => expect(store.getState().boot).not.toBeNull());
    const refs = [{ kind: 'file', path: 'src/a.ts' }];
    const optimistic = { id: 'optimistic:1', sessionId: 's', role: 'user', content: 'ship it', createdAt: new Date().toISOString(), contextRefs: refs };
    win.dispatchEvent(new CustomEvent('mingle:optimistic-session-message', { detail: { message: optimistic } }));
    win.dispatchEvent(new CustomEvent('mingle:optimistic-session-message', { detail: { message: optimistic } }));
    expect(store.getState().boot!.messages.filter((message) => message.id === 'optimistic:1')).toHaveLength(1);

    bootstrap.mockResolvedValue(payload({ version: 'unsaved' }));
    await store.getState().refreshNow();
    const kept = store.getState().boot!.messages.at(-1)!;
    expect(kept).toBe(store.getState().boot!.messages.find((message) => message.id === 'optimistic:1'));
    expect(kept.contextRefs).toBe(refs);
    expect(kept.id).toBe('optimistic:1');

    bootstrap.mockResolvedValue(payload({ version: 'saved' }, (boot) => {
      boot.messages.push({ id: 'm-saved', sessionId: 's', role: 'user', content: 'ship it', createdAt: optimistic.createdAt, runId: 'r0' });
    }));
    await store.getState().refreshNow();
    const ids = store.getState().boot!.messages.map((message) => message.id);
    expect(ids).toContain('m-saved');
    expect(ids).not.toContain('optimistic:1');

    win.dispatchEvent(new CustomEvent('mingle:optimistic-session-message', { detail: { message: { ...optimistic, id: 'optimistic:2' } } }));
    win.dispatchEvent(new CustomEvent('mingle:optimistic-session-remove', { detail: { messageId: 'optimistic:2' } }));
    expect(store.getState().boot!.messages.some((message) => message.id === 'optimistic:2')).toBe(false);
  });

  it('publishes a burst of stream deltas as two store updates and still ends with the exact text', async () => {
    vi.useFakeTimers();
    const { useMingle: store, socket } = await startStore();
    bootstrap.mockResolvedValue(payload());
    store.getState().init();
    await vi.advanceTimersByTimeAsync(0);
    socket().readyState = 1;
    socket().onopen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().boot).not.toBeNull();

    let updates = 0;
    const unsubscribe = store.subscribe(() => { updates++; });
    try {
      let offset = 0;
      for (let index = 0; index < 2_000; index++) {
        const delta = `tok${index % 10} `;
        socket().onmessage?.({ data: JSON.stringify({ type: 'session.delta', sessionId: 's', messageId: 'live', delta, offset }) });
        offset += delta.length;
      }
      // Previously: 2,000 store updates, one per delta, each re-rendering every stream subscriber.
      expect(updates).toBe(1);
      expect(store.getState().streams.live.text.length).toBe(5);
      await vi.advanceTimersByTimeAsync(32);
      expect(updates).toBe(2);
      const { base, text } = store.getState().streams.live;
      expect(base + text).toHaveLength(offset);
      expect((base + text).startsWith('tok0 tok1 tok2 ')).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('looks a streaming message up through one index instead of scanning the history for every delta', async () => {
    vi.useFakeTimers();
    const { useMingle: store, socket } = await startStore();
    bootstrap.mockResolvedValue(payload());
    store.getState().init();
    await vi.advanceTimersByTimeAsync(0);
    socket().readyState = 1;
    expect(store.getState().boot).not.toBeNull();
    let idReads = 0;
    const counted = store.getState().boot!.messages.map((message) => Object.defineProperty({ ...message }, 'id', { enumerable: true, get: () => { idReads++; return message.id; } }));
    store.setState({ boot: { ...store.getState().boot!, messages: counted } });
    let offset = counted[299].content.length;
    for (let index = 0; index < 500; index++) {
      socket().onmessage?.({ data: JSON.stringify({ type: 'session.delta', sessionId: 's', messageId: 'm299', delta: 'x', offset }) });
      offset += 1;
    }
    // Previously `messages.find` read ids until the match on every delta (about 300 reads each). Now one pass builds the index.
    expect(idReads).toBeLessThanOrEqual(counted.length);
    expect(store.getState().streams.m299.text).toHaveLength(counted[299].content.length + 1);
  });

  it('recovers from an out-of-order delta by refreshing, and resumes streaming from the new snapshot', async () => {
    vi.useFakeTimers();
    const { useMingle: store, socket } = await startStore();
    bootstrap.mockResolvedValue(payload());
    store.getState().init();
    await vi.advanceTimersByTimeAsync(0);
    socket().readyState = 1;
    expect(store.getState().boot).not.toBeNull();
    const delta = (messageId: string, offset: number, text: string) =>
      socket().onmessage?.({ data: JSON.stringify({ type: 'session.delta', sessionId: 's', messageId, delta: text, offset }) });

    delta('live', 0, 'Hello');
    delta('live', 5, ' world');
    await vi.advanceTimersByTimeAsync(40);
    const calls = bootstrap.mock.calls.length;
    delta('live', 40, 'late');
    await vi.advanceTimersByTimeAsync(40);
    expect(store.getState().streams.live.base + store.getState().streams.live.text).toBe('Hello world');
    expect(bootstrap.mock.calls.length).toBe(calls);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(bootstrap.mock.calls.length).toBe(calls + 1);

    // A replayed chunk the buffer already holds is absorbed instead of duplicated.
    delta('live', 0, 'Hello');
    await vi.advanceTimersByTimeAsync(40);
    expect(store.getState().streams.live.base + store.getState().streams.live.text).toBe('Hello world');
  });

  it('settles pending stream text before a refresh decides which buffers the snapshot has caught up with', async () => {
    vi.useFakeTimers();
    const { useMingle: store, socket } = await startStore();
    bootstrap.mockResolvedValue(payload());
    store.getState().init();
    await vi.advanceTimersByTimeAsync(0);
    socket().readyState = 1;
    const delta = (offset: number, text: string) =>
      socket().onmessage?.({ data: JSON.stringify({ type: 'session.delta', sessionId: 's', messageId: 'm299', delta: text, offset }) });
    const length = store.getState().boot!.messages[299].content.length;
    delta(length, ' first');
    delta(length + 6, ' second');
    expect(store.getState().streams.m299.text).toHaveLength(length + 6);
    bootstrap.mockResolvedValue(payload({ version: 'caught-up' }, (boot) => { boot.messages[299].content += ' first'; }));
    await store.getState().refreshNow();
    // The server has the first chunk only; the buffered second chunk must survive the prune.
    expect(store.getState().streams.m299.base + store.getState().streams.m299.text).toHaveLength(length + 13);
    bootstrap.mockResolvedValue(payload({ version: 'fully-caught-up' }, (boot) => { boot.messages[299].content += ' first second'; }));
    await store.getState().refreshNow();
    expect(store.getState().streams.m299).toBeUndefined();
  });

  it('still forwards state, team, terminal and group events while refreshes stay coalesced', async () => {
    vi.useFakeTimers();
    const { useMingle: store, socket, win } = await startStore();
    const { terminalBus } = await import('./terminalBus');
    bootstrap.mockResolvedValue(payload({ groups: [] }));
    store.getState().init();
    await vi.advanceTimersByTimeAsync(0);
    socket().readyState = 1;
    expect(store.getState().boot).not.toBeNull();
    const seen: string[] = [];
    for (const name of ['mingle:state-changed', 'mingle:team-chat-updated', 'mingle:team-structure-updated', 'mingle:team-session-updated', 'mingle:team-activity-updated', 'mingle:provider-updates-changed']) {
      win.addEventListener(name, () => seen.push(name));
    }
    const emit = (event: object) => socket().onmessage?.({ data: JSON.stringify(event) });
    const refreshes = bootstrap.mock.calls.length;
    const event = (id: number, type: string) => ({ id, projectId: 'p', sessionId: null, type, summary: type, payload: {}, createdAt: at });

    emit({ type: 'state.changed', event: event(1_000, 'team.chat.updated') });
    emit({ type: 'state.changed', event: event(1_000, 'team.chat.updated') });
    emit({ type: 'state.changed', event: event(1_001, 'team.session.updated') });
    emit({ type: 'state.changed', event: event(1_002, 'provider.updates.updated') });
    emit({ type: 'state.changed', event: event(1_003, 'team.agent.activity.updated') });
    expect(seen).toEqual(expect.arrayContaining([
      'mingle:state-changed', 'mingle:team-chat-updated', 'mingle:team-structure-updated', 'mingle:team-session-updated', 'mingle:provider-updates-changed',
    ]));
    expect(seen).toContain('mingle:team-activity-updated');
    expect(store.getState().boot!.events.filter((item) => item.id === 1_000)).toHaveLength(1);
    expect(store.getState().boot!.events.some((item) => item.id === 1_003)).toBe(false);
    expect(bootstrap.mock.calls.length).toBe(refreshes);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bootstrap.mock.calls.length).toBe(refreshes + 1);

    store.setState({ terminal: { status: 'running', terminalId: 't1', exitCode: null, projectId: 'p', sessionId: null, label: '', note: null } });
    const chunks: (string | null)[] = [];
    const stop = terminalBus.subscribe((chunk) => chunks.push(chunk));
    emit({ type: 'terminal.output', terminalId: 't1', data: 'ls\r\n' });
    emit({ type: 'terminal.output', terminalId: 'other', data: 'ignored' });
    emit({ type: 'terminal.exit', terminalId: 't1', exitCode: 3 });
    stop();
    expect(chunks).toEqual(['ls\r\n']);
    expect(store.getState().terminal).toMatchObject({ status: 'exited', exitCode: 3 });
  });

  it('merges group snapshots from a refresh so unchanged conversations keep their references', async () => {
    const { useMingle: store } = await startStore();
    const group = (id: string, count: number) => ({
      group: { id, projectId: 'p', title: id, anchorSessionId: 's', mode: 'cowork', orchestratorMemberId: null, paused: false, pauseReason: null },
      members: [{ id: `${id}-m`, groupId: id, sessionId: 's', handle: 'a', role: 'peer', joinedAt: at, removedAt: null }],
      messages: Array.from({ length: count }, (_, seq) => ({ id: `${id}-g${seq}`, seq, groupId: id, senderMemberId: null, recipientMemberIds: [], kind: 'user', content: `hi ${seq}`, requestId: null, replyToId: null, sourceMessageId: null })),
      requests: [], deliveries: [], assignments: [],
    });
    bootstrap.mockResolvedValueOnce(payload({ groups: [group('a', 20), group('b', 20)] }));
    await store.getState().refreshNow();
    const before = store.getState().boot!.groups!;
    bootstrap.mockResolvedValueOnce(payload({ version: 'group', groups: [group('a', 20), group('b', 21)] }));
    await store.getState().refreshNow();
    const after = store.getState().boot!.groups!;
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1].members).toBe(before[1].members);
    expect(after[1].messages.slice(0, 20).every((message, index) => message === before[1].messages[index])).toBe(true);
  });
});
