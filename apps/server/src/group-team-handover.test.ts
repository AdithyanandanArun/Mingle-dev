import { rmSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { makeRepo, startTestApp } from './test-utils.ts';
import type { TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const repos: string[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
  while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true });
});

it('requeues a failed planner request to the selected team leader without starting inference while paused', async () => {
  const test = await startTestApp({ exampleWorkspace: false });
  apps.push(test);
  const path = makeRepo();
  repos.push(path);
  const project = test.app.store.insertProject({ id: 'team-handover-project', name: 'Team handover', path });
  const lead = test.app.store.insertSession({ projectId: project.id, name: 'Original lead', provider: 'claude', model: 'claude-sonnet-5-5',
    effort: 'high', policy: 'supervised', isolated: false, worktreePath: path, branch: null });
  const fallback = test.app.store.insertSession({ projectId: project.id, name: 'Fallback lead', provider: 'claude', model: 'claude-sonnet-5-5',
    effort: 'high', policy: 'supervised', isolated: false, worktreePath: path, branch: null });
  const groupId = 'teamgroup-handover-test';
  test.app.groups.createTeamGroup({ id: groupId, projectId: project.id, title: 'Team handover', orchestratorSessionId: lead.id,
    members: [
      { sessionId: lead.id, handle: 'claude1', role: 'orchestrator', held: false },
      { sessionId: fallback.id, handle: 'claude2', role: 'worker', held: false },
    ] });
  const snapshot = test.app.groups.get(groupId);
  const leadMember = snapshot.members.find((member) => member.sessionId === lead.id)!;
  const requestId = 'handover-request';
  const messageId = 'handover-message';
  const failedDeliveryId = 'handover-failed-delivery';
  const at = new Date().toISOString();
  test.app.store.db.prepare(`INSERT INTO group_messages(id,group_id,sender_member_id,recipient_member_ids,kind,content,request_id,reply_to_id,source_message_id,source_run_id,client_message_id,created_at,invocation,context_refs_json)
    VALUES(?,?,NULL,?,'user',?,NULL,NULL,NULL,NULL,NULL,?,NULL,NULL)`).run(messageId, groupId, JSON.stringify([leadMember.id]), 'Continue the pending plan', at);
  test.app.store.db.prepare(`INSERT INTO group_requests(id,group_id,message_id,planner_member_id,status,turns_used,created_at,updated_at,intent,execution_plan_id)
    VALUES(?,?,?,?,'paused',1,?,?, 'normal',NULL)`).run(requestId, groupId, messageId, leadMember.id, at, at);
  test.app.store.db.prepare(`INSERT INTO group_deliveries(id,group_id,request_id,message_id,member_id,kind,status,run_id,hop,attempts,retryable,error,assignment_id,started_at,created_at,updated_at,coordinator_epoch,task_id)
    VALUES(?,?,?,?,?,'request','failed','failed-run',0,1,0,'quota exhausted',NULL,?,?,?,1,NULL)`)
    .run(failedDeliveryId, groupId, requestId, messageId, leadMember.id, at, at, at);

  test.app.groups.setTeamLeader(groupId, fallback.id, { paused: true, pauseReason: 'Waiting for explicit resume.' });
  const after = test.app.groups.get(groupId);
  const failed = after.deliveries.find((delivery) => delivery.id === failedDeliveryId)!;
  const queued = after.deliveries.find((delivery) => delivery.status === 'queued')!;
  expect(queued).toMatchObject({ memberId: after.group.orchestratorMemberId, requestId, messageId, kind: 'request' });
  expect(failed.recoveredByDeliveryId).toBe(queued.id);
  expect(after.requests.find((request) => request.id === requestId)?.status).toBe('paused');
  expect(test.fake.runs).toEqual([]);
});

it('allows removal of the last remote proxy while retaining the host conversation', async () => {
  const test = await startTestApp({ exampleWorkspace: false });
  apps.push(test);
  const path = makeRepo();
  repos.push(path);
  const project = test.app.store.insertProject({ id: 'team-proxy-removal-project', name: 'Proxy removal', path });
  const lead = test.app.store.insertSession({ projectId: project.id, name: 'Local lead', provider: 'claude', model: 'claude-sonnet-5-5',
    effort: 'high', policy: 'supervised', isolated: false, worktreePath: path, branch: null });
  const remote = test.app.store.insertSession({ projectId: project.id, id: 'proxy_remote_agent', name: 'Remote agent', provider: 'codex', model: 'gpt-6-codex',
    effort: 'medium', policy: 'supervised', isolated: false, worktreePath: path, branch: null });
  const groupId = 'group-last-proxy-removal';
  test.app.groups.createTeamGroup({ id: groupId, projectId: project.id, title: 'Shared session', orchestratorSessionId: lead.id,
    members: [
      { sessionId: lead.id, handle: 'claude1', role: 'orchestrator', held: false },
      { sessionId: remote.id, handle: 'codex1', role: 'worker', held: false },
    ] });
  test.app.store.db.prepare(`INSERT INTO mingle_team_proxy_sessions(session_id,team_id,shared_project_id,agent_id,owner_account_id,owner_device_id,handle)
    VALUES(?,?,?,?,?,?,?)`).run(remote.id, 'team-id', 'shared-project-id', 'remote-agent-id', 'owner-account-id', 'owner-device-id', 'codex1');
  const proxy = test.app.groups.get(groupId).members.find((member) => member.sessionId === remote.id)!;
  const after = test.app.groups.removeMember(groupId, proxy.id);
  expect(after.members.find((member) => member.id === proxy.id)?.removedAt).toBeTruthy();
  expect(after.members.filter((member) => !member.removedAt).map((member) => member.sessionId)).toEqual([lead.id]);
  expect(after.group.anchorSessionId).toBe(lead.id);
});
