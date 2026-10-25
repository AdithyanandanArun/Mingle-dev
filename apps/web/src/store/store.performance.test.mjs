import { afterEach, expect, it, vi } from 'vitest';

const { bootstrap } = vi.hoisted(() => ({ bootstrap: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { bootstrap }, errorMessage: (error) => String(error) }));

let useMingle;
afterEach(() => {
  bootstrap.mockReset();
  useMingle?.setState({ boot: null, bootError: null, bootLoading: true, staleError: null });
});

it('keeps one bootstrap in flight, makes one trailing fetch, and skips an unchanged state update', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  ({ useMingle } = await import('./store.ts'));
  let resolveFirst;
  let resolveTrailing;
  bootstrap
    .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveTrailing = resolve; }));

  const payload = {
    projects: [], sessions: [], messages: [], tasks: [], events: [], approvals: [], plans: [], questions: [], providers: [],
    settings: {}, version: 'test', runs: [], toolCalls: [],
  };
  let updates = 0;
  const unsubscribe = useMingle.subscribe(() => { updates++; });
  try {
    const first = useMingle.getState().refreshNow();
    const joined = useMingle.getState().refreshNow();
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
