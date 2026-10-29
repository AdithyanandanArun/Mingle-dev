import { nativePlanSteps } from '../plans.js';
import type { ProviderTaskPlan, AdapterEvent, Policy, ToolActivity, ToolCategory } from '@mingle/contracts';
import { ProviderError, describeValue, isRecord, truncate } from '../common.js';

export type ClaudeSdkPermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan';

/** Mingle policy names map directly to Claude Code permission modes. */
export function claudePermissionMode(policy: Policy): ClaudeSdkPermissionMode {
  switch (policy) {
    case 'supervised': return 'default';
    case 'balanced': return 'acceptEdits';
    case 'auto': return 'auto';
    case 'full-access': return 'bypassPermissions';
  }
}

export const CLAUDE_MODELS: { id: string; name: string }[] = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
];

export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5-5';

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

/** Copy of a tool input that is safe to show or store: long strings are shortened. */
export function previewInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = typeof value === 'string' ? truncate(value, 4_000) : isRecord(value) || Array.isArray(value) ? truncate(JSON.stringify(value), 4_000) : value;
  }
  return out;
}

export function describeToolUse(toolName: string, input: Record<string, unknown>, sdkTitle?: string): string {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  let text: string;
  switch (toolName) {
    case 'Bash': text = `Run command: ${str(input.command) ?? describeValue(input, 300)}`; break;
    case 'Write': text = `Write file ${path ?? '(unknown path)'}`; break;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': text = `Edit file ${path ?? '(unknown path)'}`; break;
    case 'WebFetch': text = `Fetch ${str(input.url) ?? 'a URL'}`; break;
    case 'WebSearch': text = `Search the web for "${str(input.query) ?? ''}"`; break;
    default: text = sdkTitle ?? `Use tool ${toolName}: ${describeValue(input, 300)}`;
  }
  return truncate(text, 900);
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : isRecord(part) ? `[${String(part.type ?? 'content')}]` : String(part))).join('\n');
  }
  return describeValue(content, 800);
}

export interface ClaudeStreamResult { sessionId: string | null; finished: boolean }

/**
 * Turns Agent SDK messages into host events.
 * Text comes from partial stream events; the complete assistant message supplies tool calls and only
 * contributes text when the same message was not streamed (so nothing is shown twice).
 */
export class ClaudeMessageMapper {
  private sessionId: string | null = null;
  private readonly currentMessageIds = new Map<string, string>();
  private readonly streamedMessages = new Set<string>();
  private readonly tools = new Map<string, { name: string; input: string; parentId: string | null }>();
  private readonly seenTools = new Set<string>();
  private readonly completedTools = new Set<string>();
  private readonly streamTools = new Map<string, { id: string; name: string; parentId: string | null; partial: string }>();
  private readonly taskToToolUse = new Map<string, string>();
  private readonly taskStates = new Map<string, { status: ToolActivity['status']; summary?: string; durationMs?: number }>();
  private readonly planTasks = new Map<string, ProviderTaskPlan['steps'][number]>();
  private emittedText = false;
  private textBlockOpen = false;
  private lastAssistantError: string | null = null;
  finished = false;

  constructor(private readonly requestedModel: string, private readonly emit: (event: AdapterEvent) => void, nativeTasks: ProviderTaskPlan['steps'] = []) {
    for (const step of nativeTasks.slice(0, 100)) this.planTasks.set(JSON.stringify(['root', step.id]), step);
  }

  get providerSessionId(): string | null { return this.sessionId; }

  private noteSession(id: unknown): void {
    if (typeof id === 'string' && id && id !== this.sessionId) {
      this.sessionId = id;
      this.emit({ type: 'session', providerSessionId: id });
    }
  }

  private text(delta: string): void {
    if (!delta) return;
    const separator = this.emittedText && !this.textBlockOpen ? '\n\n' : '';
    this.textBlockOpen = true;
    this.emittedText = true;
    this.emit({ type: 'text', text: separator + delta });
  }

  private subagentText(parentId: string, messageId: string | undefined, text: string, blockIndex = 0): void {
    if (!text) return;
    this.emit({ type: 'subagent.text', parentId, messageId: messageId ?? `message-${blockIndex}`, text });
  }

