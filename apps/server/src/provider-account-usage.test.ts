import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppSettings, ProviderAccountUsageSnapshot, ProviderResetResult, ProviderUsage, RedeemProviderResetInput } from '@mingle/contracts';
import { deferred, FakeProviders, startTestApp, waitFor } from './test-utils.ts';
import { CodexAccountUsage, type CodexAccountUsageConnect } from './providers/codex/account-usage.ts';

const usage = (provider: 'codex' | 'claude', resets: ProviderUsage['resets'] = null): ProviderUsage => ({ provider, fetchedAt: new Date().toISOString(), status: 'available', plan: 'plus',
  windows: [{ id: 'five_hour', label: '5-hour', usedPercent: 30, remainingPercent: 70, resetAt: '2026-11-04T12:00:00.000Z', windowMinutes: 300 },
    { id: 'seven_day', label: '7-day', usedPercent: 60, remainingPercent: 40, resetAt: '2026-11-10T12:00:00.000Z', windowMinutes: 10080 }],
  credits: null, resets, notices: [] });
const settings = (): AppSettings => ({ defaultProvider: 'codex', defaultCodexModel: 'gpt-6.1-sol', defaultClaudeModel: 'claude-sonnet-5-5', defaultEffort: 'high', defaultIsolated: true,
  defaultPolicy: 'supervised', theme: 'dark', claudeExecutable: '', codexExecutable: '' });

function scriptedConnect(options: { creditRows?: unknown; count?: number | null; account?: string; consume?: (params: any) => unknown | Promise<unknown> } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const connect: CodexAccountUsageConnect = async () => ({
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'account/read') return { account: { id: options.account ?? 'native-account-1', type: 'chatgpt' } };
      if (method === 'account/rateLimits/read') return { rateLimits: { planType: 'plus', primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1793793600 }, secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1794312000 } },
        rateLimitResetCredits: { availableCount: options.count === undefined ? 1 : options.count, credits: options.creditRows === undefined ? [{ id: 'credit-1', title: 'Earned reset', status: 'available', expiresAt: 1_800_000_000 }] : options.creditRows } };
      if (method === 'account/rateLimitResetCredit/consume') return options.consume ? options.consume(params) : { outcome: 'reset' };
      throw new Error(`Unexpected RPC: ${method}`);
    }, async close() { return true; },
  });
  return { calls, connect };
}

const apps: Array<{ cleanup(): Promise<void> }> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

