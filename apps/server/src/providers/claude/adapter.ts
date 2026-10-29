import path from 'node:path';
import { ATTACHMENT_LIMITS, type AdapterEvent, type AgentAdapter, type AppSettings, type ContextCompactionResult, type RunOptions, type SessionPlanProposal, type UserInputField } from '@mingle/contracts';
import type { Options, PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ProviderError, TextTail, abortError, errorMessage, isAbortError, isRecord, markDispatched, markNotDispatched, redactSecrets, truncate } from '../common.js';
import { bundledClaudeCandidates, resolveExecutableCached, type ResolveResult } from '../discovery.js';
import { ClaudeMessageMapper, claudePermissionMode, describeToolUse, previewInput } from './messages.js';
import { claudeEnvironment } from './auth.js';
import { autoCompactPercent, claudeCompactEnv, describeClaudeCompaction } from '../compaction.js';
import { base64Of, fileNote, filesOf, imageMime, imagesOf, invocationText, NO_TEXT_PROMPT } from '../attachments.js';

export type QueryFn = (params: { prompt: string; options: Options }) => Query | AsyncGenerator<unknown, void>;
export type ContentQueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => Query | AsyncGenerator<unknown, void>;

export interface ClaudeAdapterDeps {
  query?: QueryFn;
  /** Structured native input, also injectable without launching a real provider. The legacy text-only query hook remains supported. */
  queryWithContent?: ContentQueryFn;
  env?: NodeJS.ProcessEnv;
  resolveExecutable?: (settings: AppSettings, env: NodeJS.ProcessEnv) => Promise<ResolveResult>;
}

export function resolveClaudeExecutable(settings: AppSettings, env: NodeJS.ProcessEnv): Promise<ResolveResult> {
  return resolveExecutableCached({ name: 'claude', override: settings.claudeExecutable, env, extraCandidates: bundledClaudeCandidates() });
}

const TEAM_TOOL_NAMES: ReadonlySet<string> = new Set(['team_members', 'team_inbox', 'team_assign', 'team_message', 'team_artifact', 'team_status'].map((name) => `mcp__mingle_team__${name}`));

function claudePlanProposal(value: string, requestId: string): SessionPlanProposal {
  const headings = [...value.matchAll(/^(?:#{1,3}\s+(.+)|\d+[.)]\s+(.+))\s*$/gm)];
  const steps = headings.length
    ? headings.map((heading, index) => {
      const start = (heading.index ?? 0) + heading[0].length;
      const end = headings[index + 1]?.index ?? value.length;
      const title = (heading[1] ?? heading[2] ?? `Step ${index + 1}`).trim().slice(0, 200);
      const description = value.slice(start, end).trim().slice(0, 4000);
      return { id: `claude-plan-step-${index + 1}`, providerId: `claude-plan-step-${index + 1}`, title, description, acceptanceCriteria: [], dependsOn: [], status: 'pending' as const };
    })
    : [{ id: 'claude-plan-step-1', providerId: 'claude-plan-step-1', title: 'Implementation plan', description: value.slice(0, 4000), acceptanceCriteria: [], dependsOn: [], status: 'pending' as const }];
  return { providerPlanId: `claude:${requestId}`.slice(0, 200), explanation: '', steps };
}

function claudeQuestionFields(input: Record<string, unknown>, requestId: string): UserInputField[] | null {
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 10) return null;
  const fields: UserInputField[] = [];
  for (const [index, raw] of input.questions.entries()) {
    if (!isRecord(raw) || typeof raw.question !== 'string' || !Array.isArray(raw.options) || raw.options.length > 20) return null;
    const options = raw.options.flatMap((option) => isRecord(option) && typeof option.label === 'string'
      ? [{ label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) }]
      : []);
    if (options.length !== raw.options.length) return null;
    fields.push({
      id: `claude-${requestId.slice(0, 80)}-${index + 1}`, ...(typeof raw.header === 'string' ? { header: raw.header } : {}),
      question: raw.question, options, multiSelect: raw.multiSelect === true, allowOther: true, secret: raw.secret === true,
    });
  }
  return fields;
}

function promptWithSelectedClaudeSkill(prompt: string, skillName: string): string {
  const escapedName = skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let body = prompt.replace(new RegExp(`(^|\\s)\\$${escapedName}(?=$|\\s)`, 'g'), '$1');
  body = body.replace(new RegExp(`^/\\$${escapedName}(?=$|\\s)`), '').trim();
  if (!body) return `/${skillName}`;
  if (new RegExp(`^/${escapedName}(?=$|\\s)`).test(body)) return body;
  return `/${skillName} ${body}`;
}

async function loadSdkQuery(): Promise<ContentQueryFn> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.query;
}

