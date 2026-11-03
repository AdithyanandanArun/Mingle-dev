import { randomUUID } from 'node:crypto';
import type { Provider, ProviderFailure } from '@mingle/contracts';
import { errorMessage, isRecord, redactSecrets, truncate } from './common.js';
import { nowIso } from '../util.js';
import type { DispatchState } from './common.js';

export interface ProviderFailureContext {
  provider: Provider;
  sessionId: string;
  runId?: string;
  actor: ProviderFailure['actor'];
  dispatchState: DispatchState;
}

interface FailureSignal {
  kind: ProviderFailure['kind'];
  providerCode?: string;
  retryAt?: string;
  outcomeKnown: boolean;
  continuationSafety: ProviderFailure['continuationSafety'];
  message: string;
}

const GENERIC_CODES = new Set(['provider_error', 'turn_failed', 'claude_failed', 'opencode_failed', 'antigravity_failed', 'rpc_error', 'acprpcerror', 'process_exited']);
const MAX_RETRY_MS = 86_400_000;

function recordsOf(error: unknown): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  const queue: { value: unknown; depth: number }[] = [{ value: error, depth: 0 }];
  const seen = new Set<unknown>();
  while (queue.length && output.length < 32) {
    const { value, depth } = queue.shift()!;
    if (!isRecord(value) || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
    if (depth >= 4) continue;
    for (const key of ['cause', 'data', 'error', 'response', 'body', 'codexErrorInfo', 'details']) {
      const nested: unknown = value[key];
      if (nested !== undefined && nested !== value) queue.push({ value: nested, depth: depth + 1 });
    }
    if (Array.isArray(value.errors)) for (const nested of value.errors.slice(0, 8)) queue.push({ value: nested, depth: depth + 1 });
  }
  return output;
}

function cleanCode(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const code = String(value).trim();
  if (!code || code.length > 100 || /[\x00-\x1f\x7f]/.test(code)) return undefined;
  return redactSecrets(code).slice(0, 100);
}

function providerCode(records: Record<string, unknown>[]): string | undefined {
  const preferred: string[] = [];
  const fallback: string[] = [];
  for (const record of records) {
    for (const key of ['providerCode', 'provider_code', 'errorCode', 'error_code', 'code', 'type', 'subtype']) {
      const value = cleanCode(record[key]);
      if (!value) continue;
      (key === 'providerCode' || key === 'provider_code' || key === 'errorCode' || key === 'error_code' ? preferred : fallback).push(value);
    }
    const codexInfo = record.codexErrorInfo;
    if (isRecord(codexInfo)) for (const key of Object.keys(codexInfo)) preferred.push(key.slice(0, 100));
  }
  return [...preferred, ...fallback].find((code) => !GENERIC_CODES.has(code.toLowerCase()))
    ?? fallback.find((code) => GENERIC_CODES.has(code.toLowerCase()));
}

function normalizeTag(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return String(value).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function httpStatus(records: Record<string, unknown>[]): number | undefined {
  for (const record of records) {
    for (const key of ['status', 'statusCode', 'status_code', 'httpStatus', 'httpStatusCode']) {
      const value = record[key];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
    }
    for (const key of ['codexErrorInfo', 'error', 'data']) {
      const variants = record[key];
      if (!isRecord(variants)) continue;
      for (const variant of Object.values(variants)) {
        if (isRecord(variant) && typeof variant.httpStatusCode === 'number' && Number.isInteger(variant.httpStatusCode)) return variant.httpStatusCode;
      }
    }
  }
  return undefined;
}

function retryAfterValue(records: Record<string, unknown>[]): unknown {
  for (const record of records) {
    if (record.retryAt !== undefined) return { at: record.retryAt };
    if (record.retry_at !== undefined) return { at: record.retry_at };
    if (record.retryAfterMs !== undefined) return { ms: record.retryAfterMs };
    if (record.retry_after_ms !== undefined) return { ms: record.retry_after_ms };
    if (record.retryAfter !== undefined) return { header: record.retryAfter };
    if (record.retry_after !== undefined) return { header: record.retry_after };
    const headers = record.headers;
    if (headers && typeof headers === 'object' && typeof (headers as { get?: unknown }).get === 'function') {
      const value = (headers as { get(name: string): string | null }).get('retry-after');
      if (value !== null) return { header: value };
    }
    if (isRecord(headers)) {
      const key = Object.keys(headers).find((name) => name.toLowerCase() === 'retry-after');
      if (key) return { header: headers[key] };
    }
  }
  return undefined;
}

function parseRetryAt(value: unknown, nowMs: number): string | undefined {
  if (!isRecord(value)) return undefined;
  let target: number | undefined;
  if (typeof value.at === 'string') {
    const parsed = Date.parse(value.at);
    if (Number.isFinite(parsed)) target = parsed;
  }
  if (target === undefined && typeof value.ms === 'number' && Number.isFinite(value.ms) && value.ms >= 0 && value.ms <= MAX_RETRY_MS) target = nowMs + value.ms;
  if (target === undefined && (typeof value.header === 'string' || typeof value.header === 'number')) {
    const header = String(value.header).trim();
    if (/^\d+(?:\.\d+)?$/.test(header)) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0 && seconds * 1000 <= MAX_RETRY_MS) target = nowMs + Math.ceil(seconds * 1000);
    } else {
      const parsed = Date.parse(header);
      if (Number.isFinite(parsed)) target = parsed;
    }
  }
  if (target === undefined || target <= nowMs || target - nowMs > MAX_RETRY_MS) return undefined;
  return new Date(target).toISOString();
}

