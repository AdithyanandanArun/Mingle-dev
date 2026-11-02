import { describe, expect, it } from 'vitest';
import type { ProviderInfo } from '@mingle/contracts';
import { resolveRunConfig } from './session-config.js';

const base = { provider: 'claude' as const, model: 'claude-custom-id', effort: 'high', policy: 'balanced' as const };
const info = (reasoningEfforts?: { id: string; label: string }[]): ProviderInfo => ({
  id: 'claude', name: 'Claude', available: true, version: 'test', executable: '/fake/claude', reason: null,
  models: [{ id: base.model, name: base.model, ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}) }],
});

describe('resolveRunConfig model metadata', () => {
  it('uses native default for missing effort metadata instead of inventing choices', () => {
    expect(resolveRunConfig(info(), base).effort).toBe('none');
  });

  it('uses native default for an explicitly empty effort list', () => {
    expect(resolveRunConfig(info([]), base).effort).toBe('none');
  });

  it('preserves a safe native effort ID advertised by the selected model', () => {
    expect(resolveRunConfig(info([{ id: 'ultra', label: 'Ultra' }]), base).effort).toBe('ultra');
  });

  it('rejects an explicit effort that the selected model did not advertise', () => {
    expect(() => resolveRunConfig(info([{ id: 'ultra', label: 'Ultra' }]), base, { effort: true })).toThrow(/not supported/);
  });
});
