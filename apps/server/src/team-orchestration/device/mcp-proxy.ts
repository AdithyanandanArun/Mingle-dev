import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  TeamArtifactSchema, TeamAssignSchema, TeamMessageSchema, TeamStatusSchema,
  TeamArtifactRefSchema, TeamToolCallPayloadSchema, TeamToolResultPayloadSchema,
} from '@mingle/contracts';
import type { TeamArtifactRef, TeamMcpConnection } from '@mingle/contracts';
import type { AuthenticatedEnvelope } from '../../distributed/execution.ts';
import { redactSecrets, truncate } from '../../util.ts';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_OUTPUT_CHARS = 64_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BINDINGS = 64;
const MAX_IN_FLIGHT = 8;
type TeamArtifactInput = z.infer<typeof TeamArtifactSchema>;

export interface TeamMcpProxyTransport {
  send(input: { teamId: string; toDeviceId: string; kind: string; payload: unknown; idempotencyKey: string }): Promise<unknown>;
  sync(): Promise<void>;
}

interface ProxyBinding {
  token: string;
  teamId: string;
  sharedProjectId: string;
  hostDeviceId: string;
  deliveryId: string;
  agentId: string;
  closed: boolean;
  inFlight: number;
  controllers: Set<AbortController>;
  /** Transfers an owner-local artifact before the host validates/records its typed handoff. */
  prepareArtifact?: (input: TeamArtifactInput, signal: AbortSignal) => Promise<TeamArtifactRef>;
}

interface PendingCall {
  binding: ProxyBinding;
  timer: NodeJS.Timeout;
  resolve(value: { ok: boolean; result?: unknown; error?: string }): void;
}

/** A loopback-only MCP facade. Tool authority remains on the host; this process only relays typed calls. */
export class TeamMcpProxy {
  private server: Server | null = null;
  private listenPort: number | null = null;
  private starting: Promise<void> | null = null;
  private readonly bindings = new Map<string, ProxyBinding>();
  private readonly pending = new Map<string, PendingCall>();

  constructor(private readonly transport: TeamMcpProxyTransport, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = Math.max(1, Math.min(DEFAULT_TIMEOUT_MS, timeoutMs));
  }

  private readonly timeoutMs: number;

  async create(input: Omit<ProxyBinding, 'token' | 'closed' | 'inFlight' | 'controllers'>): Promise<TeamMcpConnection> {
    await this.ensureServer();
    if (this.bindings.size >= MAX_BINDINGS) throw new Error('Too many active device-side team tool connections.');
    const token = randomBytes(32).toString('base64url');
    const binding: ProxyBinding = { ...input, token, closed: false, inFlight: 0, controllers: new Set() };
    this.bindings.set(token, binding);
    return { url: `http://127.0.0.1:${this.listenPort}/mcp`, token };
  }

  resolve(envelope: AuthenticatedEnvelope): void {
    if (envelope.kind !== 'teamgroup.tool.result') return;
    const parsed = TeamToolResultPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const pending = this.pending.get(parsed.data.callId);
    if (!pending || pending.binding.closed || pending.binding.teamId !== envelope.teamId
      || pending.binding.hostDeviceId !== envelope.fromDeviceId || pending.binding.sharedProjectId !== parsed.data.sharedProjectId
      || pending.binding.deliveryId !== parsed.data.deliveryId) return;
    clearTimeout(pending.timer);
    this.pending.delete(parsed.data.callId);
    pending.resolve({ ok: parsed.data.ok, ...(parsed.data.result !== undefined ? { result: parsed.data.result } : {}), ...(parsed.data.error ? { error: parsed.data.error } : {}) });
  }

