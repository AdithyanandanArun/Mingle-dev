import type { Message, Provider, SessionRun, ToolCall } from '@mingle/contracts';
import type { DisplayMessage } from './conversation';
import { deriveSubagents, type SubagentRun } from './subagents';

/**
 * Pure, indexed derivation behind the single-agent transcript.
 *
 * Every stage reuses the previous result's object identities whenever the data is structurally unchanged, so
 * React.memo boundaries downstream hold across bootstrap refetches that return identical history, and a
 * streamed token only invalidates the one message it belongs to. All lookups use maps built in one pass:
 * the whole derivation is O(messages + runs + tool calls) instead of O(runs × messages).
 */

const EMPTY: readonly never[] = [];
export const EMPTY_TOOL_CALLS: ToolCall[] = [];
export const EMPTY_RUNS: readonly SessionRun[] = EMPTY;
export const EMPTY_SUBAGENTS: readonly SubagentRun[] = EMPTY;
export const EMPTY_STREAM_IDS: readonly string[] = EMPTY;

/** Structural equality for JSON-shaped data (what bootstrap deserialization produces). */
export function deepEqualData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as readonly unknown[];
    if (a.length !== other.length) return false;
    for (let index = 0; index < a.length; index++) if (!deepEqualData(a[index], other[index])) return false;
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || !deepEqualData(left[key], right[key])) return false;
  }
  return true;
}

export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

/**
 * Keeps each previous element whose id matches a structurally equal next element, and returns `previous` itself
 * when nothing changed. Order and content always come from `next`.
 */
export function reuseById<T extends { id: string | number }>(previous: readonly T[] | undefined, next: readonly T[], equal: (a: T, b: T) => boolean = deepEqualData): readonly T[] {
  if (!previous || previous.length === 0) return next;
  const known = new Map<string | number, T>();
  for (const item of previous) known.set(item.id, item);
  const merged = next.map((item) => {
    const old = known.get(item.id);
    return old !== undefined && equal(old, item) ? old : item;
  });
  return sameItems(previous, merged) ? previous : merged;
}

interface StreamLike { sessionId: string; base: string; text: string }

/** Ids of the live stream buffers that belong to one session, in store order; `previous` is returned when unchanged. */
export function pickSessionStreamIds(streams: Readonly<Record<string, StreamLike>>, sessionId: string | undefined, previous: readonly string[] = EMPTY_STREAM_IDS): readonly string[] {
  if (!sessionId) return EMPTY_STREAM_IDS;
  const ids: string[] = [];
  for (const id in streams) if (streams[id]!.sessionId === sessionId) ids.push(id);
  if (ids.length === 0) return EMPTY_STREAM_IDS;
  return sameItems(previous, ids) ? previous : ids;
}

/** The longer of the stored text and the streamed buffer, exactly as the bootstrap/stream overlap rule requires. */
export function overlayStream(message: DisplayMessage, entry: StreamLike | undefined): DisplayMessage {
  if (!entry) return message;
  const streamed = entry.base + entry.text;
  return streamed.length > message.content.length ? { ...message, content: streamed } : message;
}

export interface DisplayInput { sessionId: string; running: boolean; streamIds: readonly string[] }

/** Session messages in stored order, then stream-only assistant messages. Streamed text is overlaid per message at render. */
export function deriveDisplayMessages(stored: readonly Message[], input: DisplayInput): DisplayMessage[] {
  const tracked = new Set(input.streamIds);
  const seen = new Set<string>();
  const out: DisplayMessage[] = [];
  for (const m of stored) {
    if (m.sessionId !== input.sessionId) continue;
    seen.add(m.id);
    out.push({ id: m.id, sessionId: m.sessionId, role: m.role, content: m.content, createdAt: m.createdAt, kind: m.kind, runId: m.runId, live: (tracked.has(m.id) || m.kind === 'streaming') && input.running, attachments: m.attachments, contextRefs: m.contextRefs });
  }
  for (const id of input.streamIds) {
    if (!seen.has(id)) out.push({ id, sessionId: input.sessionId, role: 'assistant', content: '', createdAt: '', live: input.running });
  }
  return out;
}

export interface RunBlock { run: SessionRun; calls: ToolCall[]; subagents: readonly SubagentRun[] }
export type TranscriptRow =
  | { kind: 'tools'; key: string; messages: readonly DisplayMessage[] }
  | { kind: 'delivery'; key: string; message: DisplayMessage; runs: readonly RunBlock[] }
  | { kind: 'message'; key: string; message: DisplayMessage; streamed: boolean; runs: readonly RunBlock[]; changes: readonly SessionRun[] };
