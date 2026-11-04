import { describe, expect, it } from 'vitest';
import type { RunReviewEvidence, SessionRun, SessionWorkflow, Task, ToolCall } from '@mingle/contracts';
import {
  changesVisible, commandOutcome, commandsSummary, commandWentWrong, deriveCommands, deriveReviewHints, extraProblems, hasReviewContent, NO_HINTS, turnStatusLabel,
} from './runReview';

const T = '2026-11-04T10:00:00.000Z';
const run = (extra: Partial<SessionRun> = {}): SessionRun => ({
  id: 'r1', sessionId: 's1', userMessageId: 'u1', provider: 'claude', model: 'm', status: 'completed', startedAt: T, finishedAt: T, durationMs: 1000, toolCount: 0, toolCounts: {}, changes: null, ...extra,
});
const call = (id: string, extra: Partial<ToolCall> = {}): ToolCall => ({
  id, runId: 'r1', sessionId: 's1', providerId: `p-${id}`, parentProviderId: null, name: 'Bash', category: 'command', status: 'completed', summary: '', command: `cmd ${id}`, input: '', output: '',
  cwd: null, exitCode: 0, processId: null, startedAt: T, finishedAt: T, durationMs: 10, ...extra,
});
const step = (id: string, runId: string, reported: 'pending' | 'in_progress' | 'completed' | 'blocked', extra: Partial<Task> = {}): Task => ({
  id, projectId: 'p1', title: `Step ${id}`, description: '', acceptanceCriteria: '', sessionId: 's1', dependsOn: [], status: 'review', createdAt: `2026-11-04T10:00:0${id.length}.000Z`, updatedAt: T,
  source: { kind: 'provider', key: `provider:s1:plan:${id}`, runId, providerId: id, reportedStatus: reported }, ...extra,
});
const evidence = (extra: Partial<RunReviewEvidence> = {}): RunReviewEvidence => ({
  runId: 'r1', sessionId: 's1', status: 'completed', readAt: T,
  tools: { total: 0, counts: {}, failed: 0, interrupted: 0, running: 0, nonZeroExit: 0 },
  commands: { total: 0, items: [], truncated: false }, problems: { total: 0, items: [], truncated: false }, failure: null, goalTurn: null, ...extra,
});

describe('command outcomes', () => {
  it('restates the recorded status and exit code and never calls anything passing', () => {
    expect(commandOutcome('completed', 0)).toBe('exit 0');
    expect(commandOutcome('completed', 3)).toBe('exit 3');
    expect(commandOutcome('completed', null)).toBe('no exit code recorded');
    expect(commandOutcome('failed', 1)).toBe('failed · exit 1');
    expect(commandOutcome('failed', null)).toBe('failed');
    expect(commandOutcome('interrupted', null)).toBe('interrupted');
    expect(commandOutcome('running', null)).toBe('still running');
    for (const outcome of ['completed', 'failed', 'interrupted', 'running'] as const) expect(commandOutcome(outcome, 0)).not.toMatch(/pass|success|ok\b|green/i);
  });

  it('flags only recorded problems; a missing exit code is unknown, not wrong', () => {
    expect(commandWentWrong({ status: 'completed', exitCode: 0 })).toBe(false);
    expect(commandWentWrong({ status: 'completed', exitCode: null })).toBe(false);
    expect(commandWentWrong({ status: 'completed', exitCode: 2 })).toBe(true);
    expect(commandWentWrong({ status: 'failed', exitCode: null })).toBe(true);
    expect(commandWentWrong({ status: 'interrupted', exitCode: null })).toBe(true);
  });
});

describe('commands', () => {
  it('uses the tool calls already in hand only as complete when every counted command is among them', () => {
    const r = run({ toolCount: 3, toolCounts: { command: 3 } });
    const partial = deriveCommands(r, [call('a'), call('b')], null);
    expect(partial).toMatchObject({ total: 3, complete: false, source: 'loaded' });
    expect(commandsSummary(partial)).toBe('3 commands recorded · outcomes not fully loaded');
    const whole = deriveCommands(r, [call('a'), call('b', { exitCode: 2, status: 'failed' }), call('c', { exitCode: null })], null);
    expect(whole.complete).toBe(true);
    expect(commandsSummary(whole)).toBe('3 commands recorded · 1 failed · 1 exited non-zero · 1 without an exit code');
  });

  it('knows the recorded count even when no rows are loaded, and ignores other runs and non-command tools', () => {
    const r = run({ toolCount: 5, toolCounts: { command: 4, file: 1 } });
    const none = deriveCommands(r, [call('f', { category: 'file' }), call('x', { runId: 'other' })], null);
    expect(none).toMatchObject({ total: 4, rows: [], complete: false, source: 'none' });
    expect(commandsSummary(none)).toBe('4 commands recorded · outcomes not fully loaded');
    expect(commandsSummary(deriveCommands(run(), [], null))).toBe('No commands recorded');
  });

  it('prefers bounded evidence for its own run, reports truncation, and refuses another run’s evidence', () => {
    const r = run({ toolCount: 60, toolCounts: { command: 60 } });
    const item = (id: string) => ({ id, name: 'Bash', command: `cmd ${id}`, summary: '', status: 'completed' as const, exitCode: 0, durationMs: 5, cwd: null });
    const trimmed = deriveCommands(r, [], evidence({ commands: { total: 60, items: [item('a'), item('b')], truncated: true } }));
    expect(trimmed).toMatchObject({ total: 60, complete: false, source: 'evidence' });
    expect(trimmed.rows).toHaveLength(2);
    expect(commandsSummary(trimmed)).toContain('outcomes not fully loaded');
    const foreign = deriveCommands(r, [], evidence({ runId: 'someone-else', commands: { total: 1, items: [item('z')], truncated: false } }));
    expect(foreign.source).toBe('none');
  });

  it('shows other problem calls only once, and not those the command list already shows', () => {
    const r = run({ toolCount: 2, toolCounts: { command: 1, file: 1 } });
    const ev = evidence({
      commands: { total: 1, items: [{ id: 'c1', name: 'Bash', command: 'npm test', summary: '', status: 'failed', exitCode: 1, durationMs: 5, cwd: null }], truncated: false },
      problems: { total: 2, truncated: false, items: [{ id: 'c1', name: 'Bash', category: 'command', status: 'failed', exitCode: 1, summary: '' }, { id: 'f1', name: 'Edit', category: 'file', status: 'failed', exitCode: null, summary: 'Edit a.ts' }] },
    });
    const commands = deriveCommands(r, [], ev);
    expect(extraProblems(ev, commands)).toEqual([{ id: 'f1', title: 'Edit a.ts', category: 'file', outcome: 'failed' }]);
    expect(extraProblems(null, commands)).toEqual([]);
  });
});

