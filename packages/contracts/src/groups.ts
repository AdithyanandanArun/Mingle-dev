import { z } from 'zod';
import { ProviderSchema, PolicySchema, EffortSchema, ServiceTierSchema } from './provider-config';
import { AttachmentIdsSchema, NativeInvocationInputSchema } from './attachments';
import { MessageContextRefsSchema } from './message-context';
import type { AttachmentRef, GroupInvocation } from './attachments';
import { AutonomyConfigSchema, GroupRecoveryPolicySchema } from './resilience';

export const GroupModeSchema = z.enum(['cowork', 'orchestrated', 'current-leads']);
export type GroupMode = z.infer<typeof GroupModeSchema>;
export const AgentConfigurationSchema = z.object({
  provider: ProviderSchema, model: z.string().trim().min(1).max(150), effort: EffortSchema,
  policy: PolicySchema, serviceTier: ServiceTierSchema.default('standard'),
}).strict();
export type AgentConfiguration = z.infer<typeof AgentConfigurationSchema>;
export const GroupDefaultsSchema = z.object({
  orchestrator: AgentConfigurationSchema.optional(), worker: AgentConfigurationSchema.optional(),
  maxParallel: z.number().int().min(1).max(6).default(2), maxTurns: z.number().int().min(2).max(10_000).default(80),
  maxHops: z.number().int().min(1).max(12).default(6), autonomy: AutonomyConfigSchema.optional(),
}).strict();
export type GroupDefaults = z.infer<typeof GroupDefaultsSchema>;
export const AgentHandleSchema = z.string().trim().toLowerCase().min(2).max(32).regex(/^[a-z][a-z0-9_-]*$/, 'Use letters, numbers, underscores or hyphens; start with a letter');
export const AddGroupAgentSchema = z.object({
  configuration: AgentConfigurationSchema, handle: AgentHandleSchema,
  isolated: z.boolean().default(true),
}).strict();
export type AddGroupAgent = z.infer<typeof AddGroupAgentSchema>;
export const CreateGroupSchema = z.object({
  sessionId: z.string().min(1).max(100), mode: GroupModeSchema, agent: AddGroupAgentSchema,
  orchestrator: AgentConfigurationSchema.optional(),
  currentConfiguration: AgentConfigurationSchema.omit({ provider: true }).optional(),
}).strict();
export type CreateGroup = z.infer<typeof CreateGroupSchema>;
export const UpdateGroupSchema = z.object({
  mode: GroupModeSchema.optional(), orchestratorMemberId: z.string().min(1).max(100).optional(),
  maxParallel: z.number().int().min(1).max(6).optional(), maxTurns: z.number().int().min(2).max(10_000).optional(),
  maxHops: z.number().int().min(1).max(12).optional(), autonomy: AutonomyConfigSchema.optional(), recoveryPolicy: GroupRecoveryPolicySchema.optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, 'Supply a group setting to update');
export type UpdateGroup = z.infer<typeof UpdateGroupSchema>;
export const SendGroupMessageSchema = z.object({
  content: z.string().trim().max(100_000).default(''), recipients: z.array(z.string().min(1).max(100)).min(1).max(8).optional(),
  intent: z.enum(['normal', 'plan']).default('normal'),
  clientMessageId: z.string().min(1).max(100).optional(),
  attachmentIds: AttachmentIdsSchema.optional(),
  contextRefs: MessageContextRefsSchema.optional(),
  /** An explicit provider-native command or skill for exactly one member; revalidated against a fresh catalog at dispatch. */
  invocation: NativeInvocationInputSchema.optional(),
}).strict().refine((body) => body.content.length > 0 || (body.attachmentIds?.length ?? 0) > 0, { message: 'Write a message or attach a file', path: ['content'] });
export type SendGroupMessage = z.infer<typeof SendGroupMessageSchema>;
export interface ConversationGroup {
  id: string; projectId: string; title: string; anchorSessionId: string; mode: GroupMode;
  orchestratorMemberId: string | null; paused: boolean; pauseReason: string | null;
  maxParallel: number; maxTurns: number; maxHops: number; createdAt: string; updatedAt: string;
  autonomy?: import('./resilience').AutonomyConfig; recoveryPolicy?: import('./resilience').GroupRecoveryPolicy;
  recoveryState?: import('./resilience').GroupRecoveryState; coordinatorEpoch?: number;
}
export interface GroupMember {
  id: string; groupId: string; sessionId: string; handle: string; role: 'peer' | 'orchestrator' | 'worker';
  joinedAt: string; removedAt: string | null; held?: boolean; failure?: import('./resilience').ProviderFailure;
}
export interface GroupMessage {
  id: string; seq: number; groupId: string; senderMemberId: string | null; recipientMemberIds: string[];
  kind: 'user' | 'agent' | 'assignment' | 'status' | 'artifact'; content: string;
  requestId: string | null; replyToId: string | null; sourceMessageId: string | null;
  sourceRunId: string | null; createdAt: string;
  /** Files the human attached to this message; metadata only. */
  attachments?: AttachmentRef[];
  /** Explicit bounded file references and quoted assistant excerpts included with this human message. */
  contextRefs?: import('./message-context').MessageContextRef[];
  /** The validated native command or skill this message addresses to one member. */
  invocation?: Pick<GroupInvocation, 'kind' | 'name' | 'arguments' | 'memberId'>;
}
export interface GroupRequest {
  id: string; groupId: string; messageId: string; plannerMemberId: string;
  status: 'active' | 'completed' | 'paused'; turnsUsed: number; createdAt: string; intent: 'normal' | 'plan'; executionPlanId?: string;
  /** Internal per-request extensions; never change the group's configured defaults. */
  autoTurnLimit?: number; autoMaxHops?: number;
}
export interface GroupDelivery {
  id: string; groupId: string; requestId: string; messageId: string; memberId: string;
  /** Durable dispatch purpose; optional for older snapshots. Completion is a turn outcome, not task acceptance. */
  kind?: 'request' | 'assignment' | 'message' | 'result';
  /** Coordinator authority generation captured when this delivery was claimed. */
  coordinatorEpoch?: number;
  failure?: import('./resilience').ProviderFailure;
  recoveredByDeliveryId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  runId: string | null; hop: number; error: string | null; createdAt: string; updatedAt: string;
}
export interface GroupAssignment {
  id: string; groupId: string; requestId: string; fromMemberId: string; toMemberId: string;
  taskId: string; deliveryId: string; scope: string[]; createdAt: string;
  acceptanceProvenance?: 'explicit' | 'derived'; milestones?: import('./resilience').GroupMilestone[];
  /** Present after a full-access orchestrator verifies and accepts this assignment. */
  acceptedBy?: 'orchestrator'; verificationSummary?: string;
}
export interface GroupSnapshot {
  group: ConversationGroup; members: GroupMember[]; messages: GroupMessage[];
  requests: GroupRequest[]; deliveries: GroupDelivery[]; assignments: GroupAssignment[];
}
export interface GroupRunContext { groupId: string; memberId: string; requestId: string; deliveryId: string; hop: number; instructions: string }
export interface TeamMcpConnection { url: string; token: string }
export const TeamAssignSchema = z.object({
  recipient: AgentHandleSchema, title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(12000), acceptanceCriteria: z.string().max(4000).default(''),
  scope: z.array(z.string().min(1).max(1000)).min(1).max(40),
  dependsOn: z.array(z.string().min(1).max(100)).max(30).default([]),
  inputArtifacts: z.array(z.object({ taskId: z.string().min(1).max(100), path: z.string().min(1).max(4096) }).strict()).max(30).default([]),
}).strict();
export const TeamMessageSchema = z.object({
  recipient: AgentHandleSchema, content: z.string().trim().min(1).max(12000),
  expectsReply: z.boolean().default(false), replyToId: z.string().min(1).max(100).optional(),
}).strict();
export const TeamArtifactSchema = z.object({
  recipient: AgentHandleSchema, path: z.string().min(1).max(4096), revision: z.string().min(1).max(100),
  note: z.string().max(4000).default(''), taskId: z.string().min(1).max(100).optional(),
}).strict();
export const TeamStatusSchema = z.object({ taskId: z.string().min(1).max(100), status: z.enum(['running','blocked','review']), note: z.string().max(4000).default('') }).strict();

/** Explicit verification evidence required when a full-access orchestrator accepts a reviewed task. */
export const TeamAcceptTaskSchema = z.object({
  taskId: z.string().trim().min(1).max(100), verificationSummary: z.string().trim().min(8).max(4_000),
}).strict();
export type TeamAcceptTask = z.infer<typeof TeamAcceptTaskSchema>;
