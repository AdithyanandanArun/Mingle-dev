import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { Button, InlineError } from '../ui';
export function BrowserSignInButton({sessionId}:{sessionId:string}) {
  const [open,setOpen]=useState(false),[url,setUrl]=useState('https://accounts.google.com/'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const start=async()=>{setBusy(true);setError('');try{await api.startBrowserSignIn(sessionId,url);}catch(e){setError(errorMessage(e));}finally{setBusy(false);}};
  return <div className="browser-signin"><Button size="sm" onClick={()=>setOpen(v=>!v)}>Sign in to a site…</Button>{open?<form onSubmit={e=>{e.preventDefault();void start();}}><label htmlFor="browser-signin-url">Site URL</label><input id="browser-signin-url" type="url" value={url} onChange={e=>setUrl(e.target.value)} required/><p>A normal browser window opens so sites like Google accept the sign-in. Automation pauses until you’re done.</p><Button size="sm" variant="primary" busy={busy} type="submit">Open</Button>{error?<InlineError>{error}</InlineError>:null}</form>:null}</div>;
}
export function BrowserSigningInBanner({sessionId}:{sessionId:string}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const finish=async()=>{setBusy(true);setError('');try{await api.finishBrowserSignIn(sessionId);}catch(e){setError(errorMessage(e));}finally{setBusy(false);}};
  return <div className="browser-signin-banner" aria-live="polite"><span>Sign-in window open. Automation is paused.</span><Button size="sm" busy={busy} onClick={()=>void finish()}>Done signing in</Button>{error?<InlineError>{error}</InlineError>:null}</div>;
}
