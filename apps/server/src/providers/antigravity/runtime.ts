import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn, type SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { AppSettings, ProviderInfo, ProviderModel, Policy } from '@mingle/contracts';
import { abortError, cleanEnv, errorMessage, isRecord, redactSecrets, TextTail, truncate } from '../common.js';
import { runProbe, settlesWithin, shutdownChild, type ChildLike } from '../process.js';
import { AcpConnection, AcpRpcError, ACP_METHOD_NOT_FOUND } from './rpc.js';
import { delegatedBrowserCommand, googleAuthorizationUrl } from './auth-browser.js';
import { antigravityLinuxLaunch } from './linux-launch.js';
import { readAntigravityMetadata, writeAntigravityMetadata } from './cache.js';

export const ANTIGRAVITY_POLICIES: Policy[] = ['supervised', 'balanced', 'full-access'];
export const ANTIGRAVITY_DEFAULT: ProviderModel = { id: 'default', name: 'Antigravity default', reasoningEfforts: [{ id: 'none', label: 'Native default' }], defaultReasoningEffort: 'none', policies: ANTIGRAVITY_POLICIES };
const REMOVE_ENV = ['MINGLE_BROWSER_MCP_TOKEN', 'MINGLE_TEAM_MCP_TOKEN', 'RELAY_BROWSER_MCP_TOKEN', 'RELAY_TEAM_MCP_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
export type AntigravitySpawn = (file: string, args: string[], options: SpawnOptions) => ChildLike;
const spawnDefault: AntigravitySpawn = (file, args, options) => spawn(file, args, options) as unknown as ChildLike;
export interface AntigravityExecutable { path: string; companion: string }
export type AntigravityResolve = { ok: true; executable: AntigravityExecutable } | { ok: false; reason: string };
function expandHome(path: string, home: string): string { return path === '~' ? home : path.startsWith('~/') || path.startsWith('~\\') ? join(home, path.slice(2)) : path; }
async function executable(path: string): Promise<boolean> { try { return (await stat(path)).isFile() && (await access(path, process.platform === 'win32' ? constants.R_OK : constants.X_OK), true); } catch { return false; } }
function names(): { acp: string; harness: string } { return process.platform === 'win32' ? { acp: 'agy_acp_server.exe', harness: 'localharness_external.exe' } : { acp: 'agy_acp_server.par', harness: 'localharness_external' }; }
async function verifyPair(path: string): Promise<AntigravityExecutable | null> {
  if (!(await executable(path))) return null;
  const companion = join(dirname(path), names().harness);
  return await executable(companion) ? { path, companion } : null;
}
export async function resolveAntigravity(settings: AppSettings, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<AntigravityResolve> {
  const override = settings.antigravityExecutable?.trim();
  const directories = (env.PATH ?? '').split(delimiter).filter((directory) => directory && isAbsolute(directory));
  if (override) {
    if (/[\x00-\x1f\x7f]/.test(override)) return { ok: false, reason: 'The configured Antigravity executable contains control characters.' };
    const expanded = expandHome(override, home);
    const candidates = /[\\/]/.test(expanded) ? [resolve(expanded)] : directories.map((directory) => join(directory, expanded));
    for (const candidate of candidates) { const pair = await verifyPair(candidate); if (pair) return { ok: true, executable: pair }; }
    return { ok: false, reason: `The configured Antigravity ACP executable or its ${names().harness} companion is missing or not executable. Reinstall the runtime or select its full path in Settings.` };
  }
  const candidates = [...directories.map((directory) => join(directory, names().acp)), join(home, '.local', 'bin', names().acp)];
  for (const candidate of [...new Set(candidates)]) { const pair = await verifyPair(candidate); if (pair) return { ok: true, executable: pair }; }
  return { ok: false, reason: `Google Antigravity ACP is not installed or configured. Use Install runtime in Settings; both ${names().acp} and ${names().harness} are required. The agy CLI alone is not this runtime.` };
}

export interface AntigravityMetadata { version: string; models: ProviderModel[]; commands: { id: string; name: string; description: string; argumentHint?: string; source: 'provider'; kind: 'prompt' }[]; choices: unknown }
const metadata = new Map<string, AntigravityMetadata>();
const authenticated = new Map<string, number>();
const keyOf = (exe: string, env: NodeJS.ProcessEnv): string => JSON.stringify([exe, process.platform, env.GEMINI_HOME ?? homedir(), env.GOOGLE_CLOUD_PROJECT ?? '', env.GOOGLE_CLOUD_LOCATION ?? '']);
function bound<T>(map: Map<string, T>): void { while (map.size > 16) map.delete(map.keys().next().value!); }
export function cachedAntigravityMetadata(exe: string, env: NodeJS.ProcessEnv = process.env): AntigravityMetadata | undefined {
  const key = keyOf(exe, env);
  const value = metadata.get(key) ?? readAntigravityMetadata(exe, key, env);
  if (value) { metadata.set(key, value); bound(metadata); }
  return value;
}
export function rememberAntigravityMetadata(exe: string, env: NodeJS.ProcessEnv, value: AntigravityMetadata): void {
  const key = keyOf(exe, env);
  metadata.set(key, value); bound(metadata);
  writeAntigravityMetadata(exe, key, env, value);
}
export function markAntigravityAuthenticated(exe: string, env: NodeJS.ProcessEnv = process.env): void { authenticated.set(keyOf(exe, env), Date.now()); bound(authenticated); }
export function isAntigravityAuthenticated(exe: string, env: NodeJS.ProcessEnv = process.env): boolean { return authenticated.has(keyOf(exe, env)); }
export function antigravityInfo(executablePath: string | null, version: string | null, models: ProviderModel[], available: boolean, reason: string | null): ProviderInfo {
  return { id: 'antigravity', name: 'Google Antigravity', available, version, executable: executablePath, reason, models, policies: ANTIGRAVITY_POLICIES };
}
export function antigravityChildEnv(env: NodeJS.ProcessEnv, companion: string): Record<string, string> { return cleanEnv(env, REMOVE_ENV, { ANTIGRAVITY_HARNESS_PATH: companion }); }
/** Native login URLs belong in Google's browser flow, never in Mingle's durable diagnostics. */
export function safeAntigravityText(text: string, secrets: readonly (string | undefined)[] = [process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY]): string {
  return redactSecrets(text, secrets).replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
    try {
      const url = new URL(raw);
      if (url.hostname === 'accounts.google.com' || /(?:^|\.)(?:antigravity\.google|antigravity\.google\.com)$/.test(url.hostname) || [...url.searchParams.keys()].some((key) => /^(?:code|state|access_token|refresh_token|id_token|client_secret|code_verifier|code_challenge)$/i.test(key))) return `${url.origin}${url.pathname}${url.search || url.hash ? '?[redacted]' : ''}`;
    } catch { /* Non-URL diagnostic text is retained after credential redaction. */ }
    return raw;
  });
}
export function safeAntigravityError(error: unknown, secrets: readonly (string | undefined)[] = [process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY]): string {
  const detail = error instanceof AcpRpcError && isRecord(error.data) && typeof error.data.message === 'string' ? `${error.message}: ${error.data.message}` : errorMessage(error);
  return truncate(safeAntigravityText(detail, secrets), 1200);
}

