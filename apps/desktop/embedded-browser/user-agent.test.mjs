import test from 'node:test';
import assert from 'node:assert/strict';
import { stripUserAgent } from './user-agent.mjs';

test('strips Electron and app semver tokens while preserving browser identity', () => {
  assert.equal(stripUserAgent('Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Electron/44.1.0 mingle/0.0.8 Mingle/1.2.3'), 'Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36');
});
