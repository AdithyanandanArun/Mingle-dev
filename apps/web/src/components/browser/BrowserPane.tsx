import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, ExternalLink, Globe, Maximize2, Minimize2, Plus, RefreshCw, Scan, Unplug, X } from 'lucide-react';
import type { BrowserAction, BrowserSessionState, BrowserTab, Session } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { cx } from '../../lib/format';
import { usePresence, useRetainedPresence } from '../../lib/motion';
import { resolveTab, useBrowserStore } from '../../store/browser';
import { useMingle } from '../../store/store';
import { Button, EmptyState, IconButton, InlineError, Spinner } from '../ui';
import { BrowserConnect } from './BrowserConnect';
import { BrowserSignInButton, BrowserSigningInBanner } from './BrowserSignIn';
import { BrowserHost } from './BrowserHost';
import { BrowserSurface } from './BrowserSurface';
import { canOpenBrowserPopout, canShowEmbedded, dockBrowserPopout, focusBrowserPopout, isBrowserPopoutOpen, onBrowserPopoutClosed, openBrowserPopout } from './desktopBridge';
import { NativeBrowserView } from './NativeBrowserView';
import { useBrowserState, usePageVisible } from './useBrowserState';
import { useBrowserStream } from './useBrowserStream';

const LOCAL_SHORTCUTS = ['localhost:3000', 'localhost:5173', 'localhost:8080'];
const isLocalHost = (host: string) => host === 'localhost' || host.endsWith('.localhost') || /^(127|10)\.\d+\.\d+\.\d+$/.test(host) || /^192\.168\.\d+\.\d+$/.test(host) || host.startsWith('[');

