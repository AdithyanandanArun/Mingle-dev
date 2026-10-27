import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'mingle-desktop-check-'));
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolvePromise => probe.close(resolvePromise));
const environment = { ...process.env, XDG_CONFIG_HOME: scratch, APPDATA: scratch, LOCALAPPDATA: join(scratch, 'local'), MINGLE_DATA_DIR: join(scratch, 'workspace') };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;
const child = spawn(resolve(process.argv[2]), [`--remote-debugging-port=${port}`, '--disable-gpu'], {
  env: environment,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => logs = (logs + chunk).slice(-10000));
let socket;
try {
  let page;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`Desktop exited: ${logs}`);
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:')); } catch { /* starting */ }
    if (page) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  assert.ok(page, `Desktop did not open its local UI: ${logs}`);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, 'open');
  const pending = new Map();
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    if (response.id) { pending.get(response.id)?.(response); pending.delete(response.id); }
  });
  let id = 0;
  async function evaluate(expression) {
    const requestId = ++id;
    const response = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Renderer evaluation timed out')); }, 5000);
      pending.set(requestId, value => { clearTimeout(timer); resolvePromise(value); });
    });
    socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    const result = await response;
    assert.ok(!result.error && !result.result.exceptionDetails, JSON.stringify(result));
    return result.result.result.value;
  }
  let view;
  for (let attempt = 0; attempt < 60; attempt++) {
    view = await evaluate('({ title: document.title, text: document.body?.innerText ?? "", mounted: document.querySelector("#root")?.childElementCount > 0 })');
    if (view.mounted && view.text.length > 100) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  assert.match(view.title, /Mingle/);
  assert.ok(view.mounted && view.text.length > 100, JSON.stringify(view));
  assert.equal(await evaluate('typeof window.require'), 'undefined', 'Renderer Node integration stays disabled');
  console.log('Installed Electron opened Mingle and rendered the built application with the sandbox enabled.');
} finally {
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    // Closing the actual window runs Electron's before-quit backend cleanup.
    // On Windows SIGTERM would terminate Electron immediately and orphan Node.
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: 99999, method: 'Runtime.evaluate', params: { expression: 'window.close()' } }));
    else child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 40000);
    await exited;
    clearTimeout(timer);
  }
  socket?.close();
  await rm(scratch, { recursive: true, force: true });
}
