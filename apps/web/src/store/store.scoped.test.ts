import type { Bootstrap, SessionSnapshot } from '@mingle/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { bootstrap, sessionSnapshot, rememberProject } = vi.hoisted(() => ({ bootstrap: vi.fn(), sessionSnapshot: vi.fn(), rememberProject: vi.fn().mockResolvedValue({}) }));
vi.mock('../lib/api', () => ({ api: { bootstrap, sessionSnapshot, rememberProject }, errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)) }));

const at = '2026-11-04T12:00:00.000Z';
type Boot = Bootstrap & { groups: NonNullable<Bootstrap['groups']> };

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id, projectId: 'p', name: id, provider: 'codex', model: 'm', effort: 'medium', status: 'idle', policy: 'supervised', isolated: false, worktreePath: '/p', branch: null,
  providerSessionId: null, createdAt: at, updatedAt: at, error: null, inputTokens: 0, outputTokens: 0, costUsd: null, pinned: false, unread: false, ...extra,
});
const message = (sessionId: string, index: number, content = `${sessionId} message ${index} ${'text '.repeat(40)}`) => ({
  id: `${sessionId}-m${index}`, sessionId, role: index % 2 ? 'assistant' : 'user', content, createdAt: at,
});
function workspace(extraSessions = 0): Boot {
  const ids = ['a', 'b', 'anchor', 'member', ...Array.from({ length: extraSessions }, (_, index) => `x${index}`)];
  return JSON.parse(JSON.stringify({
    projects: [{ id: 'p', name: 'Example project', path: '/p', createdAt: at, isExample: false }],
    sessions: [...ids.map((id) => session(id)), session('helper', { parentSessionId: 'a' })],
    messages: [...ids.flatMap((id) => Array.from({ length: id.startsWith('x') ? 300 : 4 }, (_, index) => message(id, index))), message('helper', 0)],
    tasks: [{ id: 't1', projectId: 'p', title: 'Task', description: '', acceptanceCriteria: '', sessionId: 'a', dependsOn: [], status: 'ready', createdAt: at, updatedAt: at }],
    events: [], approvals: [], plans: [], questions: [], queuedMessages: [], runs: [], toolCalls: [], workflows: [], delegatedSubagents: [],
    providers: [{ id: 'codex', name: 'Codex', available: true, version: '1', executable: 'codex', reason: null, models: [] }],
    settings: {}, version: 'scoped-test',
    groups: [{ group: { id: 'g', anchorSessionId: 'anchor', title: 'Team' }, members: [{ id: 'g1', sessionId: 'anchor', removedAt: null }, { id: 'g2', sessionId: 'member', removedAt: null }], messages: [], requests: [], deliveries: [], assignments: [] }],
  })) as Boot;
}
/** The snapshot a server would produce for `id` from `boot`, optionally edited. */
function snapshotOf(boot: Boot, id: string, edit?: (snap: SessionSnapshot) => void): SessionSnapshot {
  const snap = JSON.parse(JSON.stringify({
    sessionId: id, eventCursor: 1, session: boot.sessions.find((row) => row.id === id),
    messages: boot.messages.filter((row) => row.sessionId === id), runs: boot.runs.filter((row) => row.sessionId === id),
    toolCalls: boot.toolCalls.filter((row) => row.sessionId === id), queuedMessages: (boot.queuedMessages ?? []).filter((row) => row.sessionId === id),
    approvals: boot.approvals.filter((row) => row.sessionId === id), plans: boot.plans.filter((row) => row.sessionId === id),
    questions: boot.questions.filter((row) => row.sessionId === id), workflows: [], delegatedSubagents: [],
  })) as SessionSnapshot;
  edit?.(snap);
  return snap;
}
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeSocket.instances.push(this); }
  send() { /* terminal traffic is not exercised here */ }
  close() { this.readyState = 3; }
}

