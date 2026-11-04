import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { AppSettings, ProviderUsage, Session, UsageCredits, UsageResetGrant, UsageWindow } from '@mingle/contracts';
import { cleanEnv, isRecord, redactSecrets, truncate } from '../common.js';
import { resolveExecutableCached } from '../discovery.js';
import { shutdownChild, type ChildLike } from '../process.js';
import { JsonRpcConnection, RpcError, RPC_METHOD_NOT_FOUND } from './rpc.js';

const INITIALIZE_TIMEOUT_MS = 8_000;
const USAGE_TIMEOUT_MS = 12_000;
const MAX_BUCKETS = 100;
const MAX_RESET_GRANTS = 100;

function unavailable(notice: string): ProviderUsage {
  return {
    provider: 'codex', fetchedAt: new Date().toISOString(), status: 'unavailable', plan: null,
    windows: [], credits: null, resets: null, notices: [truncate(redactSecrets(notice), 300)],
  };
}

function safeText(value: unknown, max = 160): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return truncate(redactSecrets(value.trim()), max);
}

function isoFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const milliseconds = value * 1000;
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) return null;
  try { return new Date(milliseconds).toISOString(); } catch { return null; }
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function planCode(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(value)) return null;
  return value;
}

function windowLabel(bucketId: string, kind: 'primary' | 'secondary', minutes: number | null): string {
  if (minutes === 300 && kind === 'primary') return 'Session';
  if (minutes === 10_080) return 'Weekly';
  const label = bucketId === 'codex' ? 'Codex' : bucketId;
  return minutes === null ? `${label} ${kind}` : `${label} ${kind} (${minutes} min)`;
}

function getSnapshots(result: Record<string, unknown>): { entries: [string, unknown][]; malformed: boolean } {
  // The multi-bucket response supersedes its legacy single-bucket mirror; never append both.
  if (isRecord(result.rateLimitsByLimitId)) {
    const mapEntries = Object.entries(result.rateLimitsByLimitId);
    if (mapEntries.length > 0) {
      return { entries: mapEntries.slice(0, MAX_BUCKETS), malformed: mapEntries.length > MAX_BUCKETS };
    }
  }
  if (isRecord(result.rateLimits)) return { entries: [['codex', result.rateLimits]], malformed: false };
  return { entries: [], malformed: true };
}

function parseWindows(snapshots: [string, unknown][], notices: string[]): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  for (const [key, raw] of snapshots) {
    if (!isRecord(raw)) { notices.push('Codex returned an invalid rate-limit bucket.'); continue; }
    const bucketId = safeText(raw.limitId, 100) ?? safeText(key, 100);
    if (!bucketId) { notices.push('Codex returned a rate-limit bucket without an identifier.'); continue; }
    const scope = safeText(raw.limitName, 100) ?? bucketId;
    for (const kind of ['primary', 'secondary'] as const) {
      const rawWindow = raw[kind];
      if (rawWindow === null || rawWindow === undefined) continue;
      if (!isRecord(rawWindow)) { notices.push(`Codex returned an invalid ${kind} window for ${bucketId}.`); continue; }
      const usedPercent = typeof rawWindow.usedPercent === 'number' && Number.isFinite(rawWindow.usedPercent) && rawWindow.usedPercent >= 0
        ? rawWindow.usedPercent
        : null;
      const windowMinutes = integerOrNull(rawWindow.windowDurationMins);
      const resetAt = isoFromUnixSeconds(rawWindow.resetsAt);
      if (usedPercent === null) notices.push(`Codex did not report valid usage for the ${kind} ${bucketId} window.`);
      if (rawWindow.windowDurationMins !== null && rawWindow.windowDurationMins !== undefined && windowMinutes === null) {
        notices.push(`Codex returned an invalid duration for the ${kind} ${bucketId} window.`);
      }
      if (rawWindow.resetsAt !== null && rawWindow.resetsAt !== undefined && resetAt === null) {
        notices.push(`Codex returned an invalid reset time for the ${kind} ${bucketId} window.`);
      }
      const id = `${bucketId}:${kind}`;
      if (seen.has(id)) continue;
      seen.add(id);
      windows.push({
        id: truncate(id, 200), label: windowLabel(bucketId, kind, windowMinutes), scope,
        usedPercent, remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
        resetAt, windowMinutes,
      });
    }
  }
  return windows;
}

function parsePlan(snapshots: [string, unknown][], notices: string[]): string | null {
  const values = [...new Set(snapshots.flatMap(([, raw]) => isRecord(raw) ? [planCode(raw.planType)].filter((plan): plan is string => plan !== null) : []))];
  if (values.length > 1) {
    notices.push('Codex reported different plan types across limit buckets; the plan is omitted.');
    return null;
  }
  return values[0] ?? null;
}

function parseCredits(snapshots: [string, unknown][], notices: string[]): UsageCredits | null {
  const values: UsageCredits[] = snapshots.flatMap(([, raw]) => {
    if (!isRecord(raw) || !isRecord(raw.credits)) return [];
    const credit = raw.credits;
    return [{
      balance: safeText(credit.balance, 100), unit: null,
      unlimited: typeof credit.unlimited === 'boolean' ? credit.unlimited : null,
      resetAt: null,
    }];
  });
  if (values.length === 0) return null;
  const unique = new Map(values.map((value) => [JSON.stringify(value), value]));
  if (unique.size > 1) {
    notices.push('Codex reported different credit balances across limit buckets; an aggregate balance is unavailable.');
    return null;
  }
  return unique.values().next().value ?? null;
}

