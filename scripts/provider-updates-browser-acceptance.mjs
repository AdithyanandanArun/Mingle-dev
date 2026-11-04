#!/usr/bin/env node
// Real component with disposable Example HTTP responses. No provider calls or host updates.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const web = createRequire(join(root, 'apps/web/package.json'));
const serverRequire = createRequire(join(root, 'apps/server/package.json'));
const { createServer } = await import(pathToFileURL(web.resolve('vite')).href);
const { chromium } = serverRequire('playwright');
const output = join(tmpdir(), `mingle-provider-updates-acceptance-${process.pid}`);
await mkdir(output, { recursive: true });
let server, browser;
try {
  server = await createServer({ configFile: join(root, 'apps/web/vite.config.ts'), root, appType: 'mpa', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { entries: [join(root, 'scripts/provider-updates-browser-fixture.html')] }, resolve: { alias: [
    { find: /^@mingle\/contracts$/, replacement: join(root, 'packages/contracts/src/index.ts') },
    { find: /^@mingle\/contracts\/(.*)$/, replacement: `${root}/packages/contracts/src/$1` },
    { find: 'react', replacement: join(root, 'apps/web/node_modules/react') },
    { find: 'react-dom', replacement: join(root, 'apps/web/node_modules/react-dom') },
  ], dedupe: ['react', 'react-dom'] } });
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const row = { provider: 'codex', installedVersion: '1.0.0', latestVersion: '1.1.0', source: 'Example public registry', checkedAt: '2026-11-02T00:00:00Z', status: 'available', channel: 'stable', method: 'native', message: 'Example newer release.', dismissed: false };
  let rows = [row, { ...row, provider: 'claude', method: 'unsupported', message: 'Example package-managed installation.', instructions: 'Use the original package manager.' }, { ...row, provider: 'antigravity', status: 'unknown', latestVersion: null, method: 'unsupported', message: 'Managed pinned runtime.' }];
  let applies = 0, checks = 0, finishUpdate, rejectCheck = false, malformed = false;
  await page.route('**/api/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/updates/apply')) {
      applies++; assert.deepEqual(request.postDataJSON(), { provider: 'codex', expectedVersion: '1.0.0' });
      await new Promise((resolve) => { finishUpdate = resolve; });
      const result = { ...rows[0], installedVersion: '1.1.0', status: 'updated', message: 'Updated the Example configured CLI.' }; rows[0] = result;
      return route.fulfill({ json: result });
    }
    if (path.endsWith('/updates/dismiss')) { const body = request.postDataJSON(); rows = rows.map((r) => r.provider === body.provider ? { ...r, dismissed: true } : r); return route.fulfill({ json: { ok: true } }); }
    if (path.endsWith('/updates/check')) { checks++; return rejectCheck ? route.fulfill({ status: 503, json: { error: 'Example offline check.' } }) : route.fulfill({ json: { providers: rows } }); }
    if (path.endsWith('/updates')) return route.fulfill({ json: malformed ? [] : { providers: rows } });
    return route.fulfill({ status: 404, json: { error: 'Example fixture route only.' } });
  });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/provider-updates-browser-fixture.html`;
  await page.goto(url);
  await page.getByText('Codex 1.1.0 is available', { exact: true }).waitFor();
  assert.equal(applies, 0); assert.equal(checks, 0);
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByRole('button', { name: 'Updating…', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Check again', exact: true }).isDisabled(), true);
  finishUpdate(); await page.getByText('Updated the Example configured CLI.', { exact: true }).waitFor();
  assert.equal(applies, 1);
  await page.getByRole('button', { name: 'Dismiss claude update', exact: true }).click();
  await page.reload(); await page.getByRole('heading', { name: 'Provider CLI updates' }).waitFor();
  assert.equal(await page.getByText('Claude 1.1.0 is available', { exact: true }).count(), 0);
  rows[1] = { ...rows[1], latestVersion: '1.2.0', dismissed: false };
  await page.evaluate(() => window.dispatchEvent(new Event('mingle:provider-updates-changed')));
  await page.getByText('Claude 1.2.0 is available', { exact: true }).waitFor();
  const claudeRow = page.locator('.provider-updates__row').filter({ hasText: 'Claude' });
  assert.equal(await claudeRow.getByRole('button', { name: 'Update', exact: true }).count(), 0);
  await claudeRow.getByRole('button', { name: 'Copy instructions', exact: true }).waitFor();
  rejectCheck = true; await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Example offline check.' }).waitFor();
  malformed = true; await page.evaluate(() => window.dispatchEvent(new Event('mingle:provider-updates-changed')));
  await page.getByRole('alert').filter({ hasText: 'Provider update status is unavailable.' }).waitFor();
  await page.getByRole('heading', { name: 'Provider CLI updates' }).waitFor();
  malformed = false; await page.evaluate(() => window.dispatchEvent(new Event('mingle:provider-updates-changed')));
  await page.getByRole('alert').filter({ hasText: 'Provider update status is unavailable.' }).waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 850 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(output, 'provider-updates-390px.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`9 provider update browser checks passed. Screenshots: ${output}`);
} finally { await browser?.close(); await server?.close(); }
