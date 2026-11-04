import { describe, expect, it } from 'vitest';
import type { Message } from '@mingle/contracts';
import {
  BOOTSTRAP_MESSAGES_PER_SESSION, EMPTY_HISTORY, HISTORY_CACHED_SESSIONS, HISTORY_IDLE_KEEP, HISTORY_OPEN_LIMIT, HISTORY_PAGE_SIZE,
  canLoadOlder, createSessionHistoryCache, loadFailed, oldestDisplayed, pageLoaded, settleIdle, syncWindow, withOlderMessages,
  type HistoryFetcher, type SessionHistory,
} from './sessionHistory';

const T0 = Date.parse('2026-11-01T00:00:00Z');
const message = (index: number, extra: Partial<Message> = {}): Message => ({
  id: `m${String(index).padStart(5, '0')}`, sessionId: 's1', role: index % 2 ? 'assistant' : 'user', content: `text ${index}`, createdAt: new Date(T0 + index * 1000).toISOString(), ...extra,
});
const range = (from: number, to: number, extra: Partial<Message> = {}): Message[] => Array.from({ length: Math.max(0, to - from) }, (_, offset) => message(from + offset, extra));
const ids = (messages: readonly Message[]) => messages.map((m) => m.id);
const full = (from: number): Message[] => range(from, from + BOOTSTRAP_MESSAGES_PER_SESSION);

/** In-memory stand-in for the server: stored order is the id order; mirrors the endpoint's cursor semantics. */
function server(total: number, sessionId = 's1') {
  const stored = range(0, total, { sessionId });
  const calls: Array<{ limit: number; before: string }> = [];
  const fetchPage: HistoryFetcher = async (_session, params) => {
    calls.push(params);
    const at = stored.findIndex((m) => m.id === params.before);
    if (at < 0) throw new Error('History cursor not found in this session');
    return stored.slice(Math.max(0, at - params.limit), at);
  };
  return { stored, calls, fetchPage };
}
const gate = () => { let open!: () => void; const opened = new Promise<void>((resolve) => { open = resolve; }); return { opened, open }; };

describe('syncWindow', () => {
  it('knows a short bootstrap window is the whole session, and a full one may have more', () => {
    expect(syncWindow(EMPTY_HISTORY, range(0, 12)).hasMore).toBe(false);
    expect(syncWindow(EMPTY_HISTORY, full(100)).hasMore).toBe(true);
    expect(syncWindow(EMPTY_HISTORY, [])).toBe(EMPTY_HISTORY);
  });

  it('returns the same history when the window is unchanged and ignores optimistic messages', () => {
    const first = syncWindow(EMPTY_HISTORY, full(0));
    const again = syncWindow(first, [...first.window]);
    expect(again).toBe(first);
    const optimistic = syncWindow(first, [...first.window, message(9999, { id: 'optimistic:abc' })]);
    expect(optimistic).toBe(first);
  });

  it('keeps messages that slide out of the window, in order, so a reader loses nothing', () => {
    let history = syncWindow(EMPTY_HISTORY, full(100));
    history = syncWindow(history, full(103));
    expect(ids(history.older)).toEqual(ids(range(100, 103)));
    history = syncWindow(history, full(110));
    expect(ids(history.older)).toEqual(ids(range(100, 110)));
    expect(history.window[0]!.id).toBe(message(110).id);
    expect(oldestDisplayed(history)!.id).toBe(message(100).id);
  });

  it('discards held history and bumps the epoch when the window cannot be proven contiguous', () => {
    let history = syncWindow(EMPTY_HISTORY, full(100));
    history = pageLoaded(history, { cursor: message(100).id, epoch: 0 }, 's1', range(0, 100), false);
    expect(history.older).toHaveLength(100);
    const jumped = syncWindow(history, full(1000));
    expect(jumped.older).toEqual([]);
    expect(jumped.epoch).toBe(history.epoch + 1);
    expect(jumped.hasMore).toBe(true);
    expect(jumped.notice).toMatch(/cleared/);
    expect(syncWindow(syncWindow(EMPTY_HISTORY, full(100)), full(1000)).notice).toBeNull();
  });
});

