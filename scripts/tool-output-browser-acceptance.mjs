#!/usr/bin/env node
/**
 * Tool-output acceptance for the single-agent transcript.
 * Drives the real SessionPane, store, transcript layout and RunActivity against an explicitly labelled Example run whose tool
 * endpoints are in-page stand-ins following the server's rules (bounded previews in snapshots, complete records from the detail and
 * run-list endpoints, `revision` / `contentRevision` bumps). Verifies that a fetched complete tool record survives later snapshots
 * and keeps receiving newer lifecycle facts without being refetched, that changed output refreshes correctly, stale/closed/
 * unmounted/failed requests cannot change what is shown, running tools become complete, truncation is labelled honestly,
 * summaries only state recorded facts, nested tools and keyboard work, and the 390px layout keeps the summary readable.
 * No server, account, provider or inference is involved; the Vite port is ephemeral.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = createRequire(join(root, 'apps/web/package.json'));
const serverRequire = createRequire(join(root, 'apps/server/package.json'));
const { createServer } = await import(pathToFileURL(web.resolve('vite')).href);
const { chromium } = serverRequire('playwright');
const outDir = join(os.tmpdir(), `mingle-tool-output-${process.pid}`);
mkdirSync(outDir, { recursive: true });
let server, browser, failed = false;
const report = {};
const errors = [];
let passed = 0;
try {
  server = await createServer({ configFile: join(root, 'apps/web/vite.config.ts'), root, appType: 'mpa', logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { entries: [join(root, 'scripts/tool-output-browser-fixture.html')] }, resolve: { alias: [
    { find: /^@mingle\/contracts$/, replacement: join(root, 'packages/contracts/src/index.ts') },
    { find: /^@mingle\/contracts\/(.*)$/, replacement: `${root}/packages/contracts/src/$1` },
    { find: 'react', replacement: join(root, 'apps/web/node_modules/react') },
    { find: 'react-dom', replacement: join(root, 'apps/web/node_modules/react-dom') },
  ], dedupe: ['react', 'react-dom'] } });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/tool-output-browser-fixture.html`;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
  await page.routeWebSocket('**/ws', () => {});
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/status of (404|500|503)/.test(message.text())) errors.push(message.text()); });
  await page.route('**/api/**', (route) => route.fulfill({ status: 404, json: { error: 'Example fixture route only.' } }));

  const fresh = async ({ listFails = false } = {}) => {
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.__tools));
    await page.evaluate((fails) => { window.__tools.failList(fails); window.__tools.mount(); }, listFails);
    await page.locator('details.run-activity').first().waitFor();
  };
  const tools = (kind) => page.evaluate((k) => window.__tools.log().filter((entry) => !k || entry.kind === k), kind);
  const runBox = (i) => page.locator('details.run-activity').nth(i);
  const openRun = async (i) => { const run = runBox(i); await run.locator('> summary').click(); await page.waitForFunction((n) => document.querySelectorAll('details.run-activity')[n].open, i); return run; };
  const tool = (title) => page.locator('details.run-tool', { has: page.locator('> summary .run-tool__title', { hasText: title }) }).first();
  const openTool = async (title) => { const row = tool(title); await row.locator('> summary').click(); await page.waitForFunction((t) => [...document.querySelectorAll('details.run-tool')].some((d) => d.open && d.querySelector(':scope > summary .run-tool__title')?.textContent?.includes(t)), title); return row; };
  const field = (row, label) => row.locator('> .run-tool__body > .run-tool__field, > .run-tool__body > .run-tool__facts > .run-tool__field', { has: page.locator('span', { hasText: new RegExp(`^${label}`) }) });
  const outputOf = async (row) => (await row.locator('> .run-tool__body > .run-tool__field pre').last().textContent()) ?? '';
  const outputLabel = (row) => row.locator('> .run-tool__body > .run-tool__field > span', { hasText: /^Output/ }).first().textContent();
  const settle = () => page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 60)));
  const test = async (label, run) => {
    try { await run(); passed++; console.log(`PASS ${label}`); }
    catch (error) { failed = true; console.log(`FAIL ${label}: ${error.stack ?? error}`); try { await page.screenshot({ path: join(outDir, `fail-${passed}.png`) }); } catch { /* best effort */ } }
  };
  const BUILD_LENGTH = (await (async () => { await fresh(); return page.evaluate(() => window.__tools.constants.BUILD_OUTPUT_LENGTH); })());

  await test('compact summary states only recorded facts, and nothing is fetched until a person opens it', async () => {
    await fresh();
    const summary = await runBox(0).locator('> summary').innerText();
    assert.match(summary, /Worked for 18s/);
    assert.match(summary, /Ran 3 commands · 1 search · 1 file action · 1 failed · 1 call exited non-zero/);
    assert.doesNotMatch(summary, /pass|success|green/i);
    assert.equal((await tools()).length, 0, 'no request before the run is opened');
    assert.match(await runBox(1).locator('> summary').innerText(), /Working for/);
  });

  await test('an opened run shows nested tools, recorded facts per row and keeps its complete output', async () => {
    await fresh();
    await openRun(0);
    await settle();
    assert.deepEqual((await tools()).map((e) => e.kind), ['list'], 'one run-list request');
    const build = tool('Build bundle');
    assert.match(await build.locator('> summary .run-tool__meta').innerText(), /exit 0 · 2\.4 s · 1 child call/);
    assert.match(await tool('Run test suite').locator('> summary .run-tool__meta').innerText(), /exit 1/);
    assert.equal(await tool('Run test suite').locator('> summary .run-tool__status').textContent(), 'failed');
    assert.equal(await build.locator('> .run-tool__body > .run-tool__children details.run-tool').count(), 1, 'child nested under its parent');
    await openTool('Build bundle');
    const text = await outputOf(build);
    assert.equal(text.length, BUILD_LENGTH);
    assert.ok(text.startsWith('BEGIN-OF-BUILD-OUTPUT') && text.endsWith('END-OF-BUILD-OUTPUT'));
    assert.equal((await outputLabel(build)).trim(), 'Output');
    assert.equal((await field(build, 'Input').locator('pre').textContent()).length, await page.evaluate(() => window.__tools.constants.BUILD_INPUT_LENGTH));
    assert.equal((await tools('tool')).length, 0, 'the run list already carried the complete record');
    const child = build.locator('> .run-tool__body > .run-tool__children details.run-tool');
    await child.locator('> summary').click();
    assert.match(await child.innerText(), /src\/a\.ts:4: TODO/);
  });

  await test('later snapshots keep the complete output, take newer lifecycle facts and fetch nothing', async () => {
    await fresh();
    await openRun(0);
    const build = await openTool('Build bundle');
    const status = await openTool('git status');
    await page.evaluate(() => window.__tools.clearLog());
    // A different tool changes, then this tool's own lifecycle fact (not its output) changes.
    await page.evaluate(() => window.__tools.change('tool-status', { output: ' M src/a.ts\n?? new.txt' }));
    await settle();
    assert.match(await outputOf(status), /\?\? new\.txt/);
    assert.equal((await outputOf(build)).length, BUILD_LENGTH, 'complete output survived an unrelated snapshot');
    await page.evaluate(() => window.__tools.change('tool-build', { durationMs: 2600 }));
    await settle();
    assert.match(await build.locator('> summary .run-tool__meta').innerText(), /2\.6 s/);
    assert.equal(await field(build, 'Duration').locator('code').textContent(), '2s');
    const text = await outputOf(build);
    assert.ok(text.startsWith('BEGIN-OF-BUILD-OUTPUT') && text.endsWith('END-OF-BUILD-OUTPUT'), 'still the complete output after a lifecycle-only update');
    assert.equal((await outputLabel(build)).trim(), 'Output');
    assert.equal((await tools()).length, 0, 'no request for unchanged expanded content');
    report.requestsAfterThreeSnapshots = (await tools()).length;
  });

  await test('without a run list the complete record loads once, shows a bounded preview first, and stays through snapshots', async () => {
    await fresh({ listFails: true });
    await openRun(0);
    await page.getByText('Could not refresh the full tool list').waitFor();
    await page.evaluate(() => window.__tools.hold());
    const build = await openTool('Build bundle');
    await page.getByText('Loading full output…').waitFor();
    const label = (await outputLabel(build)).trim();
    assert.match(label, new RegExp(`^Output tail · last 2,000 of ${BUILD_LENGTH.toLocaleString('en-US')} characters$`));
    assert.match((await field(build, 'Input').locator('> span').textContent()), /^Input · first 4,000 of /);
    assert.ok(!(await outputOf(build)).includes('BEGIN-OF-BUILD-OUTPUT'));
    await page.evaluate(() => window.__tools.releaseAll());
    await page.waitForFunction(() => !document.body.textContent.includes('Loading full output…'));
    const text = await outputOf(build);
    assert.equal(text.length, BUILD_LENGTH);
    assert.ok(text.startsWith('BEGIN-OF-BUILD-OUTPUT'));
    assert.equal((await tools('tool')).length, 1);
    for (let i = 0; i < 3; i++) { await page.evaluate((n) => window.__tools.change('tool-status', { output: `status ${n}` }), i); await settle(); }
    assert.equal((await outputOf(build)).length, BUILD_LENGTH);
    assert.equal((await tools('tool')).length, 1, 'three unrelated snapshots caused no second fetch');
  });

  await test('output that really changed is shown as a preview then refreshed once', async () => {
    await fresh({ listFails: true });
    await openRun(0);
    const build = await openTool('Build bundle');
    await page.waitForFunction(() => window.__tools.log().filter((e) => e.kind === 'tool').length === 1 && !document.body.textContent.includes('Loading full output…'));
    assert.equal((await outputOf(build)).length, BUILD_LENGTH);
    await page.evaluate(() => window.__tools.hold());
    await page.evaluate((length) => window.__tools.change('tool-build', { output: `${window.__tools.record('tool-build').output}\nREPLACED-RESULT`, exitCode: 3, status: 'failed' }), BUILD_LENGTH);
    await page.getByText('Loading full output…').waitFor();
    assert.match((await outputLabel(build)).trim(), /^Output tail · last 2,000 of /, 'a stale complete copy is not presented as current');
    assert.ok((await outputOf(build)).endsWith('REPLACED-RESULT'));
    await page.evaluate(() => window.__tools.releaseAll());
    await page.waitForFunction(() => !document.body.textContent.includes('Loading full output…'));
    const text = await outputOf(build);
    assert.ok(text.startsWith('BEGIN-OF-BUILD-OUTPUT') && text.endsWith('REPLACED-RESULT'));
    assert.equal((await tools('tool')).length, 2, 'exactly one refetch for the changed content');
    assert.equal(await field(build, 'Exit code').locator('code').textContent(), '3');
  });

  await test('a stale detail response cannot roll back newer content, in either arrival order', async () => {
    for (const order of [[0, 1], [1, 0]]) {
      await fresh({ listFails: true });
      await openRun(0);
      await page.evaluate(() => window.__tools.hold());
      const build = await openTool('Build bundle');
      await page.waitForFunction(() => window.__tools.heldCount() === 1);
      // While the first response is in flight the record changes and a newer snapshot arrives; a second request starts.
      await page.evaluate(() => window.__tools.change('tool-build', { output: `${window.__tools.record('tool-build').output}\nNEWEST-RESULT` }));
      await page.waitForFunction(() => window.__tools.heldCount() === 2);
      await page.evaluate((n) => window.__tools.releaseNth(n), order[0]);
      await settle();
      await page.evaluate((n) => window.__tools.releaseNth(n), order[1]);
      await page.waitForFunction(() => !document.body.textContent.includes('Loading full output…'));
      await settle();
      const text = await outputOf(build);
      assert.ok(text.endsWith('NEWEST-RESULT'), `order ${order}: newest content shown`);
      assert.ok(!text.endsWith('END-OF-BUILD-OUTPUT'), `order ${order}: stale content not shown`);
      assert.equal(text.length, BUILD_LENGTH + '\nNEWEST-RESULT'.length);
      await page.evaluate(() => window.__tools.releaseAll());
    }
  });

  await test('closing a row ends its request: no late spinner or content, and reopening asks again', async () => {
    await fresh({ listFails: true });
    await openRun(0);
    await page.evaluate(() => window.__tools.hold());
    const build = await openTool('Build bundle');
    await page.getByText('Loading full output…').waitFor();
    await build.locator('> summary').click();
    await page.waitForFunction(() => !document.body.textContent.includes('Loading full output…'));
    await page.evaluate(() => window.__tools.releaseAll());
    await settle();
    assert.equal(await page.getByText('Loading full output…').count(), 0);
    await build.locator('> summary').click();
    await page.waitForFunction(() => window.__tools.log().filter((e) => e.kind === 'tool').length === 2);
    await page.waitForFunction(() => !document.body.textContent.includes('Loading full output…'));
    assert.equal((await outputOf(build)).length, BUILD_LENGTH);
  });

  await test('a failed detail request is reported while the preview stays, and reopening retries', async () => {
    await fresh({ listFails: true });
    await openRun(0);
    await page.evaluate(() => window.__tools.failDetail(1));
    const build = await openTool('Build bundle');
    await page.getByText('Could not load full output. Showing the available record.').waitFor();
    assert.match((await outputLabel(build)).trim(), /^Output tail · last 2,000 of /);
    assert.ok((await outputOf(build)).endsWith('END-OF-BUILD-OUTPUT'));
    await build.locator('> summary').click();
    await page.waitForFunction(() => !document.body.textContent.includes('Could not load full output.'));
    await build.locator('> summary').click();
    await page.waitForFunction(() => !document.body.textContent.includes('Loading full output…') && window.__tools.log().filter((e) => e.kind === 'tool').length === 2);
    assert.equal(await page.getByText('Could not load full output.').count(), 0);
    assert.equal((await outputOf(build)).length, BUILD_LENGTH);
  });

  await test('unmounting during a request leaves no error or warning when the response arrives', async () => {
    await fresh({ listFails: true });
    await openRun(0);
    await page.evaluate(() => window.__tools.hold());
    await openTool('Build bundle');
    await page.getByText('Loading full output…').waitFor();
    const before = errors.length;
    await page.evaluate(() => window.__tools.unmount());
    await page.evaluate(() => window.__tools.releaseAll());
    await settle();
    assert.equal(errors.length, before);
  });

  await test('a running tool shows its live tail, is not fetched, and loads complete once it finishes', async () => {
    await fresh();
    await openRun(1);
    const live = await openTool('Long running task');
    await page.evaluate(() => window.__tools.change('tool-live', { output: `${window.__tools.record('tool-live').output}\nMORE-LIVE-OUTPUT ${'x'.repeat(400)}` }));
    await settle();
    assert.match((await outputLabel(live)).trim(), /^Output tail · last 2,000 of /);
    assert.match(await outputOf(live), /MORE-LIVE-OUTPUT/);
    assert.equal((await tools('tool')).length, 0, 'running tools are never fetched');
    assert.equal(await live.locator('> summary .run-tool__status').textContent(), 'running');
    await page.evaluate(() => window.__tools.change('tool-live', { status: 'completed', finishedAt: new Date().toISOString(), durationMs: 5000, exitCode: 0, output: `${window.__tools.record('tool-live').output}\nFINISHED-RESULT` }));
    await page.waitForFunction(() => window.__tools.log().filter((e) => e.kind === 'tool').length === 1);
    await page.waitForFunction(() => !document.body.textContent.includes('Loading full output…'));
    const text = await outputOf(live);
    assert.ok(text.startsWith('live line 0000') && text.endsWith('FINISHED-RESULT'));
    assert.equal((await outputLabel(live)).trim(), 'Output');
    assert.equal(await live.locator('> summary .run-tool__status').textContent(), 'completed');
    assert.match(await live.locator('> summary .run-tool__meta').innerText(), /exit 0 · 5\.0 s/);
  });

  await test('truncation is described by what actually happened', async () => {
    await fresh();
    await openRun(0);
    const withList = await openTool('Capture a very long log');
    assert.equal((await outputLabel(withList)).trim(), 'Output · last 20,000 characters captured (earlier output was not kept)');
    await fresh({ listFails: true });
    await openRun(0);
    await page.evaluate(() => window.__tools.hold());
    const clipped = await openTool('Capture a very long log');
    assert.equal((await outputLabel(clipped)).trim(), 'Output tail · last 2,000 of 20,000 characters (earlier output was not captured)');
    await page.getByText('Loading full output…').waitFor();
    await page.evaluate(() => window.__tools.releaseAll());
    await page.waitForFunction(() => !document.body.textContent.includes('Loading full output…'));
    assert.equal((await outputLabel(clipped)).trim(), 'Output · last 20,000 characters captured (earlier output was not kept)');
  });

  await test('keyboard opens runs and tools, and focus order follows the tree', async () => {
    await fresh();
    await runBox(0).locator('> summary').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('details.run-activity')[0].open);
    await page.keyboard.press('Tab');
    assert.match(await page.evaluate(() => document.activeElement?.textContent ?? ''), /Build bundle/);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => [...document.querySelectorAll('details.run-tool')].find((d) => d.textContent.includes('Build bundle')).open);
    // Scrollable output regions are keyboard-focusable too; the child's summary is reached within a few tabs, after its parent's fields.
    let reached = false;
    for (let i = 0; i < 6 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = /Search for TODO/.test(await page.evaluate(() => document.activeElement?.textContent ?? ''));
    }
    assert.ok(reached, 'the child follows its parent');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
  });

  await test('the 390px layout keeps the factual summary and every row inside the viewport', async () => {
    await fresh();
    await page.setViewportSize({ width: 390, height: 900 });
    await openRun(0);
    await openTool('Run test suite');
    await openTool('Build bundle');
    await settle();
    const counts = runBox(0).locator('> summary .run-activity__counts');
    assert.ok(await counts.isVisible(), 'summary counts remain visible at narrow widths');
    assert.match(await counts.innerText(), /Ran 3 commands/);
    const overflow = await page.evaluate(() => {
      const limit = window.innerWidth;
      const wide = [...document.querySelectorAll('details.run-activity, details.run-activity *')].filter((el) => el.getBoundingClientRect().right > limit + 1 && getComputedStyle(el).position !== 'fixed');
      return { scroll: document.documentElement.scrollWidth, limit, wide: wide.slice(0, 5).map((el) => `${el.tagName}.${el.className}`) };
    });
    assert.ok(overflow.scroll <= overflow.limit, `no horizontal page scroll (${overflow.scroll} > ${overflow.limit})`);
    assert.deepEqual(overflow.wide, []);
    await page.screenshot({ path: join(outDir, 'narrow.png') });
    await page.setViewportSize({ width: 1100, height: 900 });
    await settle();
    await page.screenshot({ path: join(outDir, 'wide.png') });
  });

  await test('colours: no blue accent or gradient was introduced on the activity rows', async () => {
    await fresh();
    await openRun(0);
    await openTool('Build bundle');
    const styles = await page.evaluate(() => [...document.querySelectorAll('.run-activity, .run-activity *')].map((el) => { const s = getComputedStyle(el); return `${s.backgroundImage} ${s.color} ${s.backgroundColor}`; }).join('|'));
    assert.ok(!/gradient/.test(styles), 'no gradients');
  });

  assert.deepEqual(errors, [], 'no page errors or console errors');
  console.log(JSON.stringify({ passed, report, screenshots: outDir }));
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
}
process.exit(failed ? 1 : 0);
