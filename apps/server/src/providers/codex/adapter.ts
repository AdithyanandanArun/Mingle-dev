import { nativePlanSteps, sessionPlanSteps } from '../plans.js';
import { spawn, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import type { AdapterEvent, AgentAdapter, AppSettings, ContextCompactionResult, NativeUserInputRequest, RunOptions } from '@mingle/contracts';
import { ProviderError, TextTail, abortError, cleanEnv, errorMessage, isRecord, markDispatched, markNotDispatched, redactSecrets, truncate } from '../common.js';
import { resolveExecutableCached, type ResolveResult } from '../discovery.js';
import { shutdownChild, type ChildLike } from '../process.js';
import {
  CodexUsageTracker, codexPolicy, commandDecision, describeCommandApproval, describeFileChangeApproval, describeLegacyApproval,
  describePermissionsApproval, describeTurnError, itemToolActivity, legacyDecision, permissionsResponse, summarizeChanges,
  type ApprovalPrompt, type FileChangeSummary,
} from './mapping.js';
import {
  autoCompactPercent, describeCodexCompaction, planCodexCompaction, rememberReportedWindow, reportedContextWindow, verifyCodexWindow,
  type CodexCompactionPlan,
} from '../compaction.js';
import { parseCodexModels, validateCodexEffort } from './capabilities.js';
import { JsonRpcConnection, RPC_METHOD_NOT_FOUND, RpcError, type CloseInfo } from './rpc.js';
import { fileNote, filesOf, imageMime, imagesOf, invocationText, NO_TEXT_PROMPT } from '../attachments.js';

export interface CodexTimeouts {
  initializeMs: number;
  threadMs: number;
  turnStartMs: number;
  interruptMs: number;
  /** How long to wait for turn/completed after turn/interrupt before the process is killed. */
  interruptGraceMs: number;
  /** Bound for the optional config/read used to discover an explicit model_context_window. */
  configReadMs: number;
  shutdownGraceMs: number;
  termMs: number;
  killMs: number;
}

export const DEFAULT_CODEX_TIMEOUTS: CodexTimeouts = {
  initializeMs: 20_000, threadMs: 60_000, turnStartMs: 60_000, interruptMs: 5_000, interruptGraceMs: 10_000, configReadMs: 5_000,
  shutdownGraceMs: 1_500, termMs: 3_000, killMs: 2_000,
};

export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildLike;

export interface CodexAdapterDeps {
  spawn?: SpawnFn;
  resolveExecutable?: (settings: AppSettings, env: NodeJS.ProcessEnv) => Promise<ResolveResult>;
  env?: NodeJS.ProcessEnv;
  timeouts?: Partial<CodexTimeouts>;
  clientVersion?: string;
}

/** Notifications that only add volume for a host that does not render raw reasoning or live command output. */
export const CODEX_OPT_OUT_NOTIFICATIONS = [
  'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded',
  'command/exec/outputDelta', 'process/outputDelta', 'fs/changed',
  'mcpServer/startupStatus/updated', 'mcpServer/event/stream/notification',
];

export const CODEX_CLIENT_INFO = { name: 'mingle', title: 'Mingle', version: '0.0.1' };

const defaultSpawn: SpawnFn = (file, args, options) => spawn(file, args, options) as unknown as ChildLike;

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => undefined); // consumers attach their own handlers; avoid unhandled-rejection noise
  return { promise, resolve, reject };
}

