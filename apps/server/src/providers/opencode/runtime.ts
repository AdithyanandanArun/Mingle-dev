import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppSettings } from '@mingle/contracts';
import { ProviderError, TextTail, abortError, cleanEnv, errorMessage, isRecord, redactSecrets, truncate } from '../common.js';
import { resolveExecutableCached, type ExecutableSource, type ResolvedExecutable } from '../discovery.js';
import { runProbe, shutdownChild, type ChildLike } from '../process.js';
import { OpencodeConnection, type AcpCloseInfo } from './rpc.js';

export type OpencodeSpawn = (file: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildLike;
export const OPENCODE_CLIENT_INFO = { name: 'mingle', title: 'Mingle', version: '0.0.1' } as const;
const SESSION_TIMEOUT = 60_000;
/** Native OpenCode session identifiers; used for metadata sessions, adapter sessions and the argv of `session delete`. */
export const SESSION_ID = /^ses_[A-Za-z0-9]{8,64}$/;

/** `opencode` installs under ~/.opencode/bin with its own install script; PATH, ~/.local/bin and ~/.npm-global/bin are searched too. */
export function opencodeCandidates(home = homedir()): { path: string; source: ExecutableSource }[] {
  return [{ path: join(home, '.opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'), source: 'home-local' }];
}

export type OpencodeResolution = { ok: true; executable: ResolvedExecutable } | { ok: false; reason: string };
export async function resolveOpencode(settings: AppSettings, env: NodeJS.ProcessEnv = process.env, home?: string): Promise<OpencodeResolution> {
  const result = await resolveExecutableCached({ name: 'opencode', override: settings.opencodeExecutable ?? '', env, home, extraCandidates: opencodeCandidates(home) });
  return result.ok ? { ok: true, executable: result.executable } : { ok: false, reason: result.reason };
}

/** Values of credential-shaped environment variables, so child output and errors can be scrubbed literally. */
export function environmentSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([key, value]) => /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) && value && value.length >= 8 ? [value] : []);
}

/**
 * Child environment. The auto-update check is disabled so a Mingle run never replaces the executable, and the loopback HTTP server
 * that `opencode acp` starts gets a random password so no other local process can drive the conversation. Both stay out of argv.
 */
export function opencodeEnvironment(base: NodeJS.ProcessEnv, permission?: Record<string, unknown>): Record<string, string> {
  return cleanEnv(base, ['OPENCODE_PERMISSION', 'MINGLE_TEAM_MCP_TOKEN', 'MINGLE_BROWSER_MCP_TOKEN', 'RELAY_TEAM_MCP_TOKEN', 'RELAY_BROWSER_MCP_TOKEN'], {
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_SERVER_PASSWORD: randomBytes(24).toString('hex'),
    ...(permission ? { OPENCODE_PERMISSION: JSON.stringify(permission) } : {}),
  });
}

export interface OpencodeRuntime {
  child: ChildLike;
  conn: OpencodeConnection;
  version: string;
  capabilities: Record<string, unknown>;
  stderr: TextTail;
  secrets: string[];
  /** Ephemeral authenticated loopback listener for native OpenCode APIs used by this child only. */
  serverPort?: number;
  serverUsername?: string;
  serverPassword?: string;
}
export interface StartOptions {
  env: Record<string, string>;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  spawn?: OpencodeSpawn;
  secrets?: readonly (string | undefined)[];
  /** Kill the child as soon as the signal aborts, for the whole life of the runtime. Otherwise the signal covers startup only. */
  killOnAbort?: boolean;
  notification?: (method: string, params: unknown) => void;
  request?: (method: string, params: unknown) => Promise<unknown>;
}

const live = new Set<OpencodeRuntime>();
const closing = new WeakMap<OpencodeRuntime, Promise<void>>();
const probes = new Set<{ controller: AbortController; settled: Promise<void> }>();
let shuttingDown = false;

