#!/usr/bin/env node
// Composer activity browser acceptance. Mounts the real SessionPane (Chat, Composer, SubagentRail, UserQuestionCard)
// through an in-process Vite server; every /api request and store socket is answered locally from Example fixtures.
// No provider process, inference or cloud service is reached. Fixture records are labelled Example data.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createPortProbe } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = createRequire(join(root, 'apps/web/package.json'));
const serverRequire = createRequire(join(root, 'apps/server/package.json'));
const { createServer } = await import(pathToFileURL(web.resolve('vite')).href);
const { chromium } = serverRequire('playwright');
const output = process.env.COMPOSER_ACTIVITY_ACCEPTANCE_OUTPUT || join(tmpdir(), `mingle-composer-activity-acceptance-${process.pid}`);
await mkdir(output, { recursive: true });

const PAGE_PATH = '/composer-activity-acceptance.html';
const SESSION = 'example-session';
const PROJECT = 'example-project';
const RUN = 'example-native-run';
const QUESTION = 'example-question-1';
const SCOPE = 'example-question-scope';
const iso = (ms = Date.now()) => new Date(ms).toISOString();
// Requests the Example fixture deliberately does not answer; they are tolerated, every other unmocked path fails.
const unmockedAllowed = /\/api\/(projects\/[^/]+\/(repository|github|context|memory|files|git|tasks)|runs\/[^/]+\/(review|changes)|sessions\/[^/]+\/(memory-injections|workflow|snapshot|attachments)|tool-calls\/)/;

let server, browser, fixtureUrl, world;
const aggregate = { unmocked: [], external: [] };
let failureCount = 0;

// ——— Example world served by the mocked local API ———
const providers = [
  { id: 'claude', name: 'Claude', available: true, version: 'Example fixture', executable: null, reason: null, policies: ['supervised', 'balanced', 'full-access'], promptCapabilities: { image: true, embeddedContext: true },
    models: [{ id: 'claude-example', name: 'Example Claude', reasoningEfforts: [{ id: 'medium', label: 'Medium' }], defaultReasoningEffort: 'medium', policies: ['supervised', 'balanced', 'full-access'] }] },
];
const settings = { defaultProvider: 'claude', defaultCodexModel: 'codex-example', defaultClaudeModel: 'claude-example', defaultEffort: 'medium', defaultIsolated: true,
  defaultPolicy: 'supervised', defaultServiceTier: 'standard', theme: 'dark', claudeExecutable: '', codexExecutable: '', onboardingCompletedVersion: 1, autoResumeOnRestart: false };