describe('account usage HTTP routes', () => {
  it('reads limits without creating or running a coding session and accepts only Codex or Claude', async () => {
    class AccountFake extends FakeProviders {
      async getAccountUsage(provider: 'codex' | 'claude'): Promise<ProviderAccountUsageSnapshot> {
        return { provider, usage: usage(provider, provider === 'codex' ? { available: 1, grants: [], detailsKnown: false, replenishesAt: null } : null),
          reset: provider === 'codex' ? { mode: 'native', snapshotToken: 'opaque', externalUrl: null, reason: null }
            : { mode: 'external', snapshotToken: null, externalUrl: 'https://claude.ai/settings/usage', reason: 'Claude does not expose a native reset.' } };
      }
      async redeemAccountUsageReset(_provider: 'codex' | 'claude', _settings: AppSettings, _token: string, _input: RedeemProviderResetInput): Promise<ProviderResetResult> {
        return { outcome: 'reset', snapshot: null, notice: 'Confirmed without a follow-up read.' };
      }
    }
    const fake = new AccountFake();
    const app = await startTestApp({ fake, exampleWorkspace: false }); apps.push(app);
    const codex = await app.api('GET', '/api/providers/codex/usage');
    expect(codex.status).toBe(200);
    expect(codex.json.usage.windows.map((row: any) => row.windowMinutes)).toEqual([300, 10080]);
    expect((await app.api('GET', '/api/providers/claude/usage?refresh=true')).json.reset.mode).toBe('external');
    expect((await app.api('GET', '/api/providers/antigravity/usage')).status).toBe(400);
    expect((await app.api('POST', '/api/providers/claude/usage/reset', { idempotencyKey: randomUUID(), snapshotToken: 'opaque' })).status).toBe(200);
    expect((await app.api('POST', '/api/providers/codex/usage/reset', { idempotencyKey: randomUUID(), snapshotToken: 'opaque', extra: true })).status).toBe(400);
    const state = (await app.api('GET', '/api/bootstrap')).json;
    expect(state.projects).toEqual([]);
    expect(state.sessions).toEqual([]);
    expect(fake.runs).toEqual([]);
  });

  it('does not cache a late account read across an explicit reset', async () => {
    const oldRead = deferred<ProviderAccountUsageSnapshot>();
    const started = deferred<void>();
    let reads = 0;
    class RacingFake extends FakeProviders {
      async getAccountUsage(provider: 'codex' | 'claude'): Promise<ProviderAccountUsageSnapshot> {
        reads++;
        if (reads === 1) { started.resolve(); return oldRead.promise; }
        return { provider, usage: usage(provider), reset: { mode: 'native', snapshotToken: 'new-token', externalUrl: null, reason: null } };
      }
      async redeemAccountUsageReset(): Promise<ProviderResetResult> { return { outcome: 'reset', snapshot: null, notice: null }; }
    }
    const fake = new RacingFake();
    const app = await startTestApp({ fake, exampleWorkspace: false }); apps.push(app);
    const pendingRead = app.api('GET', '/api/providers/codex/usage');
    await started.promise;
    const reset = app.api('POST', '/api/providers/codex/usage/reset', { idempotencyKey: randomUUID(), snapshotToken: 'leased' });
    await waitFor(() => reads === 1);
    oldRead.resolve({ provider: 'codex', usage: usage('codex'), reset: { mode: 'native', snapshotToken: 'old-token', externalUrl: null, reason: null } });
    await Promise.all([pendingRead, reset]);
    expect((await app.api('GET', '/api/providers/codex/usage?refresh=true')).json.reset.snapshotToken).toBe('new-token');
    expect(reads).toBe(2);
  });

  it('coalesces the same reset key, fences another key, and holds new reads until mutation completes', async () => {
    const resetGate = deferred<ProviderResetResult>();
    let reads = 0;
    class FencedFake extends FakeProviders {
      async getAccountUsage(provider: 'codex' | 'claude'): Promise<ProviderAccountUsageSnapshot> {
        reads++;
        return { provider, usage: usage(provider), reset: { mode: 'native', snapshotToken: 'fresh', externalUrl: null, reason: null } };
      }
      redeemAccountUsageReset(): Promise<ProviderResetResult> { return resetGate.promise; }
    }
    const app = await startTestApp({ fake: new FencedFake(), exampleWorkspace: false }); apps.push(app);
    const firstKey = randomUUID();
    const input = { idempotencyKey: firstKey, snapshotToken: 'lease' };
    const first = app.app.providers.redeemAccountUsageReset('codex', 'lease', input);
    const duplicate = app.app.providers.redeemAccountUsageReset('codex', 'lease', input);
    const different = await app.app.providers.redeemAccountUsageReset('codex', 'lease', { ...input, idempotencyKey: randomUUID() });
    expect(different.notice).toMatch(/another reset action/i);
    const read = app.app.providers.accountUsage('codex');
    await Promise.resolve();
    expect(reads).toBe(0);
    resetGate.resolve({ outcome: 'reset', snapshot: null, notice: null });
    const [one, same] = await Promise.all([first, duplicate]);
    expect(same).toBe(one);
    expect((await read).reset.snapshotToken).toBe('fresh');
    expect(reads).toBe(1);
  });
});

