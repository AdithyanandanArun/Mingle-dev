import type { Approval, Session, SessionRun, Task, ToolCall, UserQuestion, WorkspaceEvent } from '@mingle/contracts';

export type StatusBarStepStatus = 'pending' | 'in_progress' | 'done' | 'blocked';
export interface StatusBarStep { id: string; title: string; status: StatusBarStepStatus }
export interface StatusBarState {
  primary: string;
  secondary?: string;
  running: boolean;
  steps: StatusBarStep[];
}

export interface StatusBarInput {
  session: Session;
  runs: readonly SessionRun[];
  toolCalls: readonly ToolCall[];
  tasks: readonly Task[];
  events: readonly WorkspaceEvent[];
  approvals: readonly Approval[];
  questions: readonly UserQuestion[];
  waitingAgents?: readonly { name: string; running: boolean }[];
}

interface PlanCandidate { steps: StatusBarStep[]; updatedAt: string }

function latest<T extends { id: number }>(items: readonly T[]): T | undefined {
  return items.reduce<T | undefined>((found, item) => !found || item.id > found.id ? item : found, undefined);
}

function eventPlan(events: readonly WorkspaceEvent[], sessionId: string): PlanCandidate | undefined {
  const event = latest(events.filter((item) => item.sessionId === sessionId && item.type === 'session.progress.plan'));
  const payload = event?.payload;
  if (!event || !payload || !Array.isArray(payload.steps)) return undefined;
  const steps = payload.steps.flatMap((raw, index): StatusBarStep[] => {
    if (!raw || typeof raw !== 'object') return [];
    const step = raw as Record<string, unknown>;
    if (typeof step.title !== 'string' || !step.title.trim()) return [];
    const status = step.status;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'done' && status !== 'blocked') return [];
    return [{ id: typeof step.id === 'string' ? step.id : `mingle-${index + 1}`, title: step.title, status }];
  });
  return { steps, updatedAt: event.createdAt };
}

function nativePlan(tasks: readonly Task[], runs: readonly SessionRun[], sessionId: string): PlanCandidate | undefined {
  const sourced = tasks.filter((task) => task.sessionId === sessionId && task.source?.kind === 'provider'
    && task.source.providerId && task.source.runId && !task.source.missing);
  if (!sourced.length) return undefined;
  const activeRun = runs.filter((run) => run.sessionId === sessionId && run.status === 'running')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1);
  const sourceRun = activeRun?.id ?? sourced.reduce((selected, task) => {
    const run = runs.find((candidate) => candidate.id === task.source!.runId);
    const selectedRun = runs.find((candidate) => candidate.id === selected);
    if (!selectedRun) return task.source!.runId!;
    return run && run.startedAt.localeCompare(selectedRun.startedAt) > 0 ? run.id : selected;
  }, sourced[0]!.source!.runId!);
  const runTasks = sourced.filter((task) => task.source!.runId === sourceRun);
  const groups = new Map<string, Task[]>();
  for (const task of runTasks) {
    const key = task.source!.key;
    const id = task.source!.providerId!;
    const prefix = key.endsWith(`:${id}`) ? key.slice(0, -id.length - 1) : key;
    const group = groups.get(prefix) ?? [];
    group.push(task);
    groups.set(prefix, group);
  }
  const planTasks = [...groups.values()].sort((left, right) => {
    const leftAt = left.reduce((at, task) => task.updatedAt > at ? task.updatedAt : at, '');
    const rightAt = right.reduce((at, task) => task.updatedAt > at ? task.updatedAt : at, '');
    return rightAt.localeCompare(leftAt);
  })[0];
  if (!planTasks?.length) return undefined;
  const steps = [...planTasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((task) => {
    const reported = task.source?.reportedStatus;
    const status: StatusBarStepStatus = reported === 'completed' ? 'done'
      : reported === 'blocked' || task.status === 'blocked' ? 'blocked'
        : reported === 'in_progress' || task.status === 'running' ? 'in_progress' : 'pending';
    return { id: task.id, title: task.title, status };
  });
  return { steps, updatedAt: planTasks.reduce((at, task) => task.updatedAt > at ? task.updatedAt : at, '') };
}

function statusFromEvent(events: readonly WorkspaceEvent[], sessionId: string, runId: string | undefined): { step: string; detail?: string; progress?: { current: number; total: number } } | undefined {
  if (!runId) return undefined;
  const event = latest(events.filter((item) => item.sessionId === sessionId && item.type === 'session.progress.status'
    && item.payload.runId === runId));
  const raw = event?.payload.status;
  if (!raw || typeof raw !== 'object') return undefined;
  const status = raw as Record<string, unknown>;
  if (typeof status.step !== 'string' || !status.step.trim()) return undefined;
  const progress = status.progress && typeof status.progress === 'object' ? status.progress as Record<string, unknown> : undefined;
  return {
    step: status.step,
    ...(typeof status.detail === 'string' ? { detail: status.detail } : {}),
    ...(progress && Number.isInteger(progress.current) && Number.isInteger(progress.total)
      ? { progress: { current: progress.current as number, total: progress.total as number } } : {}),
  };
}

