import { expect, it } from 'vitest';
import { assignmentText, buildInstructions, LIMITS, type InstructionData } from './prompt.ts';

const worker: InstructionData = {
  title: 'Shared project', mode: 'orchestrated',
  self: { handle: 'owner', role: 'worker', provider: 'opencode', model: 'fake-model', effort: 'high', device: 'this device', load: { running: 1, queued: 0 },
    health: { memberId: 'owner', handle: 'owner', state: 'ok' }, activeScopes: [], state: 'working', you: true },
  roster: [{ handle: 'lead', role: 'orchestrator', provider: 'claude', model: 'sonnet', effort: 'medium', device: 'this device', load: { running: 0, queued: 1 },
    health: { memberId: 'lead', handle: 'lead', state: 'cooldown', until: '2026-10-29T12:00:00.000Z' },
    activeScopes: [{ taskId: 'task-lead', title: 'Update contracts', paths: ['packages/contracts/src'], status: 'running' }], state: 'idle', you: false }],
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

it('tells cross-device workers to use their permanent branch and permits a direct push to only that branch', () => {
  const instructions = buildInstructions({ ...worker, crossDeviceWorker: true });
  expect(instructions).toContain('permanent branch `mingle/owner/work`');
  expect(instructions).toContain('git add and git commit');
  expect(instructions).toContain('Mingle automatically pushes this branch to origin when your turn ends');
  expect(instructions).toContain('git push origin HEAD:mingle/owner/work');
  expect(instructions).toContain('git pull --no-rebase origin <integration-branch supplied by the host>');
  expect(instructions).toContain('never absolute paths from your device');
  expect(instructions).toContain('Never tell the human that you cannot commit or push');
  expect(instructions).not.toContain('Do not push manually');
  expect(instructions).not.toContain('never push or publish without explicit human authorization');
});

it('allows reply-only remote workers to synchronize and publish only their branch when asked', () => {
  const instructions = buildInstructions({ ...worker, crossDeviceWorker: true, deliveryKind: 'message', integrationBranch: 'main' });
  expect(instructions).toContain('reply-only message delivery');
  expect(instructions).toContain('If the sender asks, you may still git pull, commit or push only on your own permanent branch `mingle/owner/work`');
  expect(instructions).toContain('Do not edit files');
  expect(instructions).toContain('Git synchronization or publication');
  expect(instructions).not.toContain('Assignment assignment-1');
});

it('yields for pending worker integration and waits for the durable result-review wake', () => {
  const instructions = buildInstructions({ ...worker, self: { ...worker.self, role: 'orchestrator' }, canAssign: true,
    deliveryKind: 'request', assignment: null });
  expect(instructions).toContain('do not poll its repository or wait inside this provider turn');
  expect(instructions).toContain('yield with Pending and end the turn');
  expect(instructions).toContain('Mingle will wake a result-review turn after durable completion');
  expect(instructions).toContain('Do not give a partial final-looking result while waiting for that work to return');
  expect(instructions).toContain('inspect the exact host-fetched review ref');
  expect(instructions).toContain('never answer Pending or wait for a human prompt after completion has arrived');
  expect(instructions).toContain('call team_accept');
});

it('gives team planners branch-aware integration guidance and keeps non-team groups conservative', () => {
  const team = { ...worker, self: { ...worker.self, role: 'orchestrator' as const }, canAssign: true, deliveryKind: 'request' as const,
    assignment: null, teamPermissionLevel: 'full-access' as const, integrationBranch: 'main',
    roster: [...worker.roster, { ...worker.roster[0]!, handle: 'owner', role: 'worker' as const, provider: 'codex', model: 'model',
      state: 'running', you: false, branch: 'mingle/owner/work' }] };
  const fullAccess = buildInstructions(team);
  expect(fullAccess).toContain('origin/mingle/owner/work');
  expect(fullAccess).toContain('git fetch origin');
  expect(fullAccess).toContain('Mingle merges and pushes the integration branch normally');
  expect(fullAccess).toContain('Do not push again after team_accept');
  expect(fullAccess).toContain('git push origin main');
  expect(fullAccess).toContain('never force');
  expect(fullAccess).toContain('Never push to a worker branch');
  expect(fullAccess).toContain('git pull --no-rebase origin main');
  expect(fullAccess).toContain('do not check origin for its work');
  expect(fullAccess).toContain('Prefer team_assign with recipient "auto" unless one agent is clearly better');
  expect(fullAccess).toContain('non-overlapping file/directory scopes');
  expect(fullAccess).toContain('avoid cooldown/stalled agents');
  expect(fullAccess.length).toBeLessThanOrEqual(LIMITS.instructions);

  const supervised = buildInstructions({ ...team, teamPermissionLevel: 'supervised' });
  expect(supervised).toContain('ask the human before pushing the integration branch');
  expect(supervised).not.toContain('push the integration branch normally');

  const nonTeam = buildInstructions({ ...team, teamPermissionLevel: null });
  expect(nonTeam).toContain('Never push or publish, or modify the human-selected checkout, without explicit human authorization');
});

it('includes compact load, health, device and active scopes for planning within the instruction bound', () => {
  const instructions = buildInstructions(worker);
  expect(instructions).toContain('load 0r/1q');
  expect(instructions).toContain('health cooldown until 2026-10-29T12:00:00.000Z');
  expect(instructions).toContain('scopes packages/contracts/src');
  expect(instructions).toContain('this device');
  expect(instructions.length).toBeLessThanOrEqual(LIMITS.instructions);

  const compact = buildInstructions({ ...worker, roster: Array.from({ length: 64 }, (_, index) => ({
    ...worker.roster[0]!, handle: `agent${index}`, activeScopes: [{ taskId: `task${index}`, title: 'A large title', paths: Array.from({ length: 40 }, (__, path) => `packages/area${index}/file-${path}.ts`), status: 'running' }],
  })) });
  expect(compact.length).toBeLessThanOrEqual(LIMITS.instructions);
});

it('uses autonomous acceptance and a worker branch commit for full-access local groups only', () => {
  const lead = buildInstructions({ ...worker, self: { ...worker.self, role: 'orchestrator' }, canAssign: true,
    deliveryKind: 'request', assignment: null, fullAccessGroup: true });
  expect(lead).toContain('use team_accept with a verification summary');
  expect(lead).toContain('Mingle merges accepted worker branches into the group integration worktree');
  expect(lead).not.toContain('a human reviews task results before they are marked done');

  const assigned = assignmentText({ id: 'assignment-local', taskId: 'task-local', from: 'lead', to: 'owner', title: 'Build the page',
    objective: 'Create the static page.', acceptance: 'The page exists.', scope: ['index.html'], request: 'Build the page.', dependsOn: [], inputs: [], fullAccessLocal: true });
  expect(assigned).toContain('commit your scoped changes before recording Review');
});
