import { describe, expect, it } from 'vitest';
import type { DelegatedSubagent, Session } from '@mingle/contracts';
import { liveSidebarSubagents, liveSubagentDotStatus } from './sidebarSubagents';

function session(overrides: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    projectId: 'project-1', name: overrides.id, provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high',
    status: 'idle', policy: 'supervised', isolated: false, worktreePath: '/tmp/work', branch: null, providerSessionId: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', error: null, inputTokens: 0, outputTokens: 0,
    costUsd: null, pinned: false, unread: false, ...overrides,
  };
}

function helper(overrides: Partial<DelegatedSubagent> & Pick<DelegatedSubagent, 'id' | 'childSessionId'>): DelegatedSubagent {
  return {
    parentSessionId: 'parent-1', name: overrides.id, provider: 'claude', model: 'claude-sonnet-5-5', task: 'Review',
    status: 'running', requestedBy: 'agent', startedAt: '2026-01-01T00:00:00Z', endedAt: null, resultPreview: null,
    error: null, resultDelivered: false, ...overrides,
  };
}

const parent = session({ id: 'parent-1', status: 'running' });
const child = (id: string, overrides: Partial<Session> = {}) => session({ id, parentSessionId: 'parent-1', ...overrides });

describe('liveSidebarSubagents', () => {
  it('lists only running helpers, matched by child and parent session', () => {
    const sessions = [parent, child('child-a'), child('child-b'), child('child-c')];
    const live = liveSidebarSubagents(sessions, [
      helper({ id: 'a', childSessionId: 'child-a', status: 'running' }),
      helper({ id: 'b', childSessionId: 'child-b', status: 'completed', endedAt: '2026-01-01T00:01:00Z' }),
      helper({ id: 'c', childSessionId: 'child-c', status: 'failed', error: 'boom' }),
      helper({ id: 'd', childSessionId: 'child-d-missing', status: 'cancelled' }),
    ], 'project-1');

    expect([...live.keys()]).toEqual(['parent-1']);
    expect(live.get('parent-1')?.map(({ subagent }) => subagent.id)).toEqual(['a']);
  });

  it('keeps a running helper whose child session is idle or waiting, because the record is the authority', () => {
    const sessions = [parent, child('idle-child', { status: 'idle' }), child('waiting-child', { status: 'waiting' })];
    const live = liveSidebarSubagents(sessions, [
      helper({ id: 'startup', childSessionId: 'idle-child', startedAt: '2026-01-01T00:00:01Z' }),
      helper({ id: 'question', childSessionId: 'waiting-child', startedAt: '2026-01-01T00:00:02Z' }),
    ], 'project-1');

    expect(live.get('parent-1')?.map(({ subagent }) => subagent.id)).toEqual(['startup', 'question']);
  });

  it('does not count a finished helper again when its child session is used later', () => {
    const reusedChild = child('reused-child', { status: 'running' });
    const live = liveSidebarSubagents([parent, reusedChild], [
      helper({ id: 'done', childSessionId: 'reused-child', status: 'completed', endedAt: '2026-01-01T00:01:00Z' }),
    ], 'project-1');

    expect(live.size).toBe(0);
  });

  it('ignores helpers whose child session belongs to another project or parent', () => {
    const sessions = [parent, child('other-project', { projectId: 'project-2' }), child('other-parent', { parentSessionId: 'parent-2' })];
    const live = liveSidebarSubagents(sessions, [
      helper({ id: 'x', childSessionId: 'other-project' }),
      helper({ id: 'y', childSessionId: 'other-parent' }),
    ], 'project-1');

    expect(live.size).toBe(0);
  });

  it('orders helpers by start time and keeps one entry per child session', () => {
    const sessions = [parent, child('first'), child('second')];
    const live = liveSidebarSubagents(sessions, [
      helper({ id: 'late', childSessionId: 'second', startedAt: '2026-01-01T00:00:05Z' }),
      helper({ id: 'early', childSessionId: 'first', startedAt: '2026-01-01T00:00:01Z' }),
      helper({ id: 'duplicate', childSessionId: 'first', startedAt: '2026-01-01T00:00:09Z' }),
    ], 'project-1');

    expect(live.get('parent-1')?.map(({ subagent }) => subagent.id)).toEqual(['early', 'late']);
  });

  it('tolerates a missing delegated list', () => {
    expect(liveSidebarSubagents([parent, child('child-a')], undefined, 'project-1').size).toBe(0);
  });
});

describe('liveSubagentDotStatus', () => {
  it('shows running for idle and interrupted child sessions while the helper is live', () => {
    expect(liveSubagentDotStatus(child('a', { status: 'idle' }))).toBe('running');
    expect(liveSubagentDotStatus(child('b', { status: 'interrupted' }))).toBe('running');
    expect(liveSubagentDotStatus(child('c', { status: 'running' }))).toBe('running');
  });

  it('keeps waiting and error states visible', () => {
    expect(liveSubagentDotStatus(child('a', { status: 'waiting' }))).toBe('waiting');
    expect(liveSubagentDotStatus(child('b', { status: 'error' }))).toBe('error');
  });
});
