import { mergeTextDelta } from '@mingle/contracts/stream';
import type { Bootstrap, GroupSnapshot, Message, SessionSnapshot } from '@mingle/contracts';

/**
 * Hot-path helpers for the bootstrap store: structural comparison without serialization, identity-preserving
 * reconciliation, optimistic message matching and stream deltas. Nothing here touches React, the network or the store.
 */

/** Deterministic operation counters so tests can assert work done instead of wall-clock time. */
export const reconcileStats = { objectComparisons: 0, indexBuilds: 0 };
export function resetReconcileStats(): void {
  reconcileStats.objectComparisons = 0;
  reconcileStats.indexBuilds = 0;
}

/** Structural equality for JSON-shaped values; allocation-free and exits at the first difference. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  reconcileStats.objectComparisons++;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let count = 0;
  for (const key in left) {
    if (!Object.hasOwn(left, key)) continue;
    count++;
    if (!Object.hasOwn(right, key) || !deepEqual(left[key], right[key])) return false;
  }
  for (const key in right) if (Object.hasOwn(right, key)) count--;
  return count === 0;
}

type Keyed = { id: string | number };
const MAX_SHIFT_SCAN = 8;

/**
 * Reuses the previous reference for every item that did not change. Appended and sliding windows (bootstrap messages
 * and events) line up by position or by one constant shift, so a lookup map is only built when the order really differs.
 * The previous array itself is returned when nothing changed.
 */
export function reconcileKeyed<T extends object>(
  prev: readonly T[] | undefined, next: T[], keyOf: (item: T) => string | number, merge: (previous: T, incoming: T) => T,
): T[] {
  if (!prev) return next;
  if (prev === next) return next;
  let shift = 0;
  if (next.length && prev.length && keyOf(prev[0]) !== keyOf(next[0])) {
    const first = keyOf(next[0]);
    const at = prev.findIndex((item) => keyOf(item) === first);
    if (at > 0) shift = at;
  }
  let lookup: Map<string | number, T> | undefined;
  let out: T[] | undefined;
  let changed = prev.length !== next.length;
  for (let i = 0; i < next.length; i++) {
    const incoming = next[i];
    const key = keyOf(incoming);
    let previous: T | undefined = prev[i + shift];
    if (!previous && !lookup && shift <= MAX_SHIFT_SCAN) {
      // Appended past the end of an aligned window: only the dropped head could still hold this key.
      previous = prev.slice(0, shift).find((item) => keyOf(item) === key);
    } else if (!previous || keyOf(previous) !== key) {
      if (!lookup) { reconcileStats.indexBuilds++; lookup = new Map(prev.map((item) => [keyOf(item), item])); }
      previous = lookup.get(key);
    }
    const chosen = previous ? merge(previous, incoming) : incoming;
    if (prev[i] !== chosen) changed = true;
    if (chosen !== incoming && !out) out = next.slice(0, i);
    if (out) out.push(chosen);
  }
  if (!changed) return prev as T[];
  return out ?? next;
}

const byId = (item: Keyed): string | number => item.id;
const keepEqual = <T>(previous: T, incoming: T): T => (deepEqual(previous, incoming) ? previous : incoming);

/** Reconcile a list of `{ id }` records. */
export function reconcile<T extends Keyed>(prev: readonly T[] | undefined, next: T[]): T[] {
  return reconcileKeyed(prev, next, byId, keepEqual);
}

/** Merge two plain records field by field, keeping the previous record when no field changed. */
function mergeRecord<T extends object>(previous: T, incoming: T, field: (key: string, before: unknown, after: unknown) => unknown): T {
  const before = previous as Record<string, unknown>;
  const after = incoming as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let changed = false;
  let keys = 0;
  for (const key of Object.keys(after)) {
    keys++;
    const value = field(key, before[key], after[key]);
    out[key] = value;
    if (value !== before[key] || !Object.hasOwn(before, key)) changed = true;
  }
  if (!changed && Object.keys(before).length !== keys) changed = true;
  return changed ? out as T : previous;
}

const GROUP_LISTS = new Set(['members', 'messages', 'requests', 'deliveries', 'assignments']);
const isKeyedList = (value: unknown): value is Keyed[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'object' && item !== null
    && (typeof (item as Keyed).id === 'string' || typeof (item as Keyed).id === 'number'));

/** A changed group still shares its unchanged members, messages, requests, deliveries and assignments. */
function mergeGroup(previous: GroupSnapshot, incoming: GroupSnapshot): GroupSnapshot {
  return mergeRecord(previous, incoming, (key, before, after) =>
    GROUP_LISTS.has(key) && isKeyedList(after) && Array.isArray(before) ? reconcile(before as Keyed[], after) : keepEqual(before, after));
}

/** Group snapshots are keyed by their group; each keeps its previous reference unless something inside it changed. */
export function reconcileGroups(prev: readonly GroupSnapshot[] | undefined, next: GroupSnapshot[]): GroupSnapshot[] {
  return reconcileKeyed(prev, next, (snapshot) => snapshot.group.id, mergeGroup);
}

