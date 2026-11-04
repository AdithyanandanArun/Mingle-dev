import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { AppSettings, ProviderAccountUsageSnapshot, ProviderResetResult, RedeemProviderResetInput, UsageResetGrant } from '@mingle/contracts';
import { cleanEnv, isRecord } from '../common.js';
import { resolveExecutableCached } from '../discovery.js';
import { shutdownChild, type ChildLike } from '../process.js';
import { JsonRpcConnection, RpcError, RPC_METHOD_NOT_FOUND } from './rpc.js';
import { parseCodexUsage } from './usage.js';

const INIT_MS = 8_000;
const RPC_MS = 10_000;
const LEASE_MS = 5 * 60_000;
const MAX_LEASES = 100;
const MAX_ATTEMPTS = 100;
const EXTERNAL = 'Codex does not expose a safe native reset action for this account.';

type RpcCall = (method: string, params: unknown, timeout: number) => Promise<unknown>;
export interface CodexAccountUsageConnection { request: RpcCall; close(): Promise<boolean>; binding?: string }
export type CodexAccountUsageConnect = (settings: AppSettings) => Promise<CodexAccountUsageConnection>;

function unsupported(reason: string): ProviderAccountUsageSnapshot {
  return { provider: 'codex', usage: { provider: 'codex', fetchedAt: new Date().toISOString(), status: 'unavailable', plan: null,
    windows: [], credits: null, resets: null, notices: [reason] }, reset: { mode: 'unavailable', snapshotToken: null, externalUrl: null, reason } };
}
function accountFingerprint(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.account)) return null;
  const account = value.account;
  const id = typeof account.id === 'string' && account.id.length <= 500 ? account.id : null;
  const email = typeof account.email === 'string' && account.email.length <= 500 ? account.email.trim().toLowerCase() : null;
  const type = typeof account.type === 'string' && account.type.length <= 80 ? account.type : '';
  const stable = id ? `id:${id}` : email ? `email:${email}:${type}` : null;
  return stable ? createHash('sha256').update(stable).digest('hex') : null;
}
function resetRows(result: unknown): { count: number | null; known: boolean; credits: UsageResetGrant[] } {
  if (!isRecord(result) || !isRecord(result.rateLimitResetCredits)) return { count: null, known: false, credits: [] };
  const credits = result.rateLimitResetCredits.credits;
  return { count: typeof result.rateLimitResetCredits.availableCount === 'number' && Number.isSafeInteger(result.rateLimitResetCredits.availableCount) && result.rateLimitResetCredits.availableCount >= 0 ? result.rateLimitResetCredits.availableCount : null,
    known: Array.isArray(credits), credits: [] };
}
function grantNotExpired(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const milliseconds = value * 1000;
  return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15 && milliseconds > Date.now();
}
interface Lease { providerExecutable: string; installationBinding: string; account: string; expires: number }
interface Attempt { fingerprint: string; creditId?: string }

/** Short-lived process-local account leases. No account identifiers or credentials leave this module. */
export class CodexAccountUsage {
  private readonly leases = new Map<string, Lease>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly inflight = new Map<string, Promise<ProviderResetResult>>();
  private activeRedemptionKey: string | null = null;
  private uncertainIdempotencyKey: string | null = null;
  constructor(private readonly connect: CodexAccountUsageConnect = connectCodex) {}

  invalidate(): void { this.leases.clear(); }

  async read(settings: AppSettings): Promise<ProviderAccountUsageSnapshot> {
    try {
      const conn = await this.connect(settings);
      let account: string | null = null;
      let result: unknown;
      let cleanupOk = true;
      try {
        account = accountFingerprint(await conn.request('account/read', { refreshToken: false }, RPC_MS));
        result = await conn.request('account/rateLimits/read', null, RPC_MS);
      } finally { cleanupOk = await conn.close(); }
      const usage = parseCodexUsage(result);
      if (!account) return { ...unsupported('Codex did not provide a stable account identity; native reset actions are disabled.'), usage };
      if (!cleanupOk) usage.notices = [...usage.notices, 'Codex app-server did not stop cleanly after the usage read.'].slice(0, 20);
      const grants = resetRows(result);
      const mode = grants.count === null ? 'unavailable' : grants.count === 0 ? 'unavailable' : 'native';
      if (mode === 'native') {
        const token = randomUUID();
        this.rememberLease(token, { providerExecutable: settings.codexExecutable, installationBinding: conn.binding ?? settings.codexExecutable, account, expires: Date.now() + LEASE_MS });
        return { provider: 'codex', usage, reset: { mode, snapshotToken: token, externalUrl: null, reason: null } };
      }
      return { provider: 'codex', usage, reset: { mode, snapshotToken: null, externalUrl: null,
        reason: grants.count === 0 ? 'No earned resets are currently available.' : 'Codex did not report an authoritative available reset count.' } };
    } catch {
      return unsupported('Codex account usage could not be read. Check Codex availability and sign-in, then retry.');
    }
  }

