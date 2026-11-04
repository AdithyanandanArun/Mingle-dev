import type { Bootstrap, SessionSnapshot } from '@mingle/contracts';
import { describe, expect, it } from 'vitest';
import { applySessionSnapshot, reconcileBootstrap, validateSessionSnapshot } from './bootstrapState';

const at = '2026-11-04T12:00:00.000Z';
const row = (id: string, sessionId: string, extra: Record<string, unknown> = {}) => ({ id, sessionId, ...extra });
const session = (id: string, extra: Record<string, unknown> = {}) => ({ id, projectId: 'p', name: id, status: 'idle', ...extra });

function boot(): Bootstrap {
  return {
    projects: [{ id: 'p', name: 'p', path: '/p', createdAt: at, isExample: false }],
    sessions: [session('a'), session('b')],
    messages: [row('a1', 'a', { content: 'one' }), row('b1', 'b', { content: 'bee' }), row('a2', 'a', { content: 'two' })],
    runs: [row('ra', 'a'), row('rb', 'b')], toolCalls: [row('ta', 'a', { output: 'x' }), row('tb', 'b', { output: 'y' })],
    queuedMessages: [row('qa', 'a')], approvals: [row('pa', 'a', { status: 'pending' })], plans: [], questions: [],
    workflows: [row('wa', 'a')], delegatedSubagents: [{ id: 'da', parentSessionId: 'a' }],
    tasks: [], events: [], providers: [], settings: {}, version: 'v',
  } as unknown as Bootstrap;
}
const snapshot = (id: string, edit: (snap: Record<string, unknown[]>) => void = () => undefined): SessionSnapshot => {
  const source = JSON.parse(JSON.stringify(boot())) as unknown as Record<string, Array<Record<string, unknown>>>;
  const owner = (item: Record<string, unknown>) => (item.parentSessionId ?? item.sessionId) === id;
  const snap: Record<string, unknown> = { sessionId: id, eventCursor: 5, session: (source.sessions ?? []).find((item) => item.id === id) };
  for (const key of ['messages', 'runs', 'toolCalls', 'queuedMessages', 'approvals', 'plans', 'questions', 'workflows', 'delegatedSubagents']) snap[key] = (source[key] ?? []).filter(owner);
  edit(snap as Record<string, unknown[]>);
  return snap as unknown as SessionSnapshot;
};

