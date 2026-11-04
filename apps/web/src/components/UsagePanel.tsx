import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRetainedPresence } from '../lib/motion';
import { Clock3, Coins, RefreshCw, RotateCcw, X } from 'lucide-react';
import type { Session, SessionUsage, UsageResetGrant, UsageWindow } from '@mingle/contracts';
import { api, errorMessage } from '../lib/api';
import { PROVIDER_NAME } from './ui';

const REFRESH_COOLDOWN_MS = 15_000;
const lastUsageRequestAt = new Map<string, number>();

function localDate(value: string | null, now: number): { exact: string; relative: string } | null {
  if (!value) return null;
  const date = new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return null;
  const exact = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(date);
  const delta = timestamp - now;
  const seconds = Math.ceil(Math.abs(delta) / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  const parts = days ? [`${days}d`, `${hours}h`] : hours ? [`${hours}h`, `${minutes}m`] : minutes ? [`${minutes}m`, `${remainder}s`] : [`${remainder}s`];
  return { exact, relative: delta >= 0 ? `in ${parts.join(' ')}` : `${parts.join(' ')} ago` };
}

function percent(value: number | null): string {
  return value === null ? 'Not reported' : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`;
}

function tokenCount(value: number): string {
  return Number.isFinite(value) ? Math.max(0, value).toLocaleString() : 'Not reported';
}

function cost(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'Not reported' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(value);
}

function DateValue({ value, now, passedLabel }: { value: string | null; now: number; passedLabel?: string }) {
  const date = localDate(value, now);
  if (!date) return <span className="usage__unknown">Timing not reported</span>;
  const passed = date.relative.endsWith('ago');
  return <span className="usage__date"><time dateTime={value ?? undefined}>{date.exact}</time><span>{passed && passedLabel ? passedLabel : date.relative}</span></span>;
}

function LimitWindow({ item, now }: { item: UsageWindow; now: number }) {
  const meterPercent = item.usedPercent === null ? null : Math.max(0, Math.min(100, item.usedPercent));
  return <article className="usage-window">
    <div className="usage-window__heading"><div><h3>{item.label}</h3>{item.scope ? <p>{item.scope}</p> : null}</div></div>
    <div className="usage-window__values">
      <span><strong>{percent(item.usedPercent)}</strong> used</span>
      <span><strong>{percent(item.remainingPercent)}</strong> left</span>
    </div>
    <div className="usage-window__track" role={meterPercent === null ? undefined : 'meter'} aria-label={`${item.label} used`} aria-valuemin={meterPercent === null ? undefined : 0} aria-valuemax={meterPercent === null ? undefined : 100} aria-valuenow={meterPercent ?? undefined} aria-valuetext={meterPercent === null ? undefined : `${percent(item.usedPercent)} used`}>
      {meterPercent !== null ? <span style={{ width: `${meterPercent}%` }} /> : null}
    </div>
    <div className="usage-window__reset"><span>Resets</span>{item.resetAt ? <DateValue value={item.resetAt} now={now} passedLabel="Reset time passed—refresh" /> : <span className="usage__unknown">Timing not reported</span>}</div>
  </article>;
}

function CreditDetails({ usage, now }: { usage: SessionUsage; now: number }) {
  const credits = usage.credits;
  if (!credits) return <p className="usage__unknown">Credit balance and reset timing not reported.</p>;
  return <dl className="usage__facts">
    <div><dt>Balance</dt><dd>{credits.unlimited === true ? 'Unlimited' : credits.balance === null ? 'Not reported' : `${credits.balance}${credits.unit ? ` ${credits.unit}` : ''}`}</dd></div>
    <div><dt>Credit reset</dt><dd>{credits.resetAt ? <DateValue value={credits.resetAt} now={now} passedLabel="Reset time passed—refresh" /> : 'Timing not reported'}</dd></div>
  </dl>;
}

function ResetDetails({ usage, now }: { usage: SessionUsage; now: number }) {
  const resets = usage.resets;
  if (!resets) return <p className="usage__unknown">Reset information not reported.</p>;
  return <>
    <dl className="usage__facts">
      <div><dt>Available resets</dt><dd>{resets.available === null ? 'Not reported' : resets.available}</dd></div>
      <div><dt>Replenishes</dt><dd>{resets.replenishesAt ? <DateValue value={resets.replenishesAt} now={now} passedLabel="Replenishment time passed—refresh" /> : 'Replenishment timing not reported'}</dd></div>
    </dl>
    <div className="usage-resets">
      <h3>Banked reset grants</h3>
      {!resets.grants.length ? <p className="usage__unknown">{resets.detailsKnown ? 'No banked grants reported.' : 'Grant details not reported.'}</p> : resets.grants.map((grant) => <Grant key={grant.id} grant={grant} now={now} />)}
    </div>
  </>;
}

function Grant({ grant, now }: { grant: UsageResetGrant; now: number }) {
  return <div className="usage-grant">
    <strong>{grant.label}</strong>
    <div>{grant.expiresAt ? <>Expires <DateValue value={grant.expiresAt} now={now} /></> : <span className="usage__unknown">Expiry not reported</span>}</div>
    <small>{grant.grantedAt ? <>Granted <DateValue value={grant.grantedAt} now={now} /></> : 'Grant date not reported'}</small>
  </div>;
}

function SessionFacts({ usage }: { usage: SessionUsage }) {
  return <section className="usage-section usage-section--session">
    <header><div><h2>This session</h2><p>Cumulative conversation totals for this Mingle session; these are not current context occupancy.</p></div></header>
    <dl className="usage__facts usage__facts--session">
      <div><dt>Input tokens</dt><dd>{tokenCount(usage.session.inputTokens)}</dd></div>
      <div><dt>Output tokens</dt><dd>{tokenCount(usage.session.outputTokens)}</dd></div>
      <div><dt>Cost</dt><dd>{cost(usage.session.costUsd)}</dd></div>
    </dl>
  </section>;
}

function Dialog({ session, onClose, open, closing }: { session: Session; onClose: () => void; open: boolean; closing: boolean }) {
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const request = useRef<AbortController | null>(null);
  const hasUsage = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const key = session.provider;
  const lastRequest = lastUsageRequestAt.get(key) ?? 0;
  const refreshWait = Math.max(0, REFRESH_COOLDOWN_MS - (now - lastRequest));

  const load = useCallback(async (refresh: boolean) => {
    if (refresh) {
      const wait = REFRESH_COOLDOWN_MS - (Date.now() - (lastUsageRequestAt.get(key) ?? 0));
      if (wait > 0) { setNow(Date.now()); return; }
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    lastUsageRequestAt.set(key, Date.now());
    setNow(Date.now());
    setError(null);
    setLoading(!hasUsage.current);
    setRefreshing(refresh);
    try {
      const next = await api.sessionUsage(session.id, refresh, controller.signal);
      if (!controller.signal.aborted) { hasUsage.current = true; setUsage(next); }
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) { setLoading(false); setRefreshing(false); }
    }
  }, [key, session.id]);

  useEffect(() => {
    if (!open) { request.current?.abort(); return; }
    void load(false);
    return () => request.current?.abort();
  }, [load, open]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyDown);
    return () => {
      document.removeEventListener('keydown', keyDown);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  const cooldownLabel = Math.ceil(refreshWait / 1000);
  const canRefresh = refreshWait <= 0 && !refreshing && !loading;
  const fetched = usage ? localDate(usage.fetchedAt, now)?.exact ?? 'Updated time not reported' : null;
  const sharedLabel = usage?.provider ? `${PROVIDER_NAME[usage.provider]} account limits` : 'Provider account limits';
  const hasAccountDetails = Boolean(usage && (usage.windows.length || usage.credits || usage.resets));
  const requestRefresh = () => void load(true);

  return createPortal(
    <div className={`usage-backdrop${closing ? ' is-closing' : ''}`} role="presentation" aria-hidden={closing || undefined} inert={closing} onMouseDown={(event) => { if (!closing && event.target === event.currentTarget) onCloseRef.current(); }}>
      <section ref={dialogRef} className="usage-dialog" role="dialog" aria-modal="true" aria-labelledby="usage-title" aria-describedby="usage-subtitle">
        <header className="usage-dialog__head">
          <div><h1 id="usage-title">Usage</h1><p id="usage-subtitle">Account limits and this session’s conversation totals.</p></div>
          <div className="usage-dialog__actions">
            <button type="button" className="usage-refresh" onClick={requestRefresh} disabled={!canRefresh} title={canRefresh ? 'Refresh provider usage' : `Refresh available in ${cooldownLabel}s`}>
              <RefreshCw size={14} className={refreshing ? 'is-spinning' : undefined} />
              <span>{refreshing ? 'Refreshing…' : error ? 'Retry' : refreshWait > 0 ? `Refresh in ${cooldownLabel}s` : 'Refresh'}</span>
            </button>
            <button ref={closeRef} type="button" className="usage-close" aria-label="Close usage" onClick={onClose}><X size={16} /></button>
          </div>
        </header>
        <div className="usage-dialog__body">
          {loading && !usage ? <div className="usage-state" role="status"><span className="usage-spinner" /> Loading usage…</div> : null}
          {error ? <div className="usage-error" role="alert"><strong>Could not load usage.</strong><span>{error}</span><span>Try again when refresh is available.</span></div> : null}
          {usage ? <>
            <div className="usage-overview">
              <div><span className="usage-overview__provider">{PROVIDER_NAME[usage.provider]}{usage.plan ? ` · ${usage.plan}` : ''}</span><span className={`usage-status usage-status--${usage.status}`}>{usage.status === 'available' ? 'Available' : usage.status === 'partial' ? 'Some details unavailable' : 'Unavailable'}</span></div>
              <p>{fetched ? `Last updated ${fetched}` : 'Last updated time not reported'}</p>
            </div>
            <SessionFacts usage={usage} />
            <section className="usage-section">
              <header><div><h2>{sharedLabel}</h2><p>Limits can be shared with other apps using this provider account.</p></div><Clock3 size={15} aria-hidden="true" /></header>
              {!hasAccountDetails ? <p className="usage__unknown">{usage.status === 'unavailable' ? 'Account usage details are unavailable.' : 'No account usage limits, credits, or reset details were reported.'}</p> : null}
              {usage.windows.length ? <div className="usage-windows">{usage.windows.map((item) => <LimitWindow key={item.id} item={item} now={now} />)}</div> : null}
              <div className="usage-account-grid">
                <section className="usage-subsection"><h3><Coins size={14} /> Credits</h3><CreditDetails usage={usage} now={now} /></section>
                <section className="usage-subsection"><h3><RotateCcw size={14} /> Resets</h3><ResetDetails usage={usage} now={now} /></section>
              </div>
            </section>
            {usage.notices.length ? <section className="usage-notices" aria-label="Usage notes"><h2>Notes</h2><ul>{usage.notices.map((notice, index) => <li key={`${index}:${notice}`}>{notice}</li>)}</ul></section> : null}
          </> : null}
        </div>
        <footer className="usage-dialog__foot"><span>{session.name}</span><span>Usage details are provided by {PROVIDER_NAME[session.provider]}.</span></footer>
      </section>
    </div>,
    document.body,
  );
}

export function UsagePanel({ session, onClose }: { session: Session | null; onClose: () => void }) {
  const identity = session ? `${session.id}:${session.provider}:${session.model}` : null;
  const { present, closing, key } = useRetainedPresence(identity);
  const retainedSession = useRef(session);
  if (session) retainedSession.current = session;
  const displayedSession = session ?? retainedSession.current;
  return present && displayedSession ? <Dialog key={key} session={displayedSession} open={Boolean(session)} closing={closing} onClose={onClose} /> : null;
}