export function createCodexAdapter(deps: CodexAdapterDeps = {}): AgentAdapter {
  const env = deps.env ?? process.env;
  const timeouts: CodexTimeouts = { ...DEFAULT_CODEX_TIMEOUTS, ...deps.timeouts };
  const resolveBinary = deps.resolveExecutable ?? ((settings, e) => resolveExecutableCached({ name: 'codex', override: settings.codexExecutable, env: e }));
  return {
    async run(options: RunOptions): Promise<void> {
      markNotDispatched(options);
      if (options.signal.aborted) throw abortError();
      if (options.invocation?.kind === 'command') throw new ProviderError('Codex app-server does not expose prompt-style slash commands. Choose a native skill instead.', { code: 'unsupported_command' });
      const resolved = await resolveBinary(options.settings, env);
      if (!resolved.ok) throw new ProviderError(resolved.reason, { code: 'executable_unavailable' });
      if (options.signal.aborted) throw abortError();
      await new CodexRun(options, resolved.executable.path, { env, timeouts, spawn: deps.spawn ?? defaultSpawn, version: deps.clientVersion ?? CODEX_CLIENT_INFO.version }).execute();
    },
    async compact({ session, settings, signal }): Promise<ContextCompactionResult> {
      const startedAt = new Date().toISOString();
      const result = (status: ContextCompactionResult['status'], message: string, error: string | null): ContextCompactionResult => ({
        sessionId: session.id, provider: 'codex', status, startedAt, finishedAt: new Date().toISOString(), checkpointId: null,
        message: truncate(redactSecrets(message), 1_000), error: error ? truncate(redactSecrets(error), 1_000) : null,
      });
      if (!session.providerSessionId) return result('unsupported', 'Codex has no native conversation to compact yet.', null);
      if (signal.aborted) return result('failed', 'Codex compaction was interrupted before it started.', 'interrupted');
      const resolved = await resolveBinary(settings, env);
      if (!resolved.ok) return result('failed', resolved.reason, resolved.reason);
      const options: RunOptions = { session, prompt: '', settings, signal, onEvent: () => undefined, requestApproval: async () => false };
      try {
        await new CodexRun(options, resolved.executable.path, { env, timeouts, spawn: deps.spawn ?? defaultSpawn, version: deps.clientVersion ?? CODEX_CLIENT_INFO.version }).execute('compact');
        return result('completed', 'Codex compacted the native conversation.', null);
      } catch (error) {
        const detail = truncate(redactSecrets(errorMessage(error)), 1_000);
        return result('failed', signal.aborted ? 'Codex compaction was interrupted; the native conversation remains selected.' : `Codex could not compact the native conversation: ${detail}`, detail);
      }
    },
  };
}

interface RunContext { env: NodeJS.ProcessEnv; timeouts: CodexTimeouts; spawn: SpawnFn; version: string }

