import { z } from 'zod';
import type { ProviderUsage } from './index';

export const AccountUsageProviderSchema = z.enum(['codex', 'claude']);
export type AccountUsageProvider = z.infer<typeof AccountUsageProviderSchema>;

/** Account limits read without requiring, creating or running a coding session. */
export interface ProviderAccountUsageSnapshot {
  provider: AccountUsageProvider;
  usage: ProviderUsage;
  reset: {
    mode: 'native' | 'external' | 'unavailable';
    /** Opaque, short-lived server binding for an explicit native redemption. Never a credential. */
    snapshotToken: string | null;
    /** Fixed provider-owned settings destination when native redemption is unavailable. */
    externalUrl: string | null;
    reason: string | null;
  };
}

export const RedeemProviderResetSchema = z.object({
  /** Reuse for retries of the same logical redemption; a new user action gets a new UUID. */
  idempotencyKey: z.string().uuid(),
  snapshotToken: z.string().min(1).max(200),
  creditId: z.string().min(1).max(160).optional(),
}).strict();
export type RedeemProviderResetInput = z.infer<typeof RedeemProviderResetSchema>;

export interface ProviderResetResult {
  outcome: 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit';
  /** A fresh provider read, never guessed from the redemption outcome. May fail independently. */
  snapshot: ProviderAccountUsageSnapshot | null;
  notice: string | null;
}
