import { describe, expect, it } from 'vitest';
import type { Message, SessionRun, SessionWorkflow, Task, ToolCall } from '@mingle/contracts';
import type { DisplayMessage } from './conversation';
import {
  buildTranscriptLayout, createTranscriptDeriver, deepEqualData, deriveDisplayMessages, overlayStream, pickSessionStreamIds, reuseById,
  type TranscriptInput, type TranscriptRow,
} from './transcript';

const T0 = Date.parse('2026-11-01T00:00:00Z');
const at = (n: number) => new Date(T0 + n * 1000).toISOString();
const message = (id: string, role: Message['role'], extra: Partial<Message> = {}): Message => ({ id, sessionId: 's1', role, content: `${id} text`, createdAt: at(Number(id.replace(/\D/g, '')) || 0), ...extra });
const run = (id: string, userMessageId: string, extra: Partial<SessionRun> = {}): SessionRun => ({
  id, sessionId: 's1', userMessageId, provider: 'claude', model: 'm', status: 'completed', startedAt: at(Number(id.replace(/\D/g, '')) || 0), finishedAt: null, durationMs: null, toolCount: 0, toolCounts: {}, ...extra,
});
const call = (id: string, runId: string, extra: Partial<ToolCall> = {}): ToolCall => ({
  id, runId, sessionId: 's1', providerId: `p-${id}`, parentProviderId: null, name: 'Bash', category: 'command', status: 'completed', summary: 'ls', command: 'ls', input: '{}', output: '', cwd: null, exitCode: 0, processId: null, startedAt: at(1), finishedAt: at(2), durationMs: 1, ...extra,
});
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// The previous implementation, kept verbatim as the behavioural oracle for placement.
function referencePlacement(messages: readonly DisplayMessage[], runs: readonly SessionRun[]) {
  const messageIds = new Set(messages.map((m) => m.id));
  const unplaced = runs.filter((r) => !messageIds.has(r.userMessageId)).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map((r) => r.id);
  const placements = new Map<number, string[]>();
  for (const r of runs) {
    if (!messageIds.has(r.userMessageId)) continue;
    const assistants = messages.map((m, index) => ({ message: m, index })).filter((row) => row.message.role === 'assistant' && row.message.runId === r.id);
    let index = assistants.at(-1)?.index;
    if (index === undefined) {
      const fallback = messages.map((m, candidate) => ({ message: m, candidate })).filter((row) => row.message.role !== 'tool' && row.message.runId === r.id).at(-1);
      index = fallback?.candidate ?? messages.findIndex((m) => m.id === r.userMessageId);
    }
    if (index === undefined || index < 0) continue;
    placements.set(index, [...(placements.get(index) ?? []), r.id]);
  }
  return { unplaced, placements };
}

function layoutPlacement(rows: readonly TranscriptRow[], messages: readonly DisplayMessage[]) {
  const indexOf = new Map(messages.map((m, index) => [m.id, index]));
  const placements = new Map<number, string[]>();
  const activity = new Map<string, string[]>();
  for (const row of rows) {
    if (row.kind === 'message' && row.changes.length) placements.set(indexOf.get(row.message.id)!, row.changes.map((block) => block.run.id));
    if (row.kind !== 'tools') activity.set(row.message.id, row.runs.map((block) => block.run.id));
  }
  return { placements, activity };
}

/** Deterministic pseudo-random generator so fixtures are reproducible. */
function random(seed: number) {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

describe('deepEqualData / reuseById', () => {
  it('compares JSON-shaped data structurally', () => {
    expect(deepEqualData({ a: [1, { b: 'x' }], c: null }, { a: [1, { b: 'x' }], c: null })).toBe(true);
    expect(deepEqualData({ a: [1] }, { a: [1, 2] })).toBe(false);
    expect(deepEqualData({ a: 1 }, { b: 1 })).toBe(false);
    expect(deepEqualData([], {})).toBe(false);
  });

  it('keeps previous identities for unchanged items and the previous list when nothing changed', () => {
    const first = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
    expect(reuseById(first, clone(first))).toBe(first);
    const next = reuseById(first, [{ id: 'a', v: 1 }, { id: 'b', v: 3 }, { id: 'c', v: 4 }]);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).not.toBe(first[1]);
    expect(next.map((item) => item.v)).toEqual([1, 3, 4]);
  });
});