const QUESTIONS = [
  { id: 'scope', header: 'Scope', question: 'Which Example area should change?', options: [{ label: 'Header' }, { label: 'Composer', description: 'Example composer shell' }], multiSelect: false, allowOther: false, secret: false },
  { id: 'checks', header: 'Checks', question: 'Which Example checks should run?', options: [{ label: 'Visual' }, { label: 'Keyboard' }], multiSelect: true, allowOther: false, secret: false },
];
function freshWorld() {
  return {
    sessionStatus: 'idle', questions: [], nativeChild: null, delegated: [], steps: [], questionFailures: [], messages: [], queuedMessages: [],
    log: [], sockets: [],
  };
}
function questionRecord(overrides = {}) {
  return { id: QUESTION, sessionId: SESSION, runId: RUN, provider: 'claude', tool: 'AskUserQuestion', questions: QUESTIONS,
    status: 'pending', createdAt: iso(Date.now() - 30_000), resolvedAt: null, ...overrides };
}
function delegatedRecord(status = 'running') {
  return { id: 'example-model-delegation', parentSessionId: SESSION, childSessionId: 'example-child', name: 'example-reviewer', provider: 'claude', model: 'claude-example',
    task: 'Review Example source', status, requestedBy: 'agent', startedAt: iso(Date.now() - 90_000), endedAt: status === 'running' ? null : iso(), resultPreview: null, error: null, resultDelivered: false };
}
function bootstrapPayload() {
  const at = iso(Date.now() - 120_000);
  const native = world.nativeChild;
  const runs = native ? [{ id: RUN, sessionId: SESSION, userMessageId: 'example-parent-request', provider: 'claude', model: 'claude-example', status: native === 'running' ? 'running' : 'completed',
    startedAt: at, finishedAt: native === 'running' ? null : iso(), durationMs: null, toolCount: 1, toolCounts: { agent: 1 } }] : [];
  const toolCalls = native ? [{ id: 'example-spawn', providerId: 'example-spawn-native', runId: RUN, sessionId: SESSION, parentProviderId: null, category: 'agent', name: 'Agent',
    status: native === 'running' ? 'running' : 'completed', summary: 'Example automatic review', command: null,
    input: JSON.stringify({ description: 'Example source review', prompt: 'Review the Example source', model: 'example-child-model' }),
    output: native === 'running' ? '' : 'Example review finished.', cwd: null, exitCode: null, processId: null, startedAt: at,
    finishedAt: native === 'running' ? null : iso(), durationMs: null,
    subagentMessages: native === 'running' ? [] : [{ id: 'example-child-reply', content: 'Example source is ready.', createdAt: iso() }] }] : [];
  const events = world.steps.length ? [{ id: 1, projectId: PROJECT, sessionId: SESSION, type: 'session.progress.plan', summary: 'Example checklist', payload: { steps: world.steps }, createdAt: at }] : [];
  return {
    projects: [{ id: PROJECT, name: 'Example project', path: '/example/project', isExample: false, createdAt: '2026-11-03T00:00:00.000Z' }],
    sessions: [{ id: SESSION, projectId: PROJECT, name: 'Example session', provider: 'claude', model: 'claude-example', effort: 'medium', status: world.sessionStatus, policy: 'supervised',
      serviceTier: 'standard', isolated: true, worktreePath: '/example/project/worktree', branch: 'example/session', providerSessionId: null, createdAt: at, updatedAt: at,
      error: null, inputTokens: 0, outputTokens: 0, costUsd: null, pinned: false, unread: false }],
    messages: [{ id: 'example-parent-request', sessionId: SESSION, role: 'user', content: 'Example request for the composer activity fixture', createdAt: at }, ...world.messages],
    queuedMessages: world.queuedMessages, delegatedSubagents: world.delegated, tasks: [], events, approvals: [], plans: [], questions: world.questions, providers, settings,
    version: 'Example fixture', runs, toolCalls, groups: [], workflows: [], lastProjectId: PROJECT,
  };
}

