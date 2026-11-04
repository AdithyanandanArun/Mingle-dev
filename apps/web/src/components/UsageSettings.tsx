import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountUsageProvider, ProviderAccountUsageSnapshot, ProviderResetResult, RedeemProviderResetInput, UsageResetGrant, UsageWindow } from '@mingle/contracts';
import { ArrowUpRight, Check, Clock3, Coins, RotateCcw, ShieldAlert } from 'lucide-react';
import { ApiError, api, errorMessage } from '../lib/api';
import { useMingle } from '../store/store';
import { ProviderMark } from './ui';
import { clearUsageResetAttempt, loadUsageResetAttempt, saveUsageResetAttempt } from '../lib/usageResetAttempt';
import './usage-settings.css';

const PROVIDERS: readonly AccountUsageProvider[] = ['codex', 'claude'];
const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage';
const REFRESH_COOLDOWN_MS = 5_000;

type RedemptionAttempt = RedeemProviderResetInput & { uncertain?: boolean };
interface ProviderState {
  snapshot: ProviderAccountUsageSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  resetMessage: string | null;
  resetKind: 'success' | 'info' | 'error' | null;
  pending: { creditId?: string; label: string; expiresAt?: string | null } | null;
  attempt: RedemptionAttempt | null;
  redeeming: boolean;
  redeemError: string | null;
  lastRefreshAt: number;
}