/** Turns what the user typed into an address to open, or an explanation of why it cannot be one. */
export function toAddress(input: string): { url: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: 'Enter a web address.' };
  if (/^(https?:\/\/|about:)/i.test(raw)) {
    try { return { url: new URL(raw).toString() }; } catch { return { error: 'That is not a valid address.' }; }
  }
  if (/\s/.test(raw)) return { error: 'Enter a web address, such as example.com or localhost:3000.' };
  const host = raw.split(/[/:?#]/)[0] ?? '';
  if (!host.includes('.') && !isLocalHost(host)) return { error: 'Enter a web address, such as example.com or localhost:3000.' };
  try { return { url: new URL(`${isLocalHost(host) ? 'http' : 'https'}://${raw}`).toString() }; } catch { return { error: 'That is not a valid address.' }; }
}

const tabLabel = (tab: BrowserTab): string => {
  if (tab.title.trim()) return tab.title.trim();
  try { return new URL(tab.url).hostname || tab.url; } catch { return tab.url || 'New tab'; }
};

function controlLabel(tab: BrowserTab, clientId: string | null): { label: string; description: string } {
  if (tab.control.holderId === null) return { label: 'Agent is driving · click or type to step in', description: 'The agent is driving. Click or type to step in.' };
  if (tab.control.holderId === clientId) return tab.control.lease === 'hold'
    ? { label: 'You have control', description: 'You have control of this tab.' }
    : { label: 'You’re driving', description: 'You are driving this tab.' };
  return { label: 'Someone else is driving', description: 'Another person is driving this tab.' };
}

export function BrowserPane({ session, active, popout = false }: { session: Session; active: boolean; popout?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [floating, setFloating] = useState(false);
  const [detached, setDetached] = useState(false);
  const visible = active || expanded || floating;
  const { state, error: stateError, apply, refresh } = useBrowserState(session.id, visible);
  const selectedId = useBrowserStore((s) => s.selected[session.id]);
  const current = resolveTab(state, selectedId);
  const pageVisible = usePageVisible();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [nativeFallback, setNativeFallback] = useState(false);
  // A natively shown built-in tab needs no screencast unless an overlay forces the fallback surface.
  const nativeCandidate = Boolean(state?.mode === 'embedded' && canShowEmbedded() && current?.embeddedTargetId);
  const stream = useBrowserStream(session.id, current?.id, visible && pageVisible && Boolean(current) && !detached && (!nativeCandidate || nativeFallback), canvasRef);
  const tab = current && stream.tab && stream.tab.id === current.id ? stream.tab : current;
  const ownership = tab ? controlLabel(tab, stream.clientId) : { label: 'Watching', description: 'You are watching this tab.' };
  const embeddedNative = Boolean(state?.mode === 'embedded' && canShowEmbedded() && tab?.embeddedTargetId);
  const canInput = Boolean(tab && stream.status === 'live' && stream.clientId && (tab.control.holderId === null || tab.control.holderId === stream.clientId));
  const [leaseNow, setLeaseNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setLeaseNow(Date.now()), 250); return () => window.clearInterval(timer); }, []);
  const ownsLease = Boolean(tab && tab.control.holderId === stream.clientId);
  const leaseSeconds = tab?.control.expiresAt ? Math.max(0, Math.ceil((tab.control.expiresAt - leaseNow) / 1000)) : 0;

  useEffect(() => {
    if (popout || !canOpenBrowserPopout()) return;
    let alive = true;
    void isBrowserPopoutOpen(session.id).then((open) => { if (alive) setDetached(open); });
    const unsubscribe = onBrowserPopoutClosed((sessionId) => { if (alive && sessionId === session.id) setDetached(false); });
    return () => { alive = false; unsubscribe(); };
  }, [popout, session.id]);

  // Follow the agent to a tab it just activated, unless the user is driving the one they are on.
  const lastActive = useRef<string | null | undefined>(undefined);
  const canInputRef = useRef(canInput);
  canInputRef.current = canInput;
  const activeTabId = state?.activeTabId;
  useEffect(() => { lastActive.current = undefined; }, [session.id]);
  useEffect(() => {
    if (!state || state.status !== 'connected') return;
    const previous = lastActive.current;
    lastActive.current = activeTabId ?? null;
    if (previous !== undefined && previous !== (activeTabId ?? null) && !canInputRef.current) useBrowserStore.getState().select(session.id, null);
  }, [activeTabId, state, session.id]);
  useEffect(() => { if (state && state.status !== 'connected') setExpanded(false); }, [state]);

  const toast = useMingle.getState().toast;
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const { present: confirmPresent, closing: confirmClosing } = usePresence(Boolean(confirmClose));
  const confirmedTab = useRef<BrowserTab | null>(null);
  const confirmOpener = useRef<HTMLElement | null>(null);
  const previousConfirmClose = useRef<string | null>(null);
  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key); setActionError(null);
    try { await work(); } catch (cause) { setActionError(errorMessage(cause)); }
    finally { setBusy(null); }
  };

  const openTab = (url?: string) => run('tab', async () => {
    const created = await api.browserNewTab(session.id, url);
    useBrowserStore.getState().select(session.id, created.id);
    refresh();
  });
  // The server only lets the viewer that owns a tab close it, so closing is limited to the tab being controlled.
  useEffect(() => { if (confirmClose && (!canInput || confirmClose !== tab?.id)) setConfirmClose(null); }, [confirmClose, canInput, tab?.id]);
  useEffect(() => {
    if (!confirmClose && previousConfirmClose.current) {
      const target = confirmOpener.current?.isConnected ? confirmOpener.current : document.getElementById('browser-address');
      target?.focus({ preventScroll: true });
    }
    previousConfirmClose.current = confirmClose;
  }, [confirmClose]);
  const closeTab = (tabId: string) => run('close', async () => {
    setConfirmClose(null);
    if (!canInput || tabId !== tab?.id || !stream.clientId) throw new Error('Wait until the browser stream is live.');
    await api.browserAction(session.id, tabId, { type: 'close' }, stream.clientId);
    if (tabId === selectedId) useBrowserStore.getState().select(session.id, null);
    refresh();
  });
  const disconnect = () => run('disconnect', async () => {
    setExpanded(false);
    setFloating(false);
    apply(await api.browserDisconnect(session.id));
    useBrowserStore.getState().select(session.id, null);
  });
  const openDesktopWindow = async () => {
    setActionError(null);
    try {
      const opened = await openBrowserPopout(session.id);
      if (!opened) throw new Error('The desktop browser window could not be opened.');
      setExpanded(false);
      setFloating(false);
      setDetached(true);
    } catch (cause) { setActionError(errorMessage(cause)); }
  };
  const dockDesktopWindow = async () => {
    setActionError(null);
    try {
      const docked = await dockBrowserPopout(session.id);
      if (!docked) throw new Error('The desktop browser window is no longer available.');
    } catch (cause) { setActionError(errorMessage(cause)); }
  };
  const act = (action: BrowserAction) => {
    if (!canInput) { toast('info', 'Someone else is driving this tab.'); return; }
    if (!stream.sendInput(action)) setActionError('The browser stream is not connected. Reconnect and try again.');
  };
  const pageDialogIdentity = tab?.dialog ? `${tab.id}:${tab.dialog.type}:${tab.dialog.message}` : null;
  const { present: pageDialogPresent, closing: pageDialogClosing, key: pageDialogKey } = useRetainedPresence(pageDialogIdentity);
  const pageDialogSnapshot = useRef<{ tab: BrowserTab; canInput: boolean; act: (action: BrowserAction) => void } | null>(null);
  if (tab?.dialog) pageDialogSnapshot.current = { tab, canInput, act };
  const confirmedTarget = confirmClose ? state?.tabs.find((item) => item.id === confirmClose) : undefined;
  if (confirmedTarget) confirmedTab.current = confirmedTarget;

  const [draft, setDraft] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const submitAddress = (e: FormEvent) => {
    e.preventDefault();
    if (!tab) return;
    const result = toAddress(draft ?? tab.url);
    if ('error' in result) { setAddressError(result.error); return; }
    setAddressError(null);
    setDraft(null);
    act({ type: 'navigate', url: result.url });
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const fitViewport = () => {
    const stage = canvasRef.current?.parentElement;
    if (!stage) return;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
    act({ type: 'resize', width: clamp(stage.clientWidth, 320, 2560), height: clamp(stage.clientHeight, 240, 1600) });
  };

  const content = (() => {
    if (detached && !popout) return (
      <div className="browser-detached" role="status">
        <Globe size={20} aria-hidden="true" />
        <strong>Browser is open in its own window</strong>
        <span>The same session and tabs are active there.</span>
        <div><Button size="sm" onClick={() => void focusBrowserPopout(session.id)}>Focus browser window</Button><Button size="sm" variant="primary" onClick={() => void dockDesktopWindow()}><ArrowDownToLine size={13} /> Dock back</Button></div>
      </div>
    );
    if (!state) return stateError ? <div className="pane-pad"><InlineError onRetry={refresh}>{stateError}</InlineError></div> : <div className="browser-center"><Spinner label="Loading browser" /></div>;
    if (state.status === 'connecting') return <ConnectingView state={state} />;
    if (state.status === 'signing-in') return <div className="browser-center"><BrowserSigningInBanner sessionId={session.id} /></div>;
    if (state.status !== 'connected') return <BrowserConnect sessionId={session.id} state={state} onState={apply} />;
    return (
      <>
        <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
          {state.tabs.map((t) => (
            <div key={t.id} className={cx('browser-tab', t.id === tab?.id && 'is-active')} role="presentation">
              <button type="button" role="tab" aria-selected={t.id === tab?.id} title={`${tabLabel(t)}\n${t.url}`} onClick={() => useBrowserStore.getState().select(session.id, t.id)}>{tabLabel(t)}</button>
              <button type="button" className="browser-tab__close" aria-label={`Close tab ${tabLabel(t)}`} disabled={busy === 'close' || !(canInput && t.id === tab?.id)}
                title={t.id !== tab?.id ? 'Select this tab first' : !canInput ? 'Another person is driving this tab' : t.managed ? 'Close tab' : 'Close this tab in your own browser'}
                onClick={(event) => {
                  if (t.managed) void closeTab(t.id);
                  else { confirmOpener.current = event.currentTarget; setConfirmClose(t.id); }
                }}><X size={11} aria-hidden="true" /></button>
            </div>
          ))}
          <IconButton label="New tab" className="browser-tabs__new" onClick={() => void openTab()} disabled={busy === 'tab'}><Plus size={14} /></IconButton>
        </div>
        {confirmPresent && confirmedTab.current ? (
          <div className={cx('browser-confirm', confirmClosing && 'is-closing')} role="alert" aria-hidden={confirmClosing || undefined} inert={confirmClosing}>
            <span>Close “{tabLabel(confirmedTab.current)}” in your own browser? It will close there too.</span>
            <Button size="sm" variant="danger" onClick={() => void closeTab(confirmedTab.current!.id)}>Close tab</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmClose(null)}>Keep</Button>
          </div>
        ) : null}
        {tab ? (
          <>
            <form className="browser-bar" onSubmit={submitAddress}>
              <IconButton label="Back" disabled={!canInput} onClick={() => act({ type: 'back' })}><ArrowLeft size={14} /></IconButton>
              <IconButton label="Forward" disabled={!canInput} onClick={() => act({ type: 'forward' })}><ArrowRight size={14} /></IconButton>
              <IconButton label="Reload" disabled={!canInput} onClick={() => act({ type: 'reload' })}><RefreshCw size={13} /></IconButton>
              <label htmlFor="browser-address" className="sr-only">Address</label>
              <input
                id="browser-address" className="input input--mono browser-bar__url" value={draft ?? tab.url} readOnly={!canInput} spellCheck={false} autoComplete="off"
                title={canInput ? undefined : 'Another person is driving this tab'} aria-invalid={addressError ? true : undefined}
                onFocus={(e) => { setDraft(tab.url); e.currentTarget.select(); }} onBlur={() => { setDraft(null); setAddressError(null); }} onChange={(e) => setDraft(e.target.value)}
              />
              {canInput ? <IconButton label="Fit page viewport to this window" onClick={fitViewport}><Scan size={14} /></IconButton> : null}
              {!popout && !floating ? <Button size="sm" variant="ghost" className="browser-pip-trigger" onClick={() => setFloating(true)}>Float</Button> : null}
              {!popout && canOpenBrowserPopout() ? <IconButton label="Open browser in a separate desktop window" onClick={() => void openDesktopWindow()}><ExternalLink size={14} /></IconButton> : null}
              {popout ? <IconButton label="Dock browser back to Mingle" onClick={() => void dockBrowserPopout()}><ArrowDownToLine size={14} /></IconButton> : null}
              <IconButton label={expanded ? 'Exit full view' : 'Open full view'} onClick={() => setExpanded((v) => !v)}>{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</IconButton>
              <IconButton label="Disconnect browser" title={state.mode === 'existing' ? 'Disconnect (your browser stays open)' : 'Disconnect and close the Mingle browser'} disabled={busy === 'disconnect'} onClick={() => void disconnect()}><Unplug size={14} /></IconButton>
            </form>
            {addressError ? <p className="browser-addr-error" role="alert">{addressError}</p> : null}
            {pageDialogPresent && pageDialogSnapshot.current ? <PageDialog key={pageDialogKey} tab={pageDialogSnapshot.current.tab} canInput={pageDialogSnapshot.current.canInput} act={pageDialogSnapshot.current.act} closing={pageDialogClosing} /> : null}
            <div className="browser-viewport">{state.mode === 'embedded' && canShowEmbedded() && tab.embeddedTargetId
              ? <NativeBrowserView sessionId={session.id} targetId={tab.embeddedTargetId} active={visible && pageVisible && !detached} stream={stream} tab={tab} canvasRef={canvasRef} canInput={canInput} onFallbackChange={setNativeFallback} />
              : <BrowserSurface stream={stream} tab={tab} canvasRef={canvasRef} canInput={canInput} />}</div>
            <div className="browser-status">
              {embeddedNative && tab?.control.holderId === 'desktop-native'
                ? <span className="browser-status__who">You’re using the page · agent resumes in {leaseSeconds}s</span>
                : embeddedNative && tab?.control.holderId === null
                  ? <span className="browser-status__who">Agent is driving · click the page to step in</span>
                  : stream.status === 'live'
                ? <>
                  {/* The countdown is visual only; screen readers hear one announcement per control change. */}
                  <span className="browser-status__who" aria-hidden="true" title={ownership.description}>{ownsLease ? tab?.control.lease === 'hold' ? 'You have control' : `You’re driving · agent resumes in ${leaseSeconds}s` : ownership.label}</span>
                  <span className="sr-only" role="status" aria-live="polite">{ownership.description}</span>
                </>
                : <span className="browser-status__who" role="status">{stream.status === 'closed' ? 'Disconnected' : 'Connecting…'}</span>}
              {stream.status === 'closed' ? <Button size="sm" onClick={stream.reconnect}>Reconnect</Button>
                : ownsLease && tab?.control.lease === 'hold' ? <Button size="sm" data-browser-focus-exit onClick={() => stream.setControl('agent')}>Hand back to agent</Button>
                  : ownsLease ? <Button size="sm" onClick={() => stream.setControl('human')}>Keep control</Button> : null}
              {state.mode === 'managed' ? <BrowserSignInButton sessionId={session.id} /> : null}
            </div>
            {canInput ? <p className="browser-hint">Keys and clicks go to the page. Alt+Shift+Escape moves focus back to Mingle. Paste with {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+V.</p> : null}
            {stream.error ? <div className="browser-stream-error"><InlineError>{stream.error}</InlineError><button type="button" className="link-btn" onClick={stream.dismissError}>Dismiss</button></div> : null}
          </>
        ) : (
          <EmptyState icon={<Globe size={20} />} title="No open tabs">
            Open a page to start. The agent can use it as soon as it exists.
            <span className="presets">{LOCAL_SHORTCUTS.map((p) => <button key={p} type="button" className="chip chip--btn chip--mono" disabled={busy === 'tab'} onClick={() => { const address = toAddress(p); void openTab('url' in address ? address.url : undefined); }}>{p}</button>)}</span>
            <span className="presets"><Button size="sm" variant="primary" busy={busy === 'tab'} onClick={() => void openTab()}><Plus size={13} /> New tab</Button></span>
          </EmptyState>
        )}
        {state.error ? <div className="browser-stream-error"><InlineError>{state.error}</InlineError></div> : null}
        {state.notices.length ? <ul className="browser-notices browser-notices--pad">{state.notices.map((n) => <li key={n}>{n}</li>)}</ul> : null}
        {actionError ? <div className="browser-stream-error"><InlineError>{actionError}</InlineError><button type="button" className="link-btn" onClick={() => setActionError(null)}>Dismiss</button></div> : null}
        {stateError ? <p className="browser-stale" role="status">Browser status may be out of date: {stateError}</p> : null}
      </>
    );
  })();

  return (
    <BrowserHost expanded={expanded} floating={floating && !detached} onDismiss={() => setExpanded(false)} onDock={() => setFloating(false)} onPopout={canOpenBrowserPopout() ? () => void openDesktopWindow() : undefined}>
      <div
        className={cx('browser__inner', expanded && 'is-expanded')}
        onKeyDown={(e) => { if (expanded && e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); setExpanded(false); } }}
      >
        {content}
      </div>
    </BrowserHost>
  );
}

