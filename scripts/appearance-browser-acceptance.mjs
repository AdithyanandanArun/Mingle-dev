#!/usr/bin/env node
// Real theme settings and original monochrome styling with Example-only HTTP responses.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const web = createRequire(join(root, 'apps/web/package.json'));
const { createServer } = await import(pathToFileURL(web.resolve('vite')).href);
const { chromium } = createRequire(join(root, 'apps/server/package.json'))('playwright');
const output = join(tmpdir(), `mingle-appearance-acceptance-${process.pid}`);
await mkdir(output, { recursive: true });
let server, browser;
try {
  server = await createServer({ configFile: join(root, 'apps/web/vite.config.ts'), root, appType: 'mpa',
    server: { host: '127.0.0.1', port: 0, hmr: false }, resolve: { alias: [
      { find: /^@mingle\/contracts$/, replacement: join(root, 'packages/contracts/src/index.ts') },
      { find: 'react', replacement: join(root, 'apps/web/node_modules/react') },
      { find: 'react-dom', replacement: join(root, 'apps/web/node_modules/react-dom') },
    ], dedupe: ['react', 'react-dom'] } });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/appearance-browser-fixture.html`;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(6000);
  const errors = [], unexpected = [], writes = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let rejectSave = false;
  let settings = { defaultProvider: 'codex', defaultCodexModel: 'example-codex-model', defaultClaudeModel: 'example-claude-model',
    defaultEffort: 'medium', defaultIsolated: true, defaultPolicy: 'supervised', theme: 'dark', claudeExecutable: '', codexExecutable: '', colorStyle: 'subtle' /* legacy response must have no effect */ };
  const bootstrap = () => ({ projects: [], sessions: [], messages: [], queuedMessages: [], tasks: [], events: [], approvals: [], plans: [], questions: [],
    providers: [], settings, version: 'Example appearance fixture', runs: [], toolCalls: [], groups: [], workflows: [] });
  await page.route('**/api/**', (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/bootstrap') return route.fulfill({ json: bootstrap() });
    if (path === '/api/settings' && request.method() === 'PATCH') {
      const patch = request.postDataJSON(); writes.push(patch);
      assert.ok(Object.keys(patch).every((key) => key === 'theme'));
      if (rejectSave) return route.fulfill({ status: 503, json: { error: 'Example appearance save failed.' } });
      settings = { ...settings, ...patch }; return route.fulfill({ json: settings });
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: 'Example fixture route only' } });
  });
  const expectTheme = async (theme, accent) => {
    await page.waitForFunction(({ theme, accent }) => document.documentElement.dataset.theme === theme
      && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === accent, { theme, accent });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.colorStyle), undefined);
    assert.equal(await page.getByRole('combobox', { name: 'Color style', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Restore monochrome', exact: true }).count(), 0);
    assert.equal(await page.getByText('Subtle color', { exact: true }).count(), 0);
  };
  const choose = async (option) => { await page.getByRole('combobox', { name: 'Theme', exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click(); };
  const surfaces = () => page.evaluate(() => Object.fromEntries([
    '--bg-app', '--bg-sidebar', '--bg-panel', '--bg-surface', '--bg-raised', '--bg-inset', '--bg-message', '--bg-active',
  ].map((key) => [key, getComputedStyle(document.documentElement).getPropertyValue(key).trim()])));
  const expectControl = (name, property, value) => page.waitForFunction(({ name, property, value }) => {
    const button = [...document.querySelectorAll('button')].find((element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name);
    return button && getComputedStyle(button)[property] === value;
  }, { name, property, value });
  await page.goto(url);
  await page.getByText('Example appearance workspace · no provider calls', { exact: true }).waitFor();
  await expectTheme('dark', '#f0f0f0');
  assert.deepEqual(await surfaces(), { '--bg-app': '#0e0e0e', '--bg-sidebar': '#121212', '--bg-panel': '#161616', '--bg-surface': '#1c1c1c',
    '--bg-raised': '#242424', '--bg-inset': '#0e0e0e', '--bg-message': '#1c1c1c', '--bg-active': 'rgba(255, 255, 255, 0.075)' });
  await expectControl('Example primary', 'backgroundColor', 'rgb(240, 240, 240)');
  await expectControl('Example send', 'backgroundColor', 'rgb(240, 240, 240)');
  await expectControl('Example secondary', 'color', 'rgb(240, 240, 240)');
  await expectControl('Example secondary', 'backgroundColor', 'rgb(28, 28, 28)');
  assert.equal(await page.getByRole('button', { name: 'Example disabled', exact: true }).isDisabled(), true);
  assert.equal(writes.length, 0, 'opening Appearance never writes a preference');
  await page.screenshot({ path: join(output, 'monochrome-dark.png'), fullPage: true });
  await choose('Light');
  await expectTheme('light', '#242424');
  assert.deepEqual(writes.at(-1), { theme: 'light' });
  await page.reload();
  await expectTheme('light', '#242424');
  assert.deepEqual(await surfaces(), { '--bg-app': '#f8f8f8', '--bg-sidebar': '#f0f0f0', '--bg-panel': '#fafafa', '--bg-surface': '#ffffff',
    '--bg-raised': '#ffffff', '--bg-inset': '#ededed', '--bg-message': '#eeeeee', '--bg-active': 'rgba(0, 0, 0, 0.07)' });
  await expectControl('Example primary', 'backgroundColor', 'rgb(36, 36, 36)');
  await expectControl('Example send', 'backgroundColor', 'rgb(36, 36, 36)');
  await expectControl('Example secondary', 'color', 'rgb(24, 24, 24)');
  await expectControl('Example secondary', 'backgroundColor', 'rgb(255, 255, 255)');
  await page.screenshot({ path: join(output, 'monochrome-light.png'), fullPage: true });
  // Keyboard-only theme selection and failed-save recovery retain the original palette.
  await page.getByRole('combobox', { name: 'Theme', exact: true }).focus();
  await page.keyboard.press('Enter'); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  await expectTheme('dark', '#f0f0f0');
  rejectSave = true;
  await choose('Light');
  await page.getByRole('alert').filter({ hasText: 'Example appearance save failed.' }).waitFor();
  await expectTheme('dark', '#f0f0f0');
  rejectSave = false;
  await choose('Light');
  await expectTheme('light', '#242424');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(output, 'appearance-390.png'), fullPage: true });
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  console.log(`Appearance browser acceptance passed: original monochrome surfaces and controls, no color feature, legacy preference ignored, theme persistence, keyboard, failed saves, narrow layout. Screenshots: ${output}`);
} finally { await browser?.close(); await server?.close(); }