  private toolActivity(id: string, name: string, input: string, parentId: string | null, status: ToolActivity['status'], output?: string, durationMs?: number, summaryOverride?: string, details?: { cwd?: string; exitCode?: number; processId?: string }): void {
    const category: ToolCategory = name === 'Bash' ? 'command'
      : /^mcp__mingle_team__team_/.test(name) ? 'agent'
      : /websearch|search/i.test(name) ? 'search'
      : /webfetch|browser|playwright/i.test(name) || /mcp__t3_code__preview_/i.test(name) ? 'browser'
      : /^(Agent|Task)$/.test(name) ? 'agent'
      : /^(Write|Edit|MultiEdit|NotebookEdit|Read|Glob|Grep)$/.test(name) ? 'file' : 'other';
    let parsed: Record<string, unknown> = {};
    try { const value: unknown = JSON.parse(input); if (isRecord(value)) parsed = value; } catch { /* partial JSON remains visible as plain input */ }
    const command = name === 'Bash' && typeof parsed.command === 'string' ? parsed.command : null;
    const cwd = details?.cwd ?? (typeof parsed.cwd === 'string' ? parsed.cwd : null);
    const summary = summaryOverride ? truncate(summaryOverride, 1_500) : command ? truncate(`$ ${command}`, 1_500) : describeToolUse(name, parsed);
    this.emit({ type: 'tool.activity', activity: { id, name, category, status, parentId, summary, input: truncate(input || '{}', 8_000), ...(command ? { command: truncate(command, 4_000) } : {}), ...(cwd ? { cwd } : {}), ...(output !== undefined ? { output: truncate(output, 20_000) } : {}), ...(durationMs !== undefined ? { durationMs } : {}), ...(details?.exitCode !== undefined ? { exitCode: details.exitCode } : {}), ...(details?.processId ? { processId: details.processId } : {}) } });
  }

  /** Processes one SDK message. Throws ProviderError for failures that must end the run. */
  handle(message: unknown): void {
    if (!isRecord(message) || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'system': return this.system(message);
      case 'stream_event': return this.streamEvent(message);
      case 'assistant': return this.assistant(message);
      case 'user': return this.user(message);
      case 'tool_progress': return this.toolProgress(message);
      case 'result': return this.result(message);
      default: return; // task, hook, status and other bookkeeping messages are not surfaced
    }
  }

  private system(message: Record<string, unknown>): void {
    if (message.subtype === 'task_started') {
      const taskId = str(message.task_id);
      const toolUseId = str(message.tool_use_id);
      if (taskId && toolUseId && message.ambient !== true && message.skip_transcript !== true) {
        // Task events describe work owned by the existing Agent/Bash invocation; they are not a second tool call.
        this.taskToToolUse.set(taskId, toolUseId);
        this.taskStates.set(taskId, { status: 'running' });
        this.syncTaskActivity(taskId);
      }
      return;
    }
    if (message.subtype === 'task_progress') {
      const taskId = str(message.task_id);
      const id = taskId ? this.taskToToolUse.get(taskId) : undefined;
      const usage = isRecord(message.usage) ? message.usage : {};
      if (taskId && id && !this.completedTools.has(id) && message.ambient !== true) {
        this.taskStates.set(taskId, { status: 'running', summary: str(message.summary) ?? str(message.description), ...(typeof usage.duration_ms === 'number' ? { durationMs: usage.duration_ms } : {}) });
        this.syncTaskActivity(taskId);
      }
      return;
    }
    if (message.subtype === 'task_notification') {
      const taskId = str(message.task_id);
      const id = taskId ? this.taskToToolUse.get(taskId) : undefined;
      if (id && taskId && !this.completedTools.has(id)) {
        const status = message.status === 'failed' ? 'failed' : message.status === 'stopped' ? 'interrupted' : 'completed';
        const usage = isRecord(message.usage) ? message.usage : {};
        this.taskStates.set(taskId, { status, summary: str(message.summary), ...(typeof usage.duration_ms === 'number' ? { durationMs: usage.duration_ms } : {}) });
        this.syncTaskActivity(taskId);
      }
      return;
    }
    switch (message.subtype) {
      case 'init': {
        if (str(message.parent_tool_use_id)) return;
        this.noteSession(message.session_id);
        const model = str(message.model);
        if (model && model !== this.requestedModel && !model.startsWith(this.requestedModel) && !this.requestedModel.startsWith(model)) {
          this.emit({ type: 'info', content: `Claude is running model ${model} although ${this.requestedModel} was requested.` });
        }
        return;
      }
      case 'api_retry':
        this.emit({ type: 'info', content: `Claude API request failed (${String(message.error ?? 'error')}${message.error_status ? ` HTTP ${String(message.error_status)}` : ''}); retry ${String(message.attempt)} of ${String(message.max_retries)}.` });
        return;
      case 'model_refusal_fallback':
        throw new ProviderError(`Claude retried on a fallback model (${String(message.original_model)} → ${String(message.fallback_model)}). Mingle does not allow automatic model substitution, so the run was stopped.`, { code: 'model_substitution' });
      case 'model_refusal_no_fallback':
        this.emit({ type: 'info', content: truncate(str(message.content) ?? `${String(message.original_model)} declined to respond.`, 600) });
        return;
      default:
        return;
    }
  }

