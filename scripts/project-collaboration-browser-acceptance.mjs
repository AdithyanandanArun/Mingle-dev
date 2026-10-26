#!/usr/bin/env node
/**
 * Browser acceptance for project-first teammate invites and joining.
 * Starts disposable local FakeProviders + Vite, mocks only the project-collaboration
 * cloud boundary and marks every positive identity/agent payload as an Example fixture.
 * No real account, cloud service, email sender, provider inference, or browser download is used.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const serverRequire = createRequire(new URL('../apps/server/package.json', import.meta.url));
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const tsxCli = serverRequire.resolve('tsx/cli');
const serverScript = fileURLToPath(new URL('./distributed-browser-fixtures.mjs', import.meta.url));
const viteModule = webRequire.resolve('vite');
const viteCli = path.resolve(path.dirname(viteModule), '../../bin/vite.js');
const outputDir = path.join(os.tmpdir(), `mingle-project-collaboration-acceptance-${process.pid}`);
const log = createWriteStream(path.join(outputDir, 'browser-acceptance.log'), { flags: 'w' });
const screenshots = {
  invite: path.join(outputDir, 'teammates-invite.png'),
  join: path.join(outputDir, 'join-project-desktop.png'),
  narrow: path.join(outputDir, 'join-project-narrow.png'),
  memberDesktop: path.join(outputDir, 'member-shared-group.png'),
  member900: path.join(outputDir, 'member-shared-group-900.png'),
};
mkdirSync(outputDir, { recursive: true });

const TOKEN = 'ExampleInviteToken_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const INVALID_TOKEN = 'ExampleExpiredInviteToken_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const INVITED_EMAIL = 'invitee@example.invalid';
const LEADER_ID = 'example-leader-account';
const TEAM_ID = 'example-project-team';
const SHARED_PROJECT_ID = 'example-shared-project';
const PROXY_SESSION_ID = 'proxy_c001abcedef0123456789abcdef01234';
const children = [];
const requests = [];
const consoleErrors = [];
const pageErrors = [];
const httpFailures = [];
let serverReady = false;
let browser;
let page;
let projectId = '';
let joinedProjectId = '';
let memberTeamSessionCreated = false;
let memberGroupResultState = 'in-progress';
let localSessions = [];
let sourceBootstrap;
let latestBootstrapFixture;
let accountMode = 'signed-in';
let deliveryMode = 'sent';
let previewMode = 'valid';
let providerSetupNeeded = false;
let includeProxySession = false;
let joinedSessions = [];
let clonedProject = null;
let collaborationSnapshot;
let publishedTeamSessionIds = [];
let orchestrationEnabled = false;
let orchestrationPermission = 'supervised';
let orchestrationVersion = 3;
let sharedTeamSession = null;
let collaborationBound = false;
let hideProjectSessions = false;
let addWrongProjectSession = false;
let unsupportedAnchorSession = false;
let mixedGroupUnsupportedLead = false;
let failShareSessionOnce = false;
let rejectNextSettingsPatch = false;
let collabGate = null;
let delayCollaborationOnce = false;
let collaborationReads = 0;
let teamStructureReads = 0;
let passed = 0;
const failures = [];

function note(text) {
  process.stdout.write(`${text}\n`);
  log.write(`${text}\n`);
}

function start(command, args, { cwd = root, name } = {}) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  children.push({ child, name });
  for (const [streamName, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      log.write(`[${name}:${streamName}] ${chunk}`);
      if (name === 'local-fixture-runtime' && chunk.includes('READY ')) serverReady = true;
    });
  }
  child.on('error', (error) => log.write(`[${name}:spawn-error] ${error.stack ?? error}\n`));
  return child;
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) { lastError = error; }
    if (children.some(({ child }) => child.exitCode !== null && child.exitCode !== 0)) {
      throw new Error(`${label}: a child process exited early${lastError ? ` (${lastError.message})` : ''}`);
    }
    await delay(80);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function test(label, run) {
  try {
    await run();
    passed++;
    note(`PASS ${label}`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
    failures.push({ label, message });
    note(`FAIL ${label}: ${message}`);
  }
}

async function ensureTeammatesDialog() {
  const dialog = page.getByRole('dialog', { name: 'Teammates' });
  if (!(await dialog.count())) {
    await page.getByRole('button', { name: 'Add teammates', exact: true }).click();
    await dialog.waitFor();
  }
  return dialog;
}

function accountState(status, email = INVITED_EMAIL) {
  return {
    configured: true, connection: null, configurationSource: 'application', status,
    user: status === 'signed-in' ? { id: accountMode === 'wrong-account' ? 'example-other-account' : LEADER_ID, email, name: 'Example account' } : null,
    sessionStorage: 'memory', error: null, authorizationUrl: null, browserError: null,
  };
}

function jsonResponse(route, status, body) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function invitationPreview(email = INVITED_EMAIL) {
  return { invitationId: 'example-invitation', projectName: 'Example Mingle project', repositoryUrl: 'https://example.invalid/acme/mingle-demo.git', email, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), role: 'member', exampleFixture: true };
}

function memberTeamChatSnapshot() {
  const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
  const now = at();
  const mirroredAgentBody = 'The shared assignment is in progress.';
  return {
    project: { teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID, name: 'Example invite checkout' },
    messages: [
      { id: 'example-member-human-message', teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID, author: { kind: 'human', accountId: LEADER_ID, displayName: 'Example leader' }, body: 'Add a total to each order row.', mentions: [], source: { sessionId: 'example-host-session', messageId: 'example-group-request' }, createdAt: at(-420_000), deliveryState: 'sent', runState: 'running' },
      { id: 'example-member-agent-message', teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID, author: { kind: 'agent', agentId: 'example-host-agent', agentName: 'Example host lead', ownerAccountId: LEADER_ID, provider: 'claude', model: 'example-claude-model' }, body: mirroredAgentBody, mentions: [], replyTo: 'example-member-human-message', source: { sessionId: 'example-host-session', messageId: 'example-group-agent-response' }, createdAt: at(-240_000), deliveryState: 'sent', runState: 'completed' },
      { id: 'example-member-confirmation-message', teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID, author: { kind: 'human', accountId: LEADER_ID, displayName: 'Example leader' }, body: 'Host confirmation after the assignment progress.', mentions: [], createdAt: now, deliveryState: 'sent', runState: null },
    ],
    hasMore: false, nextBefore: null,
    members: [{ accountId: LEADER_ID, displayName: 'Example leader', role: 'leader' }, { accountId: 'example-invitee-account', displayName: 'Example invitee', role: 'member' }],
    agents: [
      { id: 'example-host-agent', name: 'Example host lead', accountId: LEADER_ID, deviceId: 'example-leader-device', projectId: joinedProjectId, sessionId: 'example-host-session', provider: 'claude', model: 'example-claude-model', state: 'working', local: false },
      ...joinedSessions.map((session, index) => ({ id: `example-invited-agent-${index + 1}`, name: session.name, accountId: 'example-invitee-account', deviceId: 'example-invitee-device', projectId: joinedProjectId, sessionId: session.id, provider: session.provider, model: session.model, state: 'idle', local: true })),
    ],
    transport: { status: 'ready', error: null, localDeviceId: 'example-invitee-device', linkedDeviceCount: 1, onlineDeviceCount: 1, peers: [] },
    groupView: memberTeamSessionCreated ? {
      version: memberGroupResultState === 'in-progress' ? 1 : 2,
      group: { id: 'example-shared-team-session', title: 'Example shared team session', mode: 'orchestrated', paused: false },
      routing: { mode: 'orchestrated', defaultRecipientHandles: ['example-host-lead'] },
      members: [
        { handle: 'example-host-lead', role: 'orchestrator', removed: false },
        { handle: 'example-invited-1', role: 'worker', removed: false },
      ],
      messages: [
        { id: 'example-group-request', seq: 1, kind: 'user', senderHandle: null, recipientHandles: ['example-host-lead'], content: 'Add a total to each order row.', requestId: 'example-group-request-id', createdAt: at(-420_000) },
        { id: 'example-group-assignment', seq: 2, kind: 'assignment', senderHandle: 'example-host-lead', recipientHandles: ['example-invited-1'], content: '', requestId: 'example-group-request-id', createdAt: at(-360_000) },
        { id: 'example-group-agent-entry', seq: 3, kind: 'agent', sourceMessageId: 'example-group-agent-response', senderHandle: 'example-host-lead', recipientHandles: [], content: mirroredAgentBody, requestId: 'example-group-request-id', createdAt: at(-240_000) },
        { id: 'example-group-progress', seq: 4, kind: 'status', senderHandle: 'example-invited-1', recipientHandles: [], content: memberGroupResultState === 'in-progress' ? mirroredAgentBody : 'The task is ready for human review.', requestId: 'example-group-request-id', createdAt: at(-120_000) },
        { id: 'example-group-member-confirmation', seq: 5, kind: 'user', sourceMessageId: 'example-member-confirmation-message', senderHandle: null, recipientHandles: ['example-host-lead'], content: 'Host confirmation after the assignment progress.', requestId: 'example-group-request-id', createdAt: at(1000) },
      ],
      requests: [{ id: 'example-group-request-id', messageId: 'example-group-request', plannerHandle: 'example-host-lead', status: memberGroupResultState === 'in-progress' ? 'active' : 'completed', turnsUsed: 2, createdAt: at(-420_000) }],
      deliveries: [{ id: 'example-group-delivery', requestId: 'example-group-request-id', messageId: 'example-group-assignment', handle: 'example-invited-1', kind: 'assignment', status: memberGroupResultState === 'in-progress' ? 'running' : 'completed', hop: 1, error: null, createdAt: at(-360_000), updatedAt: at(-120_000) }],
      assignments: [{ id: 'example-group-assignment-record', requestId: 'example-group-request-id', deliveryId: 'example-group-delivery', fromHandle: 'example-host-lead', toHandle: 'example-invited-1', taskId: 'example-group-task', title: 'Add order total', taskStatus: memberGroupResultState === 'in-progress' ? 'running' : 'review', scope: ['src/order.ts'], createdAt: at(-360_000) }],
      result: { requestId: 'example-group-request-id', status: memberGroupResultState, title: memberGroupResultState === 'in-progress' ? 'In progress' : 'Ready for review', summary: memberGroupResultState === 'in-progress' ? 'Shared group work is still running or queued; this result is partial.' : 'The shared task state is ready for human review.', facts: ['1 assigned task', memberGroupResultState === 'in-progress' ? '1 turn running' : '1 need review'], changedPaths: memberGroupResultState === 'in-progress' ? [] : ['src/order.ts'] },
      updatedAt: now,
    } : null,
    exampleFixture: true,
  };
}

function teamStructureSnapshot(id = projectId) {
  if (joinedSessions.length && id === joinedProjectId) {
    const now = new Date().toISOString();
    return {
      projectId: id, teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID, enabled: true,
      settings: { leaderOrchestration: true, permissionLevel: 'supervised', orchestratorAgentId: 'example-host-agent', fallbackAgentIds: [], version: 1, updatedAt: now, updatedByAccountId: LEADER_ID },
      host: { deviceId: 'example-leader-device', accountId: LEADER_ID, displayName: 'Example leader device', online: true, isThisDevice: false },
      canEdit: false,
      myConsent: { teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID, accountId: 'example-invitee-account', deviceId: 'example-invitee-device', agentIds: ['example-invited-agent-1'], permissionLevel: 'supervised', settingsVersion: 1, disclaimerVersion: '1', state: 'granted', acceptedAt: now, updatedAt: now },
      members: [
        { agentId: 'example-host-agent', name: 'Example host lead', handle: 'example-host-lead', ownerAccountId: LEADER_ID, ownerDisplayName: 'Example leader', deviceId: 'example-leader-device', deviceName: 'Example leader device', local: false, sessionId: null, provider: 'claude', model: 'example-claude-model', effort: 'high', role: 'orchestrator', fallbackRank: null, state: 'working', consent: 'granted', currentTask: 'Review the shared order total assignment', lastActivityAt: now, failure: null },
        ...joinedSessions.map((session, index) => ({ agentId: `example-invited-agent-${index + 1}`, name: session.name, handle: `example-invited-${index + 1}`, ownerAccountId: 'example-invitee-account', ownerDisplayName: 'Example invitee', deviceId: 'example-invitee-device', deviceName: 'Example member device', local: true, sessionId: session.id, provider: session.provider, model: session.model, effort: session.effort, role: 'worker', fallbackRank: null, state: 'idle', consent: 'granted', currentTask: null, lastActivityAt: null, failure: null })),
      ],
      leaderHistory: [], needsLeader: false,
      teamSession: memberTeamSessionCreated ? { groupId: 'example-shared-team-session', sessionId: 'example-host-anchor', title: 'Example shared team session' } : null,
      observedAt: now, exampleFixture: true,
    };
  }
  const members = publishedTeamSessionIds.flatMap((sessionId, index) => {
    const session = localSessions.find((candidate) => candidate.id === sessionId);
    if (!session) return [];
    return [{
      agentId: `example-team-agent-${index + 1}`,
      name: index === 0 ? 'Example local Codex' : `Example local agent ${index + 1}`,
      handle: `example-local-${index + 1}`,
      ownerAccountId: LEADER_ID,
      ownerDisplayName: 'Example leader',
      deviceId: 'example-leader-device',
      deviceName: 'Example leader device',
      local: true,
      sessionId,
      provider: 'codex',
      model: 'example-codex-model',
      effort: 'medium',
      role: 'worker',
      fallbackRank: null,
      state: 'idle',
      consent: 'none',
      currentTask: null,
      lastActivityAt: null,
      failure: null,
    }];
  });
  return {
    projectId: id,
    teamId: TEAM_ID,
    sharedProjectId: SHARED_PROJECT_ID,
    enabled: orchestrationEnabled,
    settings: orchestrationEnabled ? {
      leaderOrchestration: true, permissionLevel: orchestrationPermission, orchestratorAgentId: null,
      fallbackAgentIds: [], version: orchestrationVersion, updatedAt: new Date().toISOString(), updatedByAccountId: LEADER_ID,
    } : null,
    host: { deviceId: 'example-leader-device', accountId: LEADER_ID, displayName: 'Example leader device', online: true, isThisDevice: true },
    canEdit: true,
    myConsent: null,
    members,
    leaderHistory: [],
    needsLeader: false,
    teamSession: sharedTeamSession,
    observedAt: new Date().toISOString(),
    exampleFixture: true,
  };
}

function updateBootstrap() {
  const boot = structuredClone(sourceBootstrap);
  boot.projects = [...boot.projects.filter((project) => project.id !== projectId), { ...sourceBootstrap.projects.find((project) => project.id === projectId), id: projectId, name: 'Example local checkout', isExample: false }];
  if (clonedProject && !boot.projects.some((project) => project.id === clonedProject.id)) boot.projects.push(clonedProject);
  if (joinedProjectId && joinedProjectId !== projectId && !boot.projects.some((project) => project.id === joinedProjectId)) {
    boot.projects.push({ id: joinedProjectId, name: 'Example invite checkout', path: '/example/invite-checkout', createdAt: new Date().toISOString(), isExample: false });
  }
  const sampleSessions = sourceBootstrap.sessions.filter((session) => session.projectId === projectId).map((session, index) => {
    const provider = (unsupportedAnchorSession && index === 0) || (mixedGroupUnsupportedLead && index === 1) ? 'antigravity' : 'codex';
    return {
      ...session,
      name: provider === 'antigravity' ? 'Example local Antigravity' : index === 0 ? 'Example local Codex' : `Example local agent ${index + 1}`,
      provider, model: 'example-codex-model', effort: 'medium', policy: 'supervised', status: 'idle',
    };
  });
  if (hideProjectSessions) sampleSessions.length = 0;
  if (includeProxySession && sampleSessions.length) {
    sampleSessions.push({ ...sampleSessions[0], id: PROXY_SESSION_ID, name: 'Example remote Codex proxy', status: 'idle' });
    const createdAt = new Date().toISOString();
    const groupId = 'example-shared-team-session';
    boot.groups = [...(boot.groups ?? []), {
      group: { id: groupId, projectId, title: 'Example shared team session', anchorSessionId: sampleSessions[0].id, mode: 'orchestrated', orchestratorMemberId: 'example-local-member', paused: false, pauseReason: null, maxParallel: 3, maxTurns: 80, maxHops: 4, createdAt, updatedAt: createdAt },
      members: [{ id: 'example-proxy-member', groupId, sessionId: PROXY_SESSION_ID, handle: 'example-teammate', role: 'worker', joinedAt: createdAt, removedAt: null }],
      messages: [], requests: [], deliveries: [], assignments: [],
    }];
  }
  for (const joinedSession of joinedSessions) {
    if (joinedSession.projectId === projectId && !sampleSessions.some((session) => session.id === joinedSession.id)) sampleSessions.push(joinedSession);
  }
  const sessionsOutsideExample = sourceBootstrap.sessions.filter((session) => session.projectId !== projectId);
  boot.sessions = [...sessionsOutsideExample, ...sampleSessions, ...joinedSessions.filter((session) => session.projectId !== projectId)];
  if (mixedGroupUnsupportedLead && sampleSessions.length >= 2) {
    const createdAt = new Date().toISOString();
    const groupId = 'example-mixed-provider-group';
    boot.groups = [...(boot.groups ?? []).filter((group) => group.group.id !== groupId), {
      group: { id: groupId, projectId, title: 'Example mixed-provider conversation', anchorSessionId: sampleSessions[0].id, mode: 'orchestrated', orchestratorMemberId: 'example-nonanchor-lead', paused: false, pauseReason: null, maxParallel: 3, maxTurns: 80, maxHops: 4, createdAt, updatedAt: createdAt },
      members: [
        { id: 'example-anchor-member', groupId, sessionId: sampleSessions[0].id, handle: 'example-anchor', role: 'worker', joinedAt: createdAt, removedAt: null },
        { id: 'example-nonanchor-lead', groupId, sessionId: sampleSessions[1].id, handle: 'example-nonanchor-lead', role: 'orchestrator', joinedAt: createdAt, removedAt: null },
      ],
      messages: [], requests: [], deliveries: [], assignments: [],
    }];
  }
  if (addWrongProjectSession) {
    const otherProjectId = 'example-other-project';
    if (!boot.projects.some((project) => project.id === otherProjectId)) boot.projects.push({ id: otherProjectId, name: 'Example other project', path: '/example/other', createdAt: new Date().toISOString(), isExample: false });
    const other = sourceBootstrap.sessions.find((session) => session.projectId === projectId);
    if (other && !boot.sessions.some((session) => session.id === 'example-other-project-session')) boot.sessions.push({ ...other, id: 'example-other-project-session', projectId: otherProjectId, name: 'Example other project session' });
  }
  if (sharedTeamSession && sharedTeamSession.sessionId && sharedTeamSession.groupId) {
    const createdAt = new Date().toISOString();
    const groups = (boot.groups ?? []).filter((group) => group.group.id !== sharedTeamSession.groupId);
    boot.groups = [...groups, {
      group: { id: sharedTeamSession.groupId, projectId, title: sharedTeamSession.title, anchorSessionId: sharedTeamSession.sessionId, mode: 'orchestrated', orchestratorMemberId: 'example-current-agent', paused: false, pauseReason: null, maxParallel: 3, maxTurns: 80, maxHops: 4, createdAt, updatedAt: createdAt },
      members: [{ id: 'example-current-agent', groupId: sharedTeamSession.groupId, sessionId: sharedTeamSession.sessionId, handle: 'example-current', role: 'orchestrator', joinedAt: createdAt, removedAt: null }],
      messages: [], requests: [], deliveries: [], assignments: [],
    }];
  }
  if (joinedSessions.length) {
    const internal = joinedSessions.flatMap((session, index) => [
      { id: `example-team-delivery-${index + 1}`, sessionId: session.id, role: 'user', kind: 'team-delivery', content: 'Human objective: add a total to each order row. Internal group routing rules: send a status report to the coordinator, do not expose this wrapper as a human message.', createdAt: new Date().toISOString() },
      { id: `example-team-answer-${index + 1}`, sessionId: session.id, role: 'assistant', content: 'Example provider response.', createdAt: new Date().toISOString() },
    ]);
    boot.messages = [...boot.messages.filter((message) => !joinedSessions.some((session) => session.id === message.sessionId)), ...internal];
  }
  boot.providers = providerSetupNeeded ? [
    { id: 'codex', name: 'Codex', available: false, version: null, executable: null, reason: 'Example fixture: provider needs setup.', policies: [], models: [] },
    { id: 'claude', name: 'Claude Code', available: false, version: null, executable: null, reason: 'Example fixture: provider needs setup.', policies: [], models: [] },
    { id: 'opencode', name: 'OpenCode', available: false, version: null, executable: null, reason: 'Example fixture: provider needs setup.', policies: [], models: [] },
  ] : [
    { id: 'codex', name: 'Codex', available: true, version: 'Example fixture', executable: '/example/codex', reason: null, policies: ['supervised'], models: [{ id: 'example-codex-model', name: 'Example Codex model', defaultReasoningEffort: 'medium', reasoningEfforts: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }], policies: ['supervised'] }] },
    { id: 'claude', name: 'Claude Code', available: true, version: 'Example fixture', executable: '/example/claude', reason: null, policies: ['supervised'], models: [{ id: 'example-claude-model', name: 'Example Claude model', defaultReasoningEffort: 'high', reasoningEfforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], policies: ['supervised'] }] },
    { id: 'opencode', name: 'OpenCode', available: true, version: 'Example fixture', executable: '/example/opencode', reason: null, policies: ['supervised'], models: [{ id: 'example-opencode-model', name: 'Example OpenCode model', defaultReasoningEffort: 'default', reasoningEfforts: [{ id: 'default', label: 'Default' }], policies: ['supervised'] }] },
    ...sourceBootstrap.providers.filter((provider) => !['codex', 'claude', 'opencode'].includes(provider.id)),
  ];
  boot.tasks = [...sourceBootstrap.tasks.filter((task) => task.projectId !== projectId), { id: 'example-local-task', projectId, title: 'Example task to share', description: 'Example-only task', acceptanceCriteria: 'Example-only criteria', sessionId: null, dependsOn: [], status: 'ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
  return boot;
}

async function closeAll() {
  if (browser) await browser.close().catch(() => {});
  for (const { child, name } of [...children].reverse()) {
    if (child.exitCode !== null) continue;
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    log.write(`[cleanup] stopped ${name}\n`);
  }
  await new Promise((resolve) => log.end(resolve));
}

async function main() {
  const { chromium } = serverRequire('playwright');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
  if (!existsSync(executablePath)) throw new Error(`Chromium executable not found at ${executablePath}. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an existing browser; this script never installs one.`);
  const uiUrl = 'http://127.0.0.1:4451/';
  const serverUrl = 'http://127.0.0.1:4310';

  start(process.execPath, [tsxCli, serverScript, '--serve'], { name: 'local-fixture-runtime' });
  start(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', '4451', '--strictPort'], { cwd: path.join(root, 'apps/web'), name: 'vite' });
  await waitFor(() => serverReady, 'disposable FakeProviders Mingle runtime');
  await waitFor(async () => (await fetch(uiUrl, { signal: AbortSignal.timeout(500) })).ok, 'Vite UI server');

  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  page = await context.newPage();
  page.setDefaultTimeout(6000);
  await page.addInitScript(() => {
    const listeners = new Set();
    const queued = [];
    window.mingleProjectInvitations = {
      onInvitation(callback) {
        listeners.add(callback);
        while (queued.length) callback(queued.shift());
        return () => listeners.delete(callback);
      },
      emit(token) {
        if (!listeners.size) queued.push(token);
        else for (const callback of listeners) callback(token);
      },
    };
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (message.text().startsWith('Failed to load resource:')) return; // Expected signed-out 401 and opaque invalid-invitation 404 fixtures are checked below.
    consoleErrors.push(message.text());
  });
  page.on('response', (response) => { if (response.status() >= 400) httpFailures.push({ status: response.status(), pathname: new URL(response.url()).pathname }); });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    let body = {};
    try { body = request.postDataJSON() ?? {}; } catch { /* GET or empty */ }
    requests.push({ method, pathname: url.pathname, body });

    if (url.pathname === '/api/bootstrap' && method === 'GET') {
      const response = await route.fetch();
      sourceBootstrap = await response.json();
      projectId = sourceBootstrap.projects.find((project) => project.isExample)?.id ?? sourceBootstrap.projects[0]?.id;
      localSessions = sourceBootstrap.sessions.filter((session) => session.projectId === projectId);
      assert.ok(projectId, 'fixture runtime supplies its example workspace');
      assert.ok(localSessions.length, 'fixture runtime supplies sample sessions');
      latestBootstrapFixture = updateBootstrap();
      await route.fulfill({ response, body: JSON.stringify(latestBootstrapFixture) });
      return;
    }
    if (url.pathname === '/api/account') {
      const status = accountMode === 'signed-out' ? 'signed-out' : 'signed-in';
      await jsonResponse(route, 200, accountState(status, accountMode === 'wrong-account' ? 'other@example.invalid' : INVITED_EMAIL));
      return;
    }
    if (url.pathname === '/api/account/sign-in' && method === 'POST') {
      accountMode = 'signed-in';
      await jsonResponse(route, 200, accountState('signed-in'));
      return;
    }
    if (url.pathname === '/api/account/sign-out' && method === 'POST') {
      accountMode = 'signed-out';
      await jsonResponse(route, 200, accountState('signed-out'));
      return;
    }
    if (/^\/api\/projects\/[^/]+\/collaboration$/.test(url.pathname) && method === 'GET') {
      const requestedProjectId = decodeURIComponent(url.pathname.split('/')[3]);
      collaborationReads++;
      if (joinedProjectId && requestedProjectId === joinedProjectId && accountMode === 'wrong-account') { await jsonResponse(route, 403, { error: 'The current account is not a member of this example project.' }); return; }
      if (joinedProjectId && requestedProjectId !== joinedProjectId && requestedProjectId !== projectId) {
        await jsonResponse(route, 200, { project: null, members: [], agents: [], invitations: [], email: { configured: false }, exampleFixture: true });
        return;
      }
      if (delayCollaborationOnce) {
        delayCollaborationOnce = false;
        collabGate = await new Promise((resolve) => { setTimeout(() => resolve('released'), 1200); });
      }
      collaborationSnapshot ??= {
        project: { teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID, name: 'Example local checkout', repositoryUrl: 'https://example.invalid/acme/mingle-demo.git' },
        members: [
          { accountId: LEADER_ID, email: 'leader@example.invalid', displayName: 'Example leader', role: 'leader', status: 'active' },
          { accountId: 'example-teammate-account', email: INVITED_EMAIL, displayName: 'Example teammate', role: 'member', status: 'active' },
        ],
        agents: [
          { id: 'example-local-agent', accountId: LEADER_ID, deviceId: 'example-leader-device', projectId, sessionId: localSessions[0]?.id ?? null, provider: 'codex', model: 'example-codex-model', state: 'idle' },
          { id: 'example-teammate-agent', accountId: 'example-teammate-account', deviceId: 'example-teammate-device', projectId, sessionId: 'example-teammate-session', provider: 'claude', model: 'example-claude-model', state: 'running' },
        ],
        invitations: [], email: { configured: true }, exampleFixture: true,
      };
      const collaborationView = structuredClone(collaborationSnapshot);
      if (!collaborationBound) collaborationView.project = null;
      await jsonResponse(route, 200, collaborationView);
      return;
    }
    if (/^\/api\/projects\/[^/]+\/team-structure$/.test(url.pathname) && method === 'GET') {
      teamStructureReads++;
      await jsonResponse(route, 200, teamStructureSnapshot(decodeURIComponent(url.pathname.split('/')[3])));
      return;
    }
    if (/^\/api\/projects\/[^/]+\/team-orchestration\/share-session$/.test(url.pathname) && method === 'POST') {
      const requestedProjectId = decodeURIComponent(url.pathname.split('/')[3]);
      if (failShareSessionOnce) { failShareSessionOnce = false; await jsonResponse(route, 503, { error: 'Example fixture: team session setup temporarily unavailable.' }); return; }
      const requestedSession = localSessions.find((session) => session.id === body.sessionId && session.projectId === requestedProjectId);
      if (!requestedSession) { await jsonResponse(route, 400, { error: 'The selected session does not belong to this project.' }); return; }
      if (body.expectedVersion !== undefined && body.expectedVersion !== orchestrationVersion) { await jsonResponse(route, 409, { error: 'Team settings changed; refresh and try again.' }); return; }
      if (sharedTeamSession) { await jsonResponse(route, 409, { error: 'This project already has a shared session.' }); return; }
      orchestrationEnabled = true;
      orchestrationPermission = body.permissionLevel;
      orchestrationVersion++;
      sharedTeamSession = { groupId: 'example-shared-session-group', sessionId: requestedSession.id, title: requestedSession.name };
      await jsonResponse(route, 200, teamStructureSnapshot(requestedProjectId));
      return;
    }
    if (/^\/api\/projects\/[^/]+\/team-orchestration$/.test(url.pathname) && method === 'PATCH') {
      if (rejectNextSettingsPatch) {
        rejectNextSettingsPatch = false;
        orchestrationVersion++;
        await jsonResponse(route, 409, { error: 'Example fixture: the canonical group is busy.' });
        return;
      }
      if (body.expectedVersion !== orchestrationVersion) { await jsonResponse(route, 409, { error: 'Team settings changed; refresh and try again.' }); return; }
      orchestrationPermission = body.permissionLevel;
      orchestrationVersion++;
      await jsonResponse(route, 200, { ok: true, exampleFixture: true });
      return;
    }
    if (/^\/api\/projects\/[^/]+\/team-chat$/.test(url.pathname) && method === 'GET') {
      const requestedProjectId = decodeURIComponent(url.pathname.split('/')[3]);
      if (accountMode !== 'signed-in' || requestedProjectId !== joinedProjectId) {
        await jsonResponse(route, 403, { error: 'The current account or project is not authorized for this shared conversation.' });
        return;
      }
      await jsonResponse(route, 200, memberTeamChatSnapshot());
      return;
    }
    if (/^\/api\/projects\/[^/]+\/collaboration\/invitations$/.test(url.pathname) && method === 'POST') {
      const id = `example-invitation-${collaborationSnapshot.invitations.length + 1}`;
      collaborationBound = true;
      const status = deliveryMode;
      const invitation = { id, email: body.email, role: body.role ?? 'member', status: 'pending', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };
      collaborationSnapshot.invitations.unshift(invitation);
      await jsonResponse(route, 200, { invitation, ...(status !== 'sent' ? { joinUrl: `https://example.invalid/project-invitations/open#token=${TOKEN}` } : {}), delivery: { status, message: status === 'sent' ? 'Example fixture email accepted.' : `Example fixture delivery state: ${status}.` }, exampleFixture: true });
      return;
    }
    if (url.pathname === '/api/project-invitations/preview' && method === 'POST') {
      if (accountMode === 'signed-out') { await jsonResponse(route, 401, { error: 'Google sign-in is required.' }); return; }
      if (previewMode !== 'valid' || accountMode === 'wrong-account') {
        await jsonResponse(route, 404, { error: 'The invitation is invalid, expired, revoked, or belongs to another account. Ask a project leader to resend an expired invitation.' });
        return;
      }
      await jsonResponse(route, 200, invitationPreview());
      return;
    }
    if (url.pathname === '/api/project-invitations/join' && method === 'POST') {
      const agents = body.agents ?? (body.agent ? [body.agent] : []);
      joinedProjectId = body.localProjectId;
      memberTeamSessionCreated = false;
      memberGroupResultState = 'in-progress';
      joinedSessions = agents.map((agent, index) => ({
        ...(localSessions[index] ?? localSessions[0] ?? {}), id: `example-invitation-agent-${index + 1}`, projectId: body.localProjectId,
        name: `Example invited agent ${index + 1}`, provider: agent.provider, model: agent.model, effort: agent.effort,
        policy: agent.policy, status: 'idle', error: null,
      }));
      await jsonResponse(route, 200, { projectId: body.localProjectId, sessionId: joinedSessions[0]?.id, sessionIds: joinedSessions.map((session) => session.id), teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID, alreadyJoined: false, exampleFixture: true });
      return;
    }
    if (url.pathname === '/api/directories' && method === 'GET') {
      await jsonResponse(route, 200, { path: String(url.searchParams.get('path') ?? '/example/projects'), displayPath: String(url.searchParams.get('path') ?? '/example/projects'), parentPath: '/example', homePath: '/example', separator: '/', platform: 'linux', directories: [], roots: [], canSelect: true, canCreateWithin: true, truncated: false });
      return;
    }
    if (url.pathname === '/api/projects/clone' && method === 'POST') {
      clonedProject = { id: 'example-cloned-project', name: body.name, path: `${body.parentPath}/${body.name}`, createdAt: new Date().toISOString(), isExample: false };
      await jsonResponse(route, 200, clonedProject);
      return;
    }
    if (url.pathname === '/api/projects' && method === 'POST') {
      const project = { id: 'example-selected-folder', name: body.name, path: body.path, createdAt: new Date().toISOString(), isExample: false };
      await jsonResponse(route, 200, project);
      return;
    }
    if (/^\/api\/projects\/[^/]+\/repository$/.test(url.pathname) && method === 'GET') {
      await jsonResponse(route, 200, { projectId: decodeURIComponent(url.pathname.split('/')[3]), sessionId: url.searchParams.get('sessionId'), root: '/example/local-checkout', isRepo: true, branch: 'main', head: 'a'.repeat(40), detached: false, branches: [{ name: 'main', current: true }], remotes: [], upstream: null, ahead: null, behind: null, changes: [], fetchedAt: new Date().toISOString(), fingerprint: 'example-fingerprint', notices: [] });
      return;
    }
    if (/^\/api\/projects\/[^/]+\/github$/.test(url.pathname) && method === 'GET') {
      await jsonResponse(route, 200, { status: 'unsupported', repository: null, url: null, branch: null, head: null, pullRequest: null, checks: [], workflows: [], fetchedAt: new Date().toISOString(), notices: ['Example fixture: no GitHub connection.'] });
      return;
    }
    if (/^\/api\/sessions\/[^/]+\/catalog$/.test(url.pathname) && method === 'GET') {
      await jsonResponse(route, 200, { commands: [], skills: [], warnings: [] });
      return;
    }
    if (url.pathname === '/api/distributed/agents/publish' && method === 'POST') {
      publishedTeamSessionIds = Array.isArray(body.sessionIds) ? body.sessionIds.filter((id) => localSessions.some((session) => session.id === id)) : [];
      if (collaborationSnapshot) {
        const teammateAgents = collaborationSnapshot.agents.filter((agent) => agent.accountId !== LEADER_ID);
        const localAgentViews = publishedTeamSessionIds.flatMap((sessionId, index) => {
          const session = localSessions.find((candidate) => candidate.id === sessionId);
          if (!session) return [];
          return [{ id: `example-local-agent-${index + 1}`, accountId: LEADER_ID, deviceId: 'example-leader-device', projectId, sessionId, provider: 'codex', model: 'example-codex-model', state: 'idle' }];
        });
        collaborationSnapshot.agents = [...localAgentViews, ...teammateAgents];
      }
      await jsonResponse(route, 200, { ok: true, exampleFixture: true }); return;
    }
    if (url.pathname === '/api/distributed/members/revoke' && method === 'POST') { await jsonResponse(route, 200, { ok: true, exampleFixture: true }); return; }
    if (url.pathname === '/api/distributed/messages' && method === 'POST') { await jsonResponse(route, 200, { ok: true, exampleFixture: true }); return; }
    if (url.pathname === '/api/distributed/tasks/publish' && method === 'POST') { await jsonResponse(route, 200, { ok: true, exampleFixture: true }); return; }
    if (/^\/api\/distributed\/groups\/[^/]+$/.test(url.pathname) && method === 'GET') {
      await jsonResponse(route, 200, { agents: [], messages: [], tasks: [], requests: [], exampleFixture: true });
      return;
    }
    if (method === 'GET') { await jsonResponse(route, 200, []); return; }
    await jsonResponse(route, 200, { ok: true, exampleFixture: true });
  });

  await page.goto(uiUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Add teammates', exact: true }).waitFor();

  await test('project-first Add teammates sits beside Add agent and sends a real email invitation request', async () => {
    const teammates = page.getByRole('button', { name: 'Add teammates', exact: true });
    const addAgent = page.getByRole('button', { name: 'Add agent', exact: true });
    assert.equal(await teammates.isEnabled(), true);
    const pair = await Promise.all([teammates.boundingBox(), addAgent.boundingBox()]);
    assert.ok(pair[0] && pair[1] && pair[1].x > pair[0].x, 'the teammate action appears beside Add agent');
    const firstSession = page.locator('.sitem').first();
    if (await firstSession.count()) await firstSession.click();
    const initialComposer = page.locator('.composer__input').first();
    await initialComposer.waitFor({ state: 'visible' });
    await initialComposer.fill('Example unsent local draft stays in place');
    await teammates.click();
    await page.getByRole('dialog', { name: 'Teammates' }).waitFor();
    await page.getByLabel('Teammate email', { exact: true }).fill('new-person@example.invalid');
    const selectedSessionId = await page.evaluate((id) => JSON.parse(localStorage.getItem('relay.ui.v2') ?? '{}').sessionByProject?.[id], projectId);
    assert.equal(await page.locator('.team-orch-settings').count(), 0, 'a new project has no team settings panel before its invitation creates a binding');
    await page.locator('.pc-field--role select').selectOption('admin');
    await page.getByRole('button', { name: 'Send invite', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /Invitation email sent to new-person@example.invalid/ }).waitFor();
    await page.getByRole('status').filter({ hasText: /now shared with the team/ }).waitFor();
    const post = requests.findLast((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/collaboration/invitations`);
    assert.deepEqual(post?.body, { email: 'new-person@example.invalid', role: 'admin' });
    const automaticShare = requests.findLast((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`);
    assert.deepEqual(automaticShare?.body, { sessionId: selectedSessionId, permissionLevel: 'supervised' }, 'successful invite setup attaches the frozen active session without asking for a session choice');
    assert.equal(requests.some((item) => item.method === 'POST' && item.pathname === '/api/sessions'), false, 'inviting does not create a provider session');
    await page.screenshot({ path: screenshots.invite, fullPage: true });
    await page.evaluate((token) => window.mingleProjectInvitations.emit(token), TOKEN);
    const joinDialog = page.getByRole('dialog', { name: 'Join Example Mingle project?' });
    await joinDialog.getByText('Example Mingle project', { exact: true }).waitFor();
    assert.equal(await initialComposer.inputValue(), 'Example unsent local draft stays in place', 'warm invite overlay preserves the active composer draft');
    await joinDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    assert.equal(await initialComposer.inputValue(), 'Example unsent local draft stays in place');
  });

  await test('failed and not-configured email delivery remain distinct; only unsent response offers a join-link fallback', async () => {
    await ensureTeammatesDialog();
    deliveryMode = 'failed';
    await page.getByLabel('Teammate email', { exact: true }).fill('failed@example.invalid');
    await page.getByRole('button', { name: 'Send invite', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /email delivery failed for failed@example.invalid/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Copy join link', exact: true }).count(), 1, 'an undelivered failed send exposes only the backend-supplied fallback link');
    await page.getByRole('button', { name: 'Copy join link', exact: true }).click();
    deliveryMode = 'not_configured';
    await page.getByLabel('Teammate email', { exact: true }).fill('offline@example.invalid');
    await page.getByRole('button', { name: 'Send invite', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /no email was sent to offline@example.invalid/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Copy join link', exact: true }).count(), 1, 'the backend-supplied unsent link is exposed as an explicit copy action');
    await page.getByRole('button', { name: 'Copy join link', exact: true }).click();
    await page.locator('.toast').filter({ hasText: 'Join link copied.' }).waitFor();
  });

  await test('onboarding shares the active session directly and the roster stays separate from session/orchestrator controls', async () => {
    includeProxySession = true;
    publishedTeamSessionIds = [];
    orchestrationEnabled = false;
    orchestrationPermission = 'supervised';
    orchestrationVersion = 3;
    sharedTeamSession = null;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add teammates', exact: true }).waitFor();
    await page.locator('.sitem').filter({ hasText: 'Example local agent 2' }).click();
    const dialog = await ensureTeammatesDialog();
    await dialog.getByRole('button', { name: 'Share current session', exact: true }).waitFor();
    assert.ok(requests.some((item) => item.method === 'GET' && item.pathname === `/api/projects/${projectId}/team-structure`), 'the settings panel receives a typed team-structure fixture rather than the generic array fallback');
    assert.equal(await dialog.getByRole('alert').count(), 0, 'the team settings panel renders without a malformed-snapshot error');
    const onboarding = dialog.locator('.team-orch-settings');
    await onboarding.getByText('Example local agent 2', { exact: true }).waitFor();
    assert.equal(await onboarding.locator('select').count(), 0, 'onboarding offers no session, orchestrator, or fallback picker');
    assert.equal(await onboarding.getByRole('switch').count(), 0, 'onboarding offers no leader-orchestration switch');
    assert.equal(await onboarding.getByRole('button', { name: /fallback|leader/i }).count(), 0, 'onboarding exposes no fallback or leader-selection action');
    assert.equal(await dialog.locator('.pc-agent-row').filter({ hasText: 'Example remote Codex proxy' }).count(), 0, 'a proxy session recorded in group membership is not shown as a local project agent');
    assert.equal(await dialog.getByRole('checkbox', { name: /Share Example remote Codex proxy with this project/ }).count(), 0, 'a remote proxy cannot be selected for republication');
    await dialog.locator('.pc-agent-row').filter({ hasText: 'Example local Codex' }).waitFor();
    await waitFor(async () => await dialog.locator('.pc-agent-row').filter({ hasText: 'Example local Codex' }).count() === 1, 'leader-owned session de-duplication');
    assert.equal(await dialog.locator('.pc-agent-row').filter({ hasText: 'Example local Codex' }).count(), 1, 'the leader-owned published session appears once in the local section, not again as a remote agent');
    const teammate = dialog.locator('.pc-agent-row--remote').filter({ hasText: 'Example teammate' });
    await teammate.getByRole('button').click();
    await dialog.getByRole('button', { name: 'Open recovery controls' }).waitFor();
    assert.match(await teammate.innerText(), /claude.*example-claude-model.*example-teammate-device/i);
    const activeSessionId = await page.evaluate((id) => JSON.parse(localStorage.getItem('relay.ui.v2') ?? '{}').sessionByProject?.[id], projectId);
    const shareCallsBefore = requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`).length;
    await onboarding.getByRole('button', { name: 'Share current session', exact: true }).click();
    await waitFor(() => requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`).length === shareCallsBefore + 1, 'active session share request');
    const sessionShare = requests.findLast((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`);
    assert.deepEqual(sessionShare?.body, { sessionId: activeSessionId, permissionLevel: 'supervised' }, 'empty roster still shares the current session and uses its agent as the automatic lead');
    await dialog.locator('.team-orch-settings__session').getByText('already shared', { exact: false }).waitFor();
    const check = dialog.getByRole('checkbox', { name: /Share Example local agent 2 with this project/ }).first();
    await check.check();
    const structureReadsBeforePublish = teamStructureReads;
    await dialog.getByRole('button', { name: 'Update shared agents' }).click();
    const publish = requests.findLast((item) => item.method === 'POST' && item.pathname === '/api/distributed/agents/publish');
    assert.ok(Array.isArray(publish?.body.sessionIds));
    assert.equal(publish.body.sessionIds.includes(PROXY_SESSION_ID), false, 'the publish API never receives the remote proxy session ID');
    await waitFor(async () => teamStructureReads > structureReadsBeforePublish
      && await dialog.locator('.team-orch-settings__session').filter({ hasText: 'Example local agent 2' }).count() > 0, 'team orchestration settings refresh after the roster changes');
    assert.ok(teamStructureReads > structureReadsBeforePublish, 'team orchestration settings refetch after the roster changes');
    await dialog.getByLabel('Share a project note').fill('Example team note');
    await dialog.getByRole('button', { name: 'Share note', exact: true }).click();
    assert.ok(requests.some((item) => item.pathname === '/api/distributed/messages' && item.body.content === 'Example team note'));
    await dialog.getByLabel('Task to share').selectOption('example-local-task');
    await dialog.getByRole('button', { name: 'Share task', exact: true }).click();
    assert.ok(requests.some((item) => item.pathname === '/api/distributed/tasks/publish' && item.body.taskId === 'example-local-task'));
    await dialog.locator('.pc-members').locator('summary').click();
    const member = dialog.locator('.pc-members > div > p').filter({ hasText: INVITED_EMAIL });
    let confirmation = '';
    page.once('dialog', async (nativeDialog) => { confirmation = nativeDialog.message(); await nativeDialog.accept(); });
    await member.getByRole('button', { name: 'Remove', exact: true }).click();
    assert.match(confirmation, /Remove .* from this project team/);
    assert.ok(requests.some((item) => item.method === 'POST' && item.pathname === '/api/distributed/members/revoke' && item.body.userId === 'example-teammate-account'));
    await dialog.getByRole('button', { name: 'Open recovery controls' }).click();
    const teamSections = page.getByRole('navigation', { name: 'Team workspace sections' });
    await teamSections.getByRole('button', { name: 'Recovery', exact: true }).waitFor();
    assert.equal(await teamSections.getByRole('button', { name: 'Recovery', exact: true }).getAttribute('aria-current'), 'page', 'remote-agent inspection opens the existing qualified-recovery section');
    await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Add teammates', exact: true }).waitFor();
    includeProxySession = false;
    publishedTeamSessionIds = [];
  });

  await test('legacy enabled project keeps full access on invite, reports setup failure truthfully, and retries sharing without resending', async () => {
    orchestrationEnabled = true;
    orchestrationPermission = 'full-access';
    orchestrationVersion = 15;
    deliveryMode = 'sent';
    sharedTeamSession = null;
    hideProjectSessions = false;
    addWrongProjectSession = false;
    failShareSessionOnce = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add teammates', exact: true }).waitFor();
    await page.locator('.sitem').filter({ hasText: 'Example local agent 2' }).click();
    const dialog = await ensureTeammatesDialog();
    const onboarding = dialog.locator('.team-orch-settings');
    await onboarding.getByRole('alert').filter({ hasText: /Full access requires every teammate/ }).waitFor();
    const selectedSessionId = await page.evaluate((id) => JSON.parse(localStorage.getItem('relay.ui.v2') ?? '{}').sessionByProject?.[id], projectId);
    const invitationsBefore = requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/collaboration/invitations`).length;
    const shareCallsBefore = requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`).length;
    await dialog.getByLabel('Teammate email', { exact: true }).fill('setup-retry@example.invalid');
    await dialog.getByRole('button', { name: 'Send invite', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: /Invitation email sent to setup-retry@example.invalid/ }).filter({ hasText: /could not be completed/ }).waitFor();
    const automaticShare = requests.findLast((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`);
    assert.deepEqual(automaticShare?.body, { sessionId: selectedSessionId, permissionLevel: 'full-access', expectedVersion: 15 }, 'legacy enabled/no-group setup preserves its existing permission and optimistic version');
    assert.equal(await dialog.getByRole('button', { name: 'Share current session', exact: true }).isEnabled(), true, 'the panel offers share-only recovery after setup fails');
    await dialog.getByRole('button', { name: 'Share current session', exact: true }).click();
    await waitFor(() => requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`).length === shareCallsBefore + 2, 'share-only retry');
    const retry = requests.findLast((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`);
    assert.deepEqual(retry?.body, { sessionId: selectedSessionId, permissionLevel: 'full-access', expectedVersion: 15 });
    assert.equal(requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/collaboration/invitations`).length, invitationsBefore + 1, 'retrying setup never resends the invitation email');
    orchestrationEnabled = false;
    orchestrationPermission = 'supervised';
    orchestrationVersion = 3;
    sharedTeamSession = null;
  });

  await test('an established shared session takes precedence and is never rebound by an invitation', async () => {
    orchestrationEnabled = true;
    orchestrationPermission = 'supervised';
    orchestrationVersion = 28;
    sharedTeamSession = { groupId: 'example-established-group', sessionId: localSessions[0].id, title: 'Example established shared session' };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add teammates', exact: true }).waitFor();
    await page.locator('.sitem').filter({ hasText: 'Example local agent 2' }).click();
    const dialog = await ensureTeammatesDialog();
    const summary = dialog.locator('.team-orch-settings__session');
    await summary.getByText('Example local Codex', { exact: true }).waitFor();
    await summary.getByText('already shared', { exact: false }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Share current session', exact: true }).count(), 0, 'a bound canonical session has no rebind action');
    const shareCount = requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`).length;
    await dialog.getByLabel('Teammate email', { exact: true }).fill('existing-session@example.invalid');
    await dialog.getByRole('button', { name: 'Send invite', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: /existing shared session.*remains in use/ }).waitFor();
    assert.equal(requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`).length, shareCount, 'invitation setup leaves the established shared group attached');
    assert.equal((await summary.innerText()).includes('Example local agent 2'), false, 'a changed active session cannot replace the canonical shared session');
  });

  await test('permission edits use only the versioned permission patch and preserve advanced leader settings', async () => {
    orchestrationEnabled = true;
    orchestrationPermission = 'supervised';
    orchestrationVersion = 41;
    sharedTeamSession = { groupId: 'example-permission-group', sessionId: localSessions[0].id, title: 'Example permission group' };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add teammates', exact: true }).waitFor();
    const dialog = await ensureTeammatesDialog();
    const onboarding = dialog.locator('.team-orch-settings');
    const shareCallsBefore = requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`).length;
    await onboarding.getByRole('radio', { name: 'Full access', exact: true }).click();
    await onboarding.getByRole('button', { name: 'Save permission level', exact: true }).click();
    await onboarding.getByRole('status').filter({ hasText: 'Team permission level saved.' }).waitFor();
    const update = requests.findLast((item) => item.method === 'PATCH' && item.pathname === `/api/projects/${projectId}/team-orchestration`);
    assert.deepEqual(update?.body, { permissionLevel: 'full-access', expectedVersion: 41 }, 'permission-only save does not reset leader orchestration, orchestrator, or fallback settings');
    assert.equal(requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`).length, shareCallsBefore, 'permission editing does not call the binding endpoint');
    sharedTeamSession = null;
    orchestrationEnabled = false;
    orchestrationPermission = 'supervised';
    orchestrationVersion = 3;
  });

  await test('permission conflicts preserve the backend reason and refresh guidance', async () => {
    orchestrationEnabled = true;
    orchestrationPermission = 'supervised';
    orchestrationVersion = 52;
    sharedTeamSession = { groupId: 'example-conflict-group', sessionId: localSessions[0].id, title: 'Example conflict group' };
    rejectNextSettingsPatch = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add teammates', exact: true }).waitFor();
    const dialog = await ensureTeammatesDialog();
    const onboarding = dialog.locator('.team-orch-settings');
    await onboarding.getByRole('radio', { name: 'Full access', exact: true }).click();
    await onboarding.getByRole('button', { name: 'Save permission level', exact: true }).click();
    const error = onboarding.getByRole('alert').filter({ hasText: /canonical group is busy/ });
    await error.waitFor();
    assert.match(await error.innerText(), /Refresh team settings and try again after resolving the issue/);
    assert.doesNotMatch(await error.innerText(), /permissions changed elsewhere/i, 'a non-version conflict is not mislabeled as a permission edit');
    sharedTeamSession = null;
    orchestrationEnabled = false;
    orchestrationPermission = 'supervised';
    orchestrationVersion = 3;
  });

  await test('missing local session never borrows another project session', async () => {
    hideProjectSessions = true;
    addWrongProjectSession = true;
    sharedTeamSession = null;
    orchestrationEnabled = false;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add teammates', exact: true }).waitFor();
    const persistedSelection = await page.evaluate((id) => JSON.parse(localStorage.getItem('relay.ui.v2') ?? '{}').sessionByProject?.[id], projectId);
    assert.equal(persistedSelection, undefined, 'the selected project has no local-session selection');
    assert.ok(latestBootstrapFixture.sessions.some((session) => session.projectId !== projectId), 'bootstrap still contains another project’s session');
    const dialog = await ensureTeammatesDialog();
    const onboarding = dialog.locator('.team-orch-settings');
    await onboarding.getByText(/No local session is open for this project/).waitFor();
    await onboarding.getByRole('button', { name: 'Open this project', exact: true }).waitFor();
    assert.equal(await onboarding.getByRole('button', { name: 'Share current session', exact: true }).isDisabled(), true, 'sharing stays disabled without a session from this project');
    assert.equal(await onboarding.locator('.team-orch-settings__session').count(), 0, 'a session from another project is never auto-selected');
    hideProjectSessions = false;
    addWrongProjectSession = false;
  });

  await test('unsupported Antigravity anchor stays disabled and invite setup explains provider requirements', async () => {
    unsupportedAnchorSession = true;
    mixedGroupUnsupportedLead = false;
    orchestrationEnabled = false;
    sharedTeamSession = null;
    deliveryMode = 'sent';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add teammates', exact: true }).waitFor();
    await page.locator('.sitem').filter({ hasText: 'Example local Antigravity' }).click();
    const dialog = await ensureTeammatesDialog();
    const onboarding = dialog.locator('.team-orch-settings');
    await onboarding.getByRole('status').filter({ hasText: /Team sharing supports Codex, Claude Code, and OpenCode/ }).waitFor();
    assert.equal(await onboarding.getByRole('button', { name: 'Share current session', exact: true }).isDisabled(), true, 'unsupported standalone providers cannot be manually shared');
    const shareCount = requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`).length;
    await dialog.getByLabel('Teammate email', { exact: true }).fill('antigravity-invite@example.invalid');
    await dialog.getByRole('button', { name: 'Send invite', exact: true }).click();
    const deliveryNotice = dialog.getByRole('status').filter({ hasText: /antigravity-invite@example.invalid/ }).filter({ hasText: /Team sharing supports Codex, Claude Code, and OpenCode/ });
    await deliveryNotice.waitFor();
    assert.match(await deliveryNotice.innerText(), /no session was shared/i);
    assert.equal(requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`).length, shareCount, 'invite-time auto-share skips an unsupported provider without calling the binding API');
  });
  unsupportedAnchorSession = false;

  await test('mixed-provider group is blocked when its non-anchor orchestrator is Antigravity', async () => {
    mixedGroupUnsupportedLead = true;
    unsupportedAnchorSession = false;
    orchestrationEnabled = false;
    sharedTeamSession = null;
    deliveryMode = 'sent';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add teammates', exact: true }).waitFor();
    await page.locator('.sitem').filter({ hasText: 'Example local Codex' }).click();
    const dialog = await ensureTeammatesDialog();
    const onboarding = dialog.locator('.team-orch-settings');
    await onboarding.getByRole('status').filter({ hasText: /Example local Antigravity \(antigravity\)/ }).waitFor();
    assert.equal(await onboarding.getByRole('button', { name: 'Share current session', exact: true }).isDisabled(), true, 'the selected Codex anchor cannot bypass its unsupported group lead');
    const shareCallsBefore = requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`).length;
    await dialog.getByLabel('Teammate email', { exact: true }).fill('mixed-provider-invite@example.invalid');
    await dialog.getByRole('button', { name: 'Send invite', exact: true }).click();
    const deliveryNotice = dialog.getByRole('status').filter({ hasText: /mixed-provider-invite@example.invalid/ }).filter({ hasText: /Example local Antigravity \(antigravity\)/ });
    await deliveryNotice.waitFor();
    assert.match(await deliveryNotice.innerText(), /no session was shared/i);
    assert.equal(requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`).length, shareCallsBefore, 'invite setup does not partially share a mixed-provider group');
  });
  mixedGroupUnsupportedLead = false;

  await test('canonical Antigravity conversation retains permission-only editing', async () => {
    unsupportedAnchorSession = true;
    orchestrationEnabled = true;
    orchestrationPermission = 'supervised';
    orchestrationVersion = 64;
    sharedTeamSession = { groupId: 'example-antigravity-canonical', sessionId: localSessions[0].id, title: 'Example Antigravity conversation' };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add teammates', exact: true }).waitFor();
    await page.locator('.sitem').filter({ hasText: 'Example local Antigravity' }).click();
    const dialog = await ensureTeammatesDialog();
    const onboarding = dialog.locator('.team-orch-settings');
    await onboarding.getByText('already shared', { exact: false }).waitFor();
    assert.equal(await onboarding.getByRole('button', { name: 'Share current session', exact: true }).count(), 0);
    assert.equal(await onboarding.getByRole('button', { name: 'Save permission level', exact: true }).isEnabled(), true, 'an established canonical conversation remains permission-editable despite its provider');
    const shareCallsBefore = requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`).length;
    await onboarding.getByRole('radio', { name: 'Full access', exact: true }).click();
    await onboarding.getByRole('button', { name: 'Save permission level', exact: true }).click();
    await onboarding.getByRole('status').filter({ hasText: 'Team permission level saved.' }).waitFor();
    const patch = requests.findLast((item) => item.method === 'PATCH' && item.pathname === `/api/projects/${projectId}/team-orchestration`);
    assert.deepEqual(patch?.body, { permissionLevel: 'full-access', expectedVersion: 64 });
    assert.equal(requests.filter((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/team-orchestration/share-session`).length, shareCallsBefore, 'canonical permission save never attempts a provider publication');
  });
  unsupportedAnchorSession = false;
  orchestrationEnabled = false;
  orchestrationPermission = 'supervised';
  orchestrationVersion = 3;
  sharedTeamSession = null;

  await test('cold ?join link clears from address/history and resumes after in-place sign-in', async () => {
    accountMode = 'signed-out';
    previewMode = 'valid';
    await page.goto(`${uiUrl}?join=${TOKEN}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('dialog', { name: 'Join project' }).waitFor();
    await waitFor(() => !new URL(page.url()).searchParams.has('join'), 'invite token to be removed from the browser address');
    await page.getByRole('heading', { name: 'Sign in to join this project' }).waitFor();
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await page.getByText('Example Mingle project', { exact: true }).waitFor();
    const invitation = page.getByRole('dialog', { name: 'Join Example Mingle project?' });
    await invitation.getByRole('button', { name: 'Join project', exact: true }).click();
    const workspace = page.getByRole('dialog', { name: 'Where should we put the code?' });
    await workspace.getByRole('button', { name: 'I already have a checkout', exact: true }).click();
    await workspace.getByRole('radio', { name: /Example local checkout/ }).click();
    await workspace.getByRole('button', { name: 'Use this checkout', exact: true }).click();
    const agents = page.getByRole('dialog', { name: 'Add your agents' });
    await agents.getByRole('heading', { name: 'Choose one or more local agents' }).waitFor();
    const providerForm = agents.locator('.pc-agent-config select');
    assert.equal(await providerForm.nth(0).inputValue(), 'codex');
    assert.equal(await providerForm.nth(1).inputValue(), 'example-codex-model');
    assert.equal(await providerForm.nth(2).inputValue(), 'medium');
    assert.equal(await providerForm.nth(3).inputValue(), 'supervised');
    const beforeJoin = requests.filter((item) => item.method === 'POST' && item.pathname === '/api/project-invitations/join').length;
    assert.equal(requests.some((item) => item.method === 'POST' && item.pathname === '/api/sessions'), false, 'setup has not pre-created a session');
    await page.screenshot({ path: screenshots.join, fullPage: true });
    await agents.getByRole('button', { name: 'Join project', exact: true }).click();
    const joinFlow = page.locator('.pc-join');
    await joinFlow.getByText('Please review before agreeing').waitFor();
    assert.equal(await joinFlow.locator('.team-consent__agent').filter({ hasText: 'Example invited agent 1' }).locator('input[type=checkbox]').isChecked(), true, 'the newly configured local agent is selected for explicit review before sharing');
    await joinFlow.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await page.getByRole('heading', { name: 'You’re in' }).waitFor();
    const joins = requests.filter((item) => item.method === 'POST' && item.pathname === '/api/project-invitations/join');
    assert.equal(joins.length, beforeJoin + 1, 'only the explicit Join project action accepts the invite');
    assert.deepEqual(joins.at(-1)?.body, { token: TOKEN, localProjectId: projectId, agents: [{ provider: 'codex', model: 'example-codex-model', effort: 'medium', policy: 'supervised' }] });
    assert.equal(requests.some((item) => item.method === 'POST' && /\/api\/sessions\/?$/.test(item.pathname)), false, 'the join endpoint is the sole initial-session creation path');
    assert.equal(requests.some((item) => item.method === 'POST' && item.pathname.endsWith('/team-consent')), false, 'skipping consent leaves the configured agent private');
    await page.getByRole('dialog', { name: 'Project joined' }).getByText('remain private', { exact: false }).waitFor();
    await page.getByRole('dialog', { name: 'Project joined' }).getByRole('button', { name: 'Open project', exact: true }).click();
  });

  await test('generic unavailable response stays neutral and switching accounts resumes the pending invitation', async () => {
    accountMode = 'wrong-account';
    previewMode = 'invalid';
    const joinsBeforeSwitch = requests.filter((item) => item.method === 'POST' && item.pathname === '/api/project-invitations/join').length;
    await page.evaluate((token) => window.mingleProjectInvitations.emit(token), INVALID_TOKEN);
    await page.getByRole('heading', { name: 'Invitation unavailable' }).waitFor();
    const joinDialog = page.getByRole('dialog', { name: 'Join project' });
    const text = await joinDialog.innerText();
    assert.match(text, /other@example.invalid/);
    assert.match(text, /check which Google account received it, switch accounts, or ask the project owner/i);
    assert.doesNotMatch(text, /This invitation (?:was revoked|has expired)/i, 'the generic 404 does not claim a particular invitation state');
    assert.doesNotMatch(text, /Example Mingle project/);
    assert.equal(requests.some((item) => item.method === 'POST' && item.pathname === '/api/project-invitations/preview' && item.body.token === INVALID_TOKEN), true);
    await joinDialog.getByRole('button', { name: 'Switch account' }).click();
    await joinDialog.getByRole('heading', { name: 'Sign in to join this project' }).waitFor();
    previewMode = 'valid';
    await joinDialog.getByRole('button', { name: 'Continue with Google' }).click();
    await page.getByRole('dialog', { name: 'Join Example Mingle project?' }).getByText('Example Mingle project', { exact: true }).waitFor();
    assert.equal(requests.filter((item) => item.method === 'POST' && item.pathname === '/api/project-invitations/join').length, joinsBeforeSwitch, 'switching accounts preserves the invitation without accepting it');
  });

  await test('warm desktop invitation opens as an overlay and requires an explicit clone destination', async () => {
    accountMode = 'signed-in';
    previewMode = 'valid';
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    const sessionRow = page.locator('.sitem').first();
    if (await sessionRow.count()) await sessionRow.click();
    await page.evaluate((token) => window.mingleProjectInvitations.emit(token), TOKEN);
    const invitation = page.getByRole('dialog', { name: 'Join Example Mingle project?' });
    await invitation.getByRole('button', { name: 'Join project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Where should we put the code?' });
    await dialog.getByText('https://example.invalid/acme/mingle-demo.git', { exact: true }).waitFor();
    assert.equal(await page.locator('.header').isVisible(), true, 'the workspace remains mounted behind the join overlay');
    assert.equal(new URL(page.url()).searchParams.has('join'), false);
    await dialog.getByRole('button', { name: 'Clone repository', exact: true }).click();
    await dialog.getByLabel('Repository destination parent folder').fill('/example/checkouts');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: screenshots.narrow, fullPage: true });
    const geometry = await dialog.evaluate((element) => ({
      viewport: window.innerWidth, documentWidth: document.documentElement.scrollWidth,
      modalWidth: element.getBoundingClientRect().width, modalRight: element.getBoundingClientRect().right,
    }));
    assert.ok(geometry.documentWidth <= geometry.viewport, `narrow invite layout does not overflow: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.modalRight <= geometry.viewport + 1, `dialog remains in the narrow viewport: ${JSON.stringify(geometry)}`);
    assert.equal(requests.some((item) => item.method === 'POST' && item.pathname === '/api/projects/clone'), false, 'opening an invitation never clones by itself');
    await dialog.getByRole('button', { name: 'Clone and continue', exact: true }).click();
    await waitFor(() => requests.some((item) => item.method === 'POST' && item.pathname === '/api/projects/clone'), 'explicit clone request');
    assert.deepEqual(requests.findLast((item) => item.method === 'POST' && item.pathname === '/api/projects/clone')?.body, { url: 'https://example.invalid/acme/mingle-demo.git', name: 'mingle-demo', parentPath: '/example/checkouts' });
    const agents = page.getByRole('dialog', { name: 'Add your agents' });
    await agents.getByRole('button', { name: 'Join project', exact: true }).click();
    const joinFlow = page.locator('.pc-join');
    await joinFlow.getByText('Please review before agreeing').waitFor();
    await joinFlow.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await page.getByRole('heading', { name: 'You’re in' }).waitFor();
    await page.getByRole('dialog', { name: 'Project joined' }).getByRole('button', { name: 'Open project', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(pageErrors.length, 0, `no uncaught browser errors: ${pageErrors.join('; ')}`);
    assert.equal(consoleErrors.length, 0, `no browser console errors: ${consoleErrors.join('; ')}`);
    const teamOrchestrationPath = `/api/projects/${projectId}/team-orchestration`;
    assert.ok(httpFailures.every((failure) => ([401, 404].includes(failure.status) && failure.pathname === '/api/project-invitations/preview')
      || (failure.status === 503 && failure.pathname === `${teamOrchestrationPath}/share-session`)
      || (failure.status === 409 && failure.pathname === teamOrchestrationPath)), `only expected invitation and team-setup fixture responses are observed: ${JSON.stringify(httpFailures)}`);
  });

  await test('provider setup-required state opens settings and resumes the same pending invitation', async () => {
    providerSetupNeeded = true;
    accountMode = 'signed-in';
    previewMode = 'valid';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add teammates', exact: true }).waitFor();
    const joinsBefore = requests.filter((item) => item.method === 'POST' && item.pathname === '/api/project-invitations/join').length;
    await page.evaluate((token) => window.mingleProjectInvitations.emit(token), TOKEN);
    const invitation = page.getByRole('dialog', { name: 'Join Example Mingle project?' });
    await invitation.getByRole('button', { name: 'Join project', exact: true }).click();
    const workspace = page.getByRole('dialog', { name: 'Where should we put the code?' });
    await workspace.getByRole('button', { name: 'I already have a checkout', exact: true }).click();
    await workspace.getByRole('radio', { name: /Example local checkout/ }).click();
    await workspace.getByRole('button', { name: 'Use this checkout', exact: true }).click();
    const agents = page.getByRole('dialog', { name: 'Add your agents' });
    await agents.getByRole('heading', { name: 'No eligible provider is ready' }).waitFor();
    assert.equal(await agents.getByRole('button', { name: 'Join project', exact: true }).isDisabled(), true);
    await agents.getByRole('button', { name: 'Open provider settings', exact: true }).click();
    await page.getByRole('button', { name: 'Back to workspace', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
    await page.getByRole('dialog', { name: 'Join Example Mingle project?' }).waitFor();
    assert.ok(requests.some((item) => item.method === 'POST' && item.pathname === '/api/project-invitations/preview' && item.body.token === TOKEN), 'the same invitation remains available after returning from settings');
    const resumedInvitation = page.getByRole('dialog', { name: 'Join Example Mingle project?' });
    await resumedInvitation.getByRole('button', { name: 'Join project', exact: true }).click();
    const resumedWorkspace = page.getByRole('dialog', { name: 'Where should we put the code?' });
    await resumedWorkspace.getByRole('button', { name: 'I already have a checkout', exact: true }).click();
    await resumedWorkspace.getByRole('radio', { name: /Example local checkout/ }).click();
    await resumedWorkspace.getByRole('button', { name: 'Use this checkout', exact: true }).click();
    await page.getByRole('dialog', { name: 'Add your agents' }).getByRole('heading', { name: 'No eligible provider is ready' }).waitFor();
    assert.equal(requests.filter((item) => item.method === 'POST' && item.pathname === '/api/project-invitations/join').length, joinsBefore, 'provider setup does not accept the invitation or create an agent');
    providerSetupNeeded = false;
  });

  await test('late collaboration snapshot after dismissing the dialog cannot resurrect stale UI', async () => {
    delayCollaborationOnce = true;
    const readsBefore = collaborationReads;
    await page.getByRole('dialog', { name: 'Add your agents' }).getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Add teammates', exact: true }).click();
    await page.getByRole('dialog', { name: 'Teammates' }).waitFor();
    await waitFor(() => collaborationReads > readsBefore, 'delayed collaboration read to start');
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await delay;
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.getByRole('alert').count(), 0, 'a stale successful GET cannot create an error or toast');
  });

  await test('invited member opens the late shared group, sees read-only parity, and keeps deliberate agent/project selection scoped', async () => {
    accountMode = 'signed-in';
    providerSetupNeeded = false;
    memberTeamSessionCreated = false;
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.ok(joinedProjectId, 'an earlier explicit invitation join supplies the example member project');
    const invitedAgent = page.getByRole('button', { name: /Your agent · @example-invited-1: Example invited agent 1/ });
    await invitedAgent.waitFor();
    assert.equal(await page.locator('.sgroup--team-session').count(), 0, 'the project has not received its team session yet');

    const readsBefore = teamStructureReads;
    memberTeamSessionCreated = true;
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent('mingle:team-structure-updated', { detail: { projectId: id } })), joinedProjectId);
    const sharedRow = page.getByRole('button', { name: 'Example shared team session, shared project team conversation', exact: true });
    await sharedRow.waitFor();
    await waitFor(() => teamStructureReads > readsBefore && sharedRow.getAttribute('aria-current').then((value) => value === 'true'), 'late shared team session auto-selection');
    await waitFor(() => requests.some((item) => item.pathname === `/api/projects/${joinedProjectId}/team-chat`), 'member shared team chat snapshot request');
    await page.getByText('Add a total to each order row.', { exact: true }).waitFor();
    await page.getByText('Add order total', { exact: true }).waitFor();
    await page.getByRole('region', { name: 'Latest shared group result' }).locator('.team-session__result-head > span').getByText('In progress', { exact: true }).waitFor();
    assert.equal(await page.locator('.team-session__group-card').count(), 1, 'the assignment is a structured shared group card');
    assert.equal(await page.locator('[data-group-message-id="example-group-request"]').count(), 0, 'the exact human group mirror is not repeated');
    assert.equal(await page.locator('[data-group-message-id="example-group-agent-entry"]').count(), 0, 'the exact agent group mirror is not repeated');
    assert.equal(await page.locator('[data-group-message-id="example-group-member-confirmation"]').count(), 0, 'a member-origin human request uses its durable chat identity to suppress the group mirror');
    assert.equal(await page.locator('[data-group-message-id="example-group-progress"]').count(), 1, 'same text from a different group author remains visible');
    assert.equal(await page.locator('.chat__inner .md').evaluateAll((nodes) => nodes.filter((node) => node.textContent?.trim() === 'The shared assignment is in progress.').length), 2,
      'identical text from the host agent and invited agent is not content-deduplicated');
    const timelineRows = await page.locator('.chat__inner [data-message-id], .chat__inner [data-group-message-id]').evaluateAll((nodes) => nodes
      .filter((node) => !node.parentElement?.closest('[data-message-id], [data-group-message-id]'))
      .map((node) => ({ id: node.getAttribute('data-message-id') ?? node.getAttribute('data-group-message-id'), at: node.querySelector('time')?.getAttribute('datetime') }))
      .filter((row) => row.at));
    assert.deepEqual(timelineRows.map((row) => row.id), [
      'example-member-human-message', 'example-group-assignment', 'example-member-agent-message',
      'example-group-progress', 'example-member-confirmation-message',
    ], 'late group activity is merged by timestamp before the latest team-chat confirmation');
    assert.ok(timelineRows.every((row, index) => index === 0 || Date.parse(timelineRows[index - 1].at) <= Date.parse(row.at)), 'merged timeline timestamps are monotonic');
    assert.equal(await page.getByText('Orchestrated · default route', { exact: true }).count(), 1, 'the composer shows the actual shared group routing mode');
    assert.ok((await page.locator('.agent-presence__row').count()) >= 2, 'the visible agent dock shows this member’s agent and the host lead');
    assert.equal(await page.getByRole('button', { name: /Pause group|Stop active runs/ }).count(), 0, 'member group view adds no host pause/stop controls');
    await page.screenshot({ path: screenshots.memberDesktop, fullPage: true });

    await page.setViewportSize({ width: 900, height: 760 });
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
      composer: document.querySelector('.composer')?.getBoundingClientRect().right ?? 0,
      dockVisible: Boolean(document.querySelector('.agent-presence__list:not([aria-hidden="true"]) .agent-presence__row')) }));
    assert.ok(geometry.document <= geometry.viewport, `the shared group view fits a 900px viewport: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.composer <= geometry.viewport + 1, `the composer stays in the 900px viewport: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.dockVisible, true, 'the member agent dock remains expanded at 900px');
    await page.screenshot({ path: screenshots.member900, fullPage: true });

    await page.setViewportSize({ width: 1280, height: 900 });
    const groupDraft = 'Example member draft survives agent and project navigation';
    const sharedComposer = page.locator('#composer-example-host-anchor');
    await sharedComposer.fill(groupDraft);
    await invitedAgent.click();
    await page.locator('.internal-delivery-detail').waitFor();
    assert.equal(await page.getByText('Internal group routing rules', { exact: false }).isVisible(), false, 'runtime delivery instructions are collapsed by exact message kind');
    await page.locator('.internal-delivery-detail summary').click();
    await page.getByText('Internal group routing rules', { exact: false }).waitFor();
    await page.locator('.internal-delivery-detail summary').click();
    // A later host update must not steal a member's explicit agent inspection.
    memberGroupResultState = 'review';
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent('mingle:team-structure-updated', { detail: { projectId: id } })), joinedProjectId);
    await page.waitForTimeout(150);
    assert.equal(await invitedAgent.getAttribute('aria-current'), 'true', 'explicit agent inspection wins over later group updates');

    await page.getByRole('button', { name: /Project: .*Switch project/ }).click();
    await page.getByRole('menuitem', { name: 'Example local checkout', exact: true }).click();
    await page.waitForTimeout(180);
    assert.equal(await page.locator('.sgroup--team-session').count(), 0, 'the joined project’s team session does not leak into another project');
    assert.equal(await page.getByText('Add an order total to each order row.', { exact: true }).count(), 0, 'project switch clears the prior group transcript');
    await page.getByRole('button', { name: /Project: .*Switch project/ }).click();
    await page.getByRole('menuitem', { name: 'mingle-demo', exact: true }).click();
    await invitedAgent.waitFor();
    await sharedRow.click();
    await page.locator('#composer-example-host-anchor').waitFor();
    assert.equal(await page.locator('#composer-example-host-anchor').inputValue(), groupDraft, 'unsent shared draft survives conversation and project navigation');

    await page.reload({ waitUntil: 'domcontentloaded' });
    const restoredTeamRow = page.getByRole('button', { name: 'Example shared team session, shared project team conversation', exact: true });
    await restoredTeamRow.waitFor();
    await waitFor(() => restoredTeamRow.getAttribute('aria-current').then((value) => value === 'true'), 'persisted project/team session selection after restart');
    await page.getByRole('region', { name: 'Latest shared group result' }).locator('.team-session__result-head > span').getByText('Ready for review', { exact: true }).waitFor();

    accountMode = 'wrong-account';
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent('mingle:team-chat-updated', { detail: { projectId: id } })), joinedProjectId);
    await page.getByRole('alert').filter({ hasText: 'current account or project is not authorized' }).waitFor();
    assert.equal(await page.getByText('Add an order total to each order row.', { exact: true }).count(), 0, 'group transcript is cleared when account authority changes');
    accountMode = 'signed-in';
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent('mingle:team-chat-updated', { detail: { projectId: id } })), joinedProjectId);
    await page.getByRole('region', { name: 'Latest shared group result' }).locator('.team-session__result-head > span').getByText('Ready for review', { exact: true }).waitFor();
    assert.equal(pageErrors.length, 0, `no uncaught browser errors in member group view: ${pageErrors.join('; ')}`);
  });

  await test('legacy joined projects migrate to an existing shared group only when no explicit selection exists', async () => {
    accountMode = 'signed-in';
    memberTeamSessionCreated = true;
    memberGroupResultState = 'review';
    assert.ok(joinedProjectId && joinedSessions[0], 'the earlier invitation join supplies a legacy member project and local agent');
    await page.evaluate(({ projectId: joinedId, sessionId }) => {
      const key = 'relay.ui.v2';
      const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
      saved.activeProjectId = joinedId;
      saved.view = 'workspace';
      saved.sessionByProject = { ...(saved.sessionByProject ?? {}), [joinedId]: sessionId };
      saved.selectedTeamSessionByProject = { ...(saved.selectedTeamSessionByProject ?? {}) };
      delete saved.selectedTeamSessionByProject[joinedId];
      saved.teamSessionAutoSelectByProject = { ...(saved.teamSessionAutoSelectByProject ?? {}) };
      delete saved.teamSessionAutoSelectByProject[joinedId];
      localStorage.setItem(key, JSON.stringify(saved));
    }, { projectId: joinedProjectId, sessionId: joinedSessions[0].id });
    const teamChatsBefore = requests.filter((item) => item.pathname === `/api/projects/${joinedProjectId}/team-chat`).length;
    await page.reload({ waitUntil: 'domcontentloaded' });
    const sharedRow = page.getByRole('button', { name: 'Example shared team session, shared project team conversation', exact: true });
    const invitedAgent = page.getByRole('button', { name: /Your agent · @example-invited-1: Example invited agent 1/ });
    await sharedRow.waitFor();
    await waitFor(() => sharedRow.getAttribute('aria-current').then((value) => value === 'true'), 'legacy remote project migrates to the existing shared session');
    await waitFor(() => requests.filter((item) => item.pathname === `/api/projects/${joinedProjectId}/team-chat`).length > teamChatsBefore, 'legacy shared team chat opens');
    assert.equal(await invitedAgent.getAttribute('aria-current'), null, 'the old local-agent pick does not masquerade as an explicit choice');
    assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem('relay.ui.v2') ?? '{}').teamSessionAutoSelectByProject?.[id], joinedProjectId), true,
      'the first authenticated remote structure persists the one-time default');

    await invitedAgent.click();
    await waitFor(() => invitedAgent.getAttribute('aria-current').then((value) => value === 'true'), 'explicit local agent selection');
    assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem('relay.ui.v2') ?? '{}').teamSessionAutoSelectByProject?.[id], joinedProjectId), false,
      'explicit agent selection records a durable opt-out');
    const readsBeforeRefresh = teamStructureReads;
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent('mingle:team-structure-updated', { detail: { projectId: id } })), joinedProjectId);
    await waitFor(() => teamStructureReads > readsBeforeRefresh, 'authenticated team structure refresh after explicit selection');
    assert.equal(await invitedAgent.getAttribute('aria-current'), 'true', 'a refreshed remote structure respects the explicit local-agent choice');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(() => invitedAgent.getAttribute('aria-current').then((value) => value === 'true'), 'explicit local-agent choice survives reload');
    assert.equal(await sharedRow.getAttribute('aria-current'), null, 'the legacy migration does not override an explicit choice on later loads');
  });

  note(`INFO fixtures: local FakeProviders runtime; collaboration/auth/email/clone/join payloads are intercepted Example fixtures; no provider inference was submitted.`);
  note(`INFO screenshots: ${JSON.stringify(screenshots)}`);
  if (failures.length) throw new Error(`${failures.length} browser acceptance check(s) failed; see ${path.join(outputDir, 'browser-acceptance.log')}`);
  note(`PASS ${passed} project-collaboration browser acceptance checks`);
}

try {
  await main();
} catch (cause) {
  throw cause;
} finally {
  await closeAll();
}