const KEYED_BOOTSTRAP_LISTS = new Set([
  'runs', 'toolCalls', 'delegatedSubagents', 'queuedMessages', 'projects', 'sessions', 'messages', 'tasks', 'events',
  'approvals', 'plans', 'questions', 'providers',
]);

function reconcileBootstrapField(key: string, before: unknown, after: unknown): unknown {
  if (after === undefined || after === null) return after;
  if (key === 'groups' && Array.isArray(after)) {
    return reconcileGroups(Array.isArray(before) ? before as GroupSnapshot[] : undefined, after as GroupSnapshot[]);
  }
  // Fields the web does not know yet (for example optional workflow lists) still keep unchanged records stable.
  if ((KEYED_BOOTSTRAP_LISTS.has(key) || isKeyedList(after)) && Array.isArray(after)) {
    return reconcile(Array.isArray(before) ? before as Keyed[] : undefined, after as Keyed[]);
  }
  return keepEqual(before, after);
}

/**
 * Reuses previous references for everything unchanged in a freshly fetched bootstrap and returns `prev` itself when
 * the whole payload is equal. Fields not named in the contract are carried through untouched.
 */
export function reconcileBootstrap(prev: Bootstrap | null, next: Bootstrap): Bootstrap {
  if (!prev) return next;
  return mergeRecord(prev, next, reconcileBootstrapField);
}

const optimisticPrefix = 'optimistic:';
export const isOptimisticMessage = (message: Pick<Message, 'id'>): boolean => message.id.startsWith(optimisticPrefix);

/**
 * Optimistic user messages the server snapshot has not caught up with. A saved user message in the same session with
 * the same text created within ten seconds satisfies every matching optimistic duplicate. One pass over the snapshot.
 */
export function pendingOptimisticMessages(current: readonly Message[] | undefined, saved: readonly Message[]): Message[] {
  const optimistic = current?.filter(isOptimisticMessage) ?? [];
  if (!optimistic.length) return optimistic;
  const bySession = new Map<string, { message: Message; createdAt: number }[]>();
  for (const message of optimistic) {
    const list = bySession.get(message.sessionId) ?? [];
    list.push({ message, createdAt: Date.parse(message.createdAt) });
    bySession.set(message.sessionId, list);
  }
  const satisfied = new Set<Message>();
  for (const row of saved) {
    if (row.role !== 'user') continue;
    const candidates = bySession.get(row.sessionId);
    if (!candidates) continue;
    let savedAt: number | undefined;
    for (const candidate of candidates) {
      if (satisfied.has(candidate.message) || candidate.message.content !== row.content) continue;
      savedAt ??= Date.parse(row.createdAt);
      if (Math.abs(savedAt - candidate.createdAt) < 10_000) satisfied.add(candidate.message);
    }
    if (satisfied.size === optimistic.length) break;
  }
  return satisfied.size ? optimistic.filter((message) => !satisfied.has(message)) : optimistic;
}

const indexes = new WeakMap<readonly unknown[], Map<string | number, unknown>>();
/** Id lookup memoized per array identity: a store array is replaced, never mutated, when it changes. */
export function findById<T extends Keyed>(list: readonly T[] | undefined, id: string | number): T | undefined {
  if (!list) return undefined;
  let index = indexes.get(list);
  if (!index) {
    reconcileStats.indexBuilds++;
    index = new Map(list.map((item) => [item.id, item]));
    indexes.set(list, index);
  }
  return index.get(id) as T | undefined;
}

export interface StreamBuffer { sessionId: string; base: string; text: string }
export interface StreamDelta { sessionId: string; messageId: string; delta: string; offset?: number }

/**
 * Next buffer for a live text chunk. Offsets address the absolute message text, so a snapshot that is already ahead
 * absorbs the overlap. null means a gap or bad offset: the caller must fetch a fresh snapshot.
 */
export function applyStreamDelta(existing: StreamBuffer | undefined, snapshot: string, event: StreamDelta): StreamBuffer | null {
  if (event.offset !== undefined) {
    const buffered = existing ? existing.base + existing.text : '';
    const current = snapshot.length > buffered.length ? snapshot : buffered;
    // Appending at the end is the overwhelmingly common case; avoid re-slicing the whole message for it.
    const text = event.offset === current.length ? current + event.delta : mergeTextDelta(current, event.offset, event.delta);
    return text === null ? null : { sessionId: event.sessionId, base: '', text };
  }
  return { sessionId: event.sessionId, base: existing ? existing.base : snapshot, text: (existing?.text ?? '') + event.delta };
}

/** Drop stream buffers the server snapshot has already caught up with. */
export function pruneStreams<T extends StreamBuffer>(streams: Record<string, T>, boot: Pick<Bootstrap, 'messages' | 'sessions'>): Record<string, T> {
  let changed = false;
  const out: Record<string, T> = {};
  for (const [id, entry] of Object.entries(streams)) {
    const message = findById(boot.messages, id);
    const session = findById(boot.sessions, entry.sessionId);
    const caughtUp = message && message.content.length >= (entry.base + entry.text).length;
    const orphan = !message && session && session.status !== 'running';
    if (caughtUp || orphan || !session) {
      changed = true;
      continue;
    }
    out[id] = entry;
  }
  return changed ? out : streams;
}

