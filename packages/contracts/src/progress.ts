import { z } from 'zod';

export const MingleStatusProgressSchema = z.object({
  current: z.number().int().min(1).max(100_000), total: z.number().int().min(1).max(100_000),
}).strict().refine((value) => value.current <= value.total, 'Progress current cannot exceed total');

export const MingleStatusSetSchema = z.object({
  step: z.string().trim().min(1).max(120), detail: z.string().max(300).optional(), progress: MingleStatusProgressSchema.optional(),
}).strict();
export type MingleStatusSet = z.infer<typeof MingleStatusSetSchema>;

export const MinglePlanUpdateSchema = z.object({
  steps: z.array(z.object({
    title: z.string().trim().min(1).max(160), status: z.enum(['pending', 'in_progress', 'done', 'blocked']),
  }).strict()).max(30),
}).strict();
export type MinglePlanUpdate = z.infer<typeof MinglePlanUpdateSchema>;

export interface ProgressMcpConnection { url: string; token: string }
