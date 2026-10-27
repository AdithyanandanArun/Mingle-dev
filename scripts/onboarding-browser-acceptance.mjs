import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { createServer: createViteServer } = webRequire('vite');
const reactPlugin = webRequire('@vitejs/plugin-react').default;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
if (!existsSync(executablePath)) {
  throw new Error(`Chromium executable not found at ${executablePath}. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an existing browser; this script never installs one.`);
}

const outputDir = process.env.MINGLE_ONBOARDING_ACCEPTANCE_OUT ?? join(tmpdir(), `mingle-onboarding-acceptance-${process.pid}`);
await mkdir(outputDir, { recursive: true });

let apiProcess;
let viteServer;
let browser;
let apiLogs = '';
let authTransitionTimer;
let accountMode = 'signed-out';
let failSignInOnce = false;
let failAccountReadOnce = false;
let nextSignInDelayMs = 800;
let signInRequests = 0;
let cancelRequests = 0;
const pageErrors = [];

async function reservePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(url, child, label, logs) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) throw new Error(`${label} exited during startup:\n${logs()}`);
    try { if ((await fetch(url)).ok) return; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} failed to start:\n${logs()}`);
}

async function waitForReady(child, logs) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) throw new Error(`Disposable FakeProviders runtime exited during startup:\n${logs()}`);
    const line = logs().split('\n').find((entry) => entry.startsWith('READY '));
    if (line) return JSON.parse(line.slice('READY '.length));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Disposable FakeProviders runtime failed to start:\n${logs()}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 4_000);
  try { await exited; } finally { clearTimeout(timer); }
}

function exampleAccount(status) {
  return {
    configured: true,
    connection: null,
    configurationSource: 'device',
    status,
    user: status === 'signed-in' ? { id: 'example-onboarding-account', email: 'ada@example.test', name: 'Example Ada' } : null,
    sessionStorage: 'memory',
    storage: { status: 'unavailable', backend: null, reason: 'web-runtime', retryable: false },
    error: null,
    authorizationUrl: null,
    browserError: null,
    exampleFixture: 'onboarding-browser-acceptance',
  };
}

function fixtureJson(value, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(value) };
}

function scheduleAccountSuccess() {
  clearTimeout(authTransitionTimer);
  if (nextSignInDelayMs < 0) return;
  authTransitionTimer = setTimeout(() => { accountMode = 'signed-in'; }, nextSignInDelayMs);
}

try {
  const webPort = await reservePort();
  apiProcess = spawn(process.execPath, [
    '--import', join(root, 'apps/server/node_modules/tsx/dist/loader.mjs'),
    join(root, 'scripts/onboarding-browser-server.mjs'),
  ], {
    cwd: root,
    env: {
      ...process.env,
      MINGLE_ONBOARDING_WEB_PORT: String(webPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiProcess.stdout.on('data', (chunk) => { apiLogs = (apiLogs + chunk).slice(-12_000); });
  apiProcess.stderr.on('data', (chunk) => { apiLogs = (apiLogs + chunk).slice(-12_000); });
  const fixtureReady = await waitForReady(apiProcess, () => apiLogs);
  assert.equal(fixtureReady.exampleWorkspace, true);
  assert.equal(fixtureReady.providers, 'FakeProviders');
  const apiBase = fixtureReady.url;
  await waitFor(`${apiBase}/api/health`, apiProcess, 'Disposable local service', () => apiLogs);

  viteServer = await createViteServer({
    configFile: false,
    root: join(root, 'apps/web'),
    plugins: [reactPlugin()],
    server: {
      host: '127.0.0.1', port: webPort, strictPort: true,
      proxy: {
        '/api': { target: apiBase, changeOrigin: false },
        '/ws': { target: apiBase.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
      },
    },
  });
  await viteServer.listen();
  const webBase = `http://127.0.0.1:${webPort}`;

  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const routeApi = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/account' && request.method() === 'GET') {
      if (failAccountReadOnce) {
        failAccountReadOnce = false;
        await route.fulfill(fixtureJson({ error: 'Example account status could not be reached.' }, 503));
        return;
      }
      await route.fulfill(fixtureJson(exampleAccount(accountMode)));
      return;
    }
    if (url.pathname === '/api/account/sign-in' && request.method() === 'POST') {
      signInRequests++;
      if (failSignInOnce) {
        failSignInOnce = false;
        await route.fulfill(fixtureJson({ error: 'Example Google sign-in could not be started.' }, 503));
        return;
      }
      accountMode = 'signing-in';
      scheduleAccountSuccess();
      await route.fulfill(fixtureJson(exampleAccount('signing-in')));
      return;
    }
    if (url.pathname === '/api/account/sign-in' && request.method() === 'DELETE') {
      cancelRequests++;
      clearTimeout(authTransitionTimer);
      accountMode = 'signed-out';
      await route.fulfill(fixtureJson(exampleAccount('signed-out')));
      return;
    }
    try {
      const upstream = await route.fetch({ url: `${apiBase}${url.pathname}${url.search}` });
      await route.fulfill({ response: upstream });
    } catch {
      await route.fulfill(fixtureJson({ error: 'Disposable local service request failed.' }, 502));
    }
  };

  const invitePage = await context.newPage();
  invitePage.on('pageerror', (error) => pageErrors.push(error.message));
  await invitePage.route('**/api/**', routeApi);
  await invitePage.goto(`${webBase}/?join=not-a-real-token`, { waitUntil: 'domcontentloaded' });
  await invitePage.getByText(/invitation link is incomplete or invalid/i).waitFor();
  assert.equal(await invitePage.locator('.onboarding__dialog').count(), 0, 'An active invitation takes priority over first-launch welcome.');
  assert.equal(new URL(invitePage.url()).searchParams.has('join'), false, 'The invitation query is removed after capture.');
  await invitePage.close();
  console.log('PASS invitation priority: example invalid invite remains visible without onboarding in front of it.');

  const popoutPage = await context.newPage();
  popoutPage.on('pageerror', (error) => pageErrors.push(error.message));
  await popoutPage.route('**/api/**', routeApi);
  await popoutPage.goto(`${webBase}/?browserPopout=example-session`, { waitUntil: 'domcontentloaded' });
  await popoutPage.getByText('This session is not available.').waitFor();
  assert.equal(await popoutPage.getByRole('dialog').count(), 0, 'The browser popout skips onboarding.');
  await popoutPage.close();
  console.log('PASS browser popout: standalone browser window skips onboarding.');

  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/api/**', routeApi);
  await page.goto(webBase, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: /Make room for good work/i }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1, 'First launch shows one accessible onboarding dialog.');
  assert.equal(await page.evaluate(() => document.activeElement?.id === 'onboarding-title'), true, 'Initial focus moves into the onboarding dialog.');
  assert.equal(await page.locator('.onboarding-background').getAttribute('inert'), '', 'The workspace behind onboarding is inert.');
  assert.equal(await page.getByRole('button', { name: 'Continue without an account' }).isVisible(), true, 'Account setup can always be skipped.');
  await page.locator('.onboarding__close').focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('onboarding__skip')), true, 'Shift+Tab wraps to the final dialog control.');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('onboarding__close')), true, 'Tab wraps to the first dialog control.');
  await page.locator('[data-onboarding-heading]').focus();
  await page.screenshot({ path: join(outputDir, 'welcome-desktop.png'), fullPage: true, animations: 'disabled' });

  await page.getByRole('button', { name: 'Continue without an account' }).click();
  await page.getByRole('heading', { name: /Your tools, your choice/i }).waitFor();
  const bootstrap = await page.evaluate(async () => await (await fetch('/api/bootstrap')).json());
  const providerCards = page.locator('.onboarding__provider');
  assert.equal(await providerCards.count(), bootstrap.providers.length, 'The provider stage reflects the actual bootstrap provider list.');
  for (const provider of bootstrap.providers) {
    const card = page.locator(`.onboarding__provider[data-provider="${provider.id}"]`);
    const text = await card.innerText();
    assert.equal(provider.available ? /Available/.test(text) : /Not available|Needs setup/.test(text), true, `Provider availability matches bootstrap for ${provider.name}.`);
  }
  assert.doesNotMatch(await page.locator('.onboarding__providers').innerText(), /Connected/);
  await page.screenshot({ path: join(outputDir, 'providers-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('heading', { name: /Make room for good work/i }).waitFor();

  failSignInOnce = true;
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByText('Example Google sign-in could not be started.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Retry Google sign-in' }).isVisible(), true, 'A sign-in failure has a truthful retry action.');
  await page.getByRole('button', { name: 'Retry Google sign-in' }).click();
  await page.getByText(/Waiting for Google sign-in to finish in your browser/).waitFor();
  await page.getByRole('heading', { name: /Good to have you here, Example Ada/i }).waitFor({ timeout: 8_000 });
  assert.equal(signInRequests, 2, 'Google sign-in only starts after explicit button clicks, including retry.');
  assert.equal(await page.getByRole('button', { name: 'Continue' }).isVisible(), true, 'Signed-in welcome remains named and can continue.');
  console.log('PASS example auth fixture: signed-out → sign-in error/retry → pending → signed-in named welcome.');

  accountMode = 'signed-out';
  clearTimeout(authTransitionTimer);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: /Make room for good work/i }).waitFor();
  nextSignInDelayMs = 20_000;
  failAccountReadOnce = true;
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByText(/Waiting for Google sign-in to finish in your browser/).waitFor();
  await page.getByText('Example account status could not be reached.').waitFor({ timeout: 5_000 });
  await page.getByRole('button', { name: 'Retry account check' }).click();
  await page.getByText(/Waiting for Google sign-in to finish in your browser/).waitFor();
  await page.getByRole('button', { name: 'Cancel sign-in' }).click();
  await page.getByRole('button', { name: 'Continue with Google' }).waitFor();
  assert.equal(cancelRequests, 1, 'The explicit cancel control calls the account cancellation endpoint.');
  console.log('PASS example auth fixture: pending status failure is visible/retryable and sign-in polling can be cancelled.');

  await page.getByRole('button', { name: 'Continue without an account' }).click();
  await page.getByRole('heading', { name: /Your tools, your choice/i }).waitFor();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: /A little more room to make things/i }).waitFor();
  await page.screenshot({ path: join(outputDir, 'ready-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: /Skip setup/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  let savedSettings = await page.evaluate(async () => (await (await fetch('/api/bootstrap')).json()).settings);
  assert.equal(savedSettings.onboardingCompletedVersion, 1, 'Skipping writes completion through the local settings endpoint.');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'Reload respects persisted onboarding completion.');
  console.log('PASS first-launch/skip persistence: onboarding completion survives a full reload.');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Replay welcome' }).click();
  await page.getByRole('heading', { name: /Make room for good work/i }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1, 'General settings can replay the optional welcome tour.');
  const naturalAnimation = await page.locator('.onboarding__orbit-center').evaluate((element) => getComputedStyle(element).animationDuration);
  assert.ok(Number.parseFloat(naturalAnimation) > 1, `The orbit illustration animates normally before reduced-motion is enabled (${naturalAnimation}).`);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedAnimation = await page.locator('.onboarding__orbit-center').evaluate((element) => getComputedStyle(element).animationDuration);
  assert.ok(Number.parseFloat(reducedAnimation) < 0.001, `Reduced-motion mode disables decorative animation (${reducedAnimation}).`);
  for (const width of [900, 360]) {
    await page.setViewportSize({ width, height: width < 500 ? 740 : 820 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `The onboarding layout has no horizontal overflow at ${width}px.`);
  }
  await page.screenshot({ path: join(outputDir, 'replay-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.matches('.settings-onboarding-replay button'));
  const settingsAfterReplay = await page.evaluate(async () => (await (await fetch('/api/bootstrap')).json()).settings);
  assert.deepEqual(settingsAfterReplay, savedSettings, 'Replaying onboarding does not reset workspace preferences.');
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.settings-onboarding-replay button')), true, 'Escape restores focus to the exact Settings replay control.');
  assert.equal(await page.getByRole('heading', { name: 'Settings', exact: true }).isVisible(), true, 'Escape returns to the Settings page.');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Replay welcome' }).click();
  await page.getByRole('heading', { name: /Make room for good work/i }).waitFor();
  await page.getByRole('button', { name: 'Continue without an account' }).click();
  await page.getByRole('heading', { name: /Your tools, your choice/i }).waitFor();
  await page.getByRole('button', { name: /Manage providers in Settings/ }).click();
  await page.getByRole('heading', { name: 'Connected agents' }).waitFor();
  assert.equal(await page.locator('.onboarding__dialog').count(), 0, 'The provider guide opens full provider settings and persists completion.');
  const settingsAfterProviderGuide = await page.evaluate(async () => (await (await fetch('/api/bootstrap')).json()).settings);
  assert.deepEqual(settingsAfterProviderGuide, savedSettings, 'Opening provider settings through onboarding leaves preferences unchanged.');
  assert.deepEqual(pageErrors, [], `Browser page errors: ${pageErrors.join('; ')}`);
  console.log(`PASS replay/accessibility/reduced motion/mobile: settings preserved; 900px and 360px have no overflow.\nScreenshots: ${outputDir}`);
} finally {
  clearTimeout(authTransitionTimer);
  await browser?.close();
  await viteServer?.close();
  await stop(apiProcess);
}
