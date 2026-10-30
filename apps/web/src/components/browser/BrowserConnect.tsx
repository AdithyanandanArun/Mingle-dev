import { useState } from 'react';
import { Download, Globe, LogIn } from 'lucide-react';
import type { BrowserConnect as ConnectRequest, BrowserSessionState } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { useMingle } from '../../store/store';
import { Button, InlineError } from '../ui';
import { BrowserSourcePicker, ChromeSetupHelp } from './BrowserSources';
import { useBrowserDiscovery } from './useBrowserDiscovery';
import { BrowserSandboxCard } from './BrowserSandboxCard';

type Mode = 'embedded' | 'managed' | 'existing';

/** Choose how this session gets a browser. Nothing connects, launches or downloads until a button here is pressed. */
export function BrowserConnect({ sessionId, state, onState }: { sessionId: string; state?: BrowserSessionState; onState(next: BrowserSessionState): void }) {
  const settings = useMingle((s) => s.boot?.settings);
  const { discovery, loading, error: discoveryError, installing, refresh, install } = useBrowserDiscovery();
  const [sourceId, setSourceId] = useState(settings?.browserExistingSourceId ?? '');
  const [endpoint, setEndpoint] = useState(settings?.browserCdpEndpoint ?? '');
  const [busy, setBusy] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = async (request: ConnectRequest) => {
    setBusy(request.mode);
    setError(null);
    try { onState(await api.browserConnect(sessionId, request)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(null); }
  };

  const manual = endpoint.trim();
  const usable = discovery?.sources.find((s) => s.id === sourceId && s.debuggingAvailable);
  const existingReady = Boolean(manual || usable);
  const existingFirst = settings?.browserDefaultMode === 'existing';
  const notices = [...(state?.notices ?? []), ...(discovery?.notices ?? [])];
  const shownError = error ?? (state?.status === 'error' ? state.error : null) ?? discoveryError;

  const managed = (
    <section className="browser-card" aria-labelledby="browser-managed-title">
      <header><Globe size={15} aria-hidden="true" /><h3 id="browser-managed-title">Mingle browser</h3></header>
      <p>A separate Chromium that Mingle opens for this session. It starts without your personal logins.</p>
      {discovery?.managedExecutable ? <code className="browser-card__path" title={discovery.managedExecutable}>{discovery.managedExecutable}</code> : null}
      {discovery && !discovery.managedAvailable ? (
        <div className="browser-card__actions">
          <Button size="sm" onClick={() => void install()} busy={installing} disabled={busy !== null}><Download size={13} aria-hidden="true" /> {installing ? 'Installing Chromium…' : 'Install Chromium'}</Button>
          {installing ? <span className="browser-card__hint" role="status">Downloading. This can take a couple of minutes.</span> : <span className="browser-card__hint">Downloads once; nothing is installed until you choose.</span>}
        </div>
      ) : (
        <div className="browser-card__actions">
          <Button size="sm" variant="primary" disabled={!discovery || busy !== null} why={discovery ? undefined : 'Checking for Chromium'} busy={busy === 'managed'} onClick={() => void connect({ mode: 'managed' })}>Open browser</Button>
        </div>
      )}
    </section>
  );

  const existing = (
    <section className="browser-card" aria-labelledby="browser-existing-title">
      <header><LogIn size={15} aria-hidden="true" /><h3 id="browser-existing-title">Your running browser</h3></header>
      <p>Use the logins and open tabs of a Chromium browser that is already running. Mingle attaches to it; nothing is copied.</p>
      <BrowserSourcePicker
        idPrefix="connect" discovery={discovery} loading={loading} sourceId={sourceId} endpoint={endpoint}
        onSource={setSourceId} onEndpoint={setEndpoint} onRefresh={() => void refresh()} disabled={busy !== null}
      />
      <ChromeSetupHelp open={Boolean(discovery) && discovery!.sources.length === 0} />
      <p className="browser-card__consent">The session’s agent will be able to see and operate every open tab in that browser, including pages you are signed in to. Disconnecting leaves your browser running.</p>
      <div className="browser-card__actions">
        <Button
          size="sm" variant={existingFirst ? 'primary' : 'secondary'} busy={busy === 'existing'} disabled={!existingReady || busy !== null}
          why={existingReady ? undefined : 'Choose a running browser or enter an endpoint'}
          onClick={() => void connect({ mode: 'existing', consent: true, ...(manual ? { endpoint: manual } : { sourceId }) })}
        >Share logged-in tabs with this session</Button>
        {busy === 'existing' ? <span className="browser-card__hint" role="status">Approve the prompt in your browser if it appears.</span> : null}
      </div>
    </section>
  );

  return (
    <div className="browser-connect">
      <div className="browser-connect__head">
        <h2>Browser for this session</h2>
        <p>Watch the agent work, take control when you want to, and hand it back.</p>
        {settings?.browserAgentEnabled === false ? <p className="browser-connect__note">Agent access is off in Settings → Browser. You can still browse here yourself.</p> : null}
      </div>
      {shownError ? <InlineError>{shownError}</InlineError> : null}
      {discovery ? <BrowserSandboxCard discovery={discovery} refresh={refresh} onUseBrowser={async (executable) => { await api.updateSettings({ browserExecutable: executable }); await refresh(); }} /> : null}
      {notices.length ? <ul className="browser-notices">{notices.map((n) => <li key={n}>{n}</li>)}</ul> : null}
      {existingFirst ? <>{existing}{managed}</> : <>{managed}{existing}</>}
    </div>
  );
}