describe('stream buffers', () => {
  it('lists only this session’s buffers and keeps the same array while only text grows', () => {
    const streams = { m1: { sessionId: 's1', base: '', text: 'a' }, other: { sessionId: 's2', base: '', text: 'b' } };
    const ids = pickSessionStreamIds(streams, 's1');
    expect(ids).toEqual(['m1']);
    expect(pickSessionStreamIds({ ...streams, m1: { sessionId: 's1', base: '', text: 'ab' }, other: { sessionId: 's2', base: '', text: 'bb' } }, 's1', ids)).toBe(ids);
    expect(pickSessionStreamIds({ ...streams, m2: { sessionId: 's1', base: '', text: 'c' } }, 's1', ids)).toEqual(['m1', 'm2']);
    expect(pickSessionStreamIds(streams, undefined)).toEqual([]);
  });

  it('keeps internal subagent handoffs out of chat without hiding matching human text', () => {
    const content = 'Subagent @reviewer finished. Result: checked the routes.';
    const stored = [message('human', 'user', { content }), message('internal', 'user', { content, kind: 'subagent-result' }), message('reply', 'assistant', { content: 'I reviewed the result.' })];
    const display = deriveDisplayMessages(stored, { sessionId: 's1', running: true, streamIds: ['internal'] });
    expect(display.map((item) => item.id)).toEqual(['human', 'reply']);
    expect(display[0]?.content).toBe(content);
  });

  it('shows streamed text only when it is longer than the stored text', () => {
    const stored: DisplayMessage = { id: 'm', role: 'assistant', content: 'hello', createdAt: '', live: true };
    expect(overlayStream(stored, undefined)).toBe(stored);
    expect(overlayStream(stored, { sessionId: 's1', base: 'he', text: 'l' })).toBe(stored);
    expect(overlayStream(stored, { sessionId: 's1', base: 'hello', text: ' world' }).content).toBe('hello world');
  });

  it('derives the same display messages as the previous global-stream implementation', () => {
    const stored = [message('m1', 'user'), message('m2', 'assistant', { kind: 'streaming', content: 'par' }), message('m3', 'assistant', { content: 'done' }), { ...message('x9', 'assistant'), sessionId: 's2' }];
    const streams = { m2: { sessionId: 's1', base: '', text: 'partial' }, m3: { sessionId: 's1', base: '', text: 'don' }, fresh: { sessionId: 's1', base: 'be', text: 'gin' }, foreign: { sessionId: 's2', base: '', text: 'zzz' } };
    for (const running of [true, false]) {
      const ids = pickSessionStreamIds(streams, 's1');
      const derived = deriveDisplayMessages(stored, { sessionId: 's1', running, streamIds: ids }).map((m) => overlayStream(m, streams[m.id as keyof typeof streams]));
      const expected: DisplayMessage[] = [];
      const seen = new Set<string>();
      for (const m of stored) {
        if (m.sessionId !== 's1') continue;
        seen.add(m.id);
        const st = streams[m.id as keyof typeof streams];
        const streamed = st ? st.base + st.text : '';
        expected.push({ id: m.id, sessionId: m.sessionId, role: m.role, content: streamed.length > m.content.length ? streamed : m.content, createdAt: m.createdAt, kind: m.kind, runId: m.runId, live: (Boolean(st) || m.kind === 'streaming') && running, attachments: m.attachments, contextRefs: m.contextRefs });
      }
      for (const [id, st] of Object.entries(streams)) if (st.sessionId === 's1' && !seen.has(id)) expected.push({ id, sessionId: 's1', role: 'assistant', content: st.base + st.text, createdAt: '', live: running });
      expect(derived).toEqual(expected);
    }
  });
});

