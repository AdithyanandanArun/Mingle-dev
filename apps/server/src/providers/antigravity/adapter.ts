import type { AdapterEvent, AgentAdapter, ContextCompactionResult, RunOptions, ToolActivity, ToolCategory } from '@mingle/contracts';
import { ProviderError, abortError, isRecord, markDispatched, markNotDispatched, redactSecrets, truncate } from '../common.js';
import { nativePlanSteps, sessionPlanSteps } from '../plans.js';
import {
  cachedAntigravityMetadata, closeAntigravity, markAntigravityAuthenticated, rememberAntigravityMetadata,
  resolveAntigravity, safeAntigravityError, safeAntigravityText, startAntigravity, type AntigravityRuntime, type AntigravitySpawn,
} from './runtime.js';
import { AcpRpcError, ACP_INVALID_PARAMS, ACP_METHOD_NOT_FOUND } from './rpc.js';
import { choices, configuration, mergeAntigravityMetadata, nativeModelValue, nativeModes, object, parseAntigravityMetadata } from './metadata.js';
import { acpPrompt, acpPromptCapabilities, invocationText } from '../attachments.js';

export interface AntigravityAdapterDeps { env?: NodeJS.ProcessEnv; spawn?: AntigravitySpawn; timeoutMs?: number }
const MODE: Record<string, string> = { supervised: 'default', balanced: 'auto_edit', 'full-access': 'yolo' };
const TEAM = new Set(['team_members', 'team_inbox', 'team_assign', 'team_message', 'team_artifact', 'team_status']);
const SESSION_TIMEOUT = 90_000;
const PROMPT_TIMEOUT = 24 * 60 * 60_000;
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const json = (value: unknown, max = 20_000): string => { try { return truncate(typeof value === 'string' ? value : JSON.stringify(value) ?? '', max); } catch { return ''; } };

export function createAntigravityAdapter(deps: AntigravityAdapterDeps = {}): AgentAdapter {
  return { async run(options) {
    markNotDispatched(options);
    if (options.signal.aborted) throw abortError();
    if (options.session.serviceTier && options.session.serviceTier !== 'standard') throw new ProviderError('Antigravity ACP does not expose Mingle service tiers. Choose Standard.', { code: 'unsupported_service_tier' });
    if ((options.skills ?? []).length || options.invocation?.kind === 'skill') throw new ProviderError('Mingle-selected Antigravity skills are unavailable. Native provider skills remain provider-owned.', { code: 'unsupported_skills' });
    if (options.intent !== 'plan' && !MODE[options.session.policy]) throw new ProviderError('Antigravity supports Supervised, Auto-accept edits and Full access. Auto is unavailable.', { code: 'unsupported_policy' });
    const env = deps.env ?? process.env;
    const resolved = await resolveAntigravity(options.settings, env);
    if (!resolved.ok) throw new ProviderError(resolved.reason, { code: 'executable_unavailable' });
    await new AntigravityRun(options, env, resolved.executable.path, resolved.executable.companion, deps).execute();
  }, async compact({ session }): Promise<ContextCompactionResult> {
    const startedAt = new Date().toISOString();
    const message = session.providerSessionId
      ? 'Antigravity ACP does not expose a client-requested native compaction operation. Mingle will not treat a generic prompt or session update as compaction.'
      : 'Antigravity has no native conversation to compact yet.';
    return {
      sessionId: session.id, provider: 'antigravity', status: 'unsupported', startedAt, finishedAt: new Date().toISOString(),
      checkpointId: null, message: truncate(redactSecrets(message), 1_000), error: null,
    };
  } };
}

class AntigravityRun {
  private runtime?: AntigravityRuntime;
  private sessionId: string | null = null;
  private phase: 'setup' | 'prompt' | 'done' = 'setup';
  private selected: unknown;
  private expectedModel: string | null = null;
  private expectedEffort: string | null = null;
  private expectedMode: string | null = null;
  private commands: unknown[] = [];
  private readonly tools = new Map<string, ToolActivity>();
  private readonly cancellation = new AbortController();
  private readonly signal: AbortSignal;
  private rejectInterrupted!: (error: Error) => void;
  private readonly interrupted = new Promise<never>((_resolve, reject) => { this.rejectInterrupted = reject; });
  private violation: Error | null = null;
  private readonly onAbort = () => { this.cancelNative(); this.rejectInterrupted(abortError()); };