export interface AntigravityRuntime { child: ChildLike; conn: AcpConnection; stderr: TextTail; version: string; capabilities: Record<string, unknown>; close(): Promise<void> }
const live = new Set<() => Promise<void>>();
/** Includes metadata discovery children, which are not managed by the session run queue. */
export async function closeAllAntigravity(): Promise<void> { await Promise.allSettled([...live].map((close) => close())); }
export async function startAntigravity(path: string, companion: string, options: {
  env?: NodeJS.ProcessEnv; spawn?: AntigravitySpawn; timeoutMs?: number; cwd?: string; signal?: AbortSignal; secrets?: readonly (string | undefined)[]; keepLockOnUnresponsive?: boolean;
  notification?: (method: string, params: unknown) => void; request?: (method: string, params: unknown) => Promise<unknown>;
  onAuthorizationUrl?: (url: string) => void;
} = {}): Promise<AntigravityRuntime> {
  if (options.signal?.aborted) throw abortError();
  const env = options.env ?? process.env;
  const childEnv = antigravityChildEnv(env, companion);
  if (options.onAuthorizationUrl) childEnv.BROWSER = delegatedBrowserCommand();
  const args = process.platform === 'linux' ? ['--uid='] : [];
  const cwd = options.cwd ?? process.cwd();
  const launch = options.spawn ? { file: path, args, stop: undefined, kill: undefined }
    : await antigravityLinuxLaunch(path, args, { cwd, env: childEnv, unsetEnv: REMOVE_ENV });
  if (options.signal?.aborted) throw abortError();
  const child = (options.spawn ?? spawnDefault)(launch.file, launch.args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  const stderr = new TextTail(20_000);
  const decoder = new StringDecoder('utf8');
  let pendingLine = ''; let discardingLine = false;
  const consumeLine = (line: string) => {
    const prefix = 'Open the following link to authenticate the ACP server: ';
    const marker = line.indexOf(prefix);
    if (marker !== -1) {
      const url = googleAuthorizationUrl(line.slice(marker + prefix.length).trim());
      stderr.push('Google browser authentication requested.\n');
      if (url && !options.signal?.aborted) options.onAuthorizationUrl?.(url);
    } else stderr.push(`${safeAntigravityText(line, options.secrets)}\n`);
  };
  child.stderr?.on('data', (chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const complete = part.endsWith('\n');
      if (!discardingLine && pendingLine.length + part.length <= 16_384) pendingLine += part;
      else { pendingLine = ''; discardingLine = true; }
      if (complete) {
        if (discardingLine) stderr.push('[oversized native diagnostic omitted]\n');
        else consumeLine(pendingLine.trimEnd());
        pendingLine = ''; discardingLine = false;
      }
    }
  });
  child.stderr?.on('end', () => {
    pendingLine += decoder.end();
    if (!discardingLine && pendingLine) consumeLine(pendingLine.trimEnd());
    pendingLine = '';
  });
  const conn = new AcpConnection(child, {
    notification: (method, params) => options.notification?.(method, params),
    request: async (method, params) => { if (options.request) return options.request(method, params); throw new AcpRpcError(ACP_METHOD_NOT_FOUND, `Mingle does not provide ACP client request ${method}.`); },
    closeMessage: (info) => `Antigravity ACP ${info.error ? `could not start (${(info.error as NodeJS.ErrnoException).code ?? safeAntigravityError(info.error, options.secrets)})` : `exited (${info.signal ?? `code ${info.exitCode}`})`}${stderr.isEmpty ? '' : `: ${truncate(safeAntigravityText(stderr.summary(1200, options.secrets), options.secrets), 1200)}`}.`,
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    // The Linux compatibility service lives outside the proxy's process group. Stop its complete
    // control group before retiring the proxy so native harness descendants cannot be orphaned.
    if (launch.stop) {
      try { child.stdin?.end(); } catch { /* Already closed. */ }
      if (!await settlesWithin(conn.closed, options.signal?.aborted ? 0 : 350)) {
        await launch.stop();
        if (!await settlesWithin(conn.closed, 2500)) await launch.kill?.();
      }
    }
    // Windows does not expose POSIX process groups. Terminate the actual child tree before its parent PID disappears.
    if (process.platform === 'win32' && !options.spawn && child.pid) {
      try { child.stdin?.end(); } catch { /* Already closed. */ }
      if (!await settlesWithin(conn.closed, options.signal?.aborted ? 0 : 350)) {
        const killer = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        await runProbe(killer, ['/PID', String(child.pid), '/T', '/F'], { timeoutMs: 2000 });
      }
    }
    const outcome = await shutdownChild(child, { closed: conn.closed, group: process.platform !== 'win32', graceMs: options.signal?.aborted ? 0 : 350, termMs: 1000, killMs: 1000 });
    // A canceled service start may race the first stop request. Repeat after its proxy retires;
    // stdin is already closed, so any later native start also receives EOF rather than a prompt.
    await launch.stop?.();
    if (outcome === 'unresponsive') {
      if (options.keepLockOnUnresponsive) await conn.closed;
      else throw new Error('Antigravity ACP did not stop after process termination.');
    }
  })();
  live.add(close);
  void conn.closed.then(() => { live.delete(close); });
  const onAbort = () => { void close().catch(() => undefined); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    const init: unknown = await conn.request('initialize', { protocolVersion: 1, clientInfo: { name: 'mingle', version: '0.0.1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, options.timeoutMs ?? 12_000);
    if (options.signal?.aborted) throw abortError();
    if (!isRecord(init) || init.protocolVersion !== 1 || !isRecord(init.agentInfo) || init.agentInfo.name !== 'antigravity-acp' || typeof init.agentInfo.version !== 'string' || !isRecord(init.agentCapabilities)) throw new Error('The selected executable did not identify itself as a compatible Google Antigravity ACP runtime.');
    return { child, conn, stderr, version: init.agentInfo.version, capabilities: init.agentCapabilities, close: async () => { options.signal?.removeEventListener('abort', onAbort); await close(); } };
  } catch (error) {
    options.signal?.removeEventListener('abort', onAbort);
    await close().catch(() => undefined);
    if (options.signal?.aborted) throw abortError();
    throw error;
  }
}
export function closeAntigravity(runtime: AntigravityRuntime): Promise<void> { return runtime.close(); }
