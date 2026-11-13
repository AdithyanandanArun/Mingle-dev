import { useState } from 'react';
import type { BrowserDiscovery } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { Button } from '../ui';

export function BrowserSandboxCard({ discovery, refresh, onUseBrowser }: {
  discovery: BrowserDiscovery; refresh(): Promise<void>; onUseBrowser?: (executable: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copying, setCopying] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<{ text: string; message: string } | null>(null);
  const sandbox = discovery.sandbox;
  if (!sandbox || sandbox.managedReady) return null;
  const fix = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { await api.fixBrowserSandbox(); await refresh(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const useBrowser = async (executable: string) => {
    if (busy || !onUseBrowser) return;
    setBusy(true); setError('');
    try { await onUseBrowser(executable); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const copyInstructions = async () => {
    const text = sandbox.manualFix;
    if (!text || copying) return;
    setCopying(true); setCopiedText(null); setCopyError(null);
    try { await copyText(text); setCopiedText(text); }
    catch { setCopyError({ text, message: 'Could not copy the instructions. Select the text above and copy it manually, or try again.' }); }
    finally { setCopying(false); }
  };
  return <section className="browser-sandbox" aria-labelledby="browser-sandbox-title">
    <h3 id="browser-sandbox-title">Chromium needs permission to use its sandbox</h3>
    <p>Linux is blocking Chromium’s protection. Allow it once, or choose an installed browser that is ready.</p>
    {sandbox.canInstallProfile ? <Button variant="primary" size="sm" busy={busy} onClick={() => void fix()}>Allow Chromium (admin prompt)</Button> : null}
    {error ? <p role="alert">{error}</p> : null}
    {discovery.systemBrowsers.filter(browser => browser.sandboxReady).map(browser =>
      <Button key={browser.id} size="sm" disabled={busy || !onUseBrowser} onClick={() => void useBrowser(browser.executable)}>Use {browser.name} instead</Button>)}
    {sandbox.manualFix ? <details>
      <summary>Do it yourself</summary>
      <pre tabIndex={0} aria-label="Manual sandbox instructions">{sandbox.manualFix}</pre>
      <Button size="sm" busy={copying} onClick={() => void copyInstructions()}>Copy instructions</Button>
      {copiedText === sandbox.manualFix ? <span role="status">Copied</span> : null}
      {copyError?.text === sandbox.manualFix ? <p role="alert">{copyError.message}</p> : null}
    </details> : null}
  </section>;
}
