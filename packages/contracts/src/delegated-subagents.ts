import { z } from 'zod';
import { ProviderSchema, type Provider } from './provider-config';

/**
 * A subagent that Mingle runs for a single-agent session on any available provider (not the provider's own built-in
 * subagents). It works in a child session; when it finishes, Mingle hands its result back to the parent agent, which
 * continues by itself.
 */
export interface DelegatedSubagent {
  id: string;
  parentSessionId: string;
  /** The child session that does the work; its transcript can be opened from the rail. */
  childSessionId: string;
  /** Short handle shown in the rail, e.g. "researcher". */
  name: string;
  provider: Provider;
  model: string;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  requestedBy: 'agent' | 'user';
  startedAt: string;
  endedAt: string | null;
  /** First part of the final answer, for the rail; the full answer is in the child session. */
  resultPreview: string | null;
  error: string | null;
  /** True once the result has been handed back to the parent (delivered or queued for it). */
  resultDelivered: boolean;
}

export const StartSubagentSchema = z.object({
  task: z.string().trim().min(1).max(20_000),
  name: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,39}$/u, 'Use lowercase letters, numbers and dashes.').optional(),
  provider: ProviderSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
}).strict();
export type StartSubagent = z.infer<typeof StartSubagentSchema>;

/** Most subagents a single parent session may run at the same time. */
export const MAX_RUNNING_SUBAGENTS = 4;
