import {afterEach,describe,expect,it} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {RunOptions} from '@mingle/contracts';
import {EXAMPLE_CLIENT_SESSION_ID} from './example.ts';
import {deferred,startTestApp,waitFor,type TestApp} from './test-utils.ts';
import {newId} from './util.ts';

const apps:TestApp[]=[];const clients:Client[]=[];const gates:Array<ReturnType<typeof deferred<void>>>=[];
afterEach(async()=>{while(gates.length)gates.pop()!.resolve(undefined);while(clients.length)await clients.pop()!.close();while(apps.length){const app=apps.pop()!;await waitFor(()=>app.app.runtime.activeCount()===0).catch(()=>undefined);await app.cleanup();}});
async function boot(){const t=await startTestApp();apps.push(t);await t.api('GET','/api/bootstrap');await t.api('PATCH',`/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}`,{provider:'claude',model:'claude-sonnet-5-5'});return t;}

describe('delegated subagents',()=>{
  it('creates child session with preamble and automatically starts parent with completed result',async()=>{
    const t=await boot();const runs:RunOptions[]=[];const parentResult=deferred<string>();
    t.fake.script=async(o,emit)=>{runs.push(o);if(o.session.parentSessionId){expect(o.prompt).toContain('You are a subagent working for another agent');expect(o.prompt).toContain('Investigate auth');emit({type:'text',text:'Auth is handled in auth.ts.'});}else if(o.prompt.includes('Subagent @'))parentResult.resolve(o.prompt);};
    const response=await t.api('POST',`/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/subagents`,{task:'Investigate auth',name:'researcher'});
    expect(response.status).toBe(201);const record=response.json;const child=t.app.store.getSession(record.childSessionId);
    expect(child).toMatchObject({parentSessionId:EXAMPLE_CLIENT_SESSION_ID,isolated:false,name:'↳ researcher',worktreePath:t.app.store.getSession(EXAMPLE_CLIENT_SESSION_ID)?.worktreePath});
    expect(await parentResult.promise).toContain('Auth is handled in auth.ts.');
    expect(t.app.store.getDelegatedSubagent(record.id)).toMatchObject({status:'completed',resultDelivered:true,resultPreview:'Auth is handled in auth.ts.'});
  });

  it('publishes a model-initiated child and returns its result without a manual launch or delegation keyword', async () => {
    const t = await boot();
    const childRelease = deferred<void>(); gates.push(childRelease);
    const resultReceived = deferred<string>();
    t.fake.script = async (options, emit) => {
      if (options.session.parentSessionId) {
        await childRelease.promise;
        emit({ type: 'text', text: 'Example review complete.' });
      } else if (options.prompt.includes('Subagent @')) {
        resultReceived.resolve(options.prompt);
      } else {
        expect(options.prompt).toContain('Build a coffee shop website');
        expect(options.subagentMcp).toBeTruthy();
        const client = new Client({ name: 'example-autonomous-model', version: '1.0.0' }, { capabilities: {} });
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(options.subagentMcp!.url), {
          requestInit: { headers: { Authorization: `Bearer ${options.subagentMcp!.token}` } },
        }));
        const result = await client.callTool({ name: 'mingle_subagent_start', arguments: { task: 'Review the Example source', name: 'reviewer' } });
        expect(result.isError).not.toBe(true);
        emit({ type: 'text', text: 'Continuing the website while review runs.' });
      }
    };
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`, { content: 'Build a coffee shop website' })).status).toBe(202);
    await waitFor(() => t.app.store.listDelegatedSubagents(EXAMPLE_CLIENT_SESSION_ID).length === 1);
    const snapshot = (await t.api('GET', '/api/bootstrap')).json;
    const child = snapshot.delegatedSubagents.find((row: any) => row.parentSessionId === EXAMPLE_CLIENT_SESSION_ID);
    expect(child).toMatchObject({ name: 'reviewer', status: 'running', requestedBy: 'agent' });
    expect(snapshot.sessions.find((row: any) => row.id === child.childSessionId)).toMatchObject({ parentSessionId: EXAMPLE_CLIENT_SESSION_ID });
    childRelease.resolve(undefined);
    expect(await resultReceived.promise).toContain('Example review complete.');
    expect(t.app.store.getDelegatedSubagent(child.id)).toMatchObject({ status: 'completed', resultDelivered: true });
  });

  it('queues a completed result while the parent is running and drains it after that turn',async()=>{
    const t=await boot();const firstParent=deferred<void>(),parentResult=deferred<string>();let parentRuns=0;
    t.fake.script=async(o,emit)=>{if(o.session.parentSessionId){emit({type:'text',text:'Queued result.'});return;}parentRuns++;if(parentRuns===1)await firstParent.promise;else parentResult.resolve(o.prompt);};
    await t.api('POST',`/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`,{content:'Start parent work'});
    await waitFor(()=>t.app.runtime.isActive(EXAMPLE_CLIENT_SESSION_ID));
    const started=await t.api('POST',`/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/subagents`,{task:'Parallel task'});expect(started.status).toBe(201);
    await waitFor(()=>t.app.store.getDelegatedSubagent(started.json.id)?.status==='completed');
    expect(t.app.store.listQueuedMessages(EXAMPLE_CLIENT_SESSION_ID)).toHaveLength(1);
    firstParent.resolve(undefined);
    expect(await parentResult.promise).toContain('Queued result.');
  });

  it('enforces the concurrent cap and supports MCP start and list; children do not receive recursive MCP',async()=>{
    const t=await boot();const start=deferred<RunOptions>();const hold=deferred<void>();gates.push(hold);
    t.fake.script=async o=>{if(o.session.id===EXAMPLE_CLIENT_SESSION_ID){start.resolve(o);await hold.promise;}else await hold.promise;};
    await t.api('POST',`/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`,{content:'begin'});const options=await start.promise;
    expect(options.subagentMcp).toBeTruthy();const client=new Client({name:'subagent-test',version:'1.0.0'},{capabilities:{}});clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(options.subagentMcp!.url),{requestInit:{headers:{Authorization:`Bearer ${options.subagentMcp!.token}`}}}));
    const result=await client.callTool({name:'mingle_subagent_start',arguments:{task:'Read project contract'}});expect(result.isError).not.toBe(true);
    const listed=await client.callTool({name:'mingle_subagent_list',arguments:{}});expect(listed.isError).not.toBe(true);
    await waitFor(()=>t.app.store.listDelegatedSubagents(EXAMPLE_CLIENT_SESSION_ID).length===1);
    const child=t.app.store.getSession(t.app.store.listDelegatedSubagents(EXAMPLE_CLIENT_SESSION_ID)[0]!.childSessionId)!;
    expect((await waitFor(()=>t.fake.runs.find(r=>r.session.id===child.id)))?.subagentMcp).toBeUndefined();
    // User API and MCP share the same four-running limit.
    for(let i=0;i<3;i++) await t.api('POST',`/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/subagents`,{task:`Task number ${i}`});
    const full=await t.api('POST',`/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/subagents`,{task:'One too many'});expect(full.status).toBe(409);
  });

  it('delivers failures, cancellation and repairs stale running records on restart',async()=>{
    const t=await boot();t.fake.script=async o=>{if(o.session.parentSessionId)throw new Error('fake provider failed');};
    const failed=await t.api('POST',`/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/subagents`,{task:'Fail this run'});await waitFor(()=>t.app.store.getDelegatedSubagent(failed.json.id)?.status==='failed');
    await waitFor(()=>t.app.store.listMessages(EXAMPLE_CLIENT_SESSION_ID).some(m=>m.content.includes('failed:')));
    const cancel=await t.api('POST',`/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/subagents`,{task:'Cancel this run'});const cancelled=await t.api('POST',`/api/subagents/${cancel.json.id}/cancel`);expect(cancelled.json.status).toBe('cancelled');
  });

  it('retains restart interruption as a note without paid work when automatic resume is off', async () => {
    const t = await startTestApp({ keepData: true }); apps.push(t);
    await t.api('GET', '/api/bootstrap');
    t.app.store.updateSettings({ autoResumeOnRestart: false });
    const parent = t.app.store.getSession(EXAMPLE_CLIENT_SESSION_ID)!;
    const child = t.app.store.insertSession({ projectId: parent.projectId, name: '↳ stale', provider: 'claude', model: 'claude-sonnet-5-5',
      effort: parent.effort, policy: parent.policy, isolated: false, worktreePath: parent.worktreePath, branch: parent.branch, parentSessionId: parent.id });
    const record = { id: newId('run'), parentSessionId: parent.id, childSessionId: child.id, name: 'stale', provider: 'claude' as const,
      model: 'claude-sonnet-5-5', task: 'Interrupted by restart', status: 'running' as const, requestedBy: 'agent' as const,
      startedAt: new Date().toISOString(), endedAt: null, resultPreview: null, error: null, resultDelivered: false };
    t.app.store.insertDelegatedSubagent(record);
    const dataDir = t.dataDir; await t.app.close(); apps.pop();
    const restarted = await startTestApp({ dataDir }); apps.push(restarted);
    expect(restarted.app.store.getDelegatedSubagent(record.id)).toMatchObject({ status: 'failed', resultDelivered: true });
    expect(restarted.app.store.listMessages(parent.id).some(m => m.content.includes('stopped because Mingle restarted'))).toBe(true);
    expect(restarted.app.store.listQueuedMessages(parent.id)).toHaveLength(0);
    expect(restarted.fake.runs).toHaveLength(0);
  });

  it('marks a persisted running child failed after restart and returns its recovery note',async()=>{
    const t=await startTestApp({keepData:true});apps.push(t);await t.api('GET','/api/bootstrap');const parent=t.app.store.getSession(EXAMPLE_CLIENT_SESSION_ID)!;
    const child=t.app.store.insertSession({projectId:parent.projectId,name:'↳ stale',provider:'claude',model:'claude-sonnet-5-5',effort:parent.effort,policy:parent.policy,isolated:false,worktreePath:parent.worktreePath,branch:parent.branch,parentSessionId:parent.id});
    const record={id:newId('run'),parentSessionId:parent.id,childSessionId:child.id,name:'stale',provider:'claude' as const,model:'claude-sonnet-5-5',task:'Interrupted by restart',status:'running' as const,requestedBy:'agent' as const,startedAt:new Date().toISOString(),endedAt:null,resultPreview:null,error:null,resultDelivered:false};
    t.app.store.insertDelegatedSubagent(record);const dataDir=t.dataDir;await t.app.close();apps.pop();
    const restarted=await startTestApp({dataDir});apps.push(restarted);
    await waitFor(()=>restarted.app.store.getDelegatedSubagent(record.id)?.status==='failed');
    expect(restarted.app.store.getDelegatedSubagent(record.id)?.error).toBe('Mingle restarted before the subagent finished');
  });
});
