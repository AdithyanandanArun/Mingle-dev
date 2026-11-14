import { describe, expect, it } from 'vitest';
import type { Session } from '@mingle/contracts';
import { contextReading, contextTone, compactBlocker } from './ContextUsageModel';
const session = { id: 's', provider: 'codex', model: 'm', providerSessionId: 'native', status: 'idle', inputTokens: 999999 } as Session;
const reading = (usedTokens: number, contextWindow: number | null = 1000) => contextReading({ ...session,
  contextUsage: { provider: 'codex', model: 'm', providerSessionId: 'native', usedTokens, contextWindow, estimated: false, source: 'example', updatedAt: '2026-11-15T00:00:00Z' } });
describe('context thresholds', () => {
  it('changes color strictly above the requested thresholds', () => {
    expect(contextTone(70)).toBe('neutral'); expect(contextTone(70.01)).toBe('warning');
    expect(contextTone(90)).toBe('warning'); expect(contextTone(90.01)).toBe('danger');
  });
  it('keeps unknown readings distinct from a reported empty context', () => {
    expect(contextReading(session).percent).toBeNull(); expect(reading(0).percent).toBe(0);
    expect(reading(10, null).percent).toBeNull(); expect(reading(10, null).usedTokens).toBe(10);
  });
  it('clips the arc while preserving an overcapacity percentage', () => {
    expect(reading(1500)).toMatchObject({ percent: 150, fraction: 1, tone: 'danger', label: 'Context: 150.0% used' });
  });
});
