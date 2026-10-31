import type { DelegatedSubagent, Provider, StartSubagent } from '@mingle/contracts';
import { MAX_RUNNING_SUBAGENTS } from '@mingle/contracts';
import type { Store } from './store.ts';
import type { WorkspaceService } from './workspace.ts';
import type { SessionRuntime } from './runtime.ts';
import type { ProviderInfo } from '@mingle/contracts';
import { defaultModel, providerName } from './provider-config.ts';
import { conflict, newId, notFound } from './util.ts';

export class DelegatedSubagentService {
  private pending=new Map<string,number>();
  constructor(private store:Store,private workspace:WorkspaceService,private runtime:SessionRuntime,private providers:()=>ProviderInfo[]|null,private isGroupSession:(id:string)=>boolean=()=>false) {
    runtime.onRunFinished((sessionId,outcome,error)=>this.onRunFinished(sessionId,outcome,error));
  }
  async start(parentSessionId:string,input:StartSubagent,requestedBy:'agent'|'user'):Promise<DelegatedSubagent> {
    const parent=this.store.getSession(parentSessionId); if(!parent)throw notFound('Parent session not found');
    if(parent.parentSessionId || this.isGroupSession(parent.id))throw conflict('Subagents can only be started from a single-agent session.');
    const running=this.store.listDelegatedSubagents(parent.id).filter(x=>x.status==='running').length;
    if(running+(this.pending.get(parent.id)??0)>=MAX_RUNNING_SUBAGENTS)throw conflict(`A session can run at most ${MAX_RUNNING_SUBAGENTS} subagents at once.`);
    const provider:Provider=input.provider??parent.provider;
    const info=this.providers()?.find(x=>x.id===provider);
    if(!info?.available)throw conflict(`${providerName(provider)} isn't available on this computer`);
    const model=input.model??(provider===parent.provider?parent.model:defaultModel(provider,this.store.getSettings()));
    const task=input.task.trim();
    const base=input.name??(task.split(/\s+/u).slice(0,4).join('-').toLowerCase().replace(/[^a-z0-9-]/gu,'').replace(/-+/gu,'-').replace(/^-|-$/gu,'').slice(0,40)||'subagent');
    let name=base, suffix=2; const names=new Set(this.store.listDelegatedSubagents(parent.id).map(x=>x.name));while(names.has(name))name=`${base.slice(0,Math.max(1,39-String(suffix).length))}-${suffix++}`;
    this.pending.set(parent.id,(this.pending.get(parent.id)??0)+1);
    let child;
    try { child=await this.workspace.createSession({projectId:parent.projectId,name:`↳ ${name}`,provider,model,policy:parent.policy,isolated:false}, {parentSessionId:parent.id,worktreePath:parent.worktreePath,branch:parent.branch}); }
    finally { const remaining=(this.pending.get(parent.id)??1)-1;if(remaining)this.pending.set(parent.id,remaining);else this.pending.delete(parent.id); }
    const record:DelegatedSubagent={id:newId('run'),parentSessionId:parent.id,childSessionId:child.id,name,provider,model,task,status:'running',requestedBy,startedAt:new Date().toISOString(),endedAt:null,resultPreview:null,error:null,resultDelivered:false};
    this.store.insertDelegatedSubagent(record);
    try { this.runtime.start(child.id,`You are a subagent working for another agent. Do only this task, then end with a concise final answer that the other agent can use. Don't ask the user questions.\n\nTask:\n${task}`); }
    catch(error) { this.finish(child.id,'failed',String(error)); }
    return record;
  }
  list(parentSessionId?:string):DelegatedSubagent[]{return this.store.listDelegatedSubagents(parentSessionId);}
  get(id:string):DelegatedSubagent {const row=this.store.getDelegatedSubagent(id);if(!row)throw notFound('Subagent not found');return row;}
  cancel(id:string):DelegatedSubagent {const row=this.get(id);if(row.status!=='running')return row;this.runtime.interrupt(row.childSessionId);this.finish(row.childSessionId,'cancelled','Cancelled');return this.get(id);}
  private onRunFinished(sessionId:string,outcome:'completed'|'failed'|'interrupted',failure:string|null):void {if(this.store.getSession(sessionId)?.parentSessionId)this.finish(sessionId,outcome==='completed'?'completed':outcome==='interrupted'?'cancelled':'failed',failure??undefined);}
  private finish(childSessionId:string,status:DelegatedSubagent['status'],error?:string):void {
    const row=this.store.listDelegatedSubagents().find(x=>x.childSessionId===childSessionId&&x.status==='running');if(!row)return;
    const answer=this.store.lastAssistantMessage(childSessionId)?.content??'';const failed=status==='failed'||status==='cancelled';
    this.store.updateDelegatedSubagent(row.id,{status,endedAt:new Date().toISOString(),resultPreview:answer.slice(0,400)||null,error:error??null});
    const message=status==='cancelled'?`Subagent @${row.name} was cancelled.`:failed?`Subagent @${row.name} (${providerName(row.provider)} ${row.model}) failed: ${error??'Unknown error'}`:`Subagent @${row.name} (${providerName(row.provider)} ${row.model}) finished.\n\nTask: ${row.task.slice(0,300)}\n\nResult:\n${answer.slice(-12000)}\n\nContinue your work using this result.`;
    void this.deliver(row.parentSessionId,message).then(()=>this.store.updateDelegatedSubagent(row.id,{resultDelivered:true})).catch(()=>{this.store.enqueueMessage({id:newId('msg'),sessionId:row.parentSessionId,content:message,intent:'normal',skills:[],attachmentIds:[],contextRefs:[]});this.store.updateDelegatedSubagent(row.id,{resultDelivered:true});this.runtime.drainQueued(row.parentSessionId);});
  }
  private async deliver(parentId:string,content:string):Promise<void> {
    const parent=this.store.getSession(parentId);if(!parent)return;
    if(parent.status==='running'&&this.runtime.isSteerable(parentId)){if(await this.runtime.steer(parentId,content))return;}
    // Queue the result, then drain at once if the parent is idle; a parent that is still running drains it when its run ends.
    this.store.enqueueMessage({id:newId('msg'),sessionId:parentId,content,intent:'normal',skills:[],attachmentIds:[],contextRefs:[]});
    this.runtime.drainQueued(parentId);
  }
  /**
   * Marks subagents interrupted by a restart as failed. Their note wakes the parent only when "Resume after restart" is
   * on; otherwise it is shown in the parent's chat without starting a run.
   */
  recover():void {
    const resume=this.store.getSettings().autoResumeOnRestart!==false;
    for(const row of this.store.listDelegatedSubagents().filter(x=>x.status==='running')){
      const child=this.store.getSession(row.childSessionId);
      if(child&&(child.status==='running'||child.status==='waiting'))continue;
      if(resume){this.finish(row.childSessionId,'failed','Mingle restarted before the subagent finished');continue;}
      this.store.updateDelegatedSubagent(row.id,{status:'failed',endedAt:new Date().toISOString(),error:'Mingle restarted before the subagent finished'});
      this.store.insertMessage({sessionId:row.parentSessionId,role:'system',kind:'info',content:`Subagent @${row.name} (${providerName(row.provider)} ${row.model}) stopped because Mingle restarted before it finished.`});
      this.store.updateDelegatedSubagent(row.id,{resultDelivered:true});
    }
  }
}