export interface TranscriptLayout { rows: readonly TranscriptRow[]; unplaced: readonly RunBlock[]; blocks: ReadonlyMap<string, RunBlock> }
export interface LayoutInput {
  messages: readonly DisplayMessage[]; runs: readonly SessionRun[]; toolCalls: readonly ToolCall[]; subagents: readonly SubagentRun[]; streamIds: readonly string[];
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const list = grouped.get(id);
    if (list) list.push(item); else grouped.set(id, [item]);
  }
  return grouped;
}

function isDelivery(message: DisplayMessage): boolean {
  return message.role === 'user' && (message.kind === 'group-delivery' || message.kind === 'team-delivery');
}

function rowsEqual(a: TranscriptRow, b: TranscriptRow): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.kind === 'tools' && b.kind === 'tools') return sameItems(a.messages, b.messages);
  if (a.kind === 'delivery' && b.kind === 'delivery') return a.message === b.message && sameItems(a.runs, b.runs);
  if (a.kind === 'message' && b.kind === 'message') {
    return a.message === b.message && a.streamed === b.streamed && sameItems(a.runs, b.runs) && sameItems(a.changes, b.changes);
  }
  return false;
}

/**
 * Places run activity under its user message, and a finished run's change card after the run's final assistant
 * message (falling back to its last non-tool message, then the user message), in one pass over the messages.
 */
export function buildTranscriptLayout(input: LayoutInput, previous?: TranscriptLayout): TranscriptLayout {
  const { messages, runs } = input;
  const indexById = new Map<string, number>();
  const lastAssistantByRun = new Map<string, number>();
  const lastNonToolByRun = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (!indexById.has(message.id)) indexById.set(message.id, index);
    if (message.runId === undefined) continue;
    if (message.role === 'assistant') lastAssistantByRun.set(message.runId, index);
    if (message.role !== 'tool') lastNonToolByRun.set(message.runId, index);
  }

  const callsByRun = groupBy(input.toolCalls, (call) => call.runId);
  const subagentsByRun = groupBy(input.subagents, (subagent) => subagent.runId);
  const blocks = new Map<string, RunBlock>();
  const blockFor = (run: SessionRun): RunBlock => {
    const old = previous?.blocks.get(run.id);
    const nextCalls = callsByRun.get(run.id) ?? EMPTY_TOOL_CALLS;
    const nextSubagents = subagentsByRun.get(run.id) ?? EMPTY_SUBAGENTS;
    const calls = old && sameItems(old.calls, nextCalls) ? old.calls : nextCalls;
    const subagents = old && sameItems(old.subagents, nextSubagents) ? old.subagents : nextSubagents;
    const block = old && old.run === run && old.calls === calls && old.subagents === subagents ? old : { run, calls, subagents };
    blocks.set(run.id, block);
    return block;
  };

  const blocksByUserMessage = new Map<string, RunBlock[]>();
  const changesByIndex = new Map<number, SessionRun[]>();
  const unplacedRuns: SessionRun[] = [];
  for (const run of runs) {
    const userIndex = indexById.get(run.userMessageId);
    if (userIndex === undefined) { unplacedRuns.push(run); continue; }
    const list = blocksByUserMessage.get(run.userMessageId);
    const block = blockFor(run);
    if (list) list.push(block); else blocksByUserMessage.set(run.userMessageId, [block]);
    const at = lastAssistantByRun.get(run.id) ?? lastNonToolByRun.get(run.id) ?? userIndex;
    const placed = changesByIndex.get(at);
    if (placed) placed.push(run); else changesByIndex.set(at, [run]);
  }
  unplacedRuns.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const unplaced = unplacedRuns.map(blockFor);

  const streamed = new Set(input.streamIds);
  const previousRows = new Map<string, TranscriptRow>();
  for (const row of previous?.rows ?? EMPTY) previousRows.set(row.key, row);
  const rows: TranscriptRow[] = [];
  const keep = (row: TranscriptRow): void => {
    const old = previousRows.get(row.key);
    rows.push(old && rowsEqual(old, row) ? old : row);
  };
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === 'tool') {
      if (index > 0 && messages[index - 1]!.role === 'tool') continue;
      const group = [message];
      for (let next = index + 1; next < messages.length && messages[next]!.role === 'tool'; next++) group.push(messages[next]!);
      keep({ kind: 'tools', key: message.id, messages: group });
    } else if (isDelivery(message)) {
      keep({ kind: 'delivery', key: message.id, message, runs: blocksByUserMessage.get(message.id) ?? EMPTY });
    } else {
      const finished = (changesByIndex.get(index) ?? EMPTY).filter((run) => run.status !== 'running');
      keep({ kind: 'message', key: message.id, message, streamed: streamed.has(message.id), runs: message.role === 'user' ? blocksByUserMessage.get(message.id) ?? EMPTY : EMPTY, changes: finished });
    }
  }

  const stableRows = previous && sameItems(previous.rows, rows) ? previous.rows : rows;
  const stableUnplaced = previous && sameItems(previous.unplaced, unplaced) ? previous.unplaced : unplaced;
  if (previous && stableRows === previous.rows && stableUnplaced === previous.unplaced) return previous;
  return { rows: stableRows, unplaced: stableUnplaced, blocks };
}

