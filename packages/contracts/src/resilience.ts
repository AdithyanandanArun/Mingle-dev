import { z } from 'zod';
import { ProviderSchema } from './provider-config';

export const AutonomyModeSchema = z.enum(['supervised', 'balanced', 'extended']);
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

export const TaskFinishCriteriaSchema = z.object({
  mode: z.enum(['acceptance', 'human-review']),
  evidenceRequired: z.boolean(),
  acceptanceProvenance: z.enum(['explicit', 'derived']).optional(),
}).strict();
export type TaskFinishCriteria = z.infer<typeof TaskFinishCriteriaSchema>;

export const AutonomyConfigSchema = z.object({
  mode: AutonomyModeSchema.default('balanced'),
  emergencyTurnLimit: z.number().int().min(2).max(10_000).nullable().optional(),
  taskFinishCriteria: TaskFinishCriteriaSchema.optional(),
}).strict();
export type AutonomyConfig = z.infer<typeof AutonomyConfigSchema>;

export const GroupRecoveryPolicySchema = z.object({
  automaticFallback: z.boolean().default(false),
  allowUnverifiedQuotaFallback: z.boolean().default(false),
  leadFallbackMemberId: z.string().min(1).max(100).nullable().optional(),
  workerFallbacks: z.record(z.string().min(1).max(100), z.string().min(1).max(100)).optional(),
}).strict();
export type GroupRecoveryPolicy = z.infer<typeof GroupRecoveryPolicySchema>;

export const GroupRecoveryStateSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'paused', 'recovering']), reason: z.string().max(1000).optional(),
  lastFailureId: z.string().max(100).optional(), updatedAt: z.string().max(40).optional(), activeRequestId: z.string().max(100).optional(),
  pendingCheckpointId: z.string().max(100).optional(), acknowledgedCheckpointId: z.string().max(100).optional(),
  acknowledgedDeliveryIds: z.array(z.string().max(100)).max(100).optional(),
}).strict();
export type GroupRecoveryState = z.infer<typeof GroupRecoveryStateSchema>;

export const ProviderFailureKindSchema = z.enum([
  'context_exhausted', 'output_truncated', 'quota_exhausted', 'temporary_rate_limit', 'authentication', 'provider_unavailable', 'unknown',
]);
export type ProviderFailureKind = z.infer<typeof ProviderFailureKindSchema>;
export const ProviderFailureSchema = z.object({
  id: z.string().min(1).max(100), sessionId: z.string().min(1).max(100), runId: z.string().min(1).max(100).optional(),
  actor: z.enum(['worker', 'lead', 'session']), kind: ProviderFailureKindSchema,
  provider: ProviderSchema, providerCode: z.string().max(100).optional(), retryable: z.boolean(), safeToRetry: z.boolean().optional(),
  outcomeUnknown: z.boolean().optional(), dispatchState: z.enum(['not-dispatched', 'dispatched', 'unknown']),
  continuationSafety: z.enum(['safe', 'unsafe', 'unknown']), quotaPool: z.string().max(100).optional(),
  retryAt: z.string().datetime({ offset: true }).nullable().optional(),
  message: z.string().max(1000), occurredAt: z.string().datetime({ offset: true }),
}).strict();
export type ProviderFailure = z.infer<typeof ProviderFailureSchema>;

export const GroupMemberHealthSchema = z.object({
  memberId: z.string().min(1).max(100), handle: z.string().min(1).max(32),
  state: z.enum(['ok', 'cooldown', 'stalled', 'failed']), until: z.string().datetime({ offset: true }).optional(),
  reason: z.string().max(500).optional(),
}).strict();
export type GroupMemberHealth = z.infer<typeof GroupMemberHealthSchema>;

