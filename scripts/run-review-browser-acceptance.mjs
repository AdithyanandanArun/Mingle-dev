#!/usr/bin/env node
/**
 * Completion-review acceptance for the single-agent transcript.
 * Drives the real SessionPane, store, transcript layout, RunReview and RunChanges against an explicitly labelled Example session whose
 * /api/runs/:id/review and /changes endpoints are in-page stand-ins following the server's rules (the real rules are covered by the server
 * tests). Verifies placement (after the last assistant message, after the user message when none exists, orphan runs last) with exactly one
 * changes list per run, that recorded commands only restate statuses and exit codes (never "passed"), that the provider turn status is kept
 * apart from the agent's own goal report and checklist, partial / unloaded / truncated metadata, failures and interruptions, the exact-run
 * goal report, lazy loading with stale/aborted/unmounted/error fences, memo identity, the saved diff dialog with focus restoration, tasks left
 * in Review, keyboard operation, and 390px / 900px layouts. No server, account, provider or inference is involved; the Vite port is ephemeral.
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
const outDir = join(os.tmpdir(), `mingle-run-review-${process.pid}`);
mkdirSync(outDir, { recursive: true });
let server, browser, failed = false;
const report = {};
const errors = [];
let passed = 0;
const ORDER = ['run-ok', 'run-nocalls', 'run-partial', 'run-unavail', 'run-failed', 'run-interrupted', 'run-goal', 'run-tool-failure', 'run-latest', 'run-orphan'];
try {
  server = await createServer({ configFile: join(root, 'apps/web/vite.config.ts'), root, appType: 'mpa', logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false }, optimizeDeps: { entries: [join(root, 'scripts/run-review-browser-fixture.html')] }, resolve: { alias: [{ find: /^@mingle\/contracts$/, replacement: join(root, 'packages/contracts/src/index.ts') }, { find: /^@mingle\/contracts\/stream$/, replacement: join(root, 'packages/contracts/src/stream.ts') }, { find: 'react', replacement: join(root, 'apps/web/node_modules/react') }, { find: 'react-dom', replacement: join(root, 'apps/web/node_modules/react-dom') }], dedupe: ['react', 'react-dom'] } });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/run-review-browser-fixture.html`;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
  await page.routeWebSocket('**/ws', () => {});
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/status of (404|409|503)/.test(message.text())) errors.push(message.text()); });
  await page.route('**/api/**', (route) => route.fulfill({ status: 404, json: { error: 'Example fixture route only.' } }));

  const fresh = async ({ hold = false } = {}) => {
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.__review));
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.evaluate((h) => { if (h) window.__review.hold(); window.__review.mount(); }, hold);
    await page.locator('section.run-review').first().waitFor();
  };
  const settle = () => page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 80)));
  const reviews = (id) => page.evaluate((i) => window.__review.log().filter((e) => e.kind === 'review' && (!i || e.id === i)), id);
  const card = (id) => page.locator(`section.run-review[data-run-id="${id}"]`);
  const details = (id) => card(id).locator('details.run-review__details');
  const openDetails = async (id) => { await details(id).locator('> summary').click(); await page.waitForFunction((i) => document.querySelector(`section.run-review[data-run-id="${i}"] details.run-review__details`).open, id); };
  const closeDetails = async (id) => { await details(id).locator('> summary').click(); await page.waitForFunction((i) => !document.querySelector(`section.run-review[data-run-id="${i}"] details.run-review__details`).open, id); };
  const summaryOf = async (id) => (await details(id).locator('> summary').innerText()).replace(/\s+/g, ' ').trim();
  const group = (id, label) => card(id).locator('div.run-review__group', { has: page.locator('p.run-review__label', { hasText: new RegExp(`^${label}$`) }) });
  const outcomes = (id) => card(id).locator('.run-review__body .run-review__list[aria-label="Commands recorded for this turn"] li .run-review__outcome').allInnerTexts();
  const test = async (label, run) => {
    try { await run(); passed++; console.log(`PASS ${label}`); }
    catch (error) { failed = true; console.log(`FAIL ${label}: ${error.stack ?? error}`); try { await page.screenshot({ path: join(outDir, `fail-${passed}.png`) }); } catch { /* best effort */ } }
  };

  await test('one review card per run with something to review, in the right place, with exactly one changes list each', async () => {
    await fresh();
    assert.deepEqual(await page.locator('section.run-review').evaluateAll((els) => els.map((el) => el.dataset.runId)), ORDER, 'document order: placed runs in transcript order, the orphan last; the plain answer has none');
    assert.equal(await page.locator('.run-changes:not(.run-review .run-changes)').count(), 0, 'no stacked changes card outside the review');
    assert.equal(await page.locator('section.run-review .run-changes').count(), 7, 'one embedded list for each of the seven runs with saved or unavailable changes');
    for (const id of ['run-ok', 'run-nocalls', 'run-latest']) assert.equal(await card(id).locator('.run-changes').count(), 1);
    const where = await page.evaluate(() => {
      const text = (needle) => { const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (walker.nextNode()) if (walker.currentNode.textContent.includes(needle)) return walker.currentNode.parentElement; return null; };
      const before = (a, b) => Boolean(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
      const cardEl = (id) => document.querySelector(`section.run-review[data-run-id="${id}"]`);
      return {
        afterAssistant: before(text('Example reply 1 from run-ok'), cardEl('run-ok')) && before(cardEl('run-ok'), text('Example request 2')),
        fallbackUser: before(text('Example request 5'), cardEl('run-failed')) && before(cardEl('run-failed'), text('Example request 6')),
        orphanLast: before(text('Example reply 9'), cardEl('run-orphan')),
      };
    });
    assert.deepEqual(where, { afterAssistant: true, fallbackUser: true, orphanLast: true });
  });

  await test('only the newest run and the goal’s latest turn load evidence on their own; nothing else is requested or written', async () => {
    await fresh();
    await settle();
    const log = await page.evaluate(() => window.__review.log());
    assert.deepEqual(log.filter((e) => e.kind === 'review').map((e) => e.id).sort(), ['run-goal', 'run-latest']);
    assert.equal(log.filter((e) => e.kind === 'changes').length, 0, 'no saved diff downloads on render');
    assert.ok(log.every((e) => e.method === 'GET'));
    report.requestsAtMount = log.length;
  });

  await test('a finished provider turn is labelled as exactly that and kept apart from what the agent says', async () => {
    await fresh();
    await settle();
    const latest = card('run-latest');
    assert.equal((await latest.locator('.run-review__status').innerText()).trim(), 'Provider turn completed');
    assert.match(await latest.locator('.run-review__note').innerText(), /does not verify the goal/);
    assert.match(await summaryOf('run-latest'), /^Commands 1 command recorded$/);
    assert.match(await group('run-latest', 'Reported by the agent').innerText(), /Checklist as last reported in this turn: 1 of 1 marked complete\./);
    assert.equal(await group('run-latest', 'Reported by the agent').locator('text=/goal complete/i').count(), 0);
  });

  await test('recorded commands restate status and exit code only, never "passed", and never show tool output', async () => {
    await fresh();
    await settle();
    assert.equal((await reviews('run-ok')).length, 0, 'run-ok has not been asked for yet');
    assert.equal(await summaryOf('run-ok'), 'Commands 4 commands recorded · 1 failed · 1 exited non-zero · 1 without an exit code');
    await openDetails('run-ok');
    await page.waitForFunction(() => document.querySelectorAll('section[data-run-id="run-ok"] .run-review__list[aria-label="Commands recorded for this turn"] li').length === 4);
    assert.equal((await reviews('run-ok')).length, 1);
    assert.deepEqual(await outcomes('run-ok'), ['exit 0 · 1.2 s', 'exit 0 · 1.2 s', 'failed · exit 2 · 1.2 s', 'no exit code recorded · 1.2 s']);
    assert.equal(await card('run-ok').locator('.run-review__list[aria-label="Commands recorded for this turn"] li.is-bad').count(), 1, 'only the recorded command failure is highlighted');
    const text = await card('run-ok').innerText();
    assert.doesNotMatch(text.replace(/whether checks passed is unknown/, ''), /pass|success|green|verified by mingle/i);
    assert.match(text, /Mingle did not run these checks; test results are unknown\./);
    assert.doesNotMatch(text, /EXAMPLE-OUTPUT-NOT-SHOWN-IN-REVIEW/);
  });

  await test('the agent’s goal report and checklist are labelled as claims, attributed to the exact run, and leave tasks in Review', async () => {
    await fresh();
    await settle();
    await openDetails('run-ok');
    const agent = group('run-ok', 'Reported by the agent');
    await agent.locator('text=Example agent report: the helper is finished.').waitFor();
    const agentText = await agent.innerText();
    assert.match(agentText, /The agent reported the goal complete: “Example agent report: the helper is finished\.”/);
    assert.match(agentText, /own report, accepted as the goal’s outcome; Mingle has not verified it\./);
    assert.match(agentText, /Checklist as last reported in this turn: 1 of 3 marked complete, 2 still open\./);
    assert.deepEqual(await agent.locator('ul[aria-label="Checklist items still open"] li').allInnerTexts(), ['Example step: document the helper\nnot started', 'Example step: publish the helper\nblocked']);
    assert.match(agentText, /Mingle leaves completed items in Review for you to accept\./);
    const recorded = await group('run-ok', 'Recorded by Mingle').innerText();
    assert.doesNotMatch(recorded, /Example agent report|marked complete/);
    assert.equal((await card('run-ok').locator('.run-review__status').innerText()).trim(), 'Provider turn completed', 'the native status is unchanged by the agent’s claim');
    // The goal's latest summary belongs to its own last turn only.
    const pageText = await page.locator('body').innerText();
    assert.doesNotMatch(pageText, /Latest goal summary that must not appear on other runs/);
    // Another run's checklist step is not shown on this one and vice versa.
    assert.doesNotMatch(agentText, /later run/);
    assert.match(await group('run-latest', 'Reported by the agent').innerText(), /Checklist as last reported in this turn: 1 of 1 marked complete\./);
    assert.deepEqual(await page.evaluate(() => window.__review.taskStatuses()), { 'step-1': 'review', 'step-2': 'ready', 'step-3': 'blocked', 'step-x': 'review' });
  });

  await test('a goal turn with nothing else still gets its own card, and a blocked report reads as blocked', async () => {
    await fresh();
    await settle();
    const text = await card('run-goal').innerText();
    assert.match(text, /The agent reported it is blocked: “Example agent report: waiting for credentials\.”/);
    assert.match(text, /No change capture was saved for this run\./);
    assert.match(text, /No provider tool calls were captured for this turn\. That does not show that nothing ran\./);
    assert.equal(await details('run-goal').count(), 0);
  });

  await test('no provider tool calls: stated plainly, with no commands section and the changes still reviewable', async () => {
    await fresh();
    const text = await card('run-nocalls').innerText();
    assert.match(text, /No provider tool calls were captured for this turn\. That does not show that nothing ran\./);
    assert.match(text, /No checklist was recorded for this turn, so remaining work is not reported\./);
    assert.equal(await details('run-nocalls').count(), 0);
    assert.equal(await card('run-nocalls').getByRole('button', { name: 'Review changes' }).count(), 1);
  });

  await test('a completed turn with only a failed non-command call still has a review and shows the failure on demand', async () => {
    await fresh();
    const review = card('run-tool-failure');
    assert.equal(await review.count(), 1);
    assert.equal(await details('run-tool-failure').count(), 1);
    assert.equal((await summaryOf('run-tool-failure')), 'Recorded activity No commands recorded');
    await openDetails('run-tool-failure');
    await review.getByText('Other calls that failed or exited non-zero').waitFor();
    assert.deepEqual(await review.locator('ul[aria-label="Other tool calls with problems"] li').allInnerTexts(), ['Example file write failed\nfile · failed']);
  });

  await test('partial metadata is never presented as complete: truncated evidence, unloaded rows and unavailable change capture', async () => {
    await fresh();
    await settle();
    assert.equal(await summaryOf('run-partial'), 'Commands 55 commands recorded · outcomes not fully loaded');
    await openDetails('run-partial');
    await page.getByText('Showing 50 of 55 recorded commands.').waitFor();
    assert.equal(await card('run-partial').locator('.run-review__list[aria-label="Commands recorded for this turn"] li').count(), 50);
    assert.equal(await summaryOf('run-partial'), 'Commands 55 commands recorded · outcomes not fully loaded', 'still partial after loading the bounded list');
    const others = await card('run-partial').locator('ul[aria-label="Other tool calls with problems"] li').allInnerTexts();
    assert.deepEqual(others, ['Edit many.ts\nfile · failed'], 'the failed edit is listed once; the non-zero command is already in the command list');
    // Three recorded commands, none carried by the snapshot: the count is known, the outcomes are not, until evidence loads.
    assert.equal(await summaryOf('run-unavail'), 'Commands 3 commands recorded · outcomes not fully loaded');
    const unavailable = await card('run-unavail').innerText();
    assert.match(unavailable, /Changes unavailable/);
    assert.match(unavailable, /Example capture notice: the repository was locked\./);
    assert.equal(await card('run-unavail').getByRole('button', { name: 'Review changes' }).count(), 0, 'nothing to open when capture failed');
    await openDetails('run-unavail');
    await page.waitForFunction(() => /^Commands 3 commands recorded$/.test(document.querySelector('section[data-run-id="run-unavail"] details.run-review__details > summary').innerText.replace(/\s+/g, ' ').trim()));
  });

  await test('failed and interrupted turns say so, with the stored failure only for its own run', async () => {
    await fresh();
    await settle();
    assert.equal((await card('run-failed').locator('.run-review__status').innerText()).trim(), 'Provider turn failed');
    assert.match(await card('run-failed').innerText(), /The provider turn failed\./);
    assert.equal(await card('run-failed').locator('text=/quota/i').count(), 0, 'the failure record is loaded on demand');
    await openDetails('run-failed');
    await card('run-failed').locator('text=Usage quota exhausted').waitFor();
    assert.match(await card('run-failed').innerText(), /Usage quota exhausted: Example provider quota was exhausted\. The provider may have acted before it failed, so the outcome is unknown\./);
    assert.deepEqual(await outcomes('run-failed'), ['failed · exit 127 · 1.2 s']);
    assert.equal((await card('run-interrupted').locator('.run-review__status').innerText()).trim(), 'Turn interrupted');
    assert.match(await card('run-interrupted').innerText(), /The turn was interrupted before it finished, so changes and commands may be partial\./);
    await openDetails('run-interrupted');
    await page.waitForFunction(() => /interrupted/.test(document.querySelector('section[data-run-id="run-interrupted"] .run-review__list li .run-review__outcome')?.textContent ?? ''));
    assert.equal(await card('run-ok').locator('text=/quota/i').count(), 0);
  });

  await test('Review changes opens the existing saved diff, keeps focus inside, returns focus, and leaves tasks in Review', async () => {
    await fresh();
    await settle();
    const button = card('run-ok').getByRole('button', { name: 'Review changes' });
    await button.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByText('src/helper.ts').waitFor();
    await dialog.getByText('docs/notes.md').waitFor();
    assert.ok(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), 'focus moved into the dialog');
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), 'focus stays trapped'); }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.ok(await button.evaluate((el) => el === document.activeElement), 'focus returned to the Review changes button');
    const log = await page.evaluate(() => window.__review.log());
    assert.equal(log.filter((e) => e.kind === 'changes' && e.id === 'run-ok').length, 1);
    assert.ok(log.every((e) => e.method === 'GET'), 'reviewing writes nothing');
    assert.deepEqual(await page.evaluate(() => window.__review.taskStatuses()), { 'step-1': 'review', 'step-2': 'ready', 'step-3': 'blocked', 'step-x': 'review' });
    // A single file opens the same dialog filtered to that file.
    await card('run-ok').locator('.run-changes__folder').filter({ hasText: 'src' }).locator('> summary').click();
    await card('run-ok').getByRole('button', { name: /helper\.ts/ }).click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  });

  await test('keyboard: details open and close with Enter and Space and show a visible focus ring', async () => {
    await fresh();
    await settle();
    const summary = details('run-partial').locator('> summary');
    await summary.focus();
    assert.notEqual(await summary.evaluate((el) => getComputedStyle(el).outlineStyle), 'none', 'focus is visible');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('section[data-run-id="run-partial"] details.run-review__details').open);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('section[data-run-id="run-partial"] details.run-review__details').open);
    const reachable = await page.evaluate(() => [...document.querySelectorAll('section.run-review button, section.run-review summary')].every((el) => el.tabIndex >= 0));
    assert.ok(reachable);
  });

  await test('a run that finishes later gets its card then, evidence loads once, and the previous newest run keeps what it showed', async () => {
    await fresh();
    await settle();
    await page.evaluate(() => { window.__review.clearLog(); window.__review.startLive(); });
    await settle();
    assert.equal(await card('run-live').count(), 0, 'no card while running');
    assert.equal((await reviews()).length, 0);
    await page.evaluate(() => window.__review.finishLive(1));
    await card('run-live').waitFor();
    await page.waitForFunction(() => /1 command recorded/.test(document.querySelector('section[data-run-id="run-live"]')?.innerText ?? '') && !/Loading/.test(document.querySelector('section[data-run-id="run-live"]')?.innerText ?? ''));
    assert.deepEqual((await reviews()).map((e) => e.id), ['run-live']);
    assert.match(await summaryOf('run-latest'), /1 command recorded/);
    assert.equal(await page.locator('section.run-review[data-run-id="run-live"] .run-changes').count(), 1);
  });

  await test('errors can be retried, and a closed, superseded or unmounted request cannot change what is shown', async () => {
    await fresh();
    await settle();
    // Failure then retry.
    await page.evaluate(() => { window.__review.clearLog(); window.__review.fail(1); });
    await openDetails('run-partial');
    await card('run-partial').getByRole('alert').waitFor();
    assert.match(await card('run-partial').getByRole('alert').innerText(), /Could not load recorded details: Example review failure\./);
    assert.equal(await summaryOf('run-partial'), 'Commands 55 commands recorded · outcomes not fully loaded', 'the count from the run record still shows');
    await card('run-partial').getByRole('button', { name: 'Try again' }).click();
    await page.getByText('Showing 50 of 55 recorded commands.').waitFor();
    assert.equal(await card('run-partial').getByRole('alert').count(), 0);
    assert.equal((await reviews('run-partial')).length, 2);
    // Closing before the answer arrives aborts it and the late answer is not applied; opening again asks again.
    await page.evaluate(() => { window.__review.clearLog(); window.__review.hold(); });
    await openDetails('run-unavail');
    await page.waitForFunction(() => window.__review.heldCount() === 1);
    await closeDetails('run-unavail');
    await page.evaluate(() => window.__review.releaseAll());
    await settle();
    assert.deepEqual((await reviews('run-unavail')).map((e) => e.aborted), [true], 'the closed request was cancelled');
    assert.equal(await summaryOf('run-unavail'), 'Commands 3 commands recorded · outcomes not fully loaded', 'the late answer was ignored');
    await openDetails('run-unavail');
    await page.waitForFunction(() => /^Commands 3 commands recorded$/.test(document.querySelector('section[data-run-id="run-unavail"] details.run-review__details > summary').innerText.replace(/\s+/g, ' ').trim()));
    assert.equal((await reviews('run-unavail')).length, 2);
  });

  await test('an answer for an older version of the run is superseded; an unmounted card ignores its answer', async () => {
    await fresh({ hold: true });
    await page.waitForFunction(() => window.__review.heldCount() === 2);
    await page.evaluate(() => window.__review.addTool('run-latest'));
    await page.waitForFunction(() => window.__review.heldCount() === 3);
    await page.evaluate(() => window.__review.releaseAll());
    await page.waitForFunction(() => /2 commands recorded/.test(document.querySelector('section[data-run-id="run-latest"]').innerText) && !/Loading/.test(document.querySelector('section[data-run-id="run-latest"]').innerText));
    const latest = (await reviews('run-latest'));
    assert.equal(latest.length, 2);
    assert.equal(latest[0].aborted, true, 'the first request was cancelled when the run changed');
    assert.doesNotMatch(await card('run-latest').innerText(), /\b1 command recorded/);
    // Unmount with answers outstanding.
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.__review));
    await page.evaluate(() => { window.__review.hold(); window.__review.mount(); });
    await page.waitForFunction(() => window.__review.heldCount() === 2);
    await page.evaluate(() => window.__review.unmount());
    await page.evaluate(() => window.__review.releaseAll());
    await settle();
    assert.ok((await reviews()).every((e) => e.aborted), 'every outstanding request was cancelled by the unmount');
  });

  await test('memo identity: an identical snapshot changes no card, and one run’s checklist update changes only that run’s card', async () => {
    await fresh();
    await settle();
    await openDetails('run-ok');
    await page.waitForFunction(() => document.querySelector('section[data-run-id="run-ok"]').innerText.includes('Example agent report'));
    await page.evaluate(() => {
      window.__mutations = {};
      for (const el of document.querySelectorAll('section.run-review')) {
        const id = el.dataset.runId; window.__mutations[id] = 0;
        new MutationObserver((records) => { window.__mutations[id] += records.length; }).observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
      }
      window.__review.clearLog();
    });
    await page.evaluate(() => window.__review.publish());
    await settle();
    assert.deepEqual(await page.evaluate(() => Object.values(window.__mutations).reduce((a, b) => a + b, 0)), 0, 'an identical snapshot re-rendered nothing');
    assert.equal((await reviews()).length, 0, 'and fetched nothing');
    await page.evaluate(() => window.__review.setChecklist('step-2', 'completed'));
    await settle();
    const touched = await page.evaluate(() => Object.entries(window.__mutations).filter(([, n]) => n > 0).map(([id]) => id));
    assert.deepEqual(touched, ['run-ok']);
    assert.match(await group('run-ok', 'Reported by the agent').innerText(), /2 of 3 marked complete, 1 still open/);
  });

  await test('layouts at 900px and 390px keep every card inside the viewport, wrap long text and stay neutral (no blue, no gradients)', async () => {
    await fresh();
    await settle();
    for (const id of ORDER) if (await details(id).count()) await openDetails(id);
    await page.waitForFunction(() => document.querySelector('section[data-run-id="run-partial"]').innerText.includes('Showing 50 of 55'));
    for (const width of [900, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await settle();
      const geometry = await page.evaluate(() => {
        const limit = window.innerWidth;
        const wide = [...document.querySelectorAll('section.run-review, section.run-review *')].filter((el) => el.getBoundingClientRect().right > limit + 1 && getComputedStyle(el).position !== 'fixed');
        return { scroll: document.documentElement.scrollWidth, limit, wide: wide.slice(0, 5).map((el) => `${el.tagName}.${el.className}`) };
      });
      assert.ok(geometry.scroll <= geometry.limit, `no horizontal page scroll at ${width}px (${geometry.scroll} > ${geometry.limit})`);
      assert.deepEqual(geometry.wide, [], `nothing in a card extends past ${width}px`);
      const smallTargets = await page.evaluate(() => [...document.querySelectorAll('section.run-review button, section.run-review summary')].filter((el) => el.getBoundingClientRect().height < 24).map((el) => el.textContent.trim().slice(0, 30)));
      assert.deepEqual(smallTargets, [], 'interactive rows are at least 24px tall');
      await card('run-ok').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(outDir, `review-${width}.png`) });
    }
    const paint = await page.evaluate(() => {
      const bluish = (value) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(value); return Boolean(m) && Number(m[3]) > Number(m[1]) + 40 && Number(m[3]) > Number(m[2]) + 20; };
      const bad = [];
      let gradient = false;
      for (const el of document.querySelectorAll('section.run-review, section.run-review *')) {
        const s = getComputedStyle(el);
        if (/gradient/.test(s.backgroundImage)) gradient = true;
        if ([s.color, s.backgroundColor, s.borderTopColor, s.outlineColor].some(bluish)) bad.push(`${el.tagName}.${el.className}`);
      }
      const animated = [...document.querySelectorAll('section.run-review > *, section.run-review__group, .run-review__details, .run-review__body')].filter((el) => getComputedStyle(el).animationName !== 'none').length;
      return { gradient, bad: bad.slice(0, 5), animated };
    });
    assert.equal(paint.gradient, false);
    assert.deepEqual(paint.bad, []);
    assert.equal(paint.animated, 0, 'the review adds no animation (reduced motion is emulated)');
    await page.setViewportSize({ width: 1100, height: 900 });
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
