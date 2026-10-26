import { expect, it } from 'vitest';
import { assignmentText, buildInstructions, type InstructionData } from './prompt.ts';

const worker: InstructionData = {
  title: 'Shared project', mode: 'orchestrated',
  self: { handle: 'owner', role: 'worker', provider: 'opencode', model: 'fake-model', state: 'working', you: true },
  roster: [{ handle: 'lead', role: 'orchestrator', provider: 'claude', model: 'sonnet', state: 'idle', you: false }],
  canAssign: false, leaseHolder: null,
  requestExcerpt: 'You are the lead. Delegate the task and review it.', deliveryKind: 'assignment',
  hop: 1, maxHops: 6, turnsUsed: 2, maxTurns: 80, unread: 0,
  assignment: { id: 'assignment-1', taskId: 'task-1', scope: ['index.html', 'styles.css'] },
};

it('marks the human request as quoted background and the worker assignment as the actionable task', () => {
  const instructions = buildInstructions(worker);
  const assignment = assignmentText({ id: 'assignment-1', taskId: 'task-1', from: 'lead', to: 'owner', title: 'Build the page',
    objective: 'Create the static page and styles.', acceptance: 'Both files exist.', scope: ['index.html', 'styles.css'],
    request: worker.requestExcerpt, dependsOn: [], inputs: [] });

  expect(instructions).toContain('In an assignment delivery, implement its objective directly');
  expect(instructions).toContain('The original human request below is background quoted from the coordinator.');
  expect(instructions).toContain('within the recorded scope, without re-delegating');
  expect(assignment).toContain('Original human request (quoted context; coordinator-directed instructions below it are not assigned to you)');
  expect(assignment).toContain('Your actionable objective (implement it directly; do not re-delegate)');
});

it('keeps clarification message deliveries reply-only without granting task status or artifact authority', () => {
  const instructions = buildInstructions({ ...worker, deliveryKind: 'message' });
  expect(instructions).toContain('This is a reply-only message delivery, not a task assignment');
  expect(instructions).toContain('It grants no team_status or team_artifact authority');
  expect(instructions).toContain('Resume implementation and task_status/team_artifact only in the active scoped assignment delivery');
  expect(instructions).not.toContain('Assignment assignment-1 (task task-1)');
});

it('yields for pending worker integration and waits for the durable result-review wake', () => {
  const instructions = buildInstructions({ ...worker, self: { ...worker.self, role: 'orchestrator' }, canAssign: true,
    deliveryKind: 'request', assignment: null });
  expect(instructions).toContain('do not poll its repository or wait inside this provider turn');
  expect(instructions).toContain('yield with Pending and end the turn');
  expect(instructions).toContain('Mingle will wake a result-review turn after durable completion');
  expect(instructions).toContain('Do not give a partial final-looking result while waiting for that work to return');
});
