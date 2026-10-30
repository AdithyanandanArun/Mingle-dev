import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEmbeddedBrowserHost } from './host.mjs';

function fakeElectron() {
  const ipcMain = new EventEmitter();
  const session = { fromPartition() { return { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, getUserAgent: () => 'Mozilla/5.0 Chrome/120.0.0.0 Electron/44.0.0' , setUserAgent() {} }; } };
  return { ipcMain, session, app: { getVersion: () => '0.0.8' }, BrowserWindow: class { constructor() { this.contentView = { addChildView() {} }; } isDestroyed() { return false; } destroy() {} } };
}

test('HTTP host requires token, rejects Origin and invalid session ids', async () => {
  const host = createEmbeddedBrowserHost({ electron: fakeElectron(), ws: { WebSocketServer: class { close() {} } } });
  try {
    const base = await host.ready;
    const missing = await fetch(`${base}/sessions/good/browser`, { method: 'POST' }); assert.equal(missing.status, 401);
    const wrong = await fetch(`${base}/sessions/good/browser`, { method: 'POST', headers: { authorization: 'Bearer wrong' } }); assert.equal(wrong.status, 401);
    const origin = await fetch(`${base}/sessions/good/browser`, { method: 'POST', headers: { authorization: `Bearer ${host.token}`, origin: 'http://localhost' } }); assert.equal(origin.status, 403);
    const badId = await fetch(`${base}/sessions/%2Fbad/browser`, { method: 'POST', headers: { authorization: `Bearer ${host.token}` } }); assert.equal(badId.status, 400);
    const good = await fetch(`${base}/sessions/valid_1/browser`, { method: 'POST', headers: { authorization: `Bearer ${host.token}` } }); assert.equal(good.status, 200); assert.match((await good.json()).wsUrl, /^ws:\/\/127\.0\.0\.1:/);
  } finally { await host.dispose(); }
});
