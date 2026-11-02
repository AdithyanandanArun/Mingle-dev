import { spawn as nodeSpawn } from 'node:child_process';
import path, { basename, join, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { conflict } from '../util.ts';
import type { Provider, ProviderInfo, ProviderUpdateInfo, ProviderUpdatesSnapshot } from '@mingle/contracts';
import type { ProviderService } from '../provider-service.ts';
import type { Store } from '../store.ts';
import type { SessionRuntime } from '../runtime.ts';
import { errorMessage, redactSecrets } from '../util.ts';
import { providerExecutable } from '../provider-config.ts';

const CACHE_MS = 12 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 4_000;
const PROCESS_TIMEOUT_MS = 5 * 60_000;
const MAX_BODY = 64 * 1024;
const NPM_SOURCES: Partial<Record<Provider, { package: string; label: string }>> = {
  claude: { package: '@anthropic-ai/claude-code', label: 'npm registry (@anthropic-ai/claude-code, latest channel)' },
  codex: { package: '@openai/codex', label: 'npm registry (@openai/codex)' },
  opencode: { package: 'opencode-ai', label: 'npm registry (opencode-ai)' },
};
type FetchLike = typeof fetch;
type SpawnLike = typeof nodeSpawn;

export interface ProviderUpdateServiceOptions {
  fetch?: FetchLike;
  spawn?: SpawnLike;
  now?: () => number;
  inspectInstall?: (provider: Provider, executable: string) => Promise<boolean>;
}

function empty(provider: Provider, diagnostic?: ProviderInfo): ProviderUpdateInfo {
  const installedVersion = diagnostic?.version ?? null;
  return { provider, installedVersion, latestVersion: null, source: null, checkedAt: null, status: 'unknown', channel: 'unknown', method: 'unsupported',
    message: diagnostic?.executable ? 'A verified public version source or safe update method is unavailable for this installation.' : 'Provider CLI is not detected.' };
}
function compareVersions(a: string, b: string): number | null {
  const parse = (value: string) => value.trim().replace(/^v/i, '').split('.').map((part) => /^\d+$/.test(part) ? Number(part) : NaN);
  const left = parse(a), right = parse(b);
  if (!left.length || !right.length || [...left, ...right].some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index] ?? 0, y = right[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
function methodFor(provider: Provider, executable: string | null, version: string | null, configured: string): ProviderUpdateInfo['method'] {
  if (!executable || !version || version.includes('-') || version.includes('+')) return 'unsupported';
  if (configured.trim() || /(?:^|[\\/])(?:usr[\\/]bin|usr[\\/]local[\\/]bin|opt[\\/]homebrew|homebrew|scoop|chocolatey|winget)(?:[\\/]|$)/i.test(executable)) return 'unsupported';
  const name = basename(executable).replace(/\.exe$/i, '').toLowerCase();
  if (provider === 'claude' && name === 'claude') return 'native';
  if (provider === 'codex' && name === 'codex') return 'native';
  if (provider === 'opencode' && name === 'opencode') return 'native';
  return 'unsupported';
}

/** Uses the host platform's separators and drive rules; never accepts sibling-prefix paths. */
export function withinNativeInstallRoot(root: string, executable: string, paths: Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'> = path): boolean {
  const relative = paths.relative(root, executable);
  return relative !== '' && !paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + paths.sep);
}

/** Bounded public metadata checks and explicit fixed-argv updates. No provider auth/config files are read. */
export class ProviderUpdateService {
  private readonly fetcher: FetchLike;
  private readonly spawn: SpawnLike;
  private readonly now: () => number;
  private closed = false;
  private readonly lifecycle = new AbortController();
  private readonly children = new Set<ReturnType<SpawnLike>>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly inspectInstall: NonNullable<ProviderUpdateServiceOptions['inspectInstall']>;
  private readonly inflight = new Map<Provider, Promise<ProviderUpdateInfo>>();
  private readonly updating = new Map<Provider, ProviderUpdateInfo>();
  constructor(private readonly store: Store, private readonly providers: ProviderService, private readonly runtime: SessionRuntime,
    options: ProviderUpdateServiceOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.spawn = options.spawn ?? nodeSpawn;
    this.now = options.now ?? Date.now;
    this.inspectInstall = options.inspectInstall ?? (async (provider, executable) => {
      const canonical = await realpath(executable);
      const info = await stat(canonical);
      if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) return false;
      if (canonical.includes('node_modules') || canonical.includes('Cellar') || canonical.includes('WindowsApps')) return false;
      const roots = provider === 'opencode' ? [resolve(homedir(), '.opencode', 'bin')]
        : [resolve(homedir(), '.local', 'bin'), resolve(homedir(), '.local', 'share', provider)];
      if (!roots.some((root) => withinNativeInstallRoot(root, canonical))) return false;
      if (provider === 'codex') return /^\s*update(?:\s|$)/m.test(await this.runFixed(executable, ['--help']));
      return true;
    });
  }

  async snapshot(): Promise<ProviderUpdatesSnapshot> {
    const diagnostics = await this.providers.list();
    const cached = this.store.getProviderUpdateChecks() as Record<string, ProviderUpdateInfo>;
    const rows: ProviderUpdateInfo[] = await Promise.all((['codex', 'claude', 'antigravity', 'opencode'] as Provider[]).map(async (provider): Promise<ProviderUpdateInfo> => {
      const diagnostic = diagnostics.find((row) => row.id === provider);
      const persisted = cached[provider];
      if (this.updating.has(provider)) return this.updating.get(provider)!;
      if (this.inflight.has(provider)) return persisted
        ? { ...persisted, installedVersion: diagnostic?.version ?? null, status: 'checking', message: 'Checking public release metadata…' }
        : { ...empty(provider, diagnostic), status: 'checking', source: NPM_SOURCES[provider]?.label ?? null, message: 'Checking public release metadata…' };
      if (persisted?.checkedAt && this.now() - Date.parse(persisted.checkedAt) < CACHE_MS) {
        return { ...this.recompare(persisted, diagnostic), installedVersion: diagnostic?.version ?? null, method: persisted.installedVersion === diagnostic?.version ? persisted.method : 'unsupported' };
      }
      return persisted ? { ...this.recompare(persisted, diagnostic), installedVersion: diagnostic?.version ?? null, method: persisted.installedVersion === diagnostic?.version ? persisted.method : 'unsupported' } : empty(provider, diagnostic);
    }));
    return { providers: rows.map((row) => ({ ...row, dismissed: Boolean(row.latestVersion && this.isDismissed(row.provider, row.latestVersion)) })) };
  }

  private recompare(info: ProviderUpdateInfo, diagnostic?: ProviderInfo): ProviderUpdateInfo {
    if (!diagnostic?.version) return { ...info, status: 'unknown', method: 'unsupported', message: 'Installed CLI version is unknown; no comparison is available.' };
    if (info.status === 'error' || !info.latestVersion || (['failed', 'updated'].includes(info.status) && info.installedVersion === diagnostic.version)) return info;
    const comparison = compareVersions(diagnostic.version, info.latestVersion);
    const status = comparison === null || comparison > 0 ? 'unknown' : comparison === 0 ? 'current' : 'available';
    return { ...info, status, message: status === 'available' ? 'A newer public release is available.' : status === 'current'
      ? 'Installed version matches the checked public release.' : 'Installed version or channel cannot be compared reliably.' };
  }

  /** Starts once diagnostics exist; callers deliberately do not await this. */
  async checkAll(force = false): Promise<void> {
    if (this.closed) return;
    const diagnostics = await this.providers.list();
    if (this.closed) return;
    await Promise.all(diagnostics.map((diagnostic) => this.check(diagnostic, force)));
  }

  async checkOne(provider: Provider, force = false): Promise<ProviderUpdateInfo> {
    if (this.closed) throw conflict('Mingle is shutting down.');
    const diagnostic = (await this.providers.list()).find((row) => row.id === provider);
    if (this.closed) throw conflict('Mingle is shutting down.');
    if (!diagnostic) return empty(provider);
    return this.check(diagnostic, force);
  }

  private async check(diagnostic: ProviderInfo, force: boolean): Promise<ProviderUpdateInfo> {
    if (this.closed) return empty(diagnostic.id, diagnostic);
    const provider = diagnostic.id;
    const previous = (this.store.getProviderUpdateChecks() as Record<string, ProviderUpdateInfo>)[provider];
    if (!force && previous?.checkedAt && this.now() - Date.parse(previous.checkedAt) < CACHE_MS) return { ...this.recompare(previous, diagnostic), installedVersion: diagnostic.version };
    const pending = this.inflight.get(provider);
    if (pending) return pending;
    const operation = this.fetchLatest(diagnostic).then((result) => {
      if (this.closed) return result;
      this.store.saveProviderUpdateCheck(provider, result);
      this.changed();
      return result;
    }).finally(() => this.inflight.delete(provider));
    this.inflight.set(provider, operation);
    return operation;
  }

  private async fetchLatest(diagnostic: ProviderInfo): Promise<ProviderUpdateInfo> {
    const provider = diagnostic.id;
    const base = empty(provider, diagnostic);
    const registry = NPM_SOURCES[provider];
    if (!registry) return { ...base, checkedAt: new Date(this.now()).toISOString(), message: provider === 'claude'
      ? 'Claude Code update channel and installer are user-managed; Mingle cannot verify a public stable version safely.'
      : provider === 'antigravity' ? 'Antigravity is managed by Mingle at a pinned ACP version. Update Mingle to change that approved runtime.' : base.message };
    if (!diagnostic.version) return { ...base, checkedAt: new Date(this.now()).toISOString(), source: registry.label, message: 'Installed CLI version is unknown; no update comparison was made.' };
    const timeout = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), this.lifecycle.signal]);
    try {
      const response = await this.fetcher(`https://registry.npmjs.org/${encodeURIComponent(registry.package)}/latest`, { headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: timeout });
      if (!response.ok) throw new Error(`Public version source returned HTTP ${response.status}.`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Public version response had no body.');
      const chunks: Uint8Array[] = []; let total = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > MAX_BODY) { await reader.cancel(); throw new Error('Public version response exceeded the size limit.'); } chunks.push(value); }
      const data = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as { version?: unknown };
      const latest = typeof data.version === 'string' && /^\d+\.\d+\.\d+$/.test(data.version) ? data.version : null;
      if (!latest) throw new Error('Public metadata did not contain a stable release version.');
      const comparison = compareVersions(diagnostic.version, latest);
      const candidate = methodFor(provider, diagnostic.executable, diagnostic.version, providerExecutable(provider, this.store.getSettings()));
      const method = candidate === 'native' && diagnostic.executable && await this.inspectInstall(provider, diagnostic.executable).catch(() => false) ? 'native' : 'unsupported';
      return { provider, installedVersion: diagnostic.version, checkedExecutable: diagnostic.executable, instructions: this.instructions(provider), latestVersion: latest, source: registry.label, checkedAt: new Date(this.now()).toISOString(),
        status: comparison === null ? 'unknown' : comparison < 0 ? 'available' : comparison === 0 ? 'current' : 'unknown', channel: 'stable', method,
        message: (method === 'unsupported' ? this.instructions(provider) + ' ' : '') + (comparison === null ? 'Versions could not be compared reliably.' : comparison > 0 ? 'Installed version is newer than the public stable tag; channel status is unknown.' : comparison < 0 ? 'A newer stable version is available.' : 'Installed version matches the public stable version.') };
    } catch (error) {
      return { ...base, checkedAt: new Date(this.now()).toISOString(), source: registry.label, status: 'error', message: `Could not check public version metadata: ${redactSecrets(errorMessage(error)).slice(0, 300)}` };
    }
  }

  private changed(): void {
    if (!this.closed) this.store.recordEvent({ type: 'provider.updates.updated', summary: 'Provider update status changed', payload: {} });
  }

  private instructions(provider: Provider): string {
    if (provider === 'claude') return 'For a native Claude installation, run claude update (it follows your configured stable/latest channel); package-managed installations must use their original package manager.';
    if (provider === 'codex') return 'For a supported native installation, run codex update. For npm installations use npm install -g @openai/codex@latest; otherwise use the original package manager.';
    if (provider === 'opencode') return 'Run opencode upgrade, or update with the package manager originally used to install it.';
    return 'Update Mingle to change the approved, checksum-pinned Antigravity runtime.';
  }

  async close(): Promise<void> {
    this.closed = true; this.lifecycle.abort();
    for (const child of this.children) this.killUpdater(child);
    await Promise.allSettled([...this.inflight.values(), ...this.jobs]);
  }

  update(provider: Provider, expectedVersion: string | null): Promise<ProviderUpdateInfo> {
    if (this.closed) return Promise.reject(conflict('Mingle is shutting down.'));
    const job = this.performUpdate(provider, expectedVersion);
    this.jobs.add(job); void job.finally(() => this.jobs.delete(job)).catch(() => {}); return job;
  }

  dismiss(provider: Provider, version: string): void { this.store.dismissProviderUpdate(provider, version); this.changed(); }
  isDismissed(provider: Provider, version: string): boolean { return this.store.providerUpdateDismissed(provider, version); }

  private async performUpdate(provider: Provider, expectedVersion: string | null): Promise<ProviderUpdateInfo> {
    const latest = (await this.checkOne(provider, false));
    const diagnostic = (await this.providers.refresh()).find((row) => row.id === provider);
    if (!diagnostic?.executable || !diagnostic.version || diagnostic.version !== expectedVersion) throw new Error('Provider executable or installed version changed. Refresh provider diagnostics and retry.');
    if (diagnostic.executable !== latest.checkedExecutable || methodFor(provider, diagnostic.executable, diagnostic.version, providerExecutable(provider, this.store.getSettings())) !== 'native') throw new Error('Provider installation changed or requires its package manager. Check again before updating.');
    if (latest.status !== 'available' || !latest.latestVersion || latest.method !== 'native') throw new Error(latest.message || 'This installation cannot be updated safely from Mingle.');
    const configuredPreference = providerExecutable(provider, this.store.getSettings());
    const configured = resolve(configuredPreference || diagnostic.executable);
    if (resolve(diagnostic.executable) !== configured) throw new Error('The configured executable changed since the update check. Refresh diagnostics and retry.');
    const release = this.runtime.reserveProviderMaintenance(provider);
    if (!release) throw conflict('Provider is busy. Wait for its active turn or cleanup to finish.');
    const args = provider === 'claude' || provider === 'codex' ? ['update'] : provider === 'opencode' ? ['upgrade'] : null;
    if (!args) { release(); throw new Error('No supported update command is available for this provider.'); }
    let state: ProviderUpdateInfo = { ...latest, status: 'updating', message: 'Updating the configured provider CLI.', progress: 'Starting approved provider update command…' };
    this.updating.set(provider, state); this.changed();
    try {
      if (this.closed) throw new Error('Mingle is shutting down.');
      if (!await this.inspectInstall(provider, diagnostic.executable)) throw new Error(this.instructions(provider));
      if (provider === 'codex') {
        const help = await this.runFixed(diagnostic.executable, ['--help']);
        if (!/^\s*update(?:\s|$)/m.test(help)) throw new Error('This Codex CLI does not advertise native update support. ' + this.instructions(provider));
      }
      if (providerExecutable(provider, this.store.getSettings()) !== configuredPreference) throw new Error('The configured provider changed during the update check.');
      await this.runFixed(diagnostic.executable, args);
      const refreshed = await this.providers.refresh();
      const after = refreshed.find((row) => row.id === provider);
      if (!after || resolve(after.executable ?? '') !== configured || !after.version || compareVersions(after.version, diagnostic.version) !== 1) {
        state = { ...latest, status: 'failed', installedVersion: after?.version ?? null, message: 'The update command finished, but the configured executable did not report a newer version. No update is claimed.' };
      } else {
        state = { ...latest, status: 'updated', installedVersion: after.version, message: `Updated from ${diagnostic.version} to ${after.version}.` };
      }
      this.store.saveProviderUpdateCheck(provider, { ...state, checkedAt: new Date(this.now()).toISOString() });
      return state;
    } catch (error) {
      state = { ...latest, status: 'failed', message: `Update failed: ${redactSecrets(errorMessage(error)).slice(0, 300)}` };
      this.store.saveProviderUpdateCheck(provider, { ...state, checkedAt: new Date(this.now()).toISOString() });
      return state;
    } finally {
      this.updating.delete(provider); release(); this.changed();
    }
  }

  private killUpdater(child: ReturnType<SpawnLike>): void {
    try {
      if (child.pid && process.platform === 'win32') {
        const killer = this.spawn(join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { try { child.kill('SIGKILL'); } catch { /* already exited */ } });
      } else if (child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
  }

  private runFixed(executable: string, args: string[]): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Mingle is shutting down.'));
    return new Promise((resolvePromise, reject) => {
      const child = this.spawn(executable, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', USERPROFILE: process.env.USERPROFILE ?? '', TMP: process.env.TMP ?? '', TEMP: process.env.TEMP ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      this.children.add(child);
      let output = ''; let settled = false; let timeoutError: Error | undefined;
      const timer = setTimeout(() => { timeoutError = new Error('Provider update exceeded the 5 minute time limit.'); this.killUpdater(child); }, PROCESS_TIMEOUT_MS); timer.unref();
      const onData = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-4000); };
      child.stdout?.on('data', onData); child.stderr?.on('data', onData);
      const done = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); this.children.delete(child); if (error) reject(new Error(`${error.message}${output ? ` ${redactSecrets(output).slice(-500)}` : ''}`)); else resolvePromise(output); };
      child.once('error', (error) => done(error));
      child.once('close', (code) => done(timeoutError ?? (code === 0 ? undefined : new Error(`Provider updater exited with code ${code ?? 'unknown'}.${output ? ` ${redactSecrets(output).slice(-500)}` : ''}`))));
    });
  }
}
