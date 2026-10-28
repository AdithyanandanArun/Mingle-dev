import { afterEach, expect, it, vi } from 'vitest';

const { bootstrap } = vi.hoisted(() => ({ bootstrap: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { bootstrap }, errorMessage: (error: unknown) => String(error) }));

let useMingle: typeof import('./store').useMingle | undefined;
afterEach(() => {
  bootstrap.mockReset();
  useMingle?.setState({ boot: null, bootError: null, bootLoading: true, staleError: null });
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
