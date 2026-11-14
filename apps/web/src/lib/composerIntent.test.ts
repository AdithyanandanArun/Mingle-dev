import { describe, expect, it } from 'vitest';
import { inferComposerIntent } from './composerIntent';

describe('inferComposerIntent', () => {
  it('routes ordinary messages normally', () => expect(inferComposerIntent('Please fix this bug').intent).toBe('normal'));
  it('strips the local plan prefix', () => expect(inferComposerIntent('/plan map the flow').content).toBe('map the flow'));
  it('recognizes explicit keep-working requests', () => expect(inferComposerIntent('Keep working until the migration is complete').intent).toBe('autonomous'));
  it('does not infer autonomy from negation', () => expect(inferComposerIntent("Don't keep working after this").intent).toBe('normal'));
  it('does not route quoted code or native commands', () => {
    expect(inferComposerIntent('`keep working`').intent).toBe('normal');
    expect(inferComposerIntent('/review keep working').intent).toBe('normal');
    expect(inferComposerIntent('$deploy keep working').intent).toBe('normal');
  });
  it('does not infer autonomy from skill mentions', () => expect(inferComposerIntent('$planner keep working').intent).toBe('normal'));
});
