import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mergePath, readLoginPath } from './shell-environment.mjs';

test('login PATH entries come first and duplicates are removed', () => {
  assert.equal(mergePath('/login/bin:/usr/bin', '/usr/bin:/inherited'), '/login/bin:/usr/bin:/inherited');
});

test('reads only marked output, strips Electron run mode, and trusts listed shell', async () => {
  let invoked;
  const spawn = (file, args, options) => {
    invoked = { file, args, options };
    const child = new EventEmitter(); child.stdout = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit('data', 'rc noise\n__MINGLE_LOGIN_PATH_START_7f6c9b__/login/bin:/usr/bin__MINGLE_LOGIN_PATH_END_7f6c9b__'); child.emit('close', 0); });
    child.kill = () => {};
    return child;
  };
  const result = await readLoginPath({ env: { SHELL: '/bin/zsh', PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' }, platform: 'linux', exists: async () => true, isListedShell: async () => true, spawn });
  assert.equal(result.path, '/login/bin:/usr/bin');
  assert.equal(invoked.file, '/bin/zsh');
  assert.deepEqual(invoked.args.slice(0, 1), ['-ilc']);
  assert.equal(invoked.options.env.TERM, 'dumb');
  assert.equal('ELECTRON_RUN_AS_NODE' in invoked.options.env, false);
});

test('keeps inherited PATH on timeout or untrusted shell', async () => {
  const timeoutSpawn = () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {}; return child; };
  const timedOut = await readLoginPath({ env: { PATH: '/current', SHELL: '/evil/shell' }, platform: 'linux', exists: async () => true, spawn: timeoutSpawn, timeoutMs: 5 });
  assert.equal(timedOut.path, '/current');
  assert.ok(timedOut.warning);
  let selected;
  const fallback = (file) => { selected = file; const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {}; queueMicrotask(() => { child.stdout.emit('data', '__MINGLE_LOGIN_PATH_START_7f6c9b__/fallback__MINGLE_LOGIN_PATH_END_7f6c9b__'); child.emit('close', 0); }); return child; };
  await readLoginPath({ env: { PATH: '/current', SHELL: '/evil/shell' }, platform: 'linux', exists: async () => true, spawn: fallback });
  assert.equal(selected, '/bin/bash');
});

test('leaves Windows PATH unchanged', async () => {
  assert.deepEqual(await readLoginPath({ env: { PATH: 'C:\\bin' }, platform: 'win32' }), { path: 'C:\\bin', warning: null });
});
