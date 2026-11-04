#!/usr/bin/env node
// Real SettingsPage and UsageSettings with disposable Example HTTP responses. No provider calls or host updates.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const webRoot = join(root, 'apps/web');
const web = createRequire(join(webRoot, 'package.json'));
const serverRequire = createRequire(join(root, 'apps/server/package.json'));
const { createServer } = await import(pathToFileURL(web.resolve('vite')).href);
const { chromium } = serverRequire('playwright');
const output = join(tmpdir(), `mingle-settings-usage-acceptance-${process.pid}`);
await mkdir(output, { recursive: true });

const future = new Date(Date.now() + 75 * 60_000).toISOString();
const old = new Date(Date.now() - 60_000).toISOString();
const window = (id, label, windowMinutes, usedPercent, remainingPercent, scope = null) => ({ id, label, windowMinutes, usedPercent, remainingPercent, resetAt: future, ...(scope ? { scope } : {}) });
const usage = (provider, overrides = {}) => ({
  provider, fetchedAt: new Date().toISOString(), status: 'partial', plan: 'Example plan',
  // Native Codex scopes its main bucket too; those windows must be visible without opening additional model limits.
  windows: provider === 'codex' ? [window('codex:primary', 'Five hour limit', 300, 140, 0, 'codex'), window('codex:secondary', 'Weekly limit', 10080, 35.5, 64.5, 'codex'), window('model', 'Model scoped', 15, null, null, 'Example model') ] : [],
  credits: null,
  resets: provider === 'codex' ? { available: 2, grants: [], detailsKnown: false, replenishesAt: future } : null,
  notices: ['Example provider note.'], ...overrides,
});
const snapshot = (provider, usageBody, reset = {}) => ({ provider, usage: usageBody, reset: { mode: provider === 'codex' ? 'native' : 'external', snapshotToken: provider === 'codex' ? 'example-snapshot-token' : null, externalUrl: provider === 'claude' ? 'https://claude.ai/settings/usage' : null, reason: null, ...reset } });
const exampleSettings = { defaultProvider: 'codex', defaultCodexModel: 'example-codex-model', defaultClaudeModel: 'example-claude-model', defaultEffort: 'medium', defaultIsolated: true, defaultPolicy: 'supervised', theme: 'dark', claudeExecutable: 'claude', codexExecutable: 'codex' };
const exampleProviders = ['codex', 'claude'].map((id) => ({ id, name: id === 'codex' ? 'Codex' : 'Claude', available: true, version: 'Example metadata', executable: null, reason: null, models: [{ id: `example-${id}-model`, name: `Example ${id} model`, reasoningEfforts: [{ id: 'medium', label: 'Medium' }] }] }));
const exampleBootstrap = { workflows: [], lastProjectId: null, projects: [], sessions: [], messages: [], tasks: [], events: [], approvals: [], plans: [], questions: [], providers: exampleProviders, settings: exampleSettings, version: 'Example fixture', runs: [], toolCalls: [], groups: [] };

