import { describe, expect, it } from 'vitest';
import type { Session } from '@mingle/contracts';
import { contextReading, contextTone, compactBlocker } from './ContextUsageModel';
const session = { id: 's', provider: 'codex', model: 'm', providerSessionId: 'native', status: 'idle', inputTokens: 999999 } as Session;
const reading = (usedTokens: number, contextWindow: number | null = 1000) => contextReading({ ...session,
  contextUsage: { provider: 'codex', model: 'm', providerSessionId: 'native', usedTokens, contextWindow, estimated: false, source: 'example', updatedAt: '2026-11-15T00:00:00Z' } });
describe('context thresholds', () => {
  it('rejects readings from a different provider, model or native conversation', () => {
    const valid = { ...session, contextUsage: { provider: session.provider, model: session.model, providerSessionId: session.providerSessionId, usedTokens: 750, contextWindow: 1000, estimated: true, source: 'example', updatedAt: '2026-11-15T00:00:00Z' } };
    for (const patch of [{ model: 'other' }, { providerSessionId: 'other' }, { provider: 'claude' as const }]) {
      expect(contextReading({ ...valid, contextUsage: { ...valid.contextUsage, ...patch } }).percent).toBeNull();
    }
    expect(contextReading(valid).label).toContain('Estimated');
  });
  it('does not render malformed counts as a percentage', () => {
    for (const tokens of [NaN, Infinity, -1, .1, Number.MAX_SAFE_INTEGER + 1]) expect(reading(tokens).percent).toBeNull();
    for (const capacity of [NaN, Infinity, -1, 0, .1]) expect(reading(10, capacity).percent).toBeNull();
  });
  it('disables native compaction until the selected conversation is available', () => {
    expect(compactBlocker(null, false)).toContain('Select one');
    expect(compactBlocker({ ...session, providerSessionId: null }, false)).toContain('Start a conversation');
    expect(compactBlocker({ ...session, status: 'running' }, false)).toContain('Wait');
    expect(compactBlocker({ ...session, provider: 'antigravity' }, false)).toContain('does not support');
    expect(compactBlocker(session, true, 'Offline')).toBe('Offline');
    expect(compactBlocker(session, false)).toBeNull();
  });
  it('changes color strictly above the requested thresholds', () => {
    expect(contextTone(70)).toBe('neutral'); expect(contextTone(70.01)).toBe('warning');
    expect(contextTone(90)).toBe('warning'); expect(contextTone(90.01)).toBe('danger');
  });
  it('keeps unknown readings distinct from a reported empty context', () => {
    expect(contextReading(session).percent).toBeNull(); expect(reading(0).percent).toBe(0);
    expect(reading(10, null).percent).toBeNull(); expect(reading(10, null)).toMatchObject({ usedTokens: 10, label: 'Context capacity unreported' });
  });
  it('clips the arc while preserving an overcapacity percentage', () => {
    expect(reading(1500)).toMatchObject({ percent: 150, fraction: 1, tone: 'danger', label: 'Context: 150.0% used' });
  });
});
