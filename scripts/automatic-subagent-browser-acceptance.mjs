#!/usr/bin/env node
/**
 * Browser acceptance for automatic model-spawned subagent display.
 * Uses the disposable local FakeProviders runtime and injects only clearly labelled
 * Example provider-reported agent activity at the browser bootstrap boundary. Never submits inference.
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
const outputDir = path.join(os.tmpdir(), `mingle-auto-subagent-acceptance-${process.pid}`);
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
    if (process.env.SUBAGENT_ACCEPTANCE_VERBOSE === '1') process.stdout.write(`[${name}] ${chunk}`);
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
  let fixture = null;
  let seed;
  let manualRequests = 0;
  await page.route('**/api/sessions/*/subagents', async (route) => {
    if (route.request().method() === 'POST') manualRequests++;
    await route.continue();
  });
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const boot = await response.json();
    boot.settings.onboardingCompletedVersion = 1;
    seed = boot;
    if (fixture) fixture(boot);
    await route.fulfill({ response, body: JSON.stringify(boot) });
  });
  await page.route('**/api/runs/example-native-run/tools', async (route) => {
    const boot = structuredClone(seed);
    fixture?.(boot);
    await route.fulfill({ json: boot.toolCalls.filter((call) => call.runId === 'example-native-run') });
  });
  await page.goto(uiUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('.composer textarea').waitFor();
  const selected = await page.evaluate(async () => {
    const { useMingle } = await import('/src/store/store.ts');
    const s = useMingle.getState();
    return s.boot.sessions.find((session) => session.id === s.sessionByProject[s.activeProjectId]);
  });
  const refresh = () => page.evaluate(async () => {
    const { useMingle } = await import('/src/store/store.ts');
    await useMingle.getState().refreshNow();
  });
  const rail = page.locator('.single-subagents');
  const makeActivity = (provider, name, status = 'running') => (boot) => {
    const at = new Date().toISOString();
    boot.sessions = boot.sessions.map((s) => s.id === selected.id ? { ...s, provider, status: 'running' } : s);
    boot.messages.push({ id: 'example-parent-request', sessionId: selected.id, role: 'user', content: 'Build a coffee shop website', createdAt: at });
    boot.toolCalls.push({ id: 'example-spawn', providerId: 'example-spawn-native', runId: 'example-native-run', sessionId: selected.id,
      parentProviderId: null, category: 'agent', name, status, summary: 'Example automatic review', command: null,
      input: JSON.stringify({ description: 'Example source review', prompt: 'Review the Example source', model: 'example-child-model' }),
      output: status === 'completed' ? 'Example review finished.' : '', cwd: null, exitCode: null, processId: null,
      startedAt: at, finishedAt: status === 'completed' ? at : null, durationMs: null,
      subagentMessages: status === 'completed' ? [{ id: 'example-child-reply', content: 'Example source is ready.', createdAt: at }] : [] });
  };
  await test('composer has no manual launcher or empty subagent rail', async () => {
    assert.equal(await page.getByRole('button', { name: 'Start a subagent', exact: true }).count(), 0);
    assert.equal(await rail.count(), 0);
  });
  for (const [provider, name] of [['claude', 'Agent'], ['codex', 'agent:spawnAgent'], ['opencode', 'task']]) {
    await test(`${provider} child appears automatically on activity with no explicit delegation request`, async () => {
      fixture = makeActivity(provider, name);
      await refresh();
      await rail.waitFor();
      if (await rail.getByRole('button', { name: 'Expand subagents' }).count()) await rail.getByRole('button', { name: 'Expand subagents' }).click();
      await page.getByRole('button', { name: 'Open @example-source-review subagent chat, Running', exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog', { name: 'Start a subagent' }).count(), 0);
    });
  }
  await test('completed child opens its messages and result; back preserves the parent draft', async () => {
    fixture = makeActivity('claude', 'Agent', 'completed');
    await refresh();
    await page.locator('.composer textarea').fill('Keep my draft');
    await page.getByRole('button', { name: 'Open @example-source-review subagent chat, Done', exact: true }).click();
    const detail = page.locator('.single-subagent-view');
    await detail.getByText('Example source is ready.', { exact: true }).waitFor();
    await detail.getByText('Example review finished.', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(outputDir, 'automatic-child-result.png') });
    await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
    assert.equal(await page.locator('.composer textarea').inputValue(), 'Keep my draft');
  });
  await test('model-callable Mingle delegation also appears automatically and expands on arrival', async () => {
    fixture = null; await refresh();
    assert.equal(await rail.count(), 0);
    fixture = (boot) => {
      const at = new Date().toISOString();
      boot.delegatedSubagents = [{ id: 'example-model-delegation', parentSessionId: selected.id, childSessionId: 'example-child',
        name: 'example-reviewer', provider: 'claude', model: 'example-model', task: 'Review Example source',
        status: 'running', requestedBy: 'agent', startedAt: at, endedAt: null, resultPreview: null, error: null, resultDelivered: false }];
    };
    await refresh();
    await rail.getByRole('button', { name: 'Open @example-reviewer subagent session', exact: true }).waitFor();
    assert.equal(await rail.getByRole('button', { name: 'Collapse subagents' }).getAttribute('aria-expanded'), 'true');
  });
  await test('narrow view remains bounded and there are no manual launch requests', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const rect = await rail.boundingBox();
    assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= 391);
    assert.equal(manualRequests, 0);
    assert.equal(await page.getByRole('button', { name: 'Start a subagent', exact: true }).count(), 0);
    await page.screenshot({ path: path.join(outputDir, 'automatic-subagents-390.png') });
    assert.deepEqual(consoleErrors, []);
  });
  note('INFO Example-only provider activity fixtures; no inference or cloud writes. Real adapter and persistence paths are checked separately by unit/integration tests.');
  note(`INFO screenshots: ${outputDir}`);
  if (failures.length) throw new Error(`${failures.length} automatic subagent check(s) failed`);
  note(`PASS ${passed} automatic subagent browser acceptance checks`);
}
try { await main(); }
finally { await closeAll(); }
