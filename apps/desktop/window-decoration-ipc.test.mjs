import assert from 'node:assert/strict';
import test from 'node:test';
import { registerWindowDecorationIpc } from './window-decoration-ipc.mjs';

function fixture() {
  const handlers = new Map();
  const mainFrame = {};
  const sender = { mainFrame };
  const event = { sender, senderFrame: mainFrame };
  const state = { supported: true, titleBar: 'system', activeTitleBar: 'system', restartRequired: false };
  const writes = [];
  const preference = { getState: () => state, setTitleBar: async value => { writes.push(value); return { ...state, titleBar: value }; } };
  registerWindowDecorationIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, preference,
    isAllowed: e => e.sender === sender && e.senderFrame === mainFrame,
  });
  return { handlers, event, state, writes, preference };
}

test('decoration IPC excludes guest frames and unrelated windows', async () => {
  const f = fixture();
  for (const event of [{ sender: f.event.sender, senderFrame: {} }, { sender: {}, senderFrame: {} }]) {
    assert.equal(f.handlers.get('mingle.window-decoration.state')(event), null);
    assert.equal(await f.handlers.get('mingle.window-decoration.set')(event, 'hidden'), null);
  }
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.handlers.get('mingle.window-decoration.state')(f.event), f.state);
  assert.equal((await f.handlers.get('mingle.window-decoration.set')(f.event, 'hidden')).titleBar, 'hidden');
  assert.deepEqual(f.writes, ['hidden']);
});

test('decoration IPC validates choices and sanitizes asynchronous filesystem failures', async () => {
  const f = fixture();
  await assert.rejects(f.handlers.get('mingle.window-decoration.set')(f.event, 'arbitrary'), /Invalid title bar/);
  assert.deepEqual(f.writes, []);
  f.preference.setTitleBar = async () => { throw new Error('private filesystem path'); };
  await assert.rejects(f.handlers.get('mingle.window-decoration.set')(f.event, 'hidden'), error => {
    assert.equal(error.message, 'Could not save the title bar choice.');
    return true;
  });
});