const initialState = (provider: AccountUsageProvider): ProviderState => ({
  snapshot: null, loading: true, refreshing: false, error: null, resetMessage: null, resetKind: null,
  pending: null, attempt: (() => { const saved = loadUsageResetAttempt(provider); return saved ? { ...saved, uncertain: true } : null; })(), redeeming: false, redeemError: null, lastRefreshAt: 0,
});

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Not reported';
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`;
}

function formatDate(value: string | null, now: number): { exact: string; relative: string; passed: boolean } | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const exact = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(date);
  const delta = date.getTime() - now;
  const seconds = Math.ceil(Math.abs(delta) / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  const parts = days ? [`${days}d`, `${hours}h`] : hours ? [`${hours}h`, `${minutes}m`] : minutes ? [`${minutes}m`, `${remainder}s`] : [`${remainder}s`];
  return { exact, relative: delta >= 0 ? `in ${parts.join(' ')}` : `${parts.join(' ')} ago`, passed: delta < 0 };
}

function DateLabel({ value, now, past }: { value: string | null; now: number; past?: string }) {
  const date = formatDate(value, now);
  if (!date) return <span className="usage-settings__muted">Timing not reported</span>;
  return <span className="usage-settings__date"><time dateTime={value ?? undefined}>{date.exact}</time><span>{date.passed && past ? past : date.relative}</span></span>;
}

function durationLabel(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes === 300) return '5-hour window';
  if (minutes === 10_080) return '7-day window';
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

function UsageMeter({ item, now }: { item: UsageWindow; now: number }) {
  const validRemaining = item.remainingPercent !== null && Number.isFinite(item.remainingPercent);
  const visual = validRemaining ? Math.max(0, Math.min(100, item.remainingPercent!)) : null;
  const duration = durationLabel(item.windowMinutes);
  return <article className="usage-settings__window">
    <div className="usage-settings__window-head">
      <div><h3>{item.label || 'Usage window'}</h3><p>{[duration, item.scope].filter(Boolean).join(' · ') || 'Window duration and scope not reported'}</p></div>
      <span className="usage-settings__window-mark" aria-hidden="true">{visual === null ? '—' : `${Math.round(visual)}% left`}</span>
    </div>
    <div className="usage-settings__meter" role={visual === null ? undefined : 'meter'} aria-label={`${item.label} remaining`} aria-valuemin={visual === null ? undefined : 0} aria-valuemax={visual === null ? undefined : 100} aria-valuenow={visual ?? undefined} aria-valuetext={visual === null ? undefined : `${formatPercent(item.remainingPercent)} remaining`}>
      {visual !== null ? <span style={{ width: `${visual}%` }} /> : <span className="usage-settings__meter-unknown" />}
    </div>
    <div className="usage-settings__window-values">
      <span><strong>{formatPercent(item.usedPercent)}</strong><small>used</small></span>
      <span><strong>{formatPercent(item.remainingPercent)}</strong><small>remaining</small></span>
    </div>
    <div className="usage-settings__reset-time"><span>Resets</span><DateLabel value={item.resetAt} now={now} past="Reset time passed · refresh to recheck" /></div>
  </article>;
}

function GrantRow({ grant, now, busy, onUse }: { grant: UsageResetGrant; now: number; busy: boolean; onUse: (grant: UsageResetGrant) => void }) {
  const expiration = formatDate(grant.expiresAt, now);
  const expired = expiration?.passed === true;
  return <div className={`usage-settings__grant${expired ? ' is-expired' : ''}`}>
    <div className="usage-settings__grant-main"><strong>{grant.label}</strong><span>{grant.expiresAt ? <>Expires <DateLabel value={grant.expiresAt} now={now} /></> : 'Expiry not reported'}</span><small>{grant.grantedAt ? <>Granted <DateLabel value={grant.grantedAt} now={now} /></> : 'Grant date not reported'}</small></div>
    <button type="button" className="usage-settings__button usage-settings__button--quiet" disabled={busy || expired} onClick={() => onUse(grant)}>{expired ? 'Expired' : 'Use this reset'}</button>
  </div>;
}

function newIdempotencyKey(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error('Secure random UUID generation is unavailable.');
  return globalThis.crypto.randomUUID();
}

function outcomeCopy(result: ProviderResetResult, hasFreshSnapshot: boolean): { text: string; kind: 'success' | 'info' } {
  const latest = hasFreshSnapshot ? 'The latest usage snapshot is shown.' : 'The latest usage could not be loaded; refresh to check current limits.';
  switch (result.outcome) {
    case 'reset': return { text: `Reset used. ${latest}`, kind: 'success' };
    case 'alreadyRedeemed': return { text: `This reset was already used. ${latest}`, kind: 'info' };
    case 'nothingToReset': return { text: `Codex reports there is nothing to reset right now. ${latest}`, kind: 'info' };
    case 'noCredit': return { text: `Codex reports that no reset credit is available. ${latest}`, kind: 'info' };
  }
}

function ProviderUsage({ provider, now }: { provider: AccountUsageProvider; now: number }) {
  const providerInfo = useMingle((store) => store.boot?.providers.find((item) => item.id === provider));
  const [state, setState] = useState<ProviderState>(() => {
    const initial = initialState(provider);
    return initial.attempt ? { ...initial, resetMessage: 'A previous reset result is unconfirmed. Retry the same attempt to check it; usage refresh alone does not confirm redemption.', resetKind: 'error' } : initial;
  });
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const inFlightRef = useRef(false);
  const attemptRef = useRef<RedemptionAttempt | null>(state.attempt);
  const mountedRef = useRef(false);
  const [confirmationRef, setConfirmationRef] = useState<HTMLDivElement | null>(null);
  const confirmationTriggerRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async (refresh: boolean, afterRedemption = false) => {
    const last = stateRef.current.lastRefreshAt;
    if (refresh && !afterRedemption && Date.now() - last < REFRESH_COOLDOWN_MS) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const generation = ++generationRef.current;
    const prior = stateRef.current;
    stateRef.current = { ...prior, loading: !prior.snapshot, refreshing: Boolean(prior.snapshot), error: null, lastRefreshAt: refresh ? Date.now() : prior.lastRefreshAt };
    setState(stateRef.current);
    try {
      const snapshot = await api.providerAccountUsage(provider, refresh, controller.signal);
      if (controller.signal.aborted || generation !== generationRef.current || !mountedRef.current) return;
      stateRef.current = { ...stateRef.current, snapshot, loading: false, refreshing: false, error: null };
      setState(stateRef.current);
    } catch (cause) {
      if (controller.signal.aborted || generation !== generationRef.current || !mountedRef.current) return;
      stateRef.current = { ...stateRef.current, loading: false, refreshing: false, error: errorMessage(cause) };
      setState(stateRef.current);
    }
  // stateRef intentionally owns the synchronous request snapshot, avoiding closure races between refreshes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    mountedRef.current = true;
    void load(false);
    return () => {
      mountedRef.current = false;
      generationRef.current++;
      requestRef.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (state.pending) confirmationRef?.focus();
  }, [state.pending, confirmationRef]);

  const setPatch = useCallback((patch: Partial<ProviderState>) => {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    setState(next);
  }, []);

  const beginConfirmation = (label: string, creditId?: string, expiresAt?: string | null) => {
    if (attemptRef.current || inFlightRef.current) return;
    if (!state.snapshot || state.snapshot.reset.mode !== 'native' || !state.snapshot.reset.snapshotToken) return;
    if (expiresAt && formatDate(expiresAt, Date.now())?.passed) return;
    confirmationTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    attemptRef.current = null;
    setPatch({ pending: { label, ...(creditId ? { creditId } : {}), ...(expiresAt ? { expiresAt } : {}) }, attempt: null, redeemError: null });
  };

  const cancelConfirmation = () => {
    attemptRef.current = null;
    setPatch({ pending: null, attempt: null, redeemError: null });
    requestAnimationFrame(() => { if (confirmationTriggerRef.current?.isConnected) confirmationTriggerRef.current.focus(); });
  };

  const redeem = async (retry = false) => {
    if (inFlightRef.current) return;
    const current = stateRef.current;
    const pending = current.pending;
    let attempt = retry ? attemptRef.current : null;
    if (!attempt) {
      if (retry || !current.snapshot || current.snapshot.reset.mode !== 'native' || !pending) return;
      const snapshotToken = current.snapshot.reset.snapshotToken;
      if (!snapshotToken) return;
      attempt = { idempotencyKey: newIdempotencyKey(), snapshotToken, ...(pending.creditId ? { creditId: pending.creditId } : {}) };
      saveUsageResetAttempt(provider, attempt);
      attemptRef.current = attempt;
    }
    requestRef.current?.abort();
    generationRef.current++;
    inFlightRef.current = true;
    setPatch({ redeeming: true, redeemError: null, resetMessage: null, resetKind: null, pending: null, snapshot: null, loading: false, refreshing: false });
    // An aborted renderer request cannot prove that the provider action stopped. Keep the attempt for an explicit same-key retry.
    try {
      const { idempotencyKey, snapshotToken, creditId } = attempt;
      const input: RedeemProviderResetInput = { idempotencyKey, snapshotToken, ...(creditId ? { creditId } : {}) };
      const result = await api.redeemProviderReset(provider, input);
      if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(result.outcome)) throw new Error('The provider reset result was not recognized.');
      clearUsageResetAttempt(provider, input.idempotencyKey);
      if (!mountedRef.current) return;
      const copy = outcomeCopy(result, Boolean(result.snapshot));
      attemptRef.current = null;
      setPatch({ redeeming: false, attempt: null, redeemError: null, resetMessage: result.notice ? `${copy.text} ${result.notice}` : copy.text, resetKind: copy.kind, snapshot: result.snapshot, error: null });
    } catch (cause) {
      const rejectedBeforeDispatch = cause instanceof ApiError && (cause.status === 409 || cause.status === 501) && !retry;
      if (rejectedBeforeDispatch) clearUsageResetAttempt(provider, attempt.idempotencyKey);
      if (!mountedRef.current) return;
      if (rejectedBeforeDispatch) {
        attemptRef.current = null;
        setPatch({ redeeming: false, attempt: null, pending: null, redeemError: null, resetMessage: errorMessage(cause), resetKind: 'info', snapshot: null });
        void load(true, true);
        return;
      }
      attempt = { ...attempt, uncertain: true };
      attemptRef.current = attempt;
      setPatch({ redeeming: false, attempt, redeemError: errorMessage(cause), resetMessage: 'The result is unknown. The reset may have been used. Retry only to check the same attempt; Mingle will reuse its request ID.', resetKind: 'error' });
    } finally {
      inFlightRef.current = false;
    }
  };

  const onRefresh = () => {
    if (inFlightRef.current) return;
    setPatch({ pending: null, ...(!attemptRef.current ? { redeemError: null, resetMessage: null, resetKind: null } : {}) });
    void load(true);
  };

  const snapshot = state.snapshot;
  const usage = snapshot?.usage;
  const resets = usage?.resets;
  // Native Codex labels even its main bucket with a scope. It belongs on the page, alongside unscoped Claude limits.
  const isPrimary = (item: UsageWindow) => !item.scope || provider === 'codex' && (item.id.startsWith('codex:') || item.scope.toLowerCase() === 'codex');
  const primaryWindows = usage?.windows.filter(isPrimary) ?? [];
  const scopedWindows = usage?.windows.filter((item) => !isPrimary(item)) ?? [];
  const hasGrants = Boolean(resets?.grants.length);
  const canRedeem = provider === 'codex' && snapshot?.reset.mode === 'native' && Boolean(snapshot.reset.snapshotToken) && !state.attempt;
  const countAvailable = resets?.available !== null && resets?.available !== undefined && resets.available > 0;
  const cooldown = Math.max(0, REFRESH_COOLDOWN_MS - (Date.now() - state.lastRefreshAt));
  const busy = state.redeeming || state.refreshing || state.loading;
  const title = provider === 'codex' ? 'Codex' : 'Claude';
  const status = usage?.status;
  const pendingExpired = Boolean(state.pending?.expiresAt && formatDate(state.pending.expiresAt, now)?.passed);

  return <section className="usage-settings__provider" aria-labelledby={`usage-${provider}-title`}>
    <header className="usage-settings__provider-head">
      <div className="usage-settings__provider-id"><span className={`usage-settings__provider-mark usage-settings__provider-mark--${provider}`} aria-hidden="true"><ProviderMark provider={provider} size={19} /></span><div><h2 id={`usage-${provider}-title`}>{title}</h2><p>{usage?.plan ? `${usage.plan} · ` : ''}Account usage</p><small className="usage-settings__runtime">{providerInfo ? `Provider runtime ${providerInfo.available ? 'available' : 'unavailable'}${providerInfo.version ? ` · ${providerInfo.version}` : ''}` : 'Provider runtime status not reported'}</small></div></div>
      <div className="usage-settings__provider-actions"><span className={`usage-settings__status${status ? ` is-${status}` : ''}`}>{state.loading && !usage ? 'Loading' : status === 'available' ? 'Available' : status === 'partial' ? 'Partial data' : status === 'unavailable' ? 'Unavailable' : 'Not loaded'}</span>
        <button type="button" className="usage-settings__button" onClick={onRefresh} disabled={busy || cooldown > 0} aria-label={`Refresh ${title} usage`} title={cooldown > 0 ? `Refresh available in ${Math.ceil(cooldown / 1000)} seconds` : `Refresh ${title} usage`}><RotateCcw size={14} className={state.refreshing ? 'is-refreshing' : undefined} /><span>{state.refreshing ? 'Refreshing…' : cooldown > 0 && usage ? `Refresh in ${Math.ceil(cooldown / 1000)}s` : 'Refresh'}</span></button>
      </div>
    </header>
    {!providerInfo?.available && providerInfo?.reason ? <p className="usage-settings__runtime-reason">{providerInfo.reason}</p> : null}
    {state.error ? <div className="usage-settings__alert" role="alert"><strong>{usage ? 'Could not refresh usage.' : 'Could not load usage.'}</strong><span>{state.error}</span><span>{usage ? 'The last successful snapshot is still shown.' : 'Try refreshing when the local provider connection is available.'}</span></div> : null}
    {state.resetMessage ? <div className={`usage-settings__alert is-${state.resetKind}`} role={state.resetKind === 'error' ? 'alert' : 'status'}><strong>{state.resetKind === 'success' ? <Check size={15} /> : state.resetKind === 'error' ? <ShieldAlert size={15} /> : null}{state.resetMessage}</strong>{state.redeemError ? <span>{state.redeemError}</span> : null}{state.attempt?.uncertain ? <button type="button" className="usage-settings__button usage-settings__button--quiet" disabled={state.redeeming} onClick={() => void redeem(true)}>{state.redeeming ? 'Checking…' : 'Retry same attempt'}</button> : null}</div> : null}
    {state.loading && !usage ? <div className="usage-settings__loading" role="status"><span className="usage-settings__spinner" />Loading account usage…</div> : null}
    {usage ? <>
      <div className="usage-settings__updated"><span>{usage.fetchedAt ? <>Updated <DateLabel value={usage.fetchedAt} now={now} /></> : 'Update time not reported'}</span><span>{snapshot?.reset.mode === 'native' ? 'Reset controls available in Mingle' : snapshot?.reset.mode === 'external' ? 'Manage resets with the provider' : 'Reset action unavailable'}</span></div>
      {usage.windows.length ? <>
        {primaryWindows.length ? <div className="usage-settings__windows">{primaryWindows.map((item) => <UsageMeter key={item.id} item={item} now={now} />)}</div> : null}
        {scopedWindows.length ? <details className="usage-settings__scoped" open={primaryWindows.length ? undefined : true}><summary>Additional scoped limits <span>{scopedWindows.length}</span></summary><div className="usage-settings__windows">{scopedWindows.map((item) => <UsageMeter key={item.id} item={item} now={now} />)}</div></details> : null}
      </> : <div className="usage-settings__empty"><Clock3 size={16} /><span>{status === 'unavailable' ? 'Account usage is unavailable for this provider.' : 'No usage windows were reported.'}</span></div>}
      {usage.credits || usage.resets ? <div className="usage-settings__details">
        {usage.credits ? <section className="usage-settings__detail"><h3><Coins size={14} /> Credits</h3><dl><div><dt>Balance</dt><dd>{usage.credits.unlimited === true ? 'Unlimited' : usage.credits.balance === null ? 'Not reported' : `${usage.credits.balance}${usage.credits.unit ? ` ${usage.credits.unit}` : ''}`}</dd></div><div><dt>Credit reset</dt><dd><DateLabel value={usage.credits.resetAt} now={now} past="Time passed · refresh to recheck" /></dd></div></dl></section> : null}
        {usage.resets ? <section className="usage-settings__detail"><h3><RotateCcw size={14} /> Reset credits</h3><dl><div><dt>Available</dt><dd>{usage.resets.available === null ? 'Not reported' : usage.resets.available}</dd></div><div><dt>Next replenishment</dt><dd><DateLabel value={usage.resets.replenishesAt} now={now} past="Time passed · refresh to recheck" /></dd></div></dl>
          <div className="usage-settings__grants"><h4>Banked resets</h4>{hasGrants ? usage.resets.grants.map((grant) => <GrantRow key={grant.id} grant={grant} now={now} busy={busy || !canRedeem} onUse={(selected) => beginConfirmation(selected.label, selected.id, selected.expiresAt)} />) : <p className="usage-settings__muted">{usage.resets.detailsKnown ? 'No banked reset grants.' : 'Individual grant details are not reported.'}</p>}
            {canRedeem && countAvailable ? <button type="button" className="usage-settings__button usage-settings__button--wide" disabled={busy} onClick={() => beginConfirmation('one available reset')}>Use one available reset</button> : null}
          </div>
        </section> : null}
      </div> : <div className="usage-settings__empty"><Coins size={16} /><span>{status === 'unavailable' ? 'Credit and reset details are unavailable.' : 'Credits and reset details were not reported.'}</span></div>}
      {usage.notices.length ? <ul className="usage-settings__notices" aria-label={`${title} usage notes`}>{usage.notices.map((notice, index) => <li key={`${index}:${notice}`}>{notice}</li>)}</ul> : null}
      {snapshot?.reset.reason ? <p className="usage-settings__reset-reason">{snapshot.reset.reason}</p> : null}
    </> : state.error ? null : null}
    {provider === 'claude' ? <div className="usage-settings__external"><div><strong>Manage Claude resets</strong><p>Claude handles reset management on its own Usage page. This opens Claude in a new tab.</p></div><a href={CLAUDE_USAGE_URL} target="_blank" rel="noopener noreferrer">Open Claude Usage <ArrowUpRight size={14} aria-hidden="true" /></a></div> : null}
    {state.pending ? <div className="usage-settings__confirm" ref={setConfirmationRef} tabIndex={-1} role="group" aria-label="Confirm Codex reset" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); cancelConfirmation(); } }}>
      <strong>{pendingExpired ? 'This reset grant has expired' : `Use ${state.pending.label}?`}</strong><p>{pendingExpired ? 'Refresh the account details to see current reset availability.' : 'This consumes one Codex usage reset credit. It cannot be undone, and it does not buy anything.'}</p>
      <div><button type="button" className="usage-settings__button usage-settings__button--danger" disabled={state.redeeming || pendingExpired} onClick={() => void redeem()}>Use one reset</button><button type="button" className="usage-settings__button usage-settings__button--quiet" disabled={state.redeeming} onClick={cancelConfirmation}>Cancel</button></div>
    </div> : null}
  </section>;
}

/** Account limits for Codex and Claude, independent of any active project or session. */
export function UsageSettings() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <main className="usage-settings">
    <header className="usage-settings__intro"><div><p className="usage-settings__eyebrow">Settings / Usage</p><h1>Usage</h1><p>Account limits and reset credits for your connected provider apps. Usage is read on this page and when you refresh.</p></div></header>
    <div className="usage-settings__provider-list">{PROVIDERS.map((provider) => <ProviderUsage key={provider} provider={provider} now={now} />)}</div>
    <p className="usage-settings__footnote">Usage and availability come from each provider. Mingle does not estimate unreported limits or combine separate usage windows.</p>
  </main>;
}

export default UsageSettings;
