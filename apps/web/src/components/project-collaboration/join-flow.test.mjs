import assert from 'node:assert/strict';
import test from 'node:test';
import { joinAgentPolicyChoices, joinSuccessCopy, resolveJoinCloneParent } from './join-flow.ts';

test('resolves the typed repository parent path instead of reusing the last Browse result', async () => {
  const calls = [];
  const resolved = { path: '/home/member/typed-location', displayPath: '/home/member/typed-location', canSelect: true, canCreateWithin: true };
  const listing = await resolveJoinCloneParent('  /home/member/typed-location  ', async (...args) => {
    calls.push(args);
    return resolved;
  });

  assert.deepEqual(calls, [['/home/member/typed-location', '', false]]);
  assert.equal(listing.path, '/home/member/typed-location');
});

test('rejects an unusable typed parent before attempting the clone', async () => {
  await assert.rejects(resolveJoinCloneParent('/home/member/not-a-folder', async () => ({
    path: '/home/member/not-a-folder', displayPath: '/home/member/not-a-folder', canSelect: false, canCreateWithin: false,
  })), /existing folder/i);
});

test('uses matching singular and plural join success copy with the Add agents next step', () => {
  assert.equal(joinSuccessCopy(1, false), '1 idle agent is ready. The project lead can now add your agent from Add agents. No model run has started.');
  assert.equal(joinSuccessCopy(2, false), '2 idle agents are ready. The project lead can now add your agents from Add agents. No model run has started.');
  assert.match(joinSuccessCopy(1, true), /remain private/);
});

test('offers each provider-supported permission mode without labelling the model count as Supervised-only', () => {
  assert.deepEqual(joinAgentPolicyChoices({ id: 'claude' }, {}), ['supervised', 'balanced']);
  assert.deepEqual(joinAgentPolicyChoices({ id: 'opencode' }, {}), ['supervised', 'balanced', 'full-access']);
  assert.deepEqual(joinAgentPolicyChoices({ id: 'claude' }, { policies: ['full-access'] }), ['full-access']);
});
