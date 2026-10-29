import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MinglePlanUpdateSchema, MingleStatusSetSchema } from '@mingle/contracts';
import type { MinglePlanUpdate, MingleStatusSet, ProgressMcpConnection, Session } from '@mingle/contracts';
import type { Store } from './store.ts';
import { errorMessage, redactSecrets, truncate } from './util.ts';

interface Binding {
  runId: string;
  session: Session;
  signal: AbortSignal;
  isLive: () => boolean;
  setStatus: (status: MingleStatusSet) => void;
  updatePlan: (plan: MinglePlanUpdate) => void;
  revoked: boolean;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const STATUS_INSTRUCTIONS = 'mingle_status_set updates the short live progress label and optional detail. Use it to keep Mingle’s composer status current during multi-step work.';
const PLAN_INSTRUCTIONS = 'mingle_plan_update replaces the checklist displayed above the composer. Keep steps concise and update their statuses as work changes.';

/** Run-scoped local MCP tools for durable, user-visible progress. */
export class ProgressMcpBridge {
  private readonly bindings = new Map<string, Binding>();

  constructor(private readonly store: Store, private readonly getPort: () => number, private readonly getHost: () => string = () => '127.0.0.1') {}

  create(input: {
    runId: string; session: Session; signal: AbortSignal; isLive: () => boolean;
    setStatus: (status: MingleStatusSet) => void; updatePlan: (plan: MinglePlanUpdate) => void;
  }): ProgressMcpConnection {
    if (this.bindings.size >= 256) throw new Error('Too many active progress tool connections');
    const token = randomBytes(32).toString('base64url');
    this.bindings.set(hash(token), { ...input, revoked: false });
    const configuredHost = this.getHost();
    const host = ['localhost', '127.0.0.1', '::1'].includes(configuredHost) ? configuredHost : '127.0.0.1';
    return { url: `http://${host === '::1' ? `[${host}]` : host}:${this.getPort()}/api/progress/mcp`, token };
  }

  revoke(runId: string): void {
    for (const [key, binding] of this.bindings) if (binding.runId === runId) {
      binding.revoked = true;
      this.bindings.delete(key);
    }
  }

  close(): void {
    for (const binding of this.bindings.values()) binding.revoked = true;
    this.bindings.clear();
  }

  private ensure(binding: Binding, requestSignal: AbortSignal): void {
    if (binding.revoked || binding.signal.aborted || requestSignal.aborted || !binding.isLive() || !this.store.getSession(binding.session.id)) {
      throw new Error('This progress tool connection has expired');
    }
  }

  private tools(binding: Binding, requestSignal: AbortSignal): McpServer {
    const server = new McpServer({ name: 'mingle-progress', version: '0.0.1' }, {
      instructions: `${STATUS_INSTRUCTIONS} ${PLAN_INSTRUCTIONS}`,
    });
    const result = (text: string) => ({ content: [{ type: 'text' as const, text }] });
    server.registerTool('mingle_status_set', {
      description: 'Set the current short status and optional detail shown in Mingle’s composer.',
      inputSchema: MingleStatusSetSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (args) => {
      try {
        this.ensure(binding, requestSignal);
        binding.setStatus(MingleStatusSetSchema.parse(args));
        this.ensure(binding, requestSignal);
        return result('Mingle progress status updated.');
      } catch (error) {
        return { ...result(truncate(redactSecrets(errorMessage(error)), 500)), isError: true };
      }
    });
    server.registerTool('mingle_plan_update', {
      description: 'Replace the current Mingle plan checklist shown above the composer.',
      inputSchema: MinglePlanUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (args) => {
      try {
        this.ensure(binding, requestSignal);
        binding.updatePlan(MinglePlanUpdateSchema.parse(args));
        this.ensure(binding, requestSignal);
        return result('Mingle progress checklist replaced.');
      } catch (error) {
        return { ...result(truncate(redactSecrets(errorMessage(error)), 500)), isError: true };
      }
    });
    return server;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    const binding = token ? this.bindings.get(hash(token)) : undefined;
    res.setHeader('Cache-Control', 'no-store');
    if (!binding || binding.revoked || binding.signal.aborted || !binding.isLive() || !this.store.getSession(binding.session.id)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Progress tool connection is unavailable or expired' }));
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
    const requestController = new AbortController();
    const server = this.tools(binding, requestController.signal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { if (!res.writableFinished) requestController.abort(); void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Progress tool request failed' })); }
      else res.destroy();
      await transport.close();
      await server.close();
    }
  }
}
