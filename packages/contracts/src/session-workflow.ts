import { z } from 'zod';
import { AttachmentIdsSchema } from './attachments';
import { MessageContextRefsSchema } from './message-context';
import type { Effort, Policy, Provider } from './provider-config';

export const WorkflowLimitsSchema = z.object({
  maxTurns: z.number().int().min(1).max(50).default(8),
  maxElapsedMinutes: z.number().int().min(1).max(1440).default(240),
  maxStalls: z.number().int().min(1).max(5).default(2),
}).strict();
export type WorkflowLimits = z.infer<typeof WorkflowLimitsSchema>;
export const StartSessionWorkflowSchema = z.object({
  goal: z.string().trim().min(1).max(30_000),
  memory: z.enum(['exclude']).optional(),
  limits: WorkflowLimitsSchema.default({ maxTurns: 8, maxElapsedMinutes: 240, maxStalls: 2 }),
  attachmentIds: AttachmentIdsSchema.optional(), contextRefs: MessageContextRefsSchema.optional(),
}).strict();
export type StartSessionWorkflowInput = z.input<typeof StartSessionWorkflowSchema>;
export const WorkflowControlSchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();
export const ResumeSessionWorkflowSchema = WorkflowControlSchema.extend({
  additionalTurns: z.number().int().min(1).max(20).optional(),
  extendMinutes: z.number().int().min(1).max(240).optional(),
}).strict();
export type ResumeSessionWorkflowInput = z.infer<typeof ResumeSessionWorkflowSchema>;
export const WorkflowFinishSchema = z.object({
  outcome: z.enum(['complete', 'blocked', 'needs_human']),
  summary: z.string().trim().min(1).max(2000),
}).strict();
export type WorkflowFinish = z.infer<typeof WorkflowFinishSchema>;
export type WorkflowStopReason = 'user-pause' | 'user-stop' | 'needs-input' | 'approval-denied' | 'quota' | 'failure' | 'limit' | 'stalled' | 'goal-complete' | 'agent-blocked' | 'refused' | 'app-closed' | 'configuration-changed' | 'unreported-outcome' | 'session-unavailable';
export interface SessionWorkflow {
  id: string; sessionId: string; taskId: string; goal: string;
  state: 'running' | 'paused' | 'stopped' | 'completed'; version: number;
  stopReason: WorkflowStopReason | null; summary: string | null;
  limits: WorkflowLimits; counters: { turns: number; stalls: number };
  currentRunId: string | null; lastRunId: string | null;
  configuration: { provider: Provider; model: string; effort: Effort; policy: Policy; serviceTier: string; worktreePath: string; branch: string | null };
  createdAt: string; updatedAt: string; deadlineAt: string;
}