describe('transcript layout', () => {
  it('places run activity and change cards like the previous quadratic implementation (randomised fixtures)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const next = random(seed);
      const messages: Message[] = [];
      const runs: SessionRun[] = [];
      let counter = 0;
      for (let turn = 0; turn < 12; turn++) {
        const runId = `r${turn}`;
        const user = `u${++counter}`;
        const kind = next() < 0.15 ? (next() < 0.5 ? 'group-delivery' : 'team-delivery') : undefined;
        if (next() > 0.1) messages.push(message(user, 'user', { kind }));
        const parts = Math.floor(next() * 4);
        for (let part = 0; part < parts; part++) {
          const pick = next();
          messages.push(message(`m${++counter}`, pick < 0.45 ? 'assistant' : pick < 0.8 ? 'tool' : 'system', { runId: next() < 0.9 ? runId : undefined }));
        }
        if (next() > 0.15) runs.push(run(runId, user, { status: next() < 0.2 ? 'running' : 'completed', startedAt: at(Math.floor(next() * 50)) }));
      }
      const display = deriveDisplayMessages(messages, { sessionId: 's1', running: false, streamIds: [] });
      const layout = buildTranscriptLayout({ messages: display, runs, toolCalls: [], subagents: [], streamIds: [] });
      const reference = referencePlacement(display, runs);
      const actual = layoutPlacement(layout.rows, display);
      // Delivery rows never show change cards (previous behaviour), so compare only message rows.
      for (const [index, ids] of reference.placements) {
        const target = display[index]!;
        const isDeliveryOrTool = target.role === 'tool' || (target.role === 'user' && (target.kind === 'group-delivery' || target.kind === 'team-delivery'));
        const expected = isDeliveryOrTool ? undefined : ids.filter((id) => runs.find((r) => r.id === id)!.status !== 'running');
        expect(actual.placements.get(index) ?? undefined, `seed ${seed} index ${index}`).toEqual(expected?.length ? expected : undefined);
      }
      expect([...actual.placements.keys()].every((index) => reference.placements.has(index)), `seed ${seed}`).toBe(true);
      expect(layout.unplaced.map((block) => block.run.id), `seed ${seed}`).toEqual(reference.unplaced);
      // Tool messages collapse into one group per consecutive run, exactly as before.
      const toolRows = layout.rows.filter((row) => row.kind === 'tools');
      expect(toolRows.reduce((total, row) => total + (row.kind === 'tools' ? row.messages.length : 0), 0)).toBe(display.filter((m) => m.role === 'tool').length);
    }
  });

  it('assigns tool calls and subagents to their run block', () => {
    const messages = deriveDisplayMessages([message('u1', 'user'), message('a1', 'assistant', { runId: 'r1' })], { sessionId: 's1', running: false, streamIds: [] });
    const task = call('c-task', 'r1', { name: 'Task', category: 'agent', input: JSON.stringify({ description: 'Review code', subagent_type: 'reviewer' }) });
    const deriver = createTranscriptDeriver();
    const model = deriver({ sessionId: 's1', provider: 'claude', model: 'm', running: false, messages: messages as unknown as Message[], runs: [run('r1', 'u1')], toolCalls: [task, call('c-other', 'r9', { sessionId: 's2' })], streamIds: [] });
    const userRow = model.layout.rows.find((row) => row.kind === 'message' && row.message.id === 'u1');
    expect(userRow?.kind === 'message' && userRow.runs[0]?.calls.map((c) => c.id)).toEqual(['c-task']);
    expect(userRow?.kind === 'message' && userRow.runs[0]?.subagents.map((s) => s.handle)).toEqual(['review-code']);
    expect(model.toolCalls).toHaveLength(1);
  });

  it('does a linear amount of work: one visit per message and run instead of one scan per run', () => {
    const turns = 600;
    const raw: Message[] = [];
    const runs: SessionRun[] = [];
    for (let i = 0; i < turns; i++) {
      raw.push(message(`u${i}`, 'user'), message(`a${i}`, 'assistant', { runId: `r${i}` }));
      runs.push(run(`r${i}`, `u${i}`));
    }
    const display = deriveDisplayMessages(raw, { sessionId: 's1', running: false, streamIds: [] });
    const measure = (build: (messages: readonly DisplayMessage[]) => unknown): number => {
      let reads = 0;
      const counted = display.map((m) => new Proxy(m, { get(target, key) { reads++; return Reflect.get(target, key); } }));
      build(counted);
      return reads;
    };
    const optimised = measure((messages) => buildTranscriptLayout({ messages, runs, toolCalls: [], subagents: [], streamIds: [] }));
    const previous = measure((messages) => referencePlacement(messages, runs));
    expect(optimised).toBeLessThan(display.length * 12);
    expect(previous).toBeGreaterThan(optimised * 50);
  });
});