describe('pageLoaded', () => {
  const base = (): SessionHistory => syncWindow(EMPTY_HISTORY, full(500));
  const request = (h: SessionHistory) => ({ cursor: oldestDisplayed(h)!.id, epoch: h.epoch });

  it('prepends the page in front of what is held', () => {
    let history = base();
    history = pageLoaded(history, request(history), 's1', range(400, 500), true);
    history = pageLoaded(history, request(history), 's1', range(300, 400), false);
    expect(ids(history.older)).toEqual(ids(range(300, 500)));
    expect(history.hasMore).toBe(false);
    expect(history.phase).toBe('idle');
  });

  it('never replaces a message the bootstrap or earlier pages already hold, and drops other sessions and optimistic rows', () => {
    const history = base();
    const fresher = message(500, { content: 'fresh bootstrap text' });
    const stale = { ...fresher, content: 'old fetched text' };
    const page = [message(1, { sessionId: 's2' }), message(2, { id: 'optimistic:x' }), message(3), message(3), stale, message(4)];
    const next = pageLoaded(history, request(history), 's1', page, true);
    expect(ids(next.older)).toEqual([message(3).id, message(4).id]);
    expect(next.window.find((m) => m.id === fresher.id)).toEqual(history.window.find((m) => m.id === fresher.id));
  });

  it('ignores a response for history that was reset or whose oldest message changed', () => {
    const history = base();
    const loading = { ...history, phase: 'loading' as const };
    expect(pageLoaded(loading, { cursor: oldestDisplayed(history)!.id, epoch: history.epoch + 1 }, 's1', range(400, 500), true)).toEqual({ ...history, phase: 'idle' });
    expect(pageLoaded(loading, { cursor: 'm-other', epoch: history.epoch }, 's1', range(400, 500), true).older).toEqual([]);
    expect(loadFailed(loading, { cursor: 'm-other', epoch: history.epoch }, 'boom').phase).toBe('idle');
  });

  it('reports a page that adds nothing while claiming more, instead of looping on the same cursor', () => {
    const history = base();
    const next = pageLoaded(history, request(history), 's1', [], true);
    expect(next.phase).toBe('error');
    expect(next.error).toMatch(/no new older/);
    expect(canLoadOlder(next)).toBe(true);
  });
});

describe('settleIdle and limits', () => {
  it('keeps only the part nearest the live window for a session that is left, and reports more history exists', () => {
    const history: SessionHistory = { ...syncWindow(EMPTY_HISTORY, full(2000)), older: range(1000, 2000), hasMore: false };
    const settled = settleIdle(history);
    expect(settled.older).toHaveLength(HISTORY_IDLE_KEEP);
    expect(settled.older.at(-1)!.id).toBe(message(1999).id);
    expect(settled.hasMore).toBe(true);
    expect(settled.epoch).toBe(history.epoch + 1);
    expect(settleIdle(settled)).toBe(settled);
  });

  it('stops offering older messages at the open limit', () => {
    const history: SessionHistory = { ...syncWindow(EMPTY_HISTORY, full(HISTORY_OPEN_LIMIT + 400)), older: range(0, HISTORY_OPEN_LIMIT) };
    expect(canLoadOlder(history)).toBe(false);
  });
});

describe('withOlderMessages', () => {
  it('returns the bootstrap array itself until older history exists, and prefers the bootstrap copy', () => {
    const boot = range(10, 20);
    expect(withOlderMessages([], boot, boot)).toBe(boot);
    const merged = withOlderMessages([...range(0, 10), { ...message(12), content: 'old copy' }], boot, boot)!;
    expect(ids(merged)).toEqual(ids(range(0, 20)));
    expect(merged.find((m) => m.id === message(12).id)!.content).toBe('text 12');
  });
});

