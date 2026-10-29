import { z } from 'zod';
import { ProviderSchema } from './provider-config';
import { ProgressBoardSnapshotSchema } from './progress-board';

export const TeamChatAgentAuthorSchema = z.object({
  kind: z.literal('agent'), agentId: z.string().trim().min(1).max(100), agentName: z.string().trim().min(1).max(100),
  ownerAccountId: z.string().uuid(), provider: ProviderSchema, model: z.string().trim().min(1).max(150),
}).strict();

export const TeamChatHumanAuthorSchema = z.object({
  kind: z.literal('human'), accountId: z.string().uuid(), displayName: z.string().trim().min(1).max(120),
}).strict();

/** Host-authored, non-chat project metadata. It never represents a person or an agent turn. */
export const TeamChatSystemAuthorSchema = z.object({
  kind: z.literal('system'), deviceId: z.string().uuid(), displayName: z.literal('Mingle'),
}).strict();

export const TeamChatAuthorSchema = z.discriminatedUnion('kind', [TeamChatHumanAuthorSchema, TeamChatAgentAuthorSchema, TeamChatSystemAuthorSchema]);
export const TeamChatRunStateSchema = z.enum(['queued', 'running', 'awaiting-approval', 'completed', 'failed', 'interrupted']);
/** Host-authenticated metadata update for an existing human-authored chat message. */
export const TeamChatRunStateUpdateSchema = z.object({
  sharedProjectId: z.string().uuid(), messageId: z.string().trim().min(1).max(100),
  state: z.enum(['running', 'completed', 'failed']),
}).strict();

export const TeamChatGroupTaskStatusSchema = z.enum(['backlog', 'ready', 'running', 'blocked', 'review', 'done', 'unknown']);
export const TeamChatGroupDeliveryStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']);
export const TeamChatGroupResultStatusSchema = z.enum(['pending', 'in-progress', 'paused', 'failed', 'stopped', 'blocked', 'follow-up', 'review', 'accepted', 'responded', 'unknown']);
export const TeamChatGroupRequestStatusSchema = z.enum(['active', 'paused', 'completed', 'failed', 'interrupted', 'cancelled', 'expired', 'unknown']);

