import { isRecord } from './common.js';
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** ACP usage_update carries context occupancy, independently of billed tokens. */
export function acpContextUsage(update: unknown) {
  if (!isRecord(update) || update.sessionUpdate !== 'usage_update' || !count(update.used)) return null;
  if (update.size !== undefined && update.size !== null && (!count(update.size) || update.size <= 0)) return null;
  return { usedTokens: update.used, contextWindow: typeof update.size === 'number' ? update.size : null };
}

/** Claude's latest main-agent message input includes prompt-cache tokens; result totals are cumulative. */
export function claudeRequestContext(message: unknown): { usedTokens: number; model: string | null } | null {
  if (!isRecord(message) || message.parent_tool_use_id) return null;
  const event = message.type === 'stream_event' && isRecord(message.event) && message.event.type === 'message_start' ? message.event : null;
  const raw = event && isRecord(event.message) ? event.message : message.type === 'assistant' && isRecord(message.message) ? message.message : null;
  const usage = raw && isRecord(raw.usage) ? raw.usage : null;
  if (!usage || !count(usage.input_tokens)) return null;
  const cacheRead = usage.cache_read_input_tokens ?? 0, cacheWrite = usage.cache_creation_input_tokens ?? 0;
  if (!count(cacheRead) || !count(cacheWrite)) return null;
  const usedTokens = usage.input_tokens + cacheRead + cacheWrite;
  return Number.isSafeInteger(usedTokens) ? { usedTokens, model: typeof raw?.model === 'string' ? raw.model : null } : null;
}

export function claudeContextWindow(message: unknown, model: string | null): number | null {
  if (!model || !isRecord(message) || message.type !== 'result' || !isRecord(message.modelUsage)) return null;
  const usage = message.modelUsage[model];
  return isRecord(usage) && count(usage.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : null;
}
