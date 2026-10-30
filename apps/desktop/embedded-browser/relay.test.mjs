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
    const view = { targetId: `target${views.length}`, url: () => url, title: () => 'title', debugger: debuggerApi, marks: 0, markAgentInput() { this.marks++; } };
    views.push(view); return view;
  }
  relay.attachSocket({ readyState: 1, send: value => sent.push(JSON.parse(value)), on() {}, close() {} });
  const call = async (method, params = {}, sessionId) => { await relay.handle(JSON.stringify({ id: sent.filter(x => x.id).length + 1, method, params, ...(sessionId ? { sessionId } : {}) })); return sent.at(-1); };
  return { relay, views, sent, call, makeView };
}

test('routes browser, page and child session messages', async () => {
  const f = fixture(); const view = f.makeView();
  await f.call('Browser.getVersion'); assert.equal(f.sent.at(-1).result.product, 'Chrome/44.1');
  await f.call('Target.attachToTarget', { targetId: view.targetId }); const page = f.sent.at(-1).result.sessionId;
  await f.call('Page.enable', {}, page); assert.equal(view.debugger.calls.at(-1)[0], 'Page.enable');
  view.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: {} }, 'child-1');
  await f.call('Runtime.evaluate', { expression: '1' }, 'child-1'); assert.equal(view.debugger.calls.at(-1)[2], 'child-1');
});
test('auto attach announces targets created later', async () => {
  const f = fixture(); await f.call('Target.setAutoAttach', { autoAttach: true });
  const created = await f.call('Target.createTarget', { url: 'https://example.com' });
  assert.equal(created.result.targetId, 'target0'); assert.ok(f.sent.some(item => item.method === 'Target.attachedToTarget'));
});
test('unknown method returns supported error; agent input is marked', async () => {
  const f = fixture(); const view = f.makeView();
  const err = await f.call('Target.createBrowserContext'); assert.match(err.error.message, /Not supported/);
  await f.call('Target.attachToTarget', { targetId: view.targetId }); const sid = f.sent.at(-1).result.sessionId;
  await f.call('Input.dispatchMouseEvent', {}, sid); assert.equal(view.marks, 1);
});
test('detach event is forwarded', async () => {
  const f = fixture(); const view = f.makeView(); await f.call('Target.setDiscoverTargets', { discover: true });
  await f.call('Target.attachToTarget', { targetId: view.targetId }); view.debugger.emit('detach');
  assert.ok(f.sent.some(item => item.method === 'Target.targetDestroyed'));
  assert.ok(f.sent.some(item => item.method === 'Target.detachedFromTarget'));
});