export const RecoveryCheckpointSchema = z.object({
  id: z.string().min(1).max(100), version: z.literal(1), sessionId: z.string().min(1).max(100), runId: z.string().min(1).max(100).optional(),
  reason: z.string().min(1).max(200), capturedAt: z.string().datetime({ offset: true }), objective: z.string().max(1000).nullable(),
  tasks: z.array(z.object({ id: z.string().max(100), title: z.string().max(300), description: z.string().max(1000), acceptanceCriteria: z.string().max(1000), status: z.enum(['backlog', 'ready', 'running', 'blocked', 'review', 'done']) }).strict()).max(100),
  worktree: z.object({ path: z.string().max(4096), branch: z.string().max(1000).nullable(), head: z.string().max(100).nullable(), dirtyPaths: z.array(z.string().max(4096)).max(500), dirtyPathsTruncated: z.boolean(), isRepository: z.boolean(), statusKnown: z.boolean() }).strict(),
  artifacts: z.array(z.object({ id: z.string().max(100), path: z.string().max(4096), revision: z.string().max(100), taskId: z.string().max(100).nullable() }).strict()).max(100),
  pendingApprovals: z.array(z.object({ id: z.string().max(100), tool: z.string().max(200), description: z.string().max(1000) }).strict()).max(100),
  errors: z.array(z.object({ id: z.string().max(100), message: z.string().max(1000), runId: z.string().max(100).optional() }).strict()).max(100),
  uncertainTools: z.array(z.object({ id: z.string().max(100), name: z.string().max(200), status: z.enum(['running', 'completed', 'failed', 'interrupted']), summary: z.string().max(1000) }).strict()).max(100),
  notices: z.array(z.string().max(1000)).max(20),
}).strict();
export type RecoveryCheckpoint = z.infer<typeof RecoveryCheckpointSchema>;

const RecoveryActionBase = { idempotencyKey: z.string().min(1).max(100) };
export const RecoveryActionRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retry-delivery'), deliveryId: z.string().min(1).max(100), checkpointId: z.string().min(1).max(100).optional(), approachNote: z.string().max(1000).optional(), ...RecoveryActionBase }).strict(),
  z.object({ action: z.literal('fallback-delivery'), deliveryId: z.string().min(1).max(100), replacementMemberId: z.string().min(1).max(100), checkpointId: z.string().min(1).max(100).optional(), ...RecoveryActionBase }).strict(),
  z.object({ action: z.literal('replace-coordinator'), replacementMemberId: z.string().min(1).max(100), requestId: z.string().min(1).max(100).optional(), checkpointId: z.string().min(1).max(100).optional(), ...RecoveryActionBase }).strict(),
  z.object({ action: z.literal('pause-for-human'), deliveryId: z.string().min(1).max(100).optional(), reason: z.string().min(1).max(1000), ...RecoveryActionBase }).strict(),
  z.object({ action: z.literal('acknowledge-checkpoint'), checkpointId: z.string().min(1).max(100), ...RecoveryActionBase }).strict(),
  z.object({ action: z.literal('resume'), ...RecoveryActionBase }).strict(),
]);
export type RecoveryActionRequest = z.infer<typeof RecoveryActionRequestSchema>;

export const RecoveryActionResultSchema = z.object({
  actionId: z.string().min(1).max(100), groupId: z.string().min(1).max(100),
  action: z.enum(['retry-delivery', 'fallback-delivery', 'replace-coordinator', 'pause-for-human', 'acknowledge-checkpoint', 'resume']),
  status: z.enum(['applied', 'already-applied']), coordinatorEpoch: z.number().int().min(1),
}).strict();
export type RecoveryActionResult = z.infer<typeof RecoveryActionResultSchema>;

export const GroupMilestoneSchema = z.object({
  id: z.string().min(1).max(100), label: z.string().min(1).max(300), status: z.enum(['pending', 'completed', 'blocked']),
  evidence: z.string().max(1000).optional(), acceptanceProvenance: z.enum(['explicit', 'derived']),
}).strict();
export type GroupMilestone = z.infer<typeof GroupMilestoneSchema>;

export const ContextCompactionResultSchema = z.object({
  sessionId: z.string().min(1).max(100), provider: ProviderSchema, status: z.enum(['completed', 'failed', 'unsupported']),
  startedAt: z.string().datetime({ offset: true }), finishedAt: z.string().datetime({ offset: true }), checkpointId: z.string().max(100).nullable(),
  message: z.string().max(1000), error: z.string().max(1000).nullable(),
}).strict();
export type ContextCompactionResult = z.infer<typeof ContextCompactionResultSchema>;