// ——— Local API boundary ———
async function handle(route) {
  const request = route.request(), method = request.method(), url = new URL(request.url()), path = url.pathname;
  let body;
  if (['POST', 'PATCH', 'PUT'].includes(method)) { try { body = request.postDataJSON(); } catch { body = undefined; } }
  world.log.push({ method, path, body });
  const json = (payload, status = 200) => route.fulfill({ status, json: payload });
  const fail = (status, error) => json({ error }, status);
  let match;
  if (path === '/api/bootstrap') return json(bootstrapPayload());
  if (path === '/api/workspace/selection') return json({ projectId: PROJECT });
  if ((match = path.match(/^\/api\/sessions\/([^/]+)\/catalog$/))) return json({ commands: [], skills: [], warnings: [] });
  if ((match = path.match(/^\/api\/sessions\/([^/]+)\/recovery$/))) return json({ checkpoint: null, failure: null });
  if ((match = path.match(/^\/api\/sessions\/([^/]+)\/usage$/))) return json({ provider: 'claude', fetchedAt: iso(), status: 'available', plan: 'Example plan', windows: [], credits: null, resets: null, notices: [], session: { id: match[1], inputTokens: 0, outputTokens: 0, costUsd: null } });
  if ((match = path.match(/^\/api\/sessions\/([^/]+)\/attachments$/))) return method === 'GET' ? json([]) : fail(400, 'Attachments are not part of this Example fixture.');
  if ((match = path.match(/^\/api\/sessions\/([^/]+)\/workflow$/))) return json({ workflow: null });
  if ((match = path.match(/^\/api\/sessions\/([^/]+)\/memory-injections$/))) return json({ injections: [] });
  if ((match = path.match(/^\/api\/sessions\/([^/]+)\/snapshot$/))) return fail(409, 'Example fixture uses the full bootstrap.');
  if ((match = path.match(/^\/api\/sessions\/([^/]+)\/messages$/)) && method === 'POST') return json({ accepted: true });
  if ((match = path.match(/^\/api\/sessions\/([^/]+)$/)) && method === 'PATCH') {
    const target = bootstrapPayload().sessions.find((item) => item.id === match[1]);
    if (!target) return fail(404, 'Unknown Example session.');
    return json({ ...target, ...body });
  }
  if ((match = path.match(/^\/api\/runs\/([^/]+)\/tools$/))) return json(bootstrapPayload().toolCalls.filter((call) => call.runId === match[1]));
  if ((match = path.match(/^\/api\/questions\/([^/]+)\/(answer|cancel)$/)) && method === 'POST') {
    const question = world.questions.find((item) => item.id === match[1]);
    if (!question) return fail(404, 'Unknown Example question.');
    if (question.status !== 'pending') return fail(409, 'This Example question was already resolved.');
    if (match[2] === 'answer' && world.questionFailures.length) return fail(world.questionFailures.shift().status, 'This Example question was already resolved elsewhere.');
    const at = iso();
    Object.assign(question, match[2] === 'answer' ? { status: 'answered', answers: body, resolvedAt: at } : { status: 'cancelled', resolvedAt: at });
    return json(question);
  }
  if (/^\/api\/sessions\/[^/]+\/interrupt$/.test(path)) return json({ ok: true });
  aggregate.unmocked.push(`${method} ${path}`);
  return fail(404, 'Not exposed by the Example composer activity fixture.');
}

