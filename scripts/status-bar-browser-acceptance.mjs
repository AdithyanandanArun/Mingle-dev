#!/usr/bin/env node
/**
 * Browser acceptance for the expandable composer task strip.
 * Uses the disposable local FakeProviders runtime and injects only clearly labelled
 * Example progress events at the browser bootstrap boundary. Never submits inference.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const serverRequire = createRequire(new URL('../apps/server/package.json', import.meta.url));
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const tsxCli = serverRequire.resolve('tsx/cli');
const fixtureServer = fileURLToPath(new URL('./distributed-browser-fixtures.mjs', import.meta.url));
const viteModule = webRequire.resolve('vite');
const viteCli = path.resolve(path.dirname(viteModule), '../../bin/vite.js');
const outputDir = path.join(os.tmpdir(), `mingle-status-bar-acceptance-${process.pid}`);
const screenshots = {
  collapsed: path.join(outputDir, 'status-bar-collapsed.png'),
  expanded: path.join(outputDir, 'status-bar-expanded.png'),
  narrow390: path.join(outputDir, 'status-bar-expanded-390.png'),
};
mkdirSync(outputDir, { recursive: true });
const children = [];
const failures = [];
const consoleErrors = [];
let browser;
let page;
let serverReady = false;
let passed = 0;

function note(message) { process.stdout.write(`${message}\n`); }
function start(command, args, { cwd = root, name, env = {} } = {}) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  children.push({ child, name });
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', (chunk) => {
    if (name === 'local-example-runtime' && chunk.includes('READY ')) serverReady = true;
    if (process.env.STATUS_BAR_ACCEPTANCE_VERBOSE === '1') process.stdout.write(`[${name}] ${chunk}`);
  });
  child.on('error', (error) => note(`[${name}] ${error.message}`));
  return child;
}
async function ephemeralPort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { probe.once('listening', resolve); probe.once('error', reject); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}
async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (children.some(({ child }) => child.exitCode !== null && child.exitCode !== 0)) throw new Error(`${label}: child process exited early`);
    await delay(80);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function test(label, run) {
  try { await run(); passed++; note(`PASS ${label}`); }
  catch (error) { failures.push({ label, error: error instanceof Error ? error.stack : String(error) }); note(`FAIL ${label}: ${error instanceof Error ? error.message : error}`); }
}
async function closeAll() {
  if (browser) await browser.close().catch(() => {});
  for (const { child, name } of [...children].reverse()) {
    if (child.exitCode !== null) continue;
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(4000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    note(`INFO stopped ${name}`);
  }
}

async function main() {
  const { chromium } = serverRequire('playwright');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
  if (!existsSync(executablePath)) throw new Error(`Chromium executable not found: ${executablePath}`);
  const [apiPort, uiPort] = await Promise.all([ephemeralPort(), ephemeralPort()]);
  const uiUrl = `http://127.0.0.1:${uiPort}/`;
  const serverUrl = `http://127.0.0.1:${apiPort}`;
  const viteConfig = path.join(outputDir, 'vite.config.mjs');
  writeFileSync(viteConfig, `
    import { mergeConfig } from ${JSON.stringify(pathToFileURL(viteModule).href)};
    import base from ${JSON.stringify(pathToFileURL(path.join(root, 'apps/web/vite.config.ts')).href)};
    export default mergeConfig(base, { server: { port: ${uiPort}, strictPort: true, proxy: {
      '/api': { target: ${JSON.stringify(serverUrl)}, changeOrigin: false },
      '/ws': { target: ${JSON.stringify(serverUrl.replace('http', 'ws'))}, ws: true, changeOrigin: false },
    } } });
  `);
  start(process.execPath, [tsxCli, fixtureServer, '--serve'], { name: 'local-example-runtime', env: { MINGLE_BROWSER_API_PORT: String(apiPort), MINGLE_BROWSER_UI_PORT: String(uiPort) } });
  start(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort', '--config', viteConfig], { cwd: path.join(root, 'apps/web'), name: 'vite' });
  await waitFor(() => serverReady, 'disposable Example FakeProviders runtime');
  await waitFor(async () => (await fetch(uiUrl, { signal: AbortSignal.timeout(500) })).ok, 'Vite UI');

  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) consoleErrors.push(message.text()); });
  let refreshFixture = false;
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const boot = await response.json();
    boot.settings.onboardingCompletedVersion = 1;
    const project = boot.projects.find((item) => item.isExample);
    const sessions = boot.sessions.filter((item) => item.projectId === project?.id);
    assert.ok(project && sessions.length, 'Example workspace and sessions are present in the local fixture runtime');
    let id = Math.max(0, ...boot.events.map((event) => event.id)) + 1;
    for (const session of sessions) boot.events.push({ id: id++, projectId: project.id, sessionId: session.id, type: 'session.progress.plan',
      summary: 'Example-only status strip acceptance fixture', payload: { exampleFixture: true, planId: 'example-status-bar-plan', steps: [
          { id: 'example-status-done', title: 'Inspect the Example workspace', status: 'done' },
      { id: 'example-status-running', title: refreshFixture ? 'Updated Example progress after bootstrap refresh' : 'Render the expandable task strip', status: 'in_progress' },
          { id: 'example-status-pending', title: 'Check keyboard and viewport behavior', status: 'pending' },
          { id: 'example-status-blocked', title: 'Example blocked fixture state', status: 'blocked' },
      ] }, createdAt: new Date().toISOString() });
    await route.fulfill({ response, body: JSON.stringify(boot) });
  });
  await page.goto(uiUrl, { waitUntil: 'domcontentloaded' });
  const toggle = page.locator('.status-bar__toggle').first();
  try { await toggle.waitFor(); }
  catch (error) {
    note(`DEBUG page text: ${(await page.locator('body').innerText()).slice(0, 1200)}`);
    note(`DEBUG console: ${JSON.stringify(consoleErrors)}`);
    await page.screenshot({ path: path.join(outputDir, 'status-bar-debug.png'), fullPage: false });
    throw error;
  }
  const bar = page.locator('.status-bar').first();

  await test('default collapsed strip shows current title, done/total, and accessible control', async () => {
    const selected = await page.evaluate(async () => {
      const { useMingle } = await import('/src/store/store.ts');
      const state = useMingle.getState();
      const project = state.boot?.projects.find((item) => item.id === state.activeProjectId);
      const session = state.boot?.sessions.find((item) => item.id === state.sessionByProject[state.activeProjectId ?? '']);
      return { example: project?.isExample, sessionProjectId: session?.projectId, projectId: project?.id };
    });
    assert.equal(selected.example, true, `selected project is explicitly the Example workspace: ${JSON.stringify(selected)}`);
    assert.equal(selected.sessionProjectId, selected.projectId, `selected session belongs to the Example workspace: ${JSON.stringify(selected)}`);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.match(await toggle.innerText(), /Render the expandable task strip/);
    assert.match(await toggle.innerText(), /1\/4/);
    const controls = await toggle.getAttribute('aria-controls');
    assert.ok(controls);
    assert.equal(await page.locator(`#${controls}`).count(), 1, 'aria-controls points to the checklist');
    assert.equal(await page.locator(`#${controls}`).isVisible(), false);
    await page.screenshot({ path: screenshots.collapsed, fullPage: false });
  });

  await test('keyboard Enter and Space toggle the checklist and statuses stay truthful', async () => {
    await toggle.focus();
    await page.keyboard.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    const list = page.locator(`#${await toggle.getAttribute('aria-controls')}`);
    assert.equal(await list.locator('li').count(), 4);
    assert.deepEqual(await list.locator('.status-bar__step-state').allTextContents(), ['Done', 'In progress', 'Pending', 'Blocked']);
    await page.screenshot({ path: screenshots.expanded, fullPage: false });
    await page.keyboard.press('Space');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  });

  await test('expanded state survives a normal bootstrap state refresh', async () => {
    await toggle.click();
    refreshFixture = true;
    const appStore = await page.evaluate(async () => {
      const { useMingle } = await import('/src/store/store.ts');
      await useMingle.getState().refreshNow();
      return true;
    });
    assert.equal(appStore, true);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.match(await toggle.innerText(), /Updated Example progress after bootstrap refresh/);
  });

  await test('Escape collapses an expanded checklist', async () => {
    await toggle.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator(`#${await toggle.getAttribute('aria-controls')}`).isVisible(), false);
  });

  await test('390px and 900px viewports have no document or task-strip overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await toggle.click();
    await page.screenshot({ path: screenshots.narrow390, fullPage: false });
    for (const width of [390, 900]) {
      await page.setViewportSize({ width, height: 844 });
      const geometry = await bar.evaluate((element) => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
        bar: element.getBoundingClientRect().width, scroll: element.scrollWidth, client: element.clientWidth,
        row: element.querySelector('.status-bar__row').getBoundingClientRect().width }));
      assert.ok(geometry.document <= width, `document fits ${width}px: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.bar <= width && geometry.scroll <= geometry.client + 1 && geometry.row <= width,
        `strip fits ${width}px: ${JSON.stringify(geometry)}`);
    }
  });

  await test('reduced motion disables strip animation and expansion transition', async () => {
    const reduced = await page.evaluate(() => ({ bar: getComputedStyle(document.querySelector('.status-bar')).animationName,
      steps: getComputedStyle(document.querySelector('.status-bar__steps')).animationName,
      chevron: getComputedStyle(document.querySelector('.status-bar__chevron')).transitionDuration }));
    assert.equal(reduced.bar, 'none');
    assert.equal(reduced.steps, 'none');
    assert.ok(Number.parseFloat(reduced.chevron) <= 0.001, `chevron transition is effectively disabled: ${reduced.chevron}`);
  });

  await test('browser page has no unexpected console or render errors', async () => { assert.deepEqual(consoleErrors, []); });
  note(`INFO fixture: injected Example-only session.progress.plan on each local bootstrap response; no live provider inference, credentials, or cloud writes.`);
  note(`INFO screenshots: ${JSON.stringify(screenshots)}`);
  if (failures.length) throw new Error(`${failures.length} status bar check(s) failed`);
  note(`PASS ${passed} status-bar browser acceptance checks`);
}

try { await main(); }
finally { await closeAll(); }
