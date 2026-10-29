import type { ProviderTaskPlan, Session, Task, TaskStatus } from '@mingle/contracts';
import { findCycle } from '../dag.ts';
import type { Store } from '../store.ts';
import { redactSecrets } from '../util.ts';
import type { TaskOps } from './taskops.ts';

export interface PlanSummary { created: Task[]; updated: Task[]; missing: Task[]; changed: boolean }

type Step = ProviderTaskPlan['steps'][number];

/**
 * Source-key prefix of one plan. Native task lists (`claude-tasks…`) and Mingle progress plans carry persistent step IDs,
 * so their keys are scoped to the session only (`provider:<session>:<planId>:<nativeId>`, with source.providerId = the ID).
 * Every other plan (Codex plans, Claude todo lists) identifies steps by title, so the same title in an unrelated request
 * must not reuse an old task: those keys are anchored to the parent request task, or to the run when there is none.
 * Continuation runs of the same parent keep their identity.
 */
export function planPrefix(session: Session, planId: string, parentTaskId: string | undefined, runId: string): string {
  if (planId.startsWith('claude-tasks') || planId.startsWith('mingle-status:')) return `provider:${session.id}:${planId}:`;
  return `provider:${session.id}:${parentTaskId ? `parent:${parentTaskId}` : `run:${runId}`}:${planId}:`;
}

/** What Mingle shows for a provider-reported step. Completed means "ready for a person to review", never done. */
function desiredStatus(reported: Step['status'], runActive: boolean): TaskStatus {
  if (reported === 'completed') return 'review';
  if (reported === 'blocked') return 'blocked';
  if (reported === 'in_progress') return runActive ? 'running' : 'ready';
  return 'ready';
}

/**
 * Maps a validated native provider plan to real tasks. Each step keeps the provider's own plan and step identity in its
 * source key, so repeated plan updates change the same task. Dependencies come only from the provider's explicit
 * dependsOn, restricted to steps that map to known tasks; order is never treated as a dependency.
 */
export function applyProviderPlan(store: Store, ops: TaskOps, session: Session, runId: string, plan: ProviderTaskPlan, parentTaskId: string | undefined): PlanSummary {
  const summary: PlanSummary = { created: [], updated: [], missing: [], changed: false };
  const projectId = session.projectId;
  const prefix = planPrefix(session, plan.planId, parentTaskId, runId);
  const keyOf = (stepId: string) => `${prefix}${stepId}`;
  const runActive = store.getRun(runId)?.status === 'running';
  const steps: Step[] = [];
  const stepIds = new Set<string>();
  for (const step of plan.steps) {
    if (stepIds.has(step.id)) continue; // a malformed duplicate step id is ignored rather than merged
    stepIds.add(step.id);
    steps.push(step);
  }

  const providerTasks = ops.sourced(projectId, 'provider');
  const byKey = new Map(providerTasks.map((task) => [task.source!.key, task]));
  const taskByStep = new Map<string, Task>();
  const usedIds = new Set<string>();

  // Pass 1: make sure a task exists for every step and carries the provider's current text.
  for (const step of steps) {
    const title = redactSecrets(step.title).slice(0, 200);
    const description = step.description === undefined ? undefined : redactSecrets(step.description).slice(0, 4000);
    let task = byKey.get(keyOf(step.id));
    if (!task) {
      const created = store.insertTask({ projectId, title, description: description ?? '', acceptanceCriteria: '', sessionId: session.id, dependsOn: [], status: 'backlog' });
      store.setTaskSource(created.id, { kind: 'provider', key: keyOf(step.id), runId, providerId: step.id, ...(parentTaskId ? { parentTaskId } : {}), reportedStatus: step.status });
      task = store.getTask(created.id) ?? created;
      summary.created.push(task);
    } else {
      const wasMissing = Boolean(task.source!.missing);
      ops.patchSource(task, { runId, providerId: step.id, reportedStatus: step.status, missing: false, ...(parentTaskId && !task.source!.parentTaskId ? { parentTaskId } : {}) });
      let changed = wasMissing;
      if (ops.retitle(task, title)) changed = true;
      if (description !== undefined && description !== task.description && !ops.hasOverride(task, 'description')) { store.updateTask(task.id, { description }); ops.markDirty(); changed = true; }
      if (changed) summary.updated.push(task);
    }
    usedIds.add(task.id);
    taskByStep.set(step.id, store.getTask(task.id) ?? task);
  }

  const resolve = (stepId: string): Task | undefined => taskByStep.get(stepId) ?? byKey.get(keyOf(stepId));

  // Pass 2: explicit dependencies, then the status the reported state and those dependencies allow.
  for (const step of steps) {
    let task = taskByStep.get(step.id)!;
    if (step.dependsOn !== undefined && !ops.hasOverride(task, 'dependsOn')) {
      const accepted: string[] = [];
      for (const depStep of new Set(step.dependsOn)) {
        const dep = resolve(depStep);
        if (!dep || dep.id === task.id || dep.projectId !== projectId) continue;
        if (findCycle(task.id, [...accepted, dep.id], (id) => store.getTask(id)?.dependsOn)) continue;
        accepted.push(dep.id);
      }
      if (JSON.stringify(accepted) !== JSON.stringify(task.dependsOn)) {
        store.updateTask(task.id, { dependsOn: accepted });
        ops.markDirty();
        task = store.getTask(task.id)!;
        if (!summary.created.some((item) => item.id === task.id) && !summary.updated.some((item) => item.id === task.id)) summary.updated.push(task);
      }
    }
    if (task.status !== 'done') {
      const before = task.status;
      const moved = ops.setStatus(task, desiredStatus(step.status, runActive), { blockedFallback: true });
      if (moved) {
        task = moved;
        if (before !== moved.status && !summary.created.some((item) => item.id === moved.id) && !summary.updated.some((item) => item.id === moved.id)) summary.updated.push(moved);
      }
    }
    taskByStep.set(step.id, store.getTask(task.id) ?? task);
  }

  if (plan.replace) {
    const kept = new Set(steps.map((step) => keyOf(step.id)));
    for (const task of providerTasks) {
      const source = task.source!;
      if (!source.key.startsWith(prefix) || kept.has(source.key) || source.missing || usedIds.has(task.id)) continue;
      ops.patchSource(task, { missing: true });
      if (task.status === 'backlog' || task.status === 'ready') ops.setStatus(task, 'review');
      summary.missing.push(store.getTask(task.id) ?? task);
    }
  }
  summary.changed = summary.created.length + summary.updated.length + summary.missing.length > 0;
  return summary;
}
