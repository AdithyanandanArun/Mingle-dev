import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Copy, Download, RefreshCw, X } from 'lucide-react';
import type { AppUpdateInfo } from '@mingle/contracts';
import { api } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { useMingle } from '../store/store';
import { SettingRow } from './SettingRow';
import { Button } from './ui';

const installCommand = (version: string) => /^\d+\.\d+\.\d+$/.test(version)
  ? `npx @mingledev/mingle@${version} install`
  : 'npx @mingledev/mingle install';
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
  const desktop = version ? window.mingleAppUpdate : undefined;
  const request = useRef<AbortController | null>(null);
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [desktopState, setDesktopState] = useState<DesktopUpdateState | null>(null);
  const [installingVersion, setInstallingVersion] = useState<string | null>(null);
  const [installFailure, setInstallFailure] = useState<{ version: string; message: string } | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartFailure, setRestartFailure] = useState(false);

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
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(timer);
      request.current?.abort();
      request.current = null;
    };
  }, [check, version]);

  useEffect(() => {
    if (!desktop) return;
    let stopped = false;
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const state = await desktop.getState();
        if (!stopped) setDesktopState(state);
      } catch { /* The native installer links remain available if the bridge is unavailable. */ }
      finally { reading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), installingVersion ? 750 : 15_000);
    window.addEventListener('focus', refresh);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [desktop, installingVersion]);

  const busy = Boolean(installingVersion || (desktopState && desktopState.phase !== 'idle'));
  const install = async (target: string) => {
    if (!desktopState?.canInstall || !desktop || busy || desktopState.restartVersion) return;
    setInstallingVersion(target);
    setInstallFailure(null);
    try {
      const result = await desktop.install(target);
      if (result?.restartVersion !== target) throw new Error('Mingle could not verify the installation.');
      setDesktopState(result);
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Could not install Mingle.';
      setInstallFailure({ version: target, message });
    } finally { setInstallingVersion(null); }
  };
  const restart = async () => {
    if (!desktop || !desktopState?.restartVersion || restarting) return;
    setRestarting(true);
    setRestartFailure(false);
    try {
      if (await desktop.restart()) return;
    } catch { /* Use the same manual recovery for a rejected or unavailable restart. */ }
    setRestartFailure(true);
    setRestarting(false);
  };
  const progress = desktopState?.phase === 'installing'
    ? 'Installing. Approve the system prompt if asked.'
    : 'Downloading and verifying…';
  return {
    info: info?.installedVersion === version ? info : null, checking, failed, check,
    canInstall: Boolean(desktopState?.canInstall), restartVersion: desktopState?.restartVersion,
    installingVersion, busy, progress, installFailure, install, restarting, restartFailure, restart,
  };
}

const restartHelp = 'Close and reopen Mingle to finish updating.';

