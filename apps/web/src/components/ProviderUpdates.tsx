import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Copy, RefreshCw, X } from 'lucide-react';
import type { ProviderUpdateInfo } from '@mingle/contracts';
import { api, errorMessage } from '../lib/api';
import { PROVIDER_NAMES } from '../lib/providers';
import { Button } from './ui';
import { copyText } from '../lib/clipboard';

const names = PROVIDER_NAMES as Record<string, string>;
export function ProviderUpdates({ noticeOnly = false }: { noticeOnly?: boolean }) {
  const readGeneration = useRef(0);
  const [rows, setRows] = useState<ProviderUpdateInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++readGeneration.current;
    try { const result = await api.providerUpdates(signal); if (!Array.isArray(result.providers)) throw new Error('Provider update status is unavailable. Check again in Settings.'); if (!signal?.aborted && generation === readGeneration.current) { setRows(result.providers); setErrors((old) => ({ ...old, load: '' })); } }
    catch (error) { if (!signal?.aborted && generation === readGeneration.current) setErrors((old) => ({ ...old, load: errorMessage(error) })); }
  }, []);
  useEffect(() => { const controller = new AbortController(); const refresh = () => void load(controller.signal); refresh(); window.addEventListener('mingle:provider-updates-changed', refresh); return () => { controller.abort(); window.removeEventListener('mingle:provider-updates-changed', refresh); }; }, [load]);

  const refresh = async (provider?: ProviderUpdateInfo['provider']) => {
    setBusy(provider ?? 'all'); setErrors({});
    try {
      const result = await api.checkProviderUpdates(provider);
      if ('providers' in result) setRows(result.providers);
      else await load();
    } catch (error) { setErrors((old) => ({ ...old, [provider ?? 'load']: errorMessage(error) })); }
    finally { setBusy(null); }
  };
  const dismiss = async (row: ProviderUpdateInfo) => {
    if (!row.latestVersion) return;
    try { await api.dismissProviderUpdate(row.provider, row.latestVersion); } catch (error) { setErrors((old) => ({ ...old, [row.provider]: errorMessage(error) })); return; }
    window.dispatchEvent(new Event('mingle:provider-updates-changed'));
    setRows((current) => current.map((item) => item.provider === row.provider ? { ...item, dismissed: true } : item));
  };
  const update = async (row: ProviderUpdateInfo) => {
    setBusy(row.provider); setErrors({});
    try {
      const result = await api.applyProviderUpdate(row.provider, row.installedVersion);
      readGeneration.current++; setRows((current) => current.map((item) => item.provider === row.provider ? result : item));
    } catch (error) { setErrors((old) => ({ ...old, [row.provider]: errorMessage(error) })); }
    finally { setBusy(null); await load(); }
  };
  const available = rows.filter((row) => row.status === 'available' && !row.dismissed);
  return <>
    {available.map((row) => <aside className="provider-update-notice" role="status" key={row.provider}>
      <div><strong>{names[row.provider] ?? row.provider} {row.latestVersion} is available</strong><p>{row.message}</p>{errors[row.provider] ? <p role="alert">{errors[row.provider]}</p> : null}</div>
      <button type="button" className="provider-update-notice__link" onClick={() => window.dispatchEvent(new CustomEvent('mingle:open-provider-settings'))}>Settings <ArrowUpRight size={14} /></button>
      <button type="button" className="provider-update-notice__dismiss" aria-label={`Dismiss ${row.provider} update`} onClick={() => void dismiss(row)}><X size={15} /></button>
    </aside>)}
    {!noticeOnly ? <section className="provider-updates" aria-label="Provider CLI updates">
      <header><div><h2>Provider CLI updates</h2><p>Checks use public release metadata. Updates only run after you choose Update.</p></div><Button variant="secondary" disabled={busy !== null} onClick={() => void refresh()}><RefreshCw size={14} /> Check again</Button></header>
      {errors.load ? <p className="provider-updates__error" role="alert">{errors.load}</p> : null}
      {!rows.length ? <p className="provider-updates__muted">Checking cached provider update status…</p> : rows.map((row) => {
        const managedPinnedRuntime = row.provider === 'antigravity';
        const guidance = row.status === 'available' && row.method === 'unsupported' ? row.instructions?.trim() : undefined;
        const showGuidanceSeparately = guidance && !row.message.includes(guidance);
        return <article className="provider-updates__row" key={row.provider}>
        <div className="provider-updates__copy"><div className="provider-updates__title"><strong>{names[row.provider] ?? row.provider}</strong><span>{managedPinnedRuntime ? 'Managed by Mingle' : row.status}</span></div>
          <p>Installed: {row.installedVersion ?? 'unknown'}{!managedPinnedRuntime ? ` · Latest stable: ${row.latestVersion ?? 'unknown'}` : ''}</p>
          <p>{row.message}</p>
          {showGuidanceSeparately ? <p className="provider-updates__guidance">{guidance}</p> : null}
          {row.source ? <small>Source: {row.source}{row.checkedAt ? ` · checked ${new Date(row.checkedAt).toLocaleString()}` : ''}</small> : null}
          {errors[row.provider] ? <p className="provider-updates__error" role="alert">{errors[row.provider]}</p> : null}

        </div>
        <div className="provider-updates__actions">
          {row.status === 'available' && row.method === 'native' ? <Button disabled={busy !== null} onClick={() => void update(row)}>{busy === row.provider ? 'Updating…' : 'Update'}</Button> : null}
          {row.status === 'available' && row.method === 'unsupported' ? <Button variant="secondary" onClick={() => void copyText(row.instructions ?? row.message).catch((error) => setErrors((old) => ({ ...old, [row.provider]: errorMessage(error) })))}><Copy size={13} /> Copy instructions</Button> : null}
          {!managedPinnedRuntime && row.status !== 'updating' && row.status !== 'available' ? <Button variant="secondary" disabled={busy !== null} onClick={() => void refresh(row.provider)}><RefreshCw size={13} /> Re-check</Button> : null}
          {row.status === 'available' && row.latestVersion && !row.dismissed ? <Button variant="secondary" onClick={() => void dismiss(row)}><Check size={13} /> Dismiss</Button> : null}
        </div>
      </article>;
      })}
    </section> : null}
  </>;
}