describe('applySessionSnapshot', () => {
  it('returns the same object when the snapshot matches what is held', () => {
    const held = boot();
    expect(applySessionSnapshot(held, snapshot('a'))).toBe(held);
  });

  it('replaces only the session\'s rows and keeps every other reference', () => {
    const held = boot();
    const next = applySessionSnapshot(held, snapshot('a', (snap) => {
      (snap.messages as Array<Record<string, unknown>>).push(row('a3', 'a', { content: 'three' }));
      (snap.toolCalls as Array<Record<string, unknown>>)[0]!.output = 'updated';
      (snap.runs as unknown[]).length = 0;
    }))!;
    expect(next.messages.filter((item) => item.sessionId === 'a').map((item) => item.id)).toEqual(['a1', 'a2', 'a3']);
    expect(next.messages.find((item) => item.id === 'b1')).toBe(held.messages.find((item) => item.id === 'b1'));
    expect(next.messages.find((item) => item.id === 'a1')).toBe(held.messages.find((item) => item.id === 'a1'));
    expect(next.toolCalls.find((item) => item.id === 'ta')?.output).toBe('updated');
    expect(next.toolCalls.find((item) => item.id === 'tb')).toBe(held.toolCalls.find((item) => item.id === 'tb'));
    expect(next.runs.map((item) => item.id)).toEqual(['rb']);
    expect(next.projects).toBe(held.projects);
    expect(next.sessions[1]).toBe(held.sessions[1]);
    expect(next.queuedMessages).toBe(held.queuedMessages);
  });

  it('clears session-owned collections the snapshot no longer has, including workflows and helpers', () => {
    const next = applySessionSnapshot(boot(), snapshot('a', (snap) => { snap.queuedMessages = []; snap.approvals = []; snap.workflows = []; snap.delegatedSubagents = []; }))!;
    expect(next.queuedMessages).toEqual([]);
    expect(next.approvals).toEqual([]);
    expect(next.workflows).toEqual([]);
    expect(next.delegatedSubagents).toEqual([]);
  });

  it('refuses a session the state does not hold, so a late answer cannot resurrect it', () => {
    const held = boot();
    held.sessions = held.sessions.filter((item) => item.id !== 'a');
    expect(applySessionSnapshot(held, snapshot('a'))).toBeNull();
  });

  it('keeps the optimistic messages it is given after the saved ones', () => {
    const optimistic = { id: 'optimistic:1', sessionId: 'a', role: 'user', content: 'typed', createdAt: at };
    const held = boot();
    held.messages = [...held.messages, optimistic as never];
    const next = applySessionSnapshot(held, snapshot('a', (snap) => { (snap.messages as Array<Record<string, unknown>>).push(row('a3', 'a')); }), [optimistic as never])!;
    expect(next.messages.filter((item) => item.sessionId === 'a').map((item) => item.id)).toEqual(['a1', 'a2', 'a3', 'optimistic:1']);
    expect(next.messages.at(-1)).toBe(optimistic);
  });

  it('gives the same rows for the session as a full bootstrap that changed only that session', () => {
    const held = boot();
    const server = boot();
    server.messages.push(row('a3', 'a', { content: 'three' }) as never);
    server.toolCalls[0] = row('ta', 'a', { output: 'later' }) as never;
    server.sessions[0] = session('a', { status: 'running' }) as never;
    const viaSnapshot = applySessionSnapshot(held, snapshot('a', (snap) => {
      snap.messages = server.messages.filter((item) => item.sessionId === 'a');
      snap.toolCalls = server.toolCalls.filter((item) => item.sessionId === 'a');
      (snap as { session: unknown }).session = server.sessions[0];
    }))!;
    const viaBootstrap = reconcileBootstrap(held, server);
    const owned = (state: Bootstrap) => ({
      session: state.sessions.find((item) => item.id === 'a'), messages: state.messages.filter((item) => item.sessionId === 'a'),
      toolCalls: state.toolCalls.filter((item) => item.sessionId === 'a'), other: state.messages.filter((item) => item.sessionId === 'b'),
    });
    expect(owned(viaSnapshot)).toEqual(owned(viaBootstrap));
  });
});

describe('validateSessionSnapshot', () => {
  it('accepts exactly the requested session\'s snapshot', () => {
    const snap = snapshot('a');
    expect(validateSessionSnapshot(snap, 'a')).toBe(snap);
  });

  it.each([
    ['not an object', null],
    ['an answer for another session', snapshot('b')],
    ['a missing collection', (() => { const snap = snapshot('a') as unknown as Record<string, unknown>; delete snap.toolCalls; return snap; })()],
    ['a collection that is not a list', { ...snapshot('a'), runs: {} }],
    ['a foreign message row', snapshot('a', (snap) => { (snap.messages as unknown[]).push(row('b1', 'b')); })],
    ['a foreign tool call', snapshot('a', (snap) => { (snap.toolCalls as unknown[]).push(row('tb', 'b')); })],
    ['a row without an id', snapshot('a', (snap) => { (snap.runs as unknown[]).push({ sessionId: 'a' }); })],
    ['a session row for another id', { ...snapshot('a'), session: session('b') }],
    ['a helper owned by another parent', snapshot('a', (snap) => { (snap.delegatedSubagents as unknown[]).push({ id: 'dx', parentSessionId: 'b' }); })],
  ])('rejects %s', (_name, value) => {
    expect(() => validateSessionSnapshot(value, 'a')).toThrow(/Malformed session snapshot/);
  });
});
