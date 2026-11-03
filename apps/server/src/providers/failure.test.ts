import { describe, expect, it } from 'vitest';
import { ProviderError } from './common.js';
import { providerFailure } from './failure.js';

const context = (dispatchState: 'not-dispatched' | 'dispatched' | 'unknown' = 'not-dispatched') => ({
  provider: 'claude' as const, sessionId: 'session-test', runId: 'run-test', actor: 'worker' as const, dispatchState,
});

describe('providerFailure', () => {
  it('classifies pre-dispatch temporary limits as retryable without treating retryability as a replay signal in other states', () => {
    const error = new ProviderError('Rate limit reached; retry later.', {
      code: 'rate_limit', providerCode: 'rate_limit_exceeded', statusCode: 429, retryAfterMs: 2_000,
    });
    const preflight = providerFailure(error, context('not-dispatched'));
    expect(preflight).toMatchObject({ kind: 'temporary_rate_limit', retryable: true, safeToRetry: true, outcomeUnknown: false, dispatchState: 'not-dispatched' });
    expect(Date.parse(preflight.retryAt!)).toBeGreaterThan(Date.now());
    expect(Date.parse(preflight.retryAt!) - Date.now()).toBeLessThanOrEqual(2_000);

    const dispatched = providerFailure(error, context('dispatched'));
    expect(dispatched).toMatchObject({ kind: 'temporary_rate_limit', retryable: true, safeToRetry: false, outcomeUnknown: true, dispatchState: 'dispatched' });
    expect(dispatched.retryAt).toEqual(expect.any(String));
  });

  it('distinguishes terminal quota exhaustion from unclassified 429 and input-token rate limits', () => {
    const quota = providerFailure(new ProviderError('Account quota exhausted.', {
      code: 'quota_exhausted', providerCode: 'usageLimitExceeded', statusCode: 429, outcomeKnown: true,
    }), context('dispatched'));
    expect(quota).toMatchObject({ kind: 'quota_exhausted', outcomeUnknown: false, retryable: false, continuationSafety: 'unknown' });
    expect(quota.quotaPool).toBeUndefined();

    const generic429 = providerFailure(new ProviderError('Request rejected.', { code: 'provider_error', statusCode: 429 }), context('unknown'));
    expect(generic429).toMatchObject({ kind: 'unknown', outcomeUnknown: true, retryable: false, dispatchState: 'unknown' });
    expect(generic429.retryAt).toBeUndefined();

    const inputLimit = providerFailure(new ProviderError('Input tokens rate limit reached.', { providerCode: 'input_tokens_rate_limit' }), context());
    expect(inputLimit.kind).toBe('temporary_rate_limit');
  });

  it('accepts only future Retry-After values bounded to 24 hours', () => {
    const accepted = providerFailure(new ProviderError('Rate limit reached.', { code: 'rate_limit', retryAfterMs: 2_500 }), context());
    expect(accepted.retryable).toBe(true);
    expect(Date.parse(accepted.retryAt!) - Date.parse(accepted.occurredAt)).toBeLessThanOrEqual(2_500);

    const tooLong = providerFailure({
      code: 'rate_limit', message: 'Rate limit reached.', retryAfterMs: 86_400_001,
    }, context());
    expect(tooLong).toMatchObject({ kind: 'temporary_rate_limit', retryable: false, safeToRetry: false, retryAt: null });

    const past = providerFailure({ code: 'rate_limit', message: 'Rate limit reached.', retryAt: '2000-01-01T00:00:00.000Z' }, context());
    expect(past).toMatchObject({ retryable: false, safeToRetry: false, retryAt: null });
  });

  it('redacts secret-shaped messages and provider codes from the durable failure record', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456';
    const failure = providerFailure(new ProviderError(`Rate limit reached for ${secret}.`, {
      code: 'rate_limit', providerCode: secret, retryAfterMs: 1_000,
    }), context());
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(failure.message).toContain('[redacted]');
    expect(failure.providerCode).not.toContain(secret);
    expect(failure.providerCode).toContain('[redacted]');
    expect(failure.providerCode!.length).toBeLessThanOrEqual(100);
  });

  it('keeps provider refusals and turn limits distinct from unknown failures', () => {
    const refusal = providerFailure(new ProviderError('OpenCode ACP: refused to continue this turn.', { code: 'refusal', outcomeKnown: true }), context('dispatched'));
    expect(refusal).toMatchObject({ kind: 'unknown', providerCode: 'refusal', outcomeUnknown: false, retryable: false });
    const turnLimit = providerFailure(new ProviderError('OpenCode stopped at its turn limit. Partial output was retained.', { code: 'turn_limit', outcomeKnown: true }), context('dispatched'));
    expect(turnLimit).toMatchObject({ kind: 'output_truncated', providerCode: 'turn_limit', retryable: false });
  });
});
