import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import type { AppSettings, ProviderInfo, ProviderModel } from '@mingle/contracts';
import { CODEX_CLIENT_INFO } from './codex/adapter.js';
import { CODEX_POLICIES, parseCodexModel } from './codex/capabilities.js';
import { JsonRpcConnection, RpcError } from './codex/rpc.js';
import { CLAUDE_DEFAULT_MODEL, CLAUDE_MODELS } from './claude/messages.js';
import { claudeEnvironment } from './claude/auth.js';
import { CLAUDE_POLICIES, probeClaudeModels } from './claude/capabilities.js';
import { TextTail, cleanEnv, errorMessage, isRecord, redactSecrets, truncate } from './common.js';
import { bundledClaudeCandidates, resolveExecutable, type ResolvedExecutable } from './discovery.js';
import { runProbe, shutdownChild, settlesWithin, type ChildLike, type ProbeFn } from './process.js';
import { detectOpencode } from './opencode/detect.js';
import { acpPromptCapabilities } from './attachments.js';
import { antigravityInfo, ANTIGRAVITY_DEFAULT, cachedAntigravityMetadata, isAntigravityAuthenticated, closeAntigravity, resolveAntigravity, startAntigravity } from './antigravity/runtime.js';

export const CODEX_DEFAULT_MODEL = 'gpt-6.1-sol';
const CODEX_DEFAULT_MODEL_ENTRY = { id: CODEX_DEFAULT_MODEL, name: 'GPT-6.1 Sol' };
const ANTIGRAVITY_AUTH_CHECKED = 'Authenticated metadata was checked earlier in this Mingle process. Account access and quota are checked again when a run starts.';
const ANTIGRAVITY_AUTH_UNVERIFIED = 'Google sign-in is not verified; sign in from Settings. Authentication is checked when a run starts.';

export interface DetectDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  probe?: ProbeFn;
  spawn?: (file: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildLike;
  /** Overall deadline for the Codex app-server probe. */
  codexProbeTimeoutMs?: number;
}

/** ACP initialization is a safe runtime check: it does not authenticate or create a session. */
export async function detectAntigravity(settings: AppSettings, deps: DetectDeps = {}): Promise<ProviderInfo> {
  const env = deps.env ?? process.env;
  const found = await resolveAntigravity(settings, env, deps.home);
  if (!found.ok) return antigravityInfo(null, null, [ANTIGRAVITY_DEFAULT], false, found.reason);
  // Test and embedded callers that inject only discovery dependencies never launch a real provider.
  if (!deps.spawn && (deps.probe || deps.env || deps.home)) return antigravityInfo(found.executable.path, null, [ANTIGRAVITY_DEFAULT], false, 'Antigravity ACP runtime was not probed because provider dependencies were injected.');
  let runtime: Awaited<ReturnType<typeof startAntigravity>> | undefined;
  try {
    runtime = await startAntigravity(found.executable.path, found.executable.companion, {
      env, cwd: process.cwd(),
      ...(deps.spawn ? { spawn: deps.spawn as never } : {}), timeoutMs: 12_000,
    });
    const remembered = cachedAntigravityMetadata(found.executable.path, env);
    const cached = remembered?.version === runtime.version ? remembered : undefined;
    const mcp = runtime.capabilities.mcpCapabilities;
    const authNote = isAntigravityAuthenticated(found.executable.path, env)
      ? ANTIGRAVITY_AUTH_CHECKED
      : ANTIGRAVITY_AUTH_UNVERIFIED;
    const note = `${isRecord(mcp) && mcp.http === true ? '' : 'ACP did not advertise HTTP MCP; Mingle browser, team and progress tools use stdio instead. '}${authNote}`;
    return { ...antigravityInfo(found.executable.path, runtime.version, cached?.models ?? [ANTIGRAVITY_DEFAULT], true, note), promptCapabilities: acpPromptCapabilities(runtime.capabilities) };
  } catch (error) {
    return antigravityInfo(found.executable.path, null, [ANTIGRAVITY_DEFAULT], false, `Antigravity ACP could not initialize: ${truncate(redactSecrets(errorMessage(error)), 350)}`);
  } finally {
    if (runtime) await closeAntigravity(runtime);
  }
}

function skippedNote(executable: ResolvedExecutable, label: string): string | null {
  if (executable.skipped.length === 0) return null;
  const skipped = executable.skipped.map((entry) => `${entry.path} (${entry.reason})`).join('; ');
  return `Using ${executable.path}; skipped ${skipped}.`.replace(/^/, `${label}: `);
}

// ---- Claude ----------------------------------------------------------------------------------------------------