let server, browser;
try {
  server = await createServer({
    configFile: join(webRoot, 'vite.config.ts'), root, appType: 'mpa',
    publicDir: join(webRoot, 'public'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    resolve: { alias: [
      { find: /^@mingle\/contracts$/, replacement: join(root, 'packages/contracts/src/index.ts') },
      { find: /^@mingle\/contracts\/(.*)$/, replacement: `${root}/packages/contracts/src/$1` },
      { find: 'react', replacement: join(webRoot, 'node_modules/react') },
      { find: 'react-dom', replacement: join(webRoot, 'node_modules/react-dom') },
    ], dedupe: ['react', 'react-dom'] },
  });
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(6000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let getCount = { codex: 0, claude: 0 }, postCount = 0, postBodies = [], postMode = 'fresh-read-failure', refreshCodex = false, releasePost, failNextPost = false;
  let deferNextCodexGet = false, releaseCodexGet, deferredCodexGetStarted = false, failNextUsageGet = false;
  await page.route('**/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url()), match = url.pathname.match(/^\/api\/providers\/(codex|claude)\/usage(?:\/reset)?$/);
    if (url.pathname === '/api/bootstrap') return route.fulfill({ json: exampleBootstrap });
    if (!match) return route.fulfill({ status: 404, json: { error: 'Example fixture route only.' } });
    const provider = match[1];
    if (request.method() === 'POST' && url.pathname.endsWith('/reset')) {
      postCount++; postBodies.push(request.postDataJSON());
      if (failNextPost) { failNextPost = false; await route.fulfill({ status: 503, json: { error: 'Example temporary connection failure.' } }); return; }
      if (postMode === 'blocked') await new Promise((resolve) => { releasePost = resolve; });
      if (postMode === 'conflict') { await route.fulfill({ status: 409, json: { error: 'Example snapshot became stale.' } }); return; }
      const resultSnapshot = postMode === 'fresh-read-failure' ? null : snapshot('codex', usage('codex', { windows: [window('5h', 'Five hour limit', 300, 12, 88)], resets: { available: 1, grants: [], detailsKnown: false, replenishesAt: future } }));
      await route.fulfill({ json: { outcome: 'reset', snapshot: resultSnapshot, notice: null } }); return;
    }
    getCount[provider]++;
    if (provider === 'codex' && url.searchParams.get('refresh') === 'true' && failNextUsageGet) {
      failNextUsageGet = false;
      await route.fulfill({ status: 503, json: { error: 'Example usage refresh unavailable.' } }); return;
    }
    if (provider === 'codex' && deferNextCodexGet) {
      deferNextCodexGet = false; deferredCodexGetStarted = true;
      await new Promise((resolve) => { releaseCodexGet = resolve; });
      try { await route.fulfill({ json: snapshot('codex', usage('codex', { windows: [window('stale', 'Stale pre-unmount example', 300, 1, 99)] })) }); } catch { /* request was aborted on category unmount */ }
      return;
    }
    if (provider === 'codex' && url.searchParams.get('refresh') === 'true' && refreshCodex) {
      const grantUsage = usage('codex', { resets: { available: 2, detailsKnown: true, replenishesAt: future, grants: [
        { id: 'expired-example', label: 'Expired example grant', expiresAt: old, grantedAt: old },
        { id: 'valid-example', label: 'Valid example grant', expiresAt: future, grantedAt: old },
      ] } });
      await route.fulfill({ json: snapshot('codex', grantUsage) }); return;
    }
    const data = provider === 'codex' ? snapshot('codex', usage('codex')) : snapshot('claude', usage('claude', { status: 'unavailable', notices: ['Example Claude usage unavailable.'] }));
    await route.fulfill({ json: data });
  });

  const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/settings-usage-browser-fixture.html`;
  await page.goto(url);
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.deepEqual(getCount, { codex: 0, claude: 0 }, 'opening General makes no provider usage requests');
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  await page.getByRole('heading', { name: 'Usage', exact: true }).waitFor();
  await page.getByText('Five hour limit', { exact: true }).waitFor();
  await page.getByText('Weekly limit', { exact: true }).waitFor();
  const scopedDetails = page.locator('.usage-settings__scoped');
  assert.equal(await scopedDetails.count(), 1, 'model-scoped windows have their own disclosure');
  assert.equal(await page.getByText('Model scoped', { exact: true }).isVisible(), false, 'scoped limits stay collapsed by default');
  assert.deepEqual(getCount, { codex: 1, claude: 1 }, 'the page reads each provider independently on entry');
  assert.equal(await page.getByText('140%').count(), 1, 'actual values above 100 percent remain visible');
  assert.equal(await page.getByText('Individual grant details are not reported.').count(), 1, 'unknown grant details are distinct from no grants');
  assert.equal(await page.getByRole('link', { name: /Open Claude Usage/ }).getAttribute('href'), 'https://claude.ai/settings/usage');
  assert.equal(await page.getByRole('link', { name: /Open Claude Usage/ }).getAttribute('target'), '_blank');
  assert.equal(await page.getByRole('link', { name: /Open Claude Usage/ }).getAttribute('rel'), 'noopener noreferrer');
  await page.waitForTimeout(1100);
  assert.deepEqual(getCount, { codex: 1, claude: 1 }, 'local countdown updates cause no idle network polling');
  await page.setViewportSize({ width: 390, height: 1500 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'narrow view has no horizontal overflow');
  await page.screenshot({ path: join(output, 'settings-usage-390px.png'), fullPage: true });
  await page.setViewportSize({ width: 900, height: 1500 });
  await page.screenshot({ path: join(output, 'settings-usage-900px.png'), fullPage: true });
  await scopedDetails.locator('summary').click();
  await page.getByText('Model scoped', { exact: true }).waitFor();
  assert.equal(await page.getByText(/15-minute window/).count(), 1, 'a short model-scoped window keeps its reported duration and scope distinct');
  assert.equal(await page.getByText('Not reported', { exact: true }).count() >= 2, true, 'unknown windows stay explicitly unknown');

  failNextUsageGet = true;
  await page.getByRole('button', { name: /Refresh Codex usage/ }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not refresh usage.' }).waitFor();
  await page.getByText('Five hour limit', { exact: true }).waitFor();
  assert.equal(await page.getByText('140%').count(), 1, 'failed refresh preserves and labels the last successful snapshot');

  await page.getByRole('button', { name: 'Use one available reset' }).click();
  const confirm = page.getByRole('group', { name: 'Confirm Codex reset' });
  await confirm.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Confirm Codex reset');
  await page.keyboard.press('Escape');
  await confirm.waitFor({ state: 'hidden' });
  assert.equal(postCount, 0, 'Escape cancels the inline confirmation without redeeming');
  await page.getByRole('button', { name: 'Use one available reset' }).click();
  const cancelConfirm = page.getByRole('group', { name: 'Confirm Codex reset' });
  await cancelConfirm.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(postCount, 0, 'cancelled confirmation does not redeem a reset');
  assert.ok(await page.getByRole('button', { name: /Refresh Codex usage/ }).evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration) <= 0.00001), 'reduced motion removes the control transition');

  postMode = 'conflict';
  await page.getByRole('button', { name: 'Use one available reset' }).click();
  await page.getByRole('group', { name: 'Confirm Codex reset' }).getByRole('button', { name: 'Use one reset' }).click();
  await page.getByRole('status').filter({ hasText: 'Example snapshot became stale.' }).waitFor();
  await page.getByText('Five hour limit', { exact: true }).waitFor();
  assert.equal(postCount, 1, 'a stale snapshot conflict triggers a fresh read without retrying the POST');

  postMode = 'blocked';
  const postCountBeforeDoubleClick = postCount;
  await page.getByRole('button', { name: 'Use one available reset' }).click();
  const confirmAgain = page.getByRole('group', { name: 'Confirm Codex reset' });
  const useButton = confirmAgain.getByRole('button', { name: 'Use one reset' });
  await useButton.dblclick();
  await page.waitForTimeout(100);
  assert.equal(postCount, postCountBeforeDoubleClick + 1, 'a double click issues exactly one reset POST');
  const firstBody = postBodies.at(-1);
  assert.match(firstBody.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(firstBody.snapshotToken, 'example-snapshot-token');
  releasePost();
  // First blocked POST succeeded. Refresh after the UI's bounded manual cooldown to show grants.
  await page.getByRole('status').filter({ hasText: 'Reset used.' }).waitFor();
  postMode = 'fresh-read-failure';
  await page.waitForTimeout(5100);
  await page.waitForFunction(() => {
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.getAttribute('aria-label') === 'Refresh Codex usage');
    return button && !button.disabled;
  });
  refreshCodex = true;
  await page.getByRole('button', { name: /Refresh Codex usage/ }).click();
  await page.getByText('Expired example grant', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Expired' }).isDisabled(), true, 'expired grants cannot be used');
  await page.getByRole('button', { name: 'Use this reset' }).click();
  const grantConfirm = page.getByRole('group', { name: 'Confirm Codex reset' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Confirm Codex reset');
  failNextPost = true;
  await grantConfirm.getByRole('button', { name: 'Use one reset' }).click();
  await page.getByRole('alert').filter({ hasText: 'The result is unknown.' }).waitFor();
  const uncertainBody = postBodies.at(-1);
  const postsBeforeRecovery = postCount;
  // A timeout may have spent a real credit. Refreshing, navigation and reload must retain its identity, never start anew.
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  await page.getByRole('button', { name: 'Retry same attempt' }).waitFor();
  await page.getByRole('button', { name: /Refresh Codex usage/ }).click();
  await page.getByText('Expired example grant', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Use this reset' }).isDisabled(), true, 'an unresolved attempt blocks another grant action');
  assert.equal(postCount, postsBeforeRecovery, 'refresh, navigation and reload never redeem automatically');
  await page.getByRole('button', { name: 'Retry same attempt' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('status').filter({ hasText: 'latest usage could not be loaded' }).waitFor();
  assert.deepEqual(postBodies.at(-1), uncertainBody, 'uncertain retry reuses UUID, snapshot token, and selected grant ID');
  assert.equal(await page.getByText('The latest usage could not be loaded; refresh to check current limits.', { exact: false }).count(), 1, 'a confirmed reset with no fresh snapshot does not claim refreshed bars');

  const claudeAnchor = page.getByRole('link', { name: /Open Claude Usage/ });
  assert.equal(await claudeAnchor.getAttribute('href'), 'https://claude.ai/settings/usage', 'Claude URL is fixed to the official destination');

  // The real settings category unmounts UsageSettings; a delayed old read cannot repopulate it after returning.
  const beforeLeaving = { ...getCount };
  await page.getByRole('button', { name: 'General', exact: true }).click();
  assert.deepEqual(getCount, beforeLeaving, 'leaving Usage causes no provider requests');
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  await page.getByText('Five hour limit', { exact: true }).waitFor();
  assert.deepEqual(getCount, { codex: beforeLeaving.codex + 1, claude: beforeLeaving.claude + 1 }, 're-entering Usage starts fresh independent reads');

  deferNextCodexGet = true;
  await page.getByRole('button', { name: /Refresh Codex usage/ }).click();
  for (let retry = 0; retry < 100 && !deferredCodexGetStarted; retry++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deferredCodexGetStarted, true, 'manual refresh starts the delayed Codex request');
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByRole('heading', { name: 'New sessions' }).waitFor();
  releaseCodexGet();
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  await page.getByText('Five hour limit', { exact: true }).waitFor();
  assert.equal(await page.getByText('Stale pre-unmount example', { exact: true }).count(), 0, 'an aborted refresh cannot apply after Usage unmount and re-entry');
  assert.deepEqual(getCount, { codex: beforeLeaving.codex + 3, claude: beforeLeaving.claude + 2 }, 'a fresh entry loads current snapshots after the old GET is abandoned');
  assert.deepEqual(pageErrors, []);
  console.log(`Settings Usage browser acceptance passed. Screenshots: ${output}`);
} finally { await browser?.close(); await server?.close(); }