export function AppUpdateNotice({ update, active }: { update: ReturnType<typeof useAppUpdate>; active: boolean }) {
  const { info, restartVersion, restarting, restartFailure, restart, installingVersion, busy, progress, canInstall, installFailure, install } = update;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [dismissedRestart, setDismissedRestart] = useState<string | null>(null);
  const [manualVersion, setManualVersion] = useState<string | null>(null);
  const [copyResult, setCopyResult] = useState<{ version: string; ok: boolean } | null>(null);
  if (!active) return null;
  if (restartVersion) {
    const version = restartVersion;
    if (dismissedRestart === version) return null;
    return <aside key={`installed-${version}`} className="update-notice app-update-complete update-notice--complete" role="status">
      <span className="update-notice__icon"><Check size={15} aria-hidden="true" /></span>
      <div className="update-notice__body">
        <div className="update-notice__header"><strong>Mingle updated</strong><span className="update-notice__version">{version}</span></div>
        <p>Restart Mingle to use the new version.</p>
        {restartFailure ? <p className="provider-updates__error" role="alert">{restartHelp}</p> : null}
      </div>
      <div className="update-notice__actions">
        <button type="button" className="update-notice__button" disabled={restarting} onClick={() => void restart()}>{restarting ? 'Restarting…' : 'Restart'}</button>
        <button type="button" className="update-notice__dismiss" disabled={restarting} aria-label="Dismiss Mingle update complete" onClick={() => setDismissedRestart(version)}><X size={15} aria-hidden="true" /></button>
      </div>
    </aside>;
  }
  const version = installingVersion ?? (info?.status === 'available' ? info.latestVersion : null);
  if (!version || (!busy && dismissed === version)) return null;
  const failure = installFailure?.version === version ? installFailure.message : null;
  const manualOpen = manualVersion === version || (canInstall && Boolean(failure));
  const copy = copyResult?.version === version ? copyResult : null;
  return <aside className="update-notice app-update-notice" role="status">
    <span className="update-notice__icon"><Download size={15} aria-hidden="true" /></span>
    <div className="update-notice__body">
      <div className="update-notice__header"><strong>Mingle update</strong><span className="update-notice__version">{version}</span></div>
      {busy ? <p>{progress}</p> : null}
      {manualOpen ? <div className="app-update-notice__manual">
        <a className="update-notice__link" href={releaseUrl(version)} target="_blank" rel="noopener noreferrer">Download installer <ArrowUpRight size={13} aria-hidden="true" /></a>
        <button type="button" className="update-notice__link" onClick={() => void copyText(installCommand(version)).then(() => {
          setCopyResult({ version, ok: true });
        }).catch(() => setCopyResult({ version, ok: false }))}>{copy?.ok ? 'Copied' : 'Copy npm command'}</button>
      </div> : null}
      {failure ? <p className="provider-updates__error" role="alert">{failure}</p> : null}
      {copy && !copy.ok ? <p className="provider-updates__error" role="alert">Could not copy the install command.</p> : null}
    </div>
    <div className="update-notice__actions">
      <button type="button" className="update-notice__button" disabled={busy} aria-expanded={canInstall ? undefined : manualOpen} onClick={() => {
        if (canInstall) void install(version);
        else setManualVersion(manualOpen ? null : version);
      }}>{busy ? 'Updating…' : canInstall && failure ? 'Retry' : !canInstall && manualOpen ? 'Hide' : 'Update'}</button>
      <button type="button" className="update-notice__dismiss" disabled={busy} aria-label="Dismiss Mingle update" onClick={() => setDismissed(version)}><X size={15} aria-hidden="true" /></button>
    </div>
  </aside>;
}

export function AppUpdateSetting({ version, update }: { version: string; update: ReturnType<typeof useAppUpdate> }) {
  const { info, checking, failed, check, canInstall, restartVersion, installingVersion, busy, progress, installFailure, install, restarting, restartFailure, restart } = update;
  const latest = installingVersion ?? (info?.status === 'available' ? info.latestVersion : null);
  const failure = installFailure?.version === latest ? installFailure.message : null;
  const status = restartVersion ? `Version ${restartVersion} is installed. Restart Mingle to use it.`
    : busy ? progress : failed || info?.status === 'unavailable' ? 'Could not check npm for updates.'
    : latest ? `Version ${latest} is available.` : info?.status === 'current' ? 'No newer npm release.' : 'Checking npm for updates…';
  return <>
    <SettingRow title="Mingle updates" htmlFor="st-app-update" description={<span role="status">Installed {version}. {status}</span>}>
      {restartVersion ? <Button id="st-app-update" variant="primary" size="sm" disabled={restarting} onClick={() => void restart()}>{restarting ? 'Restarting…' : 'Restart'}</Button>
        : <Button id="st-app-update" variant="secondary" size="sm" disabled={checking || busy} onClick={() => void check(true)}><RefreshCw size={13} />{checking ? 'Checking…' : 'Check for updates'}</Button>}
    </SettingRow>
    {restartVersion && restartFailure ? <p className="provider-updates__error" role="alert">{restartHelp}</p> : null}
    {latest && !restartVersion ? <div className="app-update-install">
      {canInstall ? <Button variant="primary" size="sm" disabled={busy} onClick={() => void install(latest)}>{busy ? 'Updating…' : failure ? 'Retry update' : 'Install update'}</Button> : null}
      <code>{installCommand(latest)}</code>
      <Button variant="secondary" size="sm" onClick={() => void copyText(installCommand(latest)).then(
        () => useMingle.getState().toast('success', 'Install command copied.'),
        () => useMingle.getState().toast('error', 'Could not copy the install command.'),
      )}><Copy size={13} /> Copy command</Button>
      <a href={releaseUrl(latest)} target="_blank" rel="noopener noreferrer">Download installer <ArrowUpRight size={13} aria-hidden="true" /></a>
    </div> : null}
    {!restartVersion && failure ? <p className="provider-updates__error" role="alert">{failure}</p> : null}
  </>;
}
