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
  let editCount = 0; let sendNowCount = 0; let failEdit = false; const editBodies = [];
  await page.route('**/api/sessions/example-session/queue/example-queued', async (route) => {
    if (route.request().method() === 'PATCH') {
      editCount++;
      editBodies.push(route.request().postDataJSON());
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
  await page.evaluate(() => window.setRemoteQueueText('Example newer server text'));
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /stale queued message/i);
  assert.deepEqual(editBodies.at(-1), { content: 'Example stale edit', expectedContent: 'Example queued text' }, 'the expected text stays the value captured when editing began');
  assert.equal(await page.getByRole('textbox', { name: 'Edit queued message' }).inputValue(), 'Example stale edit', 'a conflict keeps the person’s edit');
  assert.equal(await page.getByText('Example newer server text').count(), 1, 'the current server text is shown beside the preserved edit');
  await page.getByRole('button', { name: 'Use latest text' }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Edit queued message' }).inputValue(), 'Example newer server text');
  await page.getByRole('button', { name: 'Cancel' }).click();
  failEdit = false;
  assert.equal(await page.getByRole('button', { name: 'Interrupt and send' }).count(), 1, 'active send-now is labelled as an interrupt');
  assert.equal(sendNowCount, 0, 'no interrupt request happens until an explicit click');
  await page.getByRole('button', { name: 'Interrupt and send' }).click();
  assert.equal(sendNowCount, 1, 'send-now request only follows the explicit interrupt action');
  await page.getByRole('button', { name: 'Find & bookmarks' }).click();
  assert.equal(await page.locator('.conversation-nav__panel').evaluate((el) => getComputedStyle(el).animationName), 'none', 'the panel entrance respects reduced motion');
  const search = page.getByRole('searchbox', { name: 'Search loaded messages' });
  assert.match(await page.locator('.conversation-nav__scope').first().innerText(), /Search loaded messages only/);
  await search.fill('duplicate phrase');
  const results = page.getByRole('list', { name: 'Search results' }).getByRole('button');
  assert.equal(await results.count(), 4, 'two repeated-text message results, each with a bookmark control');
  await results.first().click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-message-id') === 'example-message-1');
  assert.equal(await page.locator('[data-message-id="example-message-1"]').evaluate((el) => document.activeElement === el), true, 'jump focuses the exact first matching message');

  await search.fill('Example newest');
  await page.evaluate(() => { for (let i = 0; i < 30; i++) localStorage.setItem(`mingle:conversation-bookmarks:old-project-${i}:old-session`, '[]'); });
  await page.getByRole('button', { name: 'Bookmark message example-message-3' }).click();
  assert.match(await page.getByRole('status').filter({ hasText: 'Bookmark saved on this device.' }).innerText(), /Bookmark saved/);
  const savedBookmark = await page.evaluate(() => localStorage.getItem('mingle:conversation-bookmarks:example-project:example-session'));
  assert.ok(savedBookmark && !savedBookmark.includes('secret-value-must-not-persist') && !savedBookmark.includes('[redacted]') && savedBookmark.includes('example-message-3'), 'bookmark storage keeps only its stable message ID and timestamp');
  assert.ok(await page.evaluate(() => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((item) => item?.startsWith('mingle:conversation-bookmarks:')).length <= 24), 'the browser bookmark index bounds total per-session keys');
  await page.reload();
  await page.getByRole('button', { name: 'Find & bookmarks' }).click();
  assert.equal(await page.getByRole('heading', { name: 'Bookmarks' }).count(), 1);
  await page.getByRole('button', { name: /Example newest response/ }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-message-id') === 'example-message-3');
  assert.equal(await page.locator('[data-message-id="example-message-3"]').evaluate((el) => document.activeElement === el), true, 'bookmark survives reload and jumps to the right row');

  await page.getByRole('button', { name: 'Find & bookmarks' }).click();
  await page.getByRole('button', { name: 'Find & bookmarks' }).click();
  await page.getByRole('button', { name: 'Load older messages to expand search scope' }).click();
  await search.fill('older history needle');
  assert.equal(await page.getByRole('button', { name: /Example older history needle/ }).count(), 1, 'loading older history expands search results only after explicit load');
  await page.getByRole('button', { name: 'Bookmark message example-older-message' }).click();
  await page.getByRole('button', { name: 'Load older messages to expand search scope' }).count().then((n) => assert.equal(n, 0));
  await page.getByRole('button', { name: 'Task · Example duplicate phrase: check the parser' }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-run-review-id') === 'example-run');
  assert.equal(await page.locator('[data-run-review-id="example-run"]').evaluate((el) => document.activeElement === el), true, 'task jumps to the actual review card rendered by TranscriptList');
  await page.getByRole('button', { name: 'Tool · Read · completed' }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-tool-call-id') === 'example-call');
  assert.equal(await page.locator('[data-tool-call-id="example-call"]').evaluate((el) => document.activeElement === el), true, 'jump opens the real RunActivity details and focuses the exact nested tool');
  await page.getByRole('button', { name: 'Changes · 1 files' }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-run-changes-id') === 'example-run');
  assert.equal(await page.locator('[data-run-changes-id="example-run"]').evaluate((el) => document.activeElement === el), true, 'changes jump to the embedded RunChanges section');
  await page.evaluate(() => document.querySelector('[data-run-review-id="example-run"]')?.remove());
  await page.getByRole('button', { name: 'Task · Example duplicate phrase: check the parser' }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-run-id') === 'example-run');
  assert.equal(await page.locator('[data-run-id="example-run"]').evaluate((el) => document.activeElement === el), true, 'a completed run without its review card falls back to the actual run landmark');

  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.locator('.conversation-nav__panel');
  const panelBox = await panel.boundingBox(); assert.ok(panelBox.width <= 366 && panelBox.x >= 0, `search remains within a 390px viewport (${JSON.stringify({ ...panelBox, cssWidth: await panel.evaluate((el) => getComputedStyle(el).width), viewport: await page.evaluate(() => innerWidth) })})`);
  await search.focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: 'Find & bookmarks' }).evaluate((el) => document.activeElement === el), true, 'Escape closes and returns focus to the trigger');
  assert.deepEqual(errors, [], 'no page errors');
  console.log(JSON.stringify({ status: 'passed', checks: 16, viewportWidths: [900, 390], data: 'explicit Example fixture' }, null, 2));
} finally { await browser?.close(); await server?.close(); }
