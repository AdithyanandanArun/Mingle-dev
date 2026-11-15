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
  const errors = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  let outcome = 'completed', heldRoute;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/bootstrap') return route.fulfill({ json: { projects: [], sessions: [], messages: [], tasks: [], events: [], approvals: [], plans: [], questions: [], providers: [], settings: { theme: 'dark' }, runs: [], toolCalls: [] } });
    if (path.endsWith('/compact/interrupt')) {
      const operation = route.request().postDataJSON().operationId;
      calls.push({ path, operation });
      await route.fulfill({ json: { interrupted: true } });
      const sessionId = path.split('/')[3];
      await heldRoute.fulfill({ json: { sessionId, provider: 'codex', status: 'failed', message: 'Example cancelled', error: null } });
      heldRoute = null; return;
    }
    if (path.endsWith('/compact')) {
      calls.push({ path, operation: route.request().postDataJSON().operationId });
      if (outcome === 'pending') { heldRoute = route; return; }
      return route.fulfill({ json: { sessionId: path.split('/')[3], provider: 'codex', status: outcome, message: `Example ${outcome}`, error: outcome === 'failed' ? 'Example compact failure' : null } });
    }
    throw new Error(`Unexpected Example request: ${path}`);
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/context-usage-browser-fixture.html`);
  await page.getByText('Example context workspace · no provider calls', { exact: true }).waitFor();
  const trigger = () => page.getByRole('button', { name: /^(Context|Estimated context)/ });
  const panel = () => page.getByRole('dialog', { name: 'Conversation context', exact: true });
  for (const [value, tone] of [[70, 'neutral'], [70.1, 'warning'], [90, 'warning'], [90.1, 'danger']]) {
    await page.getByRole('button', { name: `Set ${value}%`, exact: true }).click();
    assert.match(await trigger().getAttribute('class'), new RegExp(`context-usage--${tone}`));
  }
  await trigger().hover();
  await panel().getByText('90.1% of context used', { exact: true }).waitFor();
  await panel().getByRole('button', { name: 'Compact conversation', exact: true }).click();
  await panel().getByRole('status').filter({ hasText: 'Example completed' }).waitFor();
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/sessions/one/compact');
  assert.equal(await page.getByRole('textbox', { name: 'Example draft' }).inputValue(), 'Keep this unsent draft');
  await page.keyboard.press('Escape');
  assert.equal(await trigger().getAttribute('aria-expanded'), 'false');
  assert.equal(await trigger().evaluate(node => document.activeElement === node), true);
  await page.getByRole('button', { name: 'Unreported', exact: true }).click();
  await trigger().hover();
  await panel().getByText('Context usage unreported', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Toggle busy', exact: true }).click();
  await trigger().click();
  assert.equal(await panel().getByRole('button', { name: 'Compact conversation', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Toggle busy', exact: true }).click();
  outcome = 'pending'; await trigger().click();
  await panel().getByRole('button', { name: 'Compact conversation', exact: true }).click();
  await panel().getByRole('button', { name: 'Cancel compaction', exact: true }).click();
  await panel().getByRole('status').filter({ hasText: 'Example cancelled' }).waitFor();
  assert.equal(calls.at(-1).operation, calls.at(-2).operation);
  await page.getByRole('button', { name: 'Switch conversation', exact: true }).click();
  assert.equal(await trigger().getAttribute('aria-expanded'), 'false', 'switching sessions closes the prior context details');
  outcome = 'unsupported'; await trigger().click();
  await panel().getByRole('button', { name: 'Compact conversation', exact: true }).click();
  await panel().getByRole('status').filter({ hasText: 'Example unsupported' }).waitFor();
  assert.equal(calls.at(-1).path, '/api/sessions/two/compact', 'actions address the newly selected conversation');
  outcome = 'failed';
  await panel().getByRole('button', { name: 'Compact conversation', exact: true }).click();
  await panel().getByRole('alert').filter({ hasText: 'Example compact failure' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Example draft' }).inputValue(), 'Keep this unsent draft');
  await page.setViewportSize({ width: 390, height: 500 });
  await trigger().click();
  const bounds = await panel().boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 500);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/mingle-context-ring.png', fullPage: true });
  console.log('Context browser acceptance passed: strict thresholds, hover, compact, cancellation, unknown, busy, focus, drafts and narrow viewport.');
} finally { await browser?.close(); await server?.close(); }
