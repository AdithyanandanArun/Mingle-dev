import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { TeamAcceptTaskSchema, TeamArtifactSchema, TeamAssignSchema, TeamMessageSchema, TeamStatusSchema } from '@mingle/contracts';
import type { GroupRunContext, Session, TeamMcpConnection } from '@mingle/contracts';
import type { Store } from './store.ts';
import { errorMessage, truncate } from './util.ts';
import { redactSecrets } from './providers/common.ts';

type Input<S extends z.ZodType> = z.input<S>;

/**
 * The group operations this bridge relies on. GroupService implements them; every call receives the
 * host-owned run context, so the service derives sender, role, lease and ownership itself.
 */
export interface TeamGroupService {
  /** Throws unless this run is the active delivery of this member's current session. */
  assertRunContext(ctx: GroupRunContext, runId: string, sessionId: string): void;
  members(ctx: GroupRunContext): unknown;
  inbox(ctx: GroupRunContext): unknown;
  assign(ctx: GroupRunContext, input: Input<typeof TeamAssignSchema>): unknown;
  message(ctx: GroupRunContext, input: Input<typeof TeamMessageSchema>): unknown;
  artifact(ctx: GroupRunContext, input: Input<typeof TeamArtifactSchema>): Promise<unknown>;
  status(ctx: GroupRunContext, input: Input<typeof TeamStatusSchema>): unknown;
  acceptTask(ctx: GroupRunContext, input: Input<typeof TeamAcceptTaskSchema>): unknown;
}

/** Optional distributed recovery tools retain the existing run-scoped group authority. */
export interface DistributedTeamTools {
  recoveryShape: z.ZodRawShape;
  members(context: GroupRunContext, sessionId: string): Promise<unknown>;
  recover(context: GroupRunContext, sessionId: string, input: Record<string, unknown>): Promise<unknown>;
}

export type TeamAcceptanceHandler = (context: GroupRunContext, sessionId: string, input: Input<typeof TeamAcceptTaskSchema>) => Promise<unknown>;

interface Binding {
  runId: string; sessionId: string; signal: AbortSignal; context: Readonly<GroupRunContext>;
  revoked: boolean; inFlight: number;
}

const MAX_BINDINGS = 64;
const MAX_IN_FLIGHT = 8;
const MAX_BODY_BYTES = 256 * 1024;
const OUTPUT_LIMIT = 64_000;
const ERROR_LIMIT = 1_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const INSTRUCTIONS = [
  'These tools are Mingle’s host-authenticated team interface for this one run. Mingle derives your identity, role and group from the run itself; you cannot choose or change the sender.',
  'Call team_members first to see each member’s handle, role and actual status, including your own. Call team_inbox to read what Mingle has queued for you.',
  'Who may assign work is enforced by the host on every call. In Orchestrated and Current agent leads groups only the designated orchestrator assigns work. In Cowork only the peer holding this request’s temporary planning lease may assign, and only within that lease; any member may message or report on its own work. A refusal is final: do not try to work around it.',
  'team_assign, team_message and team_artifact confirm acceptance or queueing, never completion. Every assignment needs a meaningful scoped objective and finish condition; if acceptance criteria are omitted, Mingle derives and labels one from the objective and edit scope. A derived criterion is not evidence of completion or acceptance. team_status reports progress on a task you own. Recipients are handles such as claude1; team_assign also accepts recipient "auto", which chooses an eligible member and reports the choice. Split work into non-overlapping scopes, prefer "auto" unless one agent is clearly better, and consider roster load and health; do not assign to cooldown/stalled members. Mingle rejects overlaps with another member\'s queued, running or Review scope. Mingle never dispatches work by scanning your prose for @mentions, so use these tools to reach someone.',
  'For completion, publish required committed handoff files once with team_artifact (one file revision per call, only when a real commit exists), record team_status review when ready, then give a concise final summary. For cross-device work Mingle commits and pushes only the scoped completion branch; workers must not report absolute device paths. On a returned completion, the coordinator immediately inspects the fetched branch/ref, runs checks and decides whether it passes; do not answer Pending or wait for another human prompt. In a full-access group or team, the coordinator may call team_accept with a verification summary; Mingle marks the task done, merges local worker branches, and pushes the integration branch normally. Cross-device teams also send no-wake notices to remote workers after a successful push. Supervised mode leaves acceptance to the human. Unresolved work stays blocked. Do not send unsolicited completion acknowledgments or wake peers solely to repeat completion. Answer concrete teammate questions concisely with replyToId when needed. A coordinator answers the human once, with the outcome first, each member’s contribution, where work was integrated, which checks it ran versus peers reported, and what still needs review.',
  'Keep payloads compact: scoped objectives, exact paths and revisions, and concise questions. Limits, edit-scope ownership and delegation budgets are enforced by the host.',
  'When available, team_remote_agents lists explicitly shared agents on linked team devices. Local execution remains the default. Use team_remote_recover only for a stopped task with verified quota/provider exhaustion after eligible local alternatives are exhausted; it queues destination-owner review and grants no execution, quota-spend, push or command permission.',
  'Group autonomy is reported by team_members. In supervised mode, or when balanced mode expands beyond the accepted edit scope, team_assign may return awaiting-human-ack with a durable checkpoint ID; stop creating assignments and tell the coordinator that human acknowledgment is required. Repeating the same tool call does not acknowledge a checkpoint.',
].join(' ');