export function safeOpencodeText(text: string, secrets: readonly (string | undefined)[] = []): string {
  return redactSecrets(text, secrets);
}
export function safeOpencodeError(error: unknown, secrets: readonly (string | undefined)[] = [], max = 600): string {
  return truncate(safeOpencodeText(errorMessage(error), secrets), max);
}

/** An unused loopback port, so each child binds its own listener instead of probing OpenCode's shared default. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('No loopback port was available.'))));
    });
  });
}

/**
 * Starts `opencode acp` in a process group and completes ACP initialization. No session is created.
 * The child's HTTP listener is pinned to loopback, an ephemeral port and no mDNS, so a user's own OpenCode server settings
 * cannot expose it or collide with parallel agents; its random password is supplied through the environment.
 */
export async function startOpencode(executable: string, options: StartOptions): Promise<OpencodeRuntime> {
  if (shuttingDown) throw new ProviderError('The OpenCode runtime is shutting down.', { code: 'aborted' });
  if (options.signal?.aborted) throw new ProviderError('OpenCode start was interrupted.', { code: 'aborted' });
  const secrets = [...(options.secrets ?? []), ...environmentSecrets(options.env)].filter((value): value is string => Boolean(value));
  const stderr = new TextTail();
  const spawnFn: OpencodeSpawn = options.spawn ?? ((file, args, spawnOptions) => spawn(file, args, spawnOptions) as unknown as ChildLike);
  let child: ChildLike;
  let port: number;
  let childEnv: Record<string, string>;
  try {
    port = await freeLoopbackPort();
    if (options.signal?.aborted || shuttingDown) throw abortError();
    childEnv = { ...options.env };
    child = spawnFn(executable, ['acp', '--hostname', '127.0.0.1', '--port', String(port), '--no-mdns'], { cwd: options.cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  } catch (error) {
    throw new ProviderError(`OpenCode could not be started: ${safeOpencodeError(error, secrets)}`, { code: 'spawn_failed', cause: error });
  }
  child.stderr?.on('data', (chunk: string | Buffer) => stderr.push(chunk.toString()));
  const conn = new OpencodeConnection(child, {
    notification: (method, params) => options.notification?.(method, params),
    request: (method, params) => options.request ? options.request(method, params) : Promise.reject(new ProviderError(`Mingle does not provide ACP client method ${method}.`)),
    closeMessage: (info: AcpCloseInfo) => `OpenCode ACP ${info.error ? `could not run (${safeOpencodeError(info.error, secrets, 200)})` : `exited with ${info.signal ?? `code ${info.exitCode}`}`}${stderr.isEmpty ? '' : `: ${stderr.summary(500, secrets)}`}`,
  });
  const runtime: OpencodeRuntime = {
    child, conn, version: '', capabilities: {}, stderr, secrets, serverPort: port,
    serverUsername: childEnv.OPENCODE_SERVER_USERNAME ?? 'opencode', serverPassword: childEnv.OPENCODE_SERVER_PASSWORD,
  };
  live.add(runtime);
  const onAbort = (): void => { void closeOpencode(runtime).catch(() => undefined); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  if (options.killOnAbort) void conn.closed.then(() => options.signal?.removeEventListener('abort', onAbort));
  try {
    const response = await conn.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: OPENCODE_CLIENT_INFO,
    }, options.timeoutMs ?? 15_000);
    if (!isRecord(response) || typeof response.protocolVersion !== 'number') throw new ProviderError('OpenCode returned an unrecognized ACP initialization response.', { code: 'protocol_error' });
    if (response.protocolVersion !== 1) throw new ProviderError(`OpenCode negotiated unsupported ACP protocol version ${response.protocolVersion}.`, { code: 'protocol_error' });
    if (!isRecord(response.agentInfo) || typeof response.agentInfo.name !== 'string' || response.agentInfo.name.toLowerCase() !== 'opencode') {
      throw new ProviderError('The selected executable did not identify itself as OpenCode over ACP. Check the OpenCode executable path in Settings.', { code: 'protocol_error' });
    }
    runtime.capabilities = isRecord(response.agentCapabilities) ? response.agentCapabilities : {};
    runtime.version = isRecord(response.agentInfo) && typeof response.agentInfo.version === 'string' ? truncate(response.agentInfo.version, 60) : '';
    return runtime;
  } catch (error) {
    await closeOpencode(runtime).catch(() => undefined);
    options.signal?.removeEventListener('abort', onAbort);
    throw error;
  } finally {
    if (!options.killOnAbort) options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Explicit native OpenCode conversation summarization through the authenticated loopback server. */
export async function summarizeOpencodeSession(runtime: OpencodeRuntime, input: {
  sessionId: string; providerID: string; modelID: string; signal: AbortSignal; timeoutMs?: number;
}): Promise<void> {
  if (!runtime.serverPort || !runtime.serverPassword || !SESSION_ID.test(input.sessionId)) {
    throw new ProviderError('OpenCode native session summarization is unavailable for this runtime.', { code: 'compaction_unsupported' });
  }
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs ?? 10 * 60_000)]);
  const auth = Buffer.from(`${runtime.serverUsername ?? 'opencode'}:${runtime.serverPassword}`).toString('base64');
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${runtime.serverPort}/session/${encodeURIComponent(input.sessionId)}/summarize`, {
      method: 'POST', signal, headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerID: input.providerID, modelID: input.modelID }),
    });
  } catch (error) {
    if (input.signal.aborted) throw abortError('OpenCode compaction was interrupted');
    throw new ProviderError(`OpenCode native summarization could not be reached: ${safeOpencodeError(error, [runtime.serverPassword])}`, { code: 'compaction_transport_failed', cause: error });
  }
  if (response.status === 404 || response.status === 405) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderError('This OpenCode runtime does not expose native session summarization.', { code: 'compaction_unsupported', statusCode: response.status });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const safe = safeOpencodeText(detail, [runtime.serverPassword]);
    throw new ProviderError(`OpenCode native summarization failed (HTTP ${response.status})${safe ? `: ${truncate(safe, 500)}` : '.'}`, {
      code: 'compaction_failed', statusCode: response.status, cause: detail,
    });
  }
  let result: unknown;
  try { result = await response.json(); } catch { result = undefined; }
  if (result !== true) throw new ProviderError('OpenCode did not confirm native session summarization.', { code: 'compaction_unconfirmed' });
}

/** Escalating stop for the child and its process group. Resolves only once the process has actually closed. */
export function closeOpencode(runtime: OpencodeRuntime): Promise<void> {
  const existing = closing.get(runtime);
  if (existing) return existing;
  const pending = (async () => {
    const outcome = await shutdownChild(runtime.child, { closed: runtime.conn.closed, group: process.platform !== 'win32', graceMs: 1_500, termMs: 3_000, killMs: 2_000 });
    // Keep the session lock until native closure, including an unresponsive termination.
    if (outcome === 'unresponsive') await runtime.conn.closed;
    live.delete(runtime);
  })();
  closing.set(runtime, pending);
  return pending;
}

/** Stops every live OpenCode child; used when the Mingle server shuts down. */
export async function closeAllOpencode(): Promise<void> {
  shuttingDown = true;
  const pending = [...probes];
  for (const probe of pending) probe.controller.abort();
  await Promise.allSettled([...live].map((runtime) => closeOpencode(runtime)).concat(pending.map((probe) => probe.settled)));
}

export const object = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

// ---- bounded metadata sessions ---------------------------------------------------------------------------------

export interface ProbeSession {
  runtime: OpencodeRuntime;
  sessionId: string;
  selected: Record<string, unknown>;
  /** Waits briefly for the native available_commands_update that follows session creation. */
  commands(waitMs?: number): Promise<unknown[]>;
}
export interface ProbeOptions { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number; spawn?: OpencodeSpawn; signal?: AbortSignal }

let slots = 2;
const waiting: (() => void)[] = [];
async function acquire(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  if (slots > 0) { slots -= 1; return; }
  await new Promise<void>((resolve, reject) => {
    const ready = () => { signal.removeEventListener('abort', aborted); resolve(); };
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      const index = waiting.indexOf(ready);
      if (index >= 0) waiting.splice(index, 1);
      reject(abortError());
    };
    waiting.push(ready);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
function release(): void {
  const next = waiting.shift();
  if (next) next(); else slots += 1;
}

/**
 * Starts OpenCode, creates one native session without sending a prompt, and always removes that session and stops the child.
 * With no `cwd` a private empty temporary directory is used so project configuration or plugins are not loaded for background metadata.
 * At most two probes run at once.
 */
export async function withProbeSession<T>(executable: string, options: ProbeOptions, work: (session: ProbeSession) => Promise<T>): Promise<T> {
  if (shuttingDown) throw new ProviderError('The OpenCode runtime is shutting down.', { code: 'aborted' });
  const baseEnv = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const left = (): number => Math.max(1, deadline - Date.now());
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref();
  let settle!: () => void;
  const job = { controller, settled: new Promise<void>((resolve) => { settle = resolve; }) };
  probes.add(job);
  let acquired = false;
  let privateDir: string | null = null;
  let commands: unknown[] | null = null;
  let announce: (() => void) | undefined;
  let runtime: OpencodeRuntime | undefined;
  let sessionId: string | null = null;
  try {
    await acquire(signal);
    acquired = true;
    if (signal.aborted || shuttingDown) throw abortError();
    privateDir = await mkdtemp(join(tmpdir(), 'relay-opencode-'));
    const cwd = options.cwd ?? privateDir;
    runtime = await startOpencode(executable, {
      env: opencodeEnvironment(baseEnv), cwd, timeoutMs: Math.min(15_000, left()), signal, killOnAbort: true, ...(options.spawn ? { spawn: options.spawn } : {}),
      notification: (method, params) => {
        const update = object(object(params).update);
        if (method === 'session/update' && update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
          commands = update.availableCommands.slice(0, 200);
          announce?.();
        }
      },
    });
    const selected = object(await runtime.conn.request('session/new', { cwd, mcpServers: [] }, Math.min(SESSION_TIMEOUT, left())));
    sessionId = typeof selected.sessionId === 'string' && SESSION_ID.test(selected.sessionId) ? selected.sessionId : null;
    if (!sessionId) throw new ProviderError('OpenCode did not return a valid native session ID.', { code: 'protocol_error' });
    const active = runtime;
    const result = await work({
      runtime: active, sessionId, selected,
      commands: async (waitMs = 1_500) => {
        if (!commands && waitMs > 0) await new Promise<void>((resolve) => { announce = resolve; setTimeout(resolve, Math.min(waitMs, left())).unref(); });
        return commands ?? [];
      },
    });
    if (signal.aborted) throw abortError();
    return result;
  } finally {
    try {
      if (runtime) await closeOpencode(runtime).catch(() => undefined);
      // Metadata sessions would otherwise accumulate in the user's OpenCode history. Only the ID created above is removed, and
      // the command runs in the private empty directory so no project configuration or plugin is discovered for it.
      if (sessionId && privateDir) {
        await runProbe(executable, ['session', 'delete', sessionId], { timeoutMs: 15_000, env: cleanEnv(baseEnv, [], { OPENCODE_DISABLE_AUTOUPDATE: '1' }), cwd: privateDir }).catch(() => undefined);
      }
      if (privateDir) await rm(privateDir, { recursive: true, force: true }).catch(() => undefined);
    } finally {
      clearTimeout(timer);
      if (acquired) release();
      probes.delete(job);
      settle();
    }
  }
}
