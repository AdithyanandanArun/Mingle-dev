import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppSettings } from '@mingle/contracts';
import { isRecord } from './common.js';

/** Highest threshold Mingle accepts; a harness may still compact earlier by its own native rules. */
export const AUTO_COMPACT_MIN_PERCENT = 1;
export const AUTO_COMPACT_MAX_PERCENT = 95;

/**
 * The user's auto-compaction threshold, or null for "native default". Null/undefined leave every harness setting
 * untouched; out-of-range or non-integer values are ignored rather than clamped, so an invalid stored value never
 * silently becomes a different threshold.
 */
export function autoCompactPercent(settings: AppSettings): number | null {
  const value = settings.autoCompactPercent;
  return typeof value === 'number' && Number.isInteger(value) && value >= AUTO_COMPACT_MIN_PERCENT && value <= AUTO_COMPACT_MAX_PERCENT ? value : null;
}

const formatTokens = (value: number): string => value.toLocaleString('en-US');

// ---- Claude ------------------------------------------------------------------------------------------------------

/** Documented Claude Code variable: percentage (1-100) of the auto-compact window at which compaction triggers. */
export const CLAUDE_COMPACT_ENV = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE';

/** Environment entries for one Claude run; empty for the native default so any inherited native configuration stays. */
export function claudeCompactEnv(percent: number | null): Record<string, string> {
  return percent === null ? {} : { [CLAUDE_COMPACT_ENV]: String(percent) };
}

/** Visible note for compaction progress reported by Claude Code SDK system messages, or null for unrelated messages. */
export function describeClaudeCompaction(message: unknown, percent: number | null): string | null {
  if (!isRecord(message) || message.type !== 'system') return null;
  const setting = percent === null ? '' : `(Mingle threshold: ${percent}%.)`;
  if (message.subtype === 'compact_boundary' && isRecord(message.compact_metadata)) {
    const meta = message.compact_metadata;
    const trigger = meta.trigger === 'manual' ? 'manually' : meta.trigger === 'auto' ? 'automatically' : null;
    const before = typeof meta.pre_tokens === 'number' ? meta.pre_tokens : null;
    const after = typeof meta.post_tokens === 'number' ? meta.post_tokens : null;
    const parts = [`Claude compacted the conversation context${trigger ? ` ${trigger}` : ''}.`];
    if (before !== null) parts.push(`${formatTokens(before)} → ${after !== null ? `${formatTokens(after)} tokens` : 'a smaller context'}.`);
    if (meta.trigger === 'auto' && setting) parts.push(setting);
    return parts.join(' ');
  }
  if (message.subtype === 'status' && message.compact_result === 'failed') {
    const reason = typeof message.compact_error === 'string' && message.compact_error ? `: ${message.compact_error.slice(0, 300)}` : '.';
    return `Claude could not compact the conversation context${reason}`;
  }
  return null;
}

// ---- Codex -------------------------------------------------------------------------------------------------------

/** Documented Codex config key: absolute token threshold for automatic history compaction (unset = model default). */
export const CODEX_COMPACT_KEY = 'model_auto_compact_token_limit';

/** Learned-window cache is bounded: model ids are user/provider supplied. */
const MAX_REMEMBERED = 64;
const reportedWindows = new Map<string, number>();

/** Effective window reported by Codex itself (`thread/tokenUsage/updated`), remembered for later runs of this process. */
export function rememberReportedWindow(model: string, window: number): void {
  if (!Number.isSafeInteger(window) || window <= 0) return;
  reportedWindows.delete(model);
  reportedWindows.set(model, window);
  if (reportedWindows.size > MAX_REMEMBERED) reportedWindows.delete(reportedWindows.keys().next().value as string);
}

/** Effective window from a `ThreadTokenUsage` payload, or null when Codex does not report one. */
export function reportedContextWindow(tokenUsage: unknown): number | null {
  if (!isRecord(tokenUsage)) return null;
  const window = tokenUsage.modelContextWindow;
  return typeof window === 'number' && Number.isSafeInteger(window) && window > 0 ? window : null;
}

/**
 * Proposed shape for a typed context event: the last request's total tokens against the reported window.
 * Whether `last.totalTokens` equals Codex's own "context used" figure is not documented; treat it as an estimate.
 */
export function codexContextUsage(tokenUsage: unknown): { usedTokens: number; contextWindow: number | null } | null {
  if (!isRecord(tokenUsage) || !isRecord(tokenUsage.last)) return null;
  const used = tokenUsage.last.totalTokens;
  return typeof used === 'number' && Number.isSafeInteger(used) && used >= 0 ? { usedTokens: used, contextWindow: reportedContextWindow(tokenUsage) } : null;
}

/** Explicit `model_context_window` from a `config/read` response (null when the user never configured one). */
export function configuredContextWindow(response: unknown): number | null {
  const config = isRecord(response) && isRecord(response.config) ? response.config : null;
  const value = config?.model_context_window;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export interface CatalogCapacity { contextWindow: number; effectivePercent: number }

const positiveInt = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null);

