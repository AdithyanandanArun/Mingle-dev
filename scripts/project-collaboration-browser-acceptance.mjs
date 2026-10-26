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
let localSessions = [];
let sourceBootstrap;
let accountMode = 'signed-in';
let deliveryMode = 'sent';
let previewMode = 'valid';
let providerSetupNeeded = false;
let includeProxySession = false;
let joinedSessions = [];
let clonedProject = null;
let collaborationSnapshot;
let publishedTeamSessionIds = [];
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
    note(`DEBUG page errors: ${JSON.stringify(pageErrors.slice(-8))}`);
    note(`DEBUG console errors: ${JSON.stringify(consoleErrors.slice(-8))}`);
    note(`DEBUG HTTP failures: ${JSON.stringify(httpFailures.slice(-12))}`);
    if (page && !page.isClosed()) {
      const state = await page.locator('[role=dialog]').innerText().catch(() => 'No dialog open.');
      note(`DEBUG visible dialog: ${state.slice(0, 1600)}`);
    }
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

function teamStructureSnapshot(id = projectId) {
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
    enabled: false,
    settings: null,
    host: { deviceId: 'example-leader-device', accountId: LEADER_ID, displayName: 'Example leader device', online: true, isThisDevice: true },
    canEdit: true,
    myConsent: null,
    members,
    leaderHistory: [],
    needsLeader: false,
    teamSession: null,
    observedAt: new Date().toISOString(),
    exampleFixture: true,
  };
}