function ConnectingView({ state }: { state: BrowserSessionState }) {
  return (
    <div className="browser-center" role="status">
      <Spinner label="Connecting" />
      <strong>Connecting to the browser…</strong>
      <span>{state.mode === 'existing' ? 'If your browser shows a permission prompt, approve it to continue.' : 'Starting the Mingle browser.'}</span>
    </div>
  );
}

/** A JavaScript dialog (alert, confirm, prompt) the page opened; it blocks the page until answered. */
function PageDialog({ tab, canInput, act, closing }: { tab: BrowserTab; canInput: boolean; act: (action: BrowserAction) => void; closing: boolean }) {
  const dialog = tab.dialog!;
  const [text, setText] = useState('');
  return (
    <div className={cx('browser-dialog', closing && 'is-closing')} role="alertdialog" aria-label={`Page ${dialog.type}`} aria-hidden={closing || undefined} inert={closing}>
      <p><strong>This page shows a {dialog.type}:</strong> {dialog.message}</p>
      {dialog.type === 'prompt' ? <input className="input" aria-label="Prompt response" value={text} disabled={!canInput} onChange={(e) => setText(e.target.value)} /> : null}
      <div>
        <Button size="sm" variant="primary" disabled={!canInput} onClick={() => act({ type: 'dialog', accept: true, ...(dialog.type === 'prompt' ? { promptText: text } : {}) })}>{dialog.type === 'alert' ? 'OK' : 'Accept'}</Button>
        {dialog.type === 'alert' ? null : <Button size="sm" disabled={!canInput} onClick={() => act({ type: 'dialog', accept: false })}>Dismiss</Button>}
      </div>
    </div>
  );
}