export async function detectClaude(settings: AppSettings, deps: DetectDeps = {}): Promise<ProviderInfo> {
  const env = deps.env ?? process.env;
  const baselinePolicies = CLAUDE_POLICIES.filter((policy) => policy !== 'auto');
  const base: ProviderInfo = { id: 'claude', name: 'Claude', available: false, version: null, executable: null, reason: null,
    // These describe the official SDK input transport. Model-specific input modalities are not reported by ModelInfo.
    promptCapabilities: { image: true, embeddedContext: true },
    models: CLAUDE_MODELS.map((model) => ({ ...model, policies: baselinePolicies })), policies: baselinePolicies };
  const withModels = async (info: ProviderInfo): Promise<ProviderInfo> => {
    // Injected probes own their entire environment; never escape them by launching a real SDK process.
    if (deps.probe || deps.spawn || deps.env || deps.home) return info;
    try {
      const models = await probeClaudeModels(settings);
      return models.length ? { ...info, models } : { ...info, reason: `${info.reason ?? ''} Model capabilities were not reported; showing baseline controls.`.trim() };
    } catch (error) {
      return { ...info, reason: `${info.reason ?? ''} Model capabilities unavailable: ${truncate(redactSecrets(errorMessage(error)), 250)}`.trim() };
    }
  };
  const resolved = await resolveExecutable({ name: 'claude', override: settings.claudeExecutable, env, home: deps.home, probe: deps.probe, extraCandidates: bundledClaudeCandidates() });
  if (!resolved.ok) return { ...base, reason: resolved.reason };
  const { executable } = resolved;
  const info = { ...base, version: executable.version, executable: executable.path };
  const note = skippedNote(executable, 'Claude');
  const childEnv = claudeEnvironment(env);
  if (childEnv.ANTHROPIC_API_KEY) {
    return withModels({ ...info, available: true, reason: ['ANTHROPIC_API_KEY is set; the key is not validated until a session runs.', note].filter(Boolean).join(' ') });
  }
  // The CLI reports local login state without inference. Never inspect its credential files or expose account details.
  let status: unknown;
  let authStatusOk = false;
  try {
    const result = await (deps.probe ?? runProbe)(executable.path, ['auth', 'status', '--json'], { timeoutMs: 6_000, env: childEnv, cwd: tmpdir() });
    if (result.timedOut || result.spawnError) {
      return { ...info, reason: 'Claude Code login check could not complete. Run `claude auth status` in the server environment, then Re-check in Settings.' };
    }
    authStatusOk = result.ok;
    status = JSON.parse(result.stdout);
  } catch {
    return { ...info, reason: 'Claude Code login status could not be read. Run `claude auth status` in the server environment, or set ANTHROPIC_API_KEY, then Re-check in Settings.' };
  }
  if (!isRecord(status) || typeof status.loggedIn !== 'boolean') {
    return { ...info, reason: 'Claude Code returned an unrecognized login status. Update Claude Code or set ANTHROPIC_API_KEY, then Re-check in Settings.' };
  }
  if (!status.loggedIn) {
    return { ...info, reason: `Claude Code ${executable.version} is installed, but no login was found. Run \`"${executable.path}" auth login\` in a terminal on this machine, or set ANTHROPIC_API_KEY in the Mingle server environment, then Re-check in Settings.` };
  }
  if (!authStatusOk) {
    return { ...info, reason: 'Claude Code login check failed. Run `claude auth status` in the server environment, then Re-check in Settings.' };
  }
  const method = status.authMethod === 'claude.ai' ? 'Claude subscription login'
    : status.authMethod === 'oauth_token' ? 'Claude Code OAuth token'
    : 'Claude Code login';
  return withModels({ ...info, available: true, reason: [`${method} detected; account access and quota are checked when a session runs.`, note].filter(Boolean).join(' ') });
}

// ---- Codex -----------------------------------------------------------------------------------------------------

interface CodexProbe {
  account: 'none' | 'present' | 'unknown';
  accountType: string | null;
  models: ProviderModel[] | null;
  error: string | null;
}

