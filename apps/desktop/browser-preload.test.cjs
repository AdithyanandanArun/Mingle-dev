const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const preloadSource = readFileSync(join(__dirname, 'browser-preload.cjs'), 'utf8');

function loadPreload() {
  const ipcListeners = new Map();
  const exposed = new Map();
  const ipcRenderer = {
    on(channel, listener) { ipcListeners.set(channel, listener); },
    invoke() { return Promise.resolve(false); },
  };
  const contextBridge = { exposeInMainWorld(name, value) { exposed.set(name, value); } };
  const sandboxBuffer = {
    from(value, encoding) {
      if (encoding === 'base64url') throw new TypeError('Unknown encoding: base64url');
      return Buffer.from(value, encoding);
    },
  };
  vm.runInNewContext(preloadSource, {
    Buffer: sandboxBuffer,
    require: name => name === 'electron' ? { contextBridge, ipcRenderer } : assert.fail(`Unexpected import: ${name}`),
  }, { filename: 'browser-preload.cjs' });
  return {
    exposed,
    emit: (token) => ipcListeners.get('mingle.project-invitation')({}, token),
  };
}

test('sandboxed preload queues valid invitations with a Buffer shim lacking base64url support', () => {
  const { exposed, emit } = loadPreload();
  const api = exposed.get('mingleProjectInvitations');
  assert.deepEqual([...Object.keys(api)], ['onInvitation']);
  assert.equal('ipcRenderer' in api, false);

  const firstToken = Buffer.alloc(32, 1).toString('base64url');
  emit(firstToken);
  emit(firstToken); // A duplicate is coalesced while no UI listener exists.
  emit('not-an-invitation-token');
  emit('A'.repeat(42)); // Below the server contract's minimum length.
  emit('A'.repeat(45)); // Invalid base64url length.
  emit(null);

  const received = [];
  const unsubscribe = api.onInvitation(value => received.push(value));
  assert.deepEqual(received, [firstToken]);
  const liveToken = Buffer.alloc(32, 2).toString('base64url');
  emit(liveToken);
  assert.deepEqual(received, [firstToken, liveToken]);

  unsubscribe();
  const queuedAfterUnsubscribe = Buffer.alloc(32, 3).toString('base64url');
  emit(queuedAfterUnsubscribe);
  const laterReceived = [];
  api.onInvitation(value => laterReceived.push(value));
  assert.deepEqual(laterReceived, [queuedAfterUnsubscribe]);
});

test('preload invitation queue is bounded to unique pending tokens', () => {
  const { exposed, emit } = loadPreload();
  const api = exposed.get('mingleProjectInvitations');
  const expected = Array.from({ length: 16 }, (_, index) => Buffer.alloc(32, index).toString('base64url'));
  for (const token of expected) emit(token);
  for (let count = 0; count < 100; count++) emit(expected[0]);
  emit(Buffer.alloc(32, 99).toString('base64url'));

  const received = [];
  api.onInvitation(token => received.push(token));
  assert.deepEqual(received, expected);
});
