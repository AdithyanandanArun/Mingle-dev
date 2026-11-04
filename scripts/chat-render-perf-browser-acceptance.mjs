#!/usr/bin/env node
/**
 * Render-count acceptance for the single-agent transcript.
 * Drives the real SessionPane against an explicitly labelled Example transcript with synthetic streamed
 * deltas. Counts components that actually re-executed per React commit, so results do not depend on wall clock.
 * No server, account, provider or inference is involved; the Vite port is ephemeral.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = createRequire(join(root, 'apps/web/package.json'));
const serverRequire = createRequire(join(root, 'apps/server/package.json'));
const { createServer } = await import(pathToFileURL(web.resolve('vite')).href);
const { chromium } = serverRequire('playwright');
const TURNS = Number(process.env.CHAT_PERF_TURNS ?? 120);
const TOKENS = Number(process.env.CHAT_PERF_TOKENS ?? 40);
let server, browser, failed = false;
try {
  server = await createServer({ configFile: join(root, 'apps/web/vite.config.ts'), root, appType: 'mpa', logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { entries: [join(root, 'scripts/chat-render-perf-browser-fixture.html')] }, resolve: { alias: [{ find: 'react', replacement: join(root, 'apps/web/node_modules/react') }, { find: 'react-dom', replacement: join(root, 'apps/web/node_modules/react-dom') }], dedupe: ['react', 'react-dom'] } });
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, reducedMotion: 'reduce' });
  await page.routeWebSocket('**/ws', () => {});
  page.setDefaultTimeout(15_000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', (route) => route.fulfill({ status: 404, json: { error: 'Example fixture route only.' } }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/chat-render-perf-browser-fixture.html`);
  await page.waitForFunction(() => Boolean(window.__perf));
  await page.evaluate((turns) => window.__perf.mount(turns), TURNS);
  await page.locator('article.msg--assistant').last().waitFor();
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await settle();
  const measure = async (label, action) => {
    await page.evaluate(() => window.__renderCounts.reset());
    await action();
    await settle();
    const counts = await page.evaluate(() => ({ ...window.__renderCounts.snapshot(), commits: window.__renderCounts.commits() }));
    process.stdout.write(`${label}: ${JSON.stringify(counts)}\n`);
    return counts;
  };
  const lastId = `a-a-${TURNS - 1}`;
  const active = await measure(`active session, ${TOKENS} tokens (${TURNS} turns)`, () => page.evaluate(async ([id, n]) => {
    for (let i = 0; i < n; i++) { window.__perf.stream('a', id, `tok${i} `); await new Promise((r) => requestAnimationFrame(r)); }
  }, [lastId, TOKENS]));
  const unrelated = await measure(`unrelated session, ${TOKENS} tokens`, () => page.evaluate(async ([id, n]) => {
    for (let i = 0; i < n; i++) { window.__perf.stream('b', id, `tok${i} `); await new Promise((r) => requestAnimationFrame(r)); }
  }, [`b-a-${TURNS - 1}`, TOKENS]));
  const refetch = await measure('bootstrap refetch with identical data', () => page.evaluate(() => window.__perf.refreshBoot()));
  assert.match(await page.locator('article.msg--assistant').last().innerText(), /tok0 tok1/);
  assert.deepEqual(errors, []);
  // Placement: run activity directly follows its user message and a finished run's review (with exactly one embedded saved-change list) follows its final assistant message.
  const placement = await page.evaluate((turns) => {
    const bad = [];
    for (let i = 0; i < turns; i++) {
      const user = document.querySelector(`article[data-message-id="a-u-${i}"]`);
      const assistant = document.querySelector(`article[data-message-id="a-a-${i}"]`);
      if (!user?.nextElementSibling?.matches('details.run-activity')) bad.push(`activity after u-${i}`);
      if (i < turns - 1 && !assistant?.nextElementSibling?.matches('section.run-review')) bad.push(`review after a-${i}`);
      if (i < turns - 1 && assistant?.nextElementSibling?.querySelectorAll('.run-changes').length !== 1) bad.push(`one embedded change list after a-${i}`);
      if (i === turns - 1 && assistant?.nextElementSibling) bad.push('running run must not show a review');
    }
    return { bad, cards: document.querySelectorAll('section.run-changes').length };
  }, TURNS);
  assert.deepEqual(placement.bad, []);
  assert.equal(placement.cards, TURNS - 1);
  // Scroll pinning: stays on the latest output until the reader scrolls away, then stays put and offers a way back.
  const pinned = () => page.evaluate(() => { const el = document.querySelector('.chat__scroll'); return el.scrollHeight - el.scrollTop - el.clientHeight; });
  const streamLines = (count) => page.evaluate(async ([id, n]) => {
    for (let i = 0; i < n; i++) { window.__perf.stream('a', id, `line ${i}\n\n`); await new Promise((r) => requestAnimationFrame(r)); }
  }, [lastId, count]);
  await streamLines(30);
  const gap = await pinned(); assert.ok(gap < 40, `streamed output stays pinned to the bottom (gap ${gap}px)`);
  await page.evaluate(() => { document.querySelector('.chat__scroll').scrollTop = 0; });
  await page.locator('button.jump').waitFor();
  await streamLines(10);
  assert.ok((await page.evaluate(() => document.querySelector('.chat__scroll').scrollTop)) < 100, 'reading older messages is not interrupted by streamed output');
  await page.locator('button.jump').click();
  await page.waitForFunction(() => { const el = document.querySelector('.chat__scroll'); return el.scrollHeight - el.scrollTop - el.clientHeight < 40; });
  // A buffer whose message is not in the bootstrap yet appears as a new assistant message and keeps growing.
  await page.evaluate(() => { window.__perf.stream('a', 'example-fresh-message', 'Fresh '); window.__perf.stream('a', 'example-fresh-message', 'text'); });
  await page.locator('article[data-message-id="example-fresh-message"]').filter({ hasText: 'Fresh text' }).waitFor();
  // Budgets: only the streaming row may render per token (the pane itself once, when the buffer first appears); settled history never does.
  // RunActivity may tick once per second for the running run, so it is bounded by elapsed seconds rather than tokens.
  const bound = (counts, name, limit, label) => assert.ok((counts[name] ?? 0) <= limit, `${label}: ${name} rendered ${counts[name] ?? 0} times (limit ${limit})`);
  bound(active, 'MessageRow', TOKENS, 'streaming'); bound(active, 'ReactMarkdown', TOKENS, 'streaming'); bound(active, 'RunChanges', 0, 'streaming');
  bound(active, 'SingleSessionPane', 2, 'streaming'); bound(active, 'TranscriptEntry', 2, 'streaming'); bound(active, 'RunActivity', 3, 'streaming');
  for (const name of ['SingleSessionPane', 'TranscriptList', 'MessageRow', 'ReactMarkdown', 'RunChanges']) bound(unrelated, name, 0, 'unrelated session');
  for (const name of ['MessageRow', 'ReactMarkdown', 'RunChanges', 'LegacyToolGroup']) bound(refetch, name, 0, 'identical refetch');
  bound(refetch, 'RunActivity', 2, 'identical refetch');
  // Automatic prompts remain inspectable without appearing as additional messages from the person.
  await page.evaluate(() => window.__perf.workflowInstructions());
  for (const kind of ['workflow-continuation', 'workflow-verification', 'workflow-resume']) {
    const detail = page.locator(`details[data-message-id="example-${kind}"]`);
    await detail.waitFor();
    assert.equal(await detail.getAttribute('open'), null);
    assert.equal(await page.locator(`article[data-message-id="example-${kind}"]`).count(), 0);
    await detail.locator('summary').focus();
    await detail.locator('summary').press('Enter');
    await detail.locator('.conversation-detail__body').waitFor({ state: 'visible' });
    assert.match(await detail.innerText(), /Example internal follow-through prompt/);
  }
  assert.deepEqual(errors, []);
  process.stdout.write('chat render performance acceptance passed\n');
} catch (error) {
  failed = true; process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
} finally {
  await browser?.close(); await server?.close();
}
process.exitCode = failed ? 1 : 0;