  redeem(settings: AppSettings, snapshotToken: string, input: RedeemProviderResetInput): Promise<ProviderResetResult> {
    const active = this.inflight.get(input.idempotencyKey);
    if (active) return active;
    if (this.uncertainIdempotencyKey !== null && this.uncertainIdempotencyKey !== input.idempotencyKey) return Promise.resolve({ outcome: 'noCredit', snapshot: null, notice: 'A previous Codex reset result is still uncertain. Retry it with its original request key before starting another reset.' });
    if (this.activeRedemptionKey !== null) return Promise.resolve({ outcome: 'noCredit', snapshot: null, notice: 'Another Codex reset action is still being confirmed. Retry this action with its original request key.' });
    const lease = this.leases.get(snapshotToken);
    const empty = (notice: string, outcome: ProviderResetResult['outcome'] = 'noCredit'): ProviderResetResult => ({ outcome, snapshot: null, notice });
    if (!lease || lease.expires <= Date.now() || lease.providerExecutable !== settings.codexExecutable) return Promise.resolve(empty('This usage snapshot expired or Codex settings changed. Refresh usage before trying again.'));
    const fingerprint = createHash('sha256').update(`${lease.account}:${snapshotToken}`).digest('hex');
    const existing = this.attempts.get(input.idempotencyKey);
    if (existing && (existing.fingerprint !== fingerprint || existing.creditId !== input.creditId)) return Promise.resolve(empty('This reset request key was already used for a different selection.'));
    this.activeRedemptionKey = input.idempotencyKey;
    const pending = this.redeemOnce(settings, lease, snapshotToken, input, fingerprint).finally(() => {
      if (this.inflight.get(input.idempotencyKey) === pending) this.inflight.delete(input.idempotencyKey);
      if (this.activeRedemptionKey === input.idempotencyKey) this.activeRedemptionKey = null;
    });
    this.inflight.set(input.idempotencyKey, pending);
    return pending;
  }

