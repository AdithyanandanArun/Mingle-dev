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
  const toggle = floating.getByRole('button', { name: 'Floating browser controls' });
  const bubble = floating.getByRole('navigation', { name: 'Floating browser actions' });
  const control = (name) => bubble.getByRole('button', { name, exact: true });
  const openControls = async () => {
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await bubble.waitFor();
  };
  const full = page.getByRole('dialog', { name: 'Shared browser', exact: true });
  await floating.waitFor();
  await floating.getByRole('application').waitFor();
  assert.equal(await sidebar.isVisible(), false);
  for (const removed of ['.browser-tabs', '.browser-bar', '.browser-status', '.browser-hint']) {
    assert.equal(await floating.locator(removed).count(), 0, `page-only layout hides ${removed}`);
  }
  assert.equal(await page.locator('body').getAttribute('data-native-shown'), null, 'only the live stream participates in floating layout');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await bubble.count(), 0, 'the page starts with only the circular toggle');
  const prompt = page.getByRole('textbox', { name: 'Example prompt' });
  const assertClearOfPrompt = () => page.waitForFunction(() => {
    const panel = document.querySelector('.browser-pip')?.getBoundingClientRect();
    const prompt = document.querySelector('[data-floating-browser-clear]')?.getBoundingClientRect();
    return panel && prompt && Math.abs(prompt.top - panel.bottom - 12) < 1
      && Math.abs(innerWidth - panel.right - 12) < 1 && Math.abs(panel.width / panel.height - 1.6) < 0.005;
  });
  await assertClearOfPrompt();
  await prompt.click();
  await prompt.fill('Example draft stays editable');
  await prompt.evaluate(node => { node.style.height = '400px'; });
  await assertClearOfPrompt();
  await prompt.evaluate(node => { node.style.height = '100px'; });
  await assertClearOfPrompt();
  const initialPanel = await floating.boundingBox();
  assert.equal(initialPanel.width, 360);
  assert.equal(initialPanel.height, 225);
  const initialToggle = await toggle.boundingBox();
  const pill = floating.locator('.browser-float-controls');
  const initialPill = await pill.boundingBox();
  assert.ok(initialToggle && initialPanel && initialPanel.x + initialPanel.width - initialToggle.x - initialToggle.width <= 35);
  assert.ok(initialToggle && initialToggle.y - initialPanel.y < 18 && Math.abs(initialPill.width - initialPill.height) < 1, JSON.stringify({ initialPanel, initialToggle, initialPill }));
  await toggle.press('Enter');
  await bubble.waitFor();
  assert.match(await bubble.evaluate(node => getComputedStyle(node).transitionProperty), /max-width/);
  await page.waitForFunction(({ width, right }) => {
    const pill = document.querySelector('.browser-float-controls');
    const nav = pill?.querySelector('nav');
    const rect = pill?.getBoundingClientRect();
    return nav && rect && nav.clientWidth >= 130 && rect.width > width
      && Math.abs(rect.right - right) < 1 && nav.getBoundingClientRect().left > rect.left;
  }, { width: initialPill.width, right: initialPill.x + initialPill.width });
  for (const name of ['Open desktop window', 'Dock browser', 'Disconnect browser', 'Open full browser', 'Minimize floating browser']) {
    await bubble.getByRole('button', { name, exact: true }).waitFor();
  }

  await control('Dock browser').focus();
  await page.keyboard.press('Escape');
  await bubble.waitFor({ state: 'hidden' });
  assert.ok(await toggle.evaluate((node) => node === document.activeElement));
  await openControls();
  await page.getByRole('heading', { name: 'Example browser workspace' }).click();
  await bubble.waitFor({ state: 'hidden' });

  await page.setViewportSize({ width: 320, height: 480 });
  await assertClearOfPrompt();
  await page.setViewportSize({ width: 2200, height: 740 });
  await page.waitForFunction(() => {
    const panel = document.querySelector('.browser-pip')?.getBoundingClientRect();
    const prompt = document.querySelector('[data-floating-browser-clear]')?.getBoundingClientRect();
    return panel && prompt && panel.left >= prompt.right && Math.abs(innerWidth - panel.right - 12) < 1 && Math.abs(innerHeight - panel.bottom - 12) < 1;
  });
  await page.setViewportSize({ width: 920, height: 740 });
  await assertClearOfPrompt();
  const beforeResize = await floating.boundingBox();
  const resizeCorner = floating.getByRole('group', { name: /Resize floating browser from top-left corner/ });
  await resizeCorner.press('Shift+ArrowLeft');
  await page.waitForFunction(({ oldWidth, right, top }) => {
    const panel = document.querySelector('.browser-pip')?.getBoundingClientRect();
    return panel && panel.width > oldWidth + 35 && Math.abs(panel.width / panel.height - 1.6) < 0.005
      && Math.abs(panel.right - right) < 1 && Math.abs(panel.top - top) < 1;
  }, { oldWidth: beforeResize.width, right: beforeResize.x + beforeResize.width, top: beforeResize.y });

  const beforeCornerDrag = await floating.boundingBox();
  const ne = await floating.getByRole('group', { name: /Resize floating browser from top-right corner/ }).boundingBox();
  await page.mouse.move(ne.x + ne.width / 2, ne.y + ne.height / 2);
  await page.mouse.down();
  await page.mouse.move(ne.x + ne.width / 2 - 55, ne.y + ne.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(({ right, bottom, width }) => {
    const panel = document.querySelector('.browser-pip')?.getBoundingClientRect();
    return panel && panel.width < width - 50 && Math.abs(panel.width / panel.height - 1.6) < 0.005
      && Math.abs(panel.right - right) < 1 && Math.abs(panel.bottom - bottom) < 1;
  }, { right: beforeCornerDrag.x + beforeCornerDrag.width, bottom: beforeCornerDrag.y + beforeCornerDrag.height, width: beforeCornerDrag.width });

  const beforeMove = await floating.boundingBox();
  const handle = await floating.locator('.browser-pip__handle').boundingBox();
  const handleCenter = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await page.mouse.move(handleCenter.x, handleCenter.y);
  await page.mouse.down();
  await page.mouse.move(handleCenter.x - 45, handleCenter.y - 35, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction((before) => {
    const panel = document.querySelector('.browser-pip')?.getBoundingClientRect();
    return panel && Math.abs(panel.left - before.x + 45) < 1 && Math.abs(panel.top - before.y + 35) < 1
      && Math.abs(panel.width - before.width) < 1 && Math.abs(panel.height - before.height) < 1;
  }, beforeMove);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openControls();
  assert.ok(await bubble.evaluate(node => getComputedStyle(node).transitionDuration.split(',').every(value => Number.parseFloat(value) <= 0.00002)));

  await floating.getByRole('application').focus();
  await page.keyboard.press('Alt+Shift+Escape');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Floating browser controls');
  await bubble.getByRole('button', { name: 'Open full browser' }).click();
  const placementBeforeFullView = await floating.boundingBox();
  await full.waitFor();
  assert.equal(await full.locator('.browser-bar, .browser-status, .browser-tabs').count(), 0);
  await full.getByRole('button', { name: 'Exit full browser' }).click();
  await floating.waitFor();
  const placementAfterFullView = await floating.boundingBox();
  assert.ok(placementBeforeFullView && placementAfterFullView
    && Math.abs(placementAfterFullView.x - placementBeforeFullView.x) < 1
    && Math.abs(placementAfterFullView.y - placementBeforeFullView.y) < 1,
  'exiting full view preserves floating placement');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Floating browser controls');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');

  await openControls();
  await control('Minimize floating browser').click();
  await floating.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Restore browser' }).click();
  await floating.waitFor();
  await assertClearOfPrompt();
  const restoredPanel = await floating.boundingBox();
  assert.ok(restoredPanel && Math.abs(restoredPanel.x + restoredPanel.width - 920 + 12) < 1, 'restoring resets to the right gutter');
  assert.equal(await sidebar.isVisible(), false);

  await openControls();
  await control('Open desktop window').click();
  await floating.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Example desktop window closes' }).click();
  await floating.waitFor();

  await openControls();
  await control('Disconnect browser').click();
  await floating.getByText('Example disconnect failed').waitFor();
  assert.equal(await floating.isVisible(), true, 'a failed disconnect keeps the browser and the failure visible');
  await openControls();
  await control('Dock browser').click();
  await floating.waitFor({ state: 'hidden' });
  await sidebar.getByRole('tablist', { name: 'Browser tabs' }).waitFor();
  await sidebar.getByRole('textbox', { name: 'Address' }).waitFor();
  await sidebar.getByText('Agent is driving · click or type to step in', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Example agent opens browser' }).click();
  assert.equal(await floating.isVisible(), false, 'explicit docking stays in effect');

  await sidebar.getByRole('button', { name: 'Float', exact: true }).click();
  await floating.waitFor();
  allowDisconnect = true;
  await openControls();
  await control('Disconnect browser').click();
  await floating.waitFor({ state: 'hidden' });
  assert.equal(disconnected, true);
  assert.deepEqual(errors, []);
  console.log('Floating browser acceptance passed: composer clearance, expanding controls, dismissal, ratio lock, keyboard, dock, minimize, full view, popout, disconnect, and reduced motion.');
} finally { await browser?.close(); await server?.close(); }
