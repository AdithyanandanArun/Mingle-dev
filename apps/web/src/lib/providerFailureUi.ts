import type { ProviderFailure } from '@mingle/contracts';
import { PROVIDER_NAMES } from './providers';

export type ProviderRecoveryKind = 'authentication' | 'quota' | 'rate-limit' | 'context' | 'unavailable' | 'refused' | 'unknown';

/** Use the server classification and code only. Display text is deliberately never used to infer safety or cause. */
export function providerRecoveryKind(failure: ProviderFailure): ProviderRecoveryKind {
  if (failure.providerCode === 'refusal') return 'refused';
  switch (failure.kind) {
    case 'authentication': return 'authentication';
    case 'quota_exhausted': return 'quota';
    case 'temporary_rate_limit': return 'rate-limit';
    case 'context_exhausted': return 'context';
    case 'provider_unavailable': return 'unavailable';
    default: return 'unknown';
  }
}

/** Strict eligibility predicate for any automatic retry caller. UI text and absent evidence never establish safety. */
export function isSafeUndispatchedTransientFailure(failure: ProviderFailure): boolean {
  const kind = providerRecoveryKind(failure);
  return (kind === 'rate-limit' || kind === 'unavailable')
    && failure.retryable === true && failure.safeToRetry === true
    && failure.dispatchState === 'not-dispatched' && failure.outcomeUnknown === false
    && failure.continuationSafety === 'safe';
}

export function providerRecoveryCopy(failure: ProviderFailure): string {
  const name = PROVIDER_NAMES[failure.provider];
  switch (providerRecoveryKind(failure)) {
    case 'authentication': return `${name} reported an authentication problem. Sign in with ${name} on this machine, then re-check provider availability in Providers settings. This is separate from your Mingle account.`;
    case 'quota': return `${name} reported a usage limit. Check provider usage or its reset time before continuing.`;
    case 'rate-limit': return `${name} reported a temporary rate limit. Wait for the reported retry time, if available, then decide whether to continue.`;
    case 'context': return `${name} reported that the conversation context is full. Review the run, then use the provider's compaction command if supported.`;
    case 'unavailable': return `${name} is currently unavailable. Check its local setup and availability before continuing.`;
    case 'refused': return `${name} refused this request. Review the provider response and revise the request yourself; it will not be retried automatically.`;
    default: return `${name} reported a failure with no specific recovery action. Review this run before deciding what to do next.`;
  }
}