describe('session history cache', () => {
  it('loads strictly older pages on demand, oldest first, with one extra row to know whether more exist', async () => {
    const remote = server(1000);
    const cache = createSessionHistoryCache(remote.fetchPage);
    cache.commit('s1', syncWindow(EMPTY_HISTORY, remote.stored.slice(700)));
    expect(remote.calls).toEqual([]);
    await cache.loadOlder('s1');
    expect(remote.calls).toEqual([{ limit: HISTORY_PAGE_SIZE + 1, before: message(700).id }]);
    let history = cache.get('s1');
    expect(ids(history.older)).toEqual(ids(range(600, 700)));
    expect(history.hasMore).toBe(true);
    for (let page = 0; page < 6; page++) await cache.loadOlder('s1');
    history = cache.get('s1');
    expect(ids(history.older)).toEqual(ids(range(0, 700)));
    expect(history.hasMore).toBe(false);
    await cache.loadOlder('s1');
    expect(remote.calls).toHaveLength(7);
  });

  it('answers overlapping requests with one fetch', async () => {
    const remote = server(1000);
    const hold = gate();
    const cache = createSessionHistoryCache(async (...args) => { await hold.opened; return remote.fetchPage(...args); });
    cache.commit('s1', syncWindow(EMPTY_HISTORY, remote.stored.slice(700)));
    const first = cache.loadOlder('s1');
    const second = cache.loadOlder('s1');
    expect(cache.get('s1').phase).toBe('loading');
    hold.open();
    await Promise.all([first, second]);
    expect(remote.calls).toHaveLength(1);
    expect(cache.get('s1').older).toHaveLength(100);
  });

  it('shows a failure, keeps what was loaded, and retries from the same cursor', async () => {
    const remote = server(1000);
    let failing = true;
    const cache = createSessionHistoryCache(async (...args) => { if (failing) throw new Error('Cannot reach the local runtime.'); return remote.fetchPage(...args); });
    cache.commit('s1', syncWindow(EMPTY_HISTORY, remote.stored.slice(700)));
    await cache.loadOlder('s1');
    expect(cache.get('s1')).toMatchObject({ phase: 'error', error: 'Cannot reach the local runtime.', older: [] });
    failing = false;
    await cache.loadOlder('s1');
    expect(cache.get('s1')).toMatchObject({ phase: 'idle', error: null });
    expect(cache.get('s1').older).toHaveLength(100);
  });

  it('calls beforeApply only when a page is published, with the old transcript still current', async () => {
    const remote = server(1000);
    const cache = createSessionHistoryCache(remote.fetchPage);
    cache.commit('s1', syncWindow(EMPTY_HISTORY, remote.stored.slice(700)));
    const seen: number[] = [];
    await cache.loadOlder('s1', { beforeApply: () => seen.push(cache.get('s1').older.length) });
    expect(seen).toEqual([0]);
    const failing = createSessionHistoryCache(async () => { throw new Error('x'); });
    failing.commit('s1', syncWindow(EMPTY_HISTORY, remote.stored.slice(700)));
    let called = false;
    await failing.loadOlder('s1', { beforeApply: () => { called = true; } });
    expect(called).toBe(false);
  });

  it('drops a response that arrives after the session was left, and aborts its request', async () => {
    const remote = server(1000);
    const hold = gate();
    const aborted: boolean[] = [];
    const cache = createSessionHistoryCache(async (session, params, signal) => { await hold.opened; aborted.push(signal.aborted); return remote.fetchPage(session, params, signal); });
    cache.commit('s1', syncWindow(EMPTY_HISTORY, remote.stored.slice(700)));
    const pending = cache.loadOlder('s1');
    cache.release('s1');
    hold.open();
    await pending;
    expect(aborted).toEqual([true]);
    expect(cache.get('s1')).toMatchObject({ phase: 'idle', older: [] });
    // Returning to the session can load again, and gets the page exactly once.
    await cache.loadOlder('s1');
    expect(cache.get('s1').older).toHaveLength(100);
  });

  it('drops a response when the held history was reset while it was in flight', async () => {
    const remote = server(1000);
    const hold = gate();
    const cache = createSessionHistoryCache(async (...args) => { await hold.opened; return remote.fetchPage(...args); });
    cache.commit('s1', syncWindow(EMPTY_HISTORY, remote.stored.slice(300, 600)));
    const pending = cache.loadOlder('s1');
    cache.commit('s1', syncWindow(cache.get('s1'), remote.stored.slice(700, 1000)));
    hold.open();
    await pending;
    expect(cache.get('s1').older).toEqual([]);
    expect(cache.get('s1').phase).toBe('idle');
    expect(cache.get('s1').window[0]!.id).toBe(message(700).id);
  });

  it('keeps a page loaded for the cursor even when new messages slid the window meanwhile', async () => {
    const remote = server(1000);
    const hold = gate();
    const cache = createSessionHistoryCache(async (...args) => { await hold.opened; return remote.fetchPage(...args); });
    cache.commit('s1', syncWindow(EMPTY_HISTORY, remote.stored.slice(500, 800)));
    const pending = cache.loadOlder('s1');
    cache.commit('s1', syncWindow(cache.get('s1'), remote.stored.slice(502, 802)));
    hold.open();
    await pending;
    expect(ids(cache.get('s1').older)).toEqual(ids(range(400, 502)));
  });

  it('bounds the sessions it remembers and cancels evicted loads', async () => {
    const hold = gate();
    const signals: AbortSignal[] = [];
    const cache = createSessionHistoryCache(async (_s, _p, signal) => { signals.push(signal); await hold.opened; return []; });
    cache.commit('first', syncWindow(EMPTY_HISTORY, full(0).map((m) => ({ ...m, sessionId: 'first' }))));
    const pending = cache.loadOlder('first');
    for (let index = 0; index < HISTORY_CACHED_SESSIONS; index++) cache.commit(`other${index}`, syncWindow(EMPTY_HISTORY, range(0, 3)));
    expect(cache.size()).toBe(HISTORY_CACHED_SESSIONS);
    expect(cache.has('first')).toBe(false);
    expect(signals[0]!.aborted).toBe(true);
    hold.open();
    await pending;
    expect(cache.get('first')).toBe(EMPTY_HISTORY);
  });

  it('notifies subscribers on every committed change and not after unsubscribing', async () => {
    const remote = server(400);
    const cache = createSessionHistoryCache(remote.fetchPage);
    let count = 0;
    const off = cache.subscribe(() => { count++; });
    cache.commit('s1', syncWindow(EMPTY_HISTORY, remote.stored.slice(100)));
    await cache.loadOlder('s1');
    expect(count).toBe(3);
    off();
    cache.commit('s1', EMPTY_HISTORY);
    expect(count).toBe(3);
  });
});
