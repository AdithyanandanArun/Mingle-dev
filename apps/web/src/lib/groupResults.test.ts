import { expect, it } from 'vitest';
import type { Approval, GroupSnapshot, Session, Task } from '@mingle/contracts';
import { buildGroupResultModel } from './groupResults';

const at = '2026-10-28T12:00:00.000Z';

function resultFixture(deliveryStatus: 'queued' | 'running' | 'completed' = 'running') {
  const groupId = 'group-a';
  const requestId = 'request-a';
  const taskId = 'task-a';
  const workerSessionId = 'worker-session';
  const snapshot = {
    group: { id: groupId, projectId: 'project-a', anchorSessionId: 'lead-session', paused: false },
    members: [
      { id: 'lead', groupId, sessionId: 'lead-session', handle: 'lead', role: 'orchestrator', removedAt: null },
      { id: 'worker', groupId, sessionId: workerSessionId, handle: 'barista', role: 'worker', removedAt: null },
    ],
    messages: [{ id: 'human-request', seq: 1, groupId, kind: 'user', content: 'Add an order total.', requestId, createdAt: at }],
    requests: [{ id: requestId, groupId, messageId: 'human-request', plannerMemberId: 'lead', status: 'active', turnsUsed: 1, createdAt: at, intent: 'normal' }],
    deliveries: [{ id: 'delivery-a', groupId, requestId, messageId: 'assignment-a', memberId: 'worker', kind: 'assignment', status: deliveryStatus, runId: null, hop: 1, error: null, createdAt: at, updatedAt: at }],
    assignments: [{ id: 'assignment-a', groupId, requestId, fromMemberId: 'lead', toMemberId: 'worker', taskId, deliveryId: 'delivery-a', scope: ['src/order.ts'], createdAt: at }],
  } as unknown as GroupSnapshot;
  const sessions = [
    { id: 'lead-session', projectId: 'project-a', provider: 'claude', model: 'example', effort: 'high', status: 'idle', policy: 'supervised', isolated: true, worktreePath: '/example/lead' },
    { id: workerSessionId, projectId: 'project-a', provider: 'claude', model: 'example', effort: 'high', status: 'running', policy: 'supervised', isolated: true, worktreePath: '/example/worker' },
  ] as unknown as Session[];
  const tasks = [{ id: taskId, projectId: 'project-a', title: 'Add order total', status: 'running', dependsOn: [] }] as unknown as Task[];
  return { snapshot, sessions, tasks, workerSessionId };
}

it('reports an active assigned agent and keeps the remaining task count plain', () => {
  const { snapshot, sessions, tasks } = resultFixture();
  const result = buildGroupResultModel({ snapshot, sessions, messages: [], runs: [], tasks });

  expect(result).toMatchObject({ status: 'in-progress', title: 'In progress', summary: 'barista is working on 1 task.' });
  expect(result?.facts).toContain('1 task still open');
});

it('shows that an active turn is waiting for approval when the member has a pending approval', () => {
  const { snapshot, sessions, tasks, workerSessionId } = resultFixture();
  const approvals = [{ id: 'approval-a', sessionId: workerSessionId, status: 'pending', tool: 'Bash', description: 'Example', input: {}, createdAt: at }] as unknown as Approval[];
  const result = buildGroupResultModel({ snapshot, sessions, messages: [], runs: [], tasks, approvals });

  expect(result).toMatchObject({ status: 'in-progress', title: 'Waiting for approval', summary: "Waiting for the team lead's approval." });
});

it('uses finalizing only after turns end while the request remains open', () => {
  const { snapshot, sessions, tasks } = resultFixture('completed');
  const result = buildGroupResultModel({ snapshot, sessions, messages: [], runs: [], tasks });

  expect(result).toMatchObject({
    status: 'finalizing', title: 'Finalizing request',
    summary: "Wrapping up — the agents have finished; waiting for the team lead's orchestrator to close the request.",
  });
  expect(result?.facts).toContain('1 task still open');
});