export function createClaudeAdapter(deps: ClaudeAdapterDeps = {}): AgentAdapter {
  const env = deps.env ?? process.env;
  const resolveBinary = deps.resolveExecutable ?? resolveClaudeExecutable;
  return {
    async run(run: RunOptions): Promise<void> {
      markNotDispatched(run);
      const { session, signal, onEvent, requestApproval, settings } = run;
      if (signal.aborted) throw abortError();
      const selectedSkills = run.invocation?.kind === 'skill' && run.invocation.skill ? [run.invocation.skill] : run.skills ?? [];
      if (run.invocation?.kind === 'skill' && !run.invocation.skill) throw new ProviderError('The selected Claude skill was not resolved. Refresh its catalog.', { code: 'invalid_skill' });
      if (run.invocation?.kind === 'command' && selectedSkills.length) throw new ProviderError('Choose one Claude command or skill per message.', { code: 'multiple_skills_unsupported' });
      if (selectedSkills.length > 1) {
        throw new ProviderError('Claude sessions can dispatch one selected skill per run. Choose a single skill or clear the selection.', { code: 'multiple_skills_unsupported' });
      }
      const selectedSkill = selectedSkills[0];
      const selectedSkillName = selectedSkill?.name.replace(/^\/+/, '');
      if (selectedSkill && (!selectedSkill.enabled || selectedSkill.source === 'user' || !selectedSkillName || !/^[A-Za-z0-9_.:-]+$/.test(selectedSkillName))) {
        throw new ProviderError('The selected Claude skill is unavailable or has an invalid name. Refresh the provider catalog and select a listed project skill.', { code: 'invalid_skill' });
      }
      if (run.invocation?.kind === 'skill' && selectedSkillName !== run.invocation.name) throw new ProviderError('The selected skill changed. Refresh its catalog.', { code: 'invalid_skill' });
      const userText = run.invocation ? invocationText(run.invocation) : selectedSkillName ? promptWithSelectedClaudeSkill(run.prompt, selectedSkillName) : run.prompt;
      const note = fileNote(filesOf(run.attachments));
      const prompt = [userText || NO_TEXT_PROMPT, note].filter(Boolean).join('\n\n');
      const images = imagesOf(run.attachments);
      for (const image of images) imageMime(image, ATTACHMENT_LIMITS.claudeImageBytes);
      if (session.effort !== 'none' && !['low', 'medium', 'high', 'xhigh', 'max'].includes(session.effort)) {
        throw new ProviderError(`Claude does not support reasoning effort "${session.effort}". Refresh the model capabilities and choose a listed effort.`, { code: 'unsupported_effort' });
      }
      if (session.serviceTier && !['standard', 'fast'].includes(session.serviceTier)) {
        throw new ProviderError(`Claude does not support service tier "${session.serviceTier}".`, { code: 'unsupported_service_tier' });
      }
      const compactPercent = autoCompactPercent(settings);
      const childEnv = { ...claudeEnvironment(env), ...claudeCompactEnv(compactPercent) };
      const secrets = [childEnv.ANTHROPIC_API_KEY, childEnv.CLAUDE_CODE_OAUTH_TOKEN, childEnv.ANTHROPIC_AUTH_TOKEN, run.browserMcp?.token, run.teamMcp?.token, run.progressMcp?.token];
      const resolved = await resolveBinary(settings, env);
      if (!resolved.ok) throw new ProviderError(resolved.reason, { code: 'executable_unavailable' });
      if (signal.aborted) throw abortError();

      const stderr = new TextTail();
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });

      // Never allow a tool call to proceed on an approval that has not been answered, and never past an abort.
      const canUseTool = async (toolName: string, input: Record<string, unknown>, context: { signal: AbortSignal; title?: string; toolUseID?: string }): Promise<PermissionResult> => {
        if (signal.aborted || context.signal.aborted) return { behavior: 'deny', message: 'The run was interrupted.', interrupt: true };
        // Mingle's authenticated browser gateway enforces this run's policy and shared-control ownership.
        if (run.browserMcp && toolName.startsWith('mcp__mingle_browser__')) return { behavior: 'allow', updatedInput: input };
        // Only the six host-backed team tools; the bridge re-checks the run, membership and delivery on every call.
        if (run.teamMcp && TEAM_TOOL_NAMES.has(toolName)) return { behavior: 'allow', updatedInput: input };
        if (run.progressMcp && ['mcp__mingle_progress__mingle_status_set', 'mcp__mingle_progress__mingle_plan_update'].includes(toolName)) return { behavior: 'allow', updatedInput: input };
        if (toolName === 'AskUserQuestion') {
          const requestId = context.toolUseID;
          const questions = requestId ? claudeQuestionFields(input, requestId) : null;
          if (!run.requestUserInput || !requestId || !questions) {
            emit({ type: 'info', content: 'Claude requested interactive input, but this runtime did not provide a valid native question request. The request was declined.' });
            return { behavior: 'deny', message: 'Mingle could not safely display this question. Continue with your best judgement and state any assumptions.' };
          }
          const answers = await run.requestUserInput({ nativeRequestId: requestId, tool: 'AskUserQuestion', questions });
          if (!answers || signal.aborted || context.signal.aborted) return { behavior: 'deny', message: 'The user-input request was cancelled. Continue without it and explain any blocker.' };
          const mapped = Object.fromEntries(questions.map((field, index) => {
            const original = (input.questions as Record<string, unknown>[])[index]!;
            const question = typeof original.question === 'string' ? original.question : field.id;
            return [question, (answers[field.id] ?? []).join(', ')];
          }));
          return { behavior: 'allow', updatedInput: { ...input, answers: mapped } };
        }
        if (toolName === 'ExitPlanMode' && run.intent === 'plan') {
          const plan = typeof input.plan === 'string' ? input.plan.trim() : '';
          if (plan) {
            const proposal = claudePlanProposal(plan, context.toolUseID ?? 'plan');
            emit({ type: 'session.plan', ...proposal });
            return { behavior: 'deny', message: 'The plan has been captured in Mingle for user review. Do not exit plan mode or begin implementation; provide a concise summary and finish this planning turn.' };
          }
          return { behavior: 'deny', message: 'Mingle could not capture an empty plan. Provide a concrete plan before finishing.' };
        }
        const aborted = new Promise<false>((resolve) => {
          const done = (): void => resolve(false);
          if (context.signal.aborted || signal.aborted) done();
          context.signal.addEventListener('abort', done, { once: true });
          signal.addEventListener('abort', done, { once: true });
        });
        let approved = false;
        try {
          approved = (await Promise.race([
            requestApproval({ tool: toolName, description: describeToolUse(toolName, input, context.title), input: previewInput(input) }),
            aborted,
          ])) === true;
        } catch {
          approved = false; // fail closed
        }
        if (signal.aborted) return { behavior: 'deny', message: 'The run was interrupted.', interrupt: true };
        return approved
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'The user denied this tool call. Do not retry it; continue without it or explain what is blocked.' };
      };

      const mcpServers: NonNullable<Options['mcpServers']> = {};
      if (run.browserMcp) mcpServers.mingle_browser = { type: 'http', url: run.browserMcp.url, headers: { Authorization: `Bearer ${run.browserMcp.token}` } };
      if (run.teamMcp) mcpServers.mingle_team = { type: 'http', url: run.teamMcp.url, headers: { Authorization: `Bearer ${run.teamMcp.token}` } };
      if (run.progressMcp) mcpServers.mingle_progress = { type: 'http', url: run.progressMcp.url, headers: { Authorization: `Bearer ${run.progressMcp.token}` } };

      const options: Options = {
        cwd: session.worktreePath,
        model: session.model,
        ...(session.effort !== 'none' ? { effort: session.effort as NonNullable<Options['effort']> } : {}),
        permissionMode: run.intent === 'plan' ? 'plan' : claudePermissionMode(session.policy),
        ...(session.policy === 'full-access' && run.intent !== 'plan' ? { allowDangerouslySkipPermissions: true } : {}),
        canUseTool,
        includePartialMessages: true,
        abortController: controller,
        pathToClaudeCodeExecutable: resolved.executable.path,
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(run.context ? { append: run.context, snapshot: false } : {}) },
        ...(run.attachments?.length ? { additionalDirectories: [...new Set(run.attachments.map((item) => path.dirname(item.path)))] } : {}),
        settingSources: ['project'],
        settings: { disableAllHooks: true, fastMode: session.serviceTier === 'fast' },
        ...(selectedSkillName ? { skills: [selectedSkillName] } : {}),
        env: { ...childEnv, CLAUDE_AGENT_SDK_CLIENT_APP: 'mingle/0.0.1' },
        stderr: (data: string) => stderr.push(data),
        ...(session.providerSessionId ? { resume: session.providerSessionId } : {}),
        ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      };

      const emit = (event: AdapterEvent): void => {
        try { onEvent(event); } catch { /* host listener errors must not break the stream */ }
      };
      const mapper = new ClaudeMessageMapper(session.model, emit, run.providerTaskState);
      let stream: Query | AsyncGenerator<unknown, void> | undefined;
      try {
        if (images.length) {
          if (deps.query && !deps.queryWithContent) throw new ProviderError('The injected Claude query supports text only; structured image input requires queryWithContent.', { code: 'unsupported_attachment' });
          const content: Exclude<SDKUserMessage['message']['content'], string> = [{ type: 'text', text: prompt }];
          for (const image of images) content.push({ type: 'image', source: { type: 'base64', media_type: imageMime(image, ATTACHMENT_LIMITS.claudeImageBytes), data: await base64Of(image) } });
          if (signal.aborted) throw abortError();
          const input = (async function* (): AsyncGenerator<SDKUserMessage> {
            markDispatched(run);
            yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...(session.providerSessionId ? { session_id: session.providerSessionId } : {}) };
          })();
          const query = deps.queryWithContent ?? await loadSdkQuery();
          stream = query({ prompt: input, options });
        } else {
          const query = deps.query ?? deps.queryWithContent ?? await loadSdkQuery();
          // The SDK owns the native request after query() receives text; failures from this point are not replay-safe.
          markDispatched(run);
          stream = query({ prompt, options });
        }
        if (session.serviceTier === 'fast' && typeof (stream as Query).initializationResult === 'function') {
          const initialized = await (stream as Query).initializationResult();
          if (initialized.fast_mode_state !== 'on') {
            const reason = initialized.fast_mode_disabled_reason ? ` (${initialized.fast_mode_disabled_reason})` : '';
            throw new ProviderError(`Claude Code could not enable requested fast mode${reason}.`, { code: 'fast_mode_unavailable' });
          }
        }
        for await (const message of stream) {
          if (session.providerSessionId && isRecord(message) && message.type === 'system' && message.subtype === 'init' && !message.parent_tool_use_id &&
            typeof message.session_id === 'string' && message.session_id !== session.providerSessionId) {
            controller.abort();
            throw new ProviderError('Claude resumed a different conversation. Mingle stopped the run to preserve the selected conversation.', { code: 'resume_failed' });
          }
          const compaction = describeClaudeCompaction(message, compactPercent);
          if (compaction) emit({ type: 'info', content: compaction });
          mapper.handle(message);
          if (signal.aborted) break;
        }
        if (signal.aborted) throw abortError();
        if (!mapper.finished) {
          const detail = stderr.summary(1_200, secrets);
          throw new ProviderError(`Claude Code ended without a result.${detail ? ` stderr: ${detail}` : ''}`, { code: 'no_result' });
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw abortError();
        if (error instanceof ProviderError) throw new ProviderError(redactSecrets(error.message, secrets), { code: error.code, cause: error });
        const detail = stderr.summary(1_200, secrets);
        throw new ProviderError(`${redactSecrets(errorMessage(error), secrets)}${detail ? ` — stderr: ${detail}` : ''}`, { code: 'claude_failed', cause: error });
      } finally {
        signal.removeEventListener('abort', onAbort);
        try { (stream as Query | undefined)?.close?.(); } catch { /* process already closed */ }
      }
    },
    async compact({ session, settings, signal }): Promise<ContextCompactionResult> {
      const startedAt = new Date().toISOString();
      const result = (status: ContextCompactionResult['status'], message: string, error: string | null): ContextCompactionResult => ({
        sessionId: session.id, provider: 'claude', status, startedAt, finishedAt: new Date().toISOString(), checkpointId: null,
        message: truncate(redactSecrets(message), 1_000), error: error ? truncate(redactSecrets(error), 1_000) : null,
      });
      if (!session.providerSessionId) return result('unsupported', 'Claude has no native conversation to compact yet.', null);
      if (signal.aborted) return result('failed', 'Claude compaction was interrupted before it started.', 'interrupted');
      if (session.effort !== 'none' && !['low', 'medium', 'high', 'xhigh', 'max'].includes(session.effort)) {
        return result('failed', `Claude does not support reasoning effort "${session.effort}".`, 'unsupported_effort');
      }
      if (session.serviceTier && !['standard', 'fast'].includes(session.serviceTier)) return result('failed', 'Claude does not support this service tier.', 'unsupported_service_tier');
      const env = deps.env ?? process.env;
      const resolved = await resolveBinary(settings, env);
      if (!resolved.ok) return result('failed', resolved.reason, resolved.reason);
      const childEnv = { ...claudeEnvironment(env), ...claudeCompactEnv(autoCompactPercent(settings)) };
      const secrets = [childEnv.ANTHROPIC_API_KEY, childEnv.CLAUDE_CODE_OAUTH_TOKEN, childEnv.ANTHROPIC_AUTH_TOKEN];
      const controller = new AbortController();
      let releaseInput!: (send: boolean) => void;
      let released = false;
      const gate = new Promise<boolean>((resolve) => { releaseInput = resolve; });
      const sendCommand = (send: boolean): void => { if (!released) { released = true; releaseInput(send); } };
      const onAbort = (): void => { sendCommand(false); controller.abort(); };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      const mcpServers: NonNullable<Options['mcpServers']> = {};
      const options: Options = {
        cwd: session.worktreePath, model: session.model,
        ...(session.effort !== 'none' ? { effort: session.effort as NonNullable<Options['effort']> } : {}),
        // Native compaction only needs the command/control channel. Narrow permissions and disable model tools entirely.
        permissionMode: 'default', tools: [],
        canUseTool: async () => ({ behavior: 'deny', message: 'Compaction does not execute tools.' }),
        includePartialMessages: true, abortController: controller, pathToClaudeCodeExecutable: resolved.executable.path,
        systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: false },
        settingSources: ['project'], settings: { disableAllHooks: true, fastMode: session.serviceTier === 'fast' },
        env: { ...childEnv, CLAUDE_AGENT_SDK_CLIENT_APP: 'mingle/0.0.1' },
        stderr: () => undefined, resume: session.providerSessionId,
        ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      };
      const input = async function* (): AsyncGenerator<SDKUserMessage> {
        if (!await gate || signal.aborted) return;
        yield { type: 'user', message: { role: 'user', content: '/compact' }, parent_tool_use_id: null, session_id: session.providerSessionId! };
      };
      let stream: Query | AsyncGenerator<unknown, void> | undefined;
      let boundary = false;
      let compactFailed: string | null = null;
      let completed = false;
      try {
        const query = deps.queryWithContent ?? await loadSdkQuery();
        stream = query({ prompt: input(), options });
        const sdkQuery = stream as Query;
        if (typeof sdkQuery.supportedCommands !== 'function') {
          sendCommand(false);
          return result('unsupported', 'This Claude SDK does not expose a native command catalog for safe compaction.', null);
        }
        await sdkQuery.initializationResult();
        const commands = await sdkQuery.supportedCommands();
        const nativeCompact = commands.some((command) => command.name === 'compact' && command.builtin === true);
        if (!nativeCompact) {
          sendCommand(false);
          return result('unsupported', 'This Claude runtime does not advertise its built-in /compact command.', null);
        }
        if (signal.aborted) throw abortError('Claude compaction was interrupted');
        sendCommand(true);
        for await (const message of stream) {
          if (signal.aborted) throw abortError('Claude compaction was interrupted');
          if (!isRecord(message)) continue;
          if (message.type === 'system' && message.subtype === 'init' && message.session_id !== session.providerSessionId) {
            throw new ProviderError('Claude resumed a different conversation. Mingle stopped compaction to preserve the selected native conversation.', { code: 'resume_failed' });
          }
          if (message.type === 'system' && message.subtype === 'compact_boundary') boundary = true;
          if (message.type === 'system' && message.subtype === 'status' && message.compact_result === 'failed') compactFailed = typeof message.compact_error === 'string' ? message.compact_error : 'Claude reported that native compaction failed.';
          if (message.type === 'result') completed = message.subtype === 'success' && message.is_error !== true;
        }
        if (signal.aborted) throw abortError('Claude compaction was interrupted');
        if (compactFailed) return result('failed', 'Claude could not compact the native conversation.', compactFailed);
        if (!completed || !boundary) return result('failed', 'Claude did not confirm successful native compaction; the selected conversation remains unchanged.', 'compaction_unconfirmed');
        return result('completed', 'Claude compacted the native conversation.', null);
      } catch (error) {
        const detail = truncate(redactSecrets(errorMessage(error), secrets), 1_000);
        return result('failed', signal.aborted ? 'Claude compaction was interrupted; the native conversation remains selected.' : `Claude could not compact the native conversation: ${detail}`, detail);
      } finally {
        signal.removeEventListener('abort', onAbort);
        sendCommand(false);
        try { (stream as Query | undefined)?.close?.(); } catch { /* process already closed */ }
      }
    },
  };
}
