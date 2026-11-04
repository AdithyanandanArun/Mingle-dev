import { afterEach, expect, it } from 'vitest';
import { clearUsageResetAttempt, loadUsageResetAttempt, saveUsageResetAttempt } from './usageResetAttempt';

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
};
const input = { idempotencyKey: '28ab9f88-1050-4ae6-a68c-a22b9138140a', snapshotToken: 'opaque-lease', creditId: 'earned-1' };
afterEach(() => {
  for (const provider of ['codex', 'claude'] as const) {
    const saved = loadUsageResetAttempt(provider, storage);
    if (saved) clearUsageResetAttempt(provider, saved.idempotencyKey, storage);
  }
  values.clear();
});

it('retains an exact retry identity through remount and clears only the confirmed logical action', () => {
  saveUsageResetAttempt('codex', input, storage);
  expect(loadUsageResetAttempt('codex', { ...storage })).toEqual(input);
  clearUsageResetAttempt('codex', 'another-action', storage);
  expect(loadUsageResetAttempt('codex', storage)).toEqual(input);
  clearUsageResetAttempt('codex', input.idempotencyKey, storage);
  expect(loadUsageResetAttempt('codex', storage)).toBeNull();
});

it('validates bounded opaque inputs and never accepts credential-shaped extra fields', () => {
  expect(() => saveUsageResetAttempt('codex', { ...input, snapshotToken: 'x'.repeat(201) }, storage)).toThrow();
  values.set('mingle:pending-usage-reset:codex', JSON.stringify({ ...input, accessToken: 'not-a-supported-field' }));
  expect(loadUsageResetAttempt('codex', storage)).toBeNull();
  expect(values.size).toBe(0);
});

it('keeps retry identity in this window when browser storage becomes unavailable', () => {
  const unavailable = { getItem: () => { throw new Error('disabled'); }, setItem: () => { throw new Error('disabled'); }, removeItem: () => { throw new Error('disabled'); } };
  saveUsageResetAttempt('codex', input, unavailable);
  expect(loadUsageResetAttempt('codex', unavailable)).toEqual(input);
  clearUsageResetAttempt('codex', input.idempotencyKey, unavailable);
  expect(loadUsageResetAttempt('codex', unavailable)).toBeNull();
});
