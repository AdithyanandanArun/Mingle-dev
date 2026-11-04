#!/usr/bin/env node
/**
 * Long-conversation acceptance for the single-agent transcript.
 * Drives the real SessionPane, store and history client against an explicitly labelled Example transcript whose
 * history endpoint is an in-page stand-in following the server's cursor rules. Verifies progressive loading
 * (on demand, no idle polling), reader anchoring, live output and bootstrap precedence, run/tool/change placement,
 * loading/error/retry/end states, fencing across session switches, text accessibility of deferred rows and the
 * measured layout saving of deferred offscreen rendering. No server, account, provider or inference is involved;
 * the Vite port is ephemeral.
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
const TURNS = Number(process.env.HISTORY_TURNS ?? 600); // stored turns: two messages and a run each
const WINDOW = 300;
const PAGE = 100;
const pad = (n) => String(n).padStart(4, '0');
let server, browser, failed = false;
const report = {};
try {
  server = await createServer({ configFile: join(root, 'apps/web/vite.config.ts'), root, publicDir: join(root, 'apps/web/public'), appType: 'mpa', logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { entries: [join(root, 'scripts/session-history-browser-fixture.html')] }, resolve: { alias: [
    { find: /^@mingle\/contracts$/, replacement: join(root, 'packages/contracts/src/index.ts') },
    { find: /^@mingle\/contracts\/(.*)$/, replacement: `${root}/packages/contracts/src/$1` },
    { find: 'react', replacement: join(root, 'apps/web/node_modules/react') },
    { find: 'react-dom', replacement: join(root, 'apps/web/node_modules/react-dom') },
  ], dedupe: ['react', 'react-dom'] } });
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, reducedMotion: 'reduce' });
  await page.routeWebSocket('**/ws', () => {});
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/status of 404/.test(message.text())) errors.push(message.text()); });
  await page.route('**/api/**', (route) => route.fulfill({ status: 404, json: { error: 'Example fixture route only.' } }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/session-history-browser-fixture.html`);
  await page.waitForFunction(() => Boolean(window.__history));
  await page.evaluate((turns) => window.__history.mount(turns), TURNS);
  await page.locator('article.msg--assistant').last().waitFor();
  const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await frame();

  const fetches = () => page.evaluate(() => window.__history.log());
  const messageIds = () => page.evaluate(() => [...document.querySelectorAll('.chat__inner > article.msg')].map((el) => el.dataset.messageId));
  const gapToBottom = () => page.evaluate(() => { const el = document.querySelector('.chat__scroll'); return el.scrollHeight - el.scrollTop - el.clientHeight; });
  const unplacedRuns = () => page.evaluate(() => {
    // Runs whose user message is not in the transcript are listed after the last message.
    const column = document.querySelector('.chat__inner'); const kids = [...column.children];
    const lastMessage = kids.map((el) => el.matches('article.msg')).lastIndexOf(true);
    return kids.slice(lastMessage + 1).filter((el) => el.matches('[data-run-id]') && el.querySelector('.run-activity')).length;
  });
  const control = page.locator('.history-control');
  const loadButton = control.getByRole('button');
  const idsOf = (from, to) => Array.from({ length: to - from }, (_, k) => [`a-u-${pad(from + k)}`, `a-a-${pad(from + k)}`]).flat();

  // 1. Initial state: the bootstrap window only, a control to load more, and no request until a person asks.
  let ids = await messageIds();
  assert.equal(ids.length, WINDOW, 'only the bootstrap window is mounted');
  assert.deepEqual(ids, idsOf(TURNS - WINDOW / 2, TURNS));
  assert.equal(await control.getAttribute('data-history'), 'ready');
  assert.equal(await loadButton.innerText(), 'Load older messages');
  assert.equal(await unplacedRuns(), 50, 'runs whose messages are older than the window are listed after the messages');
  await page.waitForTimeout(1500);
  assert.deepEqual(await fetches(), [], 'nothing is fetched while idle');
  const openGap = await gapToBottom();
  assert.ok(openGap < 5, `the transcript opens on the latest output (gap ${openGap}px)`);
  const rowBox = await page.evaluate(() => { const el = document.querySelector('.chat__inner > article.msg--assistant'); return { name: el.getAttribute('aria-label') }; });
  assert.match(rowBox.name, /Assistant response/);

  // 2. Deferred offscreen rendering: most mounted rows are skipped by the browser while staying in the DOM.
  const skipped = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('.chat__inner > article.msg')];
    // A row that is skipped has its contents skipped: its first child is no longer rendered.
    const skippedRows = rows.filter((el) => !el.firstElementChild.checkVisibility({ contentVisibilityAuto: true }));
    return { rows: rows.length, skipped: skippedRows.length };
  });
  const initialSkip = await skipped();
  report.initialSkip = initialSkip;
  assert.ok(initialSkip.skipped >= initialSkip.rows * 0.8, `most offscreen rows skip layout (${initialSkip.skipped}/${initialSkip.rows})`);

  // 3. Read the top of the loaded window, then load older messages while a request is held to observe loading and overlap.
  await page.evaluate(() => { document.querySelector('.chat__scroll').scrollTop = 0; });
  await page.locator('button.jump').waitFor();
  await frame();
  const topRendered = await page.evaluate(() => [...document.querySelectorAll('.chat__inner > article.msg')].slice(0, 2).every((el) => el.firstElementChild.checkVisibility({ contentVisibilityAuto: true })));
  assert.ok(topRendered, 'rows at the viewport are rendered');
  const anchorBefore = await page.evaluate(() => {
    const scroller = document.querySelector('.chat__scroll'); const top = scroller.getBoundingClientRect().top;
    const row = [...document.querySelectorAll('.chat__inner > article.msg')].find((el) => el.getBoundingClientRect().bottom > top + 1);
    return { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - top };
  });
  await page.evaluate(() => {
    window.__liveValues = [];
    new MutationObserver(() => window.__liveValues.push(document.querySelector('.chat__scroll').getAttribute('aria-live'))).observe(document.querySelector('.chat__scroll'), { attributes: true, attributeFilter: ['aria-live'] });
    window.__history.holdNext();
  });
  await loadButton.click();
  await page.waitForFunction(() => document.querySelector('.history-control')?.getAttribute('data-history') === 'loading');
  assert.match(await loadButton.innerText(), /Loading older messages/);
  assert.equal(await loadButton.getAttribute('aria-disabled'), 'true');
  assert.equal(await loadButton.evaluate((el) => document.activeElement === el), true, 'the control keeps focus while loading');
  await loadButton.click({ force: true }); await loadButton.click({ force: true });
  assert.equal((await fetches()).length, 1, 'overlapping clicks make one request');
  // Live output arrives while history loads; the reader stays where they are.
  const lastId = `a-a-${pad(TURNS - 1)}`;
  await page.evaluate(([id]) => { for (let i = 0; i < 20; i++) window.__history.stream('a', id, `live ${i}\n\n`); }, [lastId]);
  await frame();
  assert.ok((await page.evaluate(() => document.querySelector('.chat__scroll').scrollTop)) < 100, 'streamed output does not pull a reader who scrolled away');
  await page.evaluate(() => window.__history.release());
  await page.waitForFunction((n) => document.querySelectorAll('.chat__inner > article.msg').length === n, WINDOW + PAGE);
  await frame();
  const request = (await fetches())[0];
  assert.deepEqual({ before: request.before, limit: request.limit }, { before: `a-u-${pad(TURNS - WINDOW / 2)}`, limit: PAGE + 1 }, 'pages before the oldest displayed message, one extra row to learn if more exist');

  // 3b. Reader anchor: the row that was at the top of the viewport stays where it was.
  const anchorAfter = await page.evaluate((id) => {
    const scroller = document.querySelector('.chat__scroll'); const el = document.querySelector(`article[data-message-id="${id}"]`);
    return { offset: el.getBoundingClientRect().top - scroller.getBoundingClientRect().top, scrollTop: scroller.scrollTop };
  }, anchorBefore.id);
  report.anchorShiftPx = Math.abs(anchorAfter.offset - anchorBefore.offset);
  assert.ok(report.anchorShiftPx <= 1.5, `the reader's anchor stays put after prepending (shift ${report.anchorShiftPx}px)`);
  assert.ok(anchorAfter.scrollTop > 1000, 'the view moved down past the prepended rows instead of jumping to the new top');
  // Live text survived and later fetched/old data never replaced it.
  assert.match(await page.locator(`article[data-message-id="${lastId}"]`).textContent(), /live 19/);
  // Chronological, duplicate free, in stored order.
  ids = await messageIds();
  assert.deepEqual(ids, idsOf(TURNS - (WINDOW + PAGE) / 2, TURNS));
  assert.equal(await unplacedRuns(), 0, 'runs of the loaded messages moved from after the messages to their user messages');
  // No arrival animation for older rows.
  const animated = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.closest?.('.chat__inner > .msg')).length);
  assert.equal(animated, 0, 'older rows do not animate in');

  // Assistive technology is not asked to read out the prepended history, and hears new output again afterwards.
  await page.waitForFunction(() => document.querySelector('.chat__scroll').getAttribute('aria-live') === 'polite');
  assert.deepEqual(await page.evaluate(() => window.__liveValues), ['off', 'polite']);

  // 3c. Placement of run activity and completion reviews with one embedded change list in the older rows.
  const placement = await page.evaluate(([from, to]) => {
    const bad = [];
    for (let i = from; i < to; i++) {
      const p = String(i).padStart(4, '0');
      const user = document.querySelector(`article[data-message-id="a-u-${p}"]`);
      const assistant = document.querySelector(`article[data-message-id="a-a-${p}"]`);
      if (!user?.nextElementSibling?.matches('[data-run-id]') || !user.nextElementSibling.querySelector('details.run-activity')) bad.push(`activity after u-${p}`);
      if (!assistant?.nextElementSibling?.matches('section.run-review')) bad.push(`review after a-${p}`);
      if (assistant?.nextElementSibling?.querySelectorAll('.run-changes').length !== 1) bad.push(`one embedded change list after a-${p}`);
    }
    return bad;
  }, [TURNS - (WINDOW + PAGE) / 2, TURNS - 1]);
  assert.deepEqual(placement, []);

  // 4. A failed page keeps everything, says so, and Retry loads the same page.
  const before = await messageIds();
  await page.evaluate(() => window.__history.failNext('Example history failure'));
  await page.evaluate(() => { document.querySelector('.chat__scroll').scrollTop = 0; });
  await loadButton.click();
  await page.locator('.history-note--error').waitFor();
  assert.match(await page.locator('.history-note--error').innerText(), /Could not load older messages: Example history failure/);
  assert.equal(await page.locator('.history-note--error').getAttribute('role'), 'alert');
  assert.equal(await loadButton.innerText(), 'Retry');
  assert.deepEqual(await messageIds(), before, 'a failure changes nothing that is shown');
  await loadButton.click();
  await page.waitForFunction((n) => document.querySelectorAll('.chat__inner > article.msg').length === n, WINDOW + 2 * PAGE);
  assert.equal(await page.locator('.history-note--error').count(), 0);
  const requests = await fetches();
  assert.equal(requests[1].before, requests[2].before, 'Retry pages before the same message');

  // 5. Bootstrap precedence and sliding: new messages arrive; everything loaded stays, nothing is duplicated.
  const countBeforeSlide = (await messageIds()).length;
  await page.evaluate(() => window.__history.slide(5));
  await page.waitForFunction((n) => document.querySelectorAll('.chat__inner > article.msg').length === n, countBeforeSlide + 10);
  ids = await messageIds();
  assert.equal(new Set(ids).size, ids.length, 'no duplicate messages after the window slid');
  assert.deepEqual(ids, idsOf(TURNS - (WINDOW + 2 * PAGE) / 2, TURNS + 5), 'messages that left the bootstrap window stay in place');
  // An identical bootstrap refetch re-renders no message of the loaded history.
  await page.evaluate(() => window.__renderCounts.reset());
  await page.evaluate(() => window.__history.refreshBoot());
  await frame();
  const refetch = await page.evaluate(() => window.__renderCounts.snapshot());
  assert.ok((refetch.MessageRow ?? 0) <= 2 && (refetch.ReactMarkdown ?? 0) <= 2, `a refetch does not re-render loaded history ${JSON.stringify(refetch)}`);

  // 6. Session switch fencing: a request in flight when the session is left is cancelled and applies nowhere.
  const loadedBefore = (await messageIds()).length;
  await page.evaluate(() => { document.querySelector('.chat__scroll').scrollTop = 0; });
  await page.evaluate(() => window.__history.holdNext());
  await loadButton.click();
  await page.waitForFunction(() => document.querySelector('.history-control')?.getAttribute('data-history') === 'loading');
  await page.evaluate(() => window.__history.select('b'));
  await page.locator('article[data-message-id="b-u-0000"]').waitFor();
  assert.equal(await page.locator('.history-control').count(), 0, 'a short session is complete in its bootstrap: no load control');
  assert.equal(await page.locator('[data-history]').count(), 0);
  await page.evaluate(() => window.__history.release());
  await frame();
  await page.evaluate(() => window.__history.select('a'));
  await page.locator(`article[data-message-id="${lastId}"]`).waitFor();
  await frame();
  const returned = await messageIds();
  assert.equal(new Set(returned).size, returned.length);
  assert.ok(returned.length >= WINDOW + 10 && returned.length <= loadedBefore, `history for a session you return to stays bounded and ordered (${returned.length})`);
  assert.equal(await control.getAttribute('data-history'), 'ready', 'the cancelled request left the control usable');

  // 7. Load everything: strictly older, in order, then an honest end of history.
  let guard = 0;
  while (await page.locator('.history-control').count() && guard++ < 30) {
    await page.evaluate(() => { document.querySelector('.chat__scroll').scrollTop = 0; });
    const current = (await messageIds()).length;
    await loadButton.click();
    await page.waitForFunction((n) => document.querySelectorAll('.chat__inner > article.msg').length > n || !document.querySelector('.history-control'), current);
  }
  await page.locator('[data-history="start"]').waitFor();
  assert.equal(await page.locator('[data-history="start"]').innerText(), 'Start of conversation');
  assert.equal(await page.locator('.history-control').count(), 0);
  ids = await messageIds();
  assert.equal(ids.length, (TURNS + 5) * 2, 'every stored message is shown exactly once');
  assert.deepEqual(ids, idsOf(0, TURNS + 5));
  const all = await fetches();
  assert.ok(all.filter((entry) => entry.status === 200 && entry.before).every((entry) => entry.limit === PAGE + 1));
  // The bootstrap carries the newest 200 runs; each sits under its own user message and none is left over at the end.
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.chat__inner > [data-run-id]')].filter((el) => el.querySelector('.run-activity')).length), 200);
  assert.equal(await unplacedRuns(), 0);
  report.fetches = all.length;
  report.messages = ids.length;
  report.domNodes = await page.evaluate(() => document.querySelectorAll('.chat__inner *').length);

  // 8. Deferred offscreen rendering with the full transcript mounted: skipped rows, layout saving, and text access.
  await page.locator('button.jump').click().catch(() => {});
  await page.waitForFunction(() => { const el = document.querySelector('.chat__scroll'); return el.scrollHeight - el.scrollTop - el.clientHeight < 40; });
  const fullSkip = await skipped();
  report.fullSkip = fullSkip;
  assert.ok(fullSkip.skipped >= fullSkip.rows * 0.9, `with ${fullSkip.rows} rows mounted nearly all offscreen rows are skipped (${fullSkip.skipped})`);
  // Stable pinning with the long transcript mounted.
  const pin = async (lines) => page.evaluate(async ([id, n]) => { for (let i = 0; i < n; i++) { window.__history.stream('a', id, `more ${i}\n\n`); await new Promise((r) => requestAnimationFrame(r)); } }, ['example-live-tail', lines]);
  const beforePin = { gap: await gapToBottom(), jump: await page.locator('button.jump').count() };
  await pin(20);
  const afterPin = await gapToBottom();
  assert.ok(afterPin < 40, `the view stays pinned to the bottom while text streams (before ${JSON.stringify(beforePin)}, after ${afterPin}px)`);

  // Browser-reported layout time for eight full-column relayouts (the column width changes each pass), with and without deferral.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metric = async (name) => (await cdp.send('Performance.getMetrics')).metrics.find((entry) => entry.name === name).value;
  const layoutCost = async (everythingVisible) => {
    await page.evaluate((visible) => {
      const style = document.createElement('style'); style.id = 'layout-cost-probe';
      style.textContent = visible ? '.chat__inner--history > .msg { content-visibility: visible !important; }' : '';
      document.head.append(style);
    }, everythingVisible);
    await frame();
    const duration = await metric('LayoutDuration');
    for (let pass = 0; pass < 8; pass++) {
      await page.evaluate((width) => { document.querySelector('.chat__inner').style.width = `${width}px`; return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); }, 700 + pass * 9);
    }
    const spent = ((await metric('LayoutDuration')) - duration) * 1000;
    await page.evaluate(() => { document.querySelector('.chat__inner').style.width = ''; document.getElementById('layout-cost-probe').remove(); });
    await frame();
    return spent;
  };
  const withDeferral = await layoutCost(false);
  const withoutDeferral = await layoutCost(true);
  report.relayoutMs = { deferred: Number(withDeferral.toFixed(1)), everythingRendered: Number(withoutDeferral.toFixed(1)), passes: 8, rows: fullSkip.rows };
  assert.ok(withDeferral < withoutDeferral * 0.75, `deferred offscreen layout makes full-column relayout much cheaper (${withDeferral.toFixed(0)}ms vs ${withoutDeferral.toFixed(0)}ms)`);

  // Text access: deferred rows are in the DOM, selectable and searchable.
  const textAccess = await page.evaluate(() => {
    const target = document.querySelector('article[data-message-id="a-u-0007"]');
    const hidden = !target.firstElementChild.checkVisibility({ contentVisibilityAuto: true });
    const inDom = document.querySelector('.chat__scroll').textContent.includes('Example question 0007');
    const range = document.createRange();
    range.setStartBefore(document.querySelector('article[data-message-id="a-u-0003"]'));
    range.setEndAfter(document.querySelector('article[data-message-id="a-a-0009"]'));
    const selected = range.toString();
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const text = selection.toString();
    selection.removeAllRanges();
    return { hidden, inDom, selectedHasSkipped: selected.includes('Example question 0007') && selected.includes('Example answer 9'), selectionHasSkipped: text.includes('Example question 0007') };
  });
  assert.deepEqual(textAccess, { hidden: true, inDom: true, selectedHasSkipped: true, selectionHasSkipped: true });
  // The browser's own find reveals and scrolls to a skipped row.
  const found = await page.evaluate(() => {
    getSelection().removeAllRanges();
    const ok = window.find('Example question 0011:');
    const row = getSelection().anchorNode?.parentElement?.closest('article.msg');
    return { ok, id: row?.dataset.messageId, rendered: row ? row.firstElementChild.checkVisibility({ contentVisibilityAuto: true }) : null };
  });
  assert.equal(found.ok, true, 'find-in-page locates text in a skipped row');
  assert.equal(found.id, 'a-u-0011');
  assert.equal(found.rendered, true, 'the found row is rendered');

  // 8. Standalone reader position and text-only draft survive navigation and reload without entering transcripts.
  await page.evaluate(() => {
    const scroller = document.querySelector('.chat__scroll');
    const anchor = document.querySelector('article[data-message-id="a-u-0450"]');
    scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24;
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
  });
  await page.waitForTimeout(650);
  const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('mingle:conversation-cache:v1') ?? '{}'));
  const savedPosition = cached.sessions.a?.reader;
  assert.ok(savedPosition && savedPosition.pinned === false && (savedPosition.messageId || savedPosition.runId), 'reader cache contains a stable ID and offset while reading away from latest');
  await page.evaluate(() => window.__history.select('b'));
  await page.locator('article[data-message-id="b-u-0000"]').waitFor();
  await page.evaluate(() => window.__history.select('a'));
  await page.locator(`article[data-message-id="${savedPosition.messageId}"]`).waitFor();
  await frame();
  const returnedOffset = await page.locator(`article[data-message-id="${savedPosition.messageId}"]`).evaluate((el) => el.getBoundingClientRect().top - document.querySelector('.chat__scroll').getBoundingClientRect().top);
  assert.ok(Math.abs(returnedOffset - savedPosition.offset) <= 3, `session return restores the same loaded row (offset ${returnedOffset})`);

  const draft = 'Example unsent draft survives reload';
  await page.locator('textarea.composer__input').fill(draft);
  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem('mingle:conversation-cache:v1') ?? '{}');
    return saved.sessions.a?.draft === 'Example unsent draft survives reload';
  });
  await page.evaluate(() => window.__history.select('b'));
  await page.locator('textarea.composer__input').fill('Example session B draft');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('mingle:conversation-cache:v1') ?? '{}').sessions.b?.draft === 'Example session B draft');
  await page.evaluate(() => window.__history.select('a'));
  await page.waitForFunction((value) => document.querySelector('textarea.composer__input')?.value === value, draft);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__history));
  await page.evaluate((turns) => window.__history.mount(turns), TURNS);
  await page.locator('textarea.composer__input').waitFor();
  await page.evaluate(() => window.__history.setStatus('a', 'idle'));
  await page.waitForFunction((value) => document.querySelector('textarea.composer__input')?.value === value, draft);
  const reloadOffset = await page.locator(`article[data-message-id="${savedPosition.messageId}"]`).evaluate((el) => el.getBoundingClientRect().top - document.querySelector('.chat__scroll').getBoundingClientRect().top);
  assert.ok(Math.abs(reloadOffset - savedPosition.offset) <= 3, `reload restores the saved loaded reader row (offset ${reloadOffset})`);
  await page.evaluate(() => window.__history.failSend('Example send failure'));
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('alert').filter({ hasText: 'Example send failure' }).waitFor();
  assert.equal(await page.locator('textarea.composer__input').inputValue(), draft, 'a failed send keeps the draft');
  await page.evaluate(() => window.__history.holdSend());
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => window.__history.sends().length === 2);
  const newerDraft = 'Example newer typing while send is pending';
  await page.locator('textarea.composer__input').fill(newerDraft);
  await page.evaluate(() => window.__history.releaseSend());
  await page.waitForFunction((value) => document.querySelector('textarea.composer__input')?.value === value, newerDraft);
  await page.waitForFunction((value) => JSON.parse(localStorage.getItem('mingle:conversation-cache:v1') ?? '{}').sessions.a?.draft === value, newerDraft);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => document.querySelector('textarea.composer__input')?.value === '');
  await page.waitForFunction(() => !JSON.parse(localStorage.getItem('mingle:conversation-cache:v1') ?? '{}').sessions.a?.draft);

  const olderPosition = { pinned: false, messageId: 'a-u-0001', offset: 24 };
  await page.evaluate((reader) => {
    const cache = JSON.parse(localStorage.getItem('mingle:conversation-cache:v1') ?? '{"version":1,"sessions":{}}');
    cache.sessions.a = { ...cache.sessions.a, reader, touchedAt: Date.now() };
    localStorage.setItem('mingle:conversation-cache:v1', JSON.stringify(cache));
  }, olderPosition);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__history));
  await page.evaluate((turns) => window.__history.mount(turns), TURNS);
  await page.evaluate(() => window.__history.setStatus('a', 'idle'));
  await page.locator('.chat__reader-notice').getByRole('button', { name: 'Load older messages' }).waitFor();
  const requestsBeforeRecovery = await fetches();
  await page.waitForTimeout(500);
  assert.deepEqual(await fetches(), requestsBeforeRecovery, 'a missing older anchor shows an explicit recovery action without automatic paging');

  // 9. Actual application shell layout: the navigation control remains below the global header.
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForFunction(() => {
    const logo = document.querySelector('.sidebar__logo');
    return logo instanceof HTMLImageElement && logo.complete && logo.naturalWidth > 0;
  });
  await frame();
  const desktopShell = await page.evaluate(() => {
    const header = document.querySelector('.header').getBoundingClientRect();
    const navigation = document.querySelector('.conversation-nav').getBoundingClientRect();
    return { headerBottom: header.bottom, navigationTop: navigation.top, sidebarVisible: getComputedStyle(document.querySelector('.sidebar')).display !== 'none', composerVisible: Boolean(document.querySelector('.composer')) };
  });
  assert.ok(desktopShell.sidebarVisible && desktopShell.composerVisible && desktopShell.navigationTop >= desktopShell.headerBottom - 1, 'desktop header, sidebar, composer and conversation control fit without overlay');
  await page.screenshot({ path: '/tmp/item10-full-shell-900.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  await page.locator('.sidebar.is-open').waitFor();
  await page.waitForTimeout(220);
  await page.screenshot({ path: '/tmp/item10-full-shell-390-sidebar.png' });
  await page.locator('.sidebar-scrim').click({ position: { x: 350, y: 400 }, force: true });
  await page.waitForFunction(() => !document.querySelector('.sidebar')?.classList.contains('is-open'));
  await page.waitForTimeout(220);
  const mobileShell = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, sidebarOpen: document.querySelector('.sidebar')?.classList.contains('is-open'), scrim: document.querySelector('.sidebar-scrim')?.className, headerText: document.querySelector('.header')?.textContent, mainRect: document.querySelector('.main')?.getBoundingClientRect().toJSON(), nav: document.querySelector('.conversation-nav').getBoundingClientRect().toJSON(), header: document.querySelector('.header').getBoundingClientRect().toJSON(), composer: document.querySelector('.composer').getBoundingClientRect().toJSON() }));
  assert.equal(mobileShell.overflow, false, 'the 390px shell has no horizontal overflow');
  assert.equal(mobileShell.sidebarOpen, false, 'the mobile sidebar closes before the chat shell is captured');
  assert.ok(mobileShell.nav.top >= mobileShell.header.bottom - 1, 'mobile conversation navigation stays below the global header');
  await page.screenshot({ path: '/tmp/item10-full-shell-390.png' });
  assert.deepEqual(errors, []);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.stdout.write('session history browser acceptance passed\n');
} catch (error) {
  failed = true; process.stderr.write(`${error instanceof Error ? error.stack : error}\n${JSON.stringify(report)}\n`);
} finally {
  await browser?.close(); await server?.close();
}
process.exitCode = failed ? 1 : 0;
