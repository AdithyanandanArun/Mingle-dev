import { describe, expect, it } from 'vitest';
import { createRefreshCoordinator, MAX_SCOPED_BATCH, SCOPED_FAILURE_COOLDOWN_MS, SCOPED_FAILURE_LIMIT, type ScopedOutcome } from './refreshCoordinator';

/** Requests whose completion the test controls, recording the order they were issued in and how many overlapped. */
function harness(options: { eligible?: (id: string) => boolean } = {}) {
  const log: string[] = [];
  const gates: Array<{ name: string; resolve: (outcome?: ScopedOutcome) => void; reject: (error: Error) => void }> = [];
  let open = 0;
  let maxOpen = 0;
  let clock = 1_000;
  const gate = <T>(name: string, done: (outcome?: ScopedOutcome) => T) => new Promise<T>((resolve, reject) => {
    log.push(name); open++; maxOpen = Math.max(maxOpen, open);
    gates.push({ name, resolve: (outcome) => { open--; resolve(done(outcome)); }, reject: (error) => { open--; reject(error); } });
  });
  const coordinator = createRefreshCoordinator({
    full: () => gate('full', () => undefined),
    session: (id) => gate(`session:${id}`, (outcome) => outcome ?? 'applied') as Promise<ScopedOutcome>,
    eligible: options.eligible ?? (() => true),
    now: () => clock,
  });
  const next = async (outcome?: ScopedOutcome) => {
    await Promise.resolve();
    const open = gates.shift();
    if (!open) throw new Error('nothing in flight');
    open.resolve(outcome);
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  return { coordinator, log, gates, next, advance: (ms: number) => { clock += ms; }, maxOpen: () => maxOpen };
}

describe('refresh coordinator', () => {
  it('refreshes only the marked session and issues no full refresh', async () => {
    const h = harness();
    h.coordinator.requestSessions(['a']);
    const done = h.coordinator.flush();
    expect(h.log).toEqual(['session:a']);
    await h.next();
    await done;
    expect(h.log).toEqual(['session:a']);
  });

  it('lets a full refresh supersede queued scoped marks', async () => {
    const h = harness();
    h.coordinator.requestSessions(['a', 'b']);
    h.coordinator.requestFull();
    h.coordinator.requestSessions(['c']);
    const done = h.coordinator.flush();
    await h.next();
    await done;
    expect(h.log).toEqual(['full']);
  });

  it('never overlaps requests and serves a mark made mid-flight with a trailing request once a flush is demanded', async () => {
    const h = harness();
    h.coordinator.requestSessions(['a']);
    const done = h.coordinator.flush();
    expect(h.log).toEqual(['session:a']);
    // The change arrives while the first answer may already have been read: it is not covered by it.
    h.coordinator.requestSessions(['a']);
    const trailing = h.coordinator.flush();
    expect(h.log).toEqual(['session:a']);
    await h.next();
    expect(h.log).toEqual(['session:a', 'session:a']);
    await h.next();
    await Promise.all([done, trailing]);
    expect(h.maxOpen()).toBe(1);
    expect(h.coordinator.pending).toBe(false);
  });

  it('leaves marks made mid-flight for the next flush, so a steady event stream cannot cause back-to-back requests', async () => {
    const h = harness();
    h.coordinator.requestSessions(['a']);
    const done = h.coordinator.flush();
    for (let burst = 0; burst < 5; burst++) h.coordinator.requestSessions(['a']);
    await h.next();
    await done;
    // Nothing demanded them, so the loop ended instead of immediately asking again.
    expect(h.log).toEqual(['session:a']);
    expect(h.coordinator.pending).toBe(true);
    const next = h.coordinator.flush();
    expect(h.log).toEqual(['session:a', 'session:a']);
    await h.next();
    await next;
    expect(h.coordinator.pending).toBe(false);
  });

  it('serves a full refresh asked for during a scoped one afterwards, and drops marks it covers', async () => {
    const h = harness();
    h.coordinator.requestSessions(['a', 'b', 'c']);
    const done = h.coordinator.flush();
    expect(h.log).toEqual(['session:a']);
    h.coordinator.requestFull();
    const joined = h.coordinator.flush();
    await h.next();
    expect(h.log).toEqual(['session:a', 'full']);
    await h.next();
    await Promise.all([done, joined]);
    expect(h.log).toEqual(['session:a', 'full']);
    expect(h.maxOpen()).toBe(1);
  });

  it('resolves an explicit full refresh only after a request started after the call', async () => {
    const h = harness();
    h.coordinator.requestFull();
    const first = h.coordinator.flush();
    h.coordinator.requestFull();
    let settled = false;
    const second = h.coordinator.flush().then(() => { settled = true; });
    await h.next();
    expect(settled).toBe(false);
    expect(h.log).toEqual(['full', 'full']);
    await h.next();
    await Promise.all([first, second]);
    expect(settled).toBe(true);
  });

  it('starts a new loop for a request made after the previous one finished', async () => {
    const h = harness();
    h.coordinator.requestSessions(['a']);
    const first = h.coordinator.flush();
    await h.next();
    await first;
    h.coordinator.requestSessions(['b']);
    const second = h.coordinator.flush();
    expect(h.log).toEqual(['session:a', 'session:b']);
    await h.next();
    await second;
  });

  it('does nothing, and keeps nothing running, when there is no mark', async () => {
    const h = harness();
    await h.coordinator.flush();
    expect(h.log).toEqual([]);
    h.coordinator.requestFull();
    const done = h.coordinator.flush();
    expect(h.log).toEqual(['full']);
    await h.next();
    await done;
  });

  it('escalates ineligible sessions and oversized batches to a full refresh', async () => {
    const h = harness({ eligible: (id) => id !== 'group-member' });
    h.coordinator.requestSessions(['a', 'group-member']);
    let done = h.coordinator.flush();
    await h.next();
    await done;
    expect(h.log).toEqual(['full']);

    h.log.length = 0;
    h.coordinator.requestSessions(Array.from({ length: MAX_SCOPED_BATCH + 1 }, (_, index) => `s${index}`));
    done = h.coordinator.flush();
    await h.next();
    await done;
    expect(h.log).toEqual(['full']);
  });

  it('falls back to a full refresh when a scoped refresh fails, and keeps that session on full refreshes for a while', async () => {
    const h = harness();
    h.coordinator.requestSessions(['a']);
    let done = h.coordinator.flush();
    h.gates.shift()!.reject(new Error('HTTP 404'));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.log).toEqual(['session:a', 'full']);
    await h.next();
    await done;

    h.log.length = 0;
    h.coordinator.requestSessions(['a']);
    done = h.coordinator.flush();
    expect(h.log).toEqual(['full']);
    await h.next();
    await done;

    h.log.length = 0;
    h.advance(SCOPED_FAILURE_COOLDOWN_MS + 1);
    h.coordinator.requestSessions(['a']);
    done = h.coordinator.flush();
    expect(h.log).toEqual(['session:a']);
    await h.next();
    await done;
  });

  it('stops using scoped refreshes after repeated failures until a new connection resets it', async () => {
    const h = harness();
    for (let index = 0; index < SCOPED_FAILURE_LIMIT; index++) {
      h.coordinator.requestSessions([`s${index}`]);
      const done = h.coordinator.flush();
      h.gates.shift()!.reject(new Error('unsupported'));
      for (let i = 0; i < 4; i++) await Promise.resolve();
      await h.next();
      await done;
    }
    h.log.length = 0;
    h.coordinator.requestSessions(['fresh']);
    let done = h.coordinator.flush();
    expect(h.log).toEqual(['full']);
    await h.next();
    await done;

    h.log.length = 0;
    h.coordinator.reset();
    done = h.coordinator.flush();
    await h.next();
    await done;
    h.log.length = 0;
    h.coordinator.requestSessions(['fresh']);
    done = h.coordinator.flush();
    expect(h.log).toEqual(['session:fresh']);
    await h.next();
    await done;
  });

  it('escalates to a full refresh when the scoped answer cannot be applied', async () => {
    const h = harness();
    h.coordinator.requestSessions(['a']);
    const done = h.coordinator.flush();
    await h.next('needs-full');
    expect(h.log).toEqual(['session:a', 'full']);
    await h.next();
    await done;
  });

  it('treats a discarded answer (for example an archived session) as handled', async () => {
    const h = harness();
    h.coordinator.requestSessions(['a']);
    const done = h.coordinator.flush();
    await h.next('discarded');
    await done;
    expect(h.log).toEqual(['session:a']);
  });
});
