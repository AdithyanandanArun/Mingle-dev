import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEmbeddedBrowserHost, cdpCookieToElectron, electronCookieToCdp } from './host.mjs';

function fakeElectron() {
  const ipcMain = new EventEmitter();
  const session = { fromPartition() { return { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, getUserAgent: () => 'Mozilla/5.0 Chrome/120.0.0.0 Electron/44.0.0' , setUserAgent() {} }; } };
  return { ipcMain, session, app: { getVersion: () => '0.0.8' }, BrowserWindow: class { constructor() { this.contentView = { addChildView() {}, removeChildView() {} }; } static getAllWindows() { return []; } isDestroyed() { return false; } destroy() {} } };
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

test('authenticated presentation route tracks exact presented target and fails closed', async () => {
  const host = createEmbeddedBrowserHost({ electron: fakeElectron(), ws: { WebSocketServer: class { close() {} } } });
  try {
    const base = await host.ready;
    const headers = { authorization: `Bearer ${host.token}` };
    const get = async (sessionId, targetId, extraHeaders = {}) => fetch(`${base}/sessions/${sessionId}/browser/targets/${targetId}/presentation`, { headers: { ...headers, ...extraHeaders } });
    assert.deepEqual(await (await get('unknown', 'target')).json(), { visible: false });
    await fetch(`${base}/sessions/present_1/browser`, { method: 'POST', headers });
    const state = host.getSession('present_1');
    const contents = { isDestroyed: () => false };
    const window = { isDestroyed: () => false, contentView: { addChildView() {}, removeChildView() {} } };
    const view = { webContents: contents, parentWindow: null, setBounds() {} };
    state.views.set('target_1', { targetId: 'target_1', webContentsView: view });
    assert.deepEqual(await (await get('present_1', 'missing')).json(), { visible: false });
    assert.deepEqual(await (await get('present_1', 'target_1')).json(), { visible: false });
    assert.equal(host.setPresented('present_1', 'target_1', window, view, { x: 0, y: 0, width: 10, height: 10 }), true);
    assert.deepEqual(await (await get('present_1', 'target_1')).json(), { visible: true });
    host.park(view);
    assert.deepEqual(await (await get('present_1', 'target_1')).json(), { visible: false });
    assert.equal(host.setPresented('present_1', 'target_1', window, view, { x: 0, y: 0, width: 10, height: 10 }), true);
    contents.isDestroyed = () => true;
    assert.deepEqual(await (await get('present_1', 'target_1')).json(), { visible: false });
    assert.equal((await get('present_1', 'target_1', { origin: 'http://localhost' })).status, 403);
  } finally { await host.dispose(); }
});

test('converts Electron and CDP cookie fields', () => {
  const electron = cdpCookieToElectron({ name: 'sid', value: 'x', domain: '.example.com', path: '/', secure: true, httpOnly: true, expires: 123, sameSite: 'Strict' });
  assert.deepEqual(electron, { url: 'https://example.com/', name: 'sid', value: 'x', path: '/', domain: '.example.com', secure: true, httpOnly: true, expirationDate: 123, sameSite: 'strict' });
  assert.deepEqual(electronCookieToCdp(electron), { name: 'sid', value: 'x', domain: '.example.com', path: '/', expires: 123, httpOnly: true, secure: true, sameSite: 'Strict' });
  assert.equal(cdpCookieToElectron({ name: 'session', value: 'v', domain: 'example.com', path: '/', expires: -1 }).expirationDate, undefined);
});

test('CDP host-only and __Host- cookies preserve host scope and secure URL semantics', () => {
  const hostOnly = cdpCookieToElectron({ name: 'sid', value: 'fake', domain: 'login.example.test', path: '/auth', secure: false });
  assert.deepEqual(hostOnly, { url: 'http://login.example.test/auth', name: 'sid', value: 'fake', path: '/auth', secure: false, httpOnly: false });
  const prefixed = cdpCookieToElectron({ name: '__Host-session', value: 'fake', domain: '.login.example.test', path: '/', secure: true, httpOnly: true });
  assert.deepEqual(prefixed, { url: 'https://login.example.test/', name: '__Host-session', value: 'fake', path: '/', secure: true, httpOnly: true });
  assert.deepEqual(electronCookieToCdp(prefixed), { name: '__Host-session', value: 'fake', domain: undefined, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: undefined });
});

test('native trusted input timestamps remain eligible immediately after an agent call', () => {
  const host = createEmbeddedBrowserHost({ electron: fakeElectron(), ws: { WebSocketServer: class { close() {} } } });
  try {
    assert.equal(host.isHumanInputEvent({ isTrusted: true, timeStamp: 42 }), true);
    assert.equal(host.isHumanInputEvent({ isTrusted: true, timeStamp: 0 }), false);
    assert.equal(host.isHumanInputEvent({ isTrusted: true, timeStamp: -1 }), false);
    assert.equal(host.isHumanInputEvent({ isTrusted: false, timeStamp: 42 }), false);
    assert.equal(host.isHumanInputEvent({ isTrusted: true, timeStamp: Number.NaN }), false);
  } finally { void host.dispose(); }
});
