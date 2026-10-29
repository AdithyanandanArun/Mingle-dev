import { z } from 'zod';
import { ProviderSchema } from './provider-config';

const TaskStatusSchema = z.enum(['backlog', 'ready', 'running', 'blocked', 'review', 'done']);

const CommitSchema = z.object({
  sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i),
  subject: z.string().max(200),
  at: z.string().datetime({ offset: true }),
}).strict();

export const ProgressBoardStateSchema = z.enum([
  'idle', 'working', 'waiting-approval', 'waiting-answer', 'paused', 'failed', 'stalled',
]);

export const ProgressBoardTaskSchema = z.object({
  id: z.string().min(1).max(100), title: z.string().max(200), status: TaskStatusSchema,
}).strict();

export const ProgressBoardStepSchema = z.object({
  label: z.string().min(1).max(200), current: z.number().int().positive().optional(), total: z.number().int().positive().optional(),
}).strict();

export const ProgressBoardBranchSchema = z.object({
  name: z.string().max(200), lastCommit: CommitSchema.nullable(), pushed: z.boolean().nullable(), merged: z.boolean().nullable(),
}).strict();

export const ProgressBoardHealthSchema = z.object({
  state: z.enum(['ok', 'cooldown', 'stalled', 'failed']),
  until: z.string().datetime({ offset: true }).optional(), reason: z.string().max(160).optional(),
}).strict();

export const ProgressBoardAssignmentHandoffSchema = z.object({
  action: z.enum(['moved', 'took-over']), handle: z.string().min(1).max(32),
}).strict();

export const ProgressBoardMemberSchema = z.object({
  memberId: z.string().min(1).max(100), handle: z.string().min(1).max(32), role: z.enum(['peer', 'orchestrator', 'worker']),
  provider: ProviderSchema, model: z.string().min(1).max(150), device: z.string().min(1).max(120),
  state: ProgressBoardStateSchema, currentTask: ProgressBoardTaskSchema.nullable(), step: ProgressBoardStepSchema.nullable(),
  branch: ProgressBoardBranchSchema.nullable(), blockers: z.array(z.string().max(200)).max(3), health: ProgressBoardHealthSchema.nullable(),
  assignmentHandoff: ProgressBoardAssignmentHandoffSchema.optional(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const ProgressBoardSnapshotSchema = z.object({
  groupId: z.string().min(1).max(100),
  integration: z.object({ branch: z.string().max(200).nullable(), head: CommitSchema.nullable(), lastPush: z.object({
    sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i), at: z.string().datetime({ offset: true }), failure: z.string().max(200).optional(),
  }).strict().nullable() }).strict(),
  members: z.array(ProgressBoardMemberSchema).max(64), updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const ProgressBoardResponseSchema = ProgressBoardSnapshotSchema.extend({
  source: z.enum(['local', 'host']),
  syncedAt: z.string().datetime({ offset: true }).optional(),
}).strict().superRefine((board, ctx) => {
  if (board.source === 'host' && !board.syncedAt) {
    ctx.addIssue({ code: 'custom', path: ['syncedAt'], message: 'A host-synced board must include its sync time.' });
  }
  if (board.source === 'local' && board.syncedAt) {
    ctx.addIssue({ code: 'custom', path: ['syncedAt'], message: 'A local board cannot include a host sync time.' });
  }
});

export type ProgressBoardState = z.infer<typeof ProgressBoardStateSchema>;
export type ProgressBoardTask = z.infer<typeof ProgressBoardTaskSchema>;
export type ProgressBoardStep = z.infer<typeof ProgressBoardStepSchema>;
export type ProgressBoardBranch = z.infer<typeof ProgressBoardBranchSchema>;
export type ProgressBoardHealth = z.infer<typeof ProgressBoardHealthSchema>;
export type ProgressBoardAssignmentHandoff = z.infer<typeof ProgressBoardAssignmentHandoffSchema>;
export type ProgressBoardMember = z.infer<typeof ProgressBoardMemberSchema>;
export type ProgressBoardSnapshot = z.infer<typeof ProgressBoardSnapshotSchema>;
export type ProgressBoardResponse = z.infer<typeof ProgressBoardResponseSchema>;