export interface TranscriptInput {
  sessionId: string; provider: Provider; model: string; running: boolean;
  messages: readonly Message[] | undefined; runs: readonly SessionRun[] | undefined; toolCalls: readonly ToolCall[] | undefined;
  streamIds: readonly string[];
}
export interface TranscriptModel {
  messages: readonly DisplayMessage[]; runs: readonly SessionRun[]; toolCalls: readonly ToolCall[]; subagents: readonly SubagentRun[]; layout: TranscriptLayout;
}

/**
 * Stateful pipeline: each stage re-runs only when its own inputs change identity, and each result keeps the
 * previous identities of structurally unchanged items. Create one per mounted conversation.
 */
export function createTranscriptDeriver(): (input: TranscriptInput) => TranscriptModel {
  let sessionId: string | undefined;
  let messageKey: unknown[] = [];
  let messages: readonly DisplayMessage[] = EMPTY;
  let runKey: unknown[] = [];
  let runs: readonly SessionRun[] = EMPTY_RUNS;
  let callKey: unknown[] = [];
  let toolCalls: readonly ToolCall[] = EMPTY_TOOL_CALLS;
  let subagentKey: unknown[] = [];
  let subagents: readonly SubagentRun[] = EMPTY_SUBAGENTS;
  let layoutKey: unknown[] = [];
  let layout: TranscriptLayout | undefined;
  let model: TranscriptModel | undefined;
  const changed = (previous: unknown[], next: unknown[]): boolean => previous.length !== next.length || next.some((value, index) => value !== previous[index]);

  return (input) => {
    if (input.sessionId !== sessionId) {
      sessionId = input.sessionId;
      messageKey = []; messages = EMPTY; runKey = []; runs = EMPTY_RUNS; callKey = []; toolCalls = EMPTY_TOOL_CALLS;
      subagentKey = []; subagents = EMPTY_SUBAGENTS; layoutKey = []; layout = undefined; model = undefined;
    }
    const nextMessageKey = [input.messages, input.streamIds, input.running];
    if (changed(messageKey, nextMessageKey)) {
      messageKey = nextMessageKey;
      messages = reuseById(messages, deriveDisplayMessages(input.messages ?? EMPTY, input));
    }
    const nextRunKey = [input.runs];
    if (changed(runKey, nextRunKey)) {
      runKey = nextRunKey;
      runs = reuseById(runs, (input.runs ?? EMPTY_RUNS).filter((run) => run.sessionId === input.sessionId));
    }
    const nextCallKey = [input.toolCalls];
    if (changed(callKey, nextCallKey)) {
      callKey = nextCallKey;
      toolCalls = reuseById(toolCalls, (input.toolCalls ?? EMPTY_TOOL_CALLS).filter((call) => call.sessionId === input.sessionId));
    }
    const nextSubagentKey = [toolCalls, input.provider, input.model];
    if (changed(subagentKey, nextSubagentKey)) {
      subagentKey = nextSubagentKey;
      subagents = reuseById(subagents, deriveSubagents(toolCalls, input.provider, input.model));
    }
    const nextLayoutKey = [messages, runs, toolCalls, subagents, input.streamIds];
    if (changed(layoutKey, nextLayoutKey) || !layout) {
      layoutKey = nextLayoutKey;
      layout = buildTranscriptLayout({ messages, runs, toolCalls, subagents, streamIds: input.streamIds }, layout);
    }
    if (model && model.messages === messages && model.runs === runs && model.toolCalls === toolCalls && model.subagents === subagents && model.layout === layout) return model;
    model = { messages, runs, toolCalls, subagents, layout };
    return model;
  };
}
