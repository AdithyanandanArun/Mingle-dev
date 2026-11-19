#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const web = createRequire(join(root, 'apps/web/package.json'));
const { createServer } = await import(pathToFileURL(web.resolve('vite')).href);
const { chromium } = createRequire(join(root, 'apps/server/package.json'))('playwright');
let server, browser;
try {
  server = await createServer({ configFile: join(root, 'apps/web/vite.config.ts'), root, appType: 'mpa',
    server: { host: '127.0.0.1', port: 0, hmr: false }, resolve: { alias: [
      { find: /^@mingle\/contracts$/, replacement: join(root, 'packages/contracts/src/index.ts') },
      { find: 'react', replacement: join(root, 'apps/web/node_modules/react') },
      { find: 'react-dom', replacement: join(root, 'apps/web/node_modules/react-dom') },
    ], dedupe: ['react', 'react-dom'] } });
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const tab = {
    id: 'tab_eeeeeeeeeeee', url: 'about:blank', title: 'Example page', managed: true,
    viewport: { width: 1280, height: 800 }, controlOwner: null,
    control: { owner: 'agent', holderId: null, lease: null, expiresAt: null },
    agentPointer: null, embeddedTargetId: 'example-target', dialog: null,
  };
  const state = { sessionId: 'example-float', status: 'connected', mode: 'embedded', tabs: [tab], activeTabId: tab.id, error: null, notices: [] };
  const empty = { ...state, status: 'disconnected', mode: null, tabs: [], activeTabId: null };
  let allowDisconnect = false;
  let disconnected = false;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/browser/disconnect')) {
      if (!allowDisconnect) return route.fulfill({ status: 503, json: { error: 'Example disconnect failed' } });
      disconnected = true;
      return route.fulfill({ json: empty });
    }
    if (path.endsWith('/browser')) return route.fulfill({ json: disconnected ? empty : state });
    return route.fulfill({ status: 404, json: { error: 'Example route not implemented' } });
  });
  await page.routeWebSocket(/\/ws\/browser\?/, (socket) => {
    socket.send(JSON.stringify({ type: 'hello', clientId: 'example-viewer', tab }));
  });
  await page.routeWebSocket(/\/ws$/, () => {});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/floating-browser-fixture.html`);
  const sidebar = page.locator('aside[aria-label="Example browser sidebar"]');
  const floating = page.getByRole('region', { name: 'Floating shared browser' });
  const bubble = floating.getByRole('navigation', { name: 'Floating browser controls' });
  const full = page.getByRole('dialog', { name: 'Shared browser', exact: true });
  await floating.waitFor();
  await floating.getByRole('application').waitFor();
  assert.equal(await sidebar.isVisible(), false);
  for (const removed of ['.browser-tabs', '.browser-bar', '.browser-status', '.browser-hint']) {
    assert.equal(await floating.locator(removed).count(), 0, `page-only layout hides ${removed}`);
  }
  assert.equal(await page.locator('body').getAttribute('data-native-shown'), null, 'only the live stream participates in floating layout');
  for (const name of ['Open desktop window', 'Dock browser', 'Disconnect browser', 'Open full browser', 'Minimize floating browser']) {
    await bubble.getByRole('button', { name, exact: true }).waitFor();
  }

  await page.setViewportSize({ width: 320, height: 480 });
  const bounds = await floating.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 320 && bounds.y + bounds.height <= 480);
  assert.ok(bounds && 480 - bounds.y - bounds.height <= 13, 'default bottom-right anchor survives viewport shrink');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await bubble.evaluate((node) => getComputedStyle(node).animationName), 'none');

  await floating.getByRole('application').focus();
  await page.keyboard.press('Alt+Shift+Escape');
  assert.match(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), /Move floating browser/);
  await bubble.getByRole('button', { name: 'Open full browser' }).click();
  await full.waitFor();
  assert.equal(await full.locator('.browser-bar, .browser-status, .browser-tabs').count(), 0);
  await full.getByRole('button', { name: 'Exit full browser' }).click();
  await floating.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Open full browser');

  await bubble.getByRole('button', { name: 'Minimize floating browser' }).click();
  await floating.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Restore browser' }).click();
  await floating.waitFor();
  assert.equal(await sidebar.isVisible(), false);

  await bubble.getByRole('button', { name: 'Open desktop window' }).click();
  await floating.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Example desktop window closes' }).click();
  await floating.waitFor();

  await bubble.getByRole('button', { name: 'Disconnect browser' }).click();
  await floating.getByText('Example disconnect failed').waitFor();
  assert.equal(await floating.isVisible(), true, 'a failed disconnect keeps the browser and the failure visible');
  await bubble.getByRole('button', { name: 'Dock browser' }).click();
  await floating.waitFor({ state: 'hidden' });
  await sidebar.getByRole('tablist', { name: 'Browser tabs' }).waitFor();
  await sidebar.getByRole('textbox', { name: 'Address' }).waitFor();
  await sidebar.getByText('Agent is driving · click or type to step in', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Example agent opens browser' }).click();
  assert.equal(await floating.isVisible(), false, 'explicit docking stays in effect');

  await sidebar.getByRole('button', { name: 'Float', exact: true }).click();
  await floating.waitFor();
  allowDisconnect = true;
  await bubble.getByRole('button', { name: 'Disconnect browser' }).click();
  await floating.waitFor({ state: 'hidden' });
  assert.equal(disconnected, true);
  assert.deepEqual(errors, []);
  console.log('Floating browser acceptance passed: startup, layout, keyboard, dock, minimize, full view, popout, disconnect, and reduced motion.');
} finally { await browser?.close(); await server?.close(); }
