#!/usr/bin/env node
/**
 * Refresh-traffic acceptance for ordinary standalone session activity.
 * Runs the real server (disposable data directory, scripted FakeProviders: no model, account or cloud call) and the real web
 * app in Chromium over a sizeable, explicitly labelled Example workspace, then compares one scripted run with scoped
 * session snapshots against the same run with the server's `scope` stripped from WebSocket frames, which is how an older
 * server behaves (every change reloads the whole bootstrap). It counts requests and response bytes, checks the final UI against
 * the server, checks that reconnect and idle behave, and prints a JSON report. Measurements are fixture evidence on one
 * machine over loopback, not Internet latency, CPU or memory.
 *
 *   node scripts/scoped-refresh-browser-acceptance.mjs          # drives the browser
 *   node scripts/scoped-refresh-browser-acceptance.mjs --serve  # the disposable Example runtime (used by the above)
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const SESSIONS = Number(process.env.SCOPED_SESSIONS ?? 30);
const MESSAGES = Number(process.env.SCOPED_MESSAGES ?? 150);
const STEPS = 12;
const STEP_MS = 400;

if (process.argv.includes('--serve')) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'mingle-scoped-refresh-'));
  const repo = path.join(dataDir, 'example-repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Example', '-c', 'user.email=example@mingle.invalid', ...args], { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); writeFileSync(path.join(repo, 'README.md'), '# Example\n'); git('add', '.'); git('commit', '-q', '-m', 'Example');
  let app;
  const shutdown = async () => { try { await app?.close(); } finally { rmSync(dataDir, { recursive: true, force: true }); } };
  try {
    const [{ createApplication }, { FakeProviders }] = await Promise.all([import('../apps/server/src/app.ts'), import('../apps/server/src/test-utils.ts')]);
    const fake = new FakeProviders();
    // The scripted run: tool activity every STEP_MS, then a reply. Nothing leaves the process.
    fake.script = async (_options, emit) => {
      for (let step = 0; step < STEPS; step++) {
        emit({ type: 'tool.activity', activity: { id: `example-tool-${step}`, name: 'Bash', category: 'command', status: 'running', command: `echo example ${step}` } });
        await delay(STEP_MS / 2);
        emit({ type: 'tool.activity', activity: { id: `example-tool-${step}`, name: 'Bash', category: 'command', status: 'completed', output: `example output ${step}` } });
        await delay(STEP_MS / 2);
      }
      emit({ type: 'text', text: 'Example run finished.' });
    };
    app = createApplication({
      dataDir, port: Number(process.env.MINGLE_BROWSER_API_PORT) || 4310, webDevPort: Number(process.env.MINGLE_BROWSER_UI_PORT) || 4451,
      webDistDir: null, providers: fake, log: () => {}, exampleWorkspace: false, detectOnStart: false,
    });
    const { store } = app;
    store.updateSettings({ onboardingCompletedVersion: 1 });
    const project = store.insertProject({ name: 'Example scoped-refresh workspace', path: repo });
    const filler = 'Example conversation text for the refresh traffic fixture. '.repeat(6);
    const ids = store.tx(() => Array.from({ length: SESSIONS }, (_, index) => {
      const session = store.insertSession({ projectId: project.id, name: `Example session ${index + 1}`, provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', policy: 'supervised', isolated: false, worktreePath: repo, branch: 'main' });
      for (let m = 0; m < MESSAGES; m++) store.insertMessage({ sessionId: session.id, role: m % 2 ? 'assistant' : 'user', content: `Example message ${m} for session ${index + 1}. ${filler}` });
      return session.id;
    }));
    const address = await app.listen();
    await app.providers.list();
    process.stdout.write(`READY ${JSON.stringify({ url: address.url, projectId: project.id, sessionIds: ids })}\n`);
    process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
    process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    await shutdown();
    process.exitCode = 1;
  }
} else {
  const serverRequire = createRequire(new URL('../apps/server/package.json', import.meta.url));
  const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const tsxCli = serverRequire.resolve('tsx/cli');
  const viteModule = webRequire.resolve('vite');
  const viteCli = path.resolve(path.dirname(viteModule), '../../bin/vite.js');
  const outputDir = path.join(os.tmpdir(), `mingle-scoped-refresh-acceptance-${process.pid}`);
  mkdirSync(outputDir, { recursive: true });
  const children = [];
  let browser;
  let ready = null;
  const note = (message) => process.stdout.write(`${message}\n`);
  const start = (args, { cwd = root, name, env = {} }) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    children.push({ child, name });
    for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', (chunk) => {
      const line = chunk.split('\n').find((text) => text.startsWith('READY '));
      if (name === 'runtime' && line) ready = JSON.parse(line.slice(6));
      if (process.env.SCOPED_VERBOSE === '1') process.stdout.write(`[${name}] ${chunk}`);
    });
    return child;
  };
  const freePort = async () => {
    const probe = createServer(); probe.listen(0, '127.0.0.1');
    await new Promise((resolve) => probe.once('listening', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
  };
  const until = async (predicate, label, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(60); }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const closeAll = async () => {
    await browser?.close().catch(() => {});
    for (const { child } of [...children].reverse()) {
      if (child.exitCode !== null) continue;
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(4000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(outputDir, { recursive: true, force: true });
  };

  let failure = null;
  try {
    const { chromium } = serverRequire('playwright');
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
    if (!existsSync(executablePath)) throw new Error(`Chromium executable not found: ${executablePath}`);
    const [apiPort, uiPort] = await Promise.all([freePort(), freePort()]);
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const uiUrl = `http://127.0.0.1:${uiPort}/`;
    const viteConfig = path.join(outputDir, 'vite.config.mjs');
    writeFileSync(viteConfig, `
      import { mergeConfig } from ${JSON.stringify(pathToFileURL(viteModule).href)};
      import base from ${JSON.stringify(pathToFileURL(path.join(root, 'apps/web/vite.config.ts')).href)};
      export default mergeConfig(base, { resolve: { alias: [
        { find: /^@mingle\\/contracts\\/stream$/, replacement: ${JSON.stringify(path.join(root, 'packages/contracts/src/stream.ts'))} },
        { find: /^@mingle\\/contracts$/, replacement: ${JSON.stringify(path.join(root, 'packages/contracts/src/index.ts'))} },
      ] }, server: { port: ${uiPort}, strictPort: true, proxy: {
        '/api': { target: ${JSON.stringify(apiUrl)}, changeOrigin: false },
        '/ws': { target: ${JSON.stringify(apiUrl.replace('http', 'ws'))}, ws: true, changeOrigin: false },
      } } });
    `);
    // Both sides use this checkout's contracts rather than whichever copy node_modules links to.
    const tsconfig = path.join(outputDir, 'tsconfig.json');
    writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { baseUrl: root, paths: {
      '@mingle/contracts': ['packages/contracts/src/index.ts'], '@mingle/contracts/stream': ['packages/contracts/src/stream.ts'],
    } } }));
    start([tsxCli, '--tsconfig', tsconfig, fileURLToPath(import.meta.url), '--serve'], { name: 'runtime', env: { MINGLE_BROWSER_API_PORT: String(apiPort), MINGLE_BROWSER_UI_PORT: String(uiPort) } });
    start([viteCli, '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort', '--config', viteConfig], { cwd: path.join(root, 'apps/web'), name: 'vite' });
    await until(() => ready, 'Example runtime');
    await until(async () => (await fetch(uiUrl, { signal: AbortSignal.timeout(500) })).ok, 'Vite UI');
    const target = ready.sessionIds[4];

    browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ projectId, sessionId }) => {
      localStorage.setItem('relay.ui.v2', JSON.stringify({ activeProjectId: projectId, sessionByProject: { [projectId]: sessionId } }));
    }, { projectId: ready.projectId, sessionId: target });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text()); });

    // Frames pass through unchanged, except while `stripScope` emulates a server that never narrows a change.
    let stripScope = false;
    let socketToServer = null;
    await page.routeWebSocket('**/ws', (ws) => {
      const server = ws.connectToServer();
      socketToServer = server;
      server.onMessage((frame) => {
        if (stripScope && typeof frame === 'string' && frame.includes('"scope"')) { const { scope: _scope, ...rest } = JSON.parse(frame); ws.send(JSON.stringify(rest)); } else ws.send(frame);
      });
      ws.onMessage((frame) => server.send(frame));
    });

    const traffic = { bootstrap: { count: 0, bytes: 0 }, snapshot: { count: 0, bytes: 0 }, snapshotSessions: new Set() };
    let counting = false;
    page.on('response', async (response) => {
      if (!counting) return;
      const url = new URL(response.url());
      const kind = url.pathname === '/api/bootstrap' ? 'bootstrap' : /^\/api\/sessions\/[^/]+\/snapshot$/.test(url.pathname) ? 'snapshot' : null;
      if (!kind) return;
      const bytes = Number(response.headers()['content-length'] ?? (await response.body()).length);
      traffic[kind].count++; traffic[kind].bytes += bytes;
      if (kind === 'snapshot') traffic.snapshotSessions.add(url.pathname.split('/')[3]);
    });
    const requestsOtherThanRefresh = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (counting && pathname.startsWith('/api/') && pathname !== '/api/bootstrap' && !/\/snapshot$/.test(pathname)) requestsOtherThanRefresh.push(`${request.method()} ${pathname}`);
    });

    await page.goto(uiUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('.composer textarea').waitFor();
    const storeState = () => page.evaluate(async (id) => {
      const { useMingle } = await import('/src/store/store.ts');
      const s = useMingle.getState();
      return { connection: s.connection, sessions: s.boot?.sessions.length ?? 0, status: s.boot?.sessions.find((x) => x.id === id)?.status,
        tools: s.boot?.toolCalls.filter((call) => call.sessionId === id).length ?? 0, last: s.boot?.messages.filter((m) => m.sessionId === id).at(-1)?.content,
        selected: s.activeProjectId ? s.sessionByProject[s.activeProjectId] : null, stale: s.staleError };
    }, target);
    await until(async () => (await storeState()).connection === 'online' && (await storeState()).sessions === SESSIONS, 'first snapshot');
    assert.equal((await storeState()).selected, target, 'the target Example session is selected');
    await delay(1500);

    const serverSlice = async () => {
      const boot = await (await fetch(`${apiUrl}/api/bootstrap`)).json();
      return { tools: boot.toolCalls.filter((call) => call.sessionId === target).length, last: boot.messages.filter((m) => m.sessionId === target).at(-1)?.content,
        status: boot.sessions.find((s) => s.id === target)?.status, bytes: JSON.stringify(boot).length };
    };
    const reportFor = async (label, strip) => {
      stripScope = strip;
      traffic.bootstrap = { count: 0, bytes: 0 }; traffic.snapshot = { count: 0, bytes: 0 }; traffic.snapshotSessions.clear(); requestsOtherThanRefresh.length = 0;
      const baseline = await storeState();
      counting = true;
      const started = Date.now();
      const sent = await fetch(`${apiUrl}/api/sessions/${target}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `Example request (${label})` }) });
      assert.equal(sent.status, 202, 'the scripted Example run starts');
      await until(async () => { const s = await storeState(); return s.last === 'Example run finished.' && s.status === 'idle' && s.tools >= baseline.tools + STEPS; }, `${label} run to finish in the UI`, 30_000);
      const finished = Date.now() - started;
      await delay(2500); // trailing refreshes settle
      counting = false;
      const ui = await storeState();
      const server = await serverSlice();
      assert.equal(ui.tools, server.tools, `${label}: tool calls match the server`);
      assert.equal(ui.last, server.last, `${label}: last message matches the server`);
      assert.equal(ui.status, server.status, `${label}: status matches the server`);
      assert.equal(ui.stale, null, `${label}: no stale error`);
      return { label, runMs: finished, bootstrap: { ...traffic.bootstrap }, snapshot: { ...traffic.snapshot }, snapshotSessions: [...traffic.snapshotSessions], otherApiRequests: [...requestsOtherThanRefresh], fullBootstrapBytes: server.bytes };
    };

    const scoped = await reportFor('scoped', false);
    const unscoped = await reportFor('whole-bootstrap baseline (scope stripped)', true);
    stripScope = false;

    assert.ok(scoped.snapshot.count >= 2, `scoped refreshes were used (${scoped.snapshot.count})`);
    assert.deepEqual(scoped.snapshotSessions, [target], 'only the active session was reloaded');
    assert.ok(scoped.bootstrap.count <= 4, `only lifecycle changes reload the whole workspace (${scoped.bootstrap.count})`);
    assert.equal(unscoped.snapshot.count, 0, 'the baseline never used a snapshot');
    assert.ok(unscoped.bootstrap.count >= scoped.bootstrap.count + 2, 'the baseline reloaded the whole workspace for ordinary activity');
    const scopedBytes = scoped.bootstrap.bytes + scoped.snapshot.bytes;
    const unscopedBytes = unscoped.bootstrap.bytes + unscoped.snapshot.bytes;
    assert.ok(scopedBytes < unscopedBytes / 2, `scoped refresh transfers far less (${scopedBytes} vs ${unscopedBytes} bytes)`);

    // No idle polling: with nothing happening, the page makes no refresh request.
    traffic.bootstrap = { count: 0, bytes: 0 }; traffic.snapshot = { count: 0, bytes: 0 }; counting = true;
    await delay(4000);
    counting = false;
    assert.equal(traffic.bootstrap.count + traffic.snapshot.count, 0, 'idle page makes no refresh request');

    // A dropped connection missed notifications, so the client rebuilds from a full snapshot, never a scoped one.
    traffic.bootstrap = { count: 0, bytes: 0 }; traffic.snapshot = { count: 0, bytes: 0 }; counting = true;
    socketToServer.close();
    await until(() => traffic.bootstrap.count >= 1, 'a full snapshot after reconnect', 15_000);
    await until(async () => (await storeState()).connection === 'online', 'reconnected');
    await delay(1500);
    counting = false;
    assert.equal(traffic.snapshot.count, 0, 'reconnect used no scoped snapshot');
    assert.equal(errors.length, 0, `no page errors: ${errors.join('; ')}`);

    note(JSON.stringify({ fixture: `${SESSIONS} Example sessions x ${MESSAGES} messages, one scripted run of ${STEPS} tool calls`, scoped, wholeBootstrapBaseline: unscoped,
      saving: { requestsBaseline: unscoped.bootstrap.count, requestsScoped: scoped.bootstrap.count + scoped.snapshot.count, bytesBaseline: unscopedBytes, bytesScoped: scopedBytes, ratio: Number((unscopedBytes / scopedBytes).toFixed(1)) } }, null, 2));
    note('PASS scoped refresh browser acceptance');
  } catch (error) {
    failure = error;
    note(`FAIL ${error instanceof Error ? error.stack : error}`);
  } finally {
    await closeAll();
  }
  process.exitCode = failure ? 1 : 0;
}
