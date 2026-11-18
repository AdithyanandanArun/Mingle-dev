import { describe, expect, it } from 'vitest';
import { activityEventInScope, activityMatchesSearch } from './activityView';

describe('activity view helpers', () => {
  it('keeps project events out of a different or unknown project scope', () => {
    expect(activityEventInScope('p1', 'p1', false)).toBe(true);
    expect(activityEventInScope('p2', 'p1', false)).toBe(false);
    expect(activityEventInScope(null, 'p1', false)).toBe(false);
    expect(activityEventInScope(null, undefined, true)).toBe(true);
  });

  it('searches case-insensitively across available timeline fields', () => {
    expect(activityMatchesSearch(' FAILED ', 'Run failed', 'run.failed')).toBe(true);
    expect(activityMatchesSearch('missing', 'Run failed', undefined)).toBe(false);
    expect(activityMatchesSearch('   ', 'anything')).toBe(true);
  });
});
