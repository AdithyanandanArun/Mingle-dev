import assert from 'node:assert/strict';
import test from 'node:test';
import { initialConsentPermissionLevel, initialConsentSessionIds, sharedAgentCountLabel } from './team-consent-flow.ts';

test('preselects join-selected agents and preserves an existing selection', () => {
  assert.deepEqual(initialConsentSessionIds(['join-agent'], ['previous-agent'], ['local-agent']), ['join-agent']);
  assert.deepEqual(initialConsentSessionIds(undefined, ['previous-agent'], ['local-agent']), ['previous-agent']);
});

test('preselects a sole local agent and leaves multi-agent consent choices explicit', () => {
  assert.deepEqual(initialConsentSessionIds(undefined, [], ['only-agent']), ['only-agent']);
  assert.deepEqual(initialConsentSessionIds(undefined, [], ['first-agent', 'second-agent']), []);
});

test('preserves only a currently valid granted permission level', () => {
  const grantedFullAccess = { state: 'granted', permissionLevel: 'full-access', settingsVersion: 12, disclaimerVersion: '3' };
  assert.equal(initialConsentPermissionLevel(grantedFullAccess, '3'), 'full-access');
  assert.equal(initialConsentPermissionLevel({ ...grantedFullAccess, permissionLevel: 'supervised' }, '3'), 'supervised');
  assert.equal(initialConsentPermissionLevel({ ...grantedFullAccess, settingsVersion: 11 }, '3'), 'full-access');
  assert.equal(initialConsentPermissionLevel({ ...grantedFullAccess, disclaimerVersion: '2' }, '3'), 'supervised');
  assert.equal(initialConsentPermissionLevel({ ...grantedFullAccess, state: 'needs-reconsent' }, '3'), 'supervised');
  assert.equal(initialConsentPermissionLevel(null, '3'), 'supervised');
});

test('pluralizes one-agent and multiple-agent sharing status', () => {
  assert.equal(sharedAgentCountLabel(1, 'shared', 'Full access'), 'Your 1 agent is shared · Full access');
  assert.equal(sharedAgentCountLabel(1, 'paused', 'Supervised'), 'Your 1 agent is paused · Supervised');
  assert.equal(sharedAgentCountLabel(2, 'shared', 'Full access'), 'Your 2 agents are shared · Full access');
});
