import { useEffect, useRef, useState } from 'react';
import { LogOut, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { AccountPreferences, AccountState, AccountStorageState, AppSettings, SavedAccountPreferences } from '@mingle/contracts';
import { api, errorMessage } from '../lib/api';
import { useMingle } from '../store/store';
import { Button, InlineError } from './ui';
import type { BrowserDesktopBridge } from './browser/desktopBridge';

declare global { interface Window { mingleBrowserDesktop?: BrowserDesktopBridge } }

function storageBackendLabel(backend: string | null | undefined): string | null {
  if (!backend) return null;
  const labels: Record<string, string> = {
    'gnome-libsecret': 'GNOME Keyring', gnome_libsecret: 'GNOME Keyring', libsecret: 'GNOME Keyring',
    kwallet: 'KWallet', kwallet5: 'KWallet', kwallet6: 'KWallet', keychain: 'macOS Keychain',
    win32: 'Windows account protection', dpapi: 'Windows account protection',
    'org.freedesktop.secrets': 'Desktop keyring',
  };
  return labels[backend.toLowerCase()] ?? null;
}

function storageMessage(account: AccountState): { available: boolean; label: string; message: string; backend: string | null; retryable: boolean } {
  const storage = account.storage;
  if (storage?.status === 'available') {
    const backend = storageBackendLabel(storage.backend);
    const message = account.status === 'signed-in'
      ? 'Your current sign-in is saved securely with this device’s OS keyring.'
      : account.status === 'signing-in'
        ? 'Secure storage is available. This sign-in will be saved when you finish the browser step.'
        : account.status === 'signed-out'
          ? 'Future sign-ins will be saved securely with this device’s OS keyring.'
          : 'Secure storage is available while Mingle restores your account status.';
    return {
      available: true, label: 'Available', backend, retryable: false,
      message,
    };
  }
  if (!storage) {
    if (account.sessionStorage === 'os-encrypted') {
      const message = account.status === 'signed-in'
        ? 'Your current sign-in is saved with this device’s operating-system keyring.'
        : account.status === 'signing-in'
          ? 'Operating-system keyring storage is available. This sign-in will be saved when you finish the browser step.'
          : account.status === 'signed-out'
            ? 'Future sign-ins will be saved with this device’s operating-system keyring.'
            : 'Operating-system keyring storage is available while Mingle restores your account status.';
      return {
        available: true, label: 'Available', backend: null, retryable: false,
        message,
      };
    }
    return {
      available: false, label: 'Memory only', backend: null, retryable: false,
      message: 'This server reports memory-only sign-in but does not provide secure-storage diagnostics. Sign-in lasts until Mingle closes; use the desktop app for persistent keyring storage.',
    };
  }

  const messages: Record<Exclude<AccountStorageState['reason'], null>, string> = {
    'web-runtime': 'This is a browser runtime, so sign-in stays in memory and ends when Mingle closes. Use the desktop app for OS-keyring storage.',
    'no-keyring': 'No OS keyring is available to Mingle. Install or start a desktop keyring, then restart Mingle to connect it.',
    'keyring-unavailable': 'Mingle cannot reach the OS keyring. Unlock or start its service, then retry secure storage.',
    'key-unreadable': storage.retryable
      ? 'Mingle could not open the encrypted storage key. Unlock the keyring and retry secure storage.'
      : 'An existing encrypted storage key could not be read. It has been preserved; contact support before changing account data.',
    'storage-write-failed': 'Mingle could not save this sign-in securely, so it may not persist after restart. Check available disk space and Mingle app-data write permissions, then retry.',
    'ipc-unavailable': 'The desktop app could not connect to its secure-storage helper. Restart the app, then retry.',
    'session-unreadable': 'An existing encrypted sign-in could not be read. It has been preserved; contact support before changing account data.',
  };
  return {
    available: false,
    label: 'Unavailable',
    backend: storageBackendLabel(storage.backend),
    retryable: storage.retryable,
    message: storage.reason ? messages[storage.reason] : 'Secure storage is unavailable in this runtime. Unlock the OS keyring, then retry.',
  };
}

function portablePreferences(settings: AppSettings): AccountPreferences {
  return {
    theme: settings.theme, defaultProvider: settings.defaultProvider,
    defaultCodexModel: settings.defaultCodexModel, defaultClaudeModel: settings.defaultClaudeModel,
    ...(settings.defaultAntigravityModel ? { defaultAntigravityModel: settings.defaultAntigravityModel } : {}),
    ...(settings.defaultOpencodeModel ? { defaultOpencodeModel: settings.defaultOpencodeModel } : {}),
    defaultEffort: settings.defaultEffort, autoCompactPercent: settings.autoCompactPercent ?? null,
  };
}

export function AccountSettings({ settings }: { settings: AppSettings }) {
  const [account, setAccount] = useState<AccountState | null>(null);
  const [storeState, setStoreState] = useState<{ available: string[]; selected: string | null; chosenBy: 'auto' | 'user' } | null>(null);
  const [storeChoice, setStoreChoice] = useState('auto');
  const [storeRestart, setStoreRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedAccountPreferences | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const connectionTouched = useRef(false);
  const mounted = useRef(true);
  const storageRetrying = useRef(false);
  const storageSnapshotVersion = useRef(0);
  const userId = account?.user?.id ?? null;

  useEffect(() => {
    let active = true;
    void window.mingleBrowserDesktop?.credentialStoreState().then(value => { if (active && value) { setStoreState(value); setStoreChoice(value.chosenBy === 'user' ? value.selected ?? 'auto' : 'auto'); } });
    return () => { active = false; };
  }, []);
  const canSync = Boolean(userId && loadedFor === userId);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      const version = storageSnapshotVersion.current;
      try {
        const value = await api.account(controller.signal);
        if (!controller.signal.aborted && !storageRetrying.current && version === storageSnapshotVersion.current) {
          setAccount(value);
          if (!connectionTouched.current) { setUrl(value.connection?.url ?? ''); setKey(value.connection?.publishableKey ?? ''); }
        }
      } catch (cause) { if (!controller.signal.aborted) setError(errorMessage(cause)); }
      finally { reading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    window.addEventListener('focus', refresh);
    return () => { mounted.current = false; controller.abort(); clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);

  useEffect(() => {
    setSaved(null); setLoadedFor(null); setNotice(null);
    if (!userId) return;
    const controller = new AbortController();
    void api.accountPreferences(controller.signal).then((value) => {
      if (!controller.signal.aborted) { setSaved(value); setLoadedFor(userId); }
    }).catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [userId]);

  const action = async (name: string, work: () => Promise<void>) => {
    setBusy(name); setError(null); setNotice(null);
    try { await work(); }
    catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { if (mounted.current) setBusy(null); }
  };
  const current = portablePreferences(settings);
  const waiting = account?.status === 'signing-in';
  const signedIn = account?.status === 'signed-in';
  const secureStorage = account ? storageMessage(account) : null;

  const retryStorage = async () => {
    if (!secureStorage?.retryable || busy) return;
    storageSnapshotVersion.current += 1;
    storageRetrying.current = true;
    setBusy('storage-retry'); setError(null); setNotice(null);
    try {
      const next = await api.accountStorageRetry();
      if (!mounted.current) return;
      setAccount(next);
      if (next.storage?.status === 'available') {
        setNotice(next.status === 'signed-in'
          ? 'Your current sign-in is now saved securely.'
          : next.status === 'signing-in'
            ? 'Secure storage is ready. Finish signing in; this sign-in will be saved securely.'
            : next.status === 'signed-out'
              ? 'Secure storage is ready. Future sign-ins will be saved securely.'
              : 'Secure storage is ready while Mingle restores your account status.');
      }
    } catch {
      if (mounted.current) setError('Could not retry secure sign-in storage. Your account and preferences are unchanged. Unlock the keyring and try again.');
    } finally {
      storageRetrying.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  return <section className="settings-page__section account-settings" aria-labelledby="account-heading">
    <div className="settings-page__section-head"><h2 id="account-heading">Your Mingle account</h2><p>Sign in with Google to keep preferences across devices. This account will also identify you in team projects.</p></div>
    {error ? <InlineError>{error}</InlineError> : null}
    {account?.error ? <InlineError>{account.error}</InlineError> : null}
    {!account ? <p className="settings-page__hint" role="status">Loading account…</p> : <>
      {secureStorage ? <section className={`account-settings__storage${secureStorage.available ? ' is-ready' : ' is-unavailable'}`} aria-label="Secure sign-in storage">
        <div className="account-settings__storage-icon" aria-hidden="true">{secureStorage.available ? <ShieldCheck size={17} /> : <ShieldAlert size={17} />}</div>
        <div className="account-settings__storage-copy">
          <div className="account-settings__storage-heading"><h3>Secure sign-in storage</h3><span>{secureStorage.label}</span></div>
          <p>{secureStorage.message}</p>
          {secureStorage.backend ? <small>{secureStorage.available ? 'Keyring' : 'Selected keyring'}: {secureStorage.backend}</small> : null}
          {busy === 'storage-retry' ? <p className="account-settings__storage-progress" role="status" aria-live="polite">Checking secure storage…</p> : null}
        </div>
        {secureStorage.retryable ? <Button size="sm" disabled={Boolean(busy)} busy={busy === 'storage-retry'} onClick={() => void retryStorage()}><RefreshCw size={12} />Retry secure storage</Button> : null}
        {storeState && storeState.available.length > 1 ? <div className="account-settings__store-choice">
          <label htmlFor="credential-store-choice">Store credentials in</label>
          <select id="credential-store-choice" value={storeChoice} disabled={Boolean(busy)} onChange={event => {
            const choice = event.target.value;
            setStoreChoice(choice);
            void window.mingleBrowserDesktop?.chooseCredentialStore(choice).then(ok => { setStoreRestart(ok); if (!ok) setError('Could not save this credential storage choice.'); });
          }}>
            <option value="auto">Automatic</option>
            {storeState.available.map(backend => <option key={backend} value={backend}>{storageBackendLabel(backend) ?? backend}</option>)}
          </select>
          {storeRestart ? <><p>Switching may require signing in again if Mingle cannot read the existing key.</p><Button size="sm" onClick={() => void window.mingleBrowserDesktop?.restartForCredentialStore()}>Restart now</Button></> : null}
        </div> : null}
      </section> : null}
      <div className="account-settings__identity">
        <div className="account-settings__avatar" aria-hidden="true">{(account.user?.name ?? account.user?.email ?? 'M').charAt(0).toUpperCase()}</div>
        <div className="account-settings__identity-copy"><h3>{account.user?.name ?? (signedIn ? 'Google account' : 'Local workspace')}</h3><p>{account.user?.email ?? 'Your projects stay available without signing in.'}</p></div>
        {signedIn ? <Button size="sm" disabled={Boolean(busy)} busy={busy === 'sign-out'} onClick={() => void action('sign-out', async () => { setAccount(await api.accountSignOut()); setSaved(null); setLoadedFor(null); })}><LogOut size={13} />Sign out</Button>
          : waiting ? <Button size="sm" disabled={Boolean(busy)} onClick={() => void action('cancel', async () => { setAccount(await api.accountCancelSignIn()); })}>Cancel sign-in</Button>
            : <Button size="sm" disabled={Boolean(busy) || !account.configured || account.status === 'restoring'} busy={busy === 'sign-in'} onClick={() => void action('sign-in', async () => { setAccount(await api.accountSignIn()); })}>Continue with Google</Button>}
      </div>
      {account.status === 'restoring' ? <p className="settings-page__hint" role="status">Restoring your sign-in…</p> : null}
      {waiting ? <div className="account-settings__waiting" role="status"><p>Finish signing in in your browser.</p>{account.browserError ? <p>{account.browserError}</p> : null}{account.authorizationUrl ? <a href={account.authorizationUrl} target="_blank" rel="noopener noreferrer">Open Google sign-in</a> : null}</div> : null}
      <div className="settings-page__section-head settings-page__section-head--next"><h2>Account preferences</h2><p>Save this device’s appearance, default provider, models, reasoning effort and context threshold. Restore them on another device when you choose.</p></div>
      {signedIn ? <>
        <div className="account-settings__preferences">
          <dl><div><dt>Appearance</dt><dd>{settings.theme === 'dark' ? 'Dark' : 'Light'}</dd></div><div><dt>Default provider</dt><dd>{settings.defaultProvider}</dd></div><div><dt>Reasoning effort</dt><dd>{settings.defaultEffort}</dd></div><div><dt>Auto compact</dt><dd>{settings.autoCompactPercent ? `${settings.autoCompactPercent}%` : 'Provider default'}</dd></div></dl>
          <p className="settings-page__hint">{!canSync ? 'Loading account preferences…' : saved ? `Saved to your account ${new Date(saved.updatedAt).toLocaleString()}.` : 'No preferences saved to this account yet.'}</p>
          <div className="account-settings__actions">
            <Button size="sm" disabled={Boolean(busy) || !canSync} busy={busy === 'save'} onClick={() => void action('save', async () => { setSaved(await api.saveAccountPreferences(current, saved?.revision ?? null)); setNotice('Preferences saved to your Mingle account.'); })}>Save device preferences</Button>
            <Button size="sm" disabled={Boolean(busy) || !canSync || !saved} busy={busy === 'restore'} onClick={() => void action('restore', async () => {
              // Fetch the latest revision rather than applying a potentially stale preview.
              const latest = await api.accountPreferences();
              setSaved(latest); setLoadedFor(userId);
              if (!latest) throw new Error('No account preferences are saved yet.');
              await api.updateSettings(latest.preferences);
              await useMingle.getState().refreshNow();
              setNotice('Account preferences applied to this device. Existing sessions keep their settings.');
            })}>Use account preferences</Button>
            <Button size="sm" disabled={Boolean(busy)} busy={busy === 'reload'} onClick={() => void action('reload', async () => { setSaved(await api.accountPreferences()); setLoadedFor(userId); setNotice('Account preferences refreshed.'); })}><RefreshCw size={12} />Reload</Button>
          </div>
        </div>
      </> : <p className="settings-page__hint">Sign in to save and restore your account preferences.</p>}
      <p className="account-settings__privacy">Provider logins, browser data, local paths and permission settings stay on this device. Project collaboration shares the agents, notes and tasks you explicitly publish.</p>
      <details className="account-settings__connection">
        <summary>Account connection</summary>
        <p className="settings-page__hint">{account.configurationSource === 'application' ? 'Connected to the Mingle account service.' : account.configurationSource === 'environment' ? 'Configured by the runtime environment.' : 'Custom Supabase account service for this device.'} Google OAuth credentials belong in Supabase, not in Mingle.</p>
        <form onSubmit={(event) => { event.preventDefault(); void action('connection', async () => { setAccount(await api.accountConnection({ url: url.trim(), publishableKey: key.trim() })); connectionTouched.current = false; setNotice('Account connection saved.'); }); }}>
          <label htmlFor="account-url">Supabase project URL</label><input id="account-url" type="url" value={url} maxLength={2048} placeholder="https://your-project.supabase.co" autoComplete="off" disabled={Boolean(busy) || signedIn || waiting || account.configurationSource === 'environment'} onChange={(event) => { connectionTouched.current = true; setUrl(event.target.value); }} />
          <label htmlFor="account-publishable-key">Publishable key</label><input id="account-publishable-key" value={key} maxLength={4096} placeholder="sb_publishable_…" autoComplete="off" spellCheck={false} disabled={Boolean(busy) || signedIn || waiting || account.configurationSource === 'environment'} onChange={(event) => { connectionTouched.current = true; setKey(event.target.value); }} />
          <Button type="submit" size="sm" disabled={Boolean(busy) || signedIn || waiting || account.configurationSource === 'environment' || !url.trim() || !key.trim()} busy={busy === 'connection'}>Save connection</Button>
        </form>
      </details>
    </>}
    {notice ? <p className="settings-page__hint" role="status">{notice}</p> : null}
  </section>;
}
