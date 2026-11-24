import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRelay } from './relay.mjs';

function fixture() {
  const sent = [], views = [];
  const relay = createRelay({ createView: async url => makeView(url), closeView: async id => { const i = views.findIndex(v => v.targetId === id); if (i >= 0) { views[i].debugger.emit('detach'); views.splice(i, 1); } }, listViews: () => views, version: '44.1', userAgent: 'Chrome test' });
  function makeView(url = 'about:blank') {
    const debuggerApi = new EventEmitter(); debuggerApi.calls = [];
    debuggerApi.sendCommand = async (...args) => { debuggerApi.calls.push(args); return { ok: true }; };
    const view = { targetId: `target${views.length}`, url: () => url, title: () => 'title', debugger: debuggerApi };
    views.push(view); return view;
  }
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1, bufferedAmount: 0, send: value => sent.push(JSON.parse(value)),
    close() { this.readyState = 3; this.emit('close'); },
    terminate() { this.close(); },
  });
  relay.attachSocket(socket);
  const call = async (method, params = {}, sessionId) => { await relay.handle(JSON.stringify({ id: sent.filter(x => x.id).length + 1, method, params, ...(sessionId ? { sessionId } : {}) })); return sent.at(-1); };
  return { relay, views, sent, call, makeView, socket };
}

test('routes browser, page and child session messages', async () => {
  const f = fixture(); const view = f.makeView();
  await f.call('Browser.getVersion'); assert.equal(f.sent.at(-1).result.product, 'Chrome/44.1');
  await f.call('Target.attachToTarget', { targetId: view.targetId }); const page = f.sent.at(-1).result.sessionId;
  await f.call('Page.enable', {}, page); assert.equal(view.debugger.calls.at(-1)[0], 'Page.enable');
  view.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: {} }, 'child-1');
  assert.equal(f.sent.at(-1).sessionId, 'child-1');
  await f.call('Runtime.evaluate', { expression: '1' }, 'child-1'); assert.equal(view.debugger.calls.at(-1)[2], 'child-1');
});
test('browser target session can attach a page session', async () => {
  const f = fixture(); const view = f.makeView();
  await f.call('Target.attachToBrowserTarget'); const browserSession = f.sent.at(-1).result.sessionId;
  await f.call('Target.attachToTarget', { targetId: view.targetId }, browserSession);
  const pageSession = f.sent.at(-1).result.sessionId;
  await f.call('Page.startScreencast', {}, pageSession);
  assert.equal(view.debugger.calls.at(-1)[0], 'Page.startScreencast');
});

test('only screencast viewers receive frames and Chromium gets one ack per frame', async () => {
  const f = fixture();
  const view = f.makeView();
  await f.call('Target.setAutoAttach', { autoAttach: true });
  const page = f.sent.find(item => item.method === 'Target.attachedToTarget').params.sessionId;
  const first = (await f.call('Target.attachToTarget', { targetId: view.targetId })).result.sessionId;
  const second = (await f.call('Target.attachToTarget', { targetId: view.targetId })).result.sessionId;
  const commands = method => view.debugger.calls.filter(call => call[0] === method);
  await f.call('Page.startScreencast', {}, first);
  await f.call('Page.startScreencast', {}, second);
  assert.equal(commands('Page.startScreencast').length, 1);
  assert.equal(commands('Page.startScreencast')[0][1].maxFramesInFlight, 1);
  const frame = () => {
    const start = f.sent.length;
    view.debugger.emit('message', {}, 'Page.screencastFrame', { sessionId: 9, data: 'a' });
    return f.sent.slice(start);
  };
  const delivered = frame();
  assert.deepEqual(delivered.map(message => message.sessionId), [first, second]);
  const ack = delivered[0].params.sessionId;
  await f.call('Page.screencastFrameAck', { sessionId: ack }, page);
  await f.call('Page.screencastFrameAck', { sessionId: ack }, first);
  await f.call('Page.screencastFrameAck', { sessionId: ack }, first);
  assert.equal(commands('Page.screencastFrameAck').length, 0);
  await f.call('Page.screencastFrameAck', { sessionId: ack }, second);
  assert.deepEqual(commands('Page.screencastFrameAck'), [['Page.screencastFrameAck', { sessionId: 9 }]]);
  const newer = frame()[0].params.sessionId;
  assert.notEqual(newer, ack);
  await f.call('Page.screencastFrameAck', { sessionId: ack }, first);
  await f.call('Target.detachFromTarget', { sessionId: second });
  assert.equal(commands('Page.screencastFrameAck').length, 1);
  await f.call('Page.screencastFrameAck', { sessionId: newer }, first);
  assert.equal(commands('Page.screencastFrameAck').length, 2);
  await f.call('Page.stopScreencast', {}, first);
  assert.equal(commands('Page.stopScreencast').length, 1);
  assert.deepEqual(frame(), []);
});

