/**
 * Serializes workspace refreshes. Notifications only mark what is stale (everything, or specific sessions); `flush` turns
 * the marks made so far into requests, one at a time, so two responses can never be applied out of order.
 *
 * Marks are paced by whoever calls `flush` (the store's debounced scheduler for notifications, immediately for explicit
 * refreshes): a mark made while a request is in flight waits for the next `flush`, and the request in flight does not cover
 * it (the server may have read its state before the change). A full refresh supersedes the scoped marks it replaces, all of
 * which were made before it was issued. Anything a scoped refresh cannot vouch for (ineligible session, failed or malformed
 * answer, unsupported endpoint) escalates to a full refresh; nothing here polls or repeats a full refresh to hide a hole.
 */

export type ScopedOutcome = 'applied' | 'discarded' | 'needs-full';

export interface RefreshActions {
  /** Fetches and applies a whole bootstrap; reports its own failures and never rejects. */
  full(): Promise<void>;
  /** Fetches and applies one session's snapshot. A rejection is a failed scoped refresh. */
  session(sessionId: string): Promise<ScopedOutcome>;
  /** Whether a scoped refresh may represent this session honestly (a known standalone session). */
  eligible(sessionId: string): boolean;
  now?(): number;
}

/** More stale sessions than this are cheaper and simpler to reload together. */
export const MAX_SCOPED_BATCH = 4;
/** A session whose scoped refresh failed uses full refreshes for this long. */
export const SCOPED_FAILURE_COOLDOWN_MS = 30_000;
/** Consecutive scoped failures after which scoped refreshes stop until `reset()` (for example an older server without the endpoint). */
export const SCOPED_FAILURE_LIMIT = 3;

interface Marks { full: boolean; sessions: Set<string> }

export function createRefreshCoordinator(actions: RefreshActions) {
  const now = actions.now ?? Date.now;
  let running: Promise<void> | null = null;
  /** Marked since the last `flush`: not yet owed to anyone. */
  const soft: Marks = { full: false, sessions: new Set() };
  /** Demanded by a `flush`: the running loop serves these before it ends. */
  const due: Marks = { full: false, sessions: new Set() };
  const cooling = new Map<string, number>();
  let failures = 0;
  let disabled = false;

  const markFull = (marks: Marks): void => { marks.full = true; marks.sessions.clear(); };
  const requestFull = (): void => markFull(soft);
  const requestSessions = (ids: readonly string[]): void => {
    if (soft.full) return;
    for (const id of ids) {
      const until = cooling.get(id);
      if (until !== undefined && until <= now()) cooling.delete(id);
      if (disabled || !actions.eligible(id) || cooling.has(id)) return markFull(soft);
      soft.sessions.add(id);
    }
    if (soft.sessions.size > MAX_SCOPED_BATCH) markFull(soft);
  };
  /** A full refresh also covers the scoped marks that were still queued behind it. */
  const demand = (): void => {
    if (soft.full) markFull(due);
    else if (!due.full) for (const id of soft.sessions) due.sessions.add(id);
    if (due.sessions.size > MAX_SCOPED_BATCH) markFull(due);
    soft.full = false;
    soft.sessions.clear();
  };

  async function loop(): Promise<void> {
    try {
      while (due.full || due.sessions.size) {
        if (due.full) {
          due.full = false;
          due.sessions.clear();
          await actions.full();
          continue;
        }
        const batch = [...due.sessions];
        due.sessions.clear();
        for (const id of batch) {
          // A full refresh demanded meanwhile starts after every mark in this batch, so it covers the rest.
          if (due.full) break;
          try {
            const outcome = await actions.session(id);
            if (outcome === 'needs-full') markFull(due);
            else failures = 0;
          } catch {
            cooling.set(id, now() + SCOPED_FAILURE_COOLDOWN_MS);
            if (++failures >= SCOPED_FAILURE_LIMIT) disabled = true;
            markFull(due);
          }
        }
      }
    } finally {
      // Cleared in the same synchronous step as the last check, so a flush after it starts a new loop.
      running = null;
    }
  }

  return {
    requestFull,
    requestSessions,
    /**
     * Owes every mark made so far a request: starts the loop, or joins the running one and extends it. Resolves once
     * those marks have been served; marks made later wait for a later flush.
     */
    flush(): Promise<void> {
      demand();
      if (running) return running;
      // Published before the loop starts, so a flush made while it runs its first synchronous step joins it.
      let finish!: () => void;
      running = new Promise<void>((resolve) => { finish = resolve; });
      const promise = running;
      void loop().then(finish, finish);
      return promise;
    },
    /** A new connection: forget scoped failures and supersede everything with a full refresh. */
    reset(): void {
      cooling.clear();
      failures = 0;
      disabled = false;
      requestFull();
    },
    get pending(): boolean { return soft.full || soft.sessions.size > 0 || due.full || due.sessions.size > 0; },
  };
}