describe('Codex earned reset RPC boundary', () => {
  it('validates the latest native grant, consumes only on explicit redemption, and returns a fresh read', async () => {
    const rpc = scriptedConnect();
    const native = new CodexAccountUsage(rpc.connect);
    const first = await native.read(settings());
    expect(first.usage.windows.map((row) => row.windowMinutes)).toEqual([300, 10080]);
    expect(first.reset.mode).toBe('native');
    expect(rpc.calls.map((row) => row.method)).toEqual(['account/read', 'account/rateLimits/read']);
    const result = await native.redeem(settings(), first.reset.snapshotToken!, { idempotencyKey: randomUUID(), snapshotToken: first.reset.snapshotToken!, creditId: 'credit-1' });
    expect(result).toMatchObject({ outcome: 'reset', snapshot: { provider: 'codex' }, notice: null });
    expect(rpc.calls.map((row) => row.method)).toEqual(['account/read', 'account/rateLimits/read', 'account/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume', 'account/read', 'account/rateLimits/read']);
    expect(rpc.calls.find((row) => row.method === 'account/rateLimitResetCredit/consume')?.params).toMatchObject({ creditId: 'credit-1' });
  });

  it('retries an uncertain consume with exactly the same UUID and selection', async () => {
    let consumeCount = 0;
    const rpc = scriptedConnect({ consume: () => { consumeCount++; if (consumeCount === 1) throw new Error('timeout with private RPC detail'); return { outcome: 'alreadyRedeemed' }; } });
    const native = new CodexAccountUsage(rpc.connect);
    const first = await native.read(settings());
    const idempotencyKey = randomUUID();
    const args = { idempotencyKey, snapshotToken: first.reset.snapshotToken!, creditId: 'credit-1' };
    const uncertain = await native.redeem(settings(), args.snapshotToken, args);
    expect(uncertain.notice).toContain('same request key');
    expect(uncertain.notice).not.toContain('private RPC detail');
    expect((await native.redeem(settings(), args.snapshotToken, { ...args, creditId: 'another-credit' })).notice).toMatch(/different selection/i);
    expect((await native.redeem(settings(), args.snapshotToken, { ...args, idempotencyKey: randomUUID() })).notice).toMatch(/previous Codex reset result/i);
    expect((await native.redeem(settings(), args.snapshotToken, args)).outcome).toBe('alreadyRedeemed');
    expect(consumeCount).toBe(2);
    expect(rpc.calls.filter((row) => row.method === 'account/rateLimitResetCredit/consume').map((row) => row.params)).toEqual([
      { idempotencyKey, creditId: 'credit-1' }, { idempotencyKey, creditId: 'credit-1' },
    ]);
  });

  it('blocks stale account, expired or unknown selected grants, key reuse with a different selection, and unknown-count redemption', async () => {
    const rpc = scriptedConnect({ creditRows: [{ id: 'expired', status: 'available', expiresAt: 1 }] });
    const native = new CodexAccountUsage(rpc.connect);
    const first = await native.read(settings());
    const key = randomUUID();
    const invalid = await native.redeem(settings(), first.reset.snapshotToken!, { idempotencyKey: key, snapshotToken: first.reset.snapshotToken!, creditId: 'expired' });
    expect(invalid.outcome).toBe('noCredit');
    expect(rpc.calls.some((row) => row.method === 'account/rateLimitResetCredit/consume')).toBe(false);

    let activeAccount = 'account-a';
    const accountRpc = scriptedConnect({ account: 'account-a' });
    const accountNative = new CodexAccountUsage(async (config) => {
      const conn = await accountRpc.connect(config);
      return { ...conn, request(method, params, timeout) {
        if (method === 'account/read') return Promise.resolve({ account: { id: activeAccount, type: 'chatgpt' } });
        return conn.request(method, params, timeout);
      } };
    });
    const snapshot = await accountNative.read(settings());
    // Change account between snapshot acquisition and the explicit action.
    activeAccount = 'account-b';
    const stale = await accountNative.redeem(settings(), snapshot.reset.snapshotToken!, { idempotencyKey: randomUUID(), snapshotToken: snapshot.reset.snapshotToken! });
    expect(stale.notice).toMatch(/account changed/i);

    const noDetails = scriptedConnect({ creditRows: null });
    const countOnly = new CodexAccountUsage(noDetails.connect);
    const countSnapshot = await countOnly.read(settings());
    const selected = await countOnly.redeem(settings(), countSnapshot.reset.snapshotToken!, { idempotencyKey: randomUUID(), snapshotToken: countSnapshot.reset.snapshotToken!, creditId: 'unverified' });
    expect(selected.notice).toMatch(/no longer exposes reset details/i);
    expect(noDetails.calls.some((row) => row.method === 'account/rateLimitResetCredit/consume')).toBe(false);

    const idOnly = scriptedConnect({ creditRows: null });
    const countOnlyWithoutDetails = new CodexAccountUsage(idOnly.connect);
    const countLease = await countOnlyWithoutDetails.read(settings());
    const countResult = await countOnlyWithoutDetails.redeem(settings(), countLease.reset.snapshotToken!, { idempotencyKey: randomUUID(), snapshotToken: countLease.reset.snapshotToken! });
    expect(countResult.outcome).toBe('reset');
    expect(idOnly.calls.some((row) => row.method === 'account/rateLimitResetCredit/consume')).toBe(true);

    const changedSettings = new CodexAccountUsage(scriptedConnect().connect);
    const settingsLease = await changedSettings.read(settings());
    expect((await changedSettings.redeem({ ...settings(), codexExecutable: '/other/codex' }, settingsLease.reset.snapshotToken!, { idempotencyKey: randomUUID(), snapshotToken: settingsLease.reset.snapshotToken! })).notice).toMatch(/expired|settings changed/i);

    const unknownCount = scriptedConnect({ count: null });
    const noAuthoritativeCount = new CodexAccountUsage(unknownCount.connect);
    expect((await noAuthoritativeCount.read(settings())).reset.mode).toBe('unavailable');
    expect(unknownCount.calls.some((row) => row.method === 'account/rateLimitResetCredit/consume')).toBe(false);
  });

  it('preserves each provider-confirmed outcome and returns only a follow-up native snapshot', async () => {
    for (const outcome of ['alreadyRedeemed', 'nothingToReset', 'noCredit'] as const) {
      const rpc = scriptedConnect({ consume: () => ({ outcome }) });
      const native = new CodexAccountUsage(rpc.connect);
      const snapshot = await native.read(settings());
      const result = await native.redeem(settings(), snapshot.reset.snapshotToken!, { idempotencyKey: randomUUID(), snapshotToken: snapshot.reset.snapshotToken! });
      expect(result).toMatchObject({ outcome, snapshot: { usage: { windows: expect.any(Array) } }, notice: null });
    }
  });

  it('coalesces duplicate clicks, fences a second key, and preserves confirmed outcomes when the follow-up read fails', async () => {
    const waitConsume = deferred<unknown>();
    let consumeCount = 0;
    let connectCount = 0;
    const scripted = scriptedConnect({ consume: () => { consumeCount++; return waitConsume.promise; } });
    const connect: CodexAccountUsageConnect = async (config) => {
      connectCount++;
      if (connectCount >= 3) return { request: async (method) => { if (method === 'account/read') throw new Error('private account diagnostic'); throw new Error('unreachable'); }, close: async () => true };
      return scripted.connect(config);
    };
    const native = new CodexAccountUsage(connect);
    const snapshot = await native.read(settings());
    const idempotencyKey = randomUUID();
    const args = { idempotencyKey, snapshotToken: snapshot.reset.snapshotToken! };
    const one = native.redeem(settings(), args.snapshotToken, args);
    const duplicate = native.redeem(settings(), args.snapshotToken, args);
    const secondKey = await native.redeem(settings(), args.snapshotToken, { ...args, idempotencyKey: randomUUID() });
    expect(secondKey.notice).toMatch(/another Codex reset action/i);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consumeCount).toBe(1);
    waitConsume.resolve({ outcome: 'reset' });
    const [first, same] = await Promise.all([one, duplicate]);
    expect(first.outcome).toBe('reset');
    expect(same).toBe(first);
    expect(first.snapshot).toBeNull();
    expect(first.notice).toMatch(/fresh usage read failed/i);
  });
});