  closeDelivery(deliveryId: string): void {
    for (const [token, binding] of this.bindings) {
      if (binding.deliveryId !== deliveryId) continue;
      binding.closed = true;
      for (const controller of binding.controllers) controller.abort();
      this.bindings.delete(token);
    }
    for (const [callId, pending] of this.pending) {
      if (pending.binding.deliveryId !== deliveryId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(callId);
      pending.resolve({ ok: false, error: 'This team delivery has ended.' });
    }
  }

  async close(): Promise<void> {
    for (const deliveryId of new Set([...this.bindings.values()].map((binding) => binding.deliveryId))) this.closeDelivery(deliveryId);
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.listenPort = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async ensureServer(): Promise<void> {
    if (this.server && this.listenPort !== null) return;
    if (this.starting) return this.starting;
    const server = createServer((req, res) => { void this.handle(req, res); });
    this.starting = new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('The team MCP relay did not bind a loopback port.'));
        this.server = server;
        this.listenPort = address.port;
        resolve();
      });
    });
    try { await this.starting; }
    finally { this.starting = null; }
  }

  private assertCallLive(binding: ProxyBinding, signal: AbortSignal): void {
    if (binding.closed || signal.aborted) throw new Error('This team delivery has ended.');
  }

  private async call(binding: ProxyBinding, signal: AbortSignal,
    tool: 'team_members' | 'team_inbox' | 'team_assign' | 'team_message' | 'team_artifact' | 'team_status', args: Record<string, unknown>): Promise<unknown> {
    this.assertCallLive(binding, signal);
    let forwardedArgs = args;
    if (tool === 'team_artifact' && binding.prepareArtifact) {
      const artifact = TeamArtifactSchema.parse(args);
      const transfer = TeamArtifactRefSchema.parse(await binding.prepareArtifact(artifact, signal));
      this.assertCallLive(binding, signal);
      if (transfer.path !== artifact.path || transfer.taskId !== artifact.taskId || transfer.revision.toLowerCase() !== artifact.revision.toLowerCase()) {
        throw new Error('The owner-device artifact transfer did not match the requested path, task, and commit.');
      }
      forwardedArgs = { ...artifact, __mingleArtifactTransfer: transfer };
    }
    this.assertCallLive(binding, signal);
    const payload = TeamToolCallPayloadSchema.parse({ sharedProjectId: binding.sharedProjectId,
      deliveryId: binding.deliveryId, callId: randomUUID(), agentId: binding.agentId, tool, args: forwardedArgs });
    const result = new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(payload.callId);
        resolve({ ok: false, error: 'The team lead did not respond to this tool call before the bounded timeout.' });
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(payload.callId, { binding, timer, resolve });
    });
    const abortPending = () => {
      const current = this.pending.get(payload.callId);
      if (!current) return;
      clearTimeout(current.timer);
      this.pending.delete(payload.callId);
      current.resolve({ ok: false, error: 'This team delivery has ended.' });
    };
    signal.addEventListener('abort', abortPending, { once: true });
    try {
      this.assertCallLive(binding, signal);
      await this.transport.send({ teamId: binding.teamId, toDeviceId: binding.hostDeviceId,
        kind: 'teamgroup.tool.call', payload, idempotencyKey: `teamtool:${binding.deliveryId}:${payload.callId}` });
      this.assertCallLive(binding, signal);
      await this.transport.sync();
      this.assertCallLive(binding, signal);
    } catch (error) {
      const pending = this.pending.get(payload.callId);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(payload.callId); pending.resolve({ ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1000) }); }
    } finally {
      signal.removeEventListener('abort', abortPending);
    }
    const reply = await result;
    this.assertCallLive(binding, signal);
    if (!reply.ok) throw new Error(reply.error ?? 'The team tool call failed on the host.');
    return reply.result ?? null;
  }

  private serverFor(binding: ProxyBinding, signal: AbortSignal): McpServer {
    const server = new McpServer({ name: 'mingle-team-proxy', version: '0.0.1' });
    const output = (value: unknown, isError = false) => ({
      content: [{ type: 'text' as const, text: truncate(redactSecrets(JSON.stringify(value) ?? 'null'), MAX_OUTPUT_CHARS) }],
      ...(isError ? { isError: true } : {}),
    });
    const register = (name: ProxyTool, shape: z.ZodRawShape, description: string, parse: (input: unknown) => Record<string, unknown>) => {
      server.registerTool(name, { description, inputSchema: shape }, async (args) => {
        if (signal.aborted || binding.closed) return output('This team delivery has ended.', true);
        try { return output(await this.call(binding, signal, name, parse(args))); }
        catch (error) { return output(redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1000), true); }
      });
    };
    register('team_members', {}, 'List team members, handles, roles and their actual status.', (input) => emptyArgs(input));
    register('team_inbox', {}, 'Read the messages, assignments and artifact references queued for this agent.', (input) => emptyArgs(input));
    register('team_assign', TeamAssignSchema.shape, 'Assign a scoped task through the team lead.', (input) => TeamAssignSchema.parse(input) as unknown as Record<string, unknown>);
    register('team_message', TeamMessageSchema.shape, 'Send a targeted message through the team lead.', (input) => TeamMessageSchema.parse(input) as unknown as Record<string, unknown>);
    register('team_artifact', TeamArtifactSchema.shape, 'Offer a committed artifact through the team lead.', (input) => TeamArtifactSchema.parse(input) as unknown as Record<string, unknown>);
    register('team_status', TeamStatusSchema.shape, 'Report progress for a task through the team lead.', (input) => TeamStatusSchema.parse(input) as unknown as Record<string, unknown>);
    return server;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    const binding = token ? this.bindings.get(token) : undefined;
    if (!binding || binding.closed) { this.reply(res, 401, 'Team tool connection is unavailable or expired.'); return; }
    if (req.url !== '/mcp' || req.method !== 'POST') { this.reply(res, 404, 'Unknown team tool endpoint.'); return; }
    const length = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) { this.reply(res, 413, 'Team tool request is too large.'); return; }
    if (binding.inFlight >= MAX_IN_FLIGHT) { this.reply(res, 429, 'Too many concurrent team tool requests.'); return; }
    binding.inFlight += 1;
    const controller = new AbortController();
    binding.controllers.add(controller);
    const mcp = this.serverFor(binding, controller.signal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES });
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      binding.inFlight = Math.max(0, binding.inFlight - 1);
      binding.controllers.delete(controller);
      if (!res.writableFinished) controller.abort();
      void transport.close();
      void mcp.close();
    };
    res.once('close', cleanup);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) this.reply(res, 500, 'Team tool request failed.');
      cleanup();
    }
  }

  private reply(res: ServerResponse, status: number, error: string): void {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error }));
  }
}

type ProxyTool = 'team_members' | 'team_inbox' | 'team_assign' | 'team_message' | 'team_artifact' | 'team_status';
function emptyArgs(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('This tool accepts no arguments.');
  return {};
}
