import { ContextCompactionResultSchema, EditSessionPlanSchema, NativeUserInputRequestSchema, ProviderTaskPlanSchema, SessionPlanProposalSchema, SessionPlanStepsSchema, UserInputAnswersSchema } from '@mingle/contracts';
import type { ProjectIntelligenceService } from './project-intelligence/service.ts';
import { existsSync, statSync } from 'node:fs';
import type { ProviderTaskPlan, AdapterEvent, Approval, ContextCompactionResult, EditSessionPlan, Message, MinglePlanUpdate, MingleStatusSet, ProviderFailure, ProviderSkill, RunChanges, RunOptions, Session, SessionPlan, SubagentMessage, Task, UserInputAnswers, UserQuestion, ToolActivity, ToolCall } from '@mingle/contracts';
import type { Hub } from './hub.ts';
import type { Store } from './store.ts';
import type { TaskService } from './tasks.ts';
import type { Logger, ProviderRuntime } from './types.ts';
import { badRequest, conflict, errorMessage, notFound, redactSecrets, truncate, newId, nowIso } from './util.ts';
import { captureRunTree, compareRunTrees, unavailableRunChanges, type RunTreeSnapshot } from './run-changes.ts';
import type { GroupService } from './groups/service.ts';
import type { TeamMcpBridge } from './team-mcp.ts';
import type { BrowserMcpBridge } from './browser-mcp.ts';
import type { ProgressMcpBridge } from './progress-mcp.ts';
import type { AttachmentService } from './attachments/service.ts';
import type { NativeInvocation, RunAttachment } from '@mingle/contracts';
import type { RecoveryService } from './recovery/service.ts';
import type { TeamProxyRuntimeService } from './team-orchestration/types.ts';
import { providerFailure } from './providers/failure.ts';
import type { DispatchAwareOptions, DispatchState } from './providers/common.ts';
import { buildMessageContext } from './message-context.ts';
import { buildProviderHandoff } from './provider-handoff.ts';
import { git } from './repository/git-run.ts';

export interface RuntimeOptions {
  /** Milliseconds to wait after an abort before declaring an unresponsive adapter interrupted. */
  abortGraceMs?: number;
  /** Interval for persisting streamed assistant text. */
  flushIntervalMs?: number;
  /** Maximum time to wait for a native provider question before cancelling the run. */
  userInputTimeoutMs?: number;
}

interface ToolBuffer { call: ToolCall; output: string; dirty: boolean; tick: number | null }

const MAX_SUBAGENT_MESSAGES = 30;
const MAX_SUBAGENT_TEXT_PER_MESSAGE = 8_000;
const MAX_SUBAGENT_TEXT_TOTAL = 24_000;

function isSubagentLaunch(provider: Session['provider'], call: ToolCall): boolean {
  if (call.category !== 'agent' || /mingle_team|team_/i.test(call.name)) return false;
  if (provider === 'claude') return call.name === 'Task' || call.name === 'Agent';
  if (provider === 'codex') return call.name === 'agent:spawnAgent' || call.name === 'agent:spawn_agent';
  if (provider === 'opencode') return call.name.toLowerCase() === 'task';
  return false;
}

interface ActiveRun {
  id: string;
  startedAt: string;
  provider: Session['provider'];
  tick: number;
  tools: Map<string, ToolBuffer>;
  activityTimer: NodeJS.Timeout | null;
  sessionId: string;
  controller: AbortController;
  closed: boolean;
  cleanupPending: boolean;
  acceptingTools: boolean;
  approvals: Map<string, (allowed: boolean) => void>;
  questions: Map<string, (answers: UserInputAnswers | null) => void>;
  stream: { messageId: string; text: string; dirty: boolean } | null;
  flushTimer: NodeJS.Timeout | null;
  consumedHandoffs: string[];
  firstEvent: boolean;
  capabilityTokens: string[];
  baseInput: number;
  baseOutput: number;
  baseCost: number | null;
  taskId: string | null;
  skills: ProviderSkill[];
  invocation?: NativeInvocation;
  intent: 'normal' | 'plan';
  executionPlanId?: string;
  context?: string;
  providerHandoff?: {
    fromProvider: Session['provider']; fromModel: string; pendingAt: string;
    messages: Message[]; latestPlan?: SessionPlan; openTasks: Task[];
  };
  contextRefs?: Message['contextRefs'];
  deferContextResolution?: boolean;
  resolveSkills?: () => Promise<ProviderSkill[]>;
  attachmentOwnerKind?: 'message' | 'group_message';
  attachmentOwnerId?: string;
  changeBaseline: RunTreeSnapshot | null;
  dispatchState: DispatchState;
  failureCause?: unknown;
  teamRun: boolean;
  teamMcpConnection?: import('@mingle/contracts').TeamMcpConnection;
  onActivity?: (event: AdapterEvent) => void;
  onApproval?: (approval: Approval) => void;
  onApprovalDecision?: (approval: Approval, decision: 'approved' | 'denied') => void;
  promise: Promise<void>;
}

interface ActiveCompaction {
  controller: AbortController;
  operationId: string;
  cleanupPending: boolean;
  startedAt: string;
  previousStatus: Session['status'];
  previousError: string | null;
  promise: Promise<ContextCompactionResult>;
}

export interface StartOptions {
  groupDeliveryId?: string; taskId?: string; userMessage?: { content: string; kind?: string }; skills?: ProviderSkill[];
  attachmentIds?: string[]; attachmentOwnerKind?: 'message' | 'group_message'; attachmentOwnerId?: string;
  invocation?: NativeInvocation; context?: string; contextRefs?: Message['contextRefs']; deferContextResolution?: boolean;
  resolveSkills?: () => Promise<ProviderSkill[]>; intent?: 'normal' | 'plan'; executionPlanId?: string;
  /** Device-owned team delivery: bypass local group context and use its encrypted Team MCP proxy. */
  teamRun?: boolean; teamMcp?: import('@mingle/contracts').TeamMcpConnection;
  /** Group-level permission applied only to this provider invocation; the saved session is unchanged. */
  runPolicy?: Session['policy'];
  /** Runtime-validated isolated worktree to use for this invocation without changing saved session metadata. */
  worktree?: { path: string; branch: string };
  /** Bounded observers used by device-side team orchestration. */
  onActivity?: (event: AdapterEvent) => void;
  onApproval?: (approval: Approval) => void;
  onApprovalDecision?: (approval: Approval, decision: 'approved' | 'denied') => void;
}

const MAX_TOOL_CHARS = 20_000;
const MAX_APPROVAL_INPUT_CHARS = 20_000;

const FAILURE_SCALAR_FIELDS = new Set([
  'message', 'code', 'providerCode', 'provider_code', 'errorCode', 'error_code', 'type', 'subtype',
  'status', 'statusCode', 'status_code', 'httpStatus', 'httpStatusCode', 'retryAt', 'retry_at',
  'retryAfterMs', 'retry_after_ms', 'retryAfter', 'retry_after', 'outcomeKnown', 'continuationSafety',
]);
const FAILURE_NESTED_FIELDS = new Set(['cause', 'data', 'error', 'response', 'body', 'codexErrorInfo', 'details', 'errors']);

function sanitizeProviderFailureInput(error: unknown, scrub: (value: string) => string, depth = 0, codexInfo = false): unknown {
  if (typeof error === 'string') return scrub(error).slice(0, 1000);
  if (typeof error === 'number' || typeof error === 'boolean' || error === null) return error;
  if (Array.isArray(error)) return error.slice(0, 8).map((entry) => sanitizeProviderFailureInput(entry, scrub, depth + 1));
  if (typeof error !== 'object' || depth > 4) return undefined;
  const source = error as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  if (error instanceof Error) {
    clean.message = scrub(error.message).slice(0, 1000);
    if (error.cause !== undefined) clean.cause = sanitizeProviderFailureInput(error.cause, scrub, depth + 1);
  }
  for (const [key, value] of Object.entries(source).slice(0, 32)) {
    if (FAILURE_SCALAR_FIELDS.has(key)) {
      if (typeof value === 'string') clean[key] = scrub(value).slice(0, 1000);
      else if (typeof value === 'number' || typeof value === 'boolean' || value === null) clean[key] = value;
    } else if (FAILURE_NESTED_FIELDS.has(key)) {
      clean[key] = sanitizeProviderFailureInput(value, scrub, depth + 1, key === 'codexErrorInfo');
    } else if (codexInfo && key.length <= 100 && /^(?:[A-Za-z][A-Za-z0-9_-]*)$/.test(key)) {
      if (typeof value === 'number' || typeof value === 'boolean' || value === null) clean[key] = value;
    }
  }
  return clean;
}

export class SessionRuntime {
  private readonly active = new Map<string, ActiveRun>();
  private readonly compactions = new Map<string, ActiveCompaction>();
  private readonly stopping = new Set<string>();
  private readonly questionTimers = new Map<string, NodeJS.Timeout>();
  private groups?: GroupService;
  private teamMcp?: TeamMcpBridge;
  private progressMcp?: ProgressMcpBridge;
  private teamProxy?: TeamProxyRuntimeService;
  private attachmentService?: AttachmentService;
  private readonly abortGraceMs: number;
  private readonly flushIntervalMs: number;
  private readonly userInputTimeoutMs: number;

  constructor(
    private readonly store: Store, private readonly hub: Hub, private readonly providers: ProviderRuntime, private readonly tasks: TaskService,
    private readonly log: Logger, options: RuntimeOptions = {}, private readonly validateSession?: (session: Session) => void, private readonly browserMcp?: BrowserMcpBridge, private readonly intelligence?: ProjectIntelligenceService,
    private readonly recovery?: RecoveryService,
  ) {
    // Covers the supported adapters' interrupt grace and escalating process shutdown.
    this.abortGraceMs = options.abortGraceMs ?? 30_000;
    this.flushIntervalMs = options.flushIntervalMs ?? 300;
    this.userInputTimeoutMs = options.userInputTimeoutMs ?? 5 * 60_000;
  }

