import { describe, expect, it } from 'vitest';
import type { ProviderFailure } from '@mingle/contracts';
import { providerSwitchFailureCopy } from './providerFailureUi';

const failure = (kind: ProviderFailure['kind']): ProviderFailure => ({
  id: 'failure_test', sessionId: 'session_test', runId: 'run_test', actor: 'session', kind,
  provider: 'claude', retryable: false, dispatchState: 'dispatched', continuationSafety: 'unknown',
  message: 'Provider request failed.', occurredAt: '2026-01-01T00:00:00.000Z',
});

describe('providerSwitchFailureCopy', () => {
  it('offers provider switching for quota, rate-limit and authentication failures', () => {
    expect(providerSwitchFailureCopy(failure('quota_exhausted'))).toContain('Claude is out of usage');
    expect(providerSwitchFailureCopy(failure('temporary_rate_limit'))).toContain('Claude is rate-limited');
    expect(providerSwitchFailureCopy(failure('authentication'))).toContain('Claude needs sign-in');
    expect(providerSwitchFailureCopy({ ...failure('unknown'), message: 'The provider token has expired.' })).toContain('Claude needs sign-in');
    expect(providerSwitchFailureCopy({ ...failure('unknown'), message: 'Usage limit exceeded for this account.' })).toContain('Claude is out of usage');
  });

  it('does not label unrelated failures as provider availability problems', () => {
    expect(providerSwitchFailureCopy(failure('context_exhausted'))).toBeNull();
    expect(providerSwitchFailureCopy(failure('unknown'))).toBeNull();
  });
});
