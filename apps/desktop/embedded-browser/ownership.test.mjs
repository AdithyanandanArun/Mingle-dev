import test from 'node:test';
import assert from 'node:assert/strict';
import { hideOwnedEmbeddedView } from './host.mjs';

test('late hide from former window cannot park a view now owned by the popout', () => {
  const main = { name: 'main' };
  const popout = { name: 'popout' };
  const view = { parentWindow: popout };
  const parked = [];
  assert.equal(hideOwnedEmbeddedView(main, view, item => parked.push(item)), false);
  assert.deepEqual(parked, []);
  assert.equal(view.parentWindow, popout);
});

test('current owner can still park its embedded view', () => {
  const owner = { name: 'main' };
  const view = { parentWindow: owner };
  const parked = [];
  assert.equal(hideOwnedEmbeddedView(owner, view, item => { parked.push(item); item.parentWindow = { name: 'parking' }; }), true);
  assert.deepEqual(parked, [view]);
});
