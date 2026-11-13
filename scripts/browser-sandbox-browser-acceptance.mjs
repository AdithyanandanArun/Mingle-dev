#!/usr/bin/env node
// Example-only UI and clipboard fixtures. No commands, installation, admin prompt or provider run.
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
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    requests.push(route.request().url());
    return route.fulfill({ status: 403, json: { error: 'Example admin prompt cancelled.' } });
  });
  await page.addInitScript(() => {
    window.exampleClipboardMode = 'reject';
    window.exampleClipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
      window.exampleClipboardWrites.push(text);
      if (window.exampleClipboardMode === 'reject') throw new Error('Example clipboard denied');
      if (window.exampleClipboardMode === 'pending') await new Promise(resolve => { window.exampleClipboardResolve = resolve; });
    } } });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/browser-sandbox-browser-fixture.html`);
  await page.getByText('Example sandbox setup · no browser installation or commands', { exact: true }).waitFor();
  await page.getByText('Do it yourself', { exact: true }).click();
  const copy = () => page.getByRole('button', { name: 'Copy instructions', exact: true });
  const copied = () => page.getByRole('status').filter({ hasText: /^Copied$/ });
  await copy().click();
  await page.getByRole('alert').filter({ hasText: 'Could not copy the instructions.' }).waitFor();
  assert.equal(await copied().count(), 0);
  await page.evaluate(() => { window.exampleClipboardMode = 'success'; });
  await copy().click();
  await copied().waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.evaluate(() => { window.exampleClipboardMode = 'pending'; });
  await copy().click();
  assert.equal(await copy().isDisabled(), true, 'pending copy disables duplicate submissions');
  assert.equal(await copied().count(), 0);
  await page.getByRole('button', { name: 'Change example instructions', exact: true }).click();
  await page.evaluate(() => window.exampleClipboardResolve());
  await page.waitForFunction(() => document.querySelector('button[aria-busy="true"]') === null);
  assert.equal(await copied().count(), 0, 'old clipboard completion cannot certify changed instructions');
  await page.evaluate(() => { window.exampleClipboardMode = 'success'; });
  await copy().click();
  await copied().waitFor();
  assert.equal(await page.evaluate(() => window.exampleClipboardWrites.at(-1)), 'Example instructions B (never executed)');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await copy().click();
  await page.getByRole('alert').filter({ hasText: 'Could not copy the instructions.' }).waitFor();
  assert.equal(await copied().count(), 0);
  await page.getByRole('button', { name: 'Use Example browser instead', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Example browser selection failed.' }).waitFor();
  await page.getByRole('button', { name: 'Allow Chromium (admin prompt)', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Example admin prompt cancelled.' }).waitFor();
  assert.equal(requests.length, 1, 'only the mocked explicit sandbox request is made');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, [], 'action failures never become unhandled rejections');
  console.log('Sandbox setup browser acceptance passed: rejected/missing clipboard, retry, pending copy, changed instructions, browser selection/admin errors and narrow layout.');
} finally { await browser?.close(); await server?.close(); }
