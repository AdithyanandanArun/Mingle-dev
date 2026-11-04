import { useEffect, useRef, useState } from 'react';
import type { QueuedMessage } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { useMingle } from '../../store/store';
import { Button, IconButton } from '../ui';

export function QueuedMessages({sessionId,items,active=false}:{sessionId:string;items:QueuedMessage[];active?:boolean}) {
  const refresh=useMingle((s)=>s.refreshNow);
  const [editing,setEditing]=useState<string|null>(null);
  const [text,setText]=useState('');
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState('');
  const mountedSession=useRef(sessionId); mountedSession.current=sessionId;
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;}},[]);
  useEffect(()=>{setEditing(null);setText('');setBusy(null);setError('');},[sessionId]);
  const act=async(id:string,fn:()=>Promise<unknown>, after?:()=>void)=>{
    if(busy)return;
    const targetSession=sessionId;
    setBusy(id);setError('');
    try{await fn();if(alive.current&&mountedSession.current===targetSession){after?.();await refresh();}}
    catch(e){if(alive.current&&mountedSession.current===targetSession)setError(errorMessage(e));}
    finally{if(alive.current&&mountedSession.current===targetSession)setBusy(null);}
  };
  if(!items.length)return null;
  return <section aria-label="Queued messages" className="queued-messages"><h3>Queued messages · always sent next</h3><p className="queued-messages__note">These messages do not steer the current response. Edit or remove them before they are sent.</p>{items.map((item)=><article key={item.id} className="queued-message">
    <span className="queued-message__state">Queued · sends after the current run{item.memory==='exclude'?' · Project memory excluded for this turn':''}</span>
    {editing===item.id?<textarea aria-label="Edit queued message" value={text} maxLength={100000} disabled={busy===item.id} onChange={(e)=>setText(e.target.value)}/>:<p title={item.content}>{item.content||'Attachment message'}{item.attachmentIds.length>0&&<small>{item.attachmentIds.length} attachments</small>}{item.skills.length>0&&<small>{item.skills.length} skills retained</small>}{item.contextRefs.length>0&&<small>{item.contextRefs.length} context references retained</small>}</p>}
    {editing===item.id?<><Button disabled={!!busy||!text.trim()} onClick={()=>void act(item.id,()=>api.editQueuedMessage(sessionId,item.id,text,item.content),()=>setEditing(null))}>{busy===item.id?'Saving…':'Save'}</Button><Button variant="secondary" disabled={!!busy} onClick={()=>{setEditing(null);setText('');}}>Cancel</Button></>:<><Button disabled={!!busy} title={active?'Interrupt the active run after cleanup, then send this queued message':'Send this queued message now'} onClick={()=>void act(item.id,()=>api.sendQueuedNow(sessionId,item.id))}>{active?'Interrupt and send':'Send now'}</Button><IconButton label="Edit queued message" title="Edit" disabled={!!busy} onClick={()=>{setText(item.content);setEditing(item.id);}}>✎</IconButton><IconButton label="Remove queued message" title="Remove" disabled={!!busy} onClick={()=>void act(item.id,()=>api.removeQueuedMessage(sessionId,item.id))}>×</IconButton></>}
  </article>)}{error&&<p role="alert">{error}</p>}</section>;
}
