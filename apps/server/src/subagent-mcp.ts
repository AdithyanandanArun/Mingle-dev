import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage,ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Session,ProviderInfo } from '@mingle/contracts';
import { StartSubagentSchema } from '@mingle/contracts';
import type { DelegatedSubagentService } from './delegated-subagents.ts';
import type { Store } from './store.ts';
import { errorMessage,redactSecrets,truncate } from './util.ts';

interface Binding {runId:string;session:Session;signal:AbortSignal;live:()=>boolean;revoked:boolean}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const INSTRUCTIONS='Use Mingle subagent tools for self-contained parallel work. Start a subagent and continue your own work; Mingle sends its result automatically as a new message when it finishes.';
export class SubagentMcpBridge {
  private bindings=new Map<string,Binding>();
  constructor(private store:Store,private service:DelegatedSubagentService,private providers:()=>ProviderInfo[]|null,private port:()=>number,private host:()=>string=()=> '127.0.0.1'){}
  create(input:{runId:string;session:Session;signal:AbortSignal;live:()=>boolean}){const token=randomBytes(32).toString('base64url');this.bindings.set(hash(token),{...input,revoked:false});const h=this.host();return {url:`http://${['localhost','127.0.0.1','::1'].includes(h)?(h==='::1'?`[${h}]`:h):'127.0.0.1'}:${this.port()}/api/subagents/mcp`,token};}
  revoke(runId:string){for(const [key,b] of this.bindings)if(b.runId===runId){b.revoked=true;this.bindings.delete(key);}}
  close(){this.bindings.clear();}
  private ensure(b:Binding,s:AbortSignal){if(b.revoked||b.signal.aborted||s.aborted||!b.live()||!this.store.getSession(b.session.id))throw new Error('This subagent tool connection has expired');}
  private server(b:Binding,signal:AbortSignal){const server=new McpServer({name:'mingle-subagents',version:'0.0.1'},{instructions:INSTRUCTIONS});const result=(text:string)=>({content:[{type:'text' as const,text}]});const invoke=async(fn:()=>unknown|Promise<unknown>)=>{try{this.ensure(b,signal);const value=await fn();this.ensure(b,signal);return result(JSON.stringify(value));}catch(e){return {...result(truncate(redactSecrets(errorMessage(e)),500)),isError:true};}};
    const available=(this.providers()??[]).filter(p=>p.available).map(p=>`${p.name}: ${p.models.map(m=>m.id).join(', ')||'default model'}`).join('; ')||'No providers currently available';
    server.registerTool('mingle_subagent_start',{description:`Start a Mingle subagent on any available provider to work on a self-contained task in parallel. It runs in the background; you don't need to wait — end your turn when you have nothing else to do, and Mingle will send you its result automatically as a new message. Available provider/models: ${available}`,inputSchema:StartSubagentSchema.shape,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},args=>invoke(()=>this.service.start(b.session.id,StartSubagentSchema.parse(args),'agent')));
    server.registerTool('mingle_subagent_list',{description:'List this parent session’s subagents and their status.',inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},()=>invoke(()=>this.service.list(b.session.id)));
    server.registerTool('mingle_subagent_result',{description:'Read a subagent’s full final answer after it finishes.',inputSchema:{id:z.string().min(1)},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},args=>invoke(()=>{const row=this.service.get(args.id);if(row.parentSessionId!==b.session.id)throw new Error('Subagent does not belong to this session');if(row.status==='running')throw new Error('Subagent is still running');return this.store.lastAssistantMessage(row.childSessionId)?.content??row.error??'';}));
    server.registerTool('mingle_subagent_cancel',{description:'Cancel a running subagent owned by this session.',inputSchema:{id:z.string().min(1)},annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}},args=>invoke(()=>{const row=this.service.get(args.id);if(row.parentSessionId!==b.session.id)throw new Error('Subagent does not belong to this session');return this.service.cancel(args.id);}));
    return server;}
  async handle(req:IncomingMessage,res:ServerResponse){const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization??'')?.[1];const b=token?this.bindings.get(hash(token)):undefined;res.setHeader('Cache-Control','no-store');if(!b||b.revoked||b.signal.aborted||!b.live()){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Subagent tool connection is unavailable or expired'}));return;}if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'});res.end();return;}const ctl=new AbortController(),server=this.server(b,ctl.signal),transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});res.once('close',()=>{if(!res.writableFinished)ctl.abort();void transport.close();void server.close();});try{await server.connect(transport);await transport.handleRequest(req,res);}catch{if(!res.headersSent){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Subagent tool request failed'}));}else res.destroy();await transport.close();await server.close();}}
}
