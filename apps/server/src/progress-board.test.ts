import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GroupSnapshot } from '@mingle/contracts';
import { buildProgressBoard } from './progress-board.ts';
import { GroupRepo } from './groups/repo.ts';
import { makeRepo, runGit, startTestApp, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const repos: string[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
  while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true });
});

it('builds a bounded board from a temp integration checkout, worker ref, review row and blockers', async () => {
  const integration = makeRepo(); repos.push(integration);
  const workerBranch = 'mingle/board-worker/work';
  const workerPath = path.join(path.dirname(integration), `board-worker-${Date.now()}`);
  runGit(integration, 'worktree', 'add', '-b', workerBranch, workerPath, 'HEAD');
  repos.push(workerPath);
  writeFileSync(path.join(workerPath, 'board.txt'), 'worker result\n');
  runGit(workerPath, 'add', 'board.txt');
  runGit(workerPath, 'commit', '-m', 'Board worker result');
  const workerSha = runGit(workerPath, 'rev-parse', 'HEAD').trim();
  runGit(integration, 'update-ref', `refs/remotes/origin/${workerBranch}`, workerSha);

  const t = await startTestApp(); apps.push(t);
  const project = t.app.store.insertProject({ id: 'board-project', name: 'Progress board test', path: integration });
  const anchor = t.app.store.insertSession({ id: 'board-anchor', projectId: project.id, name: 'Lead', provider: 'codex', model: 'gpt-6.1-sol',
    effort: 'high', policy: 'supervised', isolated: false, worktreePath: integration, branch: 'main' });
  const worker = t.app.store.insertSession({ id: 'board-worker', projectId: project.id, name: 'Worker', provider: 'claude', model: 'claude-sonnet-5-5',
    effort: 'high', policy: 'supervised', isolated: true, worktreePath: integration, branch: null });
  const task = t.app.store.insertTask({ id: 'board-task', projectId: project.id, title: 'Finish the board worker task', description: '', acceptanceCriteria: '',
    sessionId: worker.id, dependsOn: [], status: 'blocked' });
  t.app.store.insertApproval({ sessionId: worker.id, tool: 'Write', description: 'Pending provider approval', input: {} });
  const deliveryId = 'board-delivery';
  t.app.store.db.prepare(`INSERT INTO mingle_team_proxy_sessions
    (session_id,team_id,shared_project_id,agent_id,owner_account_id,owner_device_id,handle) VALUES (?,?,?,?,?,?,?)`)
    .run(worker.id, 'board-team', 'board-shared-project', 'board-agent', 'board-owner', 'board-device', 'board-worker');
  t.app.store.db.prepare(`INSERT INTO mingle_team_host_review_branches
    (delivery_id,branch,commit_sha,review_ref,fetch_failure,push_failure,merged_at,accepted_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(deliveryId, workerBranch, workerSha, `refs/mingle/team/review/${deliveryId}`, 'Fetch failed for https://secret.example/team.git',
      'Push failed for https://secret.example/team.git', null, null);

  const at = new Date().toISOString();
  const group: GroupSnapshot = {
    group: { id: 'board-group', projectId: project.id, title: 'Progress board', anchorSessionId: anchor.id, mode: 'current-leads',
      orchestratorMemberId: 'board-lead-member', paused: false, pauseReason: null, maxParallel: 2, maxTurns: 80, maxHops: 6, createdAt: at, updatedAt: at },
    members: [
      { id: 'board-lead-member', groupId: 'board-group', sessionId: anchor.id, handle: 'lead', role: 'orchestrator', joinedAt: at, removedAt: null },
      { id: 'board-worker-member', groupId: 'board-group', sessionId: worker.id, handle: 'board-worker', role: 'worker', joinedAt: at, removedAt: null },
    ],
    messages: [], requests: [{ id: 'board-request', groupId: 'board-group', messageId: 'board-message', plannerMemberId: 'board-lead-member', status: 'active', turnsUsed: 1, createdAt: at, intent: 'normal' }],
    deliveries: [{ id: deliveryId, groupId: 'board-group', requestId: 'board-request', messageId: 'board-message', memberId: 'board-worker-member',
      kind: 'assignment', status: 'running', runId: 'board-run', hop: 0, error: null, createdAt: at, updatedAt: at }],
    assignments: [{ id: 'board-assignment', groupId: 'board-group', requestId: 'board-request', fromMemberId: 'board-lead-member', toMemberId: 'board-worker-member',
      taskId: task.id, deliveryId, scope: ['board.txt'], createdAt: at }],
  };
  t.app.store.recordEvent({ projectId: project.id, sessionId: worker.id, type: 'session.progress.status', summary: 'Run progress updated',
    payload: { runId: 'board-run', status: { step: 'Review worker changes', detail: 'secret detail must stay private', progress: { current: 3, total: 7 } } } });
  const integrationHead = runGit(integration, 'rev-parse', 'HEAD').trim();
  t.app.store.recordEvent({ projectId: project.id, type: 'group.integration.pushed', summary: 'Integration pushed',
    payload: { groupId: group.group.id, branch: 'main', commitSha: integrationHead } });
  t.app.store.recordEvent({ projectId: project.id, sessionId: worker.id, type: 'group.delivery.auto-fallback', summary: 'Automatic fallback',
    payload: { groupId: group.group.id, fromMemberId: 'board-worker-member', toMemberId: 'board-lead-member', assignmentId: 'board-assignment', taskId: task.id } });

  const board = await buildProgressBoard({ store: t.app.store, group, memberHealth: [
    { memberId: 'board-lead-member', handle: 'lead', state: 'stalled', until: at, reason: 'No activity from the current delivery' },
    { memberId: 'board-worker-member', handle: 'board-worker', state: 'cooldown', until: '2026-10-29T10:12:00.000Z',
      reason: `Provider quota exhausted at https://secret.example/api api_key=${'x'.repeat(24)} ${'y'.repeat(180)}` },
  ], now: () => Date.parse(at) });
  const member = board.members.find((item) => item.memberId === 'board-worker-member')!;
  const leadMember = board.members.find((item) => item.memberId === 'board-lead-member')!;
  expect(board.integration).toMatchObject({ branch: 'main', head: { sha: integrationHead, subject: 'initial' }, lastPush: { sha: integrationHead } });
  expect(member).toMatchObject({
    handle: 'board-worker', provider: 'claude', device: 'Remote owner', state: 'waiting-approval',
    currentTask: { id: task.id, status: 'blocked' },
    step: { label: 'Review worker changes', current: 3, total: 7 },
    branch: { name: workerBranch, lastCommit: { sha: workerSha, subject: 'Board worker result' }, pushed: false, merged: false },
    health: { state: 'cooldown', until: '2026-10-29T10:12:00.000Z' },
    assignmentHandoff: { action: 'moved', handle: 'lead' },
  });
  expect(member.health?.reason).toContain('[remote]');
  expect(member.health?.reason).not.toContain('secret.example');
  expect(member.health?.reason).not.toContain('xxxxxxxx');
  expect(member.health?.reason?.length).toBeLessThanOrEqual(160);
  expect(member.blockers).toContain(member.health?.reason);
  expect(leadMember).toMatchObject({ state: 'stalled', health: { state: 'stalled' }, assignmentHandoff: { action: 'took-over', handle: 'board-worker' } });
  expect(member.blockers).toHaveLength(3);
  expect(member.blockers.join(' ')).toContain('Approval required');
  expect(member.blockers.join(' ')).toContain('blocked');
  expect(member.blockers.join(' ')).toContain('[remote]');
  expect(JSON.stringify(board)).not.toContain('secret.example');
  expect(JSON.stringify(board)).not.toContain('secret detail');
});