function runningAgentNames(calls: readonly ToolCall[], runId: string | undefined): string[] {
  if (!runId) return [];
  return calls.filter((call) => call.runId === runId && call.category === 'agent' && call.status === 'running'
    && !/mingle_team|team_/i.test(call.name)).map((call, index) => {
      try {
        const input: unknown = JSON.parse(call.input);
        if (input && typeof input === 'object' && !Array.isArray(input)) {
          const data = input as Record<string, unknown>;
          for (const field of ['description', 'name', 'subagent_type', 'agentType', 'type']) {
            if (typeof data[field] === 'string' && data[field].trim()) return (data[field] as string).trim();
          }
        }
      } catch { /* provider input can be an incomplete snapshot */ }
      return call.summary.trim() || `Subagent ${index + 1}`;
    });
}

function activeStep(steps: readonly StatusBarStep[]): { step: StatusBarStep; index: number } | undefined {
  const index = steps.findIndex((step) => step.status === 'in_progress');
  const next = index >= 0 ? index : steps.findIndex((step) => step.status === 'pending');
  if (next >= 0) return { step: steps[next]!, index: next };
  const blocked = steps.findIndex((step) => step.status === 'blocked');
  return blocked >= 0 ? { step: steps[blocked]!, index: blocked } : undefined;
}

/** Derives the compact composer status, keeping explicit run progress ahead of native plans and tool activity. */
export function deriveStatusBarState(input: StatusBarInput): StatusBarState | null {
  const { session } = input;
  const activeRun = input.runs.filter((run) => run.sessionId === session.id && run.status === 'running')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1);
  const running = Boolean(activeRun) || session.status === 'running' || session.status === 'waiting';
  const explicit = statusFromEvent(input.events, session.id, activeRun?.id);
  const eventPlanValue = eventPlan(input.events, session.id);
  const nativePlanValue = nativePlan(input.tasks, input.runs, session.id);
  const plan = eventPlanValue && (!nativePlanValue || eventPlanValue.updatedAt >= nativePlanValue.updatedAt) ? eventPlanValue : nativePlanValue;
  const steps = plan?.steps ?? [];
  const unfinished = steps.some((step) => step.status !== 'done');
  const pendingApproval = input.approvals.some((approval) => approval.sessionId === session.id && approval.status === 'pending');
  const pendingQuestion = input.questions.some((question) => question.sessionId === session.id && question.status === 'pending');
  const agents = (input.waitingAgents ?? []).filter((agent) => agent.running);
  const subagents = runningAgentNames(input.toolCalls, activeRun?.id);
  if (!running && !unfinished && !agents.length) return null;

  let primary = 'Working…';
  let secondary: string | undefined;
  if (explicit && running) {
    primary = explicit.step;
    const progress = explicit.progress ? `Step ${explicit.progress.current} of ${explicit.progress.total}` : undefined;
    secondary = [progress, explicit.detail, subagents.length ? subagents.join(', ') : undefined, agents.length ? `${agents.length} agent${agents.length === 1 ? '' : 's'} active` : undefined].filter(Boolean).join(' · ') || undefined;
  } else if (unfinished) {
    const current = activeStep(steps);
    if (current) {
      primary = current.step.status === 'blocked' ? `Blocked · ${current.step.title}` : current.step.title;
      secondary = [`Step ${current.index + 1} of ${steps.length}`, subagents.length ? subagents.join(', ') : undefined,
        agents.length ? `Waiting on ${agents.length} agent${agents.length === 1 ? '' : 's'}${agents.length === 1 ? ` · ${agents[0]!.name}` : ''}` : undefined].filter(Boolean).join(' · ');
    }
  } else if (subagents.length) {
    primary = `Waiting on ${subagents.length} subagent${subagents.length === 1 ? '' : 's'}`;
    secondary = subagents.join(', ');
  } else if (agents.length) {
    primary = `Waiting on ${agents.length} agent${agents.length === 1 ? '' : 's'}`;
    secondary = agents.map((agent) => agent.name).filter(Boolean).join(', ') || undefined;
  } else if (pendingQuestion) {
    primary = 'Waiting for your answer';
  } else if (pendingApproval) {
    primary = 'Waiting for approval';
  } else if (session.status === 'waiting') {
    primary = 'Waiting…';
  }

  return { primary, secondary, running, steps: unfinished ? steps : [] };
}