function updateBootstrap() {
  const boot = structuredClone(sourceBootstrap);
  boot.projects = [...boot.projects.filter((project) => project.id !== projectId), { ...sourceBootstrap.projects.find((project) => project.id === projectId), id: projectId, name: 'Example local checkout', isExample: false }];
  if (clonedProject && !boot.projects.some((project) => project.id === clonedProject.id)) boot.projects.push(clonedProject);
  const sampleSessions = sourceBootstrap.sessions.filter((session) => session.projectId === projectId).map((session, index) => ({
    ...session, name: index === 0 ? 'Example local Codex' : `Example local agent ${index + 1}`, provider: 'codex', model: 'example-codex-model', effort: 'medium', policy: 'supervised', status: 'idle',
  }));
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
    if (!sampleSessions.some((session) => session.id === joinedSession.id)) sampleSessions.push(joinedSession);
  }
  boot.sessions = [...sourceBootstrap.sessions.filter((session) => session.projectId !== projectId), ...sampleSessions];
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
      await route.fulfill({ response, body: JSON.stringify(updateBootstrap()) });
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
      collaborationReads++;
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
      await jsonResponse(route, 200, collaborationSnapshot);
      return;
    }
    if (/^\/api\/projects\/[^/]+\/team-structure$/.test(url.pathname) && method === 'GET') {
      teamStructureReads++;
      await jsonResponse(route, 200, teamStructureSnapshot(decodeURIComponent(url.pathname.split('/')[3])));
      return;
    }
    if (/^\/api\/projects\/[^/]+\/collaboration\/invitations$/.test(url.pathname) && method === 'POST') {
      const id = `example-invitation-${collaborationSnapshot.invitations.length + 1}`;
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
    await page.locator('.pc-field--role select').selectOption('admin');
    await page.getByRole('button', { name: 'Send invite', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /Invitation email sent to new-person@example.invalid/ }).waitFor();
    const post = requests.findLast((item) => item.method === 'POST' && item.pathname === `/api/projects/${projectId}/collaboration/invitations`);
    assert.deepEqual(post?.body, { email: 'new-person@example.invalid', role: 'admin' });
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

  await test('combined local/team roster excludes remote proxies, refreshes orchestration, and supports owner-scoped actions', async () => {
    includeProxySession = true;
    publishedTeamSessionIds = [];
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add teammates', exact: true }).waitFor();
    const dialog = await ensureTeammatesDialog();
    await dialog.getByText('This shared project is not yet a team-orchestrated project.').waitFor();
    assert.ok(requests.some((item) => item.method === 'GET' && item.pathname === `/api/projects/${projectId}/team-structure`), 'the settings panel receives a typed team-structure fixture rather than the generic array fallback');
    assert.equal(await dialog.getByRole('alert').count(), 0, 'the team settings panel renders without a malformed-snapshot error');
    assert.equal(await dialog.locator('.pc-agent-row').filter({ hasText: 'Example remote Codex proxy' }).count(), 0, 'a proxy session recorded in group membership is not shown as a local project agent');
    assert.equal(await dialog.getByRole('checkbox', { name: /Share Example remote Codex proxy with this project/ }).count(), 0, 'a remote proxy cannot be selected for republication');
    await dialog.locator('.pc-agent-row').filter({ hasText: 'Example local Codex' }).waitFor();
    await waitFor(async () => await dialog.locator('.pc-agent-row').filter({ hasText: 'Example local Codex' }).count() === 1, 'leader-owned session de-duplication');
    assert.equal(await dialog.locator('.pc-agent-row').filter({ hasText: 'Example local Codex' }).count(), 1, 'the leader-owned published session appears once in the local section, not again as a remote agent');
    const teammate = dialog.locator('.pc-agent-row--remote').filter({ hasText: 'Example teammate' });
    await teammate.getByRole('button').click();
    await dialog.getByRole('button', { name: 'Open recovery controls' }).waitFor();
    assert.match(await teammate.innerText(), /claude.*example-claude-model.*example-teammate-device/i);
    assert.equal(await dialog.locator('#team-orchestrator-agent option').filter({ hasText: 'No roster agents available' }).count(), 1, 'the fixture starts with no agents in the orchestration roster');
    const check = dialog.getByRole('checkbox', { name: /Share Example local agent 2 with this project/ }).first();
    await check.check();
    const structureReadsBeforePublish = teamStructureReads;
    await dialog.getByRole('button', { name: 'Update shared agents' }).click();
    const publish = requests.findLast((item) => item.method === 'POST' && item.pathname === '/api/distributed/agents/publish');
    assert.ok(Array.isArray(publish?.body.sessionIds));
    assert.equal(publish.body.sessionIds.includes(PROXY_SESSION_ID), false, 'the publish API never receives the remote proxy session ID');
    await waitFor(async () => teamStructureReads > structureReadsBeforePublish
      && await dialog.locator('#team-orchestrator-agent option').filter({ hasText: 'Example local agent 2' }).count() > 0, 'team orchestration settings refresh after the roster changes');
    assert.ok(teamStructureReads > structureReadsBeforePublish, 'team orchestration settings refetch after the roster changes');
    assert.equal(await dialog.locator('#team-orchestrator-agent option').filter({ hasText: 'No roster agents available' }).count(), 0, 'the stale empty-roster option is replaced without reopening Teammates');
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
    assert.ok(httpFailures.every((failure) => [401, 404].includes(failure.status) && failure.pathname === '/api/project-invitations/preview'), `only expected opaque invitation auth/invalid responses are observed: ${JSON.stringify(httpFailures)}`);
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

  note(`INFO fixtures: local FakeProviders runtime; collaboration/auth/email/clone/join payloads are intercepted Example fixtures; no provider inference was submitted.`);
  note(`INFO screenshots: ${JSON.stringify(screenshots)}`);
  if (failures.length) throw new Error(`${failures.length} browser acceptance check(s) failed; see ${path.join(outputDir, 'browser-acceptance.log')}`);
  note(`PASS ${passed} project-collaboration browser acceptance checks`);
}

try {
  await main();
} catch (cause) {
  if (page) {
    note(`DEBUG uncaught page errors: ${JSON.stringify(pageErrors.slice(-8))}`);
    note(`DEBUG uncaught console errors: ${JSON.stringify(consoleErrors.slice(-8))}`);
    note(`DEBUG uncaught HTTP failures: ${JSON.stringify(httpFailures.slice(-12))}`);
    if (!page.isClosed()) note(`DEBUG uncaught visible dialog: ${(await page.locator('[role=dialog]').innerText().catch(() => 'No dialog open.')).slice(0, 1600)}`);
  }
  throw cause;
} finally {
  await closeAll();
}
