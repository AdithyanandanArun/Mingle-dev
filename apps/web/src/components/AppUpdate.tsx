import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Copy, Download, RefreshCw, X } from 'lucide-react';
import type { AppUpdateInfo } from '@mingle/contracts';
import { api } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { useMingle } from '../store/store';
import { SettingRow } from './SettingRow';
import { Button } from './ui';

const installCommand = 'npx @mingledev/mingle install';
const checkInterval = 15 * 60_000;
const releaseUrl = (version: string) => `https://github.com/AdithyanandanArun/Mingle-dev/releases/tag/v${encodeURIComponent(version)}`;

interface DesktopUpdateState {
  canInstall: boolean;
  phase: 'idle' | 'downloading' | 'installing';
  restartVersion: string | null;
}

declare global {
  interface Window {
    mingleAppUpdate?: {
      getState(): Promise<DesktopUpdateState | null>;
      install(version: string): Promise<DesktopUpdateState | null>;
      restart(): Promise<boolean>;
    };
  }
}

export function useAppUpdate(version: string | undefined) {
  const request = useRef<AbortController | null>(null);
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);

  const check = useCallback(async (refresh = false) => {
    if (!version || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setChecking(true);
    try {
      const result = await api.appUpdate(refresh, controller.signal);
      if (!controller.signal.aborted) {
        setInfo(result);
        setFailed(false);
      }
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setChecking(false);
      }
    }
  }, [version]);

  useEffect(() => {
    if (!version) return;
    void check();
    const timer = window.setInterval(() => void check(), checkInterval);
    return () => {
      window.clearInterval(timer);
      request.current?.abort();
      request.current = null;
    };
  }, [check, version]);

  return { info: info?.installedVersion === version ? info : null, checking, failed, check };
}

export function AppUpdateNotice({ info, active }: { info: AppUpdateInfo | null; active: boolean }) {
  const desktop = window.mingleAppUpdate;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [dismissedRestart, setDismissedRestart] = useState<string | null>(null);
  const [desktopState, setDesktopState] = useState<DesktopUpdateState | null>(null);
  const [applying, setApplying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    let stopped = false;
    const refresh = () => void desktop.getState().then(state => { if (!stopped) setDesktopState(state); }).catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, applying ? 750 : 15_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [desktop, applying]);

  const install = async (version: string) => {
    if (!desktopState?.canInstall || !desktop || applying) return;
    setApplying(true);
    setFailure(null);
    try {
      const result = await desktop.install(version);
      if (!result?.restartVersion) throw new Error('Mingle could not verify the installation.');
      setDesktopState(result);
    } catch (error) {
      setFailure(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Could not install Mingle.');
    } finally { setApplying(false); }
  };
  if (!active) return null;
  if (desktopState?.restartVersion) {
    const version = desktopState.restartVersion;
    if (dismissedRestart === version) return null;
    return <aside key={`installed-${version}`} className="update-notice app-update-complete update-notice--complete" role="status">
      <span className="update-notice__icon"><Check size={15} aria-hidden="true" /></span>
      <div className="update-notice__body">
        <div className="update-notice__header"><strong>Mingle updated</strong><span className="update-notice__version">{version}</span></div>
        <p>Restart Mingle to use the new version.</p>
        {failure ? <p className="provider-updates__error" role="alert">{failure}</p> : null}
      </div>
      <div className="update-notice__actions">
        <button type="button" className="update-notice__button" onClick={() => void desktop?.restart().then(ok => {
          if (!ok) setFailure('Close and reopen Mingle to finish updating.');
        }).catch(() => setFailure('Close and reopen Mingle to finish updating.'))}>Restart</button>
        <button type="button" className="update-notice__dismiss" aria-label="Dismiss Mingle update complete" onClick={() => setDismissedRestart(version)}><X size={15} aria-hidden="true" /></button>
      </div>
    </aside>;
  }
  if (info?.status !== 'available' || !info.latestVersion || dismissed === info.latestVersion) return null;
  const version = info.latestVersion;
  const busy = applying || Boolean(desktopState && desktopState.phase !== 'idle');
  return <aside className="update-notice app-update-notice" role="status">
    <span className="update-notice__icon"><Download size={15} aria-hidden="true" /></span>
    <div className="update-notice__body">
      <div className="update-notice__header"><strong>Mingle update</strong><span className="update-notice__version">{version}</span></div>
      {busy ? <p>{desktopState?.phase === 'installing' ? 'Installing. Approve the system prompt if asked.' : 'Downloading and verifying…'}</p> : null}
      {manualOpen ? <div className="app-update-notice__manual">
        <a className="update-notice__link" href={releaseUrl(version)} target="_blank" rel="noopener noreferrer">Download installer <ArrowUpRight size={13} aria-hidden="true" /></a>
        <button type="button" className="update-notice__link" onClick={() => void copyText(installCommand).then(() => {
          setCopied(true); setFailure(null);
        }).catch(() => setFailure('Could not copy the install command.'))}>{copied ? 'Copied' : 'Copy npm command'}</button>
      </div> : null}
      {failure ? <p className="provider-updates__error" role="alert">{failure}</p> : null}
    </div>
    <div className="update-notice__actions">
      <button type="button" className="update-notice__button" disabled={busy} onClick={() => desktopState?.canInstall ? void install(version) : setManualOpen(!manualOpen)}>{busy ? 'Updating…' : manualOpen ? 'Hide' : 'Update'}</button>
      <button type="button" className="update-notice__dismiss" disabled={busy} aria-label="Dismiss Mingle update" onClick={() => setDismissed(version)}><X size={15} aria-hidden="true" /></button>
    </div>
  </aside>;
}

export function AppUpdateSetting({ version, update }: { version: string; update: ReturnType<typeof useAppUpdate> }) {
  const { info, checking, failed, check } = update;
  const latest = info?.status === 'available' ? info.latestVersion : null;
  const status = failed || info?.status === 'unavailable' ? 'Could not check npm for updates.'
    : latest ? `Version ${latest} is available.` : info?.status === 'current' ? 'No newer npm release.' : 'Checking npm for updates…';
  return <>
    <SettingRow title="Mingle updates" htmlFor="st-app-update" description={<span role="status">Installed {version}. {status}</span>}>
      <Button id="st-app-update" variant="secondary" size="sm" disabled={checking} onClick={() => void check(true)}><RefreshCw size={13} />{checking ? 'Checking…' : 'Check for updates'}</Button>
    </SettingRow>
    {latest ? <div className="app-update-install">
      <code>{installCommand}</code>
      <Button variant="secondary" size="sm" onClick={() => void copyText(installCommand).then(
        () => useMingle.getState().toast('success', 'Install command copied.'),
        () => useMingle.getState().toast('error', 'Could not copy the install command.'),
      )}><Copy size={13} /> Copy command</Button>
      <a href={releaseUrl(latest)} target="_blank" rel="noopener noreferrer">Download installer <ArrowUpRight size={13} aria-hidden="true" /></a>
    </div> : null}
  </>;
}