/** Authenticated, run-scoped MCP access to the group coordination layer. */
export class TeamMcpBridge {
  private bindings = new Map<string, Binding>();
  private distributed: DistributedTeamTools | null = null;
  private acceptanceHandler: TeamAcceptanceHandler | null = null;
  constructor(private groups: TeamGroupService, private store: Store, private getPort: () => number, private getHost: () => string = () => '127.0.0.1') {}

  setDistributedTools(tools: DistributedTeamTools): void { this.distributed = tools; }
  setAcceptanceHandler(handler: TeamAcceptanceHandler): void { this.acceptanceHandler = handler; }

  create(runId: string, session: Session, signal: AbortSignal, context: GroupRunContext): TeamMcpConnection {
    if (this.bindings.size >= MAX_BINDINGS) throw new Error('Too many active team tool connections');
    if (!runId || !session.id) throw new Error('A team tool connection requires a run and session');
    for (const binding of this.bindings.values()) if (binding.runId === runId) throw new Error('This run already has a team tool connection');
    const token = randomBytes(32).toString('base64url');
    const frozen = Object.freeze({ groupId: context.groupId, memberId: context.memberId, requestId: context.requestId, deliveryId: context.deliveryId, hop: context.hop, instructions: context.instructions });
    this.bindings.set(hash(token), { runId, sessionId: session.id, signal, context: frozen, revoked: false, inFlight: 0 });
    const host = this.getHost();
    return { url: `http://${host.includes(':') ? `[${host}]` : host}:${this.getPort()}/api/team/mcp`, token };
  }

  revoke(runId: string): void {
    for (const [key, binding] of this.bindings) if (binding.runId === runId) { binding.revoked = true; this.bindings.delete(key); }
  }

  /** Executes an owner-device MCP request against the same live host binding and group guards. */
  async callRemote(runId: string, sessionId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const binding = [...this.bindings.values()].find((candidate) => candidate.runId === runId && candidate.sessionId === sessionId);
    if (!binding || !this.active(binding)) throw new Error('This team tool delivery is no longer active.');
    const ctx = binding.context;
    switch (tool) {
      case 'team_members': this.ensure(binding, binding.signal); return this.groups.members(ctx);
      case 'team_inbox': this.ensure(binding, binding.signal); return this.groups.inbox(ctx);
      case 'team_assign': this.ensure(binding, binding.signal); return this.groups.assign(ctx, TeamAssignSchema.parse(args));
      case 'team_message': this.ensure(binding, binding.signal); return this.groups.message(ctx, TeamMessageSchema.parse(args));
      case 'team_artifact': this.ensure(binding, binding.signal); return this.groups.artifact(ctx, TeamArtifactSchema.parse(args));
      case 'team_status': this.ensure(binding, binding.signal); return this.groups.status(ctx, TeamStatusSchema.parse(args));
      case 'team_accept': this.ensure(binding, binding.signal); return this.acceptanceHandler?.(ctx, binding.sessionId, TeamAcceptTaskSchema.parse(args)) ?? Promise.reject(new Error('Task acceptance is unavailable.'));
      default: throw new Error('Unsupported team tool.');
    }
  }

  close(): void {
    for (const binding of this.bindings.values()) binding.revoked = true;
    this.bindings.clear();
  }

  /** True while the run is live, its session exists, and the group service still recognizes this delivery. */
  private active(binding: Binding): boolean {
    if (binding.revoked || binding.signal.aborted || !this.store.getSession(binding.sessionId)) return false;
    try { this.groups.assertRunContext(binding.context, binding.runId, binding.sessionId); return true; } catch { return false; }
  }

  private ensure(binding: Binding, requestSignal: AbortSignal, finishing = false): void {
    if (requestSignal.aborted) throw new Error('This team request was cancelled');
    if (!this.active(binding)) {
      throw new Error(finishing
        ? 'This team tool connection expired while the request was finishing; the action may already have been recorded.'
        : 'This team tool connection has expired');
    }
  }

