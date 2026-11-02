import { z } from 'zod';
import { ProviderSchema } from './provider-config';

export const ProviderUpdateStatusSchema = z.enum(['checking', 'available', 'current', 'error', 'unknown', 'updating', 'failed', 'updated']);
export type ProviderUpdateStatus = z.infer<typeof ProviderUpdateStatusSchema>;
export interface ProviderUpdateInfo {
  provider: import('./provider-config').Provider;
  installedVersion: string | null;
  latestVersion: string | null;
  source: string | null;
  checkedExecutable?: string | null;
  instructions?: string;
  checkedAt: string | null;
  status: ProviderUpdateStatus;
  channel: 'stable' | 'prerelease' | 'unknown';
  method: 'native' | 'unsupported';
  message: string;
  dismissed?: boolean;
  progress?: string;
}
export interface ProviderUpdatesSnapshot { providers: ProviderUpdateInfo[]; }
export const ProviderUpdateActionSchema = z.object({ provider: ProviderSchema, expectedVersion: z.string().max(100).nullable() }).strict();
export const ProviderUpdateDismissSchema = z.object({ provider: ProviderSchema, version: z.string().min(1).max(100) }).strict();