  private async redeemOnce(settings: AppSettings, lease: Lease, token: string, input: RedeemProviderResetInput, fingerprint: string): Promise<ProviderResetResult> {
    const empty = (notice: string, outcome: ProviderResetResult['outcome'] = 'noCredit'): ProviderResetResult => ({ outcome, snapshot: null, notice });
    let retrySameKey = false;
    try {
      const conn = await this.connect(settings);
      let confirmed: ProviderResetResult['outcome'] | null = null;
      try {
        if ((conn.binding ?? settings.codexExecutable) !== lease.installationBinding) return empty('The Codex installation changed. Refresh usage before trying again.');
        const account = accountFingerprint(await conn.request('account/read', { refreshToken: false }, RPC_MS));
        if (!account || account !== lease.account) return empty('The active Codex account changed. Refresh usage before trying again.');
        const attempt = this.attempts.get(input.idempotencyKey);
        if (!attempt) {
          const current = await conn.request('account/rateLimits/read', null, RPC_MS);
          const grants = resetRows(current);
          if (grants.count === null || grants.count < 1) return empty('No earned reset is currently available.', 'noCredit');
          if (grants.known) {
            const raw = (current as { rateLimitResetCredits: { credits: unknown[] } }).rateLimitResetCredits.credits;
            const available = raw.filter((row): row is Record<string, unknown> => isRecord(row) && row.status === 'available');
            if (input.creditId ? !available.some((row) => row.id === input.creditId && grantNotExpired(row.expiresAt)) : available.length === 0) return empty('The selected earned reset is no longer available.', 'noCredit');
          } else if (input.creditId) return empty('Codex no longer exposes reset details needed to validate that selection. Refresh usage and select an available reset.');
        }
        if (!attempt) {
          this.rememberAttempt(input.idempotencyKey, { fingerprint, ...(input.creditId ? { creditId: input.creditId } : {}) });
        }
        this.uncertainIdempotencyKey = input.idempotencyKey;
        const response = await conn.request('account/rateLimitResetCredit/consume', { idempotencyKey: input.idempotencyKey, ...(input.creditId ? { creditId: input.creditId } : {}) }, RPC_MS);
        const outcome = isRecord(response) && ['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(String(response.outcome)) ? response.outcome as ProviderResetResult['outcome'] : null;
        if (!outcome) { retrySameKey = true; return empty('Codex returned an unrecognized reset result. Retry with the same request key to safely resolve it.'); }
        this.uncertainIdempotencyKey = null;
        confirmed = outcome;
      } catch (error) {
        if (error instanceof RpcError && error.code === RPC_METHOD_NOT_FOUND) {
          this.uncertainIdempotencyKey = null;
          this.attempts.delete(input.idempotencyKey);
          return empty('This Codex app-server version does not expose the native earned reset action.');
        }
        retrySameKey = true;
        return empty('The reset result could not be confirmed. Retry this action using the same request key.', 'noCredit');
      } finally { await conn.close(); }
      if (!confirmed) return empty('Codex did not confirm the reset result.');
      // A confirmed action is retained even if the independent follow-up read fails.
      const snapshot = await this.read(settings);
      const fresh = snapshot.usage.status === 'unavailable' ? null : snapshot;
      return { outcome: confirmed, snapshot: fresh, notice: fresh ? null : 'Codex confirmed the reset action, but a fresh usage read failed. Refresh usage to see current limits.' };
    } catch {
      return empty('The reset result could not be confirmed. Retry this action using the same request key.', 'noCredit');
    } finally { if (!retrySameKey) this.leases.delete(token); }
  }

  private rememberLease(token: string, lease: Lease): void {
    if (this.leases.size >= MAX_LEASES) this.leases.delete(this.leases.keys().next().value!);
    this.leases.set(token, lease);
  }
  private rememberAttempt(key: string, attempt: Attempt): void {
    if (this.attempts.size >= MAX_ATTEMPTS) this.attempts.delete(this.attempts.keys().next().value!);
    this.attempts.set(key, attempt);
  }
}

async function connectCodex(settings: AppSettings): Promise<CodexAccountUsageConnection> {
  const resolved = await resolveExecutableCached({ name: 'codex', override: settings.codexExecutable });
  if (!resolved.ok) throw new Error('Codex executable unavailable');
  const env = cleanEnv(process.env, ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']);
  const child = spawn(resolved.executable.path, ['app-server'], { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true }) as unknown as ChildLike;
  const closed = new Promise<void>((resolve) => { child.on('close', () => resolve()); child.on('error', () => resolve()); });
  child.stderr?.on('data', () => undefined);
  const conn = new JsonRpcConnection(child, { onNotification: () => undefined,
    onRequest: async (method) => { throw new RpcError(RPC_METHOD_NOT_FOUND, `Unsupported request: ${method}`); },
    formatClose: () => 'Codex app-server exited during account usage.' });
  try {
    await conn.request('initialize', { clientInfo: { name: 'mingle', title: 'Mingle', version: resolved.executable.version }, capabilities: { experimentalApi: false } }, INIT_MS);
    conn.notify('initialized', {});
  } catch (error) {
    await shutdownChild(child, { closed: conn.closed, group: process.platform !== 'win32', graceMs: 500, termMs: 1_000, killMs: 1_000 });
    throw error;
  }
  return { binding: `${resolved.executable.path}:${resolved.executable.version}`, request: (method, params, timeout) => conn.request(method, params, timeout), close: async () => {
    const outcome = await shutdownChild(child, { closed: conn.closed ?? closed, group: process.platform !== 'win32', graceMs: 500, termMs: 1_000, killMs: 1_000 });
    return outcome !== 'unresponsive';
  } };
}
