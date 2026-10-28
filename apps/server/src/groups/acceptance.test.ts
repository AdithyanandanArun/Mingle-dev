import { afterEach, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { openDatabase } from '../db.ts';
import { Store } from '../store.ts';
import { makeRepo } from '../test-utils.ts';
import { GroupRepo } from './repo.ts';

const stores: Store[] = [];
const repos: string[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.db.close();
  while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true });
});

it('persists orchestrator acceptance evidence in the group assignment snapshot source', () => {
  const store = new Store(openDatabase(':memory:'));
  stores.push(store);
  const path = makeRepo(); repos.push(path);
  const project = store.insertProject({ name: 'Acceptance fixture', path });
  const leadSession = store.insertSession({ projectId: project.id, name: 'Lead', provider: 'claude', model: 'claude-test', effort: 'medium',
    policy: 'full-access', isolated: false, worktreePath: path, branch: 'main' });
  const workerSession = store.insertSession({ projectId: project.id, name: 'Worker', provider: 'codex', model: 'codex-test', effort: 'medium',
    policy: 'full-access', isolated: false, worktreePath: path, branch: 'main' });
  store.insertTask({ id: 'task-1', projectId: project.id, title: 'Result', description: '', acceptanceCriteria: '', sessionId: workerSession.id, dependsOn: [], status: 'review' });
  const repo = new GroupRepo(store.db);
  repo.insertGroup({ id: 'group-1', projectId: project.id, title: 'Team', anchorSessionId: leadSession.id, mode: 'orchestrated', maxParallel: 2, maxTurns: 20, maxHops: 5 });
  repo.insertMember({ id: 'lead-member', groupId: 'group-1', sessionId: leadSession.id, handle: 'lead', role: 'orchestrator' });
  repo.insertMember({ id: 'worker-member', groupId: 'group-1', sessionId: workerSession.id, handle: 'worker', role: 'worker' });
  const message = repo.insertMessage({ groupId: 'group-1', senderMemberId: null, recipients: ['lead-member'], kind: 'user', content: 'Build' });
  repo.insertRequest({ id: 'request-1', groupId: 'group-1', messageId: message.id, plannerMemberId: 'lead-member' });
  repo.insertAssignment({ id: 'assignment-1', groupId: 'group-1', requestId: 'request-1', fromMemberId: 'lead-member',
    toMemberId: 'worker-member', taskId: 'task-1', deliveryId: 'delivery-1', scope: ['src/result.ts'], fingerprint: 'fingerprint' });

  repo.acceptAssignment('assignment-1', 'Tests passed and the diff was inspected.');

  expect(repo.getAssignment('assignment-1')).toMatchObject({ acceptedBy: 'orchestrator', verificationSummary: 'Tests passed and the diff was inspected.' });
});