  constructor(private readonly options: RunOptions, private readonly env: NodeJS.ProcessEnv, private readonly executable: string, private readonly companion: string, private readonly deps: AntigravityAdapterDeps) {
    this.signal = AbortSignal.any([options.signal, this.cancellation.signal]);
    this.interrupted.catch(() => undefined);
  }
  private emit(event: AdapterEvent): void {
    const secrets = [this.options.browserMcp?.token, this.options.teamMcp?.token, this.options.progressMcp?.token, this.env.GEMINI_API_KEY, this.env.GOOGLE_API_KEY];
    const scrub = (value: unknown): unknown => typeof value === 'string' ? safeAntigravityText(value, secrets)
      : Array.isArray(value) ? value.map(scrub)
        : isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrub(entry)])) : value;
    try { this.options.onEvent(scrub(event) as AdapterEvent); } catch { /* A host listener cannot break the provider protocol. */ }
  }
  private info(content: string): void { this.emit({ type: 'info', content: truncate(content, 1200) }); }
  private race<T>(promise: Promise<T>): Promise<T> { return Promise.race([promise, this.interrupted]); }
  private cancelNative(): void {
    if (!this.runtime || !this.sessionId || this.phase === 'done') return;
    try { this.runtime.conn.notify('session/cancel', { sessionId: this.sessionId }); } catch { /* Process cleanup remains authoritative. */ }
  }
  private fail(message: string, code: string): void {
    if (this.violation || this.phase === 'done') return;
    this.violation = new ProviderError(message, { code });
    this.cancelNative();
    this.rejectInterrupted(this.violation);
    this.cancellation.abort();
  }

  async execute(): Promise<void> {
    this.options.signal.addEventListener('abort', this.onAbort, { once: true });
    try {
      if (this.signal.aborted) throw abortError();
      this.runtime = await startAntigravity(this.executable, this.companion, {
        env: this.env, ...(this.deps.spawn ? { spawn: this.deps.spawn } : {}), cwd: this.options.session.worktreePath,
        timeoutMs: this.deps.timeoutMs ?? 12_000, signal: this.signal, keepLockOnUnresponsive: true, secrets: [this.options.browserMcp?.token, this.options.teamMcp?.token, this.options.progressMcp?.token, this.env.GEMINI_API_KEY, this.env.GOOGLE_API_KEY],
        notification: (method, params) => this.onNotification(method, params), request: (method, params) => this.onRequest(method, params),
      });
      const { conn, capabilities } = this.runtime;
      const connections = [this.options.browserMcp && { name: 'mingle_browser', ...this.options.browserMcp }, this.options.teamMcp && { name: 'mingle_team', ...this.options.teamMcp }, this.options.progressMcp && { name: 'mingle_progress', ...this.options.progressMcp }].filter((value): value is { name: string; url: string; token: string } => Boolean(value));
      const supportsHttpMcp = object(capabilities.mcpCapabilities).http === true;
      if (connections.some((connection) => connection.name !== 'mingle_progress') && !supportsHttpMcp) throw new ProviderError('The selected Antigravity runtime did not advertise HTTP MCP support. Mingle browser and team tools cannot be connected; no prompt was sent.', { code: 'mcp_unsupported' });
      if (this.options.progressMcp && !supportsHttpMcp) this.info('This Antigravity runtime does not advertise HTTP MCP support. Mingle progress tools are unavailable; use the native task plan when reported.');
      const registeredConnections = connections.filter((connection) => supportsHttpMcp || connection.name !== 'mingle_progress');
      const mcpServers = registeredConnections.map((connection) => ({ type: 'http', name: connection.name, url: connection.url, headers: [{ name: 'Authorization', value: `Bearer ${connection.token}` }] }));
      const params = { cwd: this.options.session.worktreePath, mcpServers, _meta: { antigravity: { eagerMcpServers: registeredConnections.map((connection) => connection.name), mcpMaxOutputBytes: 64_000 } } };
      const existing = this.options.session.providerSessionId;
      if (existing) {
        this.sessionId = existing;
        const method = object(capabilities.sessionCapabilities).resume ? 'session/resume' : capabilities.loadSession === true ? 'session/load' : null;
        if (!method) throw new ProviderError('This Antigravity runtime cannot resume the selected native conversation. Mingle will not create a replacement.', { code: 'resume_unsupported' });
        this.selected = await this.race(conn.request(method, { ...params, sessionId: existing }, SESSION_TIMEOUT));
        const returned = object(this.selected).sessionId;
        if (returned !== undefined && returned !== existing) throw new ProviderError('Antigravity returned a different conversation ID. The run was stopped.', { code: 'resume_failed' });
      } else {
        this.selected = await this.race(conn.request('session/new', params, SESSION_TIMEOUT));
        const id = object(this.selected).sessionId;
        if (typeof id !== 'string' || !id || id.length > 200) throw new ProviderError('Antigravity did not return a valid native conversation ID.', { code: 'protocol_error' });
        this.sessionId = id;
      }
      if (this.signal.aborted) throw abortError();
      this.emit({ type: 'session', providerSessionId: this.sessionId! });
      await this.applySelection();
      this.remember();
      markAntigravityAuthenticated(this.executable, this.env);
      if (this.options.session.model === 'default') this.info(`Antigravity selected its native default model: ${this.expectedModel}.`);
      if (this.options.settings.autoCompactPercent != null) this.info('Mingle’s automatic compaction threshold is not exposed by Antigravity ACP. Its native context management remains in effect.');
      const prompt = await acpPrompt({ text: this.options.invocation ? invocationText(this.options.invocation) : this.options.prompt,
        attachments: this.options.attachments, capabilities: acpPromptCapabilities(capabilities), agent: 'Antigravity', context: this.options.context });
      if (this.signal.aborted) throw abortError();
      this.phase = 'prompt';
      markDispatched(this.options);
      const response: unknown = await this.race(conn.request('session/prompt', { sessionId: this.sessionId, prompt }, PROMPT_TIMEOUT));
      if (this.violation) throw this.violation;
      if (this.signal.aborted) throw abortError();
      const reason = object(response).stopReason;
      if (reason === 'cancelled') throw new ProviderError('Antigravity canceled the turn without a Mingle interruption.', { code: 'turn_interrupted' });
      if (reason === 'max_tokens' || reason === 'max_turn_requests') throw new ProviderError(`Antigravity stopped at its ${reason === 'max_tokens' ? 'token' : 'turn'} limit. Partial output was retained.`, { code: 'turn_limit', outcomeKnown: true });
      if (reason !== 'end_turn' && reason !== 'refusal') throw new ProviderError('Antigravity returned an unrecognized completion state.', { code: 'protocol_error' });
    } catch (error) {
      if (this.violation) throw this.violation;
      if (this.options.signal.aborted) throw abortError();
      throw new ProviderError(`Antigravity ACP: ${safeAntigravityError(error, [this.options.browserMcp?.token, this.options.teamMcp?.token, this.options.progressMcp?.token, this.env.GEMINI_API_KEY, this.env.GOOGLE_API_KEY])}`, { code: error instanceof ProviderError ? error.code : error instanceof AcpRpcError && error.code === -32000 ? 'authentication_required' : 'antigravity_failed', cause: error });
    } finally {
      this.phase = 'done';
      this.options.signal.removeEventListener('abort', this.onAbort);
      if (this.runtime) { this.remember(); await closeAntigravity(this.runtime); }
    }
  }

  private remember(): void {
    if (!this.runtime || !this.selected) return;
    const next = parseAntigravityMetadata(this.runtime.version, this.selected, this.commands);
    rememberAntigravityMetadata(this.executable, this.env, mergeAntigravityMetadata(cachedAntigravityMetadata(this.executable, this.env), next));
  }
  private async setConfig(id: string, value: string): Promise<void> {
    if (this.signal.aborted) throw abortError();
    const response = await this.race(this.runtime!.conn.request('session/set_config_option', { sessionId: this.sessionId, configId: id, value }, SESSION_TIMEOUT));
    if (!Array.isArray(object(response).configOptions)) throw new ProviderError('Antigravity did not confirm its effective configuration.', { code: 'protocol_error' });
    this.selected = { ...object(this.selected), ...object(response) };
  }
  private async applySelection(): Promise<void> {
    const wanted = this.options.session;
    if (wanted.model !== 'default') {
      const model = configuration(this.selected, 'model');
      if (!model || !choices(model.options).some((choice) => choice.value === wanted.model)) throw new ProviderError(`Antigravity does not advertise model "${truncate(wanted.model, 150)}". Refresh models in Settings.`, { code: 'unsupported_model' });
      await this.setConfig(String(model.id), wanted.model);
      if (nativeModelValue(this.selected) !== wanted.model) throw new ProviderError('Antigravity did not select the requested model.', { code: 'unsupported_model' });
    }
    this.expectedModel = nativeModelValue(this.selected);
    if (!this.expectedModel) throw new ProviderError('Antigravity did not report its effective model. No prompt was sent.', { code: 'protocol_error' });
    if (wanted.effort !== 'none') {
      const effort = configuration(this.selected, 'thinking_level');
      if (!effort || !choices(effort.options).some((choice) => choice.value === wanted.effort)) throw new ProviderError(`Antigravity does not advertise effort "${wanted.effort}" for this model. Choose Native default or refresh its models.`, { code: 'unsupported_effort' });
      await this.setConfig(String(effort.id), wanted.effort);
      if (configuration(this.selected, 'thinking_level')?.currentValue !== wanted.effort) throw new ProviderError('Antigravity did not confirm the requested reasoning effort.', { code: 'unsupported_effort' });
      this.expectedEffort = wanted.effort;
    }
    const mode = this.options.intent === 'plan' ? nativeModes(this.selected).find((value) => value === 'plan') : MODE[wanted.policy];
    if (!mode) throw new ProviderError('This Antigravity ACP runtime did not advertise a native read-only plan mode. No prompt was sent.', { code: 'unsupported_plan_mode' });
    const selector = configuration(this.selected, 'mode');
    if (!nativeModes(this.selected).includes(mode)) throw new ProviderError('Antigravity did not advertise the requested permission mode. No prompt was sent.', { code: 'unsupported_policy' });
    this.expectedMode = mode;
    if (selector) {
      await this.setConfig(String(selector.id), mode);
      if (configuration(this.selected, 'mode')?.currentValue !== mode) throw new ProviderError('Antigravity did not confirm the requested permission mode. No prompt was sent.', { code: 'unsupported_policy' });
    } else if (this.options.intent === 'plan') {
      const response = await this.race(this.runtime!.conn.request('session/set_mode', { sessionId: this.sessionId, modeId: mode }, SESSION_TIMEOUT));
      const reported = object(response).currentModeId;
      if (typeof reported === 'string' && reported !== mode) throw new ProviderError('Antigravity did not confirm its native read-only plan mode. No prompt was sent.', { code: 'unsupported_plan_mode' });
      this.selected = { ...object(this.selected), modes: { ...object(object(this.selected).modes), currentModeId: mode } };
    } else throw new ProviderError('Antigravity did not expose a configurable permission mode. No prompt was sent.', { code: 'unsupported_policy' });
    if (nativeModelValue(this.selected) !== this.expectedModel) throw new ProviderError('Antigravity changed the selected model while applying configuration. No prompt was sent.', { code: 'model_substitution' });
    if (this.expectedEffort && configuration(this.selected, 'thinking_level')?.currentValue !== this.expectedEffort) throw new ProviderError('Antigravity changed the requested reasoning effort while applying configuration. No prompt was sent.', { code: 'unsupported_effort' });
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== 'session/request_permission') {
      if (method === 'elicitation/create' || method === 'session/request_input' || method === 'session/request_user_input') {
        this.info('This Antigravity ACP runtime requested interactive input through a method Mingle cannot verify or answer. The request was declined; no answer was sent.');
      }
      throw new AcpRpcError(ACP_METHOD_NOT_FOUND, `Mingle does not provide ACP client method ${method}.`);
    }
    const data = object(params); const call = object(data.toolCall);
    const cancelled = { outcome: { outcome: 'cancelled' } };
    if (this.phase !== 'prompt' || this.signal.aborted) return cancelled;
    if (data.sessionId !== this.sessionId) throw new AcpRpcError(ACP_INVALID_PARAMS, 'This permission request belongs to another session.');
    if (this.options.intent === 'plan') return cancelled;
    const options = Array.isArray(data.options) ? data.options.map(object) : [];
    const allow = options.find((option) => option.kind === 'allow_once' && typeof option.optionId === 'string');
    const reject = options.find((option) => option.kind === 'reject_once' && typeof option.optionId === 'string');
    if (!allow || !reject) return cancelled;
    const mcp = object(object(call._meta).mcp);
    const trustedTeam = this.options.teamMcp && mcp.server === 'mingle_team' && typeof mcp.tool === 'string' && TEAM.has(mcp.tool);
    const trustedBrowser = this.options.browserMcp && mcp.server === 'mingle_browser' && typeof mcp.tool === 'string' && /^browser_[a-z_]+$/.test(mcp.tool);
    const trustedProgress = this.options.progressMcp && mcp.server === 'mingle_progress' && ['mingle_status_set', 'mingle_plan_update'].includes(String(mcp.tool));
    let approved = Boolean(trustedTeam || trustedBrowser || trustedProgress);
    if (!approved) {
      try { approved = await Promise.race([this.options.requestApproval({ tool: truncate(text(call.title) ?? 'Antigravity tool', 200), description: truncate(text(call.title) ?? 'Antigravity requested tool permission', 1000), input: object(call.rawInput) }), this.interrupted.catch(() => false)]); }
      catch { approved = false; }
    }
    if (this.signal.aborted) return cancelled;
    // Never grant a durable native Allow Always rule, and never invent tool completion from an approval decision.
    return { outcome: { outcome: 'selected', optionId: approved ? allow.optionId : reject.optionId } };
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update' || this.phase === 'done') return;
    const data = object(params); const update = object(data.update);
    if (this.sessionId && data.sessionId !== this.sessionId) return;
    const kind = update.sessionUpdate;
    if (kind === 'available_commands_update' && Array.isArray(update.availableCommands)) { this.commands = update.availableCommands.slice(0, 100); return; }
    if (this.phase !== 'prompt' || this.signal.aborted) return; // In particular, suppress native load-session replay.
    if (kind === 'agent_message_chunk' && object(update.content).type === 'text' && typeof object(update.content).text === 'string') this.emit({ type: 'text', text: String(object(update.content).text) });
    else if (kind === 'tool_call' || kind === 'tool_call_update') this.tool(update);
    else if (kind === 'plan') {
      const steps = nativePlanSteps(update.entries, 'content');
      if (steps) {
        if (this.options.intent === 'plan') this.emit({ type: 'session.plan', providerPlanId: 'antigravity-plan', explanation: '', steps: sessionPlanSteps(steps) });
        else this.emit({ type: 'task.plan', planId: 'antigravity-plan', replace: true, steps });
      }
    } else if (kind === 'config_option_update') {
      const state = { configOptions: update.configOptions };
      const model = nativeModelValue(state);
      const effort = configuration(state, 'thinking_level')?.currentValue;
      const mode = configuration(state, 'mode')?.currentValue;
      if (model && model !== this.expectedModel) this.fail('Antigravity changed the selected model during the run. Mingle stopped the turn rather than accepting an automatic substitution.', 'model_substitution');
      if (this.expectedEffort && effort !== undefined && effort !== this.expectedEffort) this.fail('Antigravity changed the selected reasoning effort during the run.', 'effort_substitution');
      if (mode !== undefined && mode !== this.expectedMode) this.fail('Antigravity changed the selected permission mode during the run. Mingle stopped the turn.', 'permission_mode_changed');
    } else if (kind === 'current_mode_update' && update.currentModeId !== this.expectedMode) this.fail('Antigravity changed the selected permission mode during the run. Mingle stopped the turn.', 'permission_mode_changed');
    // Thoughts are provider-private. usage_update.used is context size, not input/output token usage.
  }

  private tool(update: Record<string, unknown>): void {
    const id = text(update.toolCallId);
    if (!id || id.length > 200) return;
    const prior = this.tools.get(id);
    const title = text(update.title) ?? prior?.summary ?? 'Antigravity tool';
    const mcp = object(object(update._meta).mcp);
    const input = update.rawInput;
    const raw = object(input);
    const output = object(update.rawOutput);
    let category: ToolCategory = prior?.category ?? 'other';
    if (mcp.server === 'mingle_team') category = 'agent';
    else if (mcp.server === 'mingle_browser') category = 'browser';
    else if (update.kind === 'execute') category = 'command';
    else if (update.kind === 'search') category = 'search';
    else if (update.kind === 'fetch') category = 'browser';
    else if (['read', 'edit', 'delete', 'move'].includes(String(update.kind))) category = 'file';
    const name = typeof mcp.server === 'string' && typeof mcp.tool === 'string' ? `mcp:${mcp.server}/${mcp.tool}` : prior?.name ?? (category === 'command' ? 'run_command' : title);
    const status = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : update.status === 'pending' || update.status === 'in_progress' ? 'running' : prior?.status ?? 'running';
    const activity: ToolActivity = { ...prior, id, name, category, status, summary: truncate(title, 1000) };
    if (input !== undefined) activity.input = json(input, 8000);
    if (update.rawOutput !== undefined) activity.output = json(output.combinedOutput ?? update.rawOutput);
    else if (Array.isArray(update.content)) {
      const content = update.content.flatMap((entry) => { const value = object(object(entry).content); return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []; }).join('\n');
      if (content) activity.output = truncate(content, 20_000);
    }
    const command = text(raw.CommandLine) ?? text(raw.command_line) ?? text(raw.commandLine) ?? text(output.commandLine);
    const cwd = text(raw.Cwd) ?? text(raw.cwd) ?? text(raw.working_dir) ?? text(output.cwd);
    const exitCode = output.exitCode ?? output.exit_code;
    if (command) activity.command = truncate(command, 4000);
    if (cwd) activity.cwd = truncate(cwd, 4096);
    if (typeof exitCode === 'number' && Number.isFinite(exitCode)) activity.exitCode = exitCode;
    this.tools.set(id, activity);
    this.emit({ type: 'tool.activity', activity });
  }
}