  private syncTaskActivity(taskId: string): void {
    const id = this.taskToToolUse.get(taskId);
    const state = this.taskStates.get(taskId);
    const tool = id ? this.tools.get(id) : undefined;
    if (!id || !state || !tool || this.completedTools.has(id)) return;
    this.toolActivity(id, tool.name, tool.input, tool.parentId, state.status, undefined, state.durationMs, state.summary);
    if (state.status !== 'running') this.completedTools.add(id);
  }

  private syncTasksForTool(toolUseId: string): void {
    for (const [taskId, id] of this.taskToToolUse) if (id === toolUseId) this.syncTaskActivity(taskId);
  }

  private streamEvent(message: Record<string, unknown>): void {
    const parentId = str(message.parent_tool_use_id) ?? null;
    if (!parentId) this.noteSession(message.session_id);
    const parentKey = JSON.stringify(parentId);
    const event = isRecord(message.event) ? message.event : null;
    if (!event) return;
    switch (event.type) {
      case 'message_start': {
        const inner = isRecord(event.message) ? event.message : null;
        const messageId = inner ? str(inner.id) : undefined;
        if (messageId) this.currentMessageIds.set(parentKey, messageId);
        return;
      }
      case 'content_block_start': {
        const block = isRecord(event.content_block) ? event.content_block : null;
        if (block?.type === 'text' && !parentId) this.textBlockOpen = false;
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          const name = str(block.name) ?? 'tool';
          const messageId = this.currentMessageIds.get(parentKey) ?? '';
          const streamKey = JSON.stringify([parentId, messageId, event.index]);
          this.streamTools.set(streamKey, { id: block.id, name, parentId, partial: '' });
          this.tools.set(block.id, { name, input: '{}', parentId });
          this.seenTools.add(block.id);
          this.syncTasksForTool(block.id);
          if (!this.completedTools.has(block.id)) this.toolActivity(block.id, name, '{}', parentId, 'running');
        }
        return;
      }
      case 'content_block_delta': {
        const delta = isRecord(event.delta) ? event.delta : null;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          const messageId = this.currentMessageIds.get(parentKey);
          if (messageId && parentId) {
            this.streamedMessages.add(JSON.stringify([parentId, messageId]));
            this.subagentText(parentId, messageId, delta.text);
          } else if (messageId) {
            this.streamedMessages.add(JSON.stringify([parentId, messageId]));
            this.text(delta.text);
          }
        }
        if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const messageId = this.currentMessageIds.get(parentKey) ?? '';
          const stream = this.streamTools.get(JSON.stringify([parentId, messageId, event.index]));
          if (stream) {
            stream.partial += delta.partial_json;
            this.tools.set(stream.id, { name: stream.name, input: stream.partial, parentId: stream.parentId });
            const taskId = [...this.taskToToolUse].find(([, id]) => id === stream.id)?.[0];
            const taskState = taskId ? this.taskStates.get(taskId) : undefined;
            this.toolActivity(stream.id, stream.name, stream.partial, stream.parentId, taskState?.status ?? 'running', undefined, taskState?.durationMs, taskState?.summary);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private assistant(message: Record<string, unknown>): void {
    const inner = isRecord(message.message) ? message.message : null;
    if (!inner || !Array.isArray(inner.content)) return;
    const parentId = str(message.parent_tool_use_id) ?? null;
    if (!parentId) this.noteSession(message.session_id);
    if (typeof message.error === 'string') {
      this.lastAssistantError = message.error;
      return; // synthetic API-error text is reported through the result message instead
    }
    const id = str(inner.id);
    const streamed = id !== undefined && this.streamedMessages.has(JSON.stringify([parentId, id]));
    for (const [blockIndex, block] of inner.content.entries()) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && !streamed) {
        if (parentId) this.subagentText(parentId, id, block.text, blockIndex);
        else {
          this.textBlockOpen = false;
          this.text(block.text);
        }
      } else if (block.type === 'tool_use') {
        const name = str(block.name) ?? 'tool';
        if (typeof block.id === 'string' && this.seenTools.has(block.id)) {
          if (this.completedTools.has(block.id)) continue; // SDK replay after result must not reopen a finished call.
          const input = JSON.stringify(isRecord(block.input) ? block.input : {});
          this.tools.set(block.id, { name, input, parentId });
          this.syncTasksForTool(block.id);
          if (!this.completedTools.has(block.id)) this.toolActivity(block.id, name, input, parentId, 'running');
          continue;
        }
        if (typeof block.id === 'string') {
          this.seenTools.add(block.id);
          this.tools.set(block.id, { name, input: JSON.stringify(isRecord(block.input) ? block.input : {}), parentId });
          this.syncTasksForTool(block.id);
        }
        const input = isRecord(block.input) ? block.input : {};
        if (typeof block.id === 'string' && !this.completedTools.has(block.id)) this.toolActivity(block.id, name, JSON.stringify(input), parentId, 'running');
      }
    }
  }

