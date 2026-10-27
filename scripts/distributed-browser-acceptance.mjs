#!/usr/bin/env node
/**
 * Real-browser acceptance for the distributed Team workspace.
 * Starts a disposable FakeProviders Mingle server and the worktree's Vite UI,
 * exercises the rendered DOM and captured HTTP bodies, then always closes both.
 * Only signed-out/error responses use the real local API. Positive cloud/team
 * snapshots and every cloud mutation response are explicitly example fixtures
 * from distributed-browser-fixtures.mjs; this is not live-cloud evidence.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { EXAMPLE, createExampleSnapshot, exampleGroupSnapshot } from './distributed-browser-fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const serverRequire = createRequire(new URL('../apps/server/package.json', import.meta.url));
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const tsxCli = serverRequire.resolve('tsx/cli');
const serverScript = fileURLToPath(new URL('./distributed-browser-fixtures.mjs', import.meta.url));
const viteModule = webRequire.resolve('vite');
const viteCli = path.resolve(path.dirname(viteModule), '../../bin/vite.js');
const outputDir = path.join(os.tmpdir(), `mingle-distributed-browser-acceptance-${process.pid}`);
const logPath = path.join(outputDir, 'browser-acceptance.log');
const screenshots = {
  map: path.join(outputDir, 'shared-agent-map.png'),
  onboarding: path.join(outputDir, 'team-workspace-onboarding.png'),
  people: path.join(outputDir, 'team-workspace-people.png'),
  team: path.join(outputDir, 'team-workspace-desktop.png'),
  narrow: path.join(outputDir, 'team-workspace-900px.png'),
};
mkdirSync(outputDir, { recursive: true });

const log = createWriteStream(logPath, { flags: 'w' });
const children = [];
let serverReady = false;
let browser;
let passed = 0;
const failures = [];
const pageErrors = [];
const writes = [];
const localApiResponses = [];
const postApiResponses = [];
const nonOkResponses = [];
const consoleErrors = [];
let localProjectId = '';
let localSessionIds = [];
let page;

function note(message) {
  process.stdout.write(`${message}\n`);
  log.write(`${message}\n`);
}

function start(command, args, { cwd = root, name, env = {} } = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push({ child, name });
  for (const [streamName, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      log.write(`[${name}:${streamName}] ${chunk}`);
      if (name === 'fakeproviders' && chunk.includes('READY ')) serverReady = true;
    });
  }
  child.on('error', (error) => { log.write(`[${name}:spawn-error] ${error.stack ?? error}\n`); });
  return child;
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
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
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function test(name, work) {
  try {
    await work();
    passed++;
    note(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    failures.push({ name, message });
    note(`FAIL ${name}: ${message}`);
    if (page && !page.isClosed()) {
      const visible = await page.locator('.distributed').innerText().catch(() => 'Team workspace is not mounted.');
      note(`DEBUG visible state after ${name}: ${visible.slice(0, 1400)}`);
    }
  }
}

async function waitForWrite(pathname, startAt = writes.length, { expectError = false, expectNotice = true } = {}) {
  await waitFor(() => writes.slice(startAt).find((write) => write.pathname === pathname), `request ${pathname}`);
  const found = writes.slice(startAt).find((write) => write.pathname === pathname);
  await waitFor(() => postApiResponses.some((response) => response.pathname === pathname), `response ${pathname}`);
  if (expectError) await page.locator('[role=alert]').filter({ hasText: /stale request digest/ }).waitFor();
  else if (expectNotice) await waitFor(() => page.locator('.distributed__notice').isVisible(), `success notice for ${pathname}`);
  await waitFor(() => page.getByRole('button', { name: 'Refresh', exact: true }).isEnabled(), `snapshot refresh after ${pathname}`);
  return found;
}

function section(label) {
  return page.getByRole('navigation', { name: 'Team workspace sections' }).getByRole('button', { name: label, exact: true });
}

function selectField(label) {
  return page.locator('.dw-field').filter({ has: page.getByText(label, { exact: true }) }).locator('select');
}

async function selectTeam(teamId) {
  const selector = page.getByRole('combobox', { name: 'Active team' });
  if (!await selector.count()) return;
  if (await selector.inputValue() === teamId) return;
  const values = await selector.locator('option').evaluateAll((options) => options.map((option) => option.value));
  if (!values.includes(teamId)) return;
  const responseStart = localApiResponses.length;
  await selector.selectOption(teamId);
  await waitFor(async () => await selector.inputValue() === teamId, `select team ${teamId}`);
  await waitFor(() => localApiResponses.slice(responseStart).some((response) => response.teamId === teamId && response.status === 200), `snapshot for team ${teamId}`);
  await waitFor(async () => !/Checking team workspace/.test(await page.locator('.distributed__foot').innerText()), `team ${teamId} snapshot render`);
}

function apiSnapshotPath(url) {
  return new URL(url).pathname === '/api/distributed/snapshot';
}

async function json(route, status, body) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function cleanup() {
  if (browser) await browser.close().catch(() => {});
  for (const { child, name } of [...children].reverse()) {
    if (child.exitCode !== null) continue;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(5_000),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    log.write(`[cleanup] stopped ${name}\n`);
  }
  await new Promise((resolve) => log.end(resolve));
}

async function main() {
  const { chromium } = serverRequire('playwright');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
  if (!existsSync(executablePath)) throw new Error(`Chromium executable not found at ${executablePath}. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an existing browser; this harness never installs one.`);
  const uiUrl = 'http://127.0.0.1:4451/';
  const serverUrl = 'http://127.0.0.1:4310';

  start(process.execPath, [tsxCli, serverScript, '--serve'], { name: 'fakeproviders' });
  start(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', '4451', '--strictPort'], { cwd: path.join(root, 'apps/web'), name: 'vite' });
  await waitFor(() => serverReady, 'disposable FakeProviders server on port 4310');
  await waitFor(async () => {
    const response = await fetch(uiUrl, { signal: AbortSignal.timeout(500) });
    return response.ok;
  }, 'worktree Vite server on unique port 4451');

  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(5_000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', async (response) => {
    if (response.status() >= 400) nonOkResponses.push({ status: response.status(), url: response.url(), pathname: new URL(response.url()).pathname });
    if (response.url().includes('/api/distributed/snapshot')) {
      let body = null;
      try { body = await response.json(); } catch { /* status remains useful for network errors */ }
      localApiResponses.push({ status: response.status(), url: response.url(), teamId: new URL(response.url()).searchParams.get('teamId'), error: body?.teams?.error ?? body?.error ?? null });
    }
    if (response.request().method() !== 'GET' && response.url().includes('/api/distributed/')) {
      postApiResponses.push({ pathname: new URL(response.url()).pathname, status: response.status() });
    }
  });

  await page.route('**/api/distributed/groups/example-local-group', async (route) => {
    await json(route, 200, {
      exampleData: true,
      agents: [{ id: 'example-group-agent', name: 'Example remote group agent', provider: 'claude', model: 'example-model' }],
      messages: [{ id: 'example-group-message', kind: 'progress', deviceId: EXAMPLE.peerDevice, createdAt: '2026-10-22T12:01:00.000Z', content: 'Example group remote progress update.' }],
      tasks: [],
      requests: [{ id: 'example-group-recovery', agentId: 'example-group-agent', targetDeviceId: EXAMPLE.localDevice, targetOwnerId: 'example-owner-id', state: 'awaiting-approval', task: { title: 'Example group recovery task' } }],
    });
  });
  await page.route('**/api/groups/example-local-group/attachments', async (route) => { await json(route, 200, []); });

  const bootstrapResponse = await page.request.get(`${serverUrl}/api/bootstrap`);
  assert.equal(bootstrapResponse.status(), 200, 'real disposable local bootstrap must succeed');
  const boot = await bootstrapResponse.json();
  localProjectId = boot.projects.find((project) => project.isExample)?.id ?? '';
  localSessionIds = boot.sessions.filter((session) => session.projectId === localProjectId).map((session) => session.id);
  assert.ok(localProjectId, 'local runtime supplies its labelled example project');
  assert.ok(localSessionIds.length >= 2, 'local runtime supplies idle example sessions');

  // This suite exercises the Settings workspace, not project-first cloud binding.
  // The labelled example folder is deliberately not a shareable Git checkout.
  await page.route(`**/api/projects/${localProjectId}/collaboration`, async (route) => {
    assert.equal(route.request().method(), 'GET');
    await json(route, 200, { exampleData: true, project: null, members: [], agents: [], invitations: [], email: { configured: false } });
  });

  // The bootstrap is from the local app; only this explicitly named local-group
  // fixture is added so GroupRemoteActivity can be tested without real group work.
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.groups = [exampleGroupSnapshot(localSessionIds[0], localSessionIds[1])];
    await route.fulfill({ response, body: JSON.stringify(body) });
  });

  await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  let releaseSignedOutSnapshot;
  let signedOutSnapshotStarted = false;
  await page.route('**/api/distributed/snapshot**', async (route) => {
    signedOutSnapshotStarted = true;
    await new Promise((resolve) => { releaseSignedOutSnapshot = resolve; });
    await route.continue();
  });
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Team workspace', exact: true }).click();
  await waitFor(() => signedOutSnapshotStarted, 'real signed-out snapshot request to start');
  assert.match(await page.locator('.distributed__statusline').innerText(), /Loading snapshot/);
  assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).isDisabled(), true);
  releaseSignedOutSnapshot?.();
  await page.getByRole('button', { name: 'Open Account settings', exact: true }).waitFor({ timeout: 15_000 });
  await page.unroute('**/api/distributed/snapshot**');
  const realSignedOut = localApiResponses.find((response) => response.status >= 400 || response.error);
  assert.ok(realSignedOut, 'signed-out response is from the actual local runtime');
  note(`INFO real local signed-out snapshot status=${realSignedOut.status} error=${realSignedOut.error ?? 'HTTP error'}; no cloud client or credentials configured by this test`);
  await test('real local signed-out visibility and account settings action', async () => {
    assert.match(await page.locator('[role=alert]').innerText(), /sign.?in|account|authenticated/i);
    assert.equal(await page.getByRole('button', { name: 'Open Account settings', exact: true }).count(), 1);
    assert.equal(await page.getByRole('navigation', { name: 'Team workspace sections' }).getByRole('button').count(), 7);
    assert.match(await page.locator('.distributed__statusline').innerText(), /Team service: Unavailable/);
    await page.getByLabel('Team name', { exact: true }).fill('Example gated team');
    await page.getByLabel('Invitation token', { exact: true }).fill('example-gated-invitation-token');
    assert.equal(await page.getByRole('button', { name: 'Create team', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Accept invitation', exact: true }).isDisabled(), true);
    assert.equal(await page.getByText('Invite someone', { exact: true }).count(), 0, 'an unavailable team snapshot has no irrelevant invite form');
  });

  // Verify 503, Retry, then a second real signed-out read before enabling the
  // example-only positive cloud snapshot fixture.
  let injectedFailure = true;
  await page.route('**/api/distributed/snapshot**', async (route) => {
    if (injectedFailure && route.request().method() === 'GET') {
      injectedFailure = false;
      await json(route, 503, { error: 'Example temporary snapshot failure for retry acceptance.' });
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText(/temporary snapshot failure for retry acceptance/i).waitFor();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Open Account settings', exact: true }).waitFor();
  await test('visible service error and retry recovery to live signed-out response', async () => {
    assert.ok(localApiResponses.some((response) => response.status >= 400 || response.error));
    assert.match(await page.locator('[role=alert]').innerText(), /sign.?in|account|authenticated/i);
    assert.match(await page.locator('.distributed__statusline').innerText(), /Team service: Unavailable/);
  });
  await page.unroute('**/api/distributed/snapshot**');

  let snapshotMode = 'example';
  let nextDigest = EXAMPLE.digest;
  let delayAlphaNext = false;
  let alphaDelayedResolve;
  let delayBetaNext = false;
  let betaDelayedResolve;
  let writesMode = 'ok';
  let exampleCreatedTeam = false;
  let emptyTeamSnapshot = false;
  let timestampOnlySnapshot = false;
  let ambiguousDependency = false;
  await page.route('**/api/distributed/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      let body = {};
      try { body = request.postDataJSON(); } catch { /* bodyless */ }
      writes.push({ pathname: url.pathname, body, method: request.method() });
      if (writesMode === 'stale' && url.pathname === `/api/distributed/approvals/${EXAMPLE.request}`) {
        await json(route, 409, { error: 'Example stale request digest; refresh and review again.' });
        return;
      }
      if (url.pathname === '/api/distributed/invitations') {
        await json(route, 200, { invitation: { id: 'example-new-invitation' }, token: 'example-only-one-time-invitation-token' });
        return;
      }
      if (url.pathname === '/api/distributed/devices/register') {
        await json(route, 200, { device: { id: 'example-registered-device', fingerprint: `SHA-256:${'9'.repeat(64)}` } });
        return;
      }
      if (url.pathname === '/api/distributed/teams') {
        exampleCreatedTeam = true;
        emptyTeamSnapshot = false;
        await json(route, 200, { id: 'example-created-team' });
        return;
      }
      await json(route, 200, { ok: true, exampleData: true });
      return;
    }
    if (url.pathname === '/api/distributed/groups/example-local-group') {
      await json(route, 200, {
        agents: [{ id: 'example-group-agent', name: 'Example remote group agent', provider: 'claude', model: 'example-model' }],
        messages: [{ id: 'example-group-message', kind: 'progress', deviceId: EXAMPLE.peerDevice, createdAt: '2026-10-22T12:01:00.000Z', content: 'Example group remote progress update.' }],
        tasks: [],
        requests: [{ id: 'example-group-recovery', agentId: 'example-group-agent', targetDeviceId: EXAMPLE.localDevice, targetOwnerId: 'example-owner-id', state: 'awaiting-approval', task: { title: 'Example group recovery task' } }],
      });
      return;
    }
    if (!apiSnapshotPath(request.url())) {
      await json(route, 404, { error: 'Unexpected example API route.' });
      return;
    }
    if (snapshotMode === 'account-signed-out') {
      await json(route, 401, { error: 'Google sign-in is required. Sign in again.' });
      return;
    }
    const teamId = url.searchParams.get('teamId') ?? EXAMPLE.teamA;
    if (teamId === EXAMPLE.teamA && delayAlphaNext) {
      delayAlphaNext = false;
      await new Promise((resolve) => { alphaDelayedResolve = resolve; });
    }
    if (teamId === EXAMPLE.teamB && delayBetaNext) {
      delayBetaNext = false;
      await new Promise((resolve) => { betaDelayedResolve = resolve; });
    }
    const body = createExampleSnapshot(localProjectId, teamId);
    if (emptyTeamSnapshot) {
      body.teams.teams = [];
      body.teams.members = [];
      body.teams.invitations = [];
      body.teams.projects = [];
    }
    if (ambiguousDependency) {
      const prerequisite = body.execution.tasks.find((row) => row.teamId === teamId && row.id === `${teamId}-prerequisite`);
      assert.ok(prerequisite, 'example dependency fixture exists');
      body.execution.tasks.push({ ...prerequisite, deviceId: `${EXAMPLE.localDevice}-spare`, agentId: '', title: 'Example ambiguous prerequisite' });
    }
    body.teams.exampleData = true;
    if (exampleCreatedTeam && !body.teams.teams.some((team) => team.id === 'example-created-team')) {
      body.teams.teams.push({ id: 'example-created-team', name: 'Example form-created team', ownerId: '10000000-0000-4000-8000-000000000001', role: 'owner', createdAt: '2026-10-22T12:02:00.000Z' });
    }
    const requestRow = body.execution.requests.find((row) => row.id === EXAMPLE.request);
    if (requestRow) requestRow.digest = nextDigest;
    if (timestampOnlySnapshot) {
      timestampOnlySnapshot = false;
      const heartbeatAt = new Date().toISOString();
      for (const row of body.transport.devices) row.lastSeenAt = heartbeatAt;
      for (const row of body.execution.agents) {
        row.publishedAt = heartbeatAt;
        row.presenceObservedAt = heartbeatAt;
        row.quotaObservedAt = heartbeatAt;
      }
      for (const row of body.execution.tasks) row.createdAt = heartbeatAt;
    }
    await json(route, 200, body);
  });

  // Positive service state is always explicitly an Example fixture; all writes
  // below are inspected at the actual browser request boundary and intercepted.
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('combobox', { name: 'Active team' }).waitFor();
  await page.getByText('Example Team Alpha members', { exact: true }).waitFor();
  await test('positive cloud state is explicitly example-named and all seven sections render', async () => {
    assert.ok(await page.getByText('Example Team Alpha members', { exact: true }).count() >= 1);
    await section('Projects').click();
    assert.ok(await page.getByText('Example shared project', { exact: true }).count() >= 1);
    const tabs = page.getByRole('navigation', { name: 'Team workspace sections' }).getByRole('button');
    assert.equal(await tabs.count(), 7);
    for (const label of ['People', 'Projects', 'Devices', 'Agents', 'Conversation', 'Recovery', 'Transfers']) {
      const button = section(label);
      await button.click();
      assert.equal(await button.getAttribute('aria-current'), 'page', `${label} must become the selected section`);
    }
  });

  await test('local GroupRemoteActivity displays authenticated-attributed example status', async () => {
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    const remoteActivity = page.locator('.group-remote-activity');
    await remoteActivity.waitFor({ timeout: 10_000 });
    assert.match(await remoteActivity.innerText(), /Example group remote progress update/);
    assert.match(await remoteActivity.innerText(), /Example remote group agent/);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Team workspace', exact: true }).click();
  });

  await test('team create, invite, accept, keyboard form submit, and one-time token display', async () => {
    await selectTeam(EXAMPLE.teamA);
    await section('People').click();
    const ownerRow = page.locator('.dw-people-roster .dw-row').filter({ hasText: 'owner-a@example.invalid' });
    const ordinaryMemberRow = page.locator('.dw-people-roster .dw-row').filter({ hasText: 'member-b@example.invalid' });
    assert.equal(await ownerRow.getByRole('button', { name: 'Remove', exact: true }).count(), 0, 'the owner cannot remove themself');
    assert.equal(await ordinaryMemberRow.getByRole('button', { name: 'Remove', exact: true }).count(), 1, 'the owner can remove an ordinary member');
    assert.equal(await page.getByText('Pending', { exact: true }).count() >= 1, true);
    assert.equal(await page.getByText('Accepted', { exact: true }).count() >= 1, true);
    assert.equal(await page.getByText('Expired', { exact: true }).count() >= 1, true);
    emptyTeamSnapshot = true;
    let teamName;
    try {
      const emptySnapshotStart = localApiResponses.length;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await waitFor(() => localApiResponses.slice(emptySnapshotStart).some((response) => response.teamId === EXAMPLE.teamA && response.status === 200), 'signed-in empty-team example snapshot');
      await page.getByRole('button', { name: 'Create team', exact: true }).waitFor();
      await page.getByRole('combobox', { name: 'Active team' }).waitFor({ state: 'detached' });
      assert.equal(await page.getByText('Invite someone', { exact: true }).count(), 0, 'teamless onboarding does not show a disabled invite form');
      teamName = page.getByLabel('Team name', { exact: true });
      await teamName.fill('');
      const invitationToken = page.getByLabel('Invitation token', { exact: true });
      await invitationToken.fill('');
      assert.equal(await page.getByRole('button', { name: 'Create team', exact: true }).isDisabled(), true, 'empty team names remain disabled');
      assert.equal(await page.getByRole('button', { name: 'Accept invitation', exact: true }).isDisabled(), true, 'empty invitation tokens remain disabled');
      const onboardingGeometry = await page.locator('.distributed__grid--people-onboarding').evaluate((grid) => {
        const cards = [...grid.querySelectorAll(':scope > .dw-card')].map((card) => {
          const rect = card.getBoundingClientRect();
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        });
        return { columns: getComputedStyle(grid).gridTemplateColumns, cards };
      });
      assert.equal(onboardingGeometry.cards.length, 2, 'empty-team onboarding shows exactly create and accept cards');
      assert.equal(onboardingGeometry.cards[0].top, onboardingGeometry.cards[1].top, 'onboarding cards share a row');
      assert.ok(Math.abs(onboardingGeometry.cards[0].height - onboardingGeometry.cards[1].height) <= 1, `onboarding cards align: ${JSON.stringify(onboardingGeometry)}`);
      assert.ok(onboardingGeometry.cards[1].left > onboardingGeometry.cards[0].left, 'onboarding cards occupy separate columns');
      await page.screenshot({ path: screenshots.onboarding, fullPage: true });
      await teamName.fill('Example form-created team');
      assert.equal(await page.getByRole('button', { name: 'Create team', exact: true }).isEnabled(), true, 'a verified account with an available empty snapshot can submit a valid team name');
      await invitationToken.fill('example-gated-invitation-token-123');
      assert.equal(await page.getByRole('button', { name: 'Accept invitation', exact: true }).isEnabled(), true, 'a verified account with an available empty snapshot can accept an invitation');
    } finally {
      emptyTeamSnapshot = false;
    }
    const startAt = writes.length;
    await teamName.press('Enter');
    const created = await waitForWrite('/api/distributed/teams', startAt, { expectNotice: false });
    assert.deepEqual(created.body, { name: 'Example form-created team' });
    await waitFor(async () => await page.getByRole('combobox', { name: 'Active team' }).inputValue() === 'example-created-team', 'new team to become active after its snapshot arrives');
    const peoplePrimary = page.locator('.distributed__grid--people-primary');
    const primaryGeometry = await peoplePrimary.evaluate((grid) => ({
      columns: getComputedStyle(grid).gridTemplateColumns,
      cards: [...grid.querySelectorAll(':scope > .dw-card')].map((card) => {
        const rect = card.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      }),
    }));
    assert.equal(primaryGeometry.cards.length, 2, 'an active team prioritizes roster and invitation management');
    assert.ok(primaryGeometry.cards[0].top < primaryGeometry.cards[1].top, 'roster precedes invitation management');
    assert.ok(primaryGeometry.cards[0].bottom < primaryGeometry.cards[1].top, `roster and invitation sections do not overlap: ${JSON.stringify(primaryGeometry)}`);
    assert.equal(primaryGeometry.cards[0].left, primaryGeometry.cards[1].left, 'roster and invitation sections share a column');
    assert.equal(primaryGeometry.cards[0].width, primaryGeometry.cards[1].width, 'roster and invitation sections use the available width');
    assert.ok(primaryGeometry.cards[0].height < primaryGeometry.cards[1].height, `the compact roster does not stretch to the taller invitation section: ${JSON.stringify(primaryGeometry)}`);
    assert.equal(await page.locator('.dw-people-secondary').evaluate((details) => details.open), false, 'create/join actions start in the compact secondary disclosure');
    await page.getByLabel('Email', { exact: true }).fill('new-member@example.invalid');
    await selectField('Role').selectOption('admin');
    const inviteStart = writes.length;
    await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
    const invite = await waitForWrite('/api/distributed/invitations', inviteStart);
    assert.deepEqual(invite.body, { teamId: 'example-created-team', email: 'new-member@example.invalid', role: 'admin' });
    await page.getByText('example-only-one-time-invitation-token', { exact: true }).waitFor();
    await page.locator('.dw-people-secondary > summary').click();
    await page.getByLabel('Invitation token', { exact: true }).fill('example-accepted-token');
    const acceptStart = writes.length;
    await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
    assert.deepEqual((await waitForWrite('/api/distributed/invitations/accept', acceptStart)).body, { token: 'example-accepted-token' });
    await page.locator('.dw-people-secondary > summary').click();
    await page.getByRole('combobox', { name: 'Active team' }).selectOption(EXAMPLE.teamA);
    await page.getByRole('heading', { name: 'Example Team Alpha members', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Team workspace', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshots.people, fullPage: true });
  });

  await test('shared project creation and local project binding payloads', async () => {
    await selectTeam(EXAMPLE.teamA);
    await section('Projects').click();
    await page.getByLabel('Project name', { exact: true }).fill('Example bound project');
    await page.getByLabel('Repository URL (optional)', { exact: true }).fill('https://example.invalid/team/repo');
    let startAt = writes.length;
    await page.getByRole('button', { name: 'Create shared project', exact: true }).click();
    assert.deepEqual((await waitForWrite('/api/distributed/projects', startAt)).body, { teamId: EXAMPLE.teamA, name: 'Example bound project', repositoryUrl: 'https://example.invalid/team/repo' });
    startAt = writes.length;
    await page.getByRole('button', { name: 'Bind current project', exact: true }).click();
    assert.deepEqual((await waitForWrite('/api/distributed/projects/bind', startAt)).body, { teamId: EXAMPLE.teamA, sharedProjectId: EXAMPLE.projectA, localProjectId });
    assert.match(await page.locator('.dw-local-device').innerText(), /Example workspace/);
  });

  await test('device registration fingerprint, link payload, and revoke confirmation', async () => {
    await selectTeam(EXAMPLE.teamA);
    await section('Devices').click();
    await page.getByLabel('Device name', { exact: true }).fill('Example new laptop');
    let startAt = writes.length;
    await page.getByRole('button', { name: 'Register device', exact: true }).click();
    assert.deepEqual((await waitForWrite('/api/distributed/devices/register', startAt)).body, { teamId: EXAMPLE.teamA, name: 'Example new laptop' });
    assert.match(await page.locator('.dw-secret').innerText(), /SHA-256:/);
    await page.getByLabel('Peer device ID', { exact: true }).fill(EXAMPLE.peerDevice);
    await page.getByLabel('Verified fingerprint', { exact: true }).fill(`SHA-256:${'e'.repeat(64)}`);
    startAt = writes.length;
    await page.getByRole('button', { name: 'Link verified device', exact: true }).click();
    assert.deepEqual((await waitForWrite('/api/distributed/devices/link', startAt)).body, { teamId: EXAMPLE.teamA, deviceId: EXAMPLE.peerDevice, fingerprint: `SHA-256:${'e'.repeat(64)}` });
    let dialogMessage = '';
    page.once('dialog', (dialog) => { dialogMessage = dialog.message(); void dialog.accept(); });
    startAt = writes.length;
    await page.locator('.dw-row--device').filter({ has: page.getByText('Example Alpha peer laptop', { exact: true }) }).getByRole('button', { name: 'Unlink device', exact: true }).click();
    assert.match(dialogMessage, /Unlink Example Alpha peer laptop/);
    assert.deepEqual((await waitForWrite('/api/distributed/devices/revoke', startAt)).body, { teamId: EXAMPLE.teamA, deviceId: EXAMPLE.peerDevice });
    page.once('dialog', (dialog) => { dialogMessage = dialog.message(); void dialog.accept(); });
    startAt = writes.length;
    await page.locator('.dw-row--device').filter({ has: page.getByText('Example Alpha spare laptop', { exact: true }) }).getByRole('button', { name: 'Revoke device', exact: true }).click();
    assert.match(dialogMessage, /Revoke Example Alpha spare laptop/);
    assert.deepEqual((await waitForWrite('/api/distributed/devices/revoke', startAt)).body, { teamId: EXAMPLE.teamA, deviceId: `${EXAMPLE.localDevice}-spare` });
  });

  await test('published roster includes only explicitly checked supervised local session', async () => {
    await selectTeam(EXAMPLE.teamA);
    await section('Agents').click();
    const candidates = page.locator('.dw-session-pick');
    assert.equal(await candidates.count(), localSessionIds.length);
    const first = candidates.first();
    await first.locator('input[type=checkbox]').check();
    const label = await first.innerText();
    assert.match(label, /codex|claude/i);
    const startAt = writes.length;
    await page.getByRole('button', { name: /Publish 1 selected/ }).click();
    const publish = await waitForWrite('/api/distributed/agents/publish', startAt);
    assert.deepEqual(publish.body, { teamId: EXAMPLE.teamA, sharedProjectId: EXAMPLE.projectA, sessionIds: [localSessionIds[0]] });
    const unpublishStart = writes.length;
    await page.getByRole('button', { name: 'Stop sharing', exact: true }).click();
    assert.deepEqual((await waitForWrite('/api/distributed/agents/publish', unpublishStart)).body, { teamId: EXAMPLE.teamA, sharedProjectId: EXAMPLE.projectA, sessionIds: [] });
  });

  await test('map uses real DOM graph nodes/edges, and task relations remain explicit example records', async () => {
    await selectTeam(EXAMPLE.teamA);
    await page.getByRole('heading', { name: 'Shared agent map', exact: true }).waitFor();
    const map = page.locator('.dw-shared-map');
    await map.scrollIntoViewIfNeeded();
    await map.locator('.react-flow__node').first().waitFor();
    await map.locator('.react-flow__edge').first().waitFor({ timeout: 5_000 });
    const flowLayout = await map.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const nodes = [...element.querySelectorAll('.react-flow__node')];
      const edges = [...element.querySelectorAll('.react-flow__edge')];
      const visibleNodes = nodes.filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return style.visibility === 'visible' && style.display !== 'none' && rect.width > 0 && rect.height > 0
          && rect.right > bounds.left && rect.left < bounds.right && rect.bottom > bounds.top && rect.top < bounds.bottom;
      }).length;
      return { nodes: nodes.length, visibleNodes, edges: edges.length, viewport: { width: bounds.width, height: bounds.height } };
    });
    note(`INFO shared map rendered geometry: ${JSON.stringify(flowLayout)}`);
    await page.screenshot({ path: screenshots.map, fullPage: true });
    const nodeCount = await map.locator('.react-flow__node').count();
    const edgeCount = await map.locator('.react-flow__edge').count();
    assert.ok(nodeCount >= 7, `expected example relationship nodes, got ${nodeCount}`);
    assert.equal(flowLayout.visibleNodes, nodeCount, 'all graph nodes have measured visible DOM bounds inside the map');
    assert.equal(edgeCount, 8, 'ownership, hosting, assignment and explicit cross-device dependency edges are rendered');
    assert.equal(await map.locator('.react-flow__edge').filter({ hasText: 'required by' }).count(), 1, 'unique cross-device task dependency is linked');
    await page.getByRole('heading', { name: 'Shared task relationships', exact: true }).scrollIntoViewIfNeeded();
    assert.match(await page.locator('.dw-list--compact').innerText(), /Example Alpha shared task/);
    await page.evaluate(() => { window.__mingleMapNode = document.querySelector('.dw-shared-map .react-flow__node'); });
    const beforeRefresh = localApiResponses.length;
    timestampOnlySnapshot = true;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await waitFor(() => localApiResponses.slice(beforeRefresh).some((response) => response.teamId === EXAMPLE.teamA && response.status === 200), 'timestamp-only map snapshot');
    await waitFor(async () => !/Checking team workspace/.test(await page.locator('.distributed__foot').innerText()), 'timestamp-only map refresh render');
    const preservedNode = await page.evaluate(() => window.__mingleMapNode === document.querySelector('.dw-shared-map .react-flow__node'));
    assert.equal(preservedNode, true, 'a timestamp-only poll preserves the rendered node instance and map viewport');
    ambiguousDependency = true;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await waitFor(async () => await map.locator('.react-flow__node').count() === nodeCount + 1, 'duplicate native task ID on a third device');
    await waitFor(async () => await map.locator('.react-flow__edge').count() === 7, 'ambiguous dependency omitted');
    assert.equal(await map.locator('.react-flow__edge').filter({ hasText: 'required by' }).count(), 0, 'ambiguous cross-device dependency is not guessed');
    await section('Conversation').click();
    const sharedTasks = page.locator('.dw-card').filter({ has: page.getByRole('heading', { name: 'Shared tasks', exact: true }) });
    assert.equal(await sharedTasks.getByText('Example Alpha prerequisite', { exact: true }).count(), 1);
    assert.equal(await sharedTasks.getByText('Example ambiguous prerequisite', { exact: true }).count(), 1, 'both device-scoped native IDs remain separate task rows');
    await section('Agents').click();
    ambiguousDependency = false;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await waitFor(async () => await map.locator('.react-flow__node').count() === nodeCount && await map.locator('.react-flow__edge').count() === 8, 'unique dependency restored');
  });

  await test('shared task publication and conversation sends actual idempotent request bodies', async () => {
    await selectTeam(EXAMPLE.teamA);
    await section('Conversation').click();
    await selectField('Local task to share').selectOption({ index: 1 });
    let startAt = writes.length;
    await page.getByRole('button', { name: 'Share task', exact: true }).click();
    const task = await waitForWrite('/api/distributed/tasks/publish', startAt);
    assert.equal(task.body.teamId, EXAMPLE.teamA);
    assert.equal(task.body.sharedProjectId, EXAMPLE.projectA);
    assert.equal(task.body.taskId, 'tsk_example_contract');
    await page.getByLabel('Message', { exact: true }).fill('Example browser-shared message');
    startAt = writes.length;
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const message = await waitForWrite('/api/distributed/messages', startAt);
    assert.deepEqual(Object.keys(message.body).sort(), ['content', 'idempotencyKey', 'sharedProjectId', 'teamId'].sort());
    assert.equal(message.body.content, 'Example browser-shared message');
    assert.match(message.body.idempotencyKey, /^[0-9a-f-]{36}$/i);
  });

  await test('recovery request is human-directed and unknown target quota is an explicit request flag', async () => {
    await selectTeam(EXAMPLE.teamA);
    await section('Recovery').click();
    await page.getByRole('checkbox', { name: /Request review from an agent with unknown quota/ }).check();
    await page.getByLabel('Work request', { exact: true }).fill('Example explicit recovery task');
    const startAt = writes.length;
    await page.getByRole('button', { name: 'Send approval request', exact: true }).click();
    const delegation = await waitForWrite('/api/distributed/delegations', startAt);
    assert.equal(delegation.body.teamId, EXAMPLE.teamA);
    assert.equal(delegation.body.sharedProjectId, EXAMPLE.projectA);
    assert.equal(delegation.body.sourceSessionId, localSessionIds[0]);
    assert.equal(delegation.body.taskId, 'tsk_example_contract');
    assert.equal(delegation.body.agentId, EXAMPLE.peerAgent);
    assert.equal(delegation.body.mode, 'unpublished-recovery');
    assert.equal(delegation.body.content, 'Example explicit recovery task');
    assert.equal(delegation.body.allowUnverifiedTarget, true);
    assert.match(delegation.body.idempotencyKey, /^[0-9a-f-]{36}$/i);
    assert.equal('maxSpendUsd' in delegation.body, false);
  });

  await test('wrong-device execution approvals are absent; review and consent gates are visible', async () => {
    await selectTeam(EXAMPLE.teamA);
    await section('Recovery').click();
    const approvals = page.locator('.dw-approval');
    assert.equal(await approvals.count(), 2, 'only two requests explicitly targeting the selected local device should be actionable');
    assert.equal(await page.getByText('Wrong-device example request must remain hidden', { exact: true }).count(), 0);
    const approval = approvals.filter({ hasText: 'Example recovery instructions' });
    const approve = approval.getByRole('button', { name: 'Approve this exact request', exact: true });
    assert.equal(await approve.isDisabled(), true);
    const acknowledgements = approval.getByRole('checkbox');
    assert.equal(await acknowledgements.nth(0).isChecked(), false, 'progress sharing defaults off');
    await acknowledgements.nth(1).check();
    assert.equal(await approve.isDisabled(), true, 'spend permission is insufficient without exact request review and unknown quota consent');
    await acknowledgements.nth(2).check();
    assert.equal(await approve.isDisabled(), true, 'spend plus unknown quota still requires exact request review');
    await acknowledgements.nth(3).check();
    assert.equal(await approve.isEnabled(), true);
  });

  await test('same request ID with changed digest clears every prior execution consent', async () => {
    await selectTeam(EXAMPLE.teamA);
    const approval = page.locator('.dw-approval').filter({ hasText: 'Example recovery instructions' });
    await approval.getByRole('checkbox').nth(3).check();
    nextDigest = 'b'.repeat(64);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator('.dw-disclosures').getByText(nextDigest, { exact: true }).waitFor();
    assert.equal(await approval.getByRole('checkbox').nth(1).isChecked(), false, 'spend consent must be cleared when digest changes');
    assert.equal(await approval.getByRole('checkbox').nth(2).isChecked(), false, 'unknown-quota consent must be cleared when digest changes');
    assert.equal(await approval.getByRole('checkbox').nth(3).isChecked(), false, 'review acknowledgement must be cleared when digest changes');
    assert.equal(await approval.getByRole('button', { name: 'Approve this exact request', exact: true }).isDisabled(), true);
  });

  await test('stale digest decision is sent once with displayed digest and never silently replayed', async () => {
    await selectTeam(EXAMPLE.teamA);
    writesMode = 'stale';
    const approval = page.locator('.dw-approval').filter({ hasText: 'Example recovery instructions' });
    const startAt = writes.length;
    await approval.getByRole('button', { name: 'Deny', exact: true }).click();
    const stale = await waitForWrite(`/api/distributed/approvals/${EXAMPLE.request}`, startAt, { expectError: true });
    assert.deepEqual(stale.body, { decision: 'denied', expectedDigest: 'b'.repeat(64), shareProgress: false, allowProviderSpend: false, allowUnverifiedQuota: false });
    await page.getByText(/Example stale request digest/).waitFor();
    await delay(150);
    assert.equal(writes.filter((write) => write.pathname === stale.pathname).length, 1, 'no automatic replay after stale digest response');
    writesMode = 'ok';
    nextDigest = EXAMPLE.digest;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator('.dw-disclosures').getByText(EXAMPLE.digest, { exact: true }).waitFor();
    const denyApproval = page.locator('.dw-approval').filter({ hasText: 'Example recovery instructions' });
    const denyStart = writes.length;
    await denyApproval.getByRole('button', { name: 'Deny', exact: true }).click();
    assert.deepEqual((await waitForWrite(`/api/distributed/approvals/${EXAMPLE.request}`, denyStart)).body, { decision: 'denied', expectedDigest: EXAMPLE.digest, shareProgress: false, allowProviderSpend: false, allowUnverifiedQuota: false });
  });

  await test('explicit destination spend and unknown-quota consent permit one reviewed approval only', async () => {
    await selectTeam(EXAMPLE.teamA);
    const approval = page.locator('.dw-approval').filter({ hasText: 'Example approval request' });
    await approval.getByRole('checkbox').nth(1).check();
    await approval.getByRole('checkbox').nth(2).check();
    await approval.getByRole('checkbox').nth(3).check();
    const startAt = writes.length;
    await approval.getByRole('button', { name: 'Approve this exact request', exact: true }).click();
    const decision = await waitForWrite(`/api/distributed/approvals/${EXAMPLE.approveRequest}`, startAt);
    assert.deepEqual(decision.body, { decision: 'approved', expectedDigest: 'd'.repeat(64), shareProgress: false, allowProviderSpend: true, allowUnverifiedQuota: true });
    assert.equal('requestId' in decision.body, false, 'route ID is not duplicated in the body');
  });

  await test('device/team scoping for Git and command approval lists', async () => {
    await selectTeam(EXAMPLE.teamA);
    await section('Transfers').click();
    const gitSection = page.getByRole('heading', { name: 'Git transfer and integration approvals', exact: true }).locator('..');
    const commandSection = page.getByRole('heading', { name: 'Incoming structured command approvals', exact: true }).locator('..');
    assert.equal(await page.locator('.dw-approval').filter({ hasText: 'example-git-wrong-device' }).count(), 0, 'wrong-device Git request is not rendered');
    assert.equal(await page.locator('.dw-approval').filter({ hasText: 'example-command-wrong-device' }).count(), 0, 'wrong-device command request is not rendered');
    assert.equal(await page.locator('.dw-approval').filter({ hasText: 'example-git-source' }).count(), 1);
    assert.equal(await page.locator('.dw-approval').filter({ hasText: 'example-git-destination' }).count(), 1);
    assert.equal(await page.locator('.dw-approval').filter({ hasText: 'git.status' }).count(), 1);
    assert.ok(await gitSection.count() >= 1);
    assert.ok(await commandSection.count() >= 1);
  });

  await test('source and destination Git decisions submit exact displayed request digests', async () => {
    await selectTeam(EXAMPLE.teamA);
    const source = page.locator('.dw-approval').filter({ hasText: 'example-git-source' });
    await source.getByRole('checkbox').check();
    let startAt = writes.length;
    await source.getByRole('button', { name: 'Approve this exact request', exact: true }).click();
    assert.deepEqual((await waitForWrite('/api/distributed/git/example-git-source/decision', startAt)).body, { decision: 'approved', expectedDigest: EXAMPLE.digest });
    const destination = page.locator('.dw-approval').filter({ hasText: 'example-git-destination' });
    await destination.getByRole('checkbox').check();
    startAt = writes.length;
    await destination.getByRole('button', { name: 'Approve this exact request', exact: true }).click();
    assert.deepEqual((await waitForWrite('/api/distributed/git/example-git-destination/decision', startAt)).body, { decision: 'approved', expectedDigest: EXAMPLE.digest });
  });

  await test('Git bundle request and imported bundle merge/push use displayed optimistic state', async () => {
    await selectTeam(EXAMPLE.teamA);
    const bundleForm = page.locator('form').filter({ hasText: 'Request a Git bundle transfer' });
    await bundleForm.locator('label.dw-field').filter({ hasText: 'Destination device' }).locator('select').selectOption(EXAMPLE.peerDevice);
    await page.getByLabel('Expected source HEAD', { exact: true }).fill(EXAMPLE.head);
    let startAt = writes.length;
    await page.getByRole('button', { name: 'Request bundle import', exact: true }).click();
    const transfer = await waitForWrite('/api/distributed/git/request', startAt);
    assert.deepEqual(transfer.body, { idempotencyKey: transfer.body.idempotencyKey, teamId: EXAMPLE.teamA, sharedProjectId: EXAMPLE.projectA, toDeviceId: EXAMPLE.peerDevice, expectedHead: EXAMPLE.head });
    assert.match(transfer.body.idempotencyKey, /^[0-9a-f-]{36}$/i);
    const imported = page.locator('.dw-approval').filter({ hasText: 'Imported bundle · example-git-imported' });
    startAt = writes.length;
    await imported.getByRole('button', { name: 'Request merge', exact: true }).click();
    const merge = await waitForWrite('/api/distributed/git/integrate', startAt);
    assert.deepEqual(merge.body, { idempotencyKey: merge.body.idempotencyKey, teamId: EXAMPLE.teamA, sharedProjectId: EXAMPLE.projectA, incomingRequestId: 'example-git-imported', action: 'merge', expectedHead: EXAMPLE.head, expectedFingerprint: EXAMPLE.fingerprint });
    await imported.locator('label.dw-field').filter({ hasText: 'Integration action' }).locator('select').selectOption('push');
    assert.equal(await imported.getByRole('button', { name: 'Request push', exact: true }).isDisabled(), true, 'push needs a configured remote name');
    await imported.locator('label.dw-field').filter({ hasText: 'Configured remote name' }).locator('input').fill('origin');
    startAt = writes.length;
    await imported.getByRole('button', { name: 'Request push', exact: true }).click();
    const push = await waitForWrite('/api/distributed/git/integrate', startAt);
    assert.equal(push.body.action, 'push');
    assert.equal(push.body.remoteName, 'origin');
    assert.equal(push.body.expectedHead, EXAMPLE.head);
    assert.equal(push.body.expectedFingerprint, EXAMPLE.fingerprint);
  });

  await test('restricted Git command UI exposes typed allowlist, validates parameters, and sends no shell text', async () => {
    await selectTeam(EXAMPLE.teamA);
    const commandForm = page.locator('form').filter({ hasText: 'Request a scoped Git read' });
    await commandForm.locator('label.dw-field').filter({ hasText: 'Destination device' }).locator('select').selectOption(EXAMPLE.peerDevice);
    await commandForm.locator('label.dw-field').filter({ hasText: 'Operation' }).locator('select').selectOption('git.log');
    await page.getByLabel('Commit limit', { exact: true }).fill('99');
    const requestButton = page.getByRole('button', { name: 'Request read operation', exact: true });
    assert.equal(await requestButton.isDisabled(), true, 'log limit over 50 cannot submit');
    await page.getByLabel('Commit limit', { exact: true }).fill('10');
    const startAt = writes.length;
    await requestButton.click();
    const command = await waitForWrite('/api/distributed/commands/request', startAt);
    assert.deepEqual(command.body, { idempotencyKey: command.body.idempotencyKey, teamId: EXAMPLE.teamA, sharedProjectId: EXAMPLE.projectA, toDeviceId: EXAMPLE.peerDevice, operation: { kind: 'git.log', limit: 10 }, cwd: '.' });
    assert.match(command.body.idempotencyKey, /^[0-9a-f-]{36}$/i);
    assert.equal('executable' in command.body, false);
    assert.equal('argv' in command.body, false);
    assert.equal('command' in command.body, false);
    const choices = await commandForm.locator('label.dw-field').filter({ hasText: 'Operation' }).locator('select option').allTextContents();
    assert.equal(choices.length, 8, 'placeholder plus exactly seven fixed Git read operations');
    assert.ok(choices.every((value) => !/shell|python|node|script/i.test(value)));
  });

  await test('incoming structured command denial binds to displayed digest', async () => {
    await selectTeam(EXAMPLE.teamA);
    const command = page.locator('.dw-approval').filter({ hasText: 'git.status' });
    await command.getByRole('checkbox').check();
    const startAt = writes.length;
    await command.getByRole('button', { name: 'Deny', exact: true }).click();
    assert.deepEqual((await waitForWrite('/api/distributed/commands/example-command-local/decision', startAt)).body, { decision: 'denied', expectedDigest: EXAMPLE.digest });
  });

  await test('team switch immediately scopes cached data and member controls by role', async () => {
    const activeTeam = page.getByRole('combobox', { name: 'Active team' });
    await selectTeam(EXAMPLE.teamB);
    await section('People').click();
    await page.getByRole('heading', { name: 'Example Team Beta members', exact: true }).waitFor();
    assert.equal(await page.getByText('Example Team Alpha members', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Remove', exact: true }).count(), 0, 'a member role cannot see team-member revoke controls');
    assert.equal(await page.getByRole('button', { name: /Create invitation/ }).isDisabled(), true, 'a member role cannot invite');
    await section('Devices').click();
    assert.equal(await page.getByText('Example Alpha laptop', { exact: true }).count(), 0, 'alpha device must not remain in beta list');
    assert.equal(await page.getByText('Example Beta local laptop', { exact: true }).count(), 1);
    await section('Agents').click();
    assert.equal(await page.getByText('Example Alpha local Codex', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Example Beta local Codex', { exact: true }).count(), 1);
    await section('Conversation').click();
    assert.equal(await page.getByText('Example Alpha shared message', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Example Beta shared message', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Example Alpha shared task', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Example Beta shared task', { exact: true }).count(), 1);
    await section('Recovery').click();
    assert.equal(await page.locator('.dw-approval').count(), 2, 'only this team device’s requests are actionable');
    await section('Projects').click();
    assert.equal(await page.getByRole('button', { name: /Create shared project/ }).isDisabled(), true, 'a team member cannot create a shared project');
    assert.equal(await page.getByText('Example shared project', { exact: true }).count(), 0, 'alpha project is not leaked across teams');
    assert.ok(await page.getByText('Example second shared project', { exact: true }).count() >= 1, 'selected team project remains visible');
    await page.screenshot({ path: screenshots.team, fullPage: true });
  });

  await test('delayed prior-team response cannot overwrite the newly selected team', async () => {
    delayAlphaNext = true;
    await section('Devices').click();
    const activeTeam = page.getByRole('combobox', { name: 'Active team' });
    const beforeAlpha = localApiResponses.length;
    await activeTeam.selectOption(EXAMPLE.teamA);
    await waitFor(async () => await activeTeam.inputValue() === EXAMPLE.teamA, 'alpha team selection');
    await waitFor(() => alphaDelayedResolve, 'delayed team-alpha snapshot request');
    assert.equal(await page.getByText('Example Beta local laptop', { exact: true }).count(), 0, 'cached beta content must be cleared while alpha loads');
    const beforeBeta = localApiResponses.length;
    await activeTeam.selectOption(EXAMPLE.teamB);
    await waitFor(async () => await activeTeam.inputValue() === EXAMPLE.teamB, 'beta team selection during alpha poll');
    await waitFor(() => localApiResponses.slice(beforeBeta).some((response) => response.teamId === EXAMPLE.teamB && response.status === 200), 'fresh beta snapshot');
    alphaDelayedResolve?.();
    alphaDelayedResolve = null;
    await delay(300);
    assert.equal(await activeTeam.inputValue(), EXAMPLE.teamB);
    assert.equal(await page.getByText('Example Alpha laptop', { exact: true }).count(), 0);
    assert.match(await page.locator('.distributed').innerText(), /Example Team Beta/);
  });

  await test('account sign-out during an older poll clears prior approvals and ignores the late response', async () => {
    delayBetaNext = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => betaDelayedResolve, 'delayed in-flight snapshot for the current example account');
    snapshotMode = 'account-signed-out';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: 'Open Account settings', exact: true }).waitFor();
    betaDelayedResolve?.();
    betaDelayedResolve = null;
    await delay(300);
    assert.equal(await page.locator('.dw-approval').count(), 0, 'old request decision controls must not survive account sign-out');
    assert.equal(await page.getByText('Example Team Beta', { exact: true }).count(), 0, 'old account snapshot must not remain visible');
    assert.match(await page.locator('[role=alert]').innerText(), /Google sign-in is required/i);
  });

  await test('desktop, 900px and narrow invitation layouts remain usable with no browser errors', async () => {
    snapshotMode = 'example';
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('combobox', { name: 'Active team' }).waitFor();
    await page.setViewportSize({ width: 1280, height: 900 });
    const desktop = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.equal(desktop.scrollWidth <= desktop.width, true, `desktop overflow ${JSON.stringify(desktop)}`);
    await page.setViewportSize({ width: 900, height: 800 });
    const narrow = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.equal(narrow.scrollWidth <= narrow.width, true, `900px overflow ${JSON.stringify(narrow)}`);
    const tabsOverflow = await page.locator('.distributed__tabs').evaluate((tabs) => ({
      overflowY: getComputedStyle(tabs).overflowY,
      scrollHeight: tabs.scrollHeight,
      clientHeight: tabs.clientHeight,
    }));
    note(`INFO workspace tab strip rendered geometry: ${JSON.stringify(tabsOverflow)}`);
    assert.equal(tabsOverflow.overflowY, 'hidden', `workspace tabs should not create vertical scrolling: ${JSON.stringify(tabsOverflow)}`);
    assert.ok(tabsOverflow.scrollHeight <= tabsOverflow.clientHeight, `workspace tab strip has no vertical overflow: ${JSON.stringify(tabsOverflow)}`);
    await page.screenshot({ path: screenshots.narrow, fullPage: true });
    await selectTeam(EXAMPLE.teamA);
    await section('People').click();
    await page.setViewportSize({ width: 1280, height: 900 });
    const desktopInviteColumns = await page.locator('.dw-people-invite').evaluate((form) => getComputedStyle(form).gridTemplateColumns.trim().split(/\s+/).length);
    assert.equal(desktopInviteColumns, 3, 'email, role and invitation action align in one desktop row');
    await page.setViewportSize({ width: 560, height: 800 });
    const mobileInviteColumns = await page.locator('.dw-people-invite').evaluate((form) => ({
      columns: getComputedStyle(form).gridTemplateColumns.trim().split(/\s+/).length,
      width: form.getBoundingClientRect().width,
    }));
    assert.equal(mobileInviteColumns.columns, 1, `invitation form fields stack on narrow screens: ${JSON.stringify(mobileInviteColumns)}`);
    assert.ok(mobileInviteColumns.width > 0, 'narrow invitation form remains rendered');
    assert.deepEqual(pageErrors, [], `page/console runtime errors: ${pageErrors.join('; ')}`);
    const expectedHttpFailures = (response) =>
      (response.pathname === '/api/distributed/snapshot' && [401, 503].includes(response.status))
      || (response.pathname === `/api/distributed/approvals/${EXAMPLE.request}` && response.status === 409);
    const unexpectedResponses = nonOkResponses.filter((response) => !expectedHttpFailures(response));
    assert.deepEqual(unexpectedResponses, [], `unexpected HTTP failures: ${JSON.stringify(unexpectedResponses)}`);
    const unpairedConsoleErrors = [...consoleErrors];
    for (const response of nonOkResponses.filter(expectedHttpFailures)) {
      const consoleIndex = unpairedConsoleErrors.findIndex((message) => message.includes(`${response.status} (`));
      if (consoleIndex >= 0) unpairedConsoleErrors.splice(consoleIndex, 1);
    }
    assert.deepEqual(unpairedConsoleErrors, [], `console errors not explained by the exact expected failure routes: ${unpairedConsoleErrors.join('; ')}`);
  });

  note(`RESULT ${passed} passed, ${failures.length} failed; cloud/team positives are intercepted Example fixtures; no provider inference invoked`);
  note(`EVIDENCE screenshots=${Object.values(screenshots).join(', ')}`);
  note(`EVIDENCE logs=${logPath}`);
  if (failures.length) {
    for (const failure of failures) note(`UNRESOLVED ${failure.name}\n${failure.message}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  note(`FATAL ${message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
