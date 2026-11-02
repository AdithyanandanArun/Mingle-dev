import { describe, expect, it } from 'vitest';
import { reasoningEffortChoices } from './providers';

describe('provider effort controls', () => {
  it('offers only the native default when capabilities are unreported, so saved settings can clear an old override', () => {
    expect(reasoningEffortChoices(undefined)).toEqual([{ id: 'none', label: 'Native/default', description: expect.stringContaining('unreported') }]);
  });

  it('preserves new provider-reported effort IDs without adding a fixed list', () => {
    const choices = [{ id: 'future_effort', label: 'Future effort' }];
    expect(reasoningEffortChoices({ id: 'new-model', name: 'New model', reasoningEfforts: choices })).toEqual(choices);
  });

  it('distinguishes an explicitly absent effort control from missing metadata', () => {
    expect(reasoningEffortChoices({ id: 'no-effort', name: 'No effort', reasoningEfforts: [] })[0]).toMatchObject({ id: 'none', description: 'This model reports no effort control.' });
  });
});
