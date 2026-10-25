import { afterEach, expect, it, vi } from 'vitest';

const { bootstrap } = vi.hoisted(() => ({ bootstrap: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { bootstrap }, errorMessage: (error: unknown) => String(error) }));

let useMingle: typeof import('./store').useMingle | undefined;
afterEach(() => {
  bootstrap.mockReset();
  useMingle?.setState({ boot: null, bootError: null, bootLoading: true, staleError: null });
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
