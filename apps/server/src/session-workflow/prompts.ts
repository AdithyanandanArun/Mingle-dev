import type { SessionWorkflow, WorkflowStopReason } from '@mingle/contracts';

const RULES = [
  'Mingle runs this goal in bounded turns inside your existing conversation. Permissions are the session\'s own and never change.',
  'The most recent message from a person always outranks this goal and your earlier plan; follow it first.',
  'Keep the progress checklist (mingle_plan_update) accurate. When you stop working on the goal, call mingle_workflow_finish exactly once: outcome "complete" only if the goal is really done, "blocked" if you cannot continue, "needs_human" if a decision or approval is required. Your report is your own claim; say honestly what you did and verified.',
  'Do not commit, push, publish, merge or deploy unless the goal or a later message from a person explicitly asks for it. Do not hide failures, and do not repeat side effects that may already have happened.',
].join('\n');

export function startPrompt(goal: string, workflow: Pick<SessionWorkflow, 'limits'>): string {
  return [
    'Goal (autonomous work):', goal.trim(), '',
    `Budget: at most ${workflow.limits.maxTurns} turns and ${workflow.limits.maxElapsedMinutes} minutes in total.`, RULES,
  ].join('\n');
}

export function continuePrompt(workflow: Pick<SessionWorkflow, 'goal' | 'counters' | 'limits'>): string {
  return [
    `Continue working toward the goal (turn ${workflow.counters.turns + 1} of at most ${workflow.limits.maxTurns}).`,
    `Goal: ${workflow.goal}`, '',
    'Check the checklist and the current state of the files, then do the next concrete step. Do not redo finished work.', RULES,
  ].join('\n');
}

export function verifyPrompt(workflow: Pick<SessionWorkflow, 'goal'>): string {
  return [
    'Your last turn ended without a goal report and without an open checklist.',
    `Goal: ${workflow.goal}`, '',
    'Decide now: if the goal is done, verify it against the real state of the files and call mingle_workflow_finish with outcome "complete" and an honest summary. If you are blocked or need a person, call it with "blocked" or "needs_human". If work remains, put the remaining steps in the checklist and continue. This is the only reminder; an unreported turn pauses the goal.', RULES,
  ].join('\n');
}

export function resumePrompt(workflow: Pick<SessionWorkflow, 'goal' | 'stopReason' | 'summary'>, queuedCount: number): string {
  return [
    `A person resumed this goal after it paused${workflow.stopReason ? ` (${describeReason(workflow.stopReason)})` : ''}.`,
    workflow.summary ? `Pause note: ${workflow.summary}` : '',
    `Goal: ${workflow.goal}`, '',
    'Before doing anything else, inspect the current state: git status and diff, files you were editing, and any partial work from the interrupted turn. Do not redo finished steps and do not repeat commands or other side effects that may already have run; check first.',
    queuedCount ? `${queuedCount} queued message(s) are waiting and will be delivered after this turn; if they conflict with the goal, expect them to take priority.` : '',
    RULES,
  ].filter(Boolean).join('\n');
}

/** Short reminder attached to adopted human, queue and subagent-result turns. */
export function adoptedContext(workflow: Pick<SessionWorkflow, 'goal'>): string {
  return [
    `[Mingle: this turn is part of the active goal "${workflow.goal.slice(0, 500)}". The newest human message outranks the goal. When you stop working on the goal call mingle_workflow_finish once (complete, blocked or needs_human); do not commit, push or publish unless a person asked.]`,
  ].join('\n');
}

export function describeReason(reason: WorkflowStopReason): string {
  switch (reason) {
    case 'user-pause': return 'paused by a person';
    case 'user-stop': return 'stopped by a person';
    case 'needs-input': return 'needs a person';
    case 'approval-denied': return 'an approval was denied or expired';
    case 'quota': return 'provider quota';
    case 'failure': return 'a provider failure';
    case 'limit': return 'a turn or time budget was reached';
    case 'stalled': return 'no measurable progress';
    case 'goal-complete': return 'the agent reported the goal complete';
    case 'agent-blocked': return 'the agent reported it is blocked';
    case 'refused': return 'the provider refused the request';
    case 'app-closed': return 'Mingle was closed';
    case 'configuration-changed': return 'the session configuration changed';
    case 'unreported-outcome': return 'the agent ended its turns without reporting an outcome';
    case 'session-unavailable': return 'the session became unavailable';
  }
}
