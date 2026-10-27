/**
 * Clearly identified example-only distributed snapshots for browser acceptance.
 * No fixture below represents a live team, account, device, mailbox or provider.
 * `--serve` starts the real local Mingle runtime with disposable example data;
 * the positive team snapshots themselves are intercepted by the browser harness.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EXAMPLE = Object.freeze({
  teamA: 'example-team-alpha',
  teamB: 'example-team-beta',
  projectA: 'example-project-alpha',
  projectB: 'example-project-beta',
  localDevice: 'example-device-local',
  peerDevice: 'example-device-peer',
  wrongDevice: 'example-device-other',
  localAgent: 'example-agent-local',
  peerAgent: 'example-agent-peer',
  request: 'example-execution-request',
  approveRequest: 'example-execution-approve-request',
  wrongRequest: 'example-wrong-device-request',
  digest: 'a'.repeat(64),
  head: 'b'.repeat(40),
  fingerprint: 'c'.repeat(64),
});

const accountA = '10000000-0000-4000-8000-000000000001';
const accountB = '10000000-0000-4000-8000-000000000002';
const at = '2026-10-22T12:00:00.000Z';
const pendingInviteExpiry = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const expiredInviteDate = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function teamRecords(teamId, projectId, localProjectId, { local = true } = {}) {
  const localDevice = local ? EXAMPLE.localDevice : `${EXAMPLE.localDevice}-beta`;
  const peerDevice = local ? EXAMPLE.peerDevice : `${EXAMPLE.peerDevice}-beta`;
  const ownerId = local ? accountA : accountB;
  const peerOwnerId = local ? accountB : accountA;
  const localAgentId = local ? EXAMPLE.localAgent : `${EXAMPLE.localAgent}-beta`;
  const peerAgentId = local ? EXAMPLE.peerAgent : `${EXAMPLE.peerAgent}-beta`;
  const requestId = local ? EXAMPLE.request : `${EXAMPLE.request}-beta`;
  const digest = local ? EXAMPLE.digest : 'd'.repeat(64);
  const sharedProject = local ? projectId : `${projectId}-beta`;
  const localBoundProject = local ? localProjectId : localProjectId;
  const fixtureKey = local ? '' : '-beta';
  return {
    teams: {
      exampleData: true,
      userId: ownerId,
      configured: true,
      teams: [{ id: teamId, name: local ? 'Example Team Alpha' : 'Example Team Beta', ownerId, role: local ? 'owner' : 'member', createdAt: at }],
      members: [
        { id: `${teamId}-member-local`, teamId, userId: ownerId, name: local ? 'Example Owner A' : 'Example Owner B', email: local ? 'owner-a@example.invalid' : 'owner-b@example.invalid', role: 'owner' },
        { id: `${teamId}-member-peer`, teamId, userId: peerOwnerId, name: local ? 'Example Member B' : 'Example Member A', email: local ? 'member-b@example.invalid' : 'member-a@example.invalid', role: 'member' },
      ],
      projects: [{ id: sharedProject, teamId, name: local ? 'Example shared project' : 'Example second shared project', repositoryUrl: null }],
      invitations: [
        { id: `${teamId}-invite`, teamId, email: 'invited@example.invalid', role: 'member', expiresAt: pendingInviteExpiry(), acceptedAt: null },
        { id: `${teamId}-invite-accepted`, teamId, email: 'accepted@example.invalid', role: 'member', expiresAt: pendingInviteExpiry(), acceptedAt: expiredInviteDate() },
        { id: `${teamId}-invite-expired`, teamId, email: 'expired@example.invalid', role: 'member', expiresAt: expiredInviteDate(), acceptedAt: null },
      ],
    },
    transport: {
      exampleData: true,
      deviceId: localDevice,
      status: 'ready',
      error: null,
      devices: [
        { id: localDevice, teamId, ownerId, name: local ? 'Example Alpha laptop' : 'Example Beta local laptop', status: 'online', fingerprint: `SHA-256:${EXAMPLE.fingerprint}`, lastSeenAt: at },
        { id: `${localDevice}-spare`, teamId, ownerId, name: `Example ${local ? 'Alpha' : 'Beta'} spare laptop`, status: 'offline', fingerprint: `SHA-256:${'8'.repeat(64)}`, lastSeenAt: at },
        { id: peerDevice, teamId, ownerId: peerOwnerId, name: local ? 'Example Alpha peer laptop' : 'Example Beta peer laptop', status: 'online', fingerprint: `SHA-256:${'e'.repeat(64)}`, lastSeenAt: at },
      ],
      links: [{ teamId, deviceId: localDevice, peerDeviceId: peerDevice, mutual: true }],
      outbox: [],
    },
    execution: {
      exampleData: true,
      bindings: [{ teamId, sharedProjectId: sharedProject, localProjectId: localBoundProject }],
      agents: [
        { id: localAgentId, teamId, sharedProjectId: sharedProject, deviceId: localDevice, ownerId, name: `Example ${local ? 'Alpha' : 'Beta'} local Codex`, provider: 'codex', model: 'example-model', policy: 'supervised', presence: 'idle', quotaState: 'unknown', quotaKnown: false, quotaReason: null },
        { id: peerAgentId, teamId, sharedProjectId: sharedProject, deviceId: peerDevice, ownerId: peerOwnerId, name: `Example ${local ? 'Alpha' : 'Beta'} remote Claude`, provider: 'claude', model: 'example-model', policy: 'supervised', presence: 'idle', quotaState: 'available', quotaKnown: true, quotaReason: 'Example quota report' },
      ],
      requests: [
        {
          id: requestId, teamId, sharedProjectId: sharedProject, sourceDeviceId: peerDevice, targetDeviceId: localDevice,
          targetOwnerId: ownerId, agentId: localAgentId, content: 'Example recovery instructions',
          task: { title: 'Example recovery task', description: 'Example task description', acceptanceCriteria: 'Example acceptance check', dependsOn: [], groupId: null },
          evidence: { worktree: { head: EXAMPLE.head }, committedReferences: [], failureKind: 'quota_exhausted', failureMessage: 'Example recorded quota exhaustion', objective: 'Example objective' },
          state: 'awaiting-approval', digest, createdAt: at,
        },
        {
          id: local ? EXAMPLE.approveRequest : `${EXAMPLE.approveRequest}-beta`, teamId, sharedProjectId: sharedProject,
          sourceDeviceId: peerDevice, targetDeviceId: localDevice, targetOwnerId: ownerId, agentId: localAgentId,
          content: 'Example approval request',
          task: { title: 'Example approval task', description: 'Example approval details', acceptanceCriteria: 'Example consent check', dependsOn: [], groupId: null },
          evidence: { worktree: { head: EXAMPLE.head }, committedReferences: [], failureKind: 'human_requested_recovery', failureMessage: null, objective: 'Example explicit recovery' },
          state: 'awaiting-approval', digest: 'd'.repeat(64), createdAt: at,
        },
        {
          id: EXAMPLE.wrongRequest, teamId, sharedProjectId: sharedProject, sourceDeviceId: peerDevice, targetDeviceId: EXAMPLE.wrongDevice,
          targetOwnerId: peerOwnerId, agentId: peerAgentId, content: 'Wrong-device example request must remain hidden',
          task: { title: 'Wrong-device request', description: '', acceptanceCriteria: '', dependsOn: [], groupId: null },
          evidence: { worktree: { head: EXAMPLE.head }, committedReferences: [], failureKind: 'human_requested_recovery', failureMessage: null, objective: null },
          state: 'awaiting-approval', digest: 'f'.repeat(64), createdAt: at,
        },
      ],
      messages: [{ id: `${teamId}-message`, teamId, sharedProjectId: sharedProject, deviceId: peerDevice, ownerId: peerOwnerId, senderName: 'Example peer owner', kind: 'message', content: `Example ${local ? 'Alpha' : 'Beta'} shared message`, agentId: null, groupId: 'example-local-group', taskId: 'example-shared-task', createdAt: at }],
      tasks: [
        { id: `${teamId}-shared-task`, teamId, sharedProjectId: sharedProject, deviceId: peerDevice, ownerId: peerOwnerId, agentId: peerAgentId, groupId: 'example-local-group', title: `Example ${local ? 'Alpha' : 'Beta'} shared task`, description: 'Example task details', acceptanceCriteria: 'Example task criteria', status: 'blocked', dependsOn: [`${teamId}-prerequisite`], createdAt: at },
        { id: `${teamId}-prerequisite`, teamId, sharedProjectId: sharedProject, deviceId: localDevice, ownerId, agentId: localAgentId, groupId: 'example-local-group', title: `Example ${local ? 'Alpha' : 'Beta'} prerequisite`, description: '', acceptanceCriteria: '', status: 'review', dependsOn: [], createdAt: at },
      ],
      events: [{ id: 1, teamId, sharedProjectId: sharedProject, deviceId: peerDevice, ownerId: peerOwnerId, type: 'result', summary: `Example ${local ? 'Alpha' : 'Beta'} progress event`, payload: {}, createdAt: at }],
    },
    git: {
      exampleData: true,
      bindings: [],
      requests: [
        { id: `example-git-source${fixtureKey}`, teamId, sharedProjectId: sharedProject, direction: 'local', peerDeviceId: peerDevice, kind: 'transfer', status: 'awaiting-source-approval', requestDigest: digest, sourceHead: EXAMPLE.head, branch: 'example/source', notices: [], createdAt: at, updatedAt: at },
        { id: `example-git-destination${fixtureKey}`, teamId, sharedProjectId: sharedProject, direction: 'incoming', peerDeviceId: peerDevice, targetDeviceId: localDevice, kind: 'transfer', status: 'awaiting-destination-approval', requestDigest: digest, sourceHead: EXAMPLE.head, branch: 'example/destination', notices: [], createdAt: at, updatedAt: at },
        { id: `example-git-wrong-device${fixtureKey}`, teamId, sharedProjectId: sharedProject, direction: 'incoming', peerDeviceId: peerDevice, targetDeviceId: EXAMPLE.wrongDevice, kind: 'transfer', status: 'awaiting-destination-approval', requestDigest: 'f'.repeat(64), sourceHead: EXAMPLE.head, branch: 'example/wrong-device', notices: [], createdAt: at, updatedAt: at },
        { id: `example-git-imported${fixtureKey}`, teamId, sharedProjectId: sharedProject, direction: 'incoming', peerDeviceId: peerDevice, targetDeviceId: localDevice, kind: 'transfer', status: 'imported', requestDigest: digest, sourceHead: EXAMPLE.head, expectedHead: EXAMPLE.head, expectedFingerprint: EXAMPLE.fingerprint, branch: 'example/imported', notices: [], createdAt: at, updatedAt: at },
      ],
      audit: [{ id: `example-git-audit${fixtureKey}`, requestId: `example-git-source${fixtureKey}`, action: 'example-created', actorDeviceId: localDevice, digest, details: { source: 'example fixture' }, createdAt: at }],
    },
    commands: {
      exampleData: true,
      bindings: [],
      requests: [
        { id: `example-command-local${fixtureKey}`, teamId, sharedProjectId: sharedProject, direction: 'incoming', peerDeviceId: peerDevice, targetDeviceId: localDevice, status: 'awaiting-approval', operation: { kind: 'git.status' }, cwd: '.', expectedHead: EXAMPLE.head, expectedFingerprint: EXAMPLE.fingerprint, requestDigest: digest, exitCode: null, output: null, outputTruncated: false, error: null, createdAt: at, updatedAt: at },
        { id: `example-command-wrong-device${fixtureKey}`, teamId, sharedProjectId: sharedProject, direction: 'incoming', peerDeviceId: peerDevice, targetDeviceId: EXAMPLE.wrongDevice, status: 'awaiting-approval', operation: { kind: 'git.status' }, cwd: '.', expectedHead: EXAMPLE.head, expectedFingerprint: EXAMPLE.fingerprint, requestDigest: 'f'.repeat(64), exitCode: null, output: null, outputTruncated: false, error: null, createdAt: at, updatedAt: at },
      ],
      audit: [{ id: `example-command-audit${fixtureKey}`, requestId: `example-command-local${fixtureKey}`, action: 'example-created', actorDeviceId: localDevice, digest, details: { operation: 'git.status' }, createdAt: at }],
    },
  };
}

/** Both teams are present intentionally: the UI must scope all sections to the selected team. */
export function createExampleSnapshot(localProjectId, selectedTeamId = EXAMPLE.teamA) {
  const alpha = teamRecords(EXAMPLE.teamA, EXAMPLE.projectA, localProjectId);
  const beta = teamRecords(EXAMPLE.teamB, EXAMPLE.projectB, localProjectId, { local: false });
  const selected = selectedTeamId === EXAMPLE.teamB ? beta : alpha;
  return {
    teams: {
      ...selected.teams,
      teams: [...alpha.teams.teams, ...beta.teams.teams],
      members: [...alpha.teams.members, ...beta.teams.members],
      projects: [...alpha.teams.projects, ...beta.teams.projects],
      invitations: [...alpha.teams.invitations, ...beta.teams.invitations],
    },
    transport: {
      ...selected.transport,
      devices: [...alpha.transport.devices, ...beta.transport.devices],
      links: [...alpha.transport.links, ...beta.transport.links],
      outbox: [...alpha.transport.outbox, ...beta.transport.outbox],
    },
    execution: {
      ...selected.execution,
      bindings: [...alpha.execution.bindings, ...beta.execution.bindings],
      agents: [...alpha.execution.agents, ...beta.execution.agents],
      requests: [...alpha.execution.requests, ...beta.execution.requests],
      messages: [...alpha.execution.messages, ...beta.execution.messages],
      tasks: [...alpha.execution.tasks, ...beta.execution.tasks],
      events: [...alpha.execution.events, ...beta.execution.events],
    },
    git: {
      ...selected.git,
      bindings: [...alpha.git.bindings, ...beta.git.bindings],
      requests: [...alpha.git.requests, ...beta.git.requests],
      audit: [...alpha.git.audit, ...beta.git.audit],
    },
    commands: {
      ...selected.commands,
      bindings: [...alpha.commands.bindings, ...beta.commands.bindings],
      requests: [...alpha.commands.requests, ...beta.commands.requests],
      audit: [...alpha.commands.audit, ...beta.commands.audit],
    },
  };
}

