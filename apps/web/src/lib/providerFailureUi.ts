import type { ProviderFailure } from '@mingle/contracts';
import { PROVIDER_NAMES } from './providers';

/** Copy for failures where changing provider is a useful way to continue the session. */
export function providerSwitchFailureCopy(failure: ProviderFailure): string | null {
  const name = PROVIDER_NAMES[failure.provider];
  const detail = failure.message.toLowerCase();
  if (failure.kind === 'quota_exhausted' || /(?:insufficient quota|quota (?:is )?(?:exhausted|exceeded)|usage limit (?:reached|exceeded)|billing hard limit)/.test(detail)) {
    return `${name} is out of usage. Switch provider to continue.`;
  }
  if (failure.kind === 'temporary_rate_limit' || /(?:rate limit (?:reached|exceeded)|too many requests|temporarily rate limited)/.test(detail)) {
    return `${name} is rate-limited right now. Switch provider to continue.`;
  }
  if (failure.kind === 'authentication' || /(?:(?:authentication|auth|access|credentials?) (?:token )?(?:has )?expired|token (?:has )?expired|login required|not logged in)/.test(detail)) {
    return `${name} needs sign-in. Switch provider to continue.`;
  }
  return null;
}
