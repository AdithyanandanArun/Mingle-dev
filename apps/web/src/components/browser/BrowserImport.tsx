import { useEffect, useMemo, useState } from 'react';
import type { BrowserImportSource, BrowserImportResult } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { Button } from '../ui';

export function BrowserImportButton({sessionId}:{sessionId:string}) {
  const [open,setOpen]=useState(false),[sources,setSources]=useState<BrowserImportSource[]>([]),[sourceId,setSourceId]=useState(''),[profileId,setProfileId]=useState(''),[domains,setDomains]=useState('google.com'),[error,setError]=useState(''),[result,setResult]=useState<BrowserImportResult|null>(null),[busy,setBusy]=useState(false);
  useEffect(()=>{ if(!open)return; let live=true; api.browserImportSources().then(rows=>{if(!live)return;setSources(rows);const available=rows.find(row=>row.supported&&row.profiles.length);if(available){setSourceId(available.id);setProfileId(available.profiles[0]!.id);}}).catch(e=>{if(live)setError(errorMessage(e));}); return()=>{live=false;}; },[open]);
  const source=sources.find(item=>item.id===sourceId), profile=source?.profiles.find(item=>item.id===profileId);
  const choices=useMemo(()=>domains.split(/[\s,]+/u).map(x=>x.trim().toLowerCase()).filter(Boolean),[domains]);
  const selectSource=(id:string)=>{setSourceId(id);setProfileId(sources.find(x=>x.id===id)?.profiles[0]?.id??'');setResult(null);};
  const submit=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);setError('');setResult(null);try{setResult(await api.browserImportCookies(sessionId,{sourceId,profileId,domains:choices}));}catch(err){setError(errorMessage(err));}finally{setBusy(false);}};
  return <div className="browser-import"><Button size="sm" onClick={()=>setOpen(v=>!v)}>Use my sign-ins…</Button>{open?<form className="browser-import__panel" onSubmit={submit}>
    <fieldset><legend>Copy sign-ins from this computer</legend>
      <label htmlFor="browser-import-source">Browser</label><select id="browser-import-source" value={sourceId} onChange={e=>selectSource(e.target.value)} disabled={!sources.length}>{sources.length?sources.map(item=><option key={item.id} value={item.id} disabled={!item.supported}>{item.name}{!item.supported?` — ${item.note}`:''}</option>):<option value="">No browser profiles found</option>}</select>
      {source?<><label htmlFor="browser-import-profile">Profile</label><select id="browser-import-profile" value={profileId} onChange={e=>{setProfileId(e.target.value);setResult(null);}}>{source.profiles.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></>:null}
      <label htmlFor="browser-import-domains">Sites (comma or space separated)</label><input id="browser-import-domains" value={domains} onChange={e=>setDomains(e.target.value)} placeholder="google.com" required />
      <p className="browser-import__consent">Mingle copies your sign-in cookies for these sites only, from {profile?.name ?? 'the selected browser profile'} into this Mingle browser. They stay on this computer.</p>
      <Button size="sm" variant="primary" type="submit" busy={busy} disabled={!source?.supported||!profile||!choices.length}>Import</Button>
      <div className="browser-import__result" aria-live="polite">{error|| (result?`Imported ${result.imported} sign-in cookies for ${result.domains.join(', ')}. Reload the page to use them.`:'')}</div>
    </fieldset>
  </form>:null}</div>;
}
