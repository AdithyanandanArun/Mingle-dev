export type DispatchState = 'not-dispatched' | 'dispatched' | 'unknown';

export interface ProviderErrorOptions {
  /** Mingle's stable adapter-level error tag. */
  code?: string;
  /** Native provider error code/type when the transport exposes one. */
  providerCode?: string | number;
  /** Structured HTTP status/Retry-After data, when present on the native error. */
  statusCode?: number;
  retryAfterMs?: number;
  retryAt?: string;
  /** True only when a terminal provider result establishes the outcome. */
  outcomeKnown?: boolean;
  continuationSafety?: 'safe' | 'unsafe' | 'unknown';
  cause?: unknown;
}

/** Error raised by provider adapters; `code` is a stable machine-readable tag. */
export class ProviderError extends Error {
  readonly code: string;
  readonly providerCode?: string;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly retryAt?: string;
  readonly outcomeKnown?: boolean;
  readonly continuationSafety?: 'safe' | 'unsafe' | 'unknown';
  constructor(message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.code = options.code ?? 'provider_error';
    if (options.providerCode !== undefined) this.providerCode = String(options.providerCode).slice(0, 100);
    if (Number.isInteger(options.statusCode)) this.statusCode = options.statusCode;
    if (Number.isFinite(options.retryAfterMs) && options.retryAfterMs! >= 0) this.retryAfterMs = Math.min(86_400_000, Math.floor(options.retryAfterMs!));
    if (options.retryAt) this.retryAt = options.retryAt;
    if (options.outcomeKnown !== undefined) this.outcomeKnown = options.outcomeKnown;
    if (options.continuationSafety) this.continuationSafety = options.continuationSafety;
  }
}

/** Internal adapter extension used by SessionRuntime to prove the provider prompt dispatch boundary. */
export interface DispatchAwareOptions { onDispatchState?: (state: DispatchState) => void }

export function markNotDispatched(options: unknown): void {
  const callback = isRecord(options) ? options.onDispatchState : undefined;
  if (typeof callback === 'function') callback('not-dispatched');
}

export function markDispatched(options: unknown): void {
  const callback = isRecord(options) ? options.onDispatchState : undefined;
  if (typeof callback === 'function') callback('dispatched');
}

/** Rejection used when a run ends because its AbortSignal fired. */
export function abortError(message = 'Run interrupted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

const REDACTION = '[redacted]';
const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-' + REDACTION],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, 'sk-' + REDACTION],
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g, REDACTION],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTION],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTION],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer ' + REDACTION],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTION],
  [/\b([A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=' + REDACTION],
  [/"([A-Za-z_]*(?:api_?key|token|secret|password|authorization)[A-Za-z_]*)"\s*:\s*"[^"]*"/gi, '"$1":"' + REDACTION + '"'],
];

/** Masks well-known credential shapes plus any literal secret values supplied by the caller. */
export function redactSecrets(text: string, literals: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const literal of literals) {
    if (literal && literal.length >= 8) out = out.split(literal).join(REDACTION);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length - max} more characters]`;
}

export function truncateTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `… [${text.length - max} earlier characters]\n${text.slice(text.length - max)}`;
}

/** Keeps only the most recent `limit` characters of a stream such as stderr. */
export class TextTail {
  private value = '';
  private dropped = 0;
  constructor(private readonly limit = 16_384) {}
  push(chunk: string): void {
    this.value += chunk;
    if (this.value.length > this.limit * 2) {
      const cut = this.value.length - this.limit;
      this.dropped += cut;
      this.value = this.value.slice(cut);
    }
  }
  /** Redacted, trimmed and shortened view suitable for error messages. */
  summary(maxChars = 1_500, literals: readonly (string | undefined)[] = []): string {
    const trimmed = this.value.trim();
    if (!trimmed) return '';
    return truncateTail(redactSecrets(trimmed, literals), maxChars);
  }
  get isEmpty(): boolean { return this.value.trim().length === 0; }
}

export function cleanEnv(base: NodeJS.ProcessEnv, remove: readonly string[] = [], set: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    // The desktop relay authorizes every embedded target. Providers receive only their
    // scoped browser MCP capability, never the backend's unrestricted relay connection.
    if (value !== undefined && key !== 'MINGLE_EMBEDDED_BROWSER_TOKEN' && key !== 'MINGLE_EMBEDDED_BROWSER_URL' && !remove.includes(key)) env[key] = value;
  }
  return { ...env, ...set };
}

export function describeValue(value: unknown, max = 600): string {
  if (typeof value === 'string') return truncate(value, max);
  try { return truncate(JSON.stringify(value) ?? String(value), max); } catch { return truncate(String(value), max); }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