  private user(message: Record<string, unknown>): void {
    if (message.isReplay === true) return;
    const inner = isRecord(message.message) ? message.message : null;
    if (!inner || !Array.isArray(inner.content)) return;
    for (const block of inner.content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
      const tool = id ? this.tools.get(id) : undefined;
      if (!id || !tool) continue;
      const structured = isRecord(message.tool_use_result) && tool.name === 'Bash' ? message.tool_use_result : null;
      const body = toolResultText(block.content).trim();
      const stdout = structured?.isImage === true ? '' : str(structured?.stdout) ?? '';
      const stderr = str(structured?.stderr) ?? '';
      const structuredOutput = [stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join('\n');
      const output = structuredOutput || body;
      const exitCode = typeof structured?.exitCode === 'number' ? structured.exitCode : undefined;
      const taskId = str(structured?.backgroundTaskId);
      if (taskId) this.taskToToolUse.set(taskId, id);
      let input = tool.input;
      if (taskId) {
        try {
          const parsed: unknown = JSON.parse(input);
          if (isRecord(parsed)) input = JSON.stringify({ ...parsed, sdkResult: { backgroundTaskId: taskId } });
        } catch { /* retain original provider input if it is partial or malformed JSON */ }
      }
      const cwd = str(structured?.cwd);
      const processId = str(structured?.processId);
      const durationMs = typeof structured?.durationMs === 'number' ? structured.durationMs : undefined;
      const status = block.is_error === true || (exitCode !== undefined && exitCode !== 0) ? 'failed' : 'completed';
      this.toolActivity(id, tool.name, input, tool.parentId, status, output || undefined, durationMs, undefined, { ...(cwd ? { cwd } : {}), ...(exitCode !== undefined ? { exitCode } : {}), ...(processId ? { processId } : {}) });
      if (status === 'completed' && !this.completedTools.has(id)) this.planResult(tool.name, tool.input, tool.parentId, message.tool_use_result);
      this.completedTools.add(id);
    }
  }

  /** Only successful native task tool results report progress; tool attempts and shell prose do not. */
  private planResult(name: string, inputText: string, parentId: string | null, result: unknown): void {
    if (!['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'].includes(name)) return;
    let input: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(inputText); if (!isRecord(parsed)) return; input = parsed; } catch { return; }
    const scope = parentId ?? 'root';
    const emit = (steps: ProviderTaskPlan['steps'], replace = false) => this.emit({ type: 'task.plan', planId: `claude-${name === 'TodoWrite' ? 'todos' : 'tasks'}:${scope}`, replace, steps });
    if (name === 'TodoWrite') {
      const steps = nativePlanSteps(input.todos, 'content');
      if (steps) emit(steps, true);
      return;
    }
    if (!isRecord(result)) return;
    const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
    const note = (value: unknown, fallback?: Record<string, unknown>) => {
      if (!isRecord(value) || !validId(value.id)) return;
      const title = (str(value.subject) ?? str(fallback?.subject))?.replace(/\s+/g, ' ').slice(0, 200);
      const status = value.status ?? fallback?.status ?? 'pending';
      if (!title || !['pending', 'in_progress', 'completed', 'blocked'].includes(String(status))) return;
      const step: ProviderTaskPlan['steps'][number] = { id: value.id, title, status: status as ProviderTaskPlan['steps'][number]['status'], ...(typeof value.description === 'string' ? { description: value.description.slice(0, 4000) } : typeof fallback?.description === 'string' ? { description: fallback.description.slice(0, 4000) } : {}), ...(Array.isArray(value.blockedBy) ? { dependsOn: value.blockedBy.filter(validId).slice(0, 100) } : {}) };
      this.planTasks.set(JSON.stringify([scope, step.id]), step);
      return step;
    };
    if (name === 'TaskCreate' || name === 'TaskGet') {
      const step = note(result.task, input);
      if (step) emit([step]);
    } else if (name === 'TaskList' && Array.isArray(result.tasks)) {
      const steps = result.tasks.slice(0, 100).map(value => note(value)).filter((step): step is ProviderTaskPlan['steps'][number] => Boolean(step));
      emit(steps);
    } else if (name === 'TaskUpdate' && result.success === true && validId(result.taskId) && result.taskId === input.taskId) {
      const previous = this.planTasks.get(JSON.stringify([scope, result.taskId]));
      // Unknown native IDs are not given fabricated titles; TaskGet/List can provide their metadata.
      const change = isRecord(result.statusChange) ? result.statusChange : {};
      const step = note({ ...previous, ...input, id: result.taskId, subject: input.subject ?? previous?.title, status: change.to ?? input.status ?? previous?.status });
      if (step) {
        const deps = new Set([...(previous?.dependsOn ?? []), ...(Array.isArray(input.addBlockedBy) ? input.addBlockedBy.filter(validId) : [])]);
        step.dependsOn = [...deps].slice(0, 100);
        const updated = [step];
        if (Array.isArray(input.addBlocks)) {
          for (const blockedId of input.addBlocks.filter(validId)) {
            const blocked = this.planTasks.get(JSON.stringify([scope, blockedId]));
            if (!blocked || blocked.id === step.id) continue;
            blocked.dependsOn = [...new Set([...(blocked.dependsOn ?? []), step.id])].slice(0, 100);
            updated.push(blocked);
          }
        }
        emit(updated);
      }
    }
  }