let useMingle: typeof import('./store').useMingle | undefined;
async function startStore(boot: Boot) {
  vi.resetModules();
  FakeSocket.instances = [];
  const storage = new Map<string, string>();
  const win = Object.assign(new EventTarget(), {
    location: { search: '', protocol: 'http:', host: 'test' },
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  });
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', { addEventListener() { /* unused */ }, removeEventListener() { /* unused */ }, visibilityState: 'visible' });
  vi.stubGlobal('location', win.location);
  vi.stubGlobal('WebSocket', FakeSocket);
  bootstrap.mockResolvedValue(boot);
  const store = await import('./store');
  useMingle = store.useMingle;
  store.useMingle.getState().init();
  await vi.advanceTimersByTimeAsync(0);
  const socket = FakeSocket.instances[0]!;
  socket.readyState = 1;
  const emit = (event: object) => socket.onmessage?.({ data: JSON.stringify(event) });
  const event = (id: number, type: string, sessionId: string | null) => ({ id, projectId: 'p', sessionId, type, summary: type, payload: {}, createdAt: at });
  const scoped = (sessionIds: string[], withEvent?: { id: number; type: string; sessionId: string }) => emit({
    type: 'state.changed', scope: { sessionIds }, ...(withEvent ? { event: event(withEvent.id, withEvent.type, withEvent.sessionId) } : {}),
  });
  /** Lets the 160 ms debounce and the one-second floor between refreshes pass. */
  const settle = (ms = 1_200) => vi.advanceTimersByTimeAsync(ms);
  return { ...store, win, socket, emit, event, scoped, settle };
}