// ——— Harness ———
let passed = 0;
const failures = [];
const screenshots = [];
const sameOrigin = (urlText) => new URL(urlText).hostname === '127.0.0.1';
async function withPage({ viewport = { width: 1000, height: 860 }, reducedMotion = 'reduce', setup }, run) {
  world = freshWorld();
  setup?.();
  const context = await browser.newContext({ viewport, reducedMotion });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
  page.on('request', (request) => { if (!sameOrigin(request.url())) aggregate.external.push(request.url()); });
  // The store opens its socket during bootstrap. Keep it inside Playwright so the real onopen path runs without a runtime.
  const socket = (ws) => world.sockets.push(ws.url());
  await context.routeWebSocket('**/ws', socket);
  await context.routeWebSocket('**/ws/**', socket);
  // Vite's injected dev client opens a separate socket even with HMR disabled; mock only its exact URL shape.
  await context.routeWebSocket(/^ws:\/\/127\.0\.0\.1:\d+\/\?token=/, () => {});
  await context.route('**/api/**', handle);
  await context.route(`**${PAGE_PATH}`, async (route) => {
    const html = await server.transformIndexHtml(PAGE_PATH, '<!doctype html><html lang="en" data-theme="dark"><head><meta charset="UTF-8" /><title>Composer activity acceptance (Example data)</title></head><body><div id="root"></div><script type="module" src="/scripts/composer-activity-browser-fixture.tsx"></script></body></html>');
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  const shot = async (name) => { const file = join(output, `${name}.png`); await page.screenshot({ path: file, fullPage: true }); screenshots.push(file); };
  try {
    await page.goto(new URL(PAGE_PATH, fixtureUrl).href, { waitUntil: 'domcontentloaded' });
    await page.locator('textarea.composer__input').first().waitFor();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await run({ page, shot, ui: ui(page) });
    assert.deepEqual(errors, [], 'page errors');
  } catch (error) {
    // Diagnostics for a failed check: the screenshot plus the class tree of the composer region.
    failureCount++;
    await page.screenshot({ path: join(output, `failure-${failureCount}.png`), fullPage: true }).catch(() => {});
    const tree = await page.evaluate(() => {
      const describe = (node, depth) => node.nodeType !== 1 || depth > 4 ? '' : `${'  '.repeat(depth)}<${node.tagName.toLowerCase()} class="${node.className?.baseVal ?? node.className}">${[...node.children].map((child) => describe(child, depth + 1)).join('')}\n`;
      const main = document.querySelector('.chat') ?? document.body;
      return describe(main, 0).slice(0, 6000);
    }).catch(() => '');
    await writeFile(join(output, `failure-${failureCount}.txt`), tree);
    throw error;
  } finally { await context.close(); }
}
function ui(page) {
  const input = page.locator('textarea.composer__input').first();
  const composer = page.locator('.composer').first();
  // The strip is the existing progress disclosure; the test accepts either its current class or a data-attribute hook.
  const strip = page.locator('.status-bar, [data-activity-strip]').first();
  // Everything the composer shows above its textarea: the progress strip, or the question dock that replaces it.
  const activity = page.locator('.composer-activity, .status-bar, [data-activity-strip]').first();
  const rail = page.locator('.single-subagents').first();
  const toggle = rail.getByRole('button', { name: /^(Expand|Collapse) subagents$/ });
  const card = (id = QUESTION) => page.locator(`.question-card[data-question-id="${id}"]`);
  const pendingCards = page.locator('.question-card[aria-label="Provider question, pending"]');
  return {
    input, composer, strip, activity, rail, toggle, card, pendingCards,
    async boxOf(locator) { return locator.evaluate((node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; }); },
    // Pointer reachability: the element actually hit at the control's centre must belong to the control.
    async hitTestable(locator) {
      return locator.evaluate((node) => {
        const r = node.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { reachable: Boolean(hit && (node === hit || node.contains(hit))), hit: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className?.baseVal ?? hit.className).split(' ').join('.')}` : 'nothing' };
      });
    },
    // Keyboard is the primary path for disclosure controls; pointer reachability is asserted separately.
    async expandRail() { if (await this.toggle.getAttribute('aria-expanded') === 'false') { await this.toggle.focus(); await page.keyboard.press('Enter'); } await page.getByRole('button', { name: 'Collapse subagents', exact: true }).waitFor(); },
    async noOverlap(a, b) {
      const [x, y] = [await this.boxOf(a), await this.boxOf(b)];
      const overlaps = x.left < y.right && x.right > y.left && x.top < y.bottom && x.bottom > y.top;
      assert.equal(overlaps, false, `boxes overlap: ${JSON.stringify({ x, y })}`);
    },
  };
}
async function test(name, run) {
  if (process.env.COMPOSER_ACTIVITY_ACCEPTANCE_FILTER && !new RegExp(process.env.COMPOSER_ACTIVITY_ACCEPTANCE_FILTER).test(name)) return;
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`FAIL ${name}\n  ${error instanceof Error ? error.stack : error}`); }
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const posts = (suffix) => world.log.filter((item) => item.method === 'POST' && item.path.endsWith(suffix));
const nativeOpen = (page, state) => page.getByRole('button', { name: `Open @example-source-review subagent chat, ${state}`, exact: true });

try {
  const probe = createPortProbe();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const fixturePort = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  server = await createServer({
    // HMR is disabled: its socket would target the base config port and is not part of the mocked store boundary.
    configFile: join(root, 'apps/web/vite.config.ts'), root, appType: 'custom', server: { host: '127.0.0.1', port: fixturePort, strictPort: true, hmr: false },
    optimizeDeps: { entries: [join(root, 'scripts/composer-activity-browser-fixture.tsx')] },
    resolve: { alias: [
      { find: /^@mingle\/contracts$/, replacement: join(root, 'packages/contracts/src/index.ts') },
      { find: /^@mingle\/contracts\/(.*)$/, replacement: `${root}/packages/contracts/src/$1` },
      { find: 'react', replacement: join(root, 'apps/web/node_modules/react') },
      { find: 'react-dom', replacement: join(root, 'apps/web/node_modules/react-dom') },
    ], dedupe: ['react', 'react-dom'] },
  });
  await server.listen();
  fixtureUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(), headless: true });

  await test('fixture is labelled Example and mounts the real composer and conversation pane', () => withPage({}, async ({ page, ui: u }) => {
    assert.equal(await page.getByText('Example workspace · fixture data only · no provider or cloud access', { exact: true }).count(), 1);
    assert.equal(await u.input.count(), 1, 'one real composer textarea');
    assert.equal(await page.locator('.chat').count(), 1, 'real SessionPane chat root');
  }));

  await test('standalone subagent rail floats top-right and is not embedded in the strip', () => withPage({ setup: () => { world.nativeChild = 'running'; world.delegated = [delegatedRecord()]; } }, async ({ page, shot, ui: u }) => {
    await u.rail.waitFor();
    assert.equal(await u.rail.evaluate((node) => node.classList.contains('single-subagents--embedded')), false, 'rail is standalone');
    assert.equal(await u.rail.evaluate((node) => node.closest('.status-bar, [data-activity-strip], .session-progress') === null), true, 'rail is outside the strip');
    assert.match(await u.rail.evaluate((node) => getComputedStyle(node).position), /^(absolute|fixed)$/, 'rail floats');
    const [rail, chat] = [await u.boxOf(u.rail), await u.boxOf(page.locator('.chat'))];
    assert.ok(chat.right - rail.right >= -1 && chat.right - rail.right <= 40, `rail is right-aligned: ${JSON.stringify({ rail, chat })}`);
    assert.ok(rail.top - chat.top <= 80, 'rail sits in the top band of the conversation');
    await u.noOverlap(u.rail, u.input);
    await shot('standalone-rail-top-right');
  }));

  await test('rail toggle is pointer-reachable over the conversation controls', () => withPage({ setup: () => { world.nativeChild = 'running'; } }, async ({ shot, ui: u }) => {
    await u.rail.waitFor();
    const hit = await u.hitTestable(u.toggle);
    await shot('rail-toggle-hit-test');
    assert.equal(hit.reachable, true, `the rail toggle is covered by ${hit.hit}`);
  }));

  await test('rail expands, collapses and opens native and delegated children from the keyboard', () => withPage({ setup: () => { world.nativeChild = 'running'; world.delegated = [delegatedRecord()]; } }, async ({ page, ui: u }) => {
    await u.rail.waitFor();
    await u.expandRail();
    await nativeOpen(page, 'Running').waitFor();
    await page.getByRole('button', { name: 'Open @example-reviewer subagent session', exact: true }).waitFor();
    await u.toggle.focus();
    await page.keyboard.press('Enter');
    assert.equal(await u.toggle.getAttribute('aria-expanded'), 'false', 'keyboard Enter collapses');
    assert.equal(await nativeOpen(page, 'Running').count(), 0, 'collapsed rows are removed from the accessibility tree');
    await page.keyboard.press('Space');
    assert.equal(await u.toggle.getAttribute('aria-expanded'), 'true', 'keyboard Space expands');
    await u.input.fill('Keep my draft');
    await nativeOpen(page, 'Running').focus();
    await page.keyboard.press('Enter');
    await page.locator('.single-subagent-view').waitFor();
    await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
    assert.equal(await u.input.inputValue(), 'Keep my draft', 'draft survives opening a child');
  }));

  await test('strip summarizes waiting questions and working children', () => withPage({ setup: () => { world.sessionStatus = 'waiting'; world.nativeChild = 'running'; world.delegated = [delegatedRecord()]; world.questions = [questionRecord()]; } }, async ({ page, shot, ui: u }) => {
    await u.activity.waitFor();
    assert.match(await u.activity.innerText(), /waiting/i, 'the composer activity area names the waiting question');
    assert.equal(await u.strip.count(), 1, 'the progress strip is present while a question is pending, so the two running children are summarized there');
    const text = await u.strip.innerText();
    assert.match(text, /\b2\b/, `strip counts the two running children: ${text}`);
    await shot('strip-summary-waiting-and-working');
  }));

  await test('internal helper handoffs stay out of chat, search and the editable queue while human text stays visible', () => withPage({ setup: () => {
    world.delegated = [{ ...delegatedRecord('completed'), resultPreview: 'Example inspectable helper result.', resultDelivered: true }];
    world.messages = [
      { id: 'example-internal-result', sessionId: SESSION, role: 'user', kind: 'subagent-result', content: 'Example private handoff payload', createdAt: iso() },
      { id: 'example-human-result-text', sessionId: SESSION, role: 'user', content: 'Subagent @example-reviewer finished. Human discussion.', createdAt: iso() },
    ];
    world.queuedMessages = [{ id: 'example-internal-queue', sessionId: SESSION, kind: 'subagent-result', subagentId: world.delegated[0].id, content: 'Example private queued handoff', intent: 'normal', skills: [], attachmentIds: [], contextRefs: [], createdAt: iso() }];
  } }, async ({ page, ui: u, shot }) => {
    await page.getByText('Subagent @example-reviewer finished. Human discussion.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Example private handoff payload', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Example private queued handoff', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: 'Queued messages', exact: true }).count(), 0);
    await u.expandRail();
    await u.rail.locator('.single-subagents__history > summary').filter({ hasText: 'Finished' }).click();
    await u.rail.getByText('Example inspectable helper result.', { exact: true }).waitFor();
    await page.getByRole('button', { name: /Find.*bookmarks/i }).click();
    const search = page.getByRole('searchbox');
    await search.fill('Example private handoff payload');
    assert.equal(await page.getByRole('list', { name: 'Search results', exact: true }).locator('li').count(), 0);
    await shot('internal-helper-handoff-hidden');
  }));

  await test('strip hides when every task is done and no child is running', () => withPage({ setup: () => { world.nativeChild = 'completed'; world.steps = [{ id: 'example-step-1', title: 'Example checklist item', status: 'done' }]; } }, async ({ page, shot, ui: u }) => {
    await page.getByText('Example request for the composer activity fixture').waitFor();
    assert.equal(await u.strip.count(), 0, 'strip is hidden');
    await shot('strip-hidden-when-done');
  }));

  await test('strip stays visible while a child runs even after its tasks are done', () => withPage({ setup: () => { world.nativeChild = 'running'; world.steps = [{ id: 'example-step-1', title: 'Example checklist item', status: 'done' }]; } }, async ({ ui: u }) => {
    await u.strip.waitFor();
    assert.match(await u.strip.innerText(), /waiting|working|running|active/i);
  }));

  await test('composer and strip share one outer border and focus ring', () => withPage({ setup: () => { world.nativeChild = 'running'; world.steps = [{ id: 'example-step-1', title: 'Example checklist item', status: 'in_progress' }]; } }, async ({ page, shot, ui: u }) => {
    await u.strip.waitFor();
    const shell = await page.evaluate(() => {
      const input = document.querySelector('textarea.composer__input');
      const strip = document.querySelector('.status-bar, [data-activity-strip]');
      const bordered = (node) => ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(getComputedStyle(node)[`border${side}Width`]) > 0 && getComputedStyle(node)[`border${side}Style`] !== 'none');
      let common = strip.parentElement;
      while (common && !common.contains(input)) common = common.parentElement;
      const composer = input.closest('.composer');
      return {
        sameShell: common !== null && common !== input,
        shellBordered: bordered(common),
        stripOwnBorder: common !== strip && bordered(strip),
        composerOwnBorder: Boolean(composer) && composer !== common && bordered(composer),
      };
    });
    assert.equal(shell.sameShell, true, 'strip and textarea have a common shell');
    assert.equal(shell.shellBordered, true, 'the shell owns a border');
    assert.equal(shell.stripOwnBorder, false, 'the strip draws no border of its own');
    assert.equal(shell.composerOwnBorder, false, 'the composer draws no second border');
    // Focus-ring styling is compared by behaviour: the shell's rendered look changes on focus, the composer's does not.
    const ringOf = () => page.evaluate(() => {
      const input = document.querySelector('textarea.composer__input');
      const strip = document.querySelector('.status-bar, [data-activity-strip]');
      let common = strip.parentElement;
      while (common && !common.contains(input)) common = common.parentElement;
      const look = (node) => { const s = getComputedStyle(node); return `${s.boxShadow}|${s.outlineStyle}|${s.outlineWidth}|${s.borderTopColor}`; };
      return { shell: look(common), composer: look(input.closest('.composer')) };
    });
    const idle = await ringOf();
    await u.input.focus();
    const focused = await ringOf();
    assert.notEqual(focused.shell, idle.shell, 'focus changes the shared shell ring');
    assert.equal(focused.composer, idle.composer, 'focus does not give the composer a second ring');
    await u.strip.locator('button').first().focus();
    assert.equal((await ringOf()).shell, focused.shell, 'focus inside the strip uses the same shell ring');
    await shot('shared-border-focus');
  }));

  await test('pending question docks above the composer and animates in with motion enabled', () => withPage({ reducedMotion: 'no-preference', setup: () => { world.sessionStatus = 'waiting'; world.questions = [questionRecord()]; } }, async ({ shot, ui: u }) => {
    await u.card().waitFor();
    assert.equal(await u.card().evaluate((node) => node.closest('.chat__history, .chat__scroll') === null), true, 'question is in the dock, not the transcript');
    // Let the entrance settle before measuring, so a mid-flight transform cannot decide the position.
    await u.card().evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
    const above = await u.card().evaluate((node) => node.getBoundingClientRect().bottom <= document.querySelector('textarea.composer__input').getBoundingClientRect().top + 1);
    assert.equal(above, true, 'dock sits above the composer');
    const animated = await u.card().evaluate((node) => {
      const names = [];
      for (let el = node; el && !el.classList.contains('composer-surface'); el = el.parentElement) names.push(getComputedStyle(el).animationName);
      return names.some((name) => name && name !== 'none');
    });
    assert.equal(animated, true, 'an entrance animation is declared on the dock with motion enabled');
    await shot('question-dock-motion');
  }));

  await test('reduced motion removes the question entrance animation', () => withPage({ reducedMotion: 'reduce', setup: () => { world.sessionStatus = 'waiting'; world.questions = [questionRecord()]; } }, async ({ ui: u }) => {
    await u.card().waitFor();
    const animated = await u.card().evaluate((node) => {
      const names = [];
      for (let el = node; el && !el.classList.contains('composer-surface'); el = el.parentElement) {
        const style = getComputedStyle(el);
        names.push(style.animationName !== 'none' && parseFloat(style.animationDuration) > 0 ? style.animationName : 'none');
      }
      return names.some((name) => name !== 'none');
    });
    assert.equal(animated, false, 'no entrance animation under reduced motion');
  }));

  await test('answering a pending question submits through the real card', () => withPage({ setup: () => { world.sessionStatus = 'waiting'; world.questions = [questionRecord()]; } }, async ({ page, shot, ui: u }) => {
    await u.card().waitFor();
    await u.card().getByRole('radio', { name: /^Composer/ }).check();
    await u.card().getByRole('checkbox', { name: /^Visual/ }).check();
    await shot('question-ready-to-submit');
    await u.card().getByRole('button', { name: 'Submit answers', exact: true }).click();
    await u.card().getByText('Provider question answered').waitFor();
    assert.deepEqual(posts(`/api/questions/${QUESTION}/answer`).map((item) => item.body), [{ scope: ['Composer'], checks: ['Visual'] }]);
    assert.equal(await u.pendingCards.count(), 0, 'no pending question remains in the dock');
    await shot('question-answered');
  }));

  await test('cancelling a pending question calls the real cancel endpoint', () => withPage({ setup: () => { world.sessionStatus = 'waiting'; world.questions = [questionRecord()]; } }, async ({ ui: u }) => {
    await u.card().waitFor();
    await u.card().getByRole('button', { name: 'Cancel request', exact: true }).click();
    await u.card().getByText('Provider question cancelled').waitFor();
    assert.equal(posts(`/api/questions/${QUESTION}/cancel`).length, 1);
    assert.equal(posts(`/api/questions/${QUESTION}/answer`).length, 0);
  }));

  await test('a rejected answer shows a visible alert and the retry succeeds', () => withPage({ setup: () => { world.sessionStatus = 'waiting'; world.questions = [questionRecord()]; world.questionFailures = [{ status: 409 }]; } }, async ({ page, shot, ui: u }) => {
    await u.card().waitFor();
    await u.card().getByRole('radio', { name: /^Composer/ }).check();
    await u.card().getByRole('checkbox', { name: /^Visual/ }).check();
    await u.card().getByRole('button', { name: 'Submit answers', exact: true }).click();
    const alert = u.card().getByRole('alert');
    await alert.waitFor();
    assert.match(await alert.innerText(), /already resolved|rejected/i);
    assert.equal(await u.pendingCards.count(), 1, 'the question stays pending after a rejection');
    await shot('question-rejected');
    await u.card().getByRole('button', { name: 'Submit answers', exact: true }).click();
    await u.card().getByText('Provider question answered').waitFor();
    assert.equal(posts(`/api/questions/${QUESTION}/answer`).length, 2, 'the retry posts again');
  }));

  await test('keyboard alone selects options and submits the question', () => withPage({ setup: () => { world.sessionStatus = 'waiting'; world.questions = [questionRecord()]; } }, async ({ page, ui: u }) => {
    await u.card().waitFor();
    await u.card().getByRole('radio', { name: /^Composer/ }).focus();
    await page.keyboard.press('Space');
    await u.card().getByRole('checkbox', { name: /^Visual/ }).focus();
    await page.keyboard.press('Space');
    await u.card().getByRole('button', { name: 'Submit answers', exact: true }).focus();
    await page.keyboard.press('Enter');
    await u.card().getByText('Provider question answered').waitFor();
    assert.deepEqual(posts(`/api/questions/${QUESTION}/answer`).map((item) => item.body), [{ scope: ['Composer'], checks: ['Visual'] }]);
  }));

  await test('narrow 390px layout keeps the dock, strip, rail and composer inside the viewport', () => withPage({ viewport: { width: 390, height: 844 }, setup: () => { world.sessionStatus = 'waiting'; world.nativeChild = 'running'; world.steps = [{ id: 'example-step-1', title: 'Example checklist item', status: 'in_progress' }]; world.questions = [questionRecord()]; } }, async ({ page, shot, ui: u }) => {
    await u.card().waitFor();
    assert.equal(await noOverflow(page), true, 'no horizontal page overflow');
    for (const locator of [u.card(), u.activity, u.input]) {
      const box = await u.boxOf(locator);
      assert.ok(box.left >= -0.5 && box.right <= 390.5, `inside the 390px viewport: ${JSON.stringify(box)}`);
    }
    if (await u.rail.count()) {
      const rail = await u.boxOf(u.rail);
      assert.ok(rail.left >= -0.5 && rail.right <= 390.5, `rail inside the viewport: ${JSON.stringify(rail)}`);
      await u.noOverlap(u.rail, u.input);
    }
    await shot('narrow-390');
  }));

  await test('no stray external requests, unmocked endpoints, or socket targets', async () => {
    assert.deepEqual(aggregate.external, [], 'external requests');
    assert.deepEqual(aggregate.unmocked.filter((path) => !unmockedAllowed.test(path)), [], 'unmocked API paths');
  });

  console.log(`INFO Example-only fixtures; no provider inference or cloud writes. Screenshots: ${output}`);
  if (failures.length) throw new Error(`${failures.length} composer activity check(s) failed`);
  console.log(`PASS ${passed} composer activity browser acceptance checks`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}