it('serves local group boards and falls back to a synced host board for a remote team session', async () => {
  const integration = makeRepo(); repos.push(integration);
  const t = await startTestApp(); apps.push(t);
  const project = t.app.store.insertProject({ id: 'board-route-project', name: 'Progress board route', path: integration });
  const anchor = t.app.store.insertSession({ id: 'board-route-anchor', projectId: project.id, name: 'Lead', provider: 'claude', model: 'claude-sonnet-5-5',
    effort: 'high', policy: 'supervised', isolated: false, worktreePath: integration, branch: 'main' });
  const groups = new GroupRepo(t.app.store.db);
  groups.insertGroup({ id: 'board-route-group', projectId: project.id, title: 'Team session', anchorSessionId: anchor.id,
    mode: 'orchestrated', maxParallel: 2, maxTurns: 20, maxHops: 5 });
  groups.insertMember({ id: 'board-route-member', groupId: 'board-route-group', sessionId: anchor.id, handle: 'lead', role: 'orchestrator' });
  vi.spyOn(t.app.groups, 'getMemberHealth').mockReturnValue([
    { memberId: 'board-route-member', handle: 'lead', state: 'cooldown', until: '2026-10-29T10:12:00.000Z' },
  ]);

  const local = await t.api('GET', '/api/groups/board-route-group/board');
  expect(local.status).toBe(200);
  expect(local.json).toMatchObject({ groupId: 'board-route-group', source: 'local' });
  expect((local.json as { members: Array<{ health: unknown }> }).members[0]?.health).toMatchObject({ state: 'cooldown', until: '2026-10-29T10:12:00.000Z' });
  expect(local.json.syncedAt).toBeUndefined();

  const board = { ...(await buildProgressBoard({ store: t.app.store, group: t.app.groups.get('board-route-group') })), groupId: 'remote-team-session' };
  const syncedAt = '2026-10-29T10:00:00.000Z';
  const syncedBoard = vi.spyOn(t.app.teamChat, 'syncedProgressBoard').mockResolvedValue({ board, syncedAt });
  const teammate = await t.api('GET', `/api/groups/remote-team-session/board?projectId=${project.id}`);
  expect(teammate.status).toBe(200);
  expect(teammate.json).toMatchObject({ groupId: 'remote-team-session', source: 'host', syncedAt });
  expect(syncedBoard).toHaveBeenCalledWith(project.id, 'remote-team-session');
});
