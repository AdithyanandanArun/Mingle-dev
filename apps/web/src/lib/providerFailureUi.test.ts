import { describe, expect, it } from 'vitest';
import type { ProviderFailure } from '@mingle/contracts';
import { isSafeUndispatchedTransientFailure, providerRecoveryCopy, providerRecoveryKind } from './providerFailureUi';

const failure = (kind: ProviderFailure['kind']): ProviderFailure => ({
  id: 'failure_test', sessionId: 'session_test', runId: 'run_test', actor: 'session', kind,
  provider: 'claude', retryable: false, dispatchState: 'dispatched', continuationSafety: 'unknown',
  message: 'Provider request failed.', occurredAt: '2026-01-01T00:00:00.000Z',
});

describe('provider recovery copy', () => {
  it('gives a specific action for server classified causes', () => {
    expect(providerRecoveryCopy(failure('quota_exhausted'))).toContain('usage limit');
    expect(providerRecoveryCopy(failure('temporary_rate_limit'))).toContain('rate limit');
    expect(providerRecoveryCopy(failure('authentication'))).toContain('separate from your Mingle account');
    expect(providerRecoveryCopy(failure('context_exhausted'))).toContain('context is full');
    expect(providerRecoveryCopy(failure('provider_unavailable'))).toContain('local setup');
    expect(providerRecoveryCopy({ ...failure('unknown'), providerCode: 'refusal' })).toContain('will not be retried automatically');
  });

  it('never infers a cause from display text, and does not recommend automatic retry', () => {
    expect(providerRecoveryKind({ ...failure('unknown'), message: 'Usage limit exceeded for this account.' })).toBe('unknown');
    expect(providerRecoveryCopy({ ...failure('unknown'), message: 'Please sign in and retry.' })).toContain('no specific recovery action');
    expect(providerRecoveryCopy(failure('unknown'))).toContain('Review this run');
  });

  it('requires every server safety fact and a transient classified cause', () => {
    const safe = { ...failure('temporary_rate_limit'), retryable: true, safeToRetry: true, dispatchState: 'not-dispatched' as const, outcomeUnknown: false, continuationSafety: 'safe' as const };
    expect(isSafeUndispatchedTransientFailure(safe)).toBe(true);
    for (const patch of [
      { retryable: false }, { safeToRetry: false }, { safeToRetry: undefined },
      { dispatchState: 'unknown' as const }, { outcomeUnknown: undefined },
      { outcomeUnknown: true }, { continuationSafety: 'unknown' as const },
      { continuationSafety: 'unsafe' as const }, { providerCode: 'refusal' },
    ]) expect(isSafeUndispatchedTransientFailure({ ...safe, ...patch })).toBe(false);
    for (const kind of ['authentication', 'quota_exhausted', 'context_exhausted', 'unknown'] as const) {
      expect(isSafeUndispatchedTransientFailure({ ...safe, kind })).toBe(false);
    }
  });
});