function parseResets(value: unknown, notices: string[]): ProviderUsage['resets'] {
  if (!isRecord(value)) return null;
  const available = integerOrNull(value.availableCount);
  if (available === null) notices.push('Codex did not report a valid available reset count.');
  const detailRows = Array.isArray(value.credits) ? value.credits : null;
  const detailsKnown = detailRows !== null;
  const grants: UsageResetGrant[] = [];
  const seen = new Set<string>();
  for (const raw of (detailRows ?? []).slice(0, MAX_RESET_GRANTS)) {
    if (!isRecord(raw) || raw.status !== 'available') continue;
    const id = safeText(raw.id, 160);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = safeText(raw.title, 120);
    const resetType = raw.resetType === 'codexRateLimits' ? 'Codex rate-limit reset' : 'Usage reset';
    grants.push({
      id, label: title ?? resetType,
      expiresAt: isoFromUnixSeconds(raw.expiresAt),
      grantedAt: isoFromUnixSeconds(raw.grantedAt),
    });
  }
  if (detailRows && detailRows.length > MAX_RESET_GRANTS) notices.push('Codex returned more reset details than Mingle displays; the available count remains authoritative.');
  // The native response has no replenishment date for this balance; credit expiry is reported per grant above.
  return { available, grants, detailsKnown, replenishesAt: null };
}

export function parseCodexUsage(result: unknown): ProviderUsage {
  const usage = unavailable('Codex returned an invalid usage response.');
  const notices: string[] = [];
  if (!isRecord(result)) return usage;
  const { entries, malformed } = getSnapshots(result);
  if (malformed) notices.push('Codex returned incomplete rate-limit data.');
  const windows = parseWindows(entries, notices);
  const plan = parsePlan(entries, notices);
  const credits = parseCredits(entries, notices);
  const resets = Object.hasOwn(result, 'rateLimitResetCredits') ? parseResets(result.rateLimitResetCredits, notices) : null;
  const hasQuotaData = windows.length > 0 || credits !== null || resets !== null;
  const hasData = hasQuotaData || plan !== null;
  if (!hasData) notices.push('Codex did not report rate limits, credits, plan, or earned resets.');
  else if (!hasQuotaData) notices.push('Codex reported plan metadata without quota, credit, or reset data.');
  return {
    provider: 'codex', fetchedAt: new Date().toISOString(),
    status: !hasData ? 'unavailable' : !hasQuotaData || notices.length > 0 ? 'partial' : 'available',
    plan, windows, credits, resets,
    notices: [...new Set(notices)].slice(0, 20).map((notice) => truncate(redactSecrets(notice), 300)),
  };
}

/** Read the local Codex account's native rate-limit snapshot without running a model turn. */
export async function getCodexUsage(session: Session, settings: AppSettings): Promise<ProviderUsage> {
  if (session.provider !== 'codex') return unavailable('Usage is available only for Codex sessions.');
  let resolved: Awaited<ReturnType<typeof resolveExecutableCached>>;
  try {
    resolved = await resolveExecutableCached({ name: 'codex', override: settings.codexExecutable });
  } catch {
    return unavailable('The configured Codex executable could not be checked.');
  }
  if (!resolved.ok) return unavailable('The configured Codex executable is unavailable.');

  let child: ChildLike | undefined;
  let childClosed: Promise<unknown> | undefined;
  let conn: JsonRpcConnection | undefined;
  let usage: ProviderUsage | undefined;
  try {
    const env = cleanEnv(process.env, ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']);
    child = spawn(resolved.executable.path, ['app-server'], {
      cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true,
    }) as unknown as ChildLike;
    childClosed = new Promise<void>((resolve) => {
      child?.on('close', () => resolve());
      child?.on('error', () => resolve());
    });
    child.stderr?.on('data', () => undefined);
    conn = new JsonRpcConnection(child, {
      onNotification: () => undefined,
      onRequest: async (method) => {
        throw new RpcError(RPC_METHOD_NOT_FOUND, `Mingle usage probe does not support ${method}`);
      },
      formatClose: () => 'Codex app-server exited during the usage read.',
    });
    await conn.request('initialize', {
      clientInfo: { name: 'mingle', title: 'Mingle', version: resolved.executable.version },
      capabilities: { experimentalApi: false },
    }, INITIALIZE_TIMEOUT_MS);
    conn.notify('initialized', {});
    const result = await conn.request('account/rateLimits/read', null, USAGE_TIMEOUT_MS);
    usage = parseCodexUsage(result);
  } catch {
    // Native RPC errors can contain account-specific service diagnostics; keep the UI notice generic.
    usage = unavailable('Codex usage could not be read. Confirm the existing Codex sign-in supports rate-limit reads, then retry.');
  } finally {
    if (child) {
      const outcome = await shutdownChild(child, {
        closed: conn?.closed ?? childClosed ?? Promise.resolve(),
        group: process.platform !== 'win32', graceMs: 500, termMs: 1_000, killMs: 1_000,
      });
      if (outcome === 'unresponsive') {
        usage ??= unavailable('Codex app-server did not stop after the usage read.');
        usage.notices = [...usage.notices, 'Codex app-server did not stop cleanly after the usage read.'].slice(0, 20);
        if (usage.status === 'available') usage.status = 'partial';
      }
    }
  }
  return usage ?? unavailable('Codex usage read failed.');
}
