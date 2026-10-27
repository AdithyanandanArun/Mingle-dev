import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
if (!existsSync(executablePath)) {
  throw new Error(`Chromium executable not found at ${executablePath}. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an existing browser; this script never installs one.`);
}
const dataDir = await mkdtemp(join(tmpdir(), 'mingle-account-storage-'));
const outputDir = process.env.MINGLE_ACCOUNT_ACCEPTANCE_OUT ?? join(tmpdir(), 'mingle-account-storage-acceptance');
await mkdir(outputDir, { recursive: true });

let apiProcess;
let webProcess;
let apiLogs = '';
let webLogs = '';
let browser;
let retryScenario = { mode: 'unavailable', next: null, delayMs: 0 };
let accountFixture;

async function reservePort(preferredPort = 0) {
  const probe = createServer();
  probe.listen(preferredPort, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(url, child, label, logs) {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (child.exitCode !== null) throw new Error(`${label} exited during startup:\n${logs()}`);
    try { if ((await fetch(url)).ok) return; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} failed to start:\n${logs()}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 4_000);
  try { await exited; } finally { clearTimeout(timer); }
}

function account({ status = 'signed-out', storage, user = null, authorizationUrl = null, sessionStorage = 'memory' } = {}) {
  return {
    configured: true,
    connection: null,
    configurationSource: 'device',
    status,
    user,
    sessionStorage,
    error: null,
    authorizationUrl,
    browserError: null,
    storage,
  };
}

const webRuntime = {
  status: 'unavailable', backend: null, reason: 'web-runtime', retryable: false,
};
const keyringLocked = {
  status: 'unavailable', backend: 'gnome_libsecret', reason: 'keyring-unavailable', retryable: true,
};
const noKeyring = {
  status: 'unavailable', backend: 'basic_text', reason: 'no-keyring', retryable: false,
};
const writeFailed = {
  status: 'unavailable', backend: null, reason: 'storage-write-failed', retryable: true,
};
const secureStorage = {
  status: 'available', backend: 'gnome-libsecret', reason: null, retryable: false,
};

function jsonResponse(value, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(value) };
}

async function openAccount(page, webBase, nextAccount) {
  accountFixture = nextAccount;
  retryScenario = { mode: 'unavailable', next: null, delayMs: 0 };
  await page.goto(webBase, { waitUntil: 'domcontentloaded' });
  const sidebarToggle = page.getByRole('button', { name: 'Open sidebar' });
  if (await sidebarToggle.isVisible()) await sidebarToggle.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('heading', { name: 'Secure sign-in storage' }).waitFor();
}

async function screenshot(page, name) {
  const path = join(outputDir, name);
  await page.screenshot({ path, fullPage: true });
  console.log(`Screenshot: ${path}`);
}

