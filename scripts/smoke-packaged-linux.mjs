import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const stage = resolve(process.argv[2] ?? 'release/mingle-0.0.1-linux-x64');
const scratch = await mkdtemp(join(tmpdir(), 'mingle-package-check-'));
const script = join(scratch, 'check.mjs');
await writeFile(script, `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const stage = process.argv[2];
const server = join(stage, 'resources/workspace/apps/server');
const require = createRequire(join(server, 'package.json'));
const pty = require('node-pty');
await new Promise((resolve, reject) => {
  const terminal = pty.spawn('/bin/sh', ['-c', 'printf MINGLE_PTY_OK'], { cwd: process.argv[3], env: process.env });
  let output = '';
  const timer = setTimeout(() => { terminal.kill(); reject(new Error('PTY timed out')); }, 10000);
  terminal.onData(data => output += data);
  terminal.onExit(({ exitCode }) => { clearTimeout(timer); try { assert.equal(exitCode, 0); assert.match(output, /MINGLE_PTY_OK/); resolve(); } catch (error) { reject(error); } });
});
const { startMingleServer } = await import(pathToFileURL(join(server, 'dist/index.mjs')));
const app = await startMingleServer({ dataDir: join(process.argv[3], 'data'), port: 0, host: '127.0.0.1', detectOnStart: false, exampleWorkspace: false, webDistDir: join(stage, 'resources/workspace/apps/web/dist') });
try {
  for (const endpoint of ['/api/health', '/api/bootstrap', '/']) {
    const res = await fetch(app.url + endpoint);
    assert.equal(res.status, 200, endpoint);
    const body = await res.text();
    if (endpoint === '/') assert.match(body, /<html/);
    else assert.doesNotThrow(() => JSON.parse(body));
  }
  assert.ok(app.store);
  const { verifyGitRepositoryDetection } = await import(pathToFileURL(${JSON.stringify(fileURLToPath(new URL('./git-repository-smoke.mjs', import.meta.url)))}));
  await verifyGitRepositoryDetection(app.url, join(process.argv[3], 'git-repository-check'));
  console.log('Packaged Node, native PTY, SQLite, HTTP API and built UI passed.');
} finally { await app.close(); }
`);
try {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(join(stage, 'resources/runtime/bin/node'), [script, stage, scratch], { stdio: 'inherit', env: { ...process.env, MINGLE_DATA_DIR: join(scratch, 'data') } });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Packaged server check timed out')); }, 60000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); try { assert.equal(code, 0, 'Packaged runtime check'); resolvePromise(); } catch (error) { reject(error); } });
  });
} finally { await rm(scratch, { recursive: true, force: true }); }