/** Reads one model from the text of Codex's local model-catalog cache; returns only the two numeric capacity fields. */
export function parseCatalogCapacity(text: string, model: string): CatalogCapacity | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const models = isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : [];
  for (const entry of models) {
    if (!isRecord(entry) || entry.slug !== model) continue;
    const contextWindow = positiveInt(entry.context_window);
    const effectivePercent = positiveInt(entry.effective_context_window_percent);
    return contextWindow && effectivePercent && effectivePercent <= 100 ? { contextWindow, effectivePercent } : null;
  }
  return null;
}

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

/**
 * App-server `model/list` carries no context window, so the capacity comes from the models cache the Codex CLI itself
 * maintains next to its config. Only models_cache.json is opened; credentials in the same directory are never touched.
 */
async function boundedCatalog(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) return '';
    const buffer = Buffer.alloc(MAX_CATALOG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    return size > MAX_CATALOG_BYTES ? '' : buffer.subarray(0, size).toString('utf8');
  } finally { await file.close(); }
}

export async function readCatalogCapacity(env: NodeJS.ProcessEnv, model: string, read: (path: string) => Promise<string> = boundedCatalog): Promise<CatalogCapacity | null> {
  const home = env.CODEX_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.codex');
  try {
    const text = await read(join(home, 'models_cache.json'));
    return text.length <= MAX_CATALOG_BYTES ? parseCatalogCapacity(text, model) : null;
  } catch {
    return null;
  }
}

/** Native absolute limit for a percentage of the effective window; at least 1 token. */
export function codexCompactLimit(percent: number, effectiveWindow: number): number {
  return Math.max(1, Math.floor((effectiveWindow * percent) / 100));
}

export type CompactionWindowSource = 'reported' | 'catalog' | 'catalog-with-config';

export interface CodexCompactionPlan {
  /** Per-thread `config` overrides for thread/start and thread/resume; empty when native compaction is left alone. */
  config: Record<string, number>;
  /** Effective window the limit was derived from, for verification against Codex's own report. */
  window: number | null;
  limit: number | null;
  percent: number | null;
  source: CompactionWindowSource | null;
  /** Visible explanation when the threshold could not be applied. */
  notice: string | null;
  cacheKey?: string;
}

export interface CodexCompactionInput {
  percent: number | null;
  model: string;
  env: NodeJS.ProcessEnv;
  /** Resolves the app-server `config/read` response; rejection means unavailable. */
  readConfig: () => Promise<unknown>;
  readCatalog?: typeof readCatalogCapacity;
  namespace?: string;
}

/**
 * Resolves the native Codex limit for the user's percentage without guessing capacity:
 * 1. an effective window Codex itself reported earlier (`modelContextWindow`);
 * 2. the model's catalog context_window (or the user's explicit `model_context_window`) scaled by the catalog's
 *    reported effective_context_window_percent — the same relation Codex reports at runtime (272,000 × 95% = 258,400).
 * Anything else leaves native compaction untouched and returns a notice.
 */
export async function planCodexCompaction(input: CodexCompactionInput): Promise<CodexCompactionPlan> {
  const none = (notice: string | null): CodexCompactionPlan => ({ config: {}, window: null, limit: null, percent: input.percent, source: null, notice });
  const { percent, model } = input;
  if (percent === null) return none(null);
  const configured = await input.readConfig().then(configuredContextWindow, () => null);
  const catalog = await (input.readCatalog ?? readCatalogCapacity)(input.env, model);
  // A changed profile, project configuration or catalog invalidates an earlier reported capacity.
  const cacheKey = JSON.stringify([input.namespace ?? '', model, configured, catalog?.contextWindow, catalog?.effectivePercent]);
  let window = reportedWindows.get(cacheKey) ?? null;
  let source: CompactionWindowSource | null = window ? 'reported' : null;
  if (!window) {
    const raw = configured ?? catalog?.contextWindow ?? null;
    if (raw && catalog) {
      window = Math.floor((raw * catalog.effectivePercent) / 100);
      source = configured ? 'catalog-with-config' : 'catalog';
    }
  }
  if (!window || !source) {
    return { ...none(`Codex has not reported the context window of ${model}, so Mingle could not apply the ${percent}% auto-compaction threshold. Native Codex auto-compaction remains in effect.`), cacheKey };
  }
  const limit = codexCompactLimit(percent, window);
  return { config: { [CODEX_COMPACT_KEY]: limit }, window, limit, percent, source, notice: null, cacheKey };
}

/** Compares the assumed window with the first window Codex reports; returns a notice when they disagree. */
export function verifyCodexWindow(plan: CodexCompactionPlan, reported: number): string | null {
  if (plan.window === null || plan.percent === null || plan.window === reported) return null;
  return `Mingle derived the ${plan.percent}% auto-compaction threshold (${formatTokens(plan.limit ?? 0)} tokens) from a ${formatTokens(plan.window)}-token window, but Codex reports ${formatTokens(reported)} tokens. The next run uses ${formatTokens(codexCompactLimit(plan.percent, reported))} tokens.`;
}

/** Visible note for a completed Codex compaction item. */
export function describeCodexCompaction(plan: CodexCompactionPlan | null): string {
  const base = 'Codex compacted the conversation context.';
  return plan?.limit && plan.percent !== null ? `${base} (Mingle threshold: ${plan.percent}% ≈ ${formatTokens(plan.limit)} tokens.)` : base;
}