/** One app-server process, one thread, one turn. The process is always torn down before run() settles. */
class CodexRun {
  private readonly stderr = new TextTail();
  private readonly usage = new CodexUsageTracker();
  private readonly turnDone = deferred<void>();
  private readonly setupAborted = deferred<never>();
  private conn!: JsonRpcConnection;
  private child!: ChildLike;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private omitEffort = false;
  private compaction: CodexCompactionPlan | null = null;
  private windowChecked = false;
  private compactRequestSent = false;
  private compactRequestAccepted = false;
  private readonly compactItemsStarted = new Map<string, string | null>();
  private readonly compactItemsCompleted = new Set<string>();
  private readonly compactTurnIds = new Set<string>();
  private phase: 'setup' | 'turn' | 'compact' | 'done' = 'setup';
  private abortRequested = false;
  private interruptSent = false;
  private violation: Error | null = null;
  private lastError: string | null = null;
  private readonly textByItem = new Map<string, string>();
  private lastTextItem: string | null = null;
  private emittedText = false;
  private readonly changesByItem = new Map<string, FileChangeSummary[]>();
  private readonly warned = new Set<string>();
  private graceTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: RunOptions, private readonly executable: string, private readonly ctx: RunContext) {}

  private emit(event: AdapterEvent): void {
    try { this.options.onEvent(event); } catch { /* a faulty host listener must not break the protocol loop */ }
  }

  private info(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.emit({ type: 'info', content: truncate(message, 800) });
  }

  private describeClose(info: CloseInfo): string {
    const how = info.error
      ? `could not be started (${info.error.message}${(info.error as NodeJS.ErrnoException).code === 'ENOENT' ? '; check that the executable and the session worktree exist' : ''})`
      : `exited unexpectedly ${info.signal ? `from signal ${info.signal}` : `with code ${info.exitCode}`}`;
    const detail = this.stderr.summary(1_500, [this.options.browserMcp?.token, this.options.teamMcp?.token]);
    return `Codex app-server ${how}.${detail ? ` stderr: ${detail}` : ''}`;
  }

  async execute(operation: 'run' | 'compact' = 'run'): Promise<void> {
    const { session, signal } = this.options;
    const env = cleanEnv(this.ctx.env, ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'MINGLE_TEAM_MCP_TOKEN', 'MINGLE_BROWSER_MCP_TOKEN', 'RELAY_TEAM_MCP_TOKEN', 'RELAY_BROWSER_MCP_TOKEN']);
    if (this.options.browserMcp) env.MINGLE_BROWSER_MCP_TOKEN = this.options.browserMcp.token;
    if (this.options.teamMcp) env.MINGLE_TEAM_MCP_TOKEN = this.options.teamMcp.token;
    this.child = this.ctx.spawn(this.executable, ['app-server'], {
      cwd: session.worktreePath, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    });
    this.child.stderr?.on('data', (chunk: string | Buffer) => this.stderr.push(chunk.toString()));
    this.conn = new JsonRpcConnection(this.child, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params, requestId) => this.onServerRequest(method, params, requestId),
      formatClose: (info) => this.describeClose(info),
      onIssue: (message) => this.info(message),
    });
    // If the process dies while we are between awaits, surface it on the turn as well.
    void this.conn.closed.then((info) => {
      if (this.phase === 'turn' || this.phase === 'compact') {
        this.turnDone.reject(this.abortRequested ? abortError() : new ProviderError(this.describeClose(info), { code: 'process_exited' }));
      }
    });
    const onAbort = (): void => this.handleAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    let failure: unknown;
    try {
      await this.guard(this.initialize());
      await this.guard(this.openThread());
      if (operation === 'compact') await this.startCompaction();
      else await this.startTurn();
      await this.turnDone.promise;
      if (this.violation) throw this.violation;
    } catch (error) {
      failure = error;
    } finally {
      this.phase = 'done';
      signal.removeEventListener('abort', onAbort);
      clearTimeout(this.graceTimer);
      const usage = this.usage.result();
      if (usage) this.emit({ type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: null });
      const outcome = await shutdownChild(this.child, {
        closed: this.conn.closed, group: process.platform !== 'win32',
        graceMs: this.ctx.timeouts.shutdownGraceMs, termMs: this.ctx.timeouts.termMs, killMs: this.ctx.timeouts.killMs,
      });
      if (outcome === 'unresponsive') this.info('Codex app-server did not exit after SIGKILL; it may be orphaned.');
    }
    if (failure !== undefined) throw failure instanceof Error ? failure : new ProviderError(String(failure));
  }

  /** During setup, an abort tears everything down immediately. */
  private guard<T>(step: Promise<T>): Promise<T> {
    if (this.options.signal.aborted) return Promise.reject(abortError());
    return Promise.race([step, this.setupAborted.promise]);
  }

  private handleAbort(): void {
    this.abortRequested = true;
    if (this.phase === 'setup') {
      this.setupAborted.reject(abortError());
      return;
    }
    if (this.phase === 'turn') this.stopTurn();
    else if (this.phase === 'compact') this.turnDone.reject(abortError('Compaction interrupted'));
  }

  /** Asks Codex to stop and starts the clock after which the process is terminated regardless. */
  private stopTurn(): void {
    if (!this.graceTimer) {
      this.graceTimer = setTimeout(() => {
        this.turnDone.reject(this.abortRequested
          ? abortError('Run interrupted; Codex did not confirm in time and was terminated')
          : this.violation ?? new ProviderError('Codex did not stop after interrupt and was terminated.'));
      }, this.ctx.timeouts.interruptGraceMs);
    }
    this.interrupt();
  }

  private interrupt(): void {
    if (this.interruptSent || !this.threadId || !this.turnId) return; // resent once the turn id is known
    this.interruptSent = true;
    this.conn.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, this.ctx.timeouts.interruptMs).catch(() => undefined);
  }

  private async initialize(): Promise<void> {
    await this.conn.request('initialize', {
      clientInfo: { ...CODEX_CLIENT_INFO, version: this.ctx.version },
      capabilities: { experimentalApi: false, optOutNotificationMethods: CODEX_OPT_OUT_NOTIFICATIONS },
    }, this.ctx.timeouts.initializeMs);
    this.conn.notify('initialized', {});
  }

  private async openThread(): Promise<void> {
    const { session } = this.options;
    const policy = codexPolicy(session.policy, session.worktreePath);
    const readOnlyPlan = this.options.intent === 'plan';
    const serviceTier = session.serviceTier && session.serviceTier !== 'standard' ? session.serviceTier : null;
    const common = { model: session.model, cwd: session.worktreePath,
      approvalPolicy: readOnlyPlan ? 'on-request' as const : policy.approvalPolicy,
      approvalsReviewer: readOnlyPlan ? 'user' as const : policy.approvalsReviewer,
      sandbox: readOnlyPlan ? 'read-only' as const : policy.sandbox, serviceTier };
    const catalog = parseCodexModels(await this.conn.request('model/list', { limit: 200, includeHidden: false }, this.ctx.timeouts.threadMs));
    const model = catalog.find((candidate) => candidate.id === session.model);
    if (imagesOf(this.options.attachments).length && model?.inputModalities && !model.inputModalities.includes('image')) {
      throw new ProviderError('The selected Codex model does not advertise image input. Choose an image-capable model or remove the image; no prompt was sent.', { code: 'unsupported_attachment' });
    }
    this.omitEffort = model?.reasoningEfforts?.length === 0;
    const effortError = validateCodexEffort(model, session.effort);
    if (effortError) throw new ProviderError(effortError, { code: 'unsupported_effort' });
    if (serviceTier && !model?.serviceTiers?.some((tier) => tier.id === serviceTier)) {
      throw new ProviderError(`Service tier "${truncate(serviceTier, 80)}" is not supported by Codex model ${session.model}.`, { code: 'unsupported_service_tier' });
    }
    // Native per-thread override of model_auto_compact_token_limit; never edits the user's global Codex config.
    const percent = autoCompactPercent(this.options.settings);
    if (percent !== null) {
      this.compaction = await planCodexCompaction({
        percent, model: session.model, env: this.ctx.env,
        namespace: JSON.stringify([session.worktreePath, this.options.settings.codexExecutable, this.ctx.env.CODEX_HOME ?? '']),
        readConfig: () => this.conn.request('config/read', { includeLayers: false, cwd: session.worktreePath }, this.ctx.timeouts.configReadMs),
      });
      if (this.compaction.notice) this.info(this.compaction.notice);
    }
    const overrides: Record<string, unknown> = { ...this.compaction?.config };
    if (this.options.browserMcp) overrides['mcp_servers.mingle_browser'] = {
      url: this.options.browserMcp.url, bearer_token_env_var: 'MINGLE_BROWSER_MCP_TOKEN', enabled: true,
      startup_timeout_sec: 15, tool_timeout_sec: 180, default_tools_approval_mode: 'approve',
    };
    // Independent of the browser server; both are per-thread and neither edits global Codex configuration.
    if (this.options.teamMcp) overrides['mcp_servers.mingle_team'] = {
      url: this.options.teamMcp.url, bearer_token_env_var: 'MINGLE_TEAM_MCP_TOKEN', enabled: true,
      startup_timeout_sec: 15, tool_timeout_sec: 180, default_tools_approval_mode: 'approve',
    };
    const threadConfig = Object.keys(overrides).length ? { config: overrides } : {};
    let result: unknown;
    if (session.providerSessionId) {
      // A failed resume is an error: silently starting a fresh thread would drop the conversation.
      result = await this.conn.request('thread/resume', { ...common, ...threadConfig, threadId: session.providerSessionId, excludeTurns: true }, this.ctx.timeouts.threadMs)
        .catch((error: unknown) => {
          if (error instanceof RpcError) throw new ProviderError(`Codex could not resume thread ${session.providerSessionId}: ${error.message}`, { code: 'resume_failed', cause: error });
          throw error;
        });
    } else {
      result = await this.conn.request('thread/start', { ...common, ...threadConfig, serviceName: 'mingle' }, this.ctx.timeouts.threadMs);
    }
    const thread = isRecord(result) && isRecord(result.thread) ? result.thread : null;
    const id = thread && typeof thread.id === 'string' ? thread.id : null;
    if (!id) throw new ProviderError('Codex returned no thread id.', { code: 'protocol_error' });
    if (session.providerSessionId && id !== session.providerSessionId) {
      throw new ProviderError(`Codex resumed thread ${id} instead of ${session.providerSessionId}; refusing to continue on a different thread.`, { code: 'resume_failed' });
    }
    this.threadId = id;
    if (isRecord(result) && typeof result.model === 'string' && result.model !== session.model) {
      this.info(`Codex is using model ${result.model} although ${session.model} was requested.`);
    }
    this.emit({ type: 'session', providerSessionId: id });
  }

  private async startTurn(): Promise<void> {
    const { session, prompt } = this.options;
    const policy = codexPolicy(session.policy, session.worktreePath);
    const readOnlyPlan = this.options.intent === 'plan';
    const serviceTier = session.serviceTier && session.serviceTier !== 'standard' ? session.serviceTier : null;
    const serviceTierForTurn = serviceTier ?? 'default';
    const selected = this.options.invocation?.kind === 'skill' ? [this.options.invocation.skill] : this.options.skills ?? [];
    if (this.options.invocation?.kind === 'skill' && this.options.invocation.skill?.name !== this.options.invocation.name) {
      throw new ProviderError('The selected Codex skill changed. Refresh its catalog.', { code: 'invalid_skill' });
    }
    if (selected.some((skill) => !skill || !skill.enabled || !skill.path || !path.isAbsolute(skill.path) || skill.path.length > 4096 || !skill.name.trim())) {
      throw new ProviderError('A selected Codex skill is no longer available. Refresh the catalog and select it again.', { code: 'invalid_skill' });
    }
    const skillInputs = selected.filter((skill): skill is NonNullable<typeof skill> => Boolean(skill)).slice(0, 20)
      .map((skill) => ({ type: 'skill', name: truncate(skill.name, 150), path: skill.path as string }));
    const images = imagesOf(this.options.attachments);
    for (const image of images) imageMime(image);
    const userText = this.options.invocation ? invocationText(this.options.invocation, '$') : prompt;
    const text = [userText || NO_TEXT_PROMPT, fileNote(filesOf(this.options.attachments))].filter(Boolean).join('\n\n');
    // Skills are explicit native input items, so context can be a separate text input without changing skill dispatch or thread configuration.
    const input = [...(this.options.context ? [{ type: 'text', text: this.options.context, text_elements: [] }] : []),
      { type: 'text', text, text_elements: [] }, ...skillInputs, ...images.map((image) => ({ type: 'localImage', path: image.path }))];
    this.phase = 'turn';
    if (this.abortRequested) throw abortError();
    const request = this.conn.request('turn/start', {
      threadId: this.threadId, input, cwd: session.worktreePath,
      model: session.model, ...(!this.omitEffort ? { effort: session.effort } : {}), serviceTier, serviceTierForTurn,
      approvalPolicy: readOnlyPlan ? 'on-request' : policy.approvalPolicy,
      approvalsReviewer: readOnlyPlan ? 'user' : policy.approvalsReviewer,
      sandboxPolicy: readOnlyPlan ? { type: 'readOnly' } : policy.sandboxPolicy,
    }, this.ctx.timeouts.turnStartMs);
    markDispatched(this.options);
    request.then((result) => {
      const turn = isRecord(result) && isRecord(result.turn) ? result.turn : null;
      if (turn && typeof turn.id === 'string') this.turnId ??= turn.id;
      if (this.abortRequested || this.violation) this.interrupt();
    }, (error: unknown) => this.turnDone.reject(error instanceof Error ? error : new ProviderError(String(error))));
  }

  /** Uses Codex's app-server compaction RPC; the immediate acknowledgement is not success until the native item completes. */
  private async startCompaction(): Promise<void> {
    if (!this.threadId) throw new ProviderError('Codex did not resume the selected native thread.', { code: 'resume_failed' });
    this.phase = 'compact';
    this.compactRequestSent = true;
    await this.conn.request('thread/compact/start', { threadId: this.threadId }, 30_000);
    this.compactRequestAccepted = true;
    this.confirmCompaction();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.turnDone.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ProviderError('Codex did not confirm native compaction completion.', { code: 'compaction_unconfirmed' })), 10 * 60_000);
          timer.unref();
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  // ---- notifications -------------------------------------------------------------------------------------------

  private isOurThread(params: Record<string, unknown>): boolean {
    return typeof params.threadId !== 'string' || params.threadId === this.threadId;
  }

  private onNotification(method: string, raw: unknown): void {
    if (!isRecord(raw)) return;
    const params = raw;
    if (method === 'warning' || method === 'configWarning') {
      const text = typeof params.message === 'string' ? params.message : typeof params.summary === 'string' ? params.summary : null;
      if (text) this.info(`Codex warning: ${text}`);
      return;
    }
    if (this.phase === 'setup') return;
    if (this.phase === 'compact') {
      // Compact success must be tied to this exact resumed thread; legacy broadcasts without identity are not evidence.
      if (!this.compactRequestSent || typeof params.threadId !== 'string' || params.threadId !== this.threadId) return;
    } else if (!this.isOurThread(params)) return;
    switch (method) {
      case 'turn/plan/updated': {
        if (typeof params.turnId !== 'string' || (this.turnId && params.turnId !== this.turnId)) break;
        const steps = nativePlanSteps(params.plan, 'step');
        if (steps) {
          const explanation = typeof params.explanation === 'string' ? params.explanation.slice(0, 4000) : '';
          if (this.options.intent === 'plan') this.emit({ type: 'session.plan', providerPlanId: 'codex-plan', explanation, steps: sessionPlanSteps(steps) });
          else this.emit({ type: 'task.plan', planId: 'codex-plan', replace: true, steps, ...(explanation ? { explanation } : {}) });
        }
        break;
      }
      case 'turn/started': {
        const turn = isRecord(params.turn) ? params.turn : null;
        if (turn && typeof turn.id === 'string') {
          if (this.phase === 'compact') this.compactTurnIds.add(turn.id);
          else this.turnId ??= turn.id;
        }
        if (this.abortRequested || this.violation) this.interrupt();
        break;
      }
      case 'item/agentMessage/delta':
        if (typeof params.itemId === 'string' && typeof params.delta === 'string') this.appendText(params.itemId, params.delta);
        break;
      case 'item/started':
      case 'item/completed':
        if (isRecord(params.item)) this.onItem(params.item, method === 'item/started' ? 'started' : 'completed', typeof params.turnId === 'string' ? params.turnId : null);
        break;
      case 'item/commandExecution/outputDelta': {
        const id = typeof params.itemId === 'string' ? params.itemId : null;
        if (id && typeof params.delta === 'string' && params.delta) this.emit({ type: 'tool.output', id, delta: params.delta });
        break;
      }
      case 'thread/tokenUsage/updated':
        this.usage.update(params.tokenUsage);
        this.checkReportedWindow(params.tokenUsage);
        break;
      case 'error': {
        const message = describeTurnError(params.error, 'Codex reported an error');
        if (params.willRetry === true) this.info(`Codex is retrying after an error: ${message}`);
        else this.lastError = message;
        break;
      }
      case 'model/rerouted':
        this.onReroute(params);
        break;
      case 'turn/completed':
        this.onTurnCompleted(params);
        break;
      default:
        break;
    }
  }

  private appendText(itemId: string, delta: string): void {
    if (!delta) return;
    const separator = this.emittedText && this.lastTextItem !== null && this.lastTextItem !== itemId && !this.textByItem.has(itemId) ? '\n\n' : '';
    this.textByItem.set(itemId, (this.textByItem.get(itemId) ?? '') + delta);
    this.lastTextItem = itemId;
    this.emittedText = true;
    this.emit({ type: 'text', text: separator + delta });
  }

  private onItem(item: Record<string, unknown>, phase: 'started' | 'completed', turnId: string | null = null): void {
    const id = typeof item.id === 'string' ? item.id : null;
    if (item.type === 'contextCompaction') {
      if (this.phase === 'compact') {
        if (!id || !this.compactRequestSent) return;
        if (phase === 'started') {
          this.compactItemsStarted.set(id, turnId);
          this.info('Codex is compacting the native conversation.');
        } else {
          const startedTurnId = this.compactItemsStarted.get(id);
          if (!this.compactItemsStarted.has(id)
            || (startedTurnId !== null && turnId !== null && startedTurnId !== turnId)
            || (turnId !== null && this.compactTurnIds.size > 0 && !this.compactTurnIds.has(turnId))) return;
          this.compactItemsCompleted.add(id);
          this.confirmCompaction();
        }
      } else if (phase === 'completed') this.emit({ type: 'info', content: describeCodexCompaction(this.compaction) });
      return;
    }
    if (item.type === 'agentMessage') {
      if (phase === 'completed' && id && typeof item.text === 'string') {
        const streamed = this.textByItem.get(id) ?? '';
        if (!streamed) this.appendText(id, item.text);
        else if (item.text.length > streamed.length && item.text.startsWith(streamed)) this.appendText(id, item.text.slice(streamed.length));
      }
      return;
    }
    if (item.type === 'fileChange' && id) this.changesByItem.set(id, summarizeChanges(item.changes));
    const isTool = ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall', 'collabToolCall', 'imageView'].includes(String(item.type));
    if (isTool && !id) {
      this.info(`Codex ${String(item.type)} item had no provider id; its tool activity was omitted.`);
      return;
    }
    const activity = itemToolActivity(item, phase);
    if (activity) this.emit({ type: 'tool.activity', activity });
  }

  private confirmCompaction(): void {
    if (this.phase === 'compact' && this.compactRequestAccepted && this.compactItemsCompleted.size > 0) this.turnDone.resolve();
  }

  /** Learns Codex's own effective window and tells the user if the threshold was derived from a different capacity. */
  private checkReportedWindow(tokenUsage: unknown): void {
    const reported = reportedContextWindow(tokenUsage);
    if (reported === null) return;
    if (this.compaction?.cacheKey) rememberReportedWindow(this.compaction.cacheKey, reported);
    if (this.windowChecked || !this.compaction) return;
    this.windowChecked = true;
    const notice = verifyCodexWindow(this.compaction, reported);
    if (notice) this.info(notice);
  }

  private onReroute(params: Record<string, unknown>): void {
    if (this.violation) return;
    const from = String(params.fromModel ?? this.options.session.model);
    const to = String(params.toModel ?? 'another model');
    const reason = typeof params.reason === 'string' ? ` (${params.reason})` : '';
    this.violation = new ProviderError(`Codex rerouted the request from ${from} to ${to}${reason}. Mingle does not allow automatic model substitution, so the run was stopped.`, { code: 'model_substitution' });
    this.info(this.violation.message);
    this.stopTurn();
  }

  private onTurnCompleted(params: Record<string, unknown>): void {
    const turn = isRecord(params.turn) ? params.turn : null;
    if (!turn) return;
    if (this.phase === 'compact' && (typeof turn.id !== 'string' || !this.compactTurnIds.has(turn.id))) return;
    if (this.turnId && typeof turn.id === 'string' && turn.id !== this.turnId) return;
    switch (turn.status) {
      case 'completed':
        if (this.phase !== 'compact') this.turnDone.resolve();
        break;
      case 'failed':
        this.turnDone.reject(new ProviderError(describeTurnError(turn.error, this.lastError ?? 'Codex turn failed'), { code: 'turn_failed', outcomeKnown: true, cause: turn.error }));
        break;
      case 'interrupted':
        this.turnDone.reject(this.violation ?? (this.abortRequested ? abortError() : new ProviderError('Codex ended the turn as interrupted without a request from Mingle.', { code: 'turn_interrupted', outcomeKnown: true })));
        break;
      default:
        break; // inProgress is not a terminal status
    }
  }

  // ---- server-initiated requests -------------------------------------------------------------------------------

  private async decide(prompt: ApprovalPrompt): Promise<boolean> {
    if (this.abortRequested) return false;
    try {
      return (await this.options.requestApproval(prompt)) === true;
    } catch {
      return false; // fail closed
    }
  }

  private async onServerRequest(method: string, raw: unknown, requestId: number | string): Promise<unknown> {
    const params = isRecord(raw) ? raw : {};
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const approved = await this.decide(describeCommandApproval(params));
        return commandDecision(approved, this.abortRequested);
      }
      case 'item/fileChange/requestApproval': {
        const known = typeof params.itemId === 'string' ? this.changesByItem.get(params.itemId) ?? [] : [];
        const approved = await this.decide(describeFileChangeApproval(params, known));
        return commandDecision(approved, this.abortRequested);
      }
      case 'item/permissions/requestApproval': {
        const approved = await this.decide(describePermissionsApproval(params));
        return permissionsResponse(approved, params.permissions);
      }
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        const approved = await this.decide(describeLegacyApproval(method, params));
        return legacyDecision(approved, this.abortRequested);
      }
      case 'mcpServer/elicitation/request':
        this.info(`An MCP server (${String(params.serverName ?? 'unknown')}) asked for input; Mingle declined because it has no input surface for that.`);
        return { action: 'decline', content: null };
      case 'item/tool/requestUserInput': {
        const questions = Array.isArray(params.questions) ? params.questions : [];
        const fields: NativeUserInputRequest['questions'] = questions.flatMap((value, index) => {
          if (!isRecord(value) || typeof value.id !== 'string' || typeof value.question !== 'string' || !Array.isArray(value.options)) return [];
          const options = value.options.flatMap((option) => isRecord(option) && typeof option.label === 'string'
            ? [{ label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) }]
            : []);
          if (options.length !== value.options.length) return [];
          return [{ id: value.id, ...(typeof value.header === 'string' ? { header: value.header } : {}), question: value.question, options,
            multiSelect: value.multiSelect === true, allowOther: value.isOther === true, secret: false }];
        });
        if (!this.options.requestUserInput || !fields.length || fields.length !== questions.length) {
          this.info('Codex requested interactive input that Mingle could not validate or display; the request was rejected.');
          throw new RpcError(RPC_METHOD_NOT_FOUND, 'Mingle cannot handle this Codex user-input request.');
        }
        const answers = await this.options.requestUserInput({ nativeRequestId: String(requestId), tool: 'requestUserInput', questions: fields });
        return { answers: Object.fromEntries(Object.entries(answers ?? {}).map(([id, values]) => [id, { answers: values }])) };
      }
      case 'item/tool/call':
        this.info(`Codex requested the client-side tool "${String(params.tool ?? 'unknown')}", which Mingle does not provide.`);
        return { contentItems: [{ type: 'inputText', text: 'Mingle does not provide client-side tools.' }], success: false };
      default:
        this.info(`Codex sent an unsupported request (${method}); Mingle rejected it.`);
        throw new RpcError(RPC_METHOD_NOT_FOUND, `Mingle does not support ${method}`);
    }
  }
}
