import { useState } from 'react';
import type { QueuedMessage } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { useMingle } from '../../store/store';
import { Button, IconButton } from '../ui';

export function QueuedMessages({sessionId,items}:{sessionId:string;items:QueuedMessage[]}) {
  const refresh=useMingle((s)=>s.refreshNow); const [editing,setEditing]=useState<string|null>(null); const [text,setText]=useState(''); const [error,setError]=useState('');
  const act=async(fn:()=>Promise<unknown>)=>{try{setError('');await fn();await refresh();}catch(e){setError(errorMessage(e));}};
  if(!items.length)return null;
  return <section aria-label="Queued messages" className="queued-messages"><h3>Queued messages</h3>{items.map((item)=><article key={item.id} className="queued-message">
    <span className="queued-message__state">Queued · will send when the agent finishes</span>
    {editing===item.id?<textarea aria-label="Edit queued message" value={text} onChange={(e)=>setText(e.target.value)}/>:<p title={item.content}>{item.content||'Attachment message'}{item.attachmentIds.length>0&&<small>{item.attachmentIds.length} attachments</small>}</p>}
    {editing===item.id?<><Button onClick={()=>void act(async()=>{await api.editQueuedMessage(sessionId,item.id,text);setEditing(null);})}>Save</Button><Button variant="secondary" onClick={()=>setEditing(null)}>Cancel</Button></>:<><Button onClick={()=>void act(()=>api.sendQueuedNow(sessionId,item.id))}>Send now</Button><IconButton label="Edit queued message" title="Edit" onClick={()=>{setText(item.content);setEditing(item.id);}}>✎</IconButton><IconButton label="Remove queued message" title="Remove" onClick={()=>void act(()=>api.removeQueuedMessage(sessionId,item.id))}>×</IconButton></>}
  </article>)}{error&&<p role="alert">{error}</p>}</section>;
}