  private toolProgress(message: Record<string, unknown>): void {
    const id = str(message.tool_use_id);
    // Progress frames have provider-stable tool IDs; heartbeat frames are not tool events.
    if (!id || message.heartbeat === true || this.completedTools.has(id)) return;
    const tool = this.tools.get(id);
    if (!tool) return; // Never create a call from progress alone.
    const seconds = typeof message.elapsed_time_seconds === 'number' ? message.elapsed_time_seconds : undefined;
    const parentId = message.parent_tool_use_id === null ? null : str(message.parent_tool_use_id) ?? tool.parentId;
    this.toolActivity(id, tool.name, tool.input, parentId, 'running', undefined, seconds === undefined ? undefined : Math.round(seconds * 1_000), `${str(message.tool_name) ?? tool.name} running${seconds !== undefined ? ` (${seconds}s)` : ''}`);
  }

  private result(message: Record<string, unknown>): void {
    if (str(message.parent_tool_use_id)) return;
    this.noteSession(message.session_id);
    this.finished = true;
    this.emitUsage(message);
    const errors = Array.isArray(message.errors) ? message.errors.filter((e): e is string => typeof e === 'string') : [];
    if (message.subtype === 'success' && message.is_error !== true) {
      const text = str(message.result);
      if (!this.emittedText && text) this.text(text);
      return;
    }
    const detail = message.subtype === 'success'
      ? str(message.result)
      : errors.join('; ') || str(message.result);
    const label = message.subtype === 'success' ? 'Claude reported an error' : `Claude run ended with ${String(message.subtype)}`;
    const assistantHint = this.lastAssistantError ? ` (${this.lastAssistantError})` : '';
    throw new ProviderError(truncate(`${label}${assistantHint}${detail ? `: ${detail}` : ''}`, 1_500), {
      code: `claude_${String(message.subtype)}`, outcomeKnown: true, cause: message,
    });
  }

  private emitUsage(message: Record<string, unknown>): void {
    let input = 0;
    let output = 0;
    let found = false;
    const modelUsage = isRecord(message.modelUsage) ? Object.values(message.modelUsage).filter(isRecord) : [];
    const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    if (modelUsage.length > 0) {
      for (const usage of modelUsage) {
        input += num(usage.inputTokens) + num(usage.cacheReadInputTokens) + num(usage.cacheCreationInputTokens);
        output += num(usage.outputTokens);
      }
      found = true;
    } else if (isRecord(message.usage)) {
      input = num(message.usage.input_tokens) + num(message.usage.cache_read_input_tokens) + num(message.usage.cache_creation_input_tokens);
      output = num(message.usage.output_tokens);
      found = true;
    }
    const cost = typeof message.total_cost_usd === 'number' && Number.isFinite(message.total_cost_usd) ? message.total_cost_usd : null;
    if (found || cost !== null) this.emit({ type: 'usage', inputTokens: input, outputTokens: output, costUsd: cost });
  }
}
