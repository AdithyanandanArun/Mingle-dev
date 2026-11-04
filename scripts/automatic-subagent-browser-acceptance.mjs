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
    export default mergeConfig(base, { resolve: { alias: [
      { find: /^@mingle\\/contracts$/, replacement: ${JSON.stringify(path.join(root, 'packages/contracts/src/index.ts'))} },
      { find: /^@mingle\\/contracts\\/(.*)$/, replacement: ${JSON.stringify(`${path.join(root, 'packages/contracts/src')}/$1`)} },
    ] }, server: { port: ${uiPort}, strictPort: true, proxy: {
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
  // Every non-GET request made by the page, so suites can prove that no deletion or inference request was sent.
  const mutations = [];
  page.on('request', (request) => { if (request.method() !== 'GET') mutations.push(`${request.method()} ${new URL(request.url()).pathname}`); });
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
    const project = boot.projects.find((item) => item.isExample) ?? boot.projects[0];
    assert.ok(project, 'Example fixture project exists');
    project.isExample = false;
    boot.lastProjectId = project.id;
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
  const refresh = async () => {
    await page.evaluate(async () => { const { useMingle } = await import('/src/store/store.ts'); await useMingle.getState().refreshNow(); });
  };
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

  // Scene builder for mixed native and Mingle-delegated subagents. A logical subagent keeps one `id` across scenes so
  // transitions are real status changes to the same record rather than replacements.
  const nativeCall = (item, at) => ({
    id: `example-${item.id}`, providerId: `example-${item.id}-native`, runId: 'example-native-run', sessionId: selected.id,
    parentProviderId: null, category: 'agent', name: 'Agent', status: item.status, summary: item.label, command: null,
    input: JSON.stringify({ description: item.label, prompt: `Review ${item.label}`, model: 'example-child-model' }),
    output: item.status === 'completed' ? 'Example review finished.' : '', cwd: null, exitCode: null, processId: null,
    startedAt: at, finishedAt: item.status === 'running' ? null : at, durationMs: null,
    subagentMessages: item.status === 'completed' ? [{ id: `example-${item.id}-reply`, content: 'Example source is ready.', createdAt: at }] : [] });
  const delegatedRecord = (item, at) => ({
    id: `example-${item.id}`, parentSessionId: selected.id, childSessionId: `example-child-${item.id}`,
    name: item.name, provider: 'claude', model: 'example-model', task: `Example ${item.name} task`,
    status: item.status, requestedBy: 'agent', startedAt: at, endedAt: item.status === 'running' ? null : at,
    resultPreview: item.status === 'completed' ? 'Example delegated result.' : null,
    error: item.status === 'failed' ? 'Example delegated failure' : null, resultDelivered: item.status !== 'running' });
  const childSession = (parent, item, at) => ({ ...parent, id: `example-child-${item.id}`, name: `Example ${item.name} child`,
    parentSessionId: selected.id, status: item.childStatus ?? 'idle', providerSessionId: null, pinned: false, unread: false,
    createdAt: at, updatedAt: at, error: item.status === 'failed' ? 'Example delegated failure' : null });
  const scene = ({ native = [], delegated = [] }) => (boot) => {
    const at = new Date().toISOString();
    const parent = boot.sessions.find((s) => s.id === selected.id);
    boot.sessions = boot.sessions.map((s) => s.id === selected.id ? { ...s, provider: 'claude', status: 'running' } : s);
    boot.messages.push({ id: 'example-parent-request', sessionId: selected.id, role: 'user', content: 'Build a coffee shop website', createdAt: at });
    boot.toolCalls.push(...native.map((item) => nativeCall(item, at)));
    boot.delegatedSubagents = [...(boot.delegatedSubagents ?? []), ...delegated.map((item) => delegatedRecord(item, at))];
    boot.sessions.push(...delegated.map((item) => childSession(parent, item, at)));
  };
  // Reads only what the user can see: the header count, the live list rows and each history section's count and open state.
  const railCounts = () => page.evaluate(() => {
    const node = document.querySelector('.single-subagents');
    if (!node) return null;
    const section = (label) => [...node.querySelectorAll('details.single-subagents__history')].find((item) => item.querySelector('summary')?.textContent.includes(label));
    const count = (label) => Number(section(label)?.querySelector('summary > span')?.textContent ?? 0);
    return {
      header: node.querySelector('.agent-presence__head > span')?.textContent.trim() ?? null,
      live: node.querySelectorAll('ul[aria-label="Live subagents"] > li').length,
      finished: count('Finished'),
      unsuccessful: count('Cancelled / failed'),
    };
  });
  const expectRail = async (expected) => {
    let actual = null;
    try {
      await waitFor(async () => {
        actual = await railCounts();
        return actual !== null && Object.entries(expected).every(([key, value]) => actual[key] === value);
      }, `subagent rail ${JSON.stringify(expected)}`, 7000);
    } catch (error) {
      throw new Error(`subagent rail expected ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`);
    }
  };
  const historySection = (label) => rail.locator('details.single-subagents__history').filter({ hasText: label });
  const isHistoryOpen = (label) => historySection(label).evaluate((node) => node.open);
  const openHistory = async (label) => {
    if (await isHistoryOpen(label)) return;
    await historySection(label).locator('summary').focus();
    await page.keyboard.press('Enter');
    await waitFor(() => isHistoryOpen(label), `${label} history opened`);
  };
  const row = (name) => rail.getByRole('button', { name, exact: true, includeHidden: true });
  const delegatedRowName = (name) => `Open @${name} subagent session`;

  await test('workspace header keeps labels and icons inside their own bounds', async () => {
    fixture = (boot) => {
      boot.projects = boot.projects.map((project) => ({ ...project, name: 'Example project with a long name that must truncate' }));
      boot.sessions = boot.sessions.map((session) => ({ ...session, name: 'Example session with a long name that must truncate' }));
    };
    await refresh();
    try {
      for (const width of [1440, 1280, 1101, 1100, 900, 600, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const layout = await page.locator('.header').evaluate((header) => {
          const bounds = (node) => {
            if (!node) return null;
            const r = node.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
          };
          return {
            header: bounds(header),
            badge: bounds(header.querySelector('.header__example')),
            actions: bounds(header.querySelector('.header__actions')),
            buttons: [...header.querySelectorAll('.header__compact-action')].map((button) => ({
              name: button.getAttribute('aria-label'), rect: bounds(button),
              icon: bounds(button.querySelector('svg')),
              label: bounds(button.querySelector('span:not(.sr-only)')),
            })),
          };
        });
        assert.ok(layout.actions.right <= width + 1, `header actions stay on screen at ${width}px`);
        assert.equal(layout.badge, null, `a selected normal project has no starter Example badge at ${width}px`);
        for (const button of layout.buttons) {
          assert.ok(button.icon.width >= 13, `${button.name} retains its icon at ${width}px`);
          assert.ok(button.icon.left >= button.rect.left && button.icon.right <= button.rect.right, `${button.name} icon stays inside its button at ${width}px`);
          if (width > 1100) {
            assert.ok(button.label.width > 0 && button.label.left >= button.rect.left && button.label.right <= button.rect.right,
              `${button.name} desktop label stays inside its button at ${width}px: ${JSON.stringify(button)}`);
          } else {
            assert.equal(button.label.width, 0, `${button.name} uses an accessible icon-only action at ${width}px`);
          }
        }
        if (width === 1280 || width === 390) await page.screenshot({ path: path.join(outputDir, `header-${width}.png`) });
      }
    } finally {
      fixture = null;
      await refresh();
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  });
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
  await test('completed child stays in collapsed history until opened; result inspection; back preserves the parent draft', async () => {
    fixture = makeActivity('claude', 'Agent', 'completed');
    await refresh();
    await page.locator('.composer textarea').fill('Keep my draft');
    await expectRail({ header: '0 live', live: 0, finished: 1, unsuccessful: 0 });
    assert.equal(await isHistoryOpen('Finished'), false, 'finished history starts collapsed');
    assert.equal(await row('Open @example-source-review subagent chat, Done').isVisible(), false, 'finished child is hidden until its section opens');
    await openHistory('Finished');
    await page.getByRole('button', { name: 'Open @example-source-review subagent chat, Done', exact: true }).click();
    const detail = page.locator('.single-subagent-view');
    await detail.getByText('Example source is ready.', { exact: true }).waitFor();
    await detail.getByText('Example review finished.', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(outputDir, 'automatic-child-result.png') });
    await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
    assert.equal(await page.locator('.composer textarea').inputValue(), 'Keep my draft');
  });
  await test('model-callable Mingle delegation appears in the floating bubble independently of progress', async () => {
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
    if (await rail.getByRole('button', { name: 'Expand subagents' }).count()) await rail.getByRole('button', { name: 'Expand subagents' }).click();
    assert.equal(await rail.getByRole('button', { name: /^(Expand|Collapse) subagents$/ }).count(), 1, 'the floating bubble owns helper expansion');
    assert.equal(await page.locator('.composer-surface .single-subagents').count(), 0);
    assert.equal(await page.locator('.status-bar').count(), 1);
  });
  await test('mixed native and delegated statuses: live rows first, history sections collapsed by default', async () => {
    fixture = scene({
      native: [
        { id: 'mix-native-running', label: 'Example native running', status: 'running' },
        { id: 'mix-native-done', label: 'Example native done', status: 'completed' },
        { id: 'mix-native-interrupted', label: 'Example native interrupted', status: 'interrupted' },
      ],
      delegated: [
        { id: 'mix-delegated-running', name: 'example-delegated-running', status: 'running', childStatus: 'idle' },
        { id: 'mix-delegated-failed', name: 'example-delegated-failed', status: 'failed', childStatus: 'error' },
        { id: 'mix-delegated-cancelled', name: 'example-delegated-cancelled', status: 'cancelled', childStatus: 'idle' },
        { id: 'mix-delegated-done', name: 'example-delegated-done', status: 'completed', childStatus: 'idle' },
      ],
    });
    await refresh();
    await expectRail({ header: '2 live', live: 2, finished: 2, unsuccessful: 3 });
    const live = rail.getByRole('list', { name: 'Live subagents' });
    await live.getByRole('button', { name: 'Open @example-native-running subagent chat, Running', exact: true }).waitFor();
    await live.getByRole('button', { name: delegatedRowName('example-delegated-running'), exact: true }).waitFor();
    assert.equal(await isHistoryOpen('Finished'), false);
    assert.equal(await isHistoryOpen('Cancelled / failed'), false);
    assert.equal(await row('Open @example-native-done subagent chat, Done').isVisible(), false);
    assert.equal(await row('Open @example-native-interrupted subagent chat, Interrupted').isVisible(), false);
    assert.equal(await rail.getByRole('button', { name: delegatedRowName('example-delegated-done'), exact: true, includeHidden: true }).isVisible(), false);
    await openHistory('Cancelled / failed');
    assert.equal(await row('Open @example-native-interrupted subagent chat, Interrupted').isVisible(), true, 'native interrupted run is grouped as cancelled or failed');
    assert.equal(await rail.getByRole('button', { name: delegatedRowName('example-delegated-failed'), exact: true }).isVisible(), true);
    assert.equal(await rail.getByRole('button', { name: delegatedRowName('example-delegated-cancelled'), exact: true }).isVisible(), true);
  });
  await test('keyboard expands history and inspects archived native and delegated subagents', async () => {
    await refresh();
    await openHistory('Finished');
    const nativeDone = row('Open @example-native-done subagent chat, Done');
    await nativeDone.focus();
    await page.keyboard.press('Enter');
    const detail = page.locator('.single-subagent-view');
    await detail.getByText('Example source is ready.', { exact: true }).waitFor();
    await detail.getByText('Example review finished.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back to conversation', exact: true }).focus();
    await page.keyboard.press('Enter');
    await detail.waitFor({ state: 'detached' });
    await expectRail({ header: '2 live', live: 2, finished: 2, unsuccessful: 3 });
    assert.equal(await isHistoryOpen('Finished'), true, 'the expanded section stays open after returning');
    await openHistory('Cancelled / failed');
    const delegatedFailed = rail.getByRole('button', { name: delegatedRowName('example-delegated-failed'), exact: true });
    await delegatedFailed.focus();
    await page.keyboard.press('Enter');
    await waitFor(async () => page.evaluate(async (childId) => {
      const { useMingle } = await import('/src/store/store.ts');
      const s = useMingle.getState();
      return s.sessionByProject[s.activeProjectId] === childId;
    }, 'example-child-mix-delegated-failed'), 'delegated child session selected from the keyboard');
    await page.evaluate(async (id) => {
      const { useMingle } = await import('/src/store/store.ts');
      useMingle.getState().selectSession(id);
    }, selected.id);
    await waitFor(async () => page.evaluate(async (id) => {
      const { useMingle } = await import('/src/store/store.ts');
      const s = useMingle.getState();
      return s.sessionByProject[s.activeProjectId] === id;
    }, selected.id), 'parent session restored after inspecting the delegated child');
  });
  await test('running rows move between live and history as authoritative status changes, and the bubble remains for history only', async () => {
    await page.locator('.composer textarea').fill('Keep my draft');
    const nativeA = { id: 'move-native', label: 'Example moving native' };
    const delegatedB = { id: 'move-delegated', name: 'example-moving-delegated' };
    fixture = scene({ native: [{ ...nativeA, status: 'running' }], delegated: [{ ...delegatedB, status: 'running', childStatus: 'running' }] });
    await refresh();
    await expectRail({ header: '2 live', live: 2, finished: 0, unsuccessful: 0 });
    // running -> failed (native) and running -> cancelled (delegated)
    fixture = scene({ native: [{ ...nativeA, status: 'failed' }], delegated: [{ ...delegatedB, status: 'cancelled', childStatus: 'idle' }] });
    await refresh();
    await expectRail({ header: '0 live', live: 0, finished: 0, unsuccessful: 2 });
    assert.equal(await rail.count(), 1, 'the bubble remains when only history exists');
    assert.equal(await rail.locator('.single-subagents__empty').textContent(), 'No live subagents');
    // Returning to running only through a refreshed authoritative status; the failed native run never comes back.
    fixture = scene({ native: [{ ...nativeA, status: 'failed' }], delegated: [{ ...delegatedB, status: 'running', childStatus: 'waiting' }] });
    await refresh();
    await expectRail({ header: '1 live', live: 1, finished: 0, unsuccessful: 1 });
    await rail.getByRole('button', { name: delegatedRowName('example-moving-delegated'), exact: true }).waitFor();
    // running -> completed
    fixture = scene({ native: [{ ...nativeA, status: 'failed' }], delegated: [{ ...delegatedB, status: 'completed', childStatus: 'idle' }] });
    await refresh();
    await expectRail({ header: '0 live', live: 0, finished: 1, unsuccessful: 1 });
    assert.equal(await page.locator('.composer textarea').inputValue(), 'Keep my draft', 'the parent draft survives every transition');
  });
  await test('sidebar nests only running delegated children, including idle and waiting ones, and follows their status', async () => {
    fixture = scene({ native: [], delegated: [
      { id: 'side-idle', name: 'example-side-idle', status: 'running', childStatus: 'idle' },
      { id: 'side-waiting', name: 'example-side-waiting', status: 'running', childStatus: 'waiting' },
      { id: 'side-done', name: 'example-side-done', status: 'completed', childStatus: 'running' },
      { id: 'side-failed', name: 'example-side-failed', status: 'failed', childStatus: 'error' },
    ] });
    await refresh();
    const parentRow = page.locator(`.sidebar .sitem-row[data-session-id="${selected.id}"]`);
    const toggle = parentRow.locator('.sitem__child-toggle');
    await toggle.waitFor();
    assert.match(await toggle.textContent(), /2 subagents/);
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    const nestedIds = () => page.locator('.sidebar .sitem-row--child').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-session-id')).sort());
    await waitFor(async () => JSON.stringify(await nestedIds()) === JSON.stringify(['example-child-side-idle', 'example-child-side-waiting']), 'only running delegated children nested');
    assert.deepEqual(await nestedIds(), ['example-child-side-idle', 'example-child-side-waiting']);
    assert.equal(await page.locator('.sidebar .sitem-row--child[data-session-id="example-child-side-waiting"] .sdot--waiting').count(), 1, 'a waiting child keeps its waiting dot');
    assert.equal(await page.locator('.sidebar .sitem-row--child[data-session-id="example-child-side-idle"] .sdot--running').count(), 1, 'an idle child during startup still reads as running');
    // Only the delegated record decides: the completed helper's child is still running and must not reappear.
    fixture = scene({ native: [], delegated: [
      { id: 'side-idle', name: 'example-side-idle', status: 'completed', childStatus: 'running' },
      { id: 'side-waiting', name: 'example-side-waiting', status: 'running', childStatus: 'waiting' },
      { id: 'side-done', name: 'example-side-done', status: 'completed', childStatus: 'running' },
      { id: 'side-failed', name: 'example-side-failed', status: 'failed', childStatus: 'error' },
    ] });
    await refresh();
    await waitFor(async () => JSON.stringify(await nestedIds()) === JSON.stringify(['example-child-side-waiting']), 'finished helper leaves the sidebar');
    assert.match(await parentRow.locator('.sitem__child-toggle').textContent(), /1 subagent/);
    fixture = scene({ native: [], delegated: [
      { id: 'side-idle', name: 'example-side-idle', status: 'completed', childStatus: 'idle' },
      { id: 'side-waiting', name: 'example-side-waiting', status: 'failed', childStatus: 'idle' },
      { id: 'side-done', name: 'example-side-done', status: 'completed', childStatus: 'idle' },
      { id: 'side-failed', name: 'example-side-failed', status: 'failed', childStatus: 'idle' },
    ] });
    await refresh();
    await waitFor(async () => (await parentRow.locator('.sitem__child-toggle').count()) === 0, 'no sidebar toggle without live helpers');
    assert.equal(await page.locator('.sidebar .sitem-row--child').count(), 0);
  });
  await test('root session stays a single top-level row, keeps its conversation and draft, and no delete or inference request is sent', async () => {
    const parentRow = page.locator(`.sidebar .sitem-row[data-session-id="${selected.id}"]`);
    assert.equal(await parentRow.count(), 1, 'the root session row is listed exactly once');
    assert.equal(await page.locator(`.sidebar .sitem-row--child[data-session-id="${selected.id}"]`).count(), 0, 'the root is never nested as a child');
    assert.equal(await page.locator('.chat__scroll').count(), 1, 'the root conversation stays mounted');
    assert.equal(await page.locator('.composer textarea').inputValue(), 'Keep my draft');
    const sessionState = await page.evaluate(async (id) => {
      const { useMingle } = await import('/src/store/store.ts');
      const s = useMingle.getState();
      return { active: s.sessionByProject[s.activeProjectId], children: s.boot.sessions.filter((item) => item.parentSessionId === id).length,
        delegated: s.boot.delegatedSubagents?.length ?? 0 };
    }, selected.id);
    assert.equal(sessionState.active, selected.id, 'the root remains the active session');
    assert.ok(sessionState.children > 0 && sessionState.delegated > 0, 'child sessions and delegated records are kept, not removed');
    assert.deepEqual(mutations.filter((entry) => entry.startsWith('DELETE ') || /\/messages$/.test(entry)), [], 'no deletion or inference request was sent');
    assert.equal(manualRequests, 0);
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