  setGroupServices(groups: GroupService, teamMcp: TeamMcpBridge): void {
    this.groups = groups;
    this.teamMcp = teamMcp;
  }
  setProgressMcp(progressMcp: ProgressMcpBridge): void { this.progressMcp = progressMcp; }
  setTeamProxyService(service: TeamProxyRuntimeService): void { this.teamProxy = service; }

  async authorizeApprovalDecision(approvalId: string): Promise<void> {
    await this.teamProxy?.authorizeApprovalDecision(approvalId);
  }
  setAttachments(service: AttachmentService): void { this.attachmentService = service; }

  activeCount(): number {
    return this.active.size + this.compactions.size + (this.teamProxy?.activeCount() ?? 0);
  }
  isActive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.compactions.has(sessionId) || Boolean(this.teamProxy?.isActive(sessionId));
  }
  /** A cleanup lock can outlive provider execution; it must not keep tool authority alive. */
  isRunLive(sessionId: string, runId: string): boolean {
    const run = this.active.get(sessionId);
    if (run) return run.id === runId && run.acceptingTools && !run.closed && !run.controller.signal.aborted;
    return Boolean(this.teamProxy?.isRunLive(sessionId, runId));
  }

  /**
   * Starts an asynchronous provider run. All validation and bookkeeping is synchronous and the session is registered as
   * active before any await, so two concurrent requests can never both start a provider Promise for one session.
   */
  start(sessionId: string, content: string, options: StartOptions = {}): string {
    const session = this.store.getSession(sessionId);
    if (!session) throw notFound('Session not found');
    if (this.stopping.has(sessionId)) throw conflict('This session is being removed from Mingle.');
    if (options.intent === 'plan' && (options.invocation || options.skills?.length || options.resolveSkills)) throw badRequest('Native plan generation cannot run provider commands or skills. Send a regular planning prompt instead.');
    const executionPlan = options.executionPlanId ? this.store.getSessionPlan(options.executionPlanId) : undefined;
    if (options.executionPlanId && (!executionPlan || executionPlan.sessionId !== sessionId
      || !((executionPlan.status === 'approved' && executionPlan.approvedRevision === executionPlan.revision)
        || (executionPlan.status === 'executing' && executionPlan.executionRunId === null)))) {
      throw conflict('This approved plan is no longer ready to execute. Review it again before starting work.');
    }
    if (this.groups?.forSession(sessionId) && !options.groupDeliveryId && !options.teamRun) throw conflict('Start grouped work through its recorded group delivery.');
    if (this.isActive(sessionId) || session.status === 'running' || session.status === 'waiting') throw conflict('Session already has active work or provider cleanup is still in progress');
    const runSession: Session = {
      ...session,
      ...(options.worktree ? { isolated: true, worktreePath: options.worktree.path, branch: options.worktree.branch } : {}),
      ...(options.runPolicy ? { policy: options.runPolicy } : {}),
    };
    if (!existsSync(runSession.worktreePath) || !statSync(runSession.worktreePath).isDirectory()) throw conflict('The session worktree no longer exists on disk');
    const proxy = Boolean(this.teamProxy?.isProxySession(sessionId));
    if (proxy && options.intent === 'plan') throw badRequest('Remote team agents cannot generate a native read-only plan until the owner runtime advertises that capability.');
    if (proxy && (options.invocation || options.skills?.length || options.attachmentIds?.length)) {
      throw badRequest('Remote team deliveries do not currently carry native commands, skills or host-local attachment IDs.');
    }
    if (!proxy) this.validateSession?.(runSession);

    const pendingProviderHandoff = session.handoffFromProvider && session.handoffFromModel && session.handoffPendingAt
      ? {
        fromProvider: session.handoffFromProvider, fromModel: session.handoffFromModel, pendingAt: session.handoffPendingAt,
        messages: this.store.listMessages(sessionId), latestPlan: this.store.listSessionPlans(sessionId).at(-1),
        openTasks: this.store.listTasks(session.projectId).filter((task) => task.sessionId === sessionId && task.status !== 'done'),
      }
      : undefined;

    const handoffs = this.store.unconsumedHandoffs(sessionId);
    const runId = newId('run');
    if (proxy) {
      const prompt = this.composePrompt(handoffs, content);
      const groupContext = this.groups?.contextForRun(sessionId, runId);
      const proxyContent = [groupContext?.instructions, options.context, prompt].filter(Boolean).join('\n\n');
      this.store.tx(() => {
        const userMessage = this.store.insertMessage({ sessionId, role: 'user', content: options.userMessage?.content ?? content, kind: options.userMessage?.kind ?? null, runId, contextRefs: options.contextRefs });
        if (options.attachmentIds?.length) throw conflict('Proxy sessions do not accept host-local attachment IDs.');
        this.store.insertRun({ id: runId, sessionId, userMessageId: userMessage.id, provider: session.provider, model: session.model, startedAt: nowIso() });
        this.store.updateSession(sessionId, { status: 'running', error: null });
        if (options.taskId) {
          const task = this.store.getTask(options.taskId);
          if (task) this.tasks.markRunning(task);
        }
        this.store.recordEvent({ projectId: session.projectId, sessionId, type: 'session.run.started', summary: `Remote team delivery started: ${session.name}`, payload: { runId, provider: session.provider, model: session.model, taskId: options.taskId ?? null, proxy: true } });
      });
      try {
        this.teamProxy!.start({ session, runId, content: proxyContent, options, context: groupContext, consumedHandoffs: handoffs.map((handoff) => handoff.id) });
      } catch (error) {
        this.store.finishRun(runId, 'failed', 0);
        this.store.updateSession(sessionId, { status: 'error', error: error instanceof Error ? error.message.slice(0, 1000) : 'Remote team delivery could not start.' });
        throw error;
      }
      return runId;
    }
    const invocation = options.invocation;
    const prompt = invocation ? content : this.composePrompt(handoffs, content);
    const run: ActiveRun = {
      id: runId, startedAt: nowIso(), provider: session.provider, tick: performance.now(), tools: new Map(), activityTimer: null,
      sessionId, controller: new AbortController(), closed: false, cleanupPending: false, acceptingTools: false, approvals: new Map(), questions: new Map(), stream: null, flushTimer: null, consumedHandoffs: handoffs.map((h) => h.id), firstEvent: false, capabilityTokens: [],
      baseInput: session.inputTokens, baseOutput: session.outputTokens, baseCost: session.costUsd, taskId: options.taskId ?? null, skills: options.skills ?? [], invocation, intent: options.intent ?? 'normal', executionPlanId: options.executionPlanId,
      contextRefs: options.contextRefs, deferContextResolution: options.deferContextResolution, resolveSkills: options.resolveSkills,
      context: [options.context, invocation && handoffs.length ? this.composePrompt(handoffs, '') : undefined].filter(Boolean).join('\n\n') || undefined,
      providerHandoff: pendingProviderHandoff,
      attachmentOwnerKind: options.attachmentOwnerKind ?? 'message', attachmentOwnerId: options.attachmentOwnerId, changeBaseline: null, dispatchState: 'unknown',
      teamRun: options.teamRun === true, teamMcpConnection: options.teamMcp, onActivity: options.onActivity,
      onApproval: options.onApproval, onApprovalDecision: options.onApprovalDecision,
      promise: Promise.resolve(),
    };
    this.store.tx(() => {
      const userMessage = this.store.insertMessage({ sessionId, role: 'user', content: options.userMessage?.content ?? content, kind: options.userMessage?.kind ?? null, runId: run.id, contextRefs: options.contextRefs });
      run.attachmentOwnerId ??= userMessage.id;
      if (options.attachmentIds?.length) {
        if (!this.attachmentService) throw conflict('Attachments are unavailable in this Mingle session.');
        this.attachmentService.claim({ kind: 'session', id: sessionId }, options.attachmentIds, 'message', userMessage.id);
      }
      this.store.insertRun({ id: run.id, sessionId, userMessageId: userMessage.id, provider: session.provider, model: session.model, startedAt: run.startedAt });
      if (options.executionPlanId) {
        const current = this.store.getSessionPlan(options.executionPlanId);
        if (!current || current.sessionId !== sessionId
          || !((current.status === 'approved' && current.approvedRevision === current.revision)
            || (current.status === 'executing' && current.executionRunId === null))) {
          throw conflict('This approved plan changed before execution could start. Review it again before starting work.');
        }
        const executing = { ...current, status: 'executing' as const, executionRunId: run.id, updatedAt: nowIso() };
        this.store.updateSessionPlan(executing);
        this.store.recordEvent({ projectId: session.projectId, sessionId, type: 'session.plan.execution.started', summary: `Plan execution started (revision ${current.revision})`, payload: { planId: current.id, revision: current.revision, runId: run.id } });
      }
      this.store.updateSession(sessionId, { status: 'running', error: null });
      if (options.taskId) {
        const task = this.store.getTask(options.taskId);
        if (task) this.tasks.markRunning(task);
      }
      this.intelligence?.trackRequest(session, run.id, options.userMessage?.content ?? content, options.taskId);
      this.store.recordEvent({ projectId: session.projectId, sessionId, type: 'session.run.started', summary: `Run started: ${session.name}`, payload: { runId: run.id, provider: session.provider, model: session.model, taskId: options.taskId ?? null, handoffsIncluded: handoffs.length } });
    });
    this.active.set(sessionId, run);
    run.promise = this.execute(run, runSession, prompt);
    return run.id;
  }

  approvePlan(planId: string, revision: number): SessionPlan {
    const plan = this.store.getSessionPlan(planId);
    if (!plan) throw notFound('Plan not found');
    if (plan.status !== 'review' || plan.revision !== revision) throw conflict('This plan changed or is no longer awaiting review. Refresh before approving it.');
    const generation = this.store.getRun(plan.runId);
    if (!generation || generation.status !== 'completed') throw conflict('Wait for plan generation to finish before approving it.');
    const approved: SessionPlan = { ...plan, status: 'approved', approvedRevision: revision, updatedAt: nowIso() };
    this.store.tx(() => {
      this.store.updateSessionPlan(approved);
      const session = this.store.getSession(plan.sessionId, true);
      this.store.recordEvent({ projectId: session?.projectId ?? null, sessionId: plan.sessionId, type: 'session.plan.approved', summary: `Plan approved (revision ${revision})`, payload: { planId, revision } });
    });
    return approved;
  }

  editPlan(planId: string, rawInput: unknown): SessionPlan {
    const parsed = EditSessionPlanSchema.safeParse(rawInput);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Plan structure is invalid.');
    const input: EditSessionPlan = parsed.data;
    const plan = this.store.getSessionPlan(planId);
    if (!plan) throw notFound('Plan not found');
    if (input.expectedRevision !== plan.revision) throw conflict('This plan changed while you were editing it. Load the latest revision before saving.');
    if (plan.status === 'executing') throw conflict('An executing plan cannot be edited. Interrupt its run first.');
    const sourceRun = this.store.getRun(plan.runId);
    if (!sourceRun || sourceRun.status !== 'completed') throw conflict('Wait for plan generation to finish before editing it.');
    const prior = new Map(plan.steps.map((step) => [step.id, step]));
    const steps = input.steps.map((step) => ({ ...step, providerId: prior.get(step.id)?.providerId ?? null, status: 'pending' as const }));
    const updated: SessionPlan = {
      ...plan, explanation: input.explanation ?? plan.explanation, steps, revision: plan.revision + 1,
      approvedRevision: null, status: 'review', executionRunId: null, updatedAt: nowIso(),
    };
    this.store.tx(() => {
      this.store.updateSessionPlan(updated);
      const session = this.store.getSession(plan.sessionId, true);
      this.store.recordEvent({ projectId: session?.projectId ?? null, sessionId: plan.sessionId, type: 'session.plan.edited', summary: `Plan revised to ${updated.revision}`, payload: { planId, revision: updated.revision } });
    });
    return updated;
  }

  async executePlan(planId: string): Promise<{ accepted: true; runId: string | null; deliveryId?: string; plan: SessionPlan }> {
    const plan = this.store.getSessionPlan(planId);
    if (!plan) throw notFound('Plan not found');
    if (plan.status !== 'approved' || plan.approvedRevision !== plan.revision) throw conflict('Approve the current plan revision before executing it.');
    if (!plan.steps.length) throw conflict('Add at least one step before executing this plan.');
    const steps = SessionPlanStepsSchema.safeParse(plan.steps);
    if (!steps.success) throw conflict('This plan structure is invalid. Revise and approve it again before execution.');
    const generation = this.store.getRun(plan.runId);
    if (!generation || generation.status !== 'completed') throw conflict('Plan generation has not completed.');
    const session = this.store.getSession(plan.sessionId);
    if (!session) throw notFound('Session not found');
    const prompt = [
      'Execute this user-approved Mingle plan. Work only on its listed steps, respect the dependencies and acceptance criteria, and report any blocked work instead of inventing approval.',
      plan.explanation ? `Plan context:\n${plan.explanation}` : '',
      ...steps.data.map((step, index) => `${index + 1}. ${step.title}${step.description ? `\n   ${step.description}` : ''}${step.acceptanceCriteria.length ? `\n   Acceptance criteria: ${step.acceptanceCriteria.join('; ')}` : ''}${step.dependsOn.length ? `\n   Depends on: ${step.dependsOn.map((id) => steps.data.find((candidate) => candidate.id === id)?.title ?? id).join(', ')}` : ''}`),
    ].filter(Boolean).join('\n\n');
    if (this.groups?.forSession(session.id)) {
      const dispatch = await this.groups.executePlan(session.id, plan.id, prompt);
      const executing = this.store.getSessionPlan(plan.id);
      if (!executing) throw conflict('The group plan execution was queued, but its plan record is unavailable. Refresh the conversation.');
      return { accepted: true, runId: dispatch.runId, deliveryId: dispatch.deliveryId, plan: executing };
    }
    const sourceMessage = this.store.getMessage(generation.userMessageId);
    if (!sourceMessage || sourceMessage.sessionId !== session.id || sourceMessage.role !== 'user') throw conflict('The original plan inputs are no longer available. Replan from this session.');
    for (const ref of sourceMessage.contextRefs ?? []) {
      if (ref.sourceSessionId !== session.id || (ref.kind === 'quote' && ref.sourceGroupId)) throw conflict('The original plan context is no longer scoped to this session. Replan with current context.');
    }
    const context = await buildMessageContext(sourceMessage.contextRefs, session.worktreePath, (_sessionId, messageId) => this.store.getMessage(messageId));
    const runId = this.start(session.id, prompt, {
      executionPlanId: plan.id, userMessage: { content: prompt, kind: 'plan-execution' },
      attachmentOwnerKind: 'message', attachmentOwnerId: sourceMessage.id, contextRefs: sourceMessage.contextRefs, context,
    });
    const executing = this.store.getSessionPlan(plan.id);
    if (!executing) throw conflict('Plan execution started, but its plan record is unavailable. Refresh the conversation.');
    return { accepted: true, runId, plan: executing };
  }

  answerUserQuestion(questionId: string, rawAnswers: unknown): UserQuestion {
    const question = this.store.getUserQuestion(questionId);
    if (!question) throw notFound('Question not found');
    if (question.status !== 'pending') throw conflict(`Question is already ${question.status}.`);
    const run = this.active.get(question.sessionId);
    const resolve = run?.questions.get(question.id);
    if (!run || run.id !== question.runId || run.closed || !resolve || run.controller.signal.aborted) {
      this.cancelQuestion(run, question, 'The provider request is no longer active.');
      throw conflict('Question is stale: its provider request is no longer active.');
    }
    const parsed = UserInputAnswersSchema.safeParse(rawAnswers);
    if (!parsed.success) throw badRequest('Answers are invalid. Refresh the question and try again.');
    const expected = new Map(question.questions.map((field) => [field.id, field]));
    if (Object.keys(parsed.data).length !== expected.size || Object.keys(parsed.data).some((id) => !expected.has(id))) throw badRequest('Answer every field in the question exactly once.');
    for (const [id, field] of expected) {
      const values = parsed.data[id]!;
      if ((!field.multiSelect && values.length !== 1) || values.length > 20) throw badRequest(`Choose a valid number of answers for “${field.question.slice(0, 120)}”.`);
      const allowed = new Set(field.options.map((option) => option.label));
      if (!field.allowOther && values.some((value) => !allowed.has(value))) throw badRequest('Choose only options provided by the active question.');
    }
    const session = this.store.getSession(question.sessionId, true);
    const answered = this.store.tx(() => {
      const updated = this.store.resolveUserQuestion(question.id, 'answered', parsed.data);
      this.store.recordEvent({ projectId: session?.projectId ?? null, sessionId: question.sessionId, type: 'session.question.answered', summary: 'Provider question answered', payload: { questionId: question.id, runId: question.runId } });
      return updated;
    });
    this.finishQuestionWait(run, question.id, parsed.data);
    return answered;
  }

  cancelUserQuestion(questionId: string): UserQuestion {
    const question = this.store.getUserQuestion(questionId);
    if (!question) throw notFound('Question not found');
    if (question.status !== 'pending') throw conflict(`Question is already ${question.status}.`);
    const run = this.active.get(question.sessionId);
    this.cancelQuestion(run, question, 'The user cancelled the provider question.');
    if (run && !run.controller.signal.aborted) this.interrupt(question.sessionId);
    return this.store.getUserQuestion(questionId) ?? { ...question, status: 'cancelled', reason: 'The user cancelled the provider question.', resolvedAt: nowIso() };
  }

  private composePrompt(handoffs: Message[], content: string): string {
    if (!handoffs.length) return content;
    const blocks = handoffs.map((h) => h.content.trim());
    return ['[Mingle context — artifacts handed off to this session since your last turn]', ...blocks, '[End of handed-off context]', '', content].join('\n\n');
  }

  private async providerHandoffBlock(run: ActiveRun, session: Session): Promise<string | undefined> {
    const handoff = run.providerHandoff;
    if (!handoff) return undefined;
    let changedFiles: string[] = [];
    let diffStat = '';
    try {
      const [status, unstaged, staged] = await Promise.all([
        git(session.worktreePath, ['status', '--short', '--untracked-files=normal'], { timeoutMs: 5_000, maxBuffer: 64 * 1024 }),
        git(session.worktreePath, ['diff', '--stat', '--no-ext-diff'], { timeoutMs: 5_000, maxBuffer: 64 * 1024 }),
        git(session.worktreePath, ['diff', '--cached', '--stat', '--no-ext-diff'], { timeoutMs: 5_000, maxBuffer: 64 * 1024 }),
      ]);
      changedFiles = status.stdout.split(/\r?\n/).filter(Boolean).slice(0, 80).map((line) => {
        const state = line.slice(0, 2).trim() || '??';
        return `${state} ${line.slice(3).trim()}`;
      });
      diffStat = [unstaged.stdout.trim(), staged.stdout.trim()].filter(Boolean).join('\n').slice(0, 1_800);
    } catch {
      diffStat = 'Git status and diff statistics were unavailable.';
    }
    return buildProviderHandoff({
      fromProvider: handoff.fromProvider, fromModel: handoff.fromModel,
      toProvider: session.provider, toModel: session.model,
      latestPlan: handoff.latestPlan, openTasks: handoff.openTasks, changedFiles, diffStat,
      messages: handoff.messages,
    });
  }

  private consumeProviderHandoff(run: ActiveRun, block: string): void {
    const handoff = run.providerHandoff;
    if (!handoff) return;
    this.store.tx(() => {
      const session = this.store.getSession(run.sessionId, true);
      if (!session || session.handoffPendingAt !== handoff.pendingAt) return;
      this.store.updateSession(run.sessionId, { handoffFromProvider: null, handoffFromModel: null, handoffPendingAt: null });
      this.store.recordEvent({
        projectId: session.projectId, sessionId: session.id, type: 'session.provider.handoff',
        summary: `Conversation context handed off to ${session.provider}`,
        payload: {
          fromProvider: handoff.fromProvider, toProvider: session.provider,
          fromModel: handoff.fromModel, toModel: session.model, bytes: Buffer.byteLength(block),
        },
      });
    });
  }

  private async execute(run: ActiveRun, startSession: Session, prompt: string): Promise<void> {
    let outcome: 'completed' | 'failed' | 'interrupted' = 'completed';
    let failure: string | null = null;
    const capabilityTokens = run.capabilityTokens;
    const scrubCapabilities = (value: string): string => capabilityTokens.reduce((text, token) => text.split(token).join('[redacted]'), value);
    try {
      await this.captureCheckpoint(run.sessionId, 'Run started', run.id);
      run.changeBaseline = await captureRunTree(startSession.worktreePath);
      if (run.controller.signal.aborted) {
        await this.finish(run, 'interrupted', null, unavailableRunChanges('The run was interrupted before work started.'));
        return;
      }
      if (run.deferContextResolution && run.contextRefs?.length) {
        const context = await buildMessageContext(run.contextRefs, startSession.worktreePath, (_sessionId, messageId) => this.store.getMessage(messageId));
        run.context = [run.context, context].filter(Boolean).join('\n\n') || undefined;
      }
      if (run.resolveSkills) run.skills = await run.resolveSkills();
      const adapter = this.providers.createAdapter(startSession.provider);
      const savedSession = this.store.getSession(run.sessionId) ?? startSession;
      const session: Session = {
        ...savedSession, worktreePath: startSession.worktreePath, branch: startSession.branch,
        isolated: startSession.isolated, policy: startSession.policy,
      };
      const settings = this.store.getSettings();
      // A queue pause can arrive while the initial Git snapshot is being captured. Do not start inference after that pause.
      if (this.groups?.forSession(session.id)?.group.paused) {
        run.controller.abort();
        await this.finish(run, 'interrupted', null, unavailableRunChanges('Group scheduling was paused before the provider started.'));
        return;
      }
      run.acceptingTools = true;
      // Browser actions and team tools can have external side effects and are deliberately absent from read-only planning.
      const browserMcp = run.intent !== 'plan' && settings.browserAgentEnabled !== false ? this.browserMcp?.create(run.id, session, run.controller.signal, (request) => this.requestApproval(run, request)) : undefined;
      if (browserMcp) capabilityTokens.push(browserMcp.token);
      const groupContext = run.teamRun ? undefined : this.groups?.contextForRun(session.id, run.id);
      if (!run.teamRun && this.groups?.forSession(session.id) && !groupContext) throw conflict('Group runs must start through a recorded group delivery. Refresh and send through the group conversation.');
      const teamMcp = run.intent !== 'plan' && run.teamRun
        ? run.teamMcpConnection
        : run.intent !== 'plan' && groupContext ? this.teamMcp?.create(run.id, session, run.controller.signal, groupContext) : undefined;
      if (teamMcp) capabilityTokens.push(teamMcp.token);
      const progressMcp = run.intent !== 'plan' ? this.progressMcp?.create({
        runId: run.id, session, signal: run.controller.signal,
        isLive: () => this.isRunLive(run.sessionId, run.id),
        setStatus: (status) => this.setProgressStatus(run, status),
        updatePlan: (plan) => this.updateProgressPlan(run, plan),
      }) : undefined;
      if (progressMcp) capabilityTokens.push(progressMcp.token);
      const explicit = run.invocation;
      const providerHandoffBlock = await this.providerHandoffBlock(run, session);
      const progressInstructions = progressMcp
        ? 'Mingle provides mingle_status_set for the live composer status and mingle_plan_update for a replaceable checklist. Keep them current during multi-step work, updating status as you make progress.'
        : undefined;
      const effectivePrompt = explicit ? prompt : [providerHandoffBlock, run.intent !== 'plan' ? groupContext?.instructions : undefined, run.context, prompt].filter(Boolean).join('\n\n');
      if (explicit && (providerHandoffBlock || progressInstructions)) run.context = [providerHandoffBlock, progressInstructions, run.context].filter(Boolean).join('\n\n');
      if (explicit && groupContext) run.context = [run.context, groupContext.instructions].filter(Boolean).join('\n\n');
      const stagedAttachments = this.attachmentService && run.attachmentOwnerId
        ? await this.attachmentService.stage(run.id, run.attachmentOwnerKind ?? 'message', run.attachmentOwnerId)
        : [];
      if (run.controller.signal.aborted) throw conflict('The run was interrupted before the provider started.');
      const injectedContext = [explicit ? run.context : undefined, progressInstructions].filter(Boolean).join('\n\n');
      const runOptions: RunOptions & DispatchAwareOptions = {
        session, prompt: effectivePrompt, intent: run.intent, ...(explicit ? { invocation: explicit } : {}), ...(injectedContext ? { context: injectedContext } : {}), attachments: stagedAttachments, teamMcp, progressMcp, providerTaskState: this.nativeTaskState(session), skills: run.skills, browserMcp, signal: run.controller.signal, settings,
        onEvent: (event) => this.handleEvent(run, capabilityTokens.length ? JSON.parse(scrubCapabilities(JSON.stringify(event))) as AdapterEvent : event),
        requestApproval: (request) => this.requestApproval(run, JSON.parse(scrubCapabilities(JSON.stringify(request)))),
        requestUserInput: (request) => this.requestUserInput(run, request),
        onDispatchState: (state) => { run.dispatchState = state; },
      };
      const adapterRun = Promise.resolve().then(() => {
        const running = adapter.run(runOptions);
        if (providerHandoffBlock) this.consumeProviderHandoff(run, providerHandoffBlock);
        return running;
      });
      const grace = new Promise<'grace'>((resolve) => {
        const onAbort = () => setTimeout(() => resolve('grace'), this.abortGraceMs).unref();
        if (run.controller.signal.aborted) onAbort();
        else run.controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      adapterRun.catch(() => undefined); // an orphaned adapter promise must never become an unhandled rejection
      const result = await Promise.race([adapterRun.then(() => 'done' as const), grace]);
      if (result === 'grace') {
        this.log('warn', `Adapter for session ${run.sessionId} ignored abort; keeping its session locked until cleanup finishes`);
        run.cleanupPending = true;
        // Finishing the visible turn must never grant a second writer access to the same worktree.
        void adapterRun.then(() => this.releaseAfterCleanup(run), () => this.releaseAfterCleanup(run));
      }
      outcome = run.controller.signal.aborted ? 'interrupted' : 'completed';
    } catch (error) {
      if (run.controller.signal.aborted) outcome = 'interrupted';
      else {
        outcome = 'failed';
        run.failureCause = error;
        const detail = redactSecrets(errorMessage(error));
        failure = truncate(scrubCapabilities(detail), 4000);
      }
    }
    run.acceptingTools = false;
    if (!run.cleanupPending) await this.attachmentService?.release(run.id);
    this.browserMcp?.revoke(run.id);
    this.teamMcp?.revoke(run.id);
    this.progressMcp?.revoke(run.id);
    let changes: RunChanges;
    try {
      changes = run.cleanupPending
        ? unavailableRunChanges('The provider was still stopping, so a final change snapshot could not be captured.')
        : run.changeBaseline?.status !== 'available'
          ? unavailableRunChanges('A starting workspace snapshot was unavailable. Changes for this run cannot be determined.')
          : await compareRunTrees(startSession.worktreePath, run.changeBaseline, await captureRunTree(startSession.worktreePath));
      if (!startSession.isolated && changes.summary.status === 'available') {
        changes.summary.notices.push('This session uses a shared project folder. Changes made by other writers during the run may be included.');
      }
    } catch {
      changes = unavailableRunChanges('Workspace changes could not be captured for this run.');
    }
    await this.finish(run, outcome, failure, changes);
  }

  private async captureCheckpoint(sessionId: string, reason: string, runId?: string): Promise<string | null> {
    if (!this.recovery) return null;
    try {
      return (await this.recovery.capture(sessionId, reason, runId)).id;
    } catch (error) {
      const detail = redactSecrets(errorMessage(error)).slice(0, 500);
      this.log('warn', `Recovery checkpoint capture failed for ${sessionId}: ${detail}`);
      return null;
    }
  }

  private failureActor(sessionId: string, runId: string): ProviderFailure['actor'] {
    const group = this.groups?.forSession(sessionId);
    if (!group) return 'session';
    const member = group.members.find((candidate) => candidate.sessionId === sessionId && !candidate.removedAt);
    const delivery = group.deliveries.find((candidate) => candidate.runId === runId);
    const request = delivery && group.requests.find((candidate) => candidate.id === delivery.requestId);
    if (member && request?.plannerMemberId === member.id) return 'lead';
    return member && (member.id === group.group.orchestratorMemberId || member.role === 'orchestrator') ? 'lead' : 'worker';
  }

  private makeProviderFailure(run: ActiveRun, failure: string, scrubCapabilities: (value: string) => string): ProviderFailure {
    const scrub = (value: string) => redactSecrets(scrubCapabilities(value)).slice(0, 1000);
    const safeError = sanitizeProviderFailureInput(run.failureCause, scrub);
    const cleanText = sanitizeProviderFailureInput(failure, scrub);
    // The provider module owns classification and retry-safety semantics. Runtime supplies only
    // the dispatch boundary and public identity after removing any run-scoped capability literals.
    const providerError = safeError && typeof safeError === 'object'
      ? { ...(safeError as Record<string, unknown>), message: typeof cleanText === 'string' ? cleanText : 'Provider operation failed.' }
      : cleanText;
    return providerFailure(providerError, {
      provider: run.provider, sessionId: run.sessionId, runId: run.id,
      actor: this.failureActor(run.sessionId, run.id), dispatchState: run.dispatchState,
    });
  }

  /** Rehydrate only genuine root Claude task IDs; this metadata is never replayed as prompt text. */
  private nativeTaskState(session: Session): ProviderTaskPlan['steps'] | undefined {
    if (session.provider !== 'claude') return undefined;
    const tasks = this.store.listTasks(session.projectId).filter(task => task.sessionId === session.id && task.source?.kind === 'provider' && task.source.providerId && task.source.key === `provider:${session.id}:claude-tasks:root:${task.source.providerId}` && !task.source.missing).slice(-100);
    const byId = new Map(tasks.map(task => [task.id, task.source!.providerId!]));
    return tasks.map(task => ({ id: task.source!.providerId!, title: task.title.slice(0, 200), description: task.description.slice(0, 4000), status: task.source!.reportedStatus ?? 'pending', dependsOn: task.dependsOn.map(id => byId.get(id)).filter((id): id is string => Boolean(id)) }));
  }

  private progressText(run: ActiveRun, value: string, max: number): string {
    const scrubbed = run.capabilityTokens.reduce((text, token) => text.split(token).join('[redacted]'), value);
    return truncate(redactSecrets(scrubbed).replaceAll('\0', ''), max);
  }

  private setProgressStatus(run: ActiveRun, status: MingleStatusSet): void {
    if (!this.isRunLive(run.sessionId, run.id)) throw conflict('This progress tool connection has expired');
    const session = this.store.getSession(run.sessionId);
    if (!session) throw notFound('Session not found');
    const safeStatus = {
      step: this.progressText(run, status.step, 120),
      ...(status.detail !== undefined ? { detail: this.progressText(run, status.detail, 300) } : {}),
      ...(status.progress ? { progress: status.progress } : {}),
    };
    this.store.recordEvent({ projectId: session.projectId, sessionId: session.id, type: 'session.progress.status', summary: 'Run progress updated', payload: { runId: run.id, status: safeStatus } });
  }

  private updateProgressPlan(run: ActiveRun, plan: MinglePlanUpdate): void {
    if (!this.isRunLive(run.sessionId, run.id)) throw conflict('This progress tool connection has expired');
    const session = this.store.getSession(run.sessionId);
    if (!session) throw notFound('Session not found');
    const steps = plan.steps.map((step, index) => ({
      id: `step-${index + 1}`, title: this.progressText(run, step.title, 160), status: step.status,
    }));
    const planId = `mingle-status:${session.id}`;
    const providerPlan: ProviderTaskPlan = {
      planId, replace: true,
      steps: steps.map((step) => ({ ...step, status: step.status === 'done' ? 'completed' : step.status })),
    };
    this.intelligence?.applyPlan(session, run.id, providerPlan);
    this.store.recordEvent({ projectId: session.projectId, sessionId: session.id, type: 'session.progress.plan', summary: 'Run progress checklist replaced', payload: { runId: run.id, planId, steps } });
  }

  private async releaseAfterCleanup(run: ActiveRun): Promise<void> {
    if (run.attachmentOwnerId) {
      try { await this.attachmentService?.release(run.id); }
      catch (error) { this.log('warn', `Attachment cleanup failed for ${run.id}: ${redactSecrets(errorMessage(error)).slice(0, 500)}`); }
    }
    await this.captureCheckpoint(run.sessionId, 'Provider cleanup released', run.id);
    run.cleanupPending = false;
    if (run.closed && this.active.get(run.sessionId) === run) {
      this.active.delete(run.sessionId);
      run.capabilityTokens.length = 0;
      try { this.groups?.onRuntimeIdle(run.sessionId); }
      catch (error) { this.log('error', `Failed to resume group queue after provider cleanup for ${run.sessionId}`, error); }
    }
  }

  private consumeHandoffsOnce(run: ActiveRun): void {
    if (run.firstEvent) return;
    run.firstEvent = true;
    if (run.consumedHandoffs.length) this.store.markConsumed(run.consumedHandoffs);
  }

  private handleEvent(run: ActiveRun, event: AdapterEvent): void {
    if (run.closed) return;
    try { run.onActivity?.(event); } catch { /* Monitoring must not interfere with provider execution. */ }
    try {
      switch (event.type) {
        case 'session.plan': {
          if (run.intent !== 'plan') break;
          const { type: _type, ...raw } = event;
          const parsed = SessionPlanProposalSchema.safeParse(JSON.parse(redactSecrets(JSON.stringify(raw))));
          if (!parsed.success) break;
          this.persistSessionPlan(run, parsed.data);
          break;
        }
        case 'task.plan': {
          const { type: _type, ...raw } = event;
          const plan = ProviderTaskPlanSchema.safeParse(JSON.parse(redactSecrets(JSON.stringify(raw))));
          const session = this.store.getSession(run.sessionId);
          if (session && plan.success) this.intelligence?.applyPlan(session, run.id, plan.data);
          break;
        }
        case 'session':
          if (event.providerSessionId) {
            this.store.updateSession(run.sessionId, { providerSessionId: event.providerSessionId });
            void this.captureCheckpoint(run.sessionId, 'Provider conversation identity recorded', run.id);
          }
          break;
        case 'text':
          if (!event.text) return;
          this.appendText(run, event.text);
          break;
        case 'tool.activity':
          this.recordTool(run, event.activity);
          break;
        case 'subagent.text':
          this.recordSubagentText(run, event.parentId, event.messageId, event.text);
          break;
        case 'tool.output':
          this.appendToolOutput(run, event.id, event.delta);
          break;
        case 'tool': {
          this.closeStream(run, null);
          this.store.insertMessage({ sessionId: run.sessionId, runId: run.id, role: 'tool', kind: 'tool', content: truncate(redactSecrets(`${event.name}${event.content ? `\n${event.content}` : ''}`), MAX_TOOL_CHARS) });
          this.store.touch();
          break;
        }
        case 'usage': {
          // Usage events are treated as run-cumulative snapshots on top of the totals at run start.
          const input = Math.max(0, Math.floor(event.inputTokens || 0));
          const output = Math.max(0, Math.floor(event.outputTokens || 0));
          const cost = event.costUsd === null || event.costUsd === undefined ? run.baseCost : (run.baseCost ?? 0) + event.costUsd;
          this.store.updateSession(run.sessionId, { inputTokens: run.baseInput + input, outputTokens: run.baseOutput + output, costUsd: cost });
          this.store.touch();
          break;
        }
        case 'info':
          this.closeStream(run, null);
          this.store.insertMessage({ sessionId: run.sessionId, runId: run.id, role: 'system', kind: 'info', content: truncate(redactSecrets(event.content), MAX_TOOL_CHARS) });
          this.store.touch();
          break;
      }
    } catch (error) {
      this.log('error', `Failed to record adapter event for ${run.sessionId}`, error);
    }
  }

  private persistSessionPlan(run: ActiveRun, proposal: import('@mingle/contracts').SessionPlanProposal): void {
    const existing = this.store.getRunPlan(run.id, proposal.providerPlanId);
    const steps = proposal.steps.map((step) => ({ ...step, providerId: step.providerId ?? step.id }));
    const same = existing && existing.explanation === proposal.explanation && JSON.stringify(existing.steps) === JSON.stringify(steps);
    if (same) return;
    const at = nowIso();
    const plan: SessionPlan = existing
      ? { ...existing, explanation: proposal.explanation, steps, revision: existing.revision + 1, approvedRevision: null, status: 'review', executionRunId: null, updatedAt: at }
      : { id: newId('plan'), sessionId: run.sessionId, runId: run.id, provider: run.provider, providerPlanId: proposal.providerPlanId,
        explanation: proposal.explanation, steps, revision: 1, approvedRevision: null, status: 'review', executionRunId: null, createdAt: at, updatedAt: at };
    const session = this.store.getSession(run.sessionId, true);
    this.store.tx(() => {
      this.store.saveSessionPlan(plan);
      this.store.recordEvent({ projectId: session?.projectId ?? null, sessionId: run.sessionId, type: 'session.plan.updated', summary: `Plan ready for review (revision ${plan.revision})`, payload: { planId: plan.id, revision: plan.revision, runId: run.id } });
    });
  }

  private requestUserInput(run: ActiveRun, raw: unknown): Promise<UserInputAnswers | null> {
    if (run.closed || run.controller.signal.aborted || !this.isRunLive(run.sessionId, run.id)) return Promise.resolve(null);
    const parsed = NativeUserInputRequestSchema.safeParse(raw);
    if (!parsed.success) {
      this.log('warn', `Provider ${run.provider} sent an invalid native user-input request for ${run.id}.`);
      return Promise.resolve(null);
    }
    const native = parsed.data;
    if (run.questions.size) return Promise.resolve(null);
    const at = nowIso();
    const question: UserQuestion = {
      id: newId('question'), sessionId: run.sessionId, runId: run.id, provider: run.provider, tool: truncate(redactSecrets(native.tool), 200),
      questions: native.questions.map((field) => ({ ...field, question: truncate(redactSecrets(field.question), 2000), options: field.options.map((option) => ({ ...option, label: truncate(redactSecrets(option.label), 200), ...(option.description ? { description: truncate(redactSecrets(option.description), 500) } : {}) })) })),
      status: 'pending', createdAt: at, resolvedAt: null,
    };
    this.closeStream(run, null);
    const session = this.store.getSession(run.sessionId, true);
    let saved: UserQuestion | undefined;
    this.store.tx(() => {
      const inserted = this.store.insertUserQuestion({ question, nativeRequestId: native.nativeRequestId });
      saved = inserted;
      if (inserted.id !== question.id) return;
      this.store.updateSession(run.sessionId, { status: 'waiting' });
      this.store.recordEvent({ projectId: session?.projectId ?? null, sessionId: run.sessionId, type: 'session.question.asked', summary: `Provider asked ${inserted.questions.length} question${inserted.questions.length === 1 ? '' : 's'}`, payload: { questionId: inserted.id, runId: run.id, provider: run.provider } });
    });
    const savedQuestion = saved;
    if (!savedQuestion || savedQuestion.id !== question.id) return Promise.resolve(null);
    return new Promise<UserInputAnswers | null>((resolve) => {
      run.questions.set(savedQuestion.id, resolve);
      const timer = setTimeout(() => {
        this.cancelQuestion(run, savedQuestion, 'The provider question timed out.');
        this.interrupt(run.sessionId);
      }, this.userInputTimeoutMs);
      timer.unref();
      this.questionTimers.set(savedQuestion.id, timer);
    });
  }

  private finishQuestionWait(run: ActiveRun, questionId: string, answers: UserInputAnswers | null): void {
    const timer = this.questionTimers.get(questionId);
    if (timer) clearTimeout(timer);
    this.questionTimers.delete(questionId);
    const resolve = run.questions.get(questionId);
    run.questions.delete(questionId);
    resolve?.(answers);
    if (!run.closed && !run.controller.signal.aborted && !run.approvals.size && !run.questions.size) this.store.updateSession(run.sessionId, { status: 'running' });
  }

  private cancelQuestion(run: ActiveRun | undefined, question: UserQuestion, reason: string): UserQuestion {
    let updated = question;
    if (question.status === 'pending') {
      const session = this.store.getSession(question.sessionId, true);
      this.store.tx(() => {
        updated = this.store.resolveUserQuestion(question.id, 'cancelled', undefined, redactSecrets(reason).slice(0, 500));
        this.store.recordEvent({ projectId: session?.projectId ?? null, sessionId: question.sessionId, type: 'session.question.cancelled', summary: 'Provider question cancelled', payload: { questionId: question.id, runId: question.runId } });
      });
    }
    if (run) this.finishQuestionWait(run, question.id, null);
    return updated;
  }

  private cancelRunQuestions(run: ActiveRun, reason: string): void {
    for (const id of [...run.questions.keys()]) {
      const question = this.store.getUserQuestion(id);
      if (question) this.cancelQuestion(run, question, reason);
      else this.finishQuestionWait(run, id, null);
    }
  }

  private recordTool(run: ActiveRun, activity: ToolActivity): void {
    const providerId = activity.id.slice(0, 200);
    if (!providerId) return;
    let buffer = run.tools.get(providerId);
    const at = nowIso();
    if (!buffer) {
      this.closeStream(run, null);
      buffer = { output: '', dirty: false, tick: activity.status === 'running' ? performance.now() : null,
        call: { id: newId('tool'), runId: run.id, sessionId: run.sessionId, providerId, parentProviderId: null,
          name: activity.name, category: activity.category, status: activity.status, summary: '', command: null, input: '', output: '',
          cwd: null, exitCode: null, processId: null, startedAt: at, finishedAt: null, durationMs: null } };
      run.tools.set(providerId, buffer);
    }
    const call = buffer.call;
    const terminal = call.finishedAt !== null;
    call.name = truncate(redactSecrets(activity.name), 200);
    call.category = activity.category;
    if (!terminal || activity.status !== 'running') call.status = activity.status;
    if (activity.parentId !== undefined) call.parentProviderId = activity.parentId?.slice(0, 200) ?? null;
    if (activity.summary !== undefined) call.summary = truncate(redactSecrets(activity.summary), 1000);
    if (activity.command !== undefined) call.command = activity.command === null ? null : truncate(redactSecrets(activity.command), 4000);
    if (activity.input !== undefined) call.input = truncate(redactSecrets(activity.input), MAX_TOOL_CHARS);
    if (activity.cwd !== undefined) call.cwd = activity.cwd === null ? null : truncate(redactSecrets(activity.cwd), 4096);
    if (activity.processId !== undefined) call.processId = activity.processId === null ? null : truncate(String(activity.processId), 200);
    if (activity.exitCode !== undefined) call.exitCode = typeof activity.exitCode === 'number' && Number.isFinite(activity.exitCode) ? activity.exitCode : null;
    if (activity.output !== undefined) {
      buffer.call.outputTruncated = activity.output.length > MAX_TOOL_CHARS;
      buffer.output = activity.output.slice(-MAX_TOOL_CHARS);
    }
    if (call.status !== 'running' && !terminal) {
      call.finishedAt = at;
      call.durationMs = buffer.tick === null ? null : Math.max(0, Math.round(performance.now() - buffer.tick));
    }
    if (typeof activity.durationMs === 'number' && Number.isFinite(activity.durationMs) && activity.durationMs >= 0) call.durationMs = Math.round(activity.durationMs);
    this.persistTool(buffer);
    this.store.touch();
  }

  private recordSubagentText(run: ActiveRun, parentId: string, messageId: string, text: string): void {
    const buffer = run.tools.get(parentId.slice(0, 200));
    if (!buffer || !isSubagentLaunch(run.provider, buffer.call) || !text) return;
    const safeText = redactSecrets(text);
    if (!safeText) return;
    const safeMessageId = truncate(messageId, 200);
    const messages = buffer.call.subagentMessages ?? (buffer.call.subagentMessages = []);
    let message = messages.find((entry) => entry.id === safeMessageId);
    if (!message) {
      if (messages.length >= MAX_SUBAGENT_MESSAGES) return;
      message = { id: safeMessageId, content: '', createdAt: nowIso() };
      messages.push(message);
    }
    const currentTotal = messages.reduce((total, entry) => total + entry.content.length, 0);
    const available = Math.min(MAX_SUBAGENT_TEXT_PER_MESSAGE - message.content.length, MAX_SUBAGENT_TEXT_TOTAL - currentTotal);
    if (available <= 0) return;
    message.content += safeText.slice(0, available);
    this.persistTool(buffer);
    this.store.touch();
  }

  private persistTool(buffer: ToolBuffer): void {
    buffer.call.output = redactSecrets(buffer.output);
    this.store.putToolCall(buffer.call);
    buffer.dirty = false;
  }

  private appendToolOutput(run: ActiveRun, providerId: string, delta: string): void {
    if (!delta) return;
    const id = providerId.slice(0, 200);
    let buffer = run.tools.get(id);
    if (!buffer) {
      this.recordTool(run, { id, name: 'Tool', category: 'other', status: 'running', summary: 'Tool output' });
      buffer = run.tools.get(id);
    }
    if (!buffer || buffer.call.finishedAt) return;
    const next = buffer.output + delta;
    buffer.call.outputTruncated ||= next.length > MAX_TOOL_CHARS;
    buffer.output = next.slice(-MAX_TOOL_CHARS);
    buffer.dirty = true;
    if (!run.activityTimer) run.activityTimer = setTimeout(() => {
      run.activityTimer = null;
      for (const tool of run.tools.values()) if (tool.dirty) this.persistTool(tool);
      this.store.touch();
    }, this.flushIntervalMs);
  }

  private finishTools(run: ActiveRun): void {
    if (run.activityTimer) clearTimeout(run.activityTimer);
    run.activityTimer = null;
    const at = nowIso();
    for (const buffer of run.tools.values()) {
      if (buffer.call.status === 'running') {
        buffer.call.status = 'interrupted';
        buffer.call.finishedAt = at;
        buffer.call.durationMs = buffer.tick === null ? null : Math.max(0, Math.round(performance.now() - buffer.tick));
        buffer.output = (buffer.output + '\n[Mingle: run ended before this tool reported completion.]').slice(-MAX_TOOL_CHARS);
      }
      this.persistTool(buffer);
    }
  }

  private appendText(run: ActiveRun, text: string): void {
    const offset = run.stream?.text.length ?? 0;
    if (!run.stream) {
      const message = this.store.insertMessage({ sessionId: run.sessionId, runId: run.id, role: 'assistant', content: text, kind: 'streaming' });
      run.stream = { messageId: message.id, text, dirty: false };
      this.store.touch();
    } else {
      run.stream.text += text;
      run.stream.dirty = true;
      if (!run.flushTimer) run.flushTimer = setTimeout(() => this.flush(run), this.flushIntervalMs);
    }
    this.hub.broadcast({ type: 'session.delta', sessionId: run.sessionId, messageId: run.stream.messageId, delta: text, offset });
  }

  private flush(run: ActiveRun): void {
    if (run.flushTimer) clearTimeout(run.flushTimer);
    run.flushTimer = null;
    if (run.stream?.dirty) {
      this.store.updateMessage(run.stream.messageId, { content: run.stream.text });
      run.stream.dirty = false;
    }
  }

  /** Persists the streamed text and sets its final kind (null = ordinary message, 'partial' = cut short). */
  private closeStream(run: ActiveRun, kind: 'partial' | null): void {
    if (!run.stream) return;
    this.flush(run);
    this.store.updateMessage(run.stream.messageId, { content: run.stream.text, kind });
    run.stream = null;
  }

  private requestApproval(run: ActiveRun, request: { tool: string; description: string; input: Record<string, unknown> }): Promise<boolean> {
    if (run.closed || run.controller.signal.aborted) return Promise.resolve(false);
    const approval = this.store.tx(() => {
      const created = this.store.insertApproval({ sessionId: run.sessionId, tool: truncate(String(request.tool), 200), description: truncate(redactSecrets(String(request.description ?? '')), 4000), input: sanitizeInput(request.input) });
      this.store.updateSession(run.sessionId, { status: 'waiting' });
      const session = this.store.getSession(run.sessionId)!;
      this.store.recordEvent({ projectId: session.projectId, sessionId: run.sessionId, type: 'approval.requested', summary: `Approval requested: ${created.tool}`, payload: { approvalId: created.id, tool: created.tool } });
      return created;
    });
    void this.captureCheckpoint(run.sessionId, 'Provider requested host approval', run.id);
    try { run.onApproval?.(approval); } catch { /* Approval mirroring must not block the local owner prompt. */ }
    return new Promise<boolean>((resolve) => run.approvals.set(approval.id, resolve));
  }

  /** Resolves a pending approval from the host UI. Stale approvals (no live run) are expired and rejected. */
  decide(approvalId: string, decision: 'approved' | 'denied'): Approval {
    const approval = this.store.getApproval(approvalId);
    if (!approval) throw notFound('Approval not found');
    if (approval.status !== 'pending') throw conflict(`Approval was already ${approval.status}`);
    const proxyApproval = this.teamProxy?.decideApproval(approvalId, decision);
    if (proxyApproval) return proxyApproval;
    const run = this.active.get(approval.sessionId);
    const resolver = run?.approvals.get(approvalId);
    const session = this.store.getSession(approval.sessionId, true);
    if (!run || !resolver || run.closed) {
      this.store.tx(() => {
        this.store.resolveApproval(approvalId, 'denied', 'expired');
        this.store.recordEvent({ projectId: session?.projectId ?? null, sessionId: approval.sessionId, type: 'approval.expired', summary: `Approval expired: ${approval.tool}`, payload: { approvalId, reason: 'no active run' } });
      });
      throw conflict('Approval is stale: its run is no longer active');
    }
    const resolved = this.store.tx(() => {
      const result = this.store.resolveApproval(approvalId, decision, 'host');
      run.approvals.delete(approvalId);
      if (run.approvals.size === 0 && run.questions.size === 0) this.store.updateSession(approval.sessionId, { status: 'running' });
      this.store.recordEvent({ projectId: session?.projectId ?? null, sessionId: approval.sessionId, type: 'approval.resolved', summary: `Approval ${decision}: ${approval.tool}`, payload: { approvalId, decision } });
      return result;
    });
    try { run.onApprovalDecision?.(resolved, decision); } catch { /* Approval observation cannot block the owner or provider. */ }
    resolver(decision === 'approved');
    return resolved;
  }

  /** Denies and releases every pending approval of a run. */
  private denyApprovals(run: ActiveRun, reason: string): void {
    if (!run.approvals.size) return;
    const session = this.store.getSession(run.sessionId, true);
    const entries = [...run.approvals.entries()];
    run.approvals.clear();
    this.store.tx(() => {
      for (const [id] of entries) {
        this.store.resolveApproval(id, 'denied', reason);
        this.store.recordEvent({ projectId: session?.projectId ?? null, sessionId: run.sessionId, type: 'approval.denied', summary: `Approval denied (${reason})`, payload: { approvalId: id, reason } });
      }
    });
    for (const [, resolve] of entries) resolve(false);
  }

  /** Cancels active provider work, including manual native compaction. Idempotent. */
  interrupt(sessionId: string): boolean {
    if (this.teamProxy?.interrupt(sessionId)) return true;
    const run = this.active.get(sessionId);
    if (run && !run.closed) {
      this.cancelRunQuestions(run, 'The provider run was interrupted.');
      run.controller.abort();
      this.denyApprovals(run, 'interrupted');
      return true;
    }
    const compaction = this.compactions.get(sessionId);
    if (!compaction || compaction.controller.signal.aborted) return false;
    compaction.controller.abort();
    return true;
  }

  /** Fences new provider work, interrupts current work, and runs a metadata-only action once cleanup releases. */
  async withSessionsStopped<T>(sessionIds: string[], action: () => T): Promise<T> {
    const ids = [...new Set(sessionIds)];
    if (ids.some((id) => this.stopping.has(id))) throw conflict('A session removal is already in progress.');
    for (const id of ids) this.stopping.add(id);
    try {
      const pending: Promise<unknown>[] = ids.flatMap((id) => {
        const run = this.active.get(id);
        const compaction = this.compactions.get(id);
        const promises: Promise<unknown>[] = [];
        if (run) promises.push(run.promise);
        if (compaction) promises.push(compaction.promise);
        return promises;
      });
      for (const id of ids) this.interrupt(id);
      await Promise.allSettled(pending);
      const unavailable = ids.find((id) => {
        const session = this.store.getSession(id);
        return this.isActive(id) || session?.status === 'running' || session?.status === 'waiting';
      });
      if (unavailable) throw conflict('Provider cleanup is still in progress. The session remains in Mingle; try deleting it again after cleanup finishes.');
      return action();
    } finally {
      for (const id of ids) this.stopping.delete(id);
    }
  }

  /** Cancels only the compaction operation named by the caller; stale Stop requests cannot hit later work. */
  interruptCompaction(sessionId: string, operationId: string): boolean {
    const compaction = this.compactions.get(sessionId);
    if (!compaction || compaction.operationId !== operationId || compaction.controller.signal.aborted) return false;
    compaction.controller.abort();
    return true;
  }

  /** Manually compacts exactly one native conversation under the normal per-session active lock. */
  compact(sessionId: string, operationId = newId('cmp')): Promise<ContextCompactionResult> {
    const session = this.store.getSession(sessionId);
    if (!session) throw notFound('Session not found');
    if (this.stopping.has(sessionId)) throw conflict('This session is being removed from Mingle.');
    const compactOperationId = operationId.trim();
    if (!compactOperationId || compactOperationId.length > 100) throw conflict('A valid compaction operation ID is required.');
    if (this.isActive(sessionId) || session.status === 'running' || session.status === 'waiting') {
      throw conflict('This session is busy; wait for its run or provider cleanup to finish before compacting.');
    }
    this.validateSession?.(session);
    const startedAt = nowIso();
    const lock: ActiveCompaction = {
      controller: new AbortController(), operationId: compactOperationId, cleanupPending: false, startedAt, previousStatus: session.status, previousError: session.error,
      promise: Promise.resolve(null as unknown as ContextCompactionResult),
    };
    this.compactions.set(sessionId, lock);
    try {
      this.store.tx(() => {
        // Other windows read session status from bootstrap. Keep that view busy until native cleanup is done.
        this.store.updateSession(sessionId, { status: 'running' });
        this.store.recordEvent({ projectId: session.projectId, sessionId, type: 'session.compaction.started', summary: `Context compaction started: ${session.name}`, payload: { provider: session.provider, startedAt } });
      });
    } catch (error) {
      this.compactions.delete(sessionId);
      throw error;
    }
    lock.promise = this.executeCompaction(session, lock);
    return lock.promise;
  }

  private async executeCompaction(session: Session, lock: ActiveCompaction): Promise<ContextCompactionResult> {
    const startedAt = lock.startedAt;
    let checkpointId: string | null = null;
    let result: ContextCompactionResult;
    let native: Promise<ContextCompactionResult> | null = null;
    try {
      if (session.provider === 'antigravity') {
        result = this.compactionResult(session, 'unsupported', startedAt, null, 'Antigravity does not expose a client-requested native context compaction operation.', 'Native compaction is unsupported for Antigravity.');
      } else if (!session.providerSessionId) {
        result = this.compactionResult(session, 'unsupported', startedAt, null, 'This session has no confirmed native conversation history to compact.', 'No native conversation ID is available.');
      } else {
        const initialAdapter = this.providers.createAdapter(session.provider);
        if (!initialAdapter.compact) {
          const reason = `${session.provider} does not expose native manual context compaction.`;
          result = this.compactionResult(session, 'unsupported', startedAt, null, reason, reason);
        } else if (lock.controller.signal.aborted) {
          result = this.compactionResult(session, 'failed', startedAt, null, 'Compaction was interrupted before native work began.', 'Interrupted before native compaction started.');
        } else {
          checkpointId = await this.captureCheckpoint(session.id, 'Before manual context compaction') ?? null;
          if (!checkpointId) {
            result = this.compactionResult(session, 'failed', startedAt, null,
              'A durable pre-compaction checkpoint could not be saved. Native history was left untouched; resolve the storage/recovery issue and try again.',
              'The required pre-compaction recovery checkpoint was not persisted.');
          } else {
            const currentSession = this.store.getSession(session.id);
            if (!currentSession || !this.store.getProject(session.projectId)) {
              throw new Error('The selected session or project is no longer visible; native compaction was not started.');
            }
            if (currentSession.status !== 'running' || currentSession.provider !== session.provider || currentSession.providerSessionId !== session.providerSessionId) {
              throw new Error('The session configuration or native conversation changed during checkpoint capture; native compaction was not started.');
            }
            // Provider availability, policy, model, and permissions may have changed while Git/checkpoint capture awaited.
            this.validateSession?.(currentSession);
            if (lock.controller.signal.aborted) {
              result = this.compactionResult(session, 'failed', startedAt, checkpointId, 'Compaction was interrupted before native work began.', 'Interrupted before native compaction started.');
            } else {
              const adapter = this.providers.createAdapter(currentSession.provider);
              if (!adapter.compact) {
                const reason = `${currentSession.provider} no longer exposes native manual context compaction.`;
                result = this.compactionResult(session, 'unsupported', startedAt, checkpointId, reason, reason);
              } else {
                if (lock.controller.signal.aborted) throw new Error('Compaction was interrupted before native work began.');
                native = Promise.resolve(adapter.compact({ session: currentSession, settings: this.store.getSettings(), signal: lock.controller.signal }));
                native.catch(() => undefined);
                const outcome = await this.waitForCompaction(native, lock.controller.signal);
                if (outcome.kind === 'grace') {
                  lock.cleanupPending = true;
                  void native.then(
                    () => { void this.releaseCompaction(session, lock); },
                    () => { void this.releaseCompaction(session, lock); },
                  );
                  result = this.compactionResult(session, 'failed', startedAt, checkpointId,
                    'Compaction was interrupted; native cleanup is still in progress and this session remains locked.',
                    'Native compaction did not settle after interruption.');
                } else if (outcome.kind === 'error') {
                  const detail = redactSecrets(errorMessage(outcome.error)).slice(0, 1000);
                  result = this.compactionResult(session, 'failed', startedAt, checkpointId, 'The provider could not compact this conversation.', detail);
                } else {
                  if (lock.controller.signal.aborted) {
                    result = this.compactionResult(session, 'failed', startedAt, checkpointId,
                      'Compaction was interrupted, but native work may already have settled; provider-side changes cannot be rolled back.',
                      'Native compaction settled after interruption was accepted.');
                  } else {
                    const providerResult = ContextCompactionResultSchema.parse(outcome.result);
                    if (providerResult.sessionId !== session.id || providerResult.provider !== session.provider) {
                      throw new Error('Provider compaction result did not match the selected native session.');
                    }
                    result = {
                      ...providerResult,
                      checkpointId: checkpointId ?? providerResult.checkpointId,
                      message: redactSecrets(providerResult.message).slice(0, 1000),
                      error: providerResult.error === null ? null : redactSecrets(providerResult.error).slice(0, 1000),
                    };
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      const detail = redactSecrets(errorMessage(error)).slice(0, 1000);
      result = this.compactionResult(session, 'failed', startedAt, checkpointId, 'The provider could not compact this conversation.', detail);
    }

    if (!lock.cleanupPending) await this.captureCheckpoint(session.id, `After manual context compaction (${result.status})`);
    const finishedAt = result.finishedAt;
    try {
      this.store.recordEvent({
        projectId: session.projectId, sessionId: session.id, type: `session.compaction.${result.status}`,
        summary: result.status === 'completed' ? `Context compaction completed: ${session.name}` : result.status === 'unsupported' ? `Context compaction unavailable: ${session.name}` : `Context compaction failed: ${session.name}`,
        payload: { provider: session.provider, startedAt: result.startedAt, finishedAt, checkpointId: result.checkpointId, message: result.message, error: result.error },
      });
    } catch (error) {
      this.log('warn', `Could not persist compaction outcome for ${session.id}: ${redactSecrets(errorMessage(error)).slice(0, 500)}`);
    }
    if (!lock.cleanupPending) this.releaseCompactionNow(session.id, lock, true);
    return result;
  }

  private compactionResult(session: Session, status: ContextCompactionResult['status'], startedAt: string, checkpointId: string | null, message: string, error: string | null): ContextCompactionResult {
    return {
      sessionId: session.id, provider: session.provider, status, startedAt, finishedAt: nowIso(), checkpointId,
      message: redactSecrets(message).slice(0, 1000), error: error === null ? null : redactSecrets(error).slice(0, 1000),
    };
  }

  private waitForCompaction(native: Promise<ContextCompactionResult>, signal: AbortSignal): Promise<{ kind: 'result'; result: ContextCompactionResult } | { kind: 'error'; error: unknown } | { kind: 'grace' }> {
    const settled = native.then((result) => ({ kind: 'result' as const, result }), (error: unknown) => ({ kind: 'error' as const, error }));
    const grace = new Promise<{ kind: 'grace' }>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const onAbort = () => {
        if (timer) return;
        timer = setTimeout(() => resolve({ kind: 'grace' }), this.abortGraceMs);
        timer.unref();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      void settled.then(() => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      });
    });
    return Promise.race([settled, grace]);
  }

  private async releaseCompaction(session: Session, lock: ActiveCompaction): Promise<void> {
    if (this.compactions.get(session.id) !== lock) return;
    await this.captureCheckpoint(session.id, 'Manual compaction provider cleanup released');
    this.releaseCompactionNow(session.id, lock, true);
  }

  private releaseCompactionNow(sessionId: string, lock: ActiveCompaction, notifyIdle: boolean): void {
    if (this.compactions.get(sessionId) !== lock) return;
    lock.cleanupPending = false;
    let session: Session | undefined;
    try { session = this.store.getSession(sessionId, true); }
    catch (error) { this.log('warn', `Could not read session after compaction for ${sessionId}: ${redactSecrets(errorMessage(error)).slice(0, 500)}`); }
    if (session) {
      try {
        this.store.updateSession(sessionId, { status: lock.previousStatus, error: lock.previousError });
      } catch (error) {
        this.log('warn', `Could not restore session status after compaction for ${sessionId}: ${redactSecrets(errorMessage(error)).slice(0, 500)}`);
      }
    }
    this.compactions.delete(sessionId);
    if (notifyIdle) {
      try { this.groups?.onRuntimeIdle(sessionId); }
      catch (error) { this.log('error', `Failed to resume group queue after compaction for ${sessionId}`, error); }
    }
  }

  private async finish(run: ActiveRun, outcome: 'completed' | 'failed' | 'interrupted', failure: string | null, changes: RunChanges, durationMs = Math.max(0, Math.round(performance.now() - run.tick)), finishedAt = nowIso()): Promise<void> {
    run.closed = true;
    run.acceptingTools = false;
    this.cancelRunQuestions(run, outcome === 'completed' ? 'The provider run finished before the question was answered.' : `The provider run was ${outcome}.`);
    this.denyApprovals(run, outcome === 'completed' ? 'run finished' : outcome);
    try {
      this.store.tx(() => {
        this.closeStream(run, outcome === 'completed' ? null : 'partial');
        this.finishTools(run);
        this.store.setRunChanges(run.id, changes);
        this.store.finishRun(run.id, outcome, durationMs, finishedAt);
        const session = this.store.getSession(run.sessionId, true);
        if (!session) return;
        if (outcome === 'failed') {
          this.store.insertMessage({ sessionId: run.sessionId, runId: run.id, role: 'system', kind: 'error', content: `Run failed: ${failure}` });
          this.store.updateSession(run.sessionId, { status: 'error', error: failure });
        } else if (outcome === 'interrupted') {
          this.store.insertMessage({ sessionId: run.sessionId, runId: run.id, role: 'system', kind: 'info', content: 'Run interrupted.' });
          this.store.updateSession(run.sessionId, { status: 'interrupted', error: null });
        } else {
          this.consumeHandoffsOnce(run);
          this.store.updateSession(run.sessionId, { status: 'idle', error: null });
        }
        if (outcome === 'completed' && !run.firstEvent) this.store.markConsumed(run.consumedHandoffs);
        if (run.taskId) this.tasks.finishRun(run.taskId, outcome);
        if (run.executionPlanId) {
          const plan = this.store.getSessionPlan(run.executionPlanId);
          if (plan?.status === 'executing' && plan.executionRunId === run.id) {
            const status = outcome === 'completed' ? 'completed' : outcome;
            this.store.updateSessionPlan({ ...plan, status, updatedAt: finishedAt });
          }
        }
        if (run.intent === 'plan' && outcome === 'completed' && !this.store.listSessionPlans(run.sessionId).some((plan) => plan.runId === run.id)) {
          this.store.insertMessage({ sessionId: run.sessionId, runId: run.id, role: 'system', kind: 'info', content: 'The provider completed without exposing a native plan. No reviewable plan was saved.' });
        }
        this.intelligence?.finishRun(session, run.id, outcome);
        this.store.recordEvent({ projectId: session.projectId, sessionId: run.sessionId, type: 'session.progress.status', summary: 'Run progress status cleared', payload: { runId: run.id, status: null } });
        this.store.recordEvent({
          projectId: session.projectId, sessionId: run.sessionId, type: `session.run.${outcome}`,
          summary: outcome === 'completed' ? `Run completed: ${session.name}` : outcome === 'failed' ? `Run failed: ${session.name}` : `Run interrupted: ${session.name}`,
          payload: { runId: run.id, durationMs, taskId: run.taskId, ...(failure ? { error: failure } : {}) },
        });
      });
    } catch (error) {
      this.log('error', `Failed to finalise run for ${run.sessionId}: ${redactSecrets(errorMessage(error)).slice(0, 500)}`);
    }
    if (outcome === 'failed' && failure) {
      try {
        const scrubCapabilities = (value: string) => run.capabilityTokens.reduce((text, token) => text.split(token).join('[redacted]'), value);
        this.recovery?.recordFailure(run.sessionId, run.id, this.makeProviderFailure(run, failure, scrubCapabilities));
      } catch (error) {
        this.log('error', `Failed to persist provider failure for run ${run.id}: ${redactSecrets(errorMessage(error)).slice(0, 500)}`);
      }
    } else if (outcome === 'completed') {
      try { this.recovery?.clearFailure(run.sessionId); }
      catch (error) { this.log('warn', `Could not resolve prior provider failure for ${run.sessionId}: ${redactSecrets(errorMessage(error)).slice(0, 500)}`); }
    }
    await this.captureCheckpoint(run.sessionId, `Run ${outcome}`, run.id);
    if (!run.cleanupPending) {
      this.active.delete(run.sessionId);
      run.capabilityTokens.length = 0;
    }
    try { if (!run.teamRun) this.groups?.onRunFinished(run.sessionId, run.id, outcome); }
    catch (error) { this.log('error', `Failed to record group delivery outcome for ${run.sessionId}`, error); }
  }

  /** Aborts all native provider work and waits (bounded) for provider cleanup. */
  async shutdown(): Promise<void> {
    const runs = [...this.active.values()];
    const compactions = [...this.compactions.entries()];
    for (const run of runs) this.interrupt(run.sessionId);
    for (const [sessionId] of compactions) this.interrupt(sessionId);
    const pending = [...runs.map((run) => run.promise), ...compactions.map(([, lock]) => lock.promise)];
    await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, this.abortGraceMs + 1000).unref())]);
  }
}

function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  try {
    const json = redactSecrets(JSON.stringify(input ?? {}));
    if (json.length <= MAX_APPROVAL_INPUT_CHARS) return JSON.parse(json) as Record<string, unknown>;
    return { truncated: true, preview: json.slice(0, MAX_APPROVAL_INPUT_CHARS) };
  } catch {
    return { unserializable: true };
  }
}