/** Strict allowlist for read-only shared group state. No session transcripts, prompts, local paths or provider context. */
export const TeamChatGroupViewSchema = z.object({
  version: z.number().int().positive(),
  group: z.object({ id: z.string().trim().min(1).max(100), title: z.string().max(100), mode: z.enum(['cowork', 'orchestrated', 'current-leads']), paused: z.boolean() }).strict(),
  routing: z.object({ mode: z.enum(['cowork', 'orchestrated', 'current-leads']), defaultRecipientHandles: z.array(z.string().trim().min(1).max(32)).max(64) }).strict(),
  members: z.array(z.object({ handle: z.string().trim().min(1).max(32), role: z.enum(['peer', 'orchestrator', 'worker']), removed: z.boolean() }).strict()).max(64),
  messages: z.array(z.object({
    id: z.string().trim().min(1).max(100), seq: z.number().int().nonnegative(), kind: z.enum(['user', 'agent', 'assignment', 'status', 'artifact']),
    sourceMessageId: z.string().trim().min(1).max(100).nullable().optional(),
    senderHandle: z.string().trim().min(1).max(32).nullable(), recipientHandles: z.array(z.string().trim().min(1).max(32)).max(64),
    content: z.string().max(8_000), requestId: z.string().trim().min(1).max(100).nullable(), createdAt: z.string().datetime({ offset: true }),
  }).strict()).max(100),
  requests: z.array(z.object({
    id: z.string().trim().min(1).max(100), messageId: z.string().trim().min(1).max(100), plannerHandle: z.string().trim().min(1).max(32).nullable(),
    status: TeamChatGroupRequestStatusSchema, turnsUsed: z.number().int().nonnegative(), createdAt: z.string().datetime({ offset: true }),
  }).strict()).max(20),
  deliveries: z.array(z.object({
    id: z.string().trim().min(1).max(100), requestId: z.string().trim().min(1).max(100), messageId: z.string().trim().min(1).max(100),
    handle: z.string().trim().min(1).max(32), kind: z.enum(['request', 'assignment', 'message', 'result']),
    status: TeamChatGroupDeliveryStatusSchema, hop: z.number().int().nonnegative(), error: z.string().max(240).nullable(),
    createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
  }).strict()).max(200),
  assignments: z.array(z.object({
    id: z.string().trim().min(1).max(100), requestId: z.string().trim().min(1).max(100), deliveryId: z.string().trim().min(1).max(100),
    fromHandle: z.string().trim().min(1).max(32), toHandle: z.string().trim().min(1).max(32), taskId: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(200), taskStatus: TeamChatGroupTaskStatusSchema, scope: z.array(z.string().trim().min(1).max(500)).max(40),
    createdAt: z.string().datetime({ offset: true }),
  }).strict()).max(100),
  /** Optional for backwards compatibility; host-authored, path-free live group progress. */
  board: ProgressBoardSnapshotSchema.optional(),
  result: z.object({
    requestId: z.string().trim().min(1).max(100), status: TeamChatGroupResultStatusSchema, title: z.string().trim().min(1).max(100),
    summary: z.string().trim().min(1).max(500), facts: z.array(z.string().trim().min(1).max(120)).max(12),
    changedPaths: z.array(z.string().trim().min(1).max(500)).max(100),
  }).strict().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const TeamChatMessageSchema = z.object({
  id: z.string().trim().min(1).max(100), teamId: z.string().uuid(), sharedProjectId: z.string().uuid(),
  author: TeamChatAuthorSchema, body: z.string().max(20_000), mentions: z.array(z.string().trim().min(1).max(100)).max(20),
  replyTo: z.string().trim().min(1).max(100).nullable().optional(), createdAt: z.string().datetime({ offset: true }),
  /** Hidden signed system record that carries a bounded, whitelisted shared group view. */
  kind: z.literal('group-view').optional(),
  // Optional only so pre-provenance local history remains readable. Incoming messages must provide both.
  authorDeviceId: z.string().uuid().optional(), authorSignature: z.string().min(80).max(100).optional(),
  deliveryState: z.enum(['sending', 'sent', 'failed']), runState: TeamChatRunStateSchema.nullable(),
  source: z.object({ sessionId: z.string().trim().min(1).max(100), messageId: z.string().trim().min(1).max(100) }).strict().optional(),
}).strict().superRefine((message, ctx) => {
  if (message.kind === 'group-view' && (message.author.kind !== 'system' || !message.source?.messageId.startsWith('team-group-view:'))) {
    ctx.addIssue({ code: 'custom', path: ['kind'], message: 'A shared group view must be a host-signed system record.' });
  }
  if (message.author.kind === 'system' && message.kind !== 'group-view') {
    ctx.addIssue({ code: 'custom', path: ['author'], message: 'System authors are reserved for shared group-view records.' });
  }
});

export const SendTeamChatMessageSchema = z.object({
  body: z.string().trim().min(1).max(20_000), mentions: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  replyTo: z.string().trim().min(1).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.mentions).size !== value.mentions.length) ctx.addIssue({ code: 'custom', path: ['mentions'], message: 'Agent mentions must be unique.' });
});

export const TeamChatSyncRequestSchema = z.object({
  sharedProjectId: z.string().uuid(), requestId: z.string().uuid(), since: z.string().datetime({ offset: true }).nullable(),
  pendingMessageIds: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
}).strict().superRefine((request, ctx) => {
  if (request.pendingMessageIds && new Set(request.pendingMessageIds).size !== request.pendingMessageIds.length) {
    ctx.addIssue({ code: 'custom', path: ['pendingMessageIds'], message: 'Pending message IDs must be unique.' });
  }
});

export const TeamChatSyncResponseSchema = z.object({
  sharedProjectId: z.string().uuid(), requestId: z.string().uuid(),
  batchIndex: z.number().int().min(0).max(199), batchCount: z.number().int().min(1).max(200),
  messages: z.array(TeamChatMessageSchema).max(200),
}).strict().superRefine((value, ctx) => {
  if (value.batchIndex >= value.batchCount) ctx.addIssue({ code: 'custom', path: ['batchIndex'], message: 'Batch index must be below batch count.' });
  if (value.batchCount === 1 && value.batchIndex === 0 && value.messages.length === 0) return;
  if (!value.messages.length) ctx.addIssue({ code: 'custom', path: ['messages'], message: 'Only a single empty completion batch is valid.' });
});

