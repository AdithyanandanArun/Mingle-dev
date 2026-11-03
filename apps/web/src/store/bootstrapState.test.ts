import type { Bootstrap, GroupSnapshot, Message } from '@mingle/contracts';
import { mergeTextDelta } from '@mingle/contracts/stream';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyStreamDelta, deepEqual, findById, pendingOptimisticMessages, pruneStreams, reconcile, reconcileBootstrap, reconcileGroups,
  reconcileStats, resetReconcileStats,
} from './bootstrapState';

const at = '2026-10-28T12:00:00.000Z';
const message = (index: number, extra: Partial<Message> = {}): Message =>
  ({ id: `m${index}`, sessionId: 's', role: index % 2 ? 'assistant' : 'user', content: `content ${index}`, createdAt: at, ...extra });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

beforeEach(resetReconcileStats);

describe('deepEqual', () => {
  it('compares nested JSON values without regard to key order and rejects shape differences', () => {
    expect(deepEqual({ a: 1, b: { c: [1, { d: 2 }] } }, { b: { c: [1, { d: 2 }] }, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual({ a: undefined }, { b: undefined })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual({}, [])).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({ a: null }, { a: {} })).toBe(false);
    expect(deepEqual('a', 'a')).toBe(true);
  });

  it('stops at the first difference', () => {
    const left = Array.from({ length: 1000 }, (_, id) => ({ id }));
    const right = clone(left);
    right[2] = { id: -1 };
    expect(deepEqual(left, right)).toBe(false);
    expect(reconcileStats.objectComparisons).toBeLessThanOrEqual(1 + 3);
  });
});

describe('reconcile', () => {
  it('returns the previous array and every previous reference when nothing changed, without building a lookup', () => {
    const prev = Array.from({ length: 300 }, (_, index) => message(index));
    const next = clone(prev);
    expect(reconcile(prev, next)).toBe(prev);
    expect(reconcileStats.indexBuilds).toBe(0);
    expect(reconcileStats.objectComparisons).toBe(300);
  });

  it('replaces only the changed record and keeps the rest canonical', () => {
    const prev = Array.from({ length: 5 }, (_, index) => message(index));
    const next = clone(prev);
    next[3] = { ...next[3], content: 'edited' };
    const result = reconcile(prev, next);
    expect(result).not.toBe(prev);
    expect(result.map((item, index) => item === prev[index])).toEqual([true, true, true, false, true]);
    expect(result[3]).toBe(next[3]);
  });

  it('follows a sliding window of appended and dropped records by shift, not by building a lookup', () => {
    const prev = Array.from({ length: 300 }, (_, index) => message(index));
    const next = clone(prev.slice(1)).concat(message(300));
    const result = reconcile(prev, next);
    expect(result.slice(0, 299).every((item, index) => item === prev[index + 1])).toBe(true);
    expect(result[299].id).toBe('m300');
    expect(reconcileStats.indexBuilds).toBe(0);
  });

  it('falls back to one lookup when records are reordered', () => {
    const prev = Array.from({ length: 6 }, (_, index) => message(index));
    const next = clone([prev[1], prev[0], prev[2], prev[3], prev[4], prev[5]]);
    const result = reconcile(prev, next);
    expect(result.every((item) => prev.includes(item))).toBe(true);
    expect(reconcileStats.indexBuilds).toBe(1);
  });

  it('takes a shorter list as a new array but still shares surviving records', () => {
    const prev = Array.from({ length: 4 }, (_, index) => message(index));
    const result = reconcile(prev, clone(prev.slice(0, 2)));
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(prev[0]);
    expect(result[1]).toBe(prev[1]);
  });

  it('keeps unchanged nested groups, members and messages when one group message arrives', () => {
    const group = (id: string, messages: number): GroupSnapshot => ({
      group: { id, projectId: 'p', title: id, anchorSessionId: `${id}-s`, mode: 'cowork', orchestratorMemberId: null, paused: false, pauseReason: null } as GroupSnapshot['group'],
      members: [{ id: `${id}-m1`, groupId: id, sessionId: `${id}-s`, handle: 'a', role: 'peer', joinedAt: at, removedAt: null }],
      messages: Array.from({ length: messages }, (_, seq) => ({
        id: `${id}-g${seq}`, seq, groupId: id, senderMemberId: null, recipientMemberIds: [], kind: 'user', content: `hi ${seq}`, requestId: null, replyToId: null, sourceMessageId: null,
      })) as unknown as GroupSnapshot['messages'],
      requests: [], deliveries: [], assignments: [],
    });
    const prev = [group('a', 3), group('b', 3)];
    const next = clone([group('a', 3), group('b', 4)]);
    const result = reconcileGroups(prev, next);
    expect(result[0]).toBe(prev[0]);
    expect(result[1]).not.toBe(prev[1]);
    expect(result[1].group).toBe(prev[1].group);
    expect(result[1].members).toBe(prev[1].members);
    expect(result[1].messages.slice(0, 3).every((item, index) => item === prev[1].messages[index])).toBe(true);
    expect(reconcileGroups(prev, clone(prev))).toBe(prev);
  });
});

describe('reconcileBootstrap', () => {
  const boot = (extra: Record<string, unknown> = {}): Bootstrap => ({
    projects: [{ id: 'p', name: 'p', path: '/p', createdAt: at, isExample: false }],
    sessions: [], messages: Array.from({ length: 4 }, (_, index) => message(index)), tasks: [], events: [], approvals: [], plans: [],
    questions: [], providers: [], settings: { theme: 'dark' } as Bootstrap['settings'], version: 'v1', runs: [], toolCalls: [], ...extra,
  });

  it('returns the previous payload for an equal one and a new payload for any change', () => {
    const prev = boot({ queuedMessages: [{ id: 'q1', sessionId: 's', content: 'x' }] });
    expect(reconcileBootstrap(prev, clone(prev))).toBe(prev);
    const changed = clone(prev);
    changed.version = 'v2';
    const result = reconcileBootstrap(prev, changed);
    expect(result).not.toBe(prev);
    expect(result.messages).toBe(prev.messages);
    expect(result.projects).toBe(prev.projects);
    expect(result.settings).toBe(prev.settings);
    expect((result as unknown as { queuedMessages: unknown }).queuedMessages).toBe((prev as unknown as { queuedMessages: unknown }).queuedMessages);
  });

  it('carries fields the web does not model yet, keeping their unchanged records stable', () => {
    const workflow = (id: string, status: string) => ({ id, status, steps: [{ id: `${id}-1`, status }] });
    const prev = boot({ sessionWorkflows: [workflow('w1', 'running'), workflow('w2', 'done')], futureFlag: { enabled: true } });
    const next = clone(prev) as Bootstrap & { sessionWorkflows: ReturnType<typeof workflow>[]; futureFlag: unknown };
    next.sessionWorkflows[0] = workflow('w1', 'done');
    const result = reconcileBootstrap(prev, next) as typeof next;
    expect(result.sessionWorkflows[0]).toEqual(workflow('w1', 'done'));
    expect(result.sessionWorkflows[1]).toBe((prev as typeof next).sessionWorkflows[1]);
    expect(result.futureFlag).toBe((prev as typeof next).futureFlag);

    const dropped = reconcileBootstrap(prev, boot());
    expect('sessionWorkflows' in dropped).toBe(false);
    const added = reconcileBootstrap(boot(), prev) as typeof next;
    expect(added.sessionWorkflows).toEqual(next.sessionWorkflows.map((item, index) => index ? item : workflow('w1', 'running')));
  });

  it('returns the first payload untouched', () => {
    const first = boot();
    expect(reconcileBootstrap(null, first)).toBe(first);
  });
});

describe('pendingOptimisticMessages', () => {
  const optimistic = (id: string, content: string, createdAt = at, extra: Partial<Message> = {}): Message =>
    ({ id: `optimistic:${id}`, sessionId: 's', role: 'user', content, createdAt, ...extra });

  it('keeps unsaved optimistic messages in their order with their context references intact', () => {
    const refs = [{ kind: 'file', path: 'src/a.ts' }] as unknown as Message['contextRefs'];
    const first = optimistic('1', 'one', at, { contextRefs: refs });
    const second = optimistic('2', 'two');
    const pending = pendingOptimisticMessages([message(0), first, second], [message(0)]);
    expect(pending).toEqual([first, second]);
    expect(pending[0]).toBe(first);
    expect(pending[0].contextRefs).toBe(refs);
  });

  it('drops a message once the same user text is saved within ten seconds, in the same session', () => {
    const near = optimistic('near', 'hello', '2026-10-28T12:00:09.000Z');
    const far = optimistic('far', 'later', '2026-10-28T12:00:10.000Z');
    const other = optimistic('other', 'hello', at, { sessionId: 'other-session' });
    const saved = [
      message(1, { role: 'user', content: 'hello' }),
      message(2, { role: 'user', content: 'later' }),
      message(3, { role: 'assistant', content: 'hello' }),
    ];
    expect(pendingOptimisticMessages([near, far, other], saved)).toEqual([far, other]);
  });

  it('lets one saved message satisfy every identical optimistic duplicate, as the previous `some` match did', () => {
    const duplicates = [optimistic('a', 'same'), optimistic('b', 'same'), optimistic('c', 'same', '2026-10-28T12:01:00.000Z')];
    expect(pendingOptimisticMessages(duplicates, [message(1, { role: 'user', content: 'same' })])).toEqual([duplicates[2]]);
  });

  it('ignores unparsable timestamps like the previous comparison', () => {
    const bad = optimistic('bad', 'x', 'not-a-date');
    expect(pendingOptimisticMessages([bad], [message(1, { role: 'user', content: 'x' })])).toEqual([bad]);
  });

  it('reads each saved message once per refresh no matter how many are pending', () => {
    let reads = 0;
    const saved = Array.from({ length: 300 }, (_, index) => {
      const row = message(index, { role: 'assistant' });
      return Object.defineProperty(row, 'role', { enumerable: true, get() { reads++; return 'assistant'; } }) as Message;
    });
    const pending = Array.from({ length: 8 }, (_, index) => optimistic(String(index), `unsaved ${index}`));
    expect(pendingOptimisticMessages([...pending], saved)).toHaveLength(8);
    expect(reads).toBe(300);
  });

  it('returns nothing without a current list', () => {
    expect(pendingOptimisticMessages(undefined, [message(0)])).toEqual([]);
  });
});

describe('applyStreamDelta', () => {
  it('matches mergeTextDelta for every offset class, including snapshot overlap and gaps', () => {
    const cases: { existing?: string; snapshot: string; offset: number; delta: string }[] = [
      { snapshot: '', offset: 0, delta: 'Hello' },
      { existing: 'Hello', snapshot: '', offset: 5, delta: ' world' },
      { existing: 'Hello', snapshot: 'Hello wor', offset: 5, delta: ' world' },
      { existing: 'Hello', snapshot: 'Hello world!!', offset: 5, delta: ' world' },
      { existing: 'Hello', snapshot: '', offset: 3, delta: 'lo!' },
      { existing: 'Hello', snapshot: '', offset: 9, delta: 'gap' },
      { existing: 'Hello', snapshot: '', offset: -1, delta: 'x' },
      { existing: 'Hello', snapshot: '', offset: 1.5, delta: 'x' },
      { existing: 'Hello', snapshot: '', offset: 5, delta: '' },
    ];
    for (const { existing, snapshot, offset, delta } of cases) {
      const buffer = existing === undefined ? undefined : { sessionId: 's', base: '', text: existing };
      const current = snapshot.length > (existing?.length ?? 0) ? snapshot : existing ?? '';
      const expected = mergeTextDelta(current, offset, delta);
      const actual = applyStreamDelta(buffer, snapshot, { sessionId: 's', messageId: 'x', delta, offset });
      expect(actual === null ? null : actual.base + actual.text).toBe(expected);
    }
  });

  it('appends legacy offset-less deltas to the snapshot base', () => {
    const first = applyStreamDelta(undefined, 'saved ', { sessionId: 's', messageId: 'x', delta: 'a' });
    expect(first).toEqual({ sessionId: 's', base: 'saved ', text: 'a' });
    expect(applyStreamDelta(first!, 'ignored', { sessionId: 's', messageId: 'x', delta: 'b' })).toEqual({ sessionId: 's', base: 'saved ', text: 'ab' });
  });
});

describe('lookups', () => {
  it('indexes a list once per array identity and returns undefined for missing records', () => {
    const list = Array.from({ length: 50 }, (_, index) => message(index));
    for (let index = 0; index < 100; index++) expect(findById(list, 'm49')).toBe(list[49]);
    expect(findById(list, 'missing')).toBeUndefined();
    expect(findById(undefined, 'm1')).toBeUndefined();
    expect(reconcileStats.indexBuilds).toBe(1);
    findById([...list], 'm1');
    expect(reconcileStats.indexBuilds).toBe(2);
  });

  it('prunes caught-up and orphaned buffers but keeps live ones', () => {
    const session = (id: string, status: string) => ({ id, status }) as unknown as Bootstrap['sessions'][number];
    const streams = {
      caught: { sessionId: 's', base: '', text: 'abc' },
      ahead: { sessionId: 's', base: '', text: 'abcdef' },
      orphan: { sessionId: 'idle', base: '', text: 'x' },
      gone: { sessionId: 'missing', base: '', text: 'x' },
      fresh: { sessionId: 's', base: '', text: 'x' },
    };
    const pruned = pruneStreams(streams, {
      messages: [message(0, { id: 'caught', content: 'abcd' }), message(1, { id: 'ahead', content: 'abc' })],
      sessions: [session('s', 'running'), session('idle', 'idle')],
    });
    expect(Object.keys(pruned).sort()).toEqual(['ahead', 'fresh']);
    const live = { ahead: streams.ahead };
    expect(pruneStreams(live, { messages: [message(1, { id: 'ahead', content: 'abc' })], sessions: [session('s', 'running')] })).toBe(live);
  });
});