/** Starts a short-lived app-server and asks only for local state (account/read, model/list); no inference is requested. */
export async function probeCodexAppServer(executable: string, deps: DetectDeps = {}): Promise<CodexProbe> {
  const env = cleanEnv(deps.env ?? process.env, ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']);
  const timeoutMs = deps.codexProbeTimeoutMs ?? 20_000;
  const stderr = new TextTail();
  const result: CodexProbe = { account: 'unknown', accountType: null, models: null, error: null };
  const spawnFn = deps.spawn ?? ((file, args, options) => spawn(file, args, options) as unknown as ChildLike);
  let child: ChildLike;
  try {
    child = spawnFn(executable, ['app-server'], { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  } catch (error) {
    return { ...result, error: errorMessage(error) };
  }
  child.stderr?.on('data', (chunk: string | Buffer) => stderr.push(chunk.toString()));
  const conn = new JsonRpcConnection(child, {
    onNotification: () => undefined,
    onRequest: async (method) => { throw new RpcError(-32601, `Mingle probe does not support ${method}`); },
    formatClose: (info) => `app-server ${info.error ? `could not start (${info.error.message})` : `exited with ${info.signal ?? `code ${info.exitCode}`}`}${stderr.isEmpty ? '' : `: ${stderr.summary(300)}`}`,
  });
  const deadline = Date.now() + timeoutMs;
  const left = (): number => Math.max(1_000, deadline - Date.now());
  try {
    await conn.request('initialize', { clientInfo: { ...CODEX_CLIENT_INFO }, capabilities: { experimentalApi: false } }, left());
    conn.notify('initialized', {});
    try {
      const account = await conn.request('account/read', { refreshToken: false }, left());
      if (isRecord(account)) {
        if (isRecord(account.account)) {
          result.account = 'present';
          result.accountType = typeof account.account.type === 'string' ? account.account.type : null;
        } else {
          result.account = account.requiresOpenaiAuth === false ? 'present' : 'none';
        }
      }
    } catch (error) {
      result.error = `account/read failed: ${errorMessage(error)}`;
    }
    try {
      const models: ProviderModel[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const response: unknown = await conn.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, left());
        if (!isRecord(response) || !Array.isArray(response.data)) break;
        for (const entry of response.data) {
          if (!isRecord(entry) || entry.hidden === true) continue;
          const model = parseCodexModel(entry);
          if (model) models.push(model);
        }
        cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
        if (!cursor) break;
      }
      result.models = models;
    } catch (error) {
      result.error = [result.error, `model/list failed: ${errorMessage(error)}`].filter(Boolean).join('; ');
    }
  } catch (error) {
    result.error = errorMessage(error);
  } finally {
    await shutdownChild(child, { closed: conn.closed, group: process.platform !== 'win32', graceMs: 1_000, termMs: 2_000, killMs: 1_000 });
    await settlesWithin(conn.closed, 100);
  }
  return result;
}

export async function detectCodex(settings: AppSettings, deps: DetectDeps = {}): Promise<ProviderInfo> {
  const env = deps.env ?? process.env;
  const base: ProviderInfo = { id: 'codex', name: 'Codex', available: false, version: null, executable: null, reason: null, models: [], policies: CODEX_POLICIES };
  const resolved = await resolveExecutable({ name: 'codex', override: settings.codexExecutable, env, home: deps.home, probe: deps.probe });
  if (!resolved.ok) return { ...base, reason: resolved.reason };
  const { executable } = resolved;
  const info = { ...base, version: executable.version, executable: executable.path };
  const probe = await probeCodexAppServer(executable.path, deps);
  const models = probe.models && probe.models.length > 0 ? probe.models : [CODEX_DEFAULT_MODEL_ENTRY];
  const note = skippedNote(executable, 'Codex');
  if (probe.account === 'none') {
    return { ...info, models, reason: `Codex ${executable.version} is installed at ${executable.path} but no Codex login was found. Run \`codex login\` in a terminal, then refresh.` };
  }
  if (probe.models === null && probe.account === 'unknown') {
    return { ...info, models, reason: `Codex ${executable.version} is installed at ${executable.path}, but its app-server did not respond: ${truncate(probe.error ?? 'unknown error', 400)}` };
  }
  const authText = probe.account === 'present'
    ? `Codex account detected${probe.accountType ? ` (${probe.accountType})` : ''}; the login is not validated until a session runs.`
    : 'Could not verify whether Codex is logged in.';
  const modelText = probe.models === null ? 'Model list unavailable; showing the default model only.' : null;
  return { ...info, available: true, models, reason: [authText, modelText, probe.error && probe.models !== null ? truncate(probe.error, 300) : null, note].filter(Boolean).join(' ') };
}

// ---- Public entry ----------------------------------------------------------------------------------------------

const inFlight = new Map<string, Promise<ProviderInfo[]>>();

/** Reports real availability. Concurrent calls with identical settings share one probe. */
export function detectProviders(settings: AppSettings, deps: DetectDeps = {}): Promise<ProviderInfo[]> {
  const key = JSON.stringify([settings.claudeExecutable, settings.codexExecutable, settings.antigravityExecutable, settings.opencodeExecutable, deps.env === undefined ? 'process' : 'custom']);
  const pending = inFlight.get(key);
  if (pending && !deps.probe && !deps.spawn) return pending;
  const run = Promise.all([detectCodex(settings, deps), detectClaude(settings, deps), detectAntigravity(settings, deps), detectOpencode(settings, deps)]).then(([codex, claude, antigravity, opencode]) => {
    // Google catalog refresh can finish while another provider is still probing.
    // Publish that refreshed catalog instead of an earlier generic default.
    if (antigravity.available && antigravity.executable) {
      const env = deps.env ?? process.env;
      const latest = cachedAntigravityMetadata(antigravity.executable, env);
      if (latest?.version === antigravity.version) antigravity = { ...antigravity, models: latest.models,
        reason: isAntigravityAuthenticated(antigravity.executable, env) ? antigravity.reason?.replace(ANTIGRAVITY_AUTH_UNVERIFIED, ANTIGRAVITY_AUTH_CHECKED) ?? null : antigravity.reason };
    }
    return [codex, claude, antigravity, opencode];
  });
  if (!deps.probe && !deps.spawn) {
    inFlight.set(key, run);
    void run.finally(() => inFlight.delete(key)).catch(() => undefined);
  }
  return run;
}

export { CLAUDE_DEFAULT_MODEL };