/** Collections of a session snapshot, each with the field that ties a row to its session. */
const SNAPSHOT_LISTS = [
  ['messages', 'sessionId'], ['runs', 'sessionId'], ['toolCalls', 'sessionId'], ['queuedMessages', 'sessionId'], ['approvals', 'sessionId'],
  ['plans', 'sessionId'], ['questions', 'sessionId'], ['workflows', 'sessionId'], ['delegatedSubagents', 'parentSessionId'],
] as const;

/**
 * A snapshot is applied only if it is exactly what was asked for: every collection present and every row owned by the
 * requested session. Anything else (a proxy answering for another endpoint, a partial body, a newer server shape) throws,
 * and the caller falls back to a full bootstrap instead of merging something it cannot vouch for.
 */
export function validateSessionSnapshot(value: unknown, sessionId: string): SessionSnapshot {
  const fail = (reason: string): never => { throw new Error(`Malformed session snapshot: ${reason}`); };
  if (!value || typeof value !== 'object') return fail('not an object');
  const snap = value as Record<string, unknown>;
  if (snap.sessionId !== sessionId) fail('wrong session');
  const session = snap.session as { id?: unknown } | null;
  if (!session || typeof session !== 'object' || session.id !== sessionId) fail('session row');
  for (const [key, owner] of SNAPSHOT_LISTS) {
    const rows = snap[key];
    if (!Array.isArray(rows)) fail(key);
    for (const row of rows as Record<string, unknown>[]) {
      if (!row || typeof row !== 'object' || row[owner] !== sessionId || (key !== 'delegatedSubagents' && key !== 'workflows' && typeof row.id !== 'string')) fail(`${key} row`);
    }
  }
  return snap as unknown as SessionSnapshot;
}

/** Replace the rows `owned` selects with `incoming`, reusing unchanged references; the previous array when nothing changed. */
function replaceOwned<T extends Keyed>(prev: readonly T[] | undefined, owned: (row: T) => boolean, incoming: T[], extra: readonly T[] = []): T[] | undefined {
  if (!prev && !incoming.length && !extra.length) return prev as undefined;
  const list = prev ?? [];
  const before = list.filter(owned);
  const after = reconcile(before, [...incoming, ...extra]);
  if (after === before) return list as T[];
  return [...list.filter((row) => !owned(row)), ...after];
}

/**
 * Applies a session snapshot onto a bootstrap-shaped state: that session's rows are replaced, everything else keeps its
 * identity. Returns null when the session is not in `boot`, so a late answer cannot resurrect an archived or removed
 * session. `keepMessages` are this session's optimistic user messages the snapshot has not caught up with; they follow the
 * snapshot's rows, the same order a full refresh gives them.
 */
export function applySessionSnapshot(boot: Bootstrap, snap: SessionSnapshot, keepMessages: readonly Message[] = []): Bootstrap | null {
  const id = snap.sessionId;
  const at = boot.sessions.findIndex((row) => row.id === id);
  if (at < 0) return null;
  const session = keepEqual(boot.sessions[at], snap.session);
  const sessions = session === boot.sessions[at] ? boot.sessions : boot.sessions.map((row, index) => (index === at ? session : row));
  const mine = <T extends { sessionId: string }>(row: T): boolean => row.sessionId === id;
  const next: Bootstrap = {
    ...boot, sessions,
    messages: replaceOwned(boot.messages, mine, snap.messages, keepMessages) ?? boot.messages,
    runs: replaceOwned(boot.runs, mine, snap.runs) ?? boot.runs,
    toolCalls: replaceOwned(boot.toolCalls, mine, snap.toolCalls) ?? boot.toolCalls,
    approvals: replaceOwned(boot.approvals, mine, snap.approvals) ?? boot.approvals,
    plans: replaceOwned(boot.plans, mine, snap.plans) ?? boot.plans,
    questions: replaceOwned(boot.questions, mine, snap.questions) ?? boot.questions,
  };
  const queued = replaceOwned(boot.queuedMessages, mine, snap.queuedMessages);
  if (queued) next.queuedMessages = queued;
  const workflows = replaceOwned(boot.workflows as Keyed[] | undefined, (row) => (row as unknown as { sessionId: string }).sessionId === id, snap.workflows as unknown as Keyed[]);
  if (workflows) next.workflows = workflows as unknown as Bootstrap['workflows'];
  const helpers = replaceOwned(boot.delegatedSubagents as Keyed[] | undefined, (row) => (row as unknown as { parentSessionId: string }).parentSessionId === id, snap.delegatedSubagents as unknown as Keyed[]);
  if (helpers) next.delegatedSubagents = helpers as unknown as Bootstrap['delegatedSubagents'];
  const unchanged = (Object.keys(next) as (keyof Bootstrap)[]).every((key) => next[key] === boot[key]);
  return unchanged ? boot : next;
}
