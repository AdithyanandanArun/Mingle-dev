#!/usr/bin/env node
/** Example-only integration checks. No real providers, shell processes or cloud calls. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { createServer as createPortProbe } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const web = createRequire(join(root, 'apps/web/package.json'));
const { chromium } = createRequire(join(root, 'apps/server/package.json'))('playwright');
const { createServer } = await import(pathToFileURL(web.resolve('vite')).href);
const output = process.env.WORKSPACE_UX_OUTPUT || '/tmp/mingle-workspace-ux';
await mkdir(output, { recursive: true });
let server; let browser; let checks = 0;
const port = await new Promise((resolve, reject) => {
  const probe = createPortProbe(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close((error) => error ? reject(error) : resolve(port)); });
});
try {
  server = await createServer({ configFile: join(root, 'apps/web/vite.config.ts'), root, cacheDir: join(output, 'vite-cache'), appType: 'mpa', logLevel: 'error',
    plugins: [{ name: 'example-workspace-entry', configureServer(vite) { vite.middlewares.use('/example-workspace-ux', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/example-workspace-ux', '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/workspace-ux-browser-fixture.tsx"></script></body></html>'));
    }); } }], server: { host: '127.0.0.1', port },
    resolve: { alias: [
      { find: /^@mingle\/contracts\/stream$/, replacement: join(root, 'packages/contracts/src/stream.ts') },
      { find: /^@mingle\/contracts$/, replacement: join(root, 'packages/contracts/src/index.ts') },
      { find: 'react', replacement: join(root, 'apps/web/node_modules/react') }, { find: 'react-dom', replacement: join(root, 'apps/web/node_modules/react-dom') },
    ], dedupe: ['react', 'react-dom'] }, optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'monaco-editor', '@monaco-editor/react'] },
  });
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, reducedMotion: 'reduce' });
  const errors = []; const unexpected = []; const writes = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let rootReads = 0; let failFiles = false; let failSave = true; let failQueue = false;
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(request.url()); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/bootstrap') return route.fulfill({ json: { projects: [], sessions: [], messages: [], tasks: [], events: [], approvals: [], plans: [], questions: [], providers: [], runs: [], toolCalls: [], groups: [], settings: { theme: 'dark' }, version: 'Example bootstrap' } });
    if (url.pathname === '/api/projects/example-project/files') {
      const path = url.searchParams.get('path') || '';
      if (!path) rootReads++;
      if (failFiles) return route.fulfill({ status: 503, json: { error: 'Example directory refresh failed' } });
      return route.fulfill({ json: path === 'src' ? [{ path: 'src/example.ts', name: 'example.ts', type: 'file' }] : [{ path: 'src', name: 'src', type: 'directory' }, { path: 'README.md', name: 'README.md', type: 'file' }] });
    }
    if (url.pathname === '/api/projects/example-project/file') {
      if (request.method() === 'PUT') { writes.push(request.postDataJSON()); return route.fulfill({ status: failSave ? 503 : 200, json: failSave ? { error: 'Example file cannot be saved' } : { ok: true } }); }
      return route.fulfill({ json: { content: 'Example original file', path: 'example.txt' } });
    }
    if (url.pathname === '/api/sessions/example-session/queue/example-queue' && request.method() === 'PATCH') {
      writes.push(request.postDataJSON());
      return route.fulfill({ status: failQueue ? 409 : 200, json: failQueue ? { error: 'Example queue changed remotely' } : { ok: true } });
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, json: { error: 'Unmocked Example route' } });
  });
  const scene = async (name) => { await page.goto(`${origin}/example-workspace-ux?scene=${name}`); await page.getByText('Example workspace UX · no inference or real shell', { exact: true }).waitFor({ timeout: 60_000 }).catch(async (error) => { console.log('Fixture load failure:', name, errors, unexpected, (await page.locator('body').innerText()).slice(0, 500)); throw error; }); };
  const check = (condition, message) => { assert.ok(condition, message); checks++; console.log(`PASS ${message}`); };

  await scene('markdown');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Example denied'); } } }));
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not copy' }).waitFor(); check(true, 'clipboard failure gives visible recovery without an unhandled rejection');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.exampleCopiedCode = text; } } }));
  await page.getByRole('button', { name: 'Copy code', exact: true }).click(); await page.getByText('Code copied to clipboard', { exact: true }).waitFor();
  check((await page.evaluate(() => window.exampleCopiedCode)).endsWith('console.log(example);'), 'code copy succeeds on retry and preserves exact content');
  await page.getByRole('button', { name: 'Wrap code lines' }).click();
  check(await page.locator('.codeblock pre').evaluate((el) => getComputedStyle(el).whiteSpace === 'pre-wrap'), 'code line wrapping applies without changing the copied source');
  await page.setViewportSize({ width: 390, height: 780 }); await page.screenshot({ path: join(output, 'code-390.png') });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'wrapped code and its toolbar fit a narrow viewport');
  await page.evaluate(() => window.exampleUX.setTheme('light')); await page.screenshot({ path: join(output, 'code-light.png') });

  await page.setViewportSize({ width: 1000, height: 760 }); await scene('files');
  const folder = page.getByRole('treeitem', { name: 'src', exact: true }); await folder.waitFor();
  check(await page.locator('[role=treeitem][tabindex="0"]').count() === 1, 'file tree has one keyboard entry point');
  await folder.focus(); await page.keyboard.press('ArrowRight'); await page.getByRole('treeitem', { name: 'example.ts' }).waitFor(); await page.keyboard.press('ArrowRight');
  check(await page.getByRole('treeitem', { name: 'example.ts' }).evaluate((el) => el === document.activeElement), 'Right expands a directory and enters its child');
  await page.keyboard.press('ArrowLeft'); check(await folder.evaluate((el) => el === document.activeElement), 'Left returns from a child file to its parent');
  await page.keyboard.press('End'); check(await page.getByRole('treeitem', { name: 'README.md' }).evaluate((el) => el === document.activeElement), 'End reaches the last visible file');
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowLeft');
  check(await folder.getAttribute('aria-expanded') === 'false', 'Left collapses a directory without opening a file');
  failFiles = true; await page.getByRole('button', { name: 'Refresh files' }).click(); await page.getByRole('alert').waitFor();
  check(await folder.isVisible(), 'failed directory refresh retains browsable file rows');
  failFiles = false; await page.getByRole('button', { name: 'Retry', exact: true }).click(); await page.getByRole('alert').waitFor({ state: 'detached' }); check(rootReads >= 3, 'file refresh can recover explicitly');

  await scene('find'); await page.keyboard.press('Control+f'); const find = page.getByRole('searchbox', { name: 'Search loaded messages' }); await find.waitFor();
  check(await find.evaluate((el) => el === document.activeElement), 'conversation find shortcut focuses the search field');
  await find.fill('no-example-match'); await page.getByText('No matching loaded messages.', { exact: true }).waitFor(); check(true, 'conversation search reports empty results');
  await find.fill('needle'); await page.getByText(/105 matching messages.*showing the first 100/).waitFor();
  await find.press('Enter'); await page.getByText(/Result 1 of 105/).waitFor(); await find.press('Enter'); await page.getByText(/Result 2 of 105/).waitFor();
  check(await find.evaluate((el) => el === document.activeElement), 'Enter advances matches while keeping the search keyboard-focused');
  await find.press('Shift+Enter'); await page.getByText(/Result 1 of 105/).waitFor(); check(true, 'Shift Enter moves to the previous loaded match');
  await find.press('Escape'); check(await page.getByRole('button', { name: 'Find & bookmarks' }).evaluate((el) => el === document.activeElement), 'Escape closes conversation find and restores its trigger');

  await scene('queue'); await page.getByRole('button', { name: 'Edit queued message' }).click(); const queued = page.getByRole('textbox', { name: 'Edit queued message' });
  check(await queued.evaluate((el) => el === document.activeElement), 'queued edits receive keyboard focus');
  await queued.fill('Example edit to cancel'); await queued.press('Escape'); await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Edit queued message'); check(await page.getByRole('button', { name: 'Edit queued message' }).evaluate((el) => el === document.activeElement), 'Escape cancels queue edits and restores focus');
  await page.getByRole('button', { name: 'Edit queued message' }).click(); await queued.fill('Example local edit'); failQueue = true;
  await queued.press('Control+Enter'); await page.getByText('Latest queued text from the server').waitFor();
  await page.getByRole('button', { name: 'Example remote edit' }).click();
  // Refresh the conflict once the Example remote record changes.
  await queued.press('Control+Enter'); await page.getByText('Example newer queued task', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Use latest text' }).click(); await queued.fill('Example merged edit'); failQueue = false;
  await queued.press('Control+Enter'); await queued.waitFor({ state: 'detached' });
  check(writes.at(-1).expectedContent === 'Example newer queued task', 'accepting latest queue text updates the optimistic concurrency baseline');

  await scene('terminal'); await page.getByRole('button', { name: 'Open example terminal' }).click(); await page.locator('.xterm').waitFor();
  await page.getByRole('button', { name: 'Clear terminal output' }).click();
  check(await page.evaluate(() => window.exampleUX.terminalText() === ''), 'clear terminal removes retained display output');
  check(await page.evaluate(() => Object.values(window.exampleUX.stats).every((n) => n === 0)), 'clear terminal never starts, stops or types into the shell');

  await scene('palette'); await page.getByRole('button', { name: 'Open example palette' }).click(); const palette = page.getByRole('combobox', { name: 'Search commands' }); await palette.waitFor();
  check(await page.locator('[role=option][aria-selected=true]').getAttribute('aria-disabled') === 'false', 'palette opens on an available command');
  await palette.press('ArrowUp'); check(await page.locator('[role=option][aria-selected=true]').getAttribute('aria-disabled') === 'false', 'palette navigation skips unavailable commands');
  await palette.fill('no-example-command'); await page.getByRole('status').filter({ hasText: 'No matching commands.' }).waitFor(); check(true, 'empty command search is announced');

  await scene('controls');
  check(await page.getByRole('button', { name: 'Example external busy' }).getAttribute('aria-busy') === 'true', 'buttons preserve caller-owned busy state');
  const icon = page.getByRole('button', { name: 'Example refresh (busy)' });
  check(await icon.isDisabled() && (await icon.getAttribute('aria-describedby')).split(/\s+/).length === 2, 'busy icon buttons retain both external and unavailable descriptions');
  const alpha = page.getByRole('radio', { name: 'Alpha', exact: true }); await alpha.focus(); await alpha.press('End');
  check(await page.getByRole('radio', { name: 'Gamma' }).evaluate((el) => el === document.activeElement && el.getAttribute('aria-checked') === 'true'), 'segmented Home End moves both selection and focus');
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowLeft'); check(await page.getByRole('radio', { name: 'Gamma' }).evaluate((el) => el === document.activeElement), 'segmented arrow wrap skips disabled options');
  const switchControl = page.getByRole('switch', { name: 'Example switch' });
  check(await switchControl.getAttribute('aria-describedby') !== null, 'switch explanations are associated with the control');
  const select = page.getByRole('combobox', { name: 'Example read only' }); await select.click(); await select.press('a');
  check((await select.getAttribute('aria-activedescendant')).endsWith('-1'), 'select typeahead advances to the next matching option');
  await select.press('a'); check((await select.getAttribute('aria-activedescendant')).endsWith('-0'), 'repeated select typeahead cycles matching options');
  await page.getByRole('option', { name: 'Apricot', exact: true }).click(); check(await select.getAttribute('aria-valuetext') === 'Apple', 'read-only select cannot change the chosen value');
  await page.getByRole('button', { name: 'Example context menu', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem');
  check(await page.evaluate(() => document.activeElement?.textContent?.includes('Alpha one')), 'context menu takes keyboard focus when it opens');
  await page.keyboard.press('a'); check(await page.evaluate(() => document.activeElement?.textContent?.includes('Alpha two')), 'context menu typeahead works immediately after opening');
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Example dialog', exact: true }).click();
  check(await page.getByRole('textbox', { name: 'Example visible field' }).evaluate((el) => el === document.activeElement), 'dialog autofocus skips hidden fields');
  await page.setViewportSize({ width: 390, height: 780 }); await page.screenshot({ path: join(output, 'dialog-390.png') });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'dialog footer and controls fit 390px');
  await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1000, height: 760 });

  await scene('editor'); await page.getByRole('button', { name: 'Open example editor' }).click(); await page.getByRole('button', { name: /^Save/ }).waitFor({ timeout: 30_000 }).catch(async (e) => { console.log('Editor fixture:', await page.locator('body').innerText(), errors); throw e; });
  await page.getByRole('button', { name: 'Example edit file', exact: true }).click(); await page.getByRole('button', { name: /^Save/ }).click();
  await page.getByRole('alert').filter({ hasText: 'Your changes are still in the editor' }).waitFor();
  check((await page.getByLabel('Example editor state').textContent()).includes('Example edited file'), 'failed saves keep edited content and inline recovery');
  failSave = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Your changes are still in the editor' }).waitFor({ state: 'detached' });
  await page.waitForFunction(() => { const state = JSON.parse(document.querySelector('[aria-label="Example editor state"]').textContent)[0]; return state.original === 'Example edited file' && !state.saving; });
  check(JSON.parse(await page.getByLabel('Example editor state').textContent())[0].original === 'Example edited file', 'retry saves the retained editor draft');
  await page.screenshot({ path: join(output, 'editor.png') });
  check(unexpected.length === 0, `no unmocked API or external requests (${unexpected.join(', ')})`);
  check(errors.length === 0, `no browser runtime errors (${errors.join(', ')})`);
  console.log(`${checks} workspace UX checks passed. Screenshots: ${output}`);
} finally { await browser?.close(); await server?.close(); }