describe('when a card is warranted', () => {
  const capture = (fileCount: number, status: 'available' | 'unavailable' = 'available') => ({ status, capturedAt: T, fileCount, files: [], additions: 0, deletions: 0, truncated: false, notices: [] });
  it('stays quiet for a plain finished answer and for a run still going', () => {
    expect(hasReviewContent({ run: run(), hints: NO_HINTS })).toBe(false);
    expect(hasReviewContent({ run: run({ changes: capture(0) }), hints: NO_HINTS })).toBe(false);
    expect(hasReviewContent({ run: run({ status: 'running', changes: capture(2), toolCounts: { command: 1 } }), hints: NO_HINTS })).toBe(false);
  });
  it('appears for saved or unavailable changes, recorded commands, a failed or interrupted turn, a checklist, or a goal turn', () => {
    expect(hasReviewContent({ run: run({ changes: capture(2) }), hints: NO_HINTS })).toBe(true);
    expect(hasReviewContent({ run: run({ changes: capture(0, 'unavailable') }), hints: NO_HINTS })).toBe(true);
    expect(hasReviewContent({ run: run({ toolCounts: { command: 1 }, toolCount: 1 }), hints: NO_HINTS })).toBe(true);
    expect(hasReviewContent({ run: run({ toolCount: 1, toolCounts: { file: 1 } }), hints: NO_HINTS })).toBe(true);
    expect(hasReviewContent({ run: run({ status: 'failed' }), hints: NO_HINTS })).toBe(true);
    expect(hasReviewContent({ run: run({ status: 'interrupted' }), hints: NO_HINTS })).toBe(true);
    expect(hasReviewContent({ run: run(), hints: { checklist: [{ id: 't', title: 'x', status: 'pending' }], goalTurn: false } })).toBe(true);
    expect(hasReviewContent({ run: run(), hints: { checklist: [], goalTurn: true } })).toBe(true);
    expect(changesVisible(null)).toBe(false);
  });
  it('labels a completed provider turn as exactly that', () => {
    expect(turnStatusLabel('completed')).toBe('Provider turn completed');
    expect(turnStatusLabel('completed')).not.toMatch(/goal|achieved|done|success/i);
  });
});

describe('per-run hints', () => {
  it('attributes each checklist step to the run that reported it last, in its own session, without dropped or unreported steps', () => {
    const tasks = [
      step('a', 'r1', 'completed'), step('bb', 'r2', 'pending'), step('ccc', 'r2', 'blocked'),
      step('d', 'r2', 'pending', { sessionId: 's2' }),
      step('e', 'r2', 'pending', { source: { kind: 'provider', key: 'k', runId: 'r2', providerId: 'e', reportedStatus: 'pending', missing: true } }),
      step('f', 'r2', 'pending', { source: { kind: 'request', key: 'k2', runId: 'r2' } }),
      step('g', 'r2', 'pending', { source: { kind: 'provider', key: 'k3', runId: 'r2', providerId: 'g' } }),
    ];
    const hints = deriveReviewHints(tasks, [], 's1');
    expect(hints.get('r1')!.checklist.map((item) => item.id)).toEqual(['a']);
    expect(hints.get('r2')!.checklist.map((item) => [item.id, item.status])).toEqual([['bb', 'pending'], ['ccc', 'blocked']]);
    expect(hints.get('r3')).toBeUndefined();
  });

  it('marks a goal turn only from this session’s goal record', () => {
    const wf = (extra: Partial<SessionWorkflow>) => ({ id: 'w', sessionId: 's1', lastRunId: null, currentRunId: null, ...extra }) as SessionWorkflow;
    const hints = deriveReviewHints([], [wf({ lastRunId: 'r1' }), wf({ sessionId: 's2', lastRunId: 'r9', currentRunId: 'r8' })], 's1');
    expect(hints.get('r1')!.goalTurn).toBe(true);
    expect(hints.has('r9') || hints.has('r8')).toBe(false);
  });

  it('keeps identities while facts are unchanged and replaces only the run whose steps changed', () => {
    const tasks = [step('a', 'r1', 'pending'), step('bb', 'r2', 'pending')];
    const first = deriveReviewHints(tasks, [], 's1');
    expect(deriveReviewHints(tasks.map((task) => ({ ...task })), [], 's1', first)).toBe(first);
    const edited = deriveReviewHints([step('a', 'r1', 'completed'), tasks[1]!], [], 's1', first);
    expect(edited).not.toBe(first);
    expect(edited.get('r2')).toBe(first.get('r2'));
    expect(edited.get('r1')).not.toBe(first.get('r1'));
  });
});
