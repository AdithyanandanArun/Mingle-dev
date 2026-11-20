import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Copy, RefreshCw, X } from 'lucide-react';
import type { AppUpdateInfo } from '@mingle/contracts';
import { api } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { useMingle } from '../store/store';
import { SettingRow } from './SettingRow';
import { Button } from './ui';

const installCommand = 'npx @mingledev/mingle install';
const checkInterval = 15 * 60_000;

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
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!active || info?.status !== 'available' || !info.latestVersion || dismissed === info.latestVersion) return null;
  const version = info.latestVersion;
  return <aside className="update-notice app-update-notice" role="status">
    <div><strong>Mingle update</strong><span className="update-notice__version">{version}</span></div>
    <button type="button" className="update-notice__link" onClick={() => useMingle.getState().openSettings({ section: 'general' })}>Update <ArrowUpRight size={14} aria-hidden="true" /></button>
    <button type="button" className="update-notice__dismiss" aria-label="Dismiss Mingle update" onClick={() => setDismissed(version)}><X size={15} aria-hidden="true" /></button>
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
      <a href={`https://github.com/AdithyanandanArun/Mingle-dev/releases/tag/v${encodeURIComponent(latest)}`} target="_blank" rel="noopener noreferrer">Download installer <ArrowUpRight size={13} aria-hidden="true" /></a>
    </div> : null}
  </>;
}
