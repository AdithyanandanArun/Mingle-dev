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
  it('keeps native commands, quoted requests and incidental mode words as chat', () => {
    for (const input of ['/review plan this', '"keep working until done"', '> Plan the release', 'Explain autonomous systems', 'The plan is stored here']) expect(inferComposerIntent(input).intent).toBe('normal');
  });
  it('recognizes natural planning requests without changing their text', () => {
    for (const input of ['Plan the migration', 'Please create a plan for this change', 'Help me plan the release', 'Just plan the next step']) expect(inferComposerIntent(input)).toEqual({ intent: 'plan', content: input });
  });
  it('honors a negative autonomy directive even after a keep-working prefix', () => {
    expect(inferComposerIntent('Keep working on the explanation, but do not run autonomously').intent).toBe('normal');
  });
});
