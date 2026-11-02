import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { claudeModelsFromSdk } from './capabilities.js';

const sdkModels = (items: unknown[]) => claudeModelsFromSdk(items as ModelInfo[]);

describe('Claude model metadata mapping', () => {
  it('preserves exact newly advertised model and effort identifiers', () => {
    expect(sdkModels([{ value: 'claude-haiku-5-5-20261101', displayName: 'Claude Haiku 5.5', supportedEffortLevels: ['low', 'ultra'], supportsEffort: true }])).toEqual([
      expect.objectContaining({
        id: 'claude-haiku-5-5-20261101', name: 'Claude Haiku 5.5',
        reasoningEfforts: [{ id: 'low', label: 'low' }, { id: 'ultra', label: 'ultra' }],
      }),
    ]);
  });

  it('does not invent effort choices when effort metadata is missing', () => {
    const [model] = sdkModels([{ value: 'claude-future-model', displayName: 'Future model' }]);
    expect(model).toBeDefined();
    expect(model).not.toHaveProperty('reasoningEfforts');
  });

  it('keeps an explicitly empty native effort list distinct from missing metadata', () => {
    const [empty, missing] = sdkModels([
      { value: 'claude-no-effort', supportedEffortLevels: [], supportsEffort: true },
      { value: 'claude-unreported' },
    ]);
    expect(empty?.reasoningEfforts).toEqual([]);
    expect(missing).not.toHaveProperty('reasoningEfforts');
  });

  it('omits invalid and excess metadata instead of exposing unbounded choices', () => {
    const efforts = Array.from({ length: 40 }, (_, index) => `effort_${index}`);
    efforts[0] = 'Invalid';
    const [model] = sdkModels([{ value: 'claude-bounded', supportedEffortLevels: efforts, supportsEffort: true }]);
    expect(model?.reasoningEfforts).toHaveLength(32);
    expect(model?.reasoningEfforts?.some((effort) => effort.id === 'Invalid')).toBe(false);
    expect(sdkModels([{ value: '' }, { value: '   ' }, { value: 42 }])).toEqual([]);
  });
});