beforeEach(() => { vi.useFakeTimers(); bootstrap.mockReset(); sessionSnapshot.mockReset(); rememberProject.mockClear(); });
afterEach(() => {
  useMingle?.setState({ boot: null, bootError: null, bootLoading: true, staleError: null, activeProjectId: null, sessionByProject: {}, selectedTeamSessionByProject: {}, teamSessionsByProject: {}, streams: {} });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('scoped session refresh', () => {
  it('refreshes a confined event through that session\'s snapshot only, keeping every other reference', async () => {
    const boot = workspace();
    const { useMingle: store, scoped, settle } = await startStore(boot);
    const before = store.getState().boot!;
    const next = snapshotOf(boot, 'a', (snap) => { snap.messages.push(message('a', 4, 'fresh reply') as never); snap.session = { ...snap.session, status: 'waiting' }; });
    sessionSnapshot.mockResolvedValue(next);
    expect(bootstrap).toHaveBeenCalledTimes(1);

    scoped(['a'], { id: 7, type: 'approval.requested', sessionId: 'a' });
    expect(store.getState().boot!.events.map((item) => item.id)).toEqual([7]);
    await settle();

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(sessionSnapshot).toHaveBeenCalledTimes(1);
    expect(sessionSnapshot).toHaveBeenCalledWith('a');
    const after = store.getState().boot!;
    expect(after.messages.filter((row) => row.sessionId === 'a').at(-1)?.content).toBe('fresh reply');
    expect(after.sessions.find((row) => row.id === 'a')?.status).toBe('waiting');
    // Identity reuse: untouched collections and other sessions' rows are the very same objects.
    expect(after.projects).toBe(before.projects);
    expect(after.tasks).toBe(before.tasks);
    expect(after.providers).toBe(before.providers);
    expect(after.groups).toBe(before.groups);
    expect(after.sessions.find((row) => row.id === 'b')).toBe(before.sessions.find((row) => row.id === 'b'));
    for (const old of before.messages.filter((row) => row.sessionId === 'b')) expect(after.messages).toContain(old);
    for (const old of before.messages.filter((row) => row.sessionId === 'a')) expect(after.messages).toContain(old);
  });

  it.each([
    ['an unscoped change', (h: Awaited<ReturnType<typeof startStore>>) => h.emit({ type: 'state.changed' })],
    ['an event without a scope', (h: Awaited<ReturnType<typeof startStore>>) => h.emit({ type: 'state.changed', event: h.event(9, 'session.run.started', 'a') })],
    ['a session the client does not know', (h: Awaited<ReturnType<typeof startStore>>) => h.scoped(['unknown'])],
    ['a group member', (h: Awaited<ReturnType<typeof startStore>>) => h.scoped(['member'])],
    ['a group anchor', (h: Awaited<ReturnType<typeof startStore>>) => h.scoped(['anchor'])],
    ['a helper session', (h: Awaited<ReturnType<typeof startStore>>) => h.scoped(['helper'])],
    ['an oversized batch', (h: Awaited<ReturnType<typeof startStore>>) => h.scoped(['a', 'b', 'a2', 'b2', 'c2'])],
    ['a scope that disagrees with its event', (h: Awaited<ReturnType<typeof startStore>>) => h.scoped(['a'], { id: 11, type: 'approval.requested', sessionId: 'b' })],
    ['an empty scope', (h: Awaited<ReturnType<typeof startStore>>) => h.emit({ type: 'state.changed', scope: { sessionIds: [] } })],
    ['a malformed scope', (h: Awaited<ReturnType<typeof startStore>>) => h.emit({ type: 'state.changed', scope: { sessionIds: [3, null] } })],
  ])('keeps the full snapshot for %s', async (_name, trigger) => {
    const h = await startStore(workspace());
    sessionSnapshot.mockResolvedValue(snapshotOf(workspace(), 'a'));
    trigger(h);
    await h.settle();
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(sessionSnapshot).not.toHaveBeenCalled();
  });

  it('serves an event that arrives mid-flight with a trailing snapshot, applied in order', async () => {
    const boot = workspace();
    const h = await startStore(boot);
    const first = deferred<SessionSnapshot>();
    const second = deferred<SessionSnapshot>();
    sessionSnapshot.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    h.scoped(['a']);
    await h.settle();
    expect(sessionSnapshot).toHaveBeenCalledTimes(1);
    h.scoped(['a']);
    await h.settle();
    // The second change is not covered by the request still in flight, and requests never overlap.
    expect(sessionSnapshot).toHaveBeenCalledTimes(1);
    first.resolve(snapshotOf(boot, 'a', (snap) => { snap.messages.push(message('a', 4, 'one') as never); }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionSnapshot).toHaveBeenCalledTimes(2);
    expect(h.useMingle.getState().boot!.messages.filter((row) => row.sessionId === 'a').at(-1)?.content).toBe('one');
    second.resolve(snapshotOf(boot, 'a', (snap) => { snap.messages.push(message('a', 4, 'one') as never, message('a', 5, 'two') as never); }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.useMingle.getState().boot!.messages.filter((row) => row.sessionId === 'a').map((row) => row.content).slice(-2)).toEqual(['one', 'two']);
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it('never overlaps a full refresh with a scoped one, and a stream gap still recovers with the full snapshot', async () => {
    const boot = workspace();
    const h = await startStore(boot);
    const inFlight = deferred<SessionSnapshot>();
    sessionSnapshot.mockReturnValueOnce(inFlight.promise);
    h.scoped(['a']);
    await h.settle();
    expect(sessionSnapshot).toHaveBeenCalledTimes(1);
    // A delta that skips text cannot be repaired by a session slice alone: it asks for everything.
    h.emit({ type: 'session.delta', sessionId: 'a', messageId: 'a-m3', delta: 'gap', offset: 99_999 });
    await h.settle();
    expect(bootstrap).toHaveBeenCalledTimes(1);
    inFlight.resolve(snapshotOf(boot, 'a'));
    await vi.advanceTimersByTimeAsync(0);
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(sessionSnapshot).toHaveBeenCalledTimes(1);
  });

  it('falls back to a full refresh when the endpoint fails, 404s or answers for the wrong session, and applies none of it', async () => {
    const boot = workspace();
    const h = await startStore(boot);
    const before = h.useMingle.getState().boot!;
    sessionSnapshot.mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }));
    h.scoped(['a']);
    await h.settle();
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(h.useMingle.getState().staleError).toBeNull();

    // Within the cooldown the same session goes straight to the full snapshot.
    h.scoped(['a']);
    await h.settle();
    expect(sessionSnapshot).toHaveBeenCalledTimes(1);
    expect(bootstrap).toHaveBeenCalledTimes(3);

    // A different session answered by a malformed body is rejected before anything is merged.
    sessionSnapshot.mockResolvedValueOnce({ ...snapshotOf(boot, 'a'), sessionId: 'b' });
    h.scoped(['b']);
    await h.settle();
    expect(bootstrap).toHaveBeenCalledTimes(4);
    sessionSnapshot.mockResolvedValueOnce({ sessionId: 'b' });
    h.scoped(['b']);
    await h.settle();
    expect(bootstrap).toHaveBeenCalledTimes(5);
    expect(h.useMingle.getState().boot).toBe(before);
  });

  it('keeps an optimistic message until the server copy arrives and does not roll back live stream text', async () => {
    const boot = workspace();
    const h = await startStore(boot);
    h.win.dispatchEvent(new CustomEvent('mingle:optimistic-session-message', { detail: { message: { id: 'optimistic:1', sessionId: 'a', role: 'user', content: 'typed', createdAt: at } } }));
    // Live text already ahead of what the snapshot holds.
    const live = boot.messages.find((row) => row.id === 'a-m3')!;
    h.emit({ type: 'session.delta', sessionId: 'a', messageId: live.id, delta: ' streamed beyond the snapshot', offset: live.content.length });
    await vi.advanceTimersByTimeAsync(40);
    sessionSnapshot.mockResolvedValueOnce(snapshotOf(boot, 'a'));
    h.scoped(['a']);
    await h.settle();
    const state = h.useMingle.getState();
    expect(state.boot!.messages.at(-1)).toMatchObject({ id: 'optimistic:1', content: 'typed' });
    expect(state.streams[live.id]!.base + state.streams[live.id]!.text).toBe(`${live.content} streamed beyond the snapshot`);

    // Once the saved copy exists the optimistic row is satisfied and the caught-up stream is pruned.
    sessionSnapshot.mockResolvedValueOnce(snapshotOf(boot, 'a', (snap) => {
      snap.messages.push({ id: 'saved-1', sessionId: 'a', role: 'user', content: 'typed', createdAt: at } as never);
      snap.messages.find((row) => row.id === live.id)!.content = `${live.content} streamed beyond the snapshot`;
    }));
    h.scoped(['a']);
    await h.settle();
    const done = h.useMingle.getState();
    expect(done.boot!.messages.some((row) => row.id === 'optimistic:1')).toBe(false);
    expect(done.boot!.messages.some((row) => row.id === 'saved-1')).toBe(true);
    expect(done.streams[live.id]).toBeUndefined();
  });

  it('does not resurrect a session archived while its snapshot was in flight, nor from a stale full snapshot', async () => {
    const boot = workspace();
    const h = await startStore(boot);
    const inFlight = deferred<SessionSnapshot>();
    sessionSnapshot.mockReturnValueOnce(inFlight.promise);
    h.scoped(['a']);
    await h.settle();
    h.useMingle.getState().applyArchivedSessions(['a']);
    inFlight.resolve(snapshotOf(boot, 'a', (snap) => { snap.messages.push(message('a', 4, 'late') as never); }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.useMingle.getState().boot!.sessions.some((row) => row.id === 'a')).toBe(false);
    expect(h.useMingle.getState().boot!.messages.some((row) => row.content === 'late')).toBe(false);

    // A full snapshot issued before the archive still lists it.
    bootstrap.mockResolvedValue({ ...boot, version: 'stale-full' });
    await h.useMingle.getState().refreshNow();
    expect(h.useMingle.getState().boot!.sessions.some((row) => row.id === 'a')).toBe(false);
    // Once the server stops listing it, nothing is held back.
    bootstrap.mockResolvedValue({ ...boot, version: 'caught-up', sessions: boot.sessions.filter((row) => row.id !== 'a'), messages: boot.messages.filter((row) => row.sessionId !== 'a') });
    await h.useMingle.getState().refreshNow();
    bootstrap.mockResolvedValue({ ...boot, version: 'restored' });
    await h.useMingle.getState().refreshNow();
    expect(h.useMingle.getState().boot!.sessions.some((row) => row.id === 'a')).toBe(true);
  });

  it('turns a session that became part of a group while in flight into a full refresh', async () => {
    const boot = workspace();
    const h = await startStore(boot);
    const inFlight = deferred<SessionSnapshot>();
    sessionSnapshot.mockReturnValueOnce(inFlight.promise);
    h.scoped(['b']);
    await h.settle();
    h.useMingle.getState().applyGroup({ group: { id: 'g2', anchorSessionId: 'b', title: 'Converted' }, members: [{ id: 'c1', sessionId: 'b', removedAt: null }], messages: [], requests: [], deliveries: [], assignments: [] } as never);
    inFlight.resolve(snapshotOf(boot, 'b', (snap) => { snap.messages.push(message('b', 4, 'pre-conversion') as never); }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.useMingle.getState().boot!.messages.some((row) => row.content === 'pre-conversion')).toBe(false);
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });

  it('drops queued scoped marks on reconnect and rebuilds with one full snapshot', async () => {
    const boot = workspace();
    const h = await startStore(boot);
    h.scoped(['a']);
    h.socket.onopen?.();
    await h.settle();
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(sessionSnapshot).not.toHaveBeenCalled();
  });

  it('keeps the event list to the bootstrap window while only scoped refreshes run', async () => {
    const boot = workspace();
    boot.events = Array.from({ length: 500 }, (_, index) => ({ id: index + 1, projectId: 'p', sessionId: null, type: 'x', summary: '', payload: {}, createdAt: at }));
    const h = await startStore(boot);
    sessionSnapshot.mockResolvedValue(snapshotOf(boot, 'a'));
    h.scoped(['a'], { id: 1_000, type: 'approval.resolved', sessionId: 'a' });
    const events = h.useMingle.getState().boot!.events;
    expect(events).toHaveLength(500);
    expect(events.at(-1)!.id).toBe(1_000);
    expect(events[0]!.id).toBe(2);
  });

  it('measures requests and payload for a run on a sizeable workspace against the full-snapshot cycle', async () => {
    const boot = workspace(36);
    const h = await startStore(boot);
    const bootBytes = JSON.stringify(boot).length;
    const snapBytes = JSON.stringify(snapshotOf(boot, 'x3')).length;
    sessionSnapshot.mockImplementation(async () => snapshotOf(boot, 'x3'));
    let fetchedBytes = 0;
    const scopedCycles = 20;
    for (let cycle = 0; cycle < scopedCycles; cycle++) {
      h.scoped(['x3']);
      await h.settle(1_100);
      fetchedBytes += snapBytes;
    }
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(sessionSnapshot).toHaveBeenCalledTimes(scopedCycles);
    // A busy run no longer reloads the other 40 sessions.
    expect(snapBytes).toBeLessThan(bootBytes / 15);
    console.info(`[item4] ${boot.sessions.length} sessions, ${boot.messages.length} messages: ${scopedCycles} activity cycles -> ${scopedCycles} session snapshots (${fetchedBytes} B) and 0 extra bootstraps; previously ${scopedCycles} bootstraps (${scopedCycles * bootBytes} B) = ${(bootBytes / snapBytes).toFixed(1)}x less per refresh`);
  });
});

describe('scheduler', () => {
  it('keeps the one-second floor and two-second ceiling for scoped refreshes', async () => {
    const boot = workspace();
    const h = await startStore(boot);
    sessionSnapshot.mockResolvedValue(snapshotOf(boot, 'a'));
    // A continuous stream of scoped events cannot postpone the refresh beyond the two-second ceiling.
    for (let tick = 0; tick < 30; tick++) { h.scoped(['a']); await vi.advanceTimersByTimeAsync(100); }
    expect(sessionSnapshot.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(sessionSnapshot.mock.calls.length).toBeLessThanOrEqual(3);
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });
});