test('a backed-up relay disconnects and stops its screencasts', async () => {
  const f = fixture();
  const view = f.makeView();
  const viewer = (await f.call('Target.attachToTarget', { targetId: view.targetId })).result.sessionId;
  await f.call('Page.startScreencast', {}, viewer);
  f.socket.bufferedAmount = 5 * 1024 * 1024;
  const before = f.sent.length;
  view.debugger.emit('message', {}, 'Page.screencastFrame', { sessionId: 9, data: 'a' });
  assert.equal(f.sent.length, before);
  assert.equal(f.socket.readyState, 3);
  assert.equal(view.debugger.calls.at(-1)[0], 'Page.stopScreencast');
});

test('console object bursts are cleared per debugger target', async () => {
  const f = fixture();
  const view = f.makeView();
  await f.call('Target.attachToTarget', { targetId: view.targetId });
  const emit = (value, target = '') => view.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { args: [value] }, target);
  const object = { objectId: 'example' };
  for (let i = 0; i < 40; i++) emit({ value: 'Example console text' });
  for (let i = 0; i < 31; i++) emit(object);
  emit(object, 'child-1');
  assert.deepEqual(view.debugger.calls, []);
  for (let i = 0; i < 95; i++) emit(object);
  assert.deepEqual(view.debugger.calls, [['Runtime.releaseObjectGroup', { objectGroup: 'console' }]]);
  for (let i = 0; i < 31; i++) emit(object, 'child-1');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.filter(item => item.method === 'Runtime.consoleAPICalled').length, 40);
  const cleared = view.debugger.calls.filter(([method]) => method === 'Runtime.discardConsoleEntries');
  assert.deepEqual(cleared, [
    ['Runtime.discardConsoleEntries', {}],
    ['Runtime.discardConsoleEntries', {}, 'child-1'],
    ['Runtime.discardConsoleEntries', {}],
  ]);
});
test('multiple explicit page sessions are independent when one detaches', async () => {
  const f = fixture(); const view = f.makeView();
  await f.call('Target.attachToTarget', { targetId: view.targetId }); const first = f.sent.at(-1).result.sessionId;
  await f.call('Target.attachToTarget', { targetId: view.targetId }); const second = f.sent.at(-1).result.sessionId;
  assert.notEqual(first, second);

  await f.call('Target.detachFromTarget', { sessionId: first });
  await f.call('Page.navigate', { url: 'https://example.com' }, second);
  assert.equal(view.debugger.calls.at(-1)[0], 'Page.navigate');
  view.debugger.emit('message', {}, 'Page.loadEventFired', { timestamp: 1 });
  assert.ok(f.sent.some(item => item.method === 'Page.loadEventFired' && item.sessionId === second));
  assert.equal(f.sent.some(item => item.method === 'Page.loadEventFired' && item.sessionId === first), false);
});
test('detaching an explicit session reports on its browser parent only', async () => {
  const f = fixture(); const view = f.makeView();
  await f.call('Target.attachToTarget', { targetId: view.targetId }); const retained = f.sent.at(-1).result.sessionId;
  await f.call('Target.attachToBrowserTarget'); const browserSession = f.sent.at(-1).result.sessionId;
  await f.call('Target.attachToTarget', { targetId: view.targetId }, browserSession); const detached = f.sent.at(-1).result.sessionId;
  await f.call('Target.detachFromTarget', { sessionId: detached }, browserSession);
  const notification = f.sent.find(item => item.method === 'Target.detachedFromTarget' && item.params.sessionId === detached);
  assert.equal(notification.sessionId, browserSession);
  await f.call('Page.navigate', { url: 'data:text/html,ok' }, retained);
  assert.equal(view.debugger.calls.at(-1)[0], 'Page.navigate');
});
test('auto attach announces targets created later', async () => {
  const f = fixture(); await f.call('Target.setAutoAttach', { autoAttach: true });
  const created = await f.call('Target.createTarget', { url: 'https://example.com' });
  assert.equal(created.result.targetId, 'target0'); assert.ok(f.sent.some(item => item.method === 'Target.attachedToTarget'));
});
test('unknown method returns supported error', async () => {
  const f = fixture();
  const err = await f.call('Target.createBrowserContext'); assert.match(err.error.message, /Not supported/);
});
test('CDP input timestamps are left to Chromium and attribution is scoped to dispatch', async () => {
  const f = fixture(); const view = f.makeView();
  await f.call('Target.attachToTarget', { targetId: view.targetId }); const sid = f.sent.at(-1).result.sessionId;
  const trace = [];
  view.beginSyntheticInput = (method, params) => {
    trace.push(['begin', method, params]);
    return () => trace.push(['end', method]);
  };
  view.debugger.sendCommand = async (method, params) => {
    trace.push(['dispatch', method, params]);
    if (method === 'Input.dispatchTouchEvent') throw new Error('target closed during input');
  };
  for (const method of ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.dispatchTouchEvent']) {
    const params = { type: 'fixture' };
    await f.call(method, params, sid);
    assert.deepEqual(trace.splice(0), [['begin', method, params], ['dispatch', method, params], ['end', method]]);
  }
});
test('detach event is forwarded', async () => {
  const f = fixture(); const view = f.makeView(); await f.call('Target.setDiscoverTargets', { discover: true });
  await f.call('Target.attachToTarget', { targetId: view.targetId }); view.debugger.emit('detach');
  assert.ok(f.sent.some(item => item.method === 'Target.targetDestroyed'));
  assert.ok(f.sent.some(item => item.method === 'Target.detachedFromTarget'));
  assert.equal(view.debugger.listenerCount('message'), 0);
  assert.equal(view.debugger.listenerCount('detach'), 0);
  f.relay.onViewClosed(view);
  assert.equal(f.sent.filter(item => item.method === 'Target.targetDestroyed').length, 1);
});

test('delegates browser cookie storage calls', async () => {
  const cookies = [{ name: 'a', value: 'b' }]; let set = null; let cleared = false;
  const sent = [];
  const relay = createRelay({ createView: async () => {}, closeView: async () => {}, listViews: () => [], version: '1', userAgent: 'ua',
    getCookies: async () => cookies, setCookies: async value => { set = value; }, clearCookies: async () => { cleared = true; } });
  relay.attachSocket({ readyState: 1, send: value => sent.push(JSON.parse(value)), on() {}, close() {} });
  const call = async (id, method, params = {}) => { await relay.handle(JSON.stringify({ id, method, params })); return sent.at(-1); };
  assert.deepEqual((await call(1, 'Storage.getCookies')).result.cookies, cookies);
  await call(2, 'Storage.setCookies', { cookies }); assert.deepEqual(set, cookies);
  await call(3, 'Storage.clearCookies'); assert.equal(cleared, true);
});
