import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { WebSocket } = require('ws');
const dataDir = await mkdtemp(join(tmpdir(), 'mingle-smoke-'));
let child;
let socket;
let logs = '';

async function reservePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

const port = await reservePort();
const base = `http://127.0.0.1:${port}`;

async function start() {
  child = spawn(process.execPath, ['--import', join(root, 'apps/server/node_modules/tsx/dist/loader.mjs'), join(root, 'apps/server/src/index.ts')], {
    cwd: root, env: { ...process.env, MINGLE_DATA_DIR: dataDir, MINGLE_PORT: String(port), PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited during startup: ${logs}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server failed to start: ${logs}`);
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child?.kill('SIGKILL'), 3000);
  try { await exit; } finally { clearTimeout(timer); }
}

async function api(path, method = 'GET', body) {
  const res = await fetch(`${base}/api${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await res.json();
  assert.ok(res.ok, `${method} ${path}: ${res.status} ${JSON.stringify(value)}`);
  return value;
}

try {
  await start();
  const boot = await api('/bootstrap');
  assert.equal(boot.projects.length, 0, 'Fresh startup does not create an example workspace');
  assert.equal(boot.sessions.length, 0, 'Fresh startup creates no sessions or inference');
  const fixturePath = join(dataDir, 'smoke-fixture');
  await mkdir(fixturePath);
  await writeFile(join(fixturePath, 'README.md'), '# Disposable smoke fixture\n');
  const gitArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Mingle Smoke', '-c', 'user.email=example@mingle.invalid'];
  execFileSync('git', [...gitArgs, 'init', '--quiet', '--initial-branch=main', '--template='], { cwd: fixturePath });
  execFileSync('git', [...gitArgs, 'add', '--', 'README.md'], { cwd: fixturePath });
  execFileSync('git', [...gitArgs, 'commit', '--quiet', '-m', 'Smoke fixture'], { cwd: fixturePath });
  const project = await api('/projects', 'POST', { name: 'Smoke fixture', path: fixturePath });
  await api('/workspace/selection', 'PUT', { projectId: project.id });
  const files = await api(`/projects/${project.id}/files`);
  assert.ok(files.some(item => item.type === 'file'), 'File API lists actual fixture files');
  const git = await api(`/projects/${project.id}/git`);
  assert.equal(git.isRepo, true, 'Fixture is a real Git repository');

  const isolated = await api('/sessions', 'POST', {
    // This checks Git/workspace isolation, not provider capabilities. Resolve native defaults instead of requiring a
    // particular model's reasoning control on a CI runner that may have no provider or model catalog installed.
    projectId: project.id, name: 'Smoke isolation', provider: 'codex', isolated: true,
  });
  assert.notEqual(isolated.worktreePath, project.path, 'New session uses an isolated worktree');
  assert.ok(isolated.branch, 'Isolated session has a Git branch');
  const readme = files.find(item => item.name.toLowerCase() === 'readme.md') ?? files.find(item => item.type === 'file');
  const scoped = `/projects/${project.id}/file?path=${encodeURIComponent(readme.path)}&sessionId=${isolated.id}`;
  const original = await api(scoped);
  const changed = `${original.content}\nSmoke isolation check.\n`;
  await api(scoped, 'PUT', { content: changed });
  const mainFile = await api(`/projects/${project.id}/file?path=${encodeURIComponent(readme.path)}`);
  assert.equal(mainFile.content, original.content, 'Worktree save leaves the project checkout unchanged');
  const isolatedGit = await api(`/projects/${project.id}/git?sessionId=${isolated.id}`);
  assert.ok(isolatedGit.diff.includes('Smoke isolation check.'), 'Changes API reflects actual session edits');
  await api(scoped, 'PUT', { content: original.content });

  const prerequisite = await api('/tasks', 'POST', { projectId: project.id, title: 'Smoke prerequisite', acceptanceCriteria: 'Recorded state persists.' });
  const dependent = await api('/tasks', 'POST', { projectId: project.id, title: 'Smoke dependent', dependsOn: [prerequisite.id] });
  assert.equal(dependent.status, 'blocked');
  const cycleResponse = await fetch(`${base}/api/tasks/${prerequisite.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dependsOn: [dependent.id] }) });
  assert.ok(cycleResponse.status >= 400 && cycleResponse.status < 500, 'Dependency cycle is rejected');
  await api(`/tasks/${prerequisite.id}`, 'PATCH', { status: 'done' });
  const updated = await api('/bootstrap');
  assert.equal(updated.tasks.find(item => item.id === dependent.id).status, 'ready', 'Completing a prerequisite unblocks its dependent');

  const forbidden = await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'https://untrusted.invalid' }, body: JSON.stringify({ theme: 'light' }) });
  assert.equal(forbidden.status, 403, 'Foreign browser origin cannot mutate local state');
  const traversal = await fetch(`${base}/api/projects/${project.id}/file?path=..%2F..%2Fetc%2Fpasswd`);
  assert.ok(traversal.status >= 400 && traversal.status < 500, 'File traversal is refused');

  let output = '';
  await new Promise((resolve, reject) => {
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: base });
    const timer = setTimeout(() => reject(new Error(`Terminal did not produce output: ${output}`)), 10000);
    socket.on('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'terminal.start', projectId: project.id, cols: 80, rows: 24 })));
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString());
      if (event.type === 'terminal.ready') socket.send(JSON.stringify({ type: 'terminal.input', terminalId: event.terminalId, data: "printf 'MINGLE_TERMINAL_%s\\n' 'OK'\r" }));
      if (event.type === 'terminal.output') {
        output += event.data;
        if (/MINGLE_TERMINAL_OK/.test(output)) { clearTimeout(timer); resolve(); }
      }
    });
  });
  socket.close();
  await stop();
  await start();
  const restored = await api('/bootstrap');
  assert.equal(restored.lastProjectId, project.id, 'Last project persists across a real process restart');
  assert.ok(restored.tasks.some(item => item.id === prerequisite.id && item.status === 'done'), 'Tasks persist across a real process restart');
  assert.ok(restored.sessions.some(item => item.id === isolated.id), 'Sessions persist across restart');
  assert.ok(restored.events.length > boot.events.length, 'Mutations emit durable events');
  console.log('Smoke passed: real HTTP/WS server, SQLite restart, worktree isolation, Git diff, task DAG, origin/path rejection and PTY. No model calls.');
} catch (error) {
  console.error(error);
  console.error(logs);
  process.exitCode = 1;
} finally {
  socket?.close();
  await stop();
  await rm(dataDir, { recursive: true, force: true });
}