function messageOf(error: unknown, records: Record<string, unknown>[]): string {
  let primary = 'Provider operation failed.';
  try { primary = errorMessage(error); } catch { /* Malformed/circular native error payload. */ }
  const parts = [primary];
  for (const record of records) {
    if (typeof record.message === 'string') parts.push(record.message);
    if (typeof record.additionalDetails === 'string') parts.push(record.additionalDetails);
  }
  return truncate(redactSecrets([...new Set(parts.filter(Boolean))].join(': ')), 1_000);
}

function classify(error: unknown, records: Record<string, unknown>[], status?: number, code?: string): FailureSignal['kind'] {
  const lowerCode = normalizeTag(code) ?? '';
  const text = messageOf(error, records).toLowerCase();
  const tags = records.flatMap((record) => [record.code, record.type, record.subtype, record.errorCode, record.error_code])
    .map(normalizeTag)
    .filter((value): value is string => value !== undefined);
  const allCodes = [lowerCode, ...tags];

  if (allCodes.some((tag) => !/(?:^|_)rate_limit(?:_|$)/.test(tag)
    && /(?:context|prompt).*(?:length|window|too_large|exceed|limit)|(?:context_length_exceeded|context_window_exceeded|prompt_too_long|request_too_large|input_too_large)/.test(tag))
    || /(?:maximum context length|context window.{0,40}(?:exceed|full|too large)|prompt is too long|input is too large)/i.test(text)) return 'context_exhausted';
  if (allCodes.some((tag) => /(?:max_output_tokens|output_token_limit|output_truncated|max_tokens|turn_limit|max_turn_requests|output_length_exceeded|output_tokens_exceeded|output_limit_exceeded)/.test(tag))
    || /(?:maximum|max|maximal) output tokens?|output token limit|stopped at (?:its )?(?:token|turn) limit/i.test(text)) return 'output_truncated';
  if (allCodes.some((tag) => /(?:insufficient_quota|quota_exhausted|quota_exceeded|usage_limit_reached|usage_limit_exceeded|billing_hard_limit|account_quota)/.test(tag))
    || /(?:insufficient quota|quota (?:is )?(?:exhausted|exceeded)|usage limit reached|billing hard limit)/i.test(text)) return 'quota_exhausted';
  if (allCodes.some((tag) => /(?:rate_limit|too_many_requests|overloaded_error|temporarily_unavailable_capacity)/.test(tag))
    || /(?:rate limit (?:reached|exceeded)|too many requests|temporarily rate limited|server is overloaded)/i.test(text)) return 'temporary_rate_limit';
  if (status === 401 || allCodes.some((tag) => /(?:authentication_required|authentication_error|unauthorized|invalid_api_key|auth_required|login_required)/.test(tag))
    || /(?:unauthori[sz]ed|authentication required|invalid api key|not logged in|login required)/i.test(text)) return 'authentication';
  if ([502, 503, 504].includes(status ?? 0) || allCodes.some((tag) => /(?:provider_unavailable|service_unavailable|process_exited|spawn_failed|executable_unavailable)/.test(tag))) return 'provider_unavailable';
  return 'unknown';
}

/** Conservative provider failure record for scheduler/recovery; raw error payloads never leave this function. */
export function providerFailure(error: unknown, context: ProviderFailureContext): ProviderFailure {
  const records = recordsOf(error);
  const code = providerCode(records);
  const status = httpStatus(records);
  const kind = classify(error, records, status, code);
  const observedAtMs = Date.now();
  const retryAt = kind === 'temporary_rate_limit' ? parseRetryAt(retryAfterValue(records), observedAtMs) : undefined;
  const outcomeKnown = records.some((record) => record.outcomeKnown === true);
  const safetySignals = records.map((record) => record.continuationSafety);
  const continuation = safetySignals.find((value) => value === 'safe' || value === 'unsafe') ?? 'unknown';
  const message = messageOf(error, records);
  return {
    id: `failure_${randomUUID().replaceAll('-', '').slice(0, 24)}`, sessionId: context.sessionId,
    ...(context.runId ? { runId: context.runId } : {}), actor: context.actor, kind,
    provider: context.provider,
    ...(code ? { providerCode: truncate(redactSecrets(code), 100) } : {}),
    retryable: kind === 'temporary_rate_limit' && retryAt !== undefined,
    ...(kind === 'temporary_rate_limit' ? { safeToRetry: retryAt !== undefined && context.dispatchState === 'not-dispatched' } : {}),
    outcomeUnknown: context.dispatchState !== 'not-dispatched' && !outcomeKnown,
    dispatchState: context.dispatchState,
    continuationSafety: continuation,
    ...(retryAt ? { retryAt } : kind === 'temporary_rate_limit' ? { retryAt: null } : {}),
    message, occurredAt: nowIso(),
  };
}
