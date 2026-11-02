#!/usr/bin/env node
// Disposable Example fixtures. Exercises the real component and HTTP boundary; no cloud or provider calls.
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
const output = join(tmpdir(), `mingle-memory-acceptance-${process.pid}`);
await mkdir(output, { recursive: true });
let server, browser;
const entry = { id: 'example-memory', title: 'Keep the UI neutral', body: 'Use existing flat surfaces and design tokens.', kind: 'convention', status: 'tentative', lifecycle: 'active', pinned: false, revision: 1, files: [{ path: 'src/theme.css' }], updatedAt: '2026-11-02T00:00:00.000Z', sources: [{ type: 'run', ref: 'example-run' }], updatedBy: { kind: 'agent', name: 'Example agent' }, origin: { local: true } };
try {
  server = await createServer({ configFile: join(root, 'apps/web/vite.config.ts'), root, appType: 'mpa', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { entries: [join(root, 'scripts/project-memory-browser-fixture.html')] }, resolve: { alias: [{ find: 'react', replacement: join(root, 'apps/web/node_modules/react') }, { find: 'react-dom', replacement: join(root, 'apps/web/node_modules/react-dom') }], dedupe: ['react', 'react-dom'] } });
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 820 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket('**/ws', () => {});
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: { projects: ['example-a', 'example-b'].map((id) => ({ id, name: id, path: `/example/${id}`, isExample: false, createdAt: '2026-11-02' })), sessions: [], messages: [], tasks: [], events: [], approvals: [], plans: [], questions: [], providers: [], settings: {}, version: 'Example fixture', runs: [], toolCalls: [] } }));
  let saved = { ...entry }, searchCount = 0, rejectEdit = false;
  await page.route('**/api/projects/*/memory**', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.includes('example-b')) return route.fulfill({ json: { entries: [], nextCursor: null, total: 0, sharing: { shared: false } } });
    if (url.pathname.endsWith('/history')) return route.fulfill({ json: { revisions: [{ id: 'revision-one', revision: 1, snapshot: { body: entry.body } }] } });
    if (request.method() === 'PATCH') {
      const { expectedRevision, ...patch } = request.postDataJSON();
      assert.equal(expectedRevision, saved.revision);
      if (rejectEdit) return route.fulfill({ status: 409, json: { error: 'Memory changed on another device. Refresh before correcting it.' } });
      saved = { ...saved, ...patch, revision: saved.revision + 1 };
      return route.fulfill({ json: { entry: saved, notices: [] } });
    }
    searchCount++;
    const q = url.searchParams.get('q') ?? '';
    return route.fulfill({ json: { entries: saved.lifecycle === 'retired' || (q && !saved.body.includes(q)) ? [] : [saved], nextCursor: null, total: 1, sharing: { shared: false } } });
  });
  await page.goto(`http://127.0.0.1:${port}/scripts/project-memory-browser-fixture.html`);
  await page.getByRole('heading', { name: entry.title }).waitFor();
  await page.getByText('src/theme.css', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Pin', exact: true }).click();
  await page.getByRole('button', { name: 'Unpin', exact: true }).waitFor();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByText('Entry history', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Correct', exact: true }).click();
  const edit = page.getByRole('textbox', { name: `Edit ${entry.title}` });
  await edit.fill('Use flat surfaces. Avoid gradients.');
  await page.getByRole('button', { name: 'Save correction' }).click();
  await page.getByText('Use flat surfaces. Avoid gradients.', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Search project memory' }).fill('missing');
  await page.getByText('No matching memories', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Search project memory' }).fill('');
  await page.getByRole('heading', { name: entry.title }).waitFor();
  rejectEdit = true;
  await page.getByRole('button', { name: 'Unpin', exact: true }).click();
  await page.getByText('Memory changed on another device. Refresh before correcting it.', { exact: true }).waitFor();
  rejectEdit = false;
  await page.getByRole('button', { name: 'Refresh project memory' }).click();
  await page.screenshot({ path: join(output, 'memory-desktop.png') });
  await page.setViewportSize({ width: 360, height: 740 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, 'memory-360.png') });
  await page.getByRole('button', { name: 'Switch example project' }).click();
  await page.getByText('Knowledge builds as you work', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: entry.title }).count(), 0);
  const before = searchCount;
  await page.getByRole('button', { name: 'Toggle panel' }).click();
  await page.waitForTimeout(400);
  assert.equal(searchCount, before, 'hidden panel does not poll');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: 8, output, fixtureOnly: true }));
} finally { await browser?.close(); await server?.close(); }
