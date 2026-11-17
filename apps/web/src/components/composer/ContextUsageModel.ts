import type { Session } from '@mingle/contracts';

export type ContextTone = 'neutral' | 'warning' | 'danger';
export function contextTone(percent: number | null): ContextTone {
  return percent !== null && percent > 90 ? 'danger' : percent !== null && percent > 70 ? 'warning' : 'neutral';
}

/** A native context reading is independent of the session's cumulative input/output totals. */
export function contextReading(session: Session | null) {
  const usage = session?.contextUsage;
  const valid = usage && usage.provider === session?.provider && usage.model === session.model
    && usage.providerSessionId === session.providerSessionId && Number.isSafeInteger(usage.usedTokens) && usage.usedTokens >= 0
    && (usage.contextWindow === null || (Number.isSafeInteger(usage.contextWindow) && usage.contextWindow > 0));
  const percent = valid && usage.contextWindow ? usage.usedTokens / usage.contextWindow * 100 : null;
  return { percent, tone: contextTone(percent), fraction: percent === null ? null : Math.min(percent / 100, 1),
    usedTokens: valid ? usage.usedTokens : null, capacity: valid ? usage.contextWindow : null,
    estimated: valid ? usage.estimated : false,
    updatedAt: valid && Number.isFinite(Date.parse(usage.updatedAt)) ? usage.updatedAt : null,
    label: percent === null ? (valid ? 'Context capacity unreported' : 'Context usage unreported') : `${usage?.estimated ? 'Estimated context' : 'Context'}: ${percent.toFixed(1)}% used` };
}

export function compactBlocker(session: Session | null, disabled: boolean, reason?: string): string | null {
  if (!session) return 'Select one agent to inspect and compact its conversation.';
  if (disabled) return reason || 'Wait until this conversation is available.';
  if (session.status === 'running' || session.status === 'waiting') return 'Wait for the current run and provider cleanup to finish.';
  if (session.id.startsWith('proxy_')) return 'Compact this conversation on its owner device.';
  if (session.provider === 'antigravity') return 'Antigravity does not support native manual compaction.';
  if (!session.providerSessionId) return 'Start a conversation before compacting its history.';
  return null;
}