describe('identity across refetches and tokens', () => {
  const stored = (): Message[] => [message('u1', 'user'), message('a1', 'assistant', { runId: 'r1', attachments: [{ id: 'f', name: 'n.txt', mimeType: 'text/plain', size: 1 }] as never }), message('u2', 'user'), message('a2', 'assistant', { runId: 'r2', kind: 'streaming', content: '' })];
  const input = (over: Partial<TranscriptInput> = {}): TranscriptInput => ({
    sessionId: 's1', provider: 'claude', model: 'm', running: true, messages: stored(), runs: [run('r1', 'u1', { changes: { status: 'available', capturedAt: at(1), fileCount: 1, files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0, binary: false }], additions: 1, deletions: 0, truncated: false, notices: [] } }), run('r2', 'u2', { status: 'running' })],
    toolCalls: [call('c1', 'r1'), call('c2', 'r2', { status: 'running' })], streamIds: [], ...over,
  });

  it('returns the identical model for a structurally identical bootstrap', () => {
    const derive = createTranscriptDeriver();
    const first = derive(input());
    const second = derive(clone(input()));
    expect(second).toBe(first);
    expect(second.layout.rows).toBe(first.layout.rows);
  });

  it('keeps every settled row when a stream starts and when only its text grows', () => {
    const derive = createTranscriptDeriver();
    const before = derive(input());
    const ids = ['a2'];
    const streaming = derive(input({ streamIds: ids }));
    const changedRows = streaming.layout.rows.filter((row, index) => row !== before.layout.rows[index]);
    expect(changedRows.map((row) => row.key)).toEqual(['a2']);
    // Text growth never reaches the derivation (the id list keeps its identity), so even a refetch yields the same model.
    expect(derive(input({ streamIds: ids }))).toBe(streaming);
  });

  it('re-renders only the row of a run whose data changed', () => {
    const derive = createTranscriptDeriver();
    const before = derive(input());
    const next = input();
    next.runs = [next.runs![0]!, { ...next.runs![1]!, toolCount: 3 }];
    const after = derive(next);
    const changed = after.layout.rows.filter((row, index) => row !== before.layout.rows[index]).map((row) => row.key);
    expect(changed).toEqual(['u2']);
  });

  it('hands each run block its own checklist and goal hint, and re-renders only the rows whose facts changed', () => {
    const derive = createTranscriptDeriver();
    const step = (id: string, runId: string, reported: 'pending' | 'completed', extra: Partial<Task> = {}): Task => ({
      id, projectId: 'p1', title: `Step ${id}`, description: '', acceptanceCriteria: '', sessionId: 's1', dependsOn: [], status: 'review', createdAt: at(1), updatedAt: at(1),
      source: { kind: 'provider', key: `provider:s1:plan:${id}`, runId, providerId: id, reportedStatus: reported }, ...extra,
    });
    const tasks = [step('t1', 'r2', 'pending'), step('t2', 'r2', 'completed'), step('t3', 'r1', 'completed', { sessionId: 's2' })];
    const before = derive({ ...input(), tasks, workflows: [] });
    const blocks = (model: ReturnType<typeof derive>) => new Map([...model.layout.blocks]);
    expect(blocks(before).get('r2')!.hints.checklist.map((item) => [item.id, item.status])).toEqual([['t1', 'pending'], ['t2', 'completed']]);
    expect(blocks(before).get('r1')!.hints.checklist).toEqual([]);
    expect(blocks(before).get('r2')!.latest).toBe(true);
    expect(blocks(before).get('r1')!.latest).toBe(false);
    // An unrelated task change (another session) and an identical refetch keep every block and row.
    const same = derive({ ...input(), tasks: [...tasks.map((task) => ({ ...task })), step('t9', 'r1', 'pending', { sessionId: 's9' })], workflows: [] });
    expect(same).toBe(before);
    // A step of r2 changes: only r2's block (and its row) is replaced.
    const moved = derive({ ...input(), tasks: [step('t1', 'r2', 'completed'), tasks[1]!, tasks[2]!], workflows: [] });
    expect(blocks(moved).get('r1')).toBe(blocks(before).get('r1'));
    expect(blocks(moved).get('r2')).not.toBe(blocks(before).get('r2'));
    const changed = moved.layout.rows.filter((row, index) => row !== before.layout.rows[index]).map((row) => row.key);
    expect(changed).toEqual(['u2']);
    // The goal's latest-turn pointer marks only that run.
    const goal = derive({ ...input(), tasks, workflows: [{ id: 'w', sessionId: 's1', lastRunId: 'r1', currentRunId: null } as SessionWorkflow] });
    expect(blocks(goal).get('r1')!.hints.goalTurn).toBe(true);
    expect(blocks(goal).get('r2')!.hints.goalTurn).toBe(false);
  });

  it('starts clean when the session changes', () => {
    const derive = createTranscriptDeriver();
    derive(input());
    const other = derive({ ...input(), sessionId: 's2', messages: [{ ...message('z1', 'user'), sessionId: 's2' }], runs: [], toolCalls: [] });
    expect(other.messages.map((m) => m.id)).toEqual(['z1']);
    expect(other.runs).toEqual([]);
  });
});
