#!/usr/bin/env node
// Disposable Example fixtures. Exercises the real Composer, SessionWorkflowPanel and Zustand bootstrap path at the
// HTTP boundary; every /api request and store socket is mocked locally; no provider or cloud is reached.
// See docs/single-session-workflow-acceptance.md.
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
const output = process.env.SESSION_WORKFLOW_ACCEPTANCE_OUTPUT || join(tmpdir(), `mingle-session-workflow-acceptance-${process.pid}`);
await mkdir(output, { recursive: true });

let server, browser, fixtureUrl, world;
const GOAL = 'Update the example README and keep the change small.';
const iso = (ms) => new Date(ms).toISOString();
const hex32 = (n) => n.toString(16).padStart(32, '0');
const unexposedAllowed = /\/api\/projects\/[^/]+\/(repository|github)/;
const aggregate = { requests: [], sockets: [], external: [], unexposed: [] };

// ——— Example world served by the mocked runtime ———
const providers = [
  { id: 'claude', name: 'Claude', available: true, version: 'Example fixture', executable: null, reason: null, policies: ['supervised', 'balanced', 'full-access'], promptCapabilities: { image: true, embeddedContext: true },
    models: [{ id: 'claude-example', name: 'Example Claude', reasoningEfforts: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }], defaultReasoningEffort: 'medium', policies: ['supervised', 'balanced', 'full-access'] }] },
  { id: 'codex', name: 'Codex', available: true, version: 'Example fixture', executable: null, reason: null, policies: ['supervised', 'full-access'], promptCapabilities: { image: true, embeddedContext: true },
    models: [{ id: 'codex-example', name: 'Example Codex', reasoningEfforts: [{ id: 'medium', label: 'Medium' }], defaultReasoningEffort: 'medium', policies: ['supervised', 'full-access'] }] },
];
function session(id, projectId, name, provider, overrides = {}) {
  return { id, projectId, name, provider, model: `${provider}-example`, effort: 'medium', status: 'idle', policy: 'supervised', serviceTier: 'standard', isolated: true, worktreePath: `/example/${projectId}/worktree`, branch: `example/${id}`,
    providerSessionId: null, createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z', error: null, inputTokens: 0, outputTokens: 0, costUsd: null, pinned: false, unread: false, ...overrides };
}
let workflowCounter = 0;
const helper = (parentSessionId, status, index) => ({ id: `example-helper-${parentSessionId}-${index}`, parentSessionId, childSessionId: `example-child-${parentSessionId}-${index}`, name: `example-helper-${index}`, provider: 'claude', model: 'claude-example',
  task: 'Example helper task', status, requestedBy: 'agent', startedAt: '2026-11-03T00:00:00.000Z', endedAt: status === 'running' ? null : '2026-11-03T00:01:00.000Z', resultPreview: null, error: null, resultDelivered: false });
function workflow(sessionId, overrides = {}) {
  const owner = world.sessions.find((item) => item.id === sessionId);
  return { id: `example-workflow-${++workflowCounter}`, sessionId, taskId: 'example-task', goal: GOAL, state: 'running', version: 1, stopReason: null, summary: null,
    limits: { maxTurns: 8, maxElapsedMinutes: 240, maxStalls: 2 }, counters: { turns: 1, stalls: 0 }, currentRunId: 'example-run', lastRunId: null,
    configuration: { provider: owner.provider, model: owner.model, effort: owner.effort, policy: owner.policy, serviceTier: 'standard', worktreePath: owner.worktreePath, branch: owner.branch },
    createdAt: iso(Date.now() - 600_000), updatedAt: iso(Date.now() - 1000), deadlineAt: iso(Date.now() + 3 * 3600_000), ...overrides };
}
function freshWorld() {
  return {
    projects: ['a', 'b'].map((key) => ({ id: `example-project-${key}`, name: `Example project ${key.toUpperCase()}`, path: `/example/${key}`, isExample: false, createdAt: '2026-11-03T00:00:00.000Z' })),
    sessions: [session('s-a', 'example-project-a', 'Example session A', 'claude'), session('s-b', 'example-project-b', 'Example session B', 'codex')],
    workflows: [], delegated: [], attachments: {}, messages: [], runs: [], approvals: [], questions: [], failure: null, log: [], notExposed: [], sockets: [], startError: null, hold: null, uploadCounter: 0,
  };
}
const find = (sessionId) => world.workflows.find((item) => item.sessionId === sessionId);
const setStatus = (sessionId, status) => { world.sessions.find((item) => item.id === sessionId).status = status; };
const calls = (method, suffix) => world.log.filter((item) => item.method === method && item.path.endsWith(suffix));
const posts = (suffix) => calls('POST', suffix);

// ——— Runtime boundary mock ———
async function handle(route, schemas) {
  const request = route.request(), url = new URL(request.url()), { pathname: path } = url, method = request.method();
  let body;
  if (['POST', 'PATCH', 'PUT'].includes(method)) { try { body = request.postDataJSON(); } catch { body = undefined; } }
  world.log.push({ method, path, body });
  aggregate.requests.push(`${method} ${path}`);
  const json = (payload, status = 200) => route.fulfill({ status, json: payload });
  const fail = (status, error) => json({ error }, status);
  let match;
  if (path === '/api/bootstrap') return json({ projects: world.projects, sessions: world.sessions, messages: world.messages, queuedMessages: [], tasks: [], events: [], approvals: world.approvals, plans: [], questions: world.questions, providers, settings: {}, version: 'Example fixture', runs: world.runs, toolCalls: [], workflows: world.workflows, delegatedSubagents: world.delegated });
  if (path === '/api/workspace/selection') return json({ projectId: body?.projectId ?? null });
  if ((match = path.match(/^\/api\/sessions\/([^/]+)\/catalog$/))) return json({ commands: [], skills: [], warnings: [] });
  if ((match = path.match(/^\/api\/sessions\/([^/]+)\/recovery$/))) return json({ checkpoint: null, failure: world.failure });
  if ((match = path.match(/^\/api\/sessions\/([^/]+)\/usage$/))) return json({ provider: 'claude', fetchedAt: iso(Date.now()), status: 'available', plan: 'Example plan', windows: [], credits: null, resets: null, notices: [], session: { id: match[1], inputTokens: 0, outputTokens: 0, costUsd: null } });
  if ((match = path.match(/^\/api\/runs\/([^/]+)\/review$/))) return json({ runId: match[1], sessionId: 's-a', status: 'failed', readAt: iso(Date.now()), tools: { total: 0, counts: {}, failed: 0, interrupted: 0, running: 0, nonZeroExit: 0 }, commands: { total: 0, items: [], truncated: false }, problems: { total: 0, items: [], truncated: false }, failure: world.failure ? { kind: world.failure.kind, message: world.failure.message, occurredAt: world.failure.occurredAt, outcomeUnknown: world.failure.outcomeUnknown } : null, goalTurn: null });
  if ((match = path.match(/^\/api\/sessions\/([^/]+)\/attachments$/))) {
    const sid = match[1];
    if (method === 'GET') return json(world.attachments[sid] ?? []);
    const name = url.searchParams.get('name') ?? 'upload.bin';
    const ref = { id: `att_${hex32(++world.uploadCounter)}`, name, mimeType: request.headers()['content-type'] ?? 'application/octet-stream', size: request.postDataBuffer()?.length ?? 0, kind: 'file', createdAt: iso(Date.now()) };
    (world.attachments[sid] ??= []).push(ref);
    return json(ref);
  }
  if ((match = path.match(/^\/api\/attachments\/([^/]+)$/)) && method === 'DELETE') {
    for (const sid of Object.keys(world.attachments)) world.attachments[sid] = world.attachments[sid].filter((item) => item.id !== match[1]);
    return json({ ok: true });
  }
  if (path.match(/^\/api\/projects\/[^/]+\/files(\/search)?$/)) return json([{ path: 'src/app.ts', name: 'app.ts', type: 'file' }]);
  if ((match = path.match(/^\/api\/sessions\/([^/]+)\/messages$/)) && method === 'POST') return json({ accepted: true });
  if ((match = path.match(/^\/api\/sessions\/([^/]+)$/)) && method === 'PATCH') {
    const target = world.sessions.find((item) => item.id === match[1]);
    if (!target) return fail(404, 'Unknown Example session.');
    Object.assign(target, body, { updatedAt: iso(Date.now()) });
    return json(target);
  }
  if ((match = path.match(/^\/api\/sessions\/([^/]+)\/workflow(?:\/(pause|stop|resume))?$/))) {
    const [, sid, action] = match;
    const target = world.sessions.find((item) => item.id === sid);
    if (!target) return fail(404, 'Unknown Example session.');
    const current = find(sid);
    if (!action && method === 'GET') return json({ workflow: current ?? null });
    if (!action && method === 'POST') {
      if (world.startError) return fail(world.startError.status, world.startError.error);
      const parsed = schemas.StartSessionWorkflowSchema.safeParse(body);
      if (!parsed.success) return fail(400, `Invalid workflow request: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
      if (current && (current.state === 'running' || current.state === 'paused')) return fail(409, 'This session already has an autonomous workflow.');
      const owned = world.attachments[sid] ?? [];
      if ((parsed.data.attachmentIds ?? []).some((id) => !owned.some((item) => item.id === id))) return fail(400, 'Attachment does not belong to this session.');
      if ((parsed.data.contextRefs ?? []).some((ref) => ref.sourceSessionId !== sid)) return fail(400, 'Context reference does not belong to this session.');
      const created = workflow(sid, { goal: parsed.data.goal, limits: parsed.data.limits, counters: { turns: 0, stalls: 0 }, deadlineAt: iso(Date.now() + parsed.data.limits.maxElapsedMinutes * 60_000) });
      world.workflows = world.workflows.filter((item) => item.sessionId !== sid).concat(created);
      world.attachments[sid] = owned.filter((item) => !(parsed.data.attachmentIds ?? []).includes(item.id));
      setStatus(sid, 'running');
      return json(created);
    }
    if (action && method === 'POST') {
      if (world.hold?.match === `${sid}:${action}`) await world.hold.promise;
      if (!current) return fail(404, 'No workflow for this session.');
      const parsed = (action === 'resume' ? schemas.ResumeSessionWorkflowSchema : schemas.WorkflowControlSchema).safeParse(body);
      if (!parsed.success) return fail(400, `Invalid workflow request: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
      if (parsed.data.expectedVersion !== current.version) return fail(409, 'This workflow changed on another device. Refresh before retrying.');
      if (action === 'pause' && current.state !== 'running') return fail(409, 'The workflow is not running.');
      if (action === 'stop' && !['running', 'paused'].includes(current.state)) return fail(409, 'The workflow has already finished.');
      if (action === 'resume') {
        if (current.state !== 'paused') return fail(409, 'The workflow is not paused.');
        if (target.status !== 'idle') return fail(409, 'The session is busy.');
        const turns = current.limits.maxTurns + (parsed.data.additionalTurns ?? 0);
        const deadline = Math.max(Date.parse(current.deadlineAt), parsed.data.extendMinutes ? Date.now() : 0) + (parsed.data.extendMinutes ?? 0) * 60_000;
        if (current.counters.turns >= turns) return fail(409, 'The turn budget is exhausted. Resume with additional turns.');
        if (deadline <= Date.now()) return fail(409, 'The time budget is exhausted. Resume with more time.');
        Object.assign(current, { state: 'running', stopReason: null, limits: { ...current.limits, maxTurns: turns }, deadlineAt: iso(deadline) });
        setStatus(sid, 'running');
      } else {
        Object.assign(current, action === 'pause' ? { state: 'paused', stopReason: 'user-pause' } : { state: 'stopped', stopReason: 'user-stop' });
        setStatus(sid, 'idle');
      }
      current.version += 1; current.updatedAt = iso(Date.now());
      return json(current);
    }
  }
  if (/^\/api\/sessions\/[^/]+\/interrupt$/.test(path)) return json({ ok: true });
  world.notExposed.push(path);
  aggregate.unexposed.push(path);
  return fail(404, 'Not exposed by the Example workflow fixture.');
}

// ——— Harness ———
let passed = 0;
const failures = [];
const screenshots = [];
async function withPage({ viewport = { width: 1000, height: 860 }, reducedMotion = 'reduce', setup, schemas, integratedProgress = false }, run) {
  world = freshWorld();
  setup?.();
  const context = await browser.newContext({ viewport, reducedMotion });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [], external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
  page.on('request', (request) => { const { hostname, protocol } = new URL(request.url()); if (protocol.startsWith('http') && hostname !== '127.0.0.1') external.push(request.url()); });
  // The store initializes its connection during Vite hot-module setup. Keep that socket wholly in Playwright so
  // the real onopen path reports online; closing it would make every composer control correctly remain offline.
  const ws = (socket) => { world.sockets.push(socket.url()); aggregate.sockets.push(socket.url()); };
  await context.routeWebSocket('**/ws', ws);
  await context.routeWebSocket('**/ws/**', ws);
  await context.route('**/api/**', (route) => handle(route, schemas));
  const shot = async (name) => { const file = join(output, `${name}.png`); await page.screenshot({ path: file, fullPage: true }); screenshots.push(file); };
  try {
    await page.goto(fixtureUrl + (integratedProgress ? '?progress=1' : ''), { waitUntil: 'domcontentloaded' });
    await page.locator('textarea.composer__input').first().waitFor();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await run({ page, shot, ui: ui(page) });
    assert.deepEqual(errors, [], 'page errors');
    assert.deepEqual(external, [], 'external requests');
    assert.ok(world.sockets.every((url) => new URL(url).pathname === '/ws'), 'only the local mocked store socket is used');
    assert.deepEqual(world.notExposed.filter((path) => !unexposedAllowed.test(path)), [], 'unmocked API paths');
  } finally { await context.close(); }
}
function ui(page) {
  return {
    input: page.locator('textarea.composer__input'),
    panel: page.getByRole('region', { name: 'Autonomous workflow' }),
    mode: page.getByRole('combobox', { name: 'Conversation mode' }),
    settings: page.getByRole('button', { name: 'Advanced conversation settings', exact: true }),
    async chooseMode(name) { await this.mode.click(); await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click(); },
    async autonomousDisabled() { if (await this.mode.isDisabled()) return true; await this.mode.click(); const option = page.getByRole('option', { name: /^Autonomous/ }); await option.waitFor(); const disabled = await option.getAttribute('aria-disabled') === 'true'; await this.mode.press('Escape'); return disabled; },
    async budgets() { if (await this.settings.getAttribute('aria-expanded') !== 'true') await this.settings.click(); await page.getByLabel('Turn budget').waitFor(); },
    send: page.getByRole('button', { name: /^(Send message|Start autonomous workflow)$/ }),
    model: page.getByRole('combobox', { name: 'Model', exact: true }),
    effort: page.getByRole('combobox', { name: 'Reasoning effort and service tier' }),
    policy: page.getByRole('combobox', { name: 'Approval policy' }),
    pause: page.getByRole('button', { name: 'Pause autonomous workflow' }),
    stop: page.getByRole('button', { name: 'Stop autonomous workflow' }),
    resume: page.getByRole('button', { name: /^Resume/ }),
    alert: page.locator('.composer__note[role="alert"], .session-workflow__error[role="alert"]'),
    label: (text) => page.getByRole('region', { name: 'Autonomous workflow' }).getByRole('button', { name: text }),
    open: (name) => page.getByRole('button', { name: `Open ${name}` }),
    refresh: () => page.evaluate(() => window.refreshExampleBootstrap()),
    async attach(name = 'spec.txt') {
      await page.getByRole('button', { name: 'Attach files' }).waitFor();
      await page.waitForFunction(() => !document.querySelector('[aria-label="Attach files"]')?.disabled);
      await page.locator('.attachment-drafts input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('Example attachment') });
      await page.getByRole('button', { name: `Remove ${name}` }).waitFor();
    },
    async addFileContext() {
      await page.getByRole('button', { name: 'Add workspace file context' }).click();
      await page.getByRole('button', { name: /src\/app\.ts/ }).click();
      await page.getByRole('button', { name: 'Remove file src/app.ts' }).waitFor();
    },
  };
}
async function test(name, run) {
  if (process.env.SESSION_WORKFLOW_ACCEPTANCE_FILTER && !new RegExp(process.env.SESSION_WORKFLOW_ACCEPTANCE_FILTER).test(name)) return;
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`FAIL ${name}\n  ${error instanceof Error ? error.stack : error}`); }
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const inViewport = (page, selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((node) => node.getClientRects().length).every((node) => { const box = node.getBoundingClientRect(); return box.left >= -0.5 && box.right <= innerWidth + 0.5; }), selector);
const textOf = (locator) => locator.innerText();

try {
  server = await createServer({
    configFile: join(root, 'apps/web/vite.config.ts'), root, appType: 'mpa', server: { host: '127.0.0.1', port: 0 },
    optimizeDeps: { entries: [join(root, 'scripts/session-workflow-browser-fixture.html')] },
    resolve: { alias: [{ find: 'react', replacement: join(root, 'apps/web/node_modules/react') }, { find: 'react-dom', replacement: join(root, 'apps/web/node_modules/react-dom') }], dedupe: ['react', 'react-dom'] },
  });
  await server.listen();
  fixtureUrl = `http://127.0.0.1:${server.httpServer.address().port}/scripts/session-workflow-browser-fixture.html`;
  const contracts = await server.ssrLoadModule('/packages/contracts/src/session-workflow.ts');
  const schemas = { StartSessionWorkflowSchema: contracts.StartSessionWorkflowSchema, WorkflowControlSchema: contracts.WorkflowControlSchema, ResumeSessionWorkflowSchema: contracts.ResumeSessionWorkflowSchema };
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(), headless: true });
  const run = (options, fn) => withPage({ ...options, schemas }, fn);

  await test('opt-in: initial composer is ordinary chat and native controls stay editable', () => run({}, async ({ page, ui: u }) => {
    assert.equal(await page.getByText('Example workspace · fixture data only', { exact: false }).count(), 1, 'fixture identifies itself as Example data');
    assert.equal((await u.mode.innerText()).trim() === 'Autonomous', false);
    assert.equal((await u.mode.innerText()).trim() === 'Plan', false);
    assert.equal(await u.panel.count(), 0, 'no workflow panel without a workflow');
    assert.equal(await page.getByText(/Up to \d+ turns/).filter({ visible: true }).count(), 0, 'no budget setup until Autonomous is chosen');
    for (const control of [u.model, u.policy, u.mode]) assert.equal(await control.isDisabled(), false);
    await u.settings.click();
    await u.effort.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await u.effort.click();
    await page.getByRole('option', { name: /^High/ }).click();
    await page.getByRole('combobox', { name: 'Reasoning effort and service tier' }).filter({ hasText: 'High' }).waitFor();
    assert.deepEqual(world.log.filter((item) => item.method === 'PATCH').map((item) => item.body), [{ effort: 'high' }]);
    await u.input.fill('Explain the build.');
    assert.equal(await u.send.getAttribute('aria-label'), 'Send message');
    await u.send.click();
    await page.waitForFunction(() => document.querySelector('textarea.composer__input')?.value === '');
    assert.deepEqual(posts('/messages').map((item) => item.body), [{ content: 'Explain the build.', intent: 'normal' }]);
    assert.equal(posts('/workflow').length, 0, 'an ordinary send never starts a workflow');
  }));

  await test('advanced settings preserve nested choices and Escape restores focus; slash effort opens the same controls', () => run({}, async ({ page, ui: u, shot }) => {
    assert.equal(await u.effort.count(), 0, 'advanced settings are absent from the toolbar');
    await u.settings.click();
    const settings = page.getByRole('dialog', { name: 'Advanced conversation settings' });
    await settings.waitFor();
    await u.effort.click();
    await page.getByRole('option', { name: /^High/ }).click();
    await settings.waitFor();
    assert.equal(await u.settings.getAttribute('aria-expanded'), 'true', 'choosing from a nested portal keeps settings open');
    await shot('00-advanced-desktop');
    await u.effort.press('Escape');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Advanced conversation settings');
    assert.equal(await u.settings.getAttribute('aria-expanded'), 'false');
    await page.waitForFunction(() => !document.querySelector('[aria-label=\"Conversation mode\"]')?.disabled);
    await u.input.fill('/effort');
    await u.input.press('Escape');
    await u.input.press('Enter');
    await page.getByRole('listbox', { name: 'Reasoning effort and service tier' }).waitFor();
    assert.equal(posts('/messages').length, 0, 'local command never starts inference');
  }));

  await test('start sends the selected budgets, goal, original attachments and context references', () => run({}, async ({ page, ui: u, shot }) => {
    await u.chooseMode('Autonomous');
    assert.equal((await u.mode.innerText()).trim() === 'Autonomous', true);
    assert.equal(await u.send.getAttribute('aria-label'), 'Start autonomous workflow');
    await u.budgets();
    await page.getByLabel('Turn budget').fill('12');
    await page.getByLabel('Time budget (minutes)').fill('90');
    await page.getByText('Up to 12 turns').waitFor();
    await u.attach();
    await u.addFileContext();
    await u.input.fill(GOAL);
    await shot('01-setup-desktop');
    const attachmentId = world.attachments['s-a'][0].id;
    await u.send.click();
    await u.label('Working toward your goal').waitFor();
    assert.deepEqual(posts('/workflow').map((item) => item.body), [{ goal: GOAL, limits: { maxTurns: 12, maxElapsedMinutes: 90, maxStalls: 2 }, attachmentIds: [attachmentId], contextRefs: [{ kind: 'file', path: 'src/app.ts', sourceSessionId: 's-a' }] }]);
    assert.equal(posts('/messages').length, 0);
    assert.equal(await u.input.inputValue(), '', 'accepted goal clears the draft');
    assert.equal(await page.getByRole('button', { name: 'Remove file src/app.ts' }).count(), 0, 'context chips are consumed');
    assert.equal(await page.getByRole('button', { name: 'Remove spec.txt' }).count(), 0, 'attachment tray is consumed');
    await page.getByText('0/12 turns').waitFor();
    await page.getByText(GOAL, { exact: true }).waitFor();
    await shot('02-started-desktop');
  }));

  await test('untouched budgets are still sent explicitly as the visible defaults', () => run({}, async ({ ui: u }) => {
    await u.chooseMode('Autonomous');
    await u.input.fill(GOAL);
    await u.send.click();
    await u.label('Working toward your goal').waitFor();
    assert.deepEqual(posts('/workflow').map((item) => item.body), [{ goal: GOAL, limits: { maxTurns: 8, maxElapsedMinutes: 240, maxStalls: 2 }, attachmentIds: [], contextRefs: [] }]);
  }));

  await test('Autonomous and Plan are mutually exclusive and keep their separate send paths', () => run({}, async ({ page, ui: u }) => {
    await u.chooseMode('Plan');
    assert.equal((await u.mode.innerText()).trim() === 'Plan', true);
    assert.equal((await u.mode.innerText()).trim() === 'Autonomous', false);
    await u.chooseMode('Autonomous');
    assert.equal((await u.mode.innerText()).trim() === 'Autonomous', true);
    assert.equal((await u.mode.innerText()).trim() === 'Plan', false);
    await u.budgets();
    await u.chooseMode('Plan');
    assert.equal((await u.mode.innerText()).trim() === 'Autonomous', false);
    assert.equal(await page.getByText(/Up to \d+ turns/).filter({ visible: true }).count(), 0, 'budget setup leaves with Autonomous');
    await u.input.fill('Plan the migration');
    await u.send.click();
    await page.waitForFunction(() => document.querySelector('textarea.composer__input')?.value === '');
    assert.deepEqual(posts('/messages').map((item) => item.body), [{ content: 'Plan the migration', intent: 'plan' }]);
    assert.equal(posts('/workflow').length, 0);
    await u.chooseMode('Autonomous');
    await u.input.fill('/review the diff');
    await u.send.click();
    await u.alert.filter({ hasText: 'Start an autonomous goal with a regular request' }).waitFor();
    assert.equal(await u.input.inputValue(), '/review the diff', 'draft survives the rejection');
    assert.equal(posts('/workflow').length, 0);
  }));

  await test('a rejected start keeps the draft, budgets, attachments and context, then retries the same request', () => run({}, async ({ page, ui: u }) => {
    world.startError = { status: 409, error: 'Another run is already active in this session.' };
    await u.chooseMode('Autonomous');
    await u.budgets();
    await page.getByLabel('Turn budget').fill('14');
    await u.attach();
    await u.addFileContext();
    await u.input.fill(GOAL);
    await u.send.click();
    await u.alert.filter({ hasText: 'Another run is already active in this session.' }).waitFor();
    assert.equal(await u.input.inputValue(), GOAL);
    assert.equal(await page.getByRole('button', { name: 'Remove spec.txt' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Remove file src/app.ts' }).count(), 1);
    assert.equal((await u.mode.innerText()).trim() === 'Autonomous', true);
    await u.budgets();
    await page.getByText('Up to 14 turns', { exact: false }).waitFor();
    assert.equal(await u.panel.count(), 0);
    world.startError = null;
    await u.send.click();
    await u.label('Working toward your goal').waitFor();
    const [first, second] = posts('/workflow');
    assert.equal(posts('/workflow').length, 2);
    assert.deepEqual(second.body, first.body, 'the retry carries the identical goal, limits, attachments and references');
    assert.equal(second.body.limits.maxTurns, 14);
  }));

  await test('an active workflow locks permission, model, effort and mode controls, in a turn and between turns', () => run({
    setup() { setStatus('s-a', 'running'); world.workflows = [workflow('s-a', { version: 2 })]; },
  }, async ({ page, ui: u }) => {
    await u.label('Working toward your goal').waitFor();
    for (const control of [u.model, u.policy, u.mode]) assert.equal(await control.isDisabled(), true);
    assert.equal((await u.mode.innerText()).trim() === 'Autonomous', true);
    assert.equal(await page.getByRole('button', { name: 'Interrupt run' }).isEnabled(), true);
    await u.settings.click();
    assert.equal(await u.effort.isDisabled(), true);
    await u.settings.click();
    assert.equal(world.log.filter((item) => item.method === 'PATCH').length, 0, 'no configuration write while locked');
    setStatus('s-a', 'idle');
    await u.refresh();
    await u.label('Continuing your goal').waitFor();
    for (const control of [u.model, u.policy, u.mode]) assert.equal(await control.isDisabled(), true, 'still locked between turns');
    await u.input.fill('Please also use tabs.');
    await u.send.click();
    await page.waitForFunction(() => document.querySelector('textarea.composer__input')?.value === '');
    assert.deepEqual(posts('/messages').map((item) => item.body), [{ content: 'Please also use tabs.', intent: 'normal' }], 'an explicit human send stays possible');
    assert.equal(posts('/workflow').length, 0);
  }));

  await test('a paused goal releases native controls, keeps ordinary chat on /messages and blocks a second goal', () => run({
    setup() { world.workflows = [workflow('s-a', { state: 'paused', stopReason: 'user-pause', version: 3 })]; },
  }, async ({ page, ui: u }) => {
    await u.label('Paused by you').waitFor();
    for (const control of [u.model, u.policy, u.mode]) assert.equal(await control.isDisabled(), false);
    assert.equal(await u.autonomousDisabled(), true, 'a second goal cannot be started while one is paused');
    assert.equal((await u.mode.innerText()).trim() === 'Autonomous', false);
    assert.equal((await u.mode.innerText()).trim(), 'Chat');
    assert.equal(await u.send.getAttribute('aria-label'), 'Send message');
    await u.input.fill('Quick question while paused.');
    await u.send.click();
    await page.waitForFunction(() => document.querySelector('textarea.composer__input')?.value === '');
    assert.deepEqual(posts('/messages').map((item) => item.body), [{ content: 'Quick question while paused.', intent: 'normal' }]);
    assert.equal(posts('/workflow').length, 0, 'no second goal start, so no 409');
    assert.equal(find('s-a').state, 'paused');
    assert.equal(find('s-a').version, 3, 'the paused goal is unchanged');
    assert.equal(await u.alert.count(), 0);
    await u.label('Paused by you').waitFor();
    assert.equal(await u.resume.isEnabled(), true, 'Resume remains available');
  }));

  await test('Autonomous mode armed before a goal arrives paused is reset and locked', () => run({}, async ({ page, ui: u }) => {
    await u.chooseMode('Autonomous');
    await u.budgets();
    world.workflows = [workflow('s-a', { state: 'paused', stopReason: 'user-pause', version: 2 })];
    await u.refresh();
    await u.label('Paused by you').waitFor();
    assert.equal((await u.mode.innerText()).trim() === 'Autonomous', false);
    assert.equal(await u.autonomousDisabled(), true);
    assert.equal(await page.getByText(/Up to \d+ turns/).filter({ visible: true }).count(), 0, 'budget setup is gone');
    assert.equal(await u.send.getAttribute('aria-label'), 'Send message');
  }));

  await test('after Stop the Autonomous mode is available again and a new goal replaces the stopped one', () => run({
    setup() { world.workflows = [workflow('s-a', { state: 'stopped', stopReason: 'user-stop', version: 4, goal: 'Previous goal' })]; },
  }, async ({ page, ui: u }) => {
    await u.label('Stopped by you').waitFor();
    assert.equal(await u.autonomousDisabled(), false);
    await u.chooseMode('Autonomous');
    await u.input.fill('A fresh goal');
    await u.send.click();
    await page.getByText('A fresh goal', { exact: true }).waitFor();
    await u.label('Working toward your goal').waitFor();
    assert.deepEqual(posts('/workflow').map((item) => item.body.goal), ['A fresh goal']);
  }));

  await test('between turns the panel counts only its own running subagents; a native question still reads Waiting for you', () => run({
    setup() { world.workflows = [workflow('s-a', { version: 2 })]; },
  }, async ({ page, ui: u }) => {
    await u.label('Continuing your goal').waitFor();
    world.delegated = [helper('s-a', 'running', 1), helper('s-a', 'running', 2), helper('s-a', 'completed', 3), helper('s-b', 'running', 4)];
    await u.refresh();
    await u.label('Waiting for 2 subagents').waitFor();
    await page.getByText('Helper results continue this goal within its remaining budget.').waitFor();
    world.delegated = [helper('s-a', 'running', 1), helper('s-b', 'running', 4)];
    await u.refresh();
    await u.label('Waiting for 1 subagent').waitFor();
    setStatus('s-a', 'waiting');
    await u.refresh();
    await u.label('Waiting for you').waitFor();
    assert.equal(await page.getByText('Helper results continue this goal within its remaining budget.').count(), 0);
    setStatus('s-a', 'running');
    await u.refresh();
    await u.label('Working toward your goal').waitFor();
    world.delegated = [];
    setStatus('s-a', 'idle');
    await u.refresh();
    await u.label('Continuing your goal').waitFor();
    assert.equal(posts('/workflow').length + posts('/pause').length, 0);
  }));

  await test('Pause and Stop send the visible version; the Composer stop control stops the workflow, not just the run', () => run({
    setup() { setStatus('s-a', 'running'); world.workflows = [workflow('s-a', { version: 3 })]; },
  }, async ({ page, ui: u }) => {
    await u.pause.click();
    await u.label('Paused by you').waitFor();
    assert.deepEqual(posts('/workflow/pause').map((item) => item.body), [{ expectedVersion: 3 }]);
    assert.equal(await u.resume.isEnabled(), true);
    assert.equal(await u.pause.count(), 0);
    await u.stop.click();
    await u.label('Stopped by you').waitFor();
    assert.deepEqual(posts('/workflow/stop').map((item) => item.body), [{ expectedVersion: 4 }]);
    for (const control of [u.pause, u.stop, u.resume]) assert.equal(await control.count(), 0, 'a stopped workflow offers no actions');
    world.workflows = [workflow('s-a', { version: 5 })];
    setStatus('s-a', 'running');
    await page.reload();
    await page.getByRole('button', { name: 'Interrupt run' }).click();
    await u.label('Stopped by you').waitFor();
    assert.deepEqual(posts('/workflow/stop').map((item) => item.body).slice(-1), [{ expectedVersion: 5 }]);
    assert.equal(posts('/interrupt').length, 0, 'workflow stop does not fall back to a bare run interrupt');
  }));

  await test('a stale 409 on Pause/Resume is shown and refreshed, never replayed', () => run({
    setup() { setStatus('s-a', 'running'); world.workflows = [workflow('s-a', { version: 1 })]; },
  }, async ({ page, ui: u }) => {
    await u.label('Working toward your goal').waitFor();
    Object.assign(find('s-a'), { state: 'paused', stopReason: 'user-pause', version: 2 }); setStatus('s-a', 'idle'); // a teammate paused first
    await u.pause.click();
    await u.alert.filter({ hasText: 'This workflow changed on another device. Refresh before retrying.' }).waitFor();
    await u.label('Paused by you').waitFor();
    await page.waitForTimeout(600);
    assert.deepEqual(posts('/workflow/pause').map((item) => item.body), [{ expectedVersion: 1 }], 'exactly one attempt, with the old version');
    assert.equal(posts('/workflow/stop').length + posts('/workflow/resume').length, 0);
    assert.equal(find('s-a').version, 2, 'the stale request changed nothing');
    await u.stop.click();
    await u.label('Stopped by you').waitFor();
    assert.deepEqual(posts('/workflow/stop').map((item) => item.body), [{ expectedVersion: 2 }], 'the next action uses the refreshed version');
  }));

  await test('a stale 409 on Resume is shown and refreshed, never replayed', () => run({
    setup() { world.workflows = [workflow('s-a', { state: 'paused', stopReason: 'user-pause', version: 2 })]; },
  }, async ({ page, ui: u }) => {
    await u.label('Paused by you').waitFor();
    Object.assign(find('s-a'), { state: 'running', stopReason: null, version: 3 }); setStatus('s-a', 'idle'); // a teammate resumed first
    await u.resume.click();
    await u.alert.filter({ hasText: 'This workflow changed on another device.' }).waitFor();
    await u.label('Continuing your goal').waitFor();
    await page.waitForTimeout(600);
    assert.deepEqual(posts('/workflow/resume').map((item) => item.body), [{ expectedVersion: 2 }]);
    assert.equal(find('s-a').version, 3);
  }));

  await test('Resume after the turn budget asks for explicit extra turns', () => run({
    setup() { world.workflows = [workflow('s-a', { state: 'paused', stopReason: 'limit', version: 4, counters: { turns: 8, stalls: 0 } })]; },
  }, async ({ page, ui: u }) => {
    await u.label('Run limit reached').waitFor();
    await page.getByText('8/8 turns').waitFor();
    await u.resume.click();
    await u.label('Working toward your goal').waitFor();
    assert.deepEqual(posts('/workflow/resume').map((item) => item.body), [{ expectedVersion: 4, additionalTurns: 8 }], 'no hidden time extension');
    await page.getByText('8/16 turns').waitFor();
  }));

  await test('Resume after the deadline asks for explicit extra time, and says so when both are needed', () => run({
    setup() { world.workflows = [workflow('s-a', { state: 'paused', stopReason: 'limit', version: 2, deadlineAt: iso(Date.now() - 60_000) })]; },
  }, async ({ page, ui: u }) => {
    await u.resume.filter({ hasText: '+4 hours' }).click();
    await u.label('Working toward your goal').waitFor();
    assert.deepEqual(posts('/workflow/resume').map((item) => item.body), [{ expectedVersion: 2, extendMinutes: 240 }]);
    assert.ok(Date.parse(find('s-a').deadlineAt) > Date.now(), 'the persisted deadline moved forward');
    world.workflows = [workflow('s-a', { state: 'paused', stopReason: 'limit', version: 6, counters: { turns: 8, stalls: 0 }, deadlineAt: iso(Date.now() - 60_000) })];
    setStatus('s-a', 'idle');
    await page.reload();
    await page.getByText('Resuming grants 8 additional turns and 4 hours more.').waitFor();
    await u.resume.click();
    await u.label('Working toward your goal').waitFor();
    assert.deepEqual(posts('/workflow/resume').slice(-1).map((item) => item.body), [{ expectedVersion: 6, additionalTurns: 8, extendMinutes: 240 }]);
  }));

  await test('a plain resume carries no extension, and an exhausted 50-turn budget cannot be resumed', () => run({
    setup() { world.workflows = [workflow('s-a', { state: 'paused', stopReason: 'user-pause', version: 7 })]; },
  }, async ({ page, ui: u }) => {
    assert.equal(await u.resume.getAttribute('aria-label'), 'Resume');
    await u.resume.click();
    await u.label('Working toward your goal').waitFor();
    assert.deepEqual(posts('/workflow/resume').map((item) => item.body), [{ expectedVersion: 7 }]);
    world.workflows = [workflow('s-a', { state: 'paused', stopReason: 'limit', version: 9, limits: { maxTurns: 50, maxElapsedMinutes: 240, maxStalls: 2 }, counters: { turns: 50, stalls: 0 } })];
    setStatus('s-a', 'idle');
    await page.reload();
    await page.getByText('50/50 turns').waitFor();
    assert.equal(await u.resume.isDisabled(), true);
    await page.getByText('This goal reached its maximum budget. Stop it before starting a new goal.').waitFor();
    assert.equal(posts('/workflow/resume').length, 1);
  }));

  await test('a time extension never exceeds the 24-hour hard cap; a fully used cap cannot be resumed', () => run({
    setup() { world.workflows = [workflow('s-a', { state: 'paused', stopReason: 'limit', version: 3, limits: { maxTurns: 8, maxElapsedMinutes: 1300, maxStalls: 2 }, deadlineAt: iso(Date.now() - 60_000) })]; },
  }, async ({ page, ui: u }) => {
    assert.equal(await u.resume.getAttribute('aria-label'), 'Resume · +140 minutes');
    await u.resume.click();
    await u.label('Working toward your goal').waitFor();
    assert.deepEqual(posts('/workflow/resume').map((item) => item.body), [{ expectedVersion: 3, extendMinutes: 140 }]);
    world.workflows = [workflow('s-a', { state: 'paused', stopReason: 'limit', version: 5, limits: { maxTurns: 8, maxElapsedMinutes: 1440, maxStalls: 2 }, deadlineAt: iso(Date.now() - 60_000) })];
    setStatus('s-a', 'idle');
    await page.reload();
    await u.label('Run limit reached').waitFor();
    assert.equal(await u.resume.isDisabled(), true);
    await page.getByText('This goal reached its maximum budget. Stop it before starting a new goal.').waitFor();
    assert.equal(posts('/workflow/resume').length, 1, 'no resume attempt past the cap');
    await u.stop.click();
    await u.label('Stopped by you').waitFor();
  }));

  await test('needs-human waiting is explicit and offers no hidden continuation', () => run({
    setup() { setStatus('s-a', 'waiting'); world.workflows = [workflow('s-a', { version: 3 })]; },
  }, async ({ page, ui: u, shot }) => {
    await u.label('Waiting for you').waitFor();
    await page.getByText('Answer the question or permission request in this conversation to continue.').waitFor();
    await page.getByText('Waiting for your answer or approval above before the run can continue.').waitFor();
    assert.equal(await u.send.count(), 0, 'waiting presents Stop instead of a send action');
    assert.equal(await u.resume.count(), 0);
    assert.equal(await u.pause.isEnabled(), true);
    await shot('03-waiting-desktop');
  }));

  await test('every pause reason is stated plainly with the agent summary and an explicit Resume', async () => {
    const reasons = [['needs-input', 'Needs your input'], ['approval-denied', 'Permission was declined'], ['quota', 'Provider limit reached'], ['failure', 'Provider needs attention'], ['stalled', 'No further progress'],
      ['agent-blocked', 'Agent is blocked'], ['refused', 'Provider declined the request'], ['unreported-outcome', 'Agent did not report an outcome'], ['configuration-changed', 'Session settings changed'], ['app-closed', 'Ready to resume after restart']];
    await run({ setup() { world.workflows = [workflow('s-a', { state: 'paused', stopReason: reasons[0][0], summary: `Example summary for ${reasons[0][0]}.` })]; } }, async ({ page, ui: u }) => {
      for (const [reason, label] of reasons) {
        Object.assign(find('s-a'), { stopReason: reason, summary: `Example summary for ${reason}.` });
        await page.reload();
        await u.label(label).waitFor();
        await page.getByText(`Example summary for ${reason}.`, { exact: true }).waitFor();
        assert.equal(await u.resume.isEnabled(), true, `${reason} offers an explicit Resume`);
      }
      assert.equal(posts('/workflow/resume').length, 0, 'nothing resumed itself');
    });
  });

  await test('completion is worded as an agent report and Review changes opens the Changes pane', () => run({
    setup() { world.workflows = [workflow('s-a', { state: 'completed', stopReason: 'goal-complete', version: 5, counters: { turns: 4, stalls: 0 }, summary: 'The agent reports the README is updated and the example checks ran.' })]; },
  }, async ({ page, ui: u, shot }) => {
    const heading = u.label('Agent reported completion');
    await heading.waitFor();
    assert.equal(await heading.getAttribute('aria-expanded'), 'false', 'finished workflows start collapsed');
    for (const control of [u.pause, u.stop, u.resume]) assert.equal(await control.count(), 0);
    await heading.click();
    await page.getByText('The agent reports the README is updated and the example checks ran.', { exact: true }).waitFor();
    const text = await textOf(u.panel);
    assert.doesNotMatch(text.replace('The agent reports the README is updated and the example checks ran.', ''), /\b(verified|certified|accepted|merged|published|passed|done|succeeded)\b/i, 'the host claims nothing beyond the agent report');
    await shot('04-completed-desktop');
    await page.getByRole('button', { name: 'Review changes' }).click();
    await page.getByText('Context tab: changes', { exact: true }).waitFor();
  }));

  await test('running and paused snapshots restore after a page load without any automatic action', () => run({
    setup() { setStatus('s-a', 'running'); world.workflows = [workflow('s-a', { version: 5, counters: { turns: 3, stalls: 0 } })]; },
  }, async ({ page, ui: u }) => {
    await u.label('Working toward your goal').waitFor();
    await page.getByText('3/8 turns').waitFor();
    await page.getByText(GOAL, { exact: true }).waitFor();
    await page.reload();
    await u.label('Working toward your goal').waitFor();
    await page.getByText('3/8 turns').waitFor();
    Object.assign(find('s-a'), { state: 'paused', stopReason: 'app-closed', version: 6 }); setStatus('s-a', 'idle');
    await page.reload();
    await u.label('Ready to resume after restart').waitFor();
    await page.getByText('Resume checks the current workspace before continuing partial work.').waitFor();
    await page.waitForTimeout(500);
    assert.equal(await u.resume.isEnabled(), true);
    assert.deepEqual(world.log.filter((item) => item.method !== 'GET' && !item.path.includes('/workspace/selection')), [], 'loading performs no mutation');
    // A later snapshot arrives through the ordinary bootstrap refresh, not a socket.
    Object.assign(find('s-a'), { state: 'running', stopReason: null, version: 7, counters: { turns: 4, stalls: 0 } }); setStatus('s-a', 'running');
    await u.refresh();
    await u.label('Working toward your goal').waitFor();
    await page.getByText('4/8 turns').waitFor();
  }));

  await test('switching sessions keeps workflow, drafts, attachments and actions with their own session and project', () => run({
    setup() { setStatus('s-a', 'running'); world.workflows = [workflow('s-a', { version: 2 })]; world.attachments['s-a'] = [{ id: `att_${hex32(900)}`, name: 'a-notes.txt', mimeType: 'text/plain', size: 3, kind: 'file', createdAt: iso(Date.now()) }]; },
  }, async ({ page, ui: u }) => {
    await page.getByText('Project: Example project A', { exact: true }).waitFor();
    await page.getByText(GOAL, { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Remove a-notes.txt' }).waitFor();
    await u.input.fill('draft for A');
    await u.open('Example session B').click();
    await page.getByText('Project: Example project B', { exact: true }).waitFor();
    assert.equal(await u.panel.count(), 0, 'B shows nothing from A');
    assert.equal(await u.input.inputValue(), '');
    assert.equal(await page.getByRole('button', { name: 'Remove a-notes.txt' }).count(), 0, 'A attachments do not leak into B');
    assert.equal(await u.autonomousDisabled(), false);
    await u.input.fill('draft for B');
    await u.open('Example session A').click();
    await page.getByText('Project: Example project A', { exact: true }).waitFor();
    assert.equal(await u.input.inputValue(), 'draft for A');
    assert.equal(await u.autonomousDisabled(), true);
    await u.open('Example session B').click();
    assert.equal(await u.input.inputValue(), 'draft for B');
    assert.equal((await u.mode.innerText()).trim() === 'Autonomous', false, 'mode does not follow the draft across sessions');
    await u.chooseMode('Autonomous');
    await u.send.click();
    await u.label('Working toward your goal').waitFor();
    assert.deepEqual(posts('/workflow').map((item) => [item.path, item.body.goal, item.body.attachmentIds, item.body.contextRefs]), [['/api/sessions/s-b/workflow', 'draft for B', [], []]]);
    assert.equal(find('s-a').goal, GOAL);
    assert.equal(find('s-a').version, 2, 'A was untouched');
    await page.getByText('draft for B', { exact: true }).waitFor();
  }));

  await test('an action in flight when the session changes cannot leak a result or error into the new session', () => run({
    setup() { setStatus('s-a', 'running'); world.workflows = [workflow('s-a', { version: 2 })]; setStatus('s-b', 'idle'); },
  }, async ({ page, ui: u }) => {
    let release; const gate = new Promise((resolve) => { release = resolve; });
    world.hold = { match: 's-a:pause', promise: gate };
    await u.pause.click();
    await u.open('Example session B').click();
    await page.getByText('Project: Example project B', { exact: true }).waitFor();
    Object.assign(find('s-a'), { version: 3 }); // make the held request stale: the late response is a 409
    release();
    await page.waitForTimeout(500);
    assert.equal(await u.alert.count(), 0, 'no alert for another session');
    assert.equal(await u.panel.count(), 0);
    assert.deepEqual(posts('/pause').map((item) => item.path), ['/api/sessions/s-a/workflow/pause'], 'the request went to the originating session only');
    await u.open('Example session A').click();
    await page.getByText('Project: Example project A', { exact: true }).waitFor();
    await u.label('Working toward your goal').waitFor();
    assert.equal(await u.alert.count(), 0, 'the remounted composer starts without a stale error');
    assert.equal(posts('/pause').length, 1, 'nothing replays on return');
  }));

  for (const [width, height] of [[390, 844], [900, 800]]) {
    await test(`layout at ${width}px: panel, setup and actions stay inside the viewport (screenshots)`, () => run({
      viewport: { width, height },
      setup() {
        setStatus('s-a', 'running');
        world.workflows = [workflow('s-a', { goal: `${GOAL} ${'Keep going with a deliberately long goal description. '.repeat(6)}https://example.invalid/${'very-long-path-segment-'.repeat(6)}`, version: 2, counters: { turns: 5, stalls: 1 } })];
        world.attachments['s-a'] = [{ id: `att_${hex32(901)}`, name: `${'long-attachment-name-'.repeat(4)}.txt`, mimeType: 'text/plain', size: 3, kind: 'file', createdAt: iso(Date.now()) }];
      },
    }, async ({ page, ui: u, shot }) => {
      await u.label('Working toward your goal').waitFor();
      const check = async (label) => {
        assert.equal(await noOverflow(page), true, `${label}: no horizontal page overflow`);
        assert.equal(await inViewport(page, '.session-workflow, .session-workflow button, .composer, .composer__bar button, .workflow-setup, .workflow-setup input'), true, `${label}: every control inside the viewport`);
        for (const control of [u.pause, u.stop]) if (await control.count()) { const box = await control.boundingBox(); assert.ok(box && box.height >= 28, `${label}: action height`); }
      };
      await check('running');
      await shot(`10-running-${width}`);
      Object.assign(find('s-a'), { state: 'paused', stopReason: 'limit', version: 3, counters: { turns: 8, stalls: 0 }, deadlineAt: iso(Date.now() - 1000), summary: `Stopped at the run limit. ${'Longer summary text. '.repeat(10)}` }); setStatus('s-a', 'idle');
      await u.refresh();
      await u.resume.waitFor();
      await check('paused with grant');
      await shot(`11-paused-${width}`);
      world.workflows = []; await u.refresh();
      await u.panel.waitFor({ state: 'detached' });
      await u.chooseMode('Autonomous');
      await u.budgets();
      await u.input.fill(GOAL);
      await check('setup open');
      await shot(`12-setup-${width}`);
    }));
  }

  await test('keyboard: start, adjust budget, toggle details and pause without a pointer', () => run({ viewport: { width: 390, height: 844 } }, async ({ page, ui: u, shot }) => {
    await u.mode.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal((await u.mode.innerText()).trim() === 'Autonomous', true);
    await u.settings.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: 'Advanced conversation settings' }).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'dialog');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.closest('label')?.textContent), 'Turn budget', await page.evaluate(() => document.activeElement?.outerHTML));
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('5');
    await u.input.focus();
    await page.keyboard.type(GOAL);
    await page.keyboard.press('Enter');
    await u.label('Working toward your goal').waitFor();
    assert.equal(posts('/workflow')[0].body.limits.maxTurns, 5);
    const heading = u.label('Working toward your goal');
    await heading.focus();
    await page.keyboard.press('Enter');
    assert.equal(await heading.getAttribute('aria-expanded'), 'false');
    await page.keyboard.press('Space');
    assert.equal(await heading.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Pause autonomous workflow');
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none', 'keyboard focus is visible');
    await shot('13-keyboard-390');
    await page.keyboard.press('Enter');
    await u.label('Paused by you').waitFor();
    assert.deepEqual(posts('/workflow/pause').map((item) => item.body), [{ expectedVersion: 1 }]);
  }));

  await test('reduced motion disables the live pulse; the pulse exists without the preference', async () => {
    const live = (page) => page.locator('.session-workflow__live').evaluate((node) => getComputedStyle(node).animationName);
    const setup = () => { setStatus('s-a', 'running'); world.workflows = [workflow('s-a')]; };
    await run({ reducedMotion: 'reduce', setup }, async ({ ui: u, page }) => { await u.label('Working toward your goal').waitFor(); assert.equal(await live(page), 'none'); });
    await run({ reducedMotion: 'no-preference', setup }, async ({ ui: u, page }) => { await u.label('Working toward your goal').waitFor(); assert.equal(await live(page), 'workflow-live'); });
  });

  await test('integrated progress has one collapsed goal strip, checklist and helper navigation; controls and refresh stay usable', () => run({
    integratedProgress: true,
    setup() { setStatus('s-a', 'running'); world.workflows = [workflow('s-a')]; world.delegated = [helper('s-a', 'running', 1)]; },
  }, async ({ page, ui: u, shot }) => {
    const heading = u.label('Working toward your goal');
    assert.equal(await heading.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.status-bar').count(), 0, 'no second status panel outside the goal');
    assert.equal(await page.getByRole('button', { name: /^(Expand|Collapse) subagents$/ }).count(), 0, 'no nested helper disclosure');
    assert.equal(await u.pause.isVisible(), true, 'controls remain outside collapsed details');
    await heading.click();
    await page.getByRole('list', { name: 'Task checklist' }).waitFor();
    await page.getByRole('button', { name: 'Open @example-helper-1 subagent session' }).click();
    await page.getByText('Opened helper example-helper-1', { exact: true }).waitFor();
    find('s-a').counters.turns = 2; await u.refresh();
    assert.equal(await heading.getAttribute('aria-expanded'), 'true');
    for (const width of [900, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await noOverflow(page), true);
      assert.equal(await inViewport(page, '.session-workflow, .session-workflow button, .single-subagents'), true);
      await shot(`14-unified-progress-${width}`);
    }
    await heading.focus(); await page.keyboard.press('Escape');
    assert.equal(await heading.getAttribute('aria-expanded'), 'false');
    await u.pause.click(); await u.label('Paused by you').waitFor();
  }));

  await test('real Composer recovery actions separate provider setup from Mingle, open usage, inspect the matching run and state pending retry', async () => {
    const stamp = iso(Date.now());
    const baseSetup = (failure, workflowSummary = null, runModel = 'claude-example') => {
      const target = world.sessions.find((item) => item.id === 's-a');
      Object.assign(target, { status: 'error', error: 'Example provider failure.' });
      world.failure = { id: 'example-failure', sessionId: 's-a', runId: 'example-failed-run', actor: 'session', provider: 'claude', kind: failure.kind, providerCode: failure.providerCode, retryable: failure.retryable ?? false, safeToRetry: failure.safeToRetry, outcomeUnknown: failure.outcomeUnknown ?? false, dispatchState: failure.dispatchState ?? 'unknown', continuationSafety: failure.continuationSafety ?? 'unknown', retryAt: null, message: failure.message ?? 'Example classified provider failure.', occurredAt: stamp };
      world.runs = [{ id: 'example-failed-run', sessionId: 's-a', userMessageId: 'example-failed-message', provider: 'claude', model: runModel, status: 'failed', startedAt: stamp, finishedAt: stamp, durationMs: 10, toolCount: 0, toolCounts: {} }];
      world.messages = [{ id: 'example-failed-message', sessionId: 's-a', role: 'user', content: 'Example request that failed.', createdAt: stamp, runId: 'example-failed-run' }];
      if (workflowSummary) world.workflows = [workflow('s-a', { state: 'running', currentRunId: null, summary: workflowSummary })];
    };
    await run({ viewport: { width: 900, height: 844 }, setup() { baseSetup({ kind: 'authentication', message: 'Example authentication failure.' }); } }, async ({ page, shot }) => {
      const note = page.locator('.composer__note').first();
      await note.getByRole('button', { name: 'Open Providers settings' }).waitFor();
      assert.match(await note.innerText(), /separate from your Mingle account/);
      world.questions = [{ id: 'example-pending-question', sessionId: 's-a', runId: 'example-failed-run', provider: 'claude', tool: 'AskUserQuestion', questions: [{ id: 'example-choice', header: 'Next step', question: 'Should Mingle continue?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false, allowOther: false, secret: false }], status: 'pending', createdAt: stamp, resolvedAt: null }];
      await page.evaluate(() => window.refreshExampleBootstrap());
      await note.getByRole('button', { name: 'Go to the question' }).click();
      assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-question-id]')?.getAttribute('data-question-id')), 'example-pending-question');
      await note.getByRole('button', { name: 'Open Providers settings' }).click();
      await page.waitForFunction(() => window.getExampleSettingsState?.().view === 'settings' && window.getExampleSettingsState?.().section === 'providers');
      await shot('15-auth-provider-settings');
    });
    await run({ viewport: { width: 390, height: 844 }, setup() { baseSetup({ kind: 'quota_exhausted', message: 'Example quota failure.' }); } }, async ({ page, shot }) => {
      const note = page.locator('.composer__note').first();
      world.approvals = [{ id: 'example-pending-approval', sessionId: 's-a', tool: 'Bash', description: 'Example approval request.', input: {}, status: 'pending', createdAt: stamp }];
      await page.evaluate(() => window.refreshExampleBootstrap());
      await note.getByRole('button', { name: 'Go to the approval' }).click();
      assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-approval-id]')?.getAttribute('data-approval-id')), 'example-pending-approval');
      await note.getByRole('button', { name: 'Check provider usage' }).waitFor();
      await note.getByRole('button', { name: 'Check provider usage' }).click();
      await page.getByRole('dialog', { name: 'Usage' }).waitFor();
      await page.getByRole('heading', { name: 'Usage' }).waitFor();
      await page.getByRole('button', { name: 'Close usage' }).click();
      await note.getByRole('button', { name: 'Review this run' }).click();
      await page.locator('[data-run-id="example-failed-run"]').waitFor();
      await shot('16-quota-usage-review-390');
    });
    await run({ viewport: { width: 900, height: 844 }, setup() { baseSetup({ kind: 'temporary_rate_limit', retryable: true, safeToRetry: true, dispatchState: 'not-dispatched', outcomeUnknown: false, continuationSafety: 'safe' }, 'Automatic retry pending.'); } }, async ({ page, shot }) => {
      const note = page.locator('.composer__note').first();
      await note.getByText(/automatic retry is pending for this generated goal turn/i).waitFor();
      await note.getByRole('button', { name: 'Review this run' }).focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('[data-run-id="example-failed-run"]').count(), 1);
      await shot('17-pending-retry-fenced-review-900');
    });
    await run({ viewport: { width: 900, height: 844 }, setup() { baseSetup({ kind: 'authentication', message: 'Stale Example failure.' }, null, 'wrong-model'); } }, async ({ page }) => {
      const note = page.locator('.composer__note').first();
      await note.getByText(/failed without a matching classified recovery record/i).waitFor();
      assert.equal(await note.getByRole('button', { name: 'Open Providers settings' }).count(), 0);
      await note.getByRole('button', { name: 'Review this run' }).waitFor();
    });
  });

  await test('boundary: only Example endpoints and mocked local sockets were used; no external hosts or run-control endpoints', () => {
    assert.ok(aggregate.sockets.every((url) => new URL(url).hostname === '127.0.0.1' && new URL(url).pathname === '/ws'));
    assert.deepEqual(aggregate.unexposed.filter((path) => !unexposedAllowed.test(path)), []);
    assert.deepEqual(aggregate.requests.filter((entry) => /\/(interrupt|approvals|questions|compact|runs|retry)\b/.test(entry) && !/GET /.test(entry)), []);
  });
} finally { await browser?.close(); await server?.close(); }

console.log(JSON.stringify({ passed, failed: failures.length, output, screenshots, fixtureOnly: true }));
if (failures.length) process.exitCode = 1;
