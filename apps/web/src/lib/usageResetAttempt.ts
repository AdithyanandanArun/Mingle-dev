import { RedeemProviderResetSchema, type AccountUsageProvider, type RedeemProviderResetInput } from '@mingle/contracts';

// These are opaque action IDs, never account credentials. Retain an uncertain action through Settings navigation/reload.
const pending = new Map<AccountUsageProvider, RedeemProviderResetInput>();
type AttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (provider: AccountUsageProvider) => `mingle:pending-usage-reset:${provider}`;
function browserStorage(): AttemptStorage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

export function loadUsageResetAttempt(provider: AccountUsageProvider, storage: AttemptStorage | null = browserStorage()): RedeemProviderResetInput | null {
  try {
    const raw = storage?.getItem(key(provider));
    if (raw) {
      const parsed = raw.length <= 1024 ? RedeemProviderResetSchema.safeParse(JSON.parse(raw)) : null;
      if (parsed?.success) { pending.set(provider, parsed.data); return parsed.data; }
      pending.delete(provider);
      storage?.removeItem(key(provider));
      return null;
    }
  } catch { /* In-memory retry remains available when browser storage is disabled. */ }
  return pending.get(provider) ?? null;
}

export function saveUsageResetAttempt(provider: AccountUsageProvider, input: RedeemProviderResetInput, storage: AttemptStorage | null = browserStorage()): void {
  const safe = RedeemProviderResetSchema.parse(input);
  pending.set(provider, safe);
  try { storage?.setItem(key(provider), JSON.stringify(safe)); } catch { /* Keep this window's retry identity in memory. */ }
}

export function clearUsageResetAttempt(provider: AccountUsageProvider, idempotencyKey: string, storage: AttemptStorage | null = browserStorage()): void {
  const current = loadUsageResetAttempt(provider, storage);
  if (current?.idempotencyKey !== idempotencyKey) return;
  pending.delete(provider);
  try { storage?.removeItem(key(provider)); } catch { /* Best effort when browser storage becomes unavailable. */ }
}
