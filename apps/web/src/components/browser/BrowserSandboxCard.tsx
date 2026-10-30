import { useState } from 'react';
import type { BrowserDiscovery } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { Button } from '../ui';

export function BrowserSandboxCard({ discovery, refresh, onUseBrowser }: { discovery:BrowserDiscovery; refresh():Promise<void>; onUseBrowser?:(executable:string)=>Promise<void> }) {
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[copied,setCopied]=useState(false);
  const sandbox=discovery.sandbox; if(!sandbox||sandbox.managedReady)return null;
  const fix=async()=>{setBusy(true);setError('');try{await api.fixBrowserSandbox();await refresh();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}};
  return <section className="browser-sandbox" aria-labelledby="browser-sandbox-title">
    <h3 id="browser-sandbox-title">Chromium needs permission to use its sandbox</h3>
    <p>Linux is blocking Chromium’s protection. Allow it once, or choose an installed browser that is ready.</p>
    {sandbox.canInstallProfile?<Button variant="primary" size="sm" busy={busy} onClick={()=>void fix()}>Allow Chromium (admin prompt)</Button>:null}
    {error?<p role="alert">{error}</p>:null}
    {discovery.systemBrowsers.filter(b=>b.sandboxReady).map(b=><Button key={b.id} size="sm" onClick={()=>void onUseBrowser?.(b.executable)}>Use {b.name} instead</Button>)}
    {sandbox.manualFix?<details><summary>Do it yourself</summary><pre>{sandbox.manualFix}</pre><Button size="sm" onClick={()=>{void navigator.clipboard.writeText(sandbox.manualFix!).then(()=>setCopied(true));}}>Copy</Button>{copied?<span role="status">Copied</span>:null}</details>:null}
  </section>;
}
