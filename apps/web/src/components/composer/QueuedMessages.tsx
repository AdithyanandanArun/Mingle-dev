import { useState } from 'react';
import type { QueuedMessage } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { useMingle } from '../../store/store';

export function QueuedMessages({sessionId,items}:{sessionId:string;items:QueuedMessage[]}) {
  const refresh=useMingle((s)=>s.refreshNow); const [editing,setEditing]=useState<string|null>(null); const [text,setText]=useState(''); const [error,setError]=useState('');
  const act=async(fn:()=>Promise<unknown>)=>{try{setError('');await fn();await refresh();}catch(e){setError(errorMessage(e));}};
  if(!items.length)return null;
  return <section aria-label="Queued messages" className="queued-messages"><h3>Queued messages</h3>{items.map((item)=><article key={item.id} className="queued-message">
    {editing===item.id?<textarea aria-label="Edit queued message" value={text} onChange={(e)=>setText(e.target.value)}/>:<p>{item.content||'Attachment message'}{item.attachmentIds.length>0&&<small>{item.attachmentIds.length} attachments</small>}</p>}
    {editing===item.id?<><button aria-label="Save queued message" onClick={()=>void act(async()=>{await api.editQueuedMessage(sessionId,item.id,text);setEditing(null);})}>Save</button><button onClick={()=>setEditing(null)}>Cancel</button></>:<><button aria-label="Send queued message now" onClick={()=>void act(()=>api.sendQueuedNow(sessionId,item.id))}>Send now</button><button aria-label="Edit queued message" onClick={()=>{setText(item.content);setEditing(item.id);}}>Edit</button><button aria-label="Remove queued message" onClick={()=>void act(()=>api.removeQueuedMessage(sessionId,item.id))}>Remove</button></>}
  </article>)}<div className="sr-only" aria-live="polite">Message queued</div>{error&&<p role="alert">{error}</p>}</section>;
}
