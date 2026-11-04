#!/usr/bin/env node
/** Local browser acceptance for loaded-history search, exact navigation and device-local session bookmarks. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = createRequire(join(root, 'apps/web/package.json'));
const serverRequire = createRequire(join(root, 'apps/server/package.json'));
const { createServer } = await import(pathToFileURL(web.resolve('vite')).href);
const { chromium } = serverRequire('playwright');
let server; let browser;
try {
  server = await createServer({ configFile: join(root, 'apps/web/vite.config.ts'), root, appType: 'mpa', logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
    optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
    resolve: { alias: [
      { find: /^@mingle\/contracts\/stream$/, replacement: join(root, 'packages/contracts/src/stream.ts') },
      { find: /^@mingle\/contracts$/, replacement: join(root, 'packages/contracts/src/index.ts') },
      { find: 'react', replacement: join(root, 'apps/web/node_modules/react') },
      { find: 'react-dom', replacement: join(root, 'apps/web/node_modules/react-dom') },
    ], dedupe: ['react', 'react-dom'] } });
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error' && !/status of (?:404|409)/.test(message.text()) && !/WebSocket connection/.test(message.text())) errors.push(message.text()); });
  await page.route('**/api/**', (route) => route.fulfill({ status: 404, json: { error: 'Example fixture route only.' } }));
  await page.routeWebSocket('**/ws', () => {});
  let editCount = 0; let sendNowCount = 0; let failEdit = false;
  await page.route('**/api/sessions/example-session/queue/example-queued', async (route) => {
    if (route.request().method() === 'PATCH') {
      editCount++;
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (failEdit) return route.fulfill({ status: 409, json: { error: 'Example stale queued message' } });
      return route.fulfill({ status: 200, json: { id: 'example-queued', content: JSON.parse(route.request().postData() ?? '{}').content } });
    }
    return route.fulfill({ status: 200, json: { ok: true } });
  });
  await page.route('**/api/sessions/example-session/queue/example-queued/send-now', async (route) => { sendNowCount++; await route.fulfill({ status: 202, json: { accepted: true } }); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/conversation-navigation-browser-fixture.html`);
  await page.getByRole('button', { name: 'Find & bookmarks' }).waitFor({ timeout: 10_000 }).catch(async () => { throw new Error(`Navigation fixture did not mount. Errors: ${errors.join(' | ')} Body: ${(await page.locator('body').innerText()).slice(0, 1000)}`); });
  await page.getByRole('button', { name: 'Edit queued message' }).click();
  await page.getByRole('textbox', { name: 'Edit queued message' }).fill('Example edited content');
  await page.getByRole('button', { name: 'Save' }).dblclick();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Edit queued message"]') === null);
  assert.equal(editCount, 1, 'a busy save cannot be submitted twice');
  assert.equal(await page.getByText('1 skills retained').count(), 1, 'editing text preserves queued skills');
  assert.equal(await page.getByText('1 attachments').count(), 1, 'editing text preserves queued attachments');
  await page.getByRole('button', { name: 'Edit queued message' }).click();
  await page.getByRole('textbox', { name: 'Edit queued message' }).fill('Discarded edit');
  await page.getByRole('button', { name: 'Cancel' }).click();
  failEdit = true;
  await page.getByRole('button', { name: 'Edit queued message' }).click();
  await page.getByRole('textbox', { name: 'Edit queued message' }).fill('Example stale edit');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /stale queued message/i);
  await page.getByRole('button', { name: 'Cancel' }).click();
  failEdit = false;
  assert.equal(await page.getByRole('button', { name: 'Interrupt and send' }).count(), 1, 'active send-now is labelled as an interrupt');
  assert.equal(sendNowCount, 0, 'no interrupt request happens until an explicit click');
  await page.getByRole('button', { name: 'Interrupt and send' }).click();
  assert.equal(sendNowCount, 1, 'send-now request only follows the explicit interrupt action');
  await page.getByRole('button', { name: 'Find & bookmarks' }).click();
  const search = page.getByRole('searchbox', { name: 'Search loaded messages' });
  assert.match(await page.locator('.conversation-nav__scope').first().innerText(), /Search loaded messages only/);
  await search.fill('duplicate phrase');
  const results = page.getByRole('list', { name: 'Search results' }).getByRole('button');
  assert.equal(await results.count(), 4, 'two repeated-text message results, each with a bookmark control');
  await results.first().click();
  assert.equal(await page.locator('[data-message-id="example-message-1"]').evaluate((el) => document.activeElement === el), true, 'jump focuses the exact first matching message');

  await search.fill('Example newest');
  await page.getByRole('button', { name: 'Bookmark message example-message-3' }).click();
  assert.match(await page.getByRole('status').innerText(), /Bookmark saved/);
  const savedBookmark = await page.evaluate(() => localStorage.getItem('mingle:conversation-bookmarks:example-project:example-session'));
  assert.ok(savedBookmark && !savedBookmark.includes('secret-value-must-not-persist') && savedBookmark.includes('[redacted]'), 'bookmark storage sanitizes credential-like preview text');
  await page.reload();
  await page.getByRole('button', { name: 'Find & bookmarks' }).click();
  assert.equal(await page.getByRole('heading', { name: 'Bookmarks' }).count(), 1);
  await page.getByRole('button', { name: /Example newest response/ }).click();
  assert.equal(await page.locator('[data-message-id="example-message-3"]').evaluate((el) => document.activeElement === el), true, 'bookmark survives reload and jumps to the right row');

  await page.getByRole('button', { name: 'Find & bookmarks' }).click();
  await page.getByRole('button', { name: 'Find & bookmarks' }).click();
  await page.getByRole('button', { name: 'Load older messages to expand search scope' }).click();
  await search.fill('older history needle');
  assert.equal(await page.getByRole('button', { name: /Example older history needle/ }).count(), 1, 'loading older history expands search results only after explicit load');
  await page.getByRole('button', { name: 'Bookmark message example-older-message' }).click();
  await page.getByRole('button', { name: 'Load older messages to expand search scope' }).count().then((n) => assert.equal(n, 0));
  await page.getByRole('button', { name: 'Task · Example duplicate phrase: check the parser' }).click();
  assert.equal(await page.locator('[data-run-id="example-run"]').evaluate((el) => document.activeElement === el), true, 'task/tool/change landmarks jump to their run review region');

  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.locator('.conversation-nav__panel');
  const panelBox = await panel.boundingBox(); assert.ok(panelBox.width <= 366 && panelBox.x >= 0, `search remains within a 390px viewport (${JSON.stringify(panelBox)})`);
  await search.focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: 'Find & bookmarks' }).evaluate((el) => document.activeElement === el), true, 'Escape closes and returns focus to the trigger');
  assert.deepEqual(errors, [], 'no page errors');
  console.log(JSON.stringify({ status: 'passed', checks: 16, viewportWidths: [900, 390], data: 'explicit Example fixture' }, null, 2));
} finally { await browser?.close(); await server?.close(); }
