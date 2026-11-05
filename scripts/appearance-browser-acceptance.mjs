#!/usr/bin/env node
// Real appearance settings, store refresh and palette application with Example-only HTTP responses.
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
    defaultEffort: 'medium', defaultIsolated: true, defaultPolicy: 'supervised', theme: 'dark', claudeExecutable: '', codexExecutable: '' };
  const bootstrap = () => ({ projects: [], sessions: [], messages: [], queuedMessages: [], tasks: [], events: [], approvals: [], plans: [], questions: [],
    providers: [], settings, version: 'Example appearance fixture', runs: [], toolCalls: [], groups: [], workflows: [] });
  await page.route('**/api/**', (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/bootstrap') return route.fulfill({ json: bootstrap() });
    if (path === '/api/settings' && request.method() === 'PATCH') {
      const patch = request.postDataJSON(); writes.push(patch);
      assert.ok(Object.keys(patch).every((key) => ['theme', 'colorStyle'].includes(key)));
      if (rejectSave) return route.fulfill({ status: 503, json: { error: 'Example appearance save failed.' } });
      settings = { ...settings, ...patch }; return route.fulfill({ json: settings });
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: 'Example fixture route only' } });
  });
  const style = () => page.evaluate(() => ({ theme: document.documentElement.dataset.theme, colorStyle: document.documentElement.dataset.colorStyle,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), bg: getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim() }));
  const expectStyle = async (theme, colorStyle, accent) => {
    await page.waitForFunction(({ theme, colorStyle, accent }) => document.documentElement.dataset.theme === theme && document.documentElement.dataset.colorStyle === colorStyle
      && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === accent, { theme, colorStyle, accent });
  };
  const choose = async (label, option) => { await page.getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click(); };
  await page.goto(url);
  await page.getByText('Example appearance workspace · no provider calls', { exact: true }).waitFor();
  await expectStyle('dark', 'subtle', '#9ebcf4');
  assert.equal(writes.length, 0, 'opening Appearance never writes a preference');
  await page.screenshot({ path: join(output, 'subtle-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Restore monochrome', exact: true }).click();
  await expectStyle('dark', 'monochrome', '#f0f0f0');
  assert.equal((await style()).bg, '#0e0e0e', 'monochrome restores the exact old surface');
  assert.deepEqual(writes.at(-1), { colorStyle: 'monochrome' });
  await page.reload();
  await expectStyle('dark', 'monochrome', '#f0f0f0');
  await choose('Theme', 'Light');
  await expectStyle('light', 'monochrome', '#242424');
  assert.equal((await style()).bg, '#f8f8f8');
  await choose('Color style', 'Subtle color');
  await expectStyle('light', 'subtle', '#3566a8');
  await page.screenshot({ path: join(output, 'subtle-light.png'), fullPage: true });
  // Keyboard-only change returns to monochrome and preserves the independently selected light theme.
  await page.getByRole('combobox', { name: 'Color style', exact: true }).focus();
  await page.keyboard.press('Enter'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await expectStyle('light', 'monochrome', '#242424');
  rejectSave = true;
  await choose('Color style', 'Subtle color');
  await page.getByRole('alert').filter({ hasText: 'Example appearance save failed.' }).waitFor();
  assert.equal((await style()).colorStyle, 'monochrome', 'failed save leaves the active palette intact');
  rejectSave = false;
  await choose('Color style', 'Subtle color');
  await expectStyle('light', 'subtle', '#3566a8');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(output, 'appearance-390.png'), fullPage: true });
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  console.log(`Appearance browser acceptance passed: dark/light palettes, exact monochrome restore, persistence, keyboard, failed saves, narrow layout. Screenshots: ${output}`);
} finally { await browser?.close(); await server?.close(); }