try {
  // Vite's development proxy targets the standard local service port.
  const apiPort = await reservePort(4310);
  const webPort = await reservePort();
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const webBase = `http://127.0.0.1:${webPort}`;

  apiProcess = spawn(process.execPath, [
    '--import', join(root, 'apps/server/node_modules/tsx/dist/loader.mjs'),
    join(root, 'apps/server/src/index.ts'),
  ], {
    cwd: root,
    env: {
      ...process.env,
      MINGLE_DATA_DIR: dataDir,
      MINGLE_PORT: String(apiPort),
      MINGLE_WEB_PORT: String(webPort),
      MINGLE_SUPABASE_URL: '',
      MINGLE_SUPABASE_PUBLISHABLE_KEY: '',
      PORT: String(apiPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiProcess.stdout.on('data', (chunk) => { apiLogs = (apiLogs + chunk).slice(-12_000); });
  apiProcess.stderr.on('data', (chunk) => { apiLogs = (apiLogs + chunk).slice(-12_000); });
  await waitFor(`${apiBase}/api/health`, apiProcess, 'Disposable local service', () => apiLogs);
  const welcomeSetup = await fetch(`${apiBase}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: webBase },
    body: JSON.stringify({ onboardingCompletedVersion: 1 }),
  });
  assert.equal(welcomeSetup.status, 200, 'Account settings acceptance starts after first-launch welcome.');

  webProcess = spawn(process.execPath, [
    join(root, 'apps/web/node_modules/vite/bin/vite.js'),
    '--host', '127.0.0.1', '--port', String(webPort), '--strictPort',
  ], {
    cwd: join(root, 'apps/web'),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  webProcess.stdout.on('data', (chunk) => { webLogs = (webLogs + chunk).slice(-8_000); });
  webProcess.stderr.on('data', (chunk) => { webLogs = (webLogs + chunk).slice(-8_000); });
  await waitFor(webBase, webProcess, 'Vite web app', () => webLogs);

  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/account' && request.method() === 'GET') {
      await route.fulfill(jsonResponse(accountFixture));
      return;
    }
    if (url.pathname === '/api/account/storage/retry' && request.method() === 'POST') {
      if (retryScenario.delayMs) await new Promise((resolve) => setTimeout(resolve, retryScenario.delayMs));
      if (retryScenario.mode === 'failure') {
        await route.fulfill(jsonResponse({ error: 'Secret Service D-Bus error: private-storage-key-material' }, 503));
        return;
      }
      if (retryScenario.next) accountFixture = retryScenario.next;
      await route.fulfill(jsonResponse(accountFixture));
      return;
    }
    if (url.pathname === '/api/account/preferences' && request.method() === 'GET') {
      const signedIn = accountFixture.status === 'signed-in';
      await route.fulfill(jsonResponse(signedIn ? {
        preferences: {
          theme: 'dark', defaultProvider: 'codex', defaultCodexModel: 'gpt-6.1-sol', defaultClaudeModel: 'claude-fixture',
          defaultEffort: 'high', autoCompactPercent: null,
        },
        revision: 2,
        updatedAt: '2026-01-02T03:04:05.000Z',
      } : null));
      return;
    }
    try {
      const upstream = await route.fetch({ url: `${apiBase}${url.pathname}${url.search}` });
      await route.fulfill({ response: upstream });
    } catch {
      await route.fulfill(jsonResponse({ error: 'Disposable service request failed.' }, 502));
    }
  });

  await openAccount(page, webBase, account({ storage: webRuntime }));
  assert.match(await page.locator('.account-settings__storage').innerText(), /browser runtime/i);
  assert.equal(await page.getByRole('button', { name: 'Retry secure storage' }).count(), 0, 'Browser memory mode has no inapplicable retry action');
  await screenshot(page, 'web-memory.png');
  console.log('PASS memory web runtime: shown as memory-only, with no retry action.');

  await openAccount(page, webBase, account({ status: 'signing-in', storage: keyringLocked, authorizationUrl: 'https://accounts.example.invalid/sign-in' }));
  assert.match(await page.locator('.account-settings__storage').innerText(), /Selected keyring: GNOME Keyring/);
  retryScenario = {
    mode: 'success', delayMs: 450,
    next: account({ status: 'signing-in', storage: secureStorage, authorizationUrl: 'https://accounts.example.invalid/sign-in', sessionStorage: 'os-encrypted' }),
  };
  const pendingRetry = page.getByRole('button', { name: 'Retry secure storage' });
  await pendingRetry.click();
  await page.getByText('Checking secure storage…').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Retry secure storage' }).isDisabled(), true, 'Retry is disabled while busy');
  await page.getByText('Finish signing in in your browser.').waitFor();
  await page.getByRole('link', { name: 'Open Google sign-in' }).waitFor();
  await page.getByText('Secure storage is ready. Finish signing in; this sign-in will be saved securely.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Cancel sign-in' }).count(), 1, 'Retry preserves the pending sign-in');
  assert.match(await page.locator('.account-settings__storage').innerText(), /GNOME Keyring/);
  await screenshot(page, 'desktop-retry-ready.png');
  console.log('PASS recoverable desktop: retry shows busy state, succeeds, and preserves pending sign-in.');

  for (const backend of ['kwallet5', 'kwallet6']) {
    await openAccount(page, webBase, account({ storage: { ...keyringLocked, backend } }));
    assert.match(await page.locator('.account-settings__storage').innerText(), /Selected keyring: KWallet/);
  }
  console.log('PASS unavailable backend labels: exact KWallet backend IDs are presented as a friendly provider name.');

  await openAccount(page, webBase, account({ storage: { ...keyringLocked, backend: 'dpapi' } }));
  assert.match(await page.locator('.account-settings__storage').innerText(), /Selected keyring: Windows account protection/);
  console.log('PASS Windows backend label: DPAPI is described as Windows account protection.');

  await openAccount(page, webBase, account({ storage: noKeyring }));
  assert.match(await page.locator('.account-settings__storage').innerText(), /install or start a desktop keyring, then restart Mingle/i);
  assert.equal(await page.getByRole('button', { name: 'Retry secure storage' }).count(), 0, 'Nonretryable keyring selection requires restart guidance, not a retry action');
  const noKeyringText = await page.locator('.account-settings__storage').innerText();
  assert.equal(noKeyringText.includes('basic_text'), false, 'Plain-text backend identifier is never presented');
  console.log('PASS no keyring: restart guidance follows nonretryable state without exposing a plaintext backend.');

  await openAccount(page, webBase, account({ storage: { ...keyringLocked, reason: 'key-unreadable', retryable: false } }));
  const permanentKeyError = await page.locator('.account-settings__storage').innerText();
  assert.match(permanentKeyError, /preserved/i);
  assert.match(permanentKeyError, /contact support/i);
  assert.equal(await page.getByRole('button', { name: 'Retry secure storage' }).count(), 0, 'A nonretryable malformed key is preserved without a retry action');

  await openAccount(page, webBase, account({ storage: { ...keyringLocked, reason: 'key-unreadable', retryable: true } }));
  assert.match(await page.locator('.account-settings__storage').innerText(), /unlock the keyring and retry/i);
  assert.equal(await page.getByRole('button', { name: 'Retry secure storage' }).count(), 1, 'A retryable key read failure exposes the server-approved retry');
  console.log('PASS key-unreadable distinction: permanent errors preserve and escalate; retryable errors offer keyring guidance.');

  const signedInUser = { id: 'fixture-account-1', email: 'mingle-fixture@example.test', name: 'Mingle Fixture' };
  await openAccount(page, webBase, account({ status: 'signed-in', storage: writeFailed, user: signedInUser }));
  assert.match(await page.locator('.account-settings__storage').innerText(), /disk space and Mingle app-data write permissions/i);
  retryScenario = {
    mode: 'success', delayMs: 0,
    next: account({ status: 'signed-in', storage: secureStorage, user: signedInUser, sessionStorage: 'os-encrypted' }),
  };
  await page.getByText('Saved to your account').waitFor();
  await page.getByRole('button', { name: 'Retry secure storage' }).click();
  await page.getByText('Your current sign-in is now saved securely.').waitFor();
  await page.getByText('mingle-fixture@example.test').waitFor();
  await page.getByText('Saved to your account').waitFor();
  console.log('PASS signed-in retry: account identity and saved preferences remain visible.');

  await openAccount(page, webBase, account({ storage: keyringLocked }));
  retryScenario = { mode: 'unavailable', delayMs: 0, next: account({ storage: keyringLocked }) };
  await page.getByRole('button', { name: 'Retry secure storage' }).click();
  await page.getByText(/Mingle cannot reach the OS keyring/i).waitFor();
  assert.equal(await page.getByText(/Secure storage is ready/i).count(), 0, 'Unavailable result never reports false success');
  console.log('PASS unavailable retry result: no success confirmation is shown.');

  await openAccount(page, webBase, account({ storage: keyringLocked }));
  retryScenario = { mode: 'failure', delayMs: 0, next: null };
  await page.getByRole('button', { name: 'Retry secure storage' }).click();
  await page.getByText(/Could not retry secure sign-in storage/i).waitFor();
  assert.equal(await page.getByText(/private-storage-key-material|Secret Service D-Bus error/i).count(), 0, 'Raw storage error is not rendered');
  console.log('PASS retry failure: actionable generic error is shown without raw OS details.');

  await page.setViewportSize({ width: 390, height: 844 });
  await openAccount(page, webBase, account({ storage: { status: 'unavailable', backend: null, reason: 'session-unreadable', retryable: false } }));
  const corruptText = await page.locator('.account-settings__storage').innerText();
  assert.match(corruptText, /preserved/i);
  assert.match(corruptText, /contact support/i);
  assert.equal(await page.getByRole('button', { name: 'Retry secure storage' }).count(), 0, 'Unreadable saved session does not offer a destructive reset');
  assert.equal(await page.getByRole('button', { name: /reset|delete|remove/i }).count(), 0, 'No destructive recovery control is present');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'The narrow account settings layout has no horizontal overflow');
  await screenshot(page, 'unreadable-session-narrow.png');
  console.log('PASS unreadable existing session: preserved/support guidance, no reset, and narrow layout fits.');

  await openAccount(page, webBase, account({ storage: undefined, sessionStorage: 'memory' }));
  assert.match(await page.locator('.account-settings__storage').innerText(), /does not provide secure-storage diagnostics/i);
  assert.equal(await page.getByRole('button', { name: 'Retry secure storage' }).count(), 0, 'Legacy snapshot does not assume retry capability');
  console.log('PASS legacy snapshot: memory-only persistence is explained without assuming storage metadata.');

  await browser.close();
  browser = null;
  console.log(`Account storage browser acceptance passed. Screenshots: ${outputDir}`);
} catch (error) {
  console.error(error);
  if (apiLogs) console.error(apiLogs);
  if (webLogs) console.error(webLogs);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stop(webProcess);
  await stop(apiProcess);
  await rm(dataDir, { recursive: true, force: true });
}