export function exampleGroupSnapshot(anchorSessionId, peerSessionId) {
  return {
    group: { id: 'example-local-group', projectId: 'prj_example', title: 'Example local group', anchorSessionId, mode: 'cowork', orchestratorMemberId: null, paused: false, pauseReason: null, maxParallel: 2, maxTurns: 80, maxHops: 6, createdAt: at, updatedAt: at },
    members: [
      { id: 'example-group-member-anchor', groupId: 'example-local-group', sessionId: anchorSessionId, handle: 'anchor', role: 'peer', joinedAt: at, removedAt: null },
      { id: 'example-group-member-peer', groupId: 'example-local-group', sessionId: peerSessionId, handle: 'peer', role: 'peer', joinedAt: at, removedAt: null },
    ],
    messages: [], requests: [], deliveries: [], assignments: [],
  };
}

if (process.argv.includes('--serve')) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'mingle-distributed-browser-'));
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await app?.close(); } finally { rmSync(dataDir, { recursive: true, force: true }); }
  };
  let app;
  try {
    const [{ createApplication }, { FakeProviders }] = await Promise.all([
      import('../apps/server/src/app.ts'),
      import('../apps/server/src/test-utils.ts'),
    ]);
    app = createApplication({
      dataDir,
      port: Number(process.env.MINGLE_BROWSER_API_PORT) || 4310,
      webDevPort: Number(process.env.MINGLE_BROWSER_UI_PORT) || 4451,
      webDistDir: null,
      providers: new FakeProviders(),
      log: () => {},
      exampleWorkspace: true,
      detectOnStart: false,
    });
    // These existing-flow suites start after welcome; its own fixture tests first launch.
    app.store.updateSettings({ onboardingCompletedVersion: 1 });
    const address = await app.listen();
    process.stdout.write(`READY ${JSON.stringify({ url: address.url, exampleWorkspace: true, dataDir })}\n`);
    process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
    process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
    process.once('beforeExit', () => { void shutdown(); });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    await shutdown();
    process.exitCode = 1;
  }
}