export const TeamChatPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100), before: z.string().trim().min(1).max(100).optional(),
}).strict();

export const ImportTeamChatHistorySchema = z.object({ sessionId: z.string().trim().min(1).max(100) }).strict();

export const TeamChatAgentSchema = z.object({
  id: z.string().min(1).max(100), name: z.string().min(1).max(100), accountId: z.string().uuid(),
  deviceId: z.string().uuid(), projectId: z.string().min(1).max(100), sessionId: z.string().min(1).max(100),
  provider: ProviderSchema, model: z.string().min(1).max(150), state: z.string().min(1).max(50), local: z.boolean(),
}).strict();
export const TeamChatMemberSchema = z.object({ accountId: z.string().uuid(), displayName: z.string().min(1).max(120), role: z.enum(['leader', 'admin', 'member']) }).strict();
export const TeamChatPeerSchema = z.object({
  deviceId: z.string().uuid(), ownerAccountId: z.string().uuid(), name: z.string().min(1).max(100),
  status: z.enum(['online', 'offline', 'revoked']), linked: z.boolean(),
}).strict();
export const TeamChatSnapshotSchema = z.object({
  project: z.object({ teamId: z.string().uuid(), sharedProjectId: z.string().uuid(), name: z.string().min(1).max(100) }).strict(),
  messages: z.array(TeamChatMessageSchema).max(200), hasMore: z.boolean(), nextBefore: z.string().max(100).nullable(),
  groupView: TeamChatGroupViewSchema.nullable().optional(),
  members: z.array(TeamChatMemberSchema).max(500), agents: z.array(TeamChatAgentSchema).max(500),
  transport: z.object({ status: z.enum(['ready', 'offline', 'signed-out', 'unregistered', 'error']),
    error: z.string().max(500).nullable(), localDeviceId: z.string().uuid().nullable(), linkedDeviceCount: z.number().int().nonnegative(),
    onlineDeviceCount: z.number().int().nonnegative(), peers: z.array(TeamChatPeerSchema).max(500) }).strict(),
}).strict();

export type TeamChatMessage = z.infer<typeof TeamChatMessageSchema>;
export type TeamChatAuthor = z.infer<typeof TeamChatAuthorSchema>;
export type TeamChatAgentAuthor = z.infer<typeof TeamChatAgentAuthorSchema>;
export type TeamChatGroupView = z.infer<typeof TeamChatGroupViewSchema>;
export type TeamChatRunStateUpdate = z.infer<typeof TeamChatRunStateUpdateSchema>;
export type TeamChatRunState = z.infer<typeof TeamChatRunStateSchema>;
export type SendTeamChatMessage = z.infer<typeof SendTeamChatMessageSchema>;
export type TeamChatSyncRequest = z.infer<typeof TeamChatSyncRequestSchema>;
export type TeamChatSyncResponse = z.infer<typeof TeamChatSyncResponseSchema>;
export type TeamChatSnapshotData = z.infer<typeof TeamChatSnapshotSchema>;

export interface TeamChatAgent {
  id: string; name: string; accountId: string; deviceId: string; projectId: string; sessionId: string;
  provider: TeamChatAgentAuthor['provider']; model: string; state: string; local: boolean;
}

export interface TeamChatMember { accountId: string; displayName: string; role: 'leader' | 'admin' | 'member' }
export interface TeamChatPeer { deviceId: string; ownerAccountId: string; name: string; status: 'online' | 'offline' | 'revoked'; linked: boolean }

export interface TeamChatSnapshot {
  project: { teamId: string; sharedProjectId: string; name: string };
  messages: TeamChatMessage[]; hasMore: boolean; nextBefore: string | null; groupView?: TeamChatGroupView | null;
  members: TeamChatMember[]; agents: TeamChatAgent[];
  transport: { status: 'ready' | 'offline' | 'signed-out' | 'unregistered' | 'error'; error: string | null; localDeviceId: string | null; linkedDeviceCount: number; onlineDeviceCount: number; peers: TeamChatPeer[] };
}
