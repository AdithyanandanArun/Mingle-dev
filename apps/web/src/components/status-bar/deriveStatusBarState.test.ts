import { describe, expect, it } from 'vitest';
import type { Approval, Session, SessionRun, Task, ToolCall, UserQuestion, WorkspaceEvent } from '@mingle/contracts';
import { deriveStatusBarState } from './deriveStatusBarState';

const session: Session = {
  id: 'session-1', projectId: 'project-1', name: 'Session', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high',
  status: 'running', policy: 'supervised', isolated: false, worktreePath: '/tmp/work', branch: null, providerSessionId: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', error: null, inputTokens: 0, outputTokens: 0,
  costUsd: null, pinned: false, unread: false,
};
const run: SessionRun = { id: 'run-1', sessionId: session.id, userMessageId: 'message-1', provider: 'claude', model: session.model, status: 'running', startedAt: '2026-01-01T00:00:00Z', finishedAt: null, durationMs: null, toolCount: 0, toolCounts: {} };
const defaults = { session, runs: [run], toolCalls: [] as ToolCall[], tasks: [] as Task[], events: [] as WorkspaceEvent[], approvals: [] as Approval[], questions: [] as UserQuestion[] };

function event(id: number, type: string, payload: Record<string, unknown>, createdAt = `2026-01-01T00:00:0${id}Z`): WorkspaceEvent {
  return { id, projectId: session.projectId, sessionId: session.id, type, summary: 'Progress update', payload, createdAt };
}

describe('deriveStatusBarState', () => {
  it('prioritizes the active run explicit status and its detail/progress', () => {
    const result = deriveStatusBarState({ ...defaults, events: [event(1, 'session.progress.status', { runId: run.id, status: { step: 'Inspecting routes', detail: 'Tracing request handling', progress: { current: 2, total: 5 } } })] });
    expect(result).toMatchObject({ primary: 'Inspecting routes', secondary: 'Step 2 of 5 · Tracing request handling', running: true });
  });

  it('shows a durable Mingle plan checklist and its active step after the run ends', () => {
    const result = deriveStatusBarState({ ...defaults, session: { ...session, status: 'idle' }, runs: [{ ...run, status: 'completed' }], events: [event(1, 'session.progress.plan', { planId: 'mingle-status:session-1', steps: [
      { id: 'one', title: 'Read the routes', status: 'done' }, { id: 'two', title: 'Add the event', status: 'in_progress' }, { id: 'three', title: 'Verify the UI', status: 'pending' },
    ] })] });
    expect(result).toMatchObject({ primary: 'Add the event', secondary: 'Step 2 of 3', running: false, steps: [{ status: 'done' }, { status: 'in_progress' }, { status: 'pending' }] });
  });

  it('falls back to the latest provider task plan when no Mingle plan is newer', () => {
    const task: Task = { id: 'task-1', projectId: session.projectId, title: 'Update native plan', description: '', acceptanceCriteria: '', sessionId: session.id,
      dependsOn: [], status: 'running', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z', source: { kind: 'provider', key: 'provider:session:run:run-1:claude-todos:root:task-1', providerId: 'task-1', runId: run.id, reportedStatus: 'in_progress' } };
    expect(deriveStatusBarState({ ...defaults, tasks: [task] })).toMatchObject({ primary: 'Update native plan', secondary: 'Step 1 of 1' });
  });

  it('shows running subagent names after plan progress and excludes team tools', () => {
    const calls = [
      { ...toolCall('task-1', 'Task', 'agent'), input: JSON.stringify({ description: 'Explore routes' }) },
      { ...toolCall('team-1', 'mcp:mingle_team/team_send', 'agent') },
    ];
    expect(deriveStatusBarState({ ...defaults, toolCalls: calls })).toMatchObject({ primary: 'Waiting for subagent to finish', secondary: 'Explore routes' });
  });

  it('uses waiting approval and question messages when no explicit plan activity is reported', () => {
    const waiting = { ...session, status: 'waiting' as const };
    expect(deriveStatusBarState({ ...defaults, session: waiting, approvals: [{ id: 'approval-1', sessionId: session.id, tool: 'edit', description: '', input: {}, status: 'pending', createdAt: '' }] })).toMatchObject({ primary: 'Waiting for approval' });
    expect(deriveStatusBarState({ ...defaults, session: waiting, questions: [{ id: 'question-1', sessionId: session.id, runId: run.id, provider: 'claude', tool: 'AskUserQuestion', status: 'pending', questions: [{ id: 'q', question: 'Which one?', options: [], multiSelect: false, allowOther: false, secret: false }], createdAt: '', resolvedAt: null }] as UserQuestion[] })).toMatchObject({ primary: 'Waiting for your answer' });
  });

  it('reports group agent waits and hides a completed idle plan', () => {
    expect(deriveStatusBarState({ ...defaults, session: { ...session, status: 'idle' }, runs: [], waitingAgents: [{ name: '@worker', running: true }] })).toMatchObject({ primary: 'Waiting on 1 agent', secondary: '@worker' });
    expect(deriveStatusBarState({ ...defaults, session: { ...session, status: 'idle' }, runs: [{ ...run, status: 'completed' }], events: [event(1, 'session.progress.plan', { steps: [{ title: 'Done', status: 'done' }] })] })).toBeNull();
  });
});

function toolCall(id: string, name: string, category: ToolCall['category']): ToolCall {
  return { id, runId: run.id, sessionId: session.id, providerId: id, parentProviderId: null, name, category, status: 'running', summary: '', command: null,
    input: '{}', output: '', cwd: null, exitCode: null, processId: null, startedAt: '', finishedAt: null, durationMs: null };
}