  private tools(binding: Binding, requestSignal: AbortSignal): McpServer {
    const server = new McpServer({ name: 'mingle-team', version: '0.0.1' }, { instructions: INSTRUCTIONS });
    const output = (value: unknown) => ({ content: [{ type: 'text' as const, text: truncate(redactSecrets(JSON.stringify(value) ?? 'null'), OUTPUT_LIMIT) }] });
    const register = (name: string, description: string, shape: z.ZodRawShape, hints: { readOnly: boolean; idempotent: boolean },
      operation: (args: Record<string, unknown>) => Promise<unknown> | unknown) => {
      server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: hints.readOnly, destructiveHint: false, idempotentHint: hints.idempotent, openWorldHint: false } }, async (args) => {
        try {
          this.ensure(binding, requestSignal);
          const result = await operation(args as Record<string, unknown>);
          this.ensure(binding, requestSignal, true);
          return output(result);
        } catch (error) {
          return { content: [{ type: 'text' as const, text: truncate(redactSecrets(errorMessage(error)), ERROR_LIMIT) }], isError: true };
        }
      });
    };
    const ctx = binding.context;
    register('team_members', 'List this group’s members with their handles, roles and actual status. Start here to learn your role and who you can reach.', {}, { readOnly: true, idempotent: true }, () => this.groups.members(ctx));
    register('team_inbox', 'Read the messages, assignments and artifact references Mingle has queued for you.', {}, { readOnly: false, idempotent: true }, () => this.groups.inbox(ctx));
    register('team_assign', 'Assign a scoped task to a member handle or use recipient "auto" to select an eligible agent by scope continuity, load, health and provider diversity. Use non-overlapping scopes. If acceptanceCriteria is omitted, Mingle persists a labeled condition derived from the objective and edit scope; that is not evidence of completion. Allowed only when your role or planning lease permits it. A success means the assignment was accepted and queued, not completed; awaiting-human-ack means no assignment was queued.',
      TeamAssignSchema.shape, { readOnly: false, idempotent: false }, (args) => this.groups.assign(ctx, TeamAssignSchema.parse(args)));
    register('team_message', 'Send a targeted question, reply or note to one member. Set expectsReply only when you need an answer; success means the message was queued. Avoid unsolicited or repetitive completion acknowledgments; normal completion goes through team_artifact, team_status and your final answer. Answer concrete teammate questions concisely with replyToId when needed, setting expectsReply when your answer must let that teammate continue.',
      TeamMessageSchema.shape, { readOnly: false, idempotent: false }, (args) => this.groups.message(ctx, TeamMessageSchema.parse(args)));
    register('team_artifact', 'Offer another member one committed file revision per call. The host verifies the path and revision before delivery; unverified references are rejected. Publish each required handoff file once for that revision; never invent an artifact when nothing is committed.',
      TeamArtifactSchema.shape, { readOnly: false, idempotent: false }, (args) => this.groups.artifact(ctx, TeamArtifactSchema.parse(args)));
    register('team_status', 'Report running, blocked or review status for a task you own. Use review once when your work is ready for human review; it is not Done. This records an event and does not itself start a model run.',
      TeamStatusSchema.shape, { readOnly: false, idempotent: true }, (args) => this.groups.status(ctx, TeamStatusSchema.parse(args)));
    const distributed = this.distributed;
    if (distributed) {
      register('team_remote_agents', 'List explicitly shared agents on linked team devices, with reported availability and quota. Local agents remain the default. Listing a remote agent grants no permission to execute on its device.',
        {}, { readOnly: true, idempotent: true }, () => distributed.members(ctx, binding.sessionId));
      register('team_remote_recover', 'Propose exceptional recovery of a stopped task on a linked device after verified local provider exhaustion. The host checks the current group planning authority and source failure. Acceptance only queues a request for the destination device owner; it never grants execution, quota, Git push or command permissions.',
        distributed.recoveryShape, { readOnly: false, idempotent: true }, (args) => distributed.recover(ctx, binding.sessionId, args));
    }
    if (this.acceptanceHandler) register('team_accept', 'Accept a completed worker task after reviewing its changes and running applicable verification. Requires full-access group/team authority, a task in Review, and a concise verificationSummary. Mingle merges local worker branches into the group integration worktree; cross-device team acceptance merges the fetched worker ref and pushes the integration branch normally, then records no-wake notices for remote workers. Merge conflicts return 409 and must be resolved manually. Supervised groups and teams leave tasks for human acceptance.',
      TeamAcceptTaskSchema.shape, { readOnly: false, idempotent: true }, (args) => this.acceptanceHandler!(ctx, binding.sessionId, TeamAcceptTaskSchema.parse(args)));
    return server;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, error: string, headers: Record<string, string> = {}) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify({ error }));
    };
    res.setHeader('Cache-Control', 'no-store');
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    const binding = token ? this.bindings.get(hash(token)) : undefined;
    if (!binding || !this.active(binding)) { reply(401, 'Team tool connection is unavailable or expired'); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
    const length = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) { reply(413, 'Team tool request is too large'); return; }
    if (binding.inFlight >= MAX_IN_FLIGHT) { reply(429, 'Too many concurrent team tool requests', { 'Retry-After': '1' }); return; }
    binding.inFlight += 1;
    const requestController = new AbortController();
    const server = this.tools(binding, requestController.signal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES });
    let released = false;
    const release = () => { if (!released) { released = true; binding.inFlight -= 1; } };
    res.once('close', () => { if (!res.writableFinished) requestController.abort(); release(); void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      reply(500, 'Team tool request failed');
      release();
      await transport.close(); await server.close();
    }
  }
}
