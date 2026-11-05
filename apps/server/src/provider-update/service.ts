import { spawn as nodeSpawn } from 'node:child_process';
import path, { basename, join, resolve } from 'node:path';
import { realpath, stat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
const PINNED_RUNTIME_MESSAGE = 'Antigravity is managed by Mingle at a checksum-pinned ACP version. Update Mingle to change that approved runtime.';
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
  managedRoot?: string;
  installManagedPackage?: (target: string, packageSpec: string) => Promise<void>;
}

function empty(provider: Provider, diagnostic?: ProviderInfo): ProviderUpdateInfo {
  const installedVersion = diagnostic?.version ?? null;
  return { provider, installedVersion, latestVersion: null, source: null, checkedAt: null, status: 'unknown', channel: 'unknown', method: 'unsupported',
    message: provider === 'antigravity' ? PINNED_RUNTIME_MESSAGE : diagnostic?.executable ? 'A verified public version source or safe update method is unavailable for this installation.' : 'Provider CLI is not detected.' };
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

function packageExecutable(provider: Provider): string | null {
  return provider === 'claude' ? 'claude' : provider === 'codex' ? 'codex' : provider === 'opencode' ? 'opencode' : null;
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
  private readonly managedRoot: string;
  private readonly installManagedPackage: NonNullable<ProviderUpdateServiceOptions['installManagedPackage']>;
  private readonly inflight = new Map<Provider, Promise<ProviderUpdateInfo>>();
  private readonly updating = new Map<Provider, ProviderUpdateInfo>();
  private readonly applying = new Set<Provider>();
  constructor(private readonly store: Store, private readonly providers: ProviderService, private readonly runtime: SessionRuntime,
    options: ProviderUpdateServiceOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.spawn = options.spawn ?? nodeSpawn;
    this.now = options.now ?? Date.now;
    this.managedRoot = resolve(options.managedRoot ?? join(homedir(), '.mingle', 'provider-clis'));
    this.installManagedPackage = options.installManagedPackage ?? (async (target, packageSpec) => {
      const npmCli = await this.npmCli();
      const userConfig = join(target, '.npm-userconfig');
      const globalConfig = join(target, '.npm-globalconfig');
      // npm rejects loading one file in multiple config layers. Keep all three private and distinct.
      await Promise.all([userConfig, globalConfig, join(target, '.npmrc')].map((file) => writeFile(file, '', { mode: 0o600, flag: 'wx' })));
      await this.runFixed(process.execPath, [npmCli, 'install', '--prefix', target, '--userconfig', userConfig, '--globalconfig', globalConfig, '--no-save', '--no-audit', '--no-fund', '--registry', 'https://registry.npmjs.org', packageSpec], target);
    });
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
        return this.cachedRow(persisted, diagnostic);
      }
      return persisted ? this.cachedRow(persisted, diagnostic) : empty(provider, diagnostic);
    }));
    return { providers: rows.map((row) => ({ ...row, dismissed: Boolean(row.latestVersion && this.isDismissed(row.provider, row.latestVersion)) })) };
  }

  private cachedRow(persisted: ProviderUpdateInfo, diagnostic?: ProviderInfo): ProviderUpdateInfo {
    const row = { ...this.recompare(persisted, diagnostic), installedVersion: diagnostic?.version ?? null };
    const sameInstall = persisted.installedVersion === diagnostic?.version && persisted.checkedExecutable === diagnostic?.executable;
    const configured = providerExecutable(persisted.provider, this.store.getSettings());
    if (sameInstall && persisted.method === 'native' && methodFor(persisted.provider, diagnostic?.executable ?? null, diagnostic?.version ?? null, configured) === 'native') return { ...row, method: 'native' };
    const lineage = this.managedLineage(diagnostic);
    if (lineage.managedExecutable) return { ...row, ...lineage, method: process.platform === 'win32' ? 'unsupported' : 'managed',
      installationDescription: this.installationDescription(persisted.provider) };
    const managed = Boolean(process.platform !== 'win32' && NPM_SOURCES[persisted.provider] && diagnostic?.version && diagnostic.executable
      && !diagnostic.version.includes('-') && !diagnostic.version.includes('+'));
    const withoutStaleLineage = { ...row };
    delete withoutStaleLineage.managedExecutable;
    delete withoutStaleLineage.previousExecutable;
    return { ...withoutStaleLineage, method: managed ? 'managed' : 'unsupported', ...(managed ? { installationDescription: this.installationDescription(persisted.provider) } : {}) };
  }

  private recompare(info: ProviderUpdateInfo, diagnostic?: ProviderInfo): ProviderUpdateInfo {
    // A pinned runtime has no public CLI release comparison, even when diagnostics have no version.
    if (info.provider === 'antigravity') return { ...empty(info.provider, diagnostic), checkedAt: info.checkedAt };
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
    if (!force && previous?.status !== 'error' && previous?.checkedAt && previous.installedVersion === diagnostic.version
      && (!NPM_SOURCES[provider] || previous.checkedExecutable === diagnostic.executable) && this.now() - Date.parse(previous.checkedAt) < CACHE_MS) return { ...this.recompare(previous, diagnostic), installedVersion: diagnostic.version };
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

  /** Restoration belongs to the saved selection, even if discovery or public metadata is unavailable. */
  private managedLineage(diagnostic?: ProviderInfo): Pick<ProviderUpdateInfo, 'managedExecutable' | 'previousExecutable'> {
    if (!diagnostic) return {};
    const prior = (this.store.getProviderUpdateChecks() as Record<string, ProviderUpdateInfo>)[diagnostic.id];
    const configured = providerExecutable(diagnostic.id, this.store.getSettings());
    if (!prior?.managedExecutable || prior.previousExecutable === undefined || !configured
      || resolve(configured) !== resolve(prior.managedExecutable)) return {};
    return { managedExecutable: prior.managedExecutable, previousExecutable: prior.previousExecutable };
  }

  private async fetchLatest(diagnostic: ProviderInfo): Promise<ProviderUpdateInfo> {
    const provider = diagnostic.id;
    const lineage = this.managedLineage(diagnostic);
    const base = { ...empty(provider, diagnostic), ...lineage };
    const registry = NPM_SOURCES[provider];
    if (!registry) return { ...base, checkedAt: new Date(this.now()).toISOString() };
    if (!diagnostic.version) return { ...base, checkedAt: new Date(this.now()).toISOString(), source: registry.label, message: 'Installed CLI version is unknown; no update comparison was made.' };
    const timeout = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), this.lifecycle.signal]);
    try {
      const response = await this.fetcher(`https://registry.npmjs.org/${encodeURIComponent(registry.package)}/latest`, { headers: { accept: 'application/json' }, signal: timeout });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Public version source returned HTTP ${response.status}.`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Public version response had no body.');
      const chunks: Uint8Array[] = []; let total = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > MAX_BODY) { await reader.cancel(); throw new Error('Public version response exceeded the size limit.'); } chunks.push(value); }
      const data = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as { version?: unknown };
      const latest = typeof data.version === 'string' && /^\d+\.\d+\.\d+$/.test(data.version) ? data.version : null;
      if (!latest) throw new Error('Public metadata did not contain a stable release version.');
      const comparison = compareVersions(diagnostic.version, latest);
      const candidate = methodFor(provider, diagnostic.executable, diagnostic.version, providerExecutable(provider, this.store.getSettings()));
      const stableInstalled = !diagnostic.version.includes('-') && !diagnostic.version.includes('+');
      const method = !stableInstalled || !diagnostic.executable ? 'unsupported' : candidate === 'native' && diagnostic.executable && await this.inspectInstall(provider, diagnostic.executable).catch(() => false) ? 'native' : process.platform === 'win32' ? 'unsupported' : 'managed';
      return { provider, installedVersion: diagnostic.version, checkedExecutable: diagnostic.executable, instructions: this.instructions(provider), latestVersion: latest, source: registry.label, checkedAt: new Date(this.now()).toISOString(),
        status: comparison === null ? 'unknown' : comparison < 0 ? 'available' : comparison === 0 ? 'current' : 'unknown', channel: 'stable', method,
        ...lineage,
        ...(method === 'managed' ? { installationDescription: this.installationDescription(provider) } : {}),
        message: (comparison === null ? 'Versions could not be compared reliably.' : comparison > 0 ? 'Installed version is newer than the public stable tag; channel status is unknown.' : comparison < 0 ? 'A newer stable version is available.' : 'Installed version matches the public stable version.') };
    } catch (error) {
      return { ...base, checkedAt: new Date(this.now()).toISOString(), source: registry.label, status: 'error', message: `Could not check public version metadata: ${redactSecrets(errorMessage(error)).slice(0, 300)}` };
    }
  }

  private installationDescription(provider: Provider): string {
    const pkg = NPM_SOURCES[provider]?.package;
    return pkg ? `Install ${pkg} at the checked version in Mingle's user-local versioned directory; this leaves the existing installation in place.` : '';
  }

  private async npmCli(): Promise<string> {
    const candidates: string[] = [];
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!directory) continue;
      const npm = join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
      try {
        const canonical = await realpath(npm);
        if (canonical.endsWith(`${path.sep}npm-cli.js`)) candidates.push(canonical);
        const base = path.dirname(canonical);
        candidates.push(join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
        candidates.push(join(base, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
        candidates.push(join(base, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
        candidates.push(join(base, '..', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js'));
      } catch { /* keep searching PATH */ }
    }
    for (const candidate of candidates) {
      try { const info = await stat(candidate); if (info.isFile()) return await realpath(candidate); } catch { /* try next */ }
    }
    throw new Error('A usable Node npm-cli.js was not found on PATH.');
  }

  private async managedExecutable(provider: Provider, version: string): Promise<string> {
    const command = packageExecutable(provider);
    const pkg = NPM_SOURCES[provider]?.package;
    if (!command || !pkg || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('No verified managed package is available.');
    const target = resolve(this.managedRoot, provider, version);
    await mkdir(this.managedRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(this.managedRoot);
    const rootInfo = await stat(root);
    if (!rootInfo.isDirectory() || (process.getuid && rootInfo.uid !== process.getuid()) || (rootInfo.mode & 0o022) !== 0) {
      throw new Error('Managed install root must be an OS-user-owned directory that other users cannot modify.');
    }
    if (!withinNativeInstallRoot(root, target)) throw new Error('Managed install path escapes its private root.');
    try {
      const existing = await realpath(target);
      if (!withinNativeInstallRoot(root, existing)) throw new Error('Existing managed install path escapes its private root.');
      const executable = join(existing, 'node_modules', '.bin', command);
      if (await this.validateManaged(provider, version, executable, root)) return executable;
      throw new Error('The existing versioned managed install failed validation; it was left untouched.');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error && error.code === 'ENOENT')) throw error;
    }
    await mkdir(join(root, provider), { recursive: true, mode: 0o700 });
    const providerRoot = await realpath(join(root, provider));
    if (!withinNativeInstallRoot(root, providerRoot)) throw new Error('Managed provider directory escapes its private root.');
    const providerInfo = await stat(providerRoot);
    if (!providerInfo.isDirectory() || (process.getuid && providerInfo.uid !== process.getuid()) || (providerInfo.mode & 0o022) !== 0) {
      throw new Error('Managed provider directory must be owned by the current OS user.');
    }
    const stage = join(providerRoot, `.${version}.${randomUUID()}.staging`);
    await mkdir(stage, { recursive: false, mode: 0o700 });
    try {
      await this.installManagedPackage(stage, `${pkg}@${version}`);
      const executable = join(stage, 'node_modules', '.bin', command);
      if (!await this.validateManaged(provider, version, executable, root)) throw new Error('The installed CLI did not report the exact checked version or escaped the managed directory.');
      if (this.closed) throw new Error('Mingle is shutting down; the staged install was discarded.');
      try { await realpath(target); throw new Error('A managed version directory appeared during installation; the staged install was discarded.'); }
      catch (error) { if (!(error instanceof Error) || !('code' in error && error.code === 'ENOENT')) throw error; }
      await rename(stage, target);
      return join(target, 'node_modules', '.bin', command);
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private async validateManaged(provider: Provider, version: string, executable: string, root: string): Promise<boolean> {
    try {
      const canonicalRoot = await realpath(root);
      const canonicalExecutable = await realpath(executable);
      if (!withinNativeInstallRoot(canonicalRoot, canonicalExecutable)) return false;
      const info = await stat(canonicalExecutable);
      if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) return false;
      const output = await this.runFixed(executable, ['--version']);
      return output.split(/[^A-Za-z0-9.+-]+/).some((token) => token.replace(/^v/i, '') === version);
    } catch { return false; }
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
    if (this.applying.has(provider)) return Promise.reject(conflict('A provider update is already in progress.'));
    this.applying.add(provider);
    const job = this.performUpdate(provider, expectedVersion);
    this.jobs.add(job); void job.finally(() => { this.jobs.delete(job); this.applying.delete(provider); }).catch(() => {}); return job;
  }

  dismiss(provider: Provider, version: string): void { this.store.dismissProviderUpdate(provider, version); this.changed(); }
  isDismissed(provider: Provider, version: string): boolean { return this.store.providerUpdateDismissed(provider, version); }

  private async performUpdate(provider: Provider, expectedVersion: string | null): Promise<ProviderUpdateInfo> {
    const latest = (await this.checkOne(provider, true));
    const diagnostic = (await this.providers.refresh()).find((row) => row.id === provider);
    if (!diagnostic?.executable || !diagnostic.version || diagnostic.version !== expectedVersion) throw new Error('Provider executable or installed version changed. Refresh provider diagnostics and retry.');
    if (diagnostic.executable !== latest.checkedExecutable) throw new Error('Provider installation changed. Check again before updating.');
    if (latest.status !== 'available' || !latest.latestVersion || !['native', 'managed'].includes(latest.method)) throw new Error(latest.message || 'This installation cannot be updated safely from Mingle.');
    const configuredPreference = providerExecutable(provider, this.store.getSettings());
    const configured = resolve(configuredPreference || diagnostic.executable);
    if (resolve(diagnostic.executable) !== configured) throw new Error('The configured executable changed since the update check. Refresh diagnostics and retry.');
    const release = this.runtime.reserveProviderMaintenance(provider);
    if (!release) throw conflict('Provider is busy. Wait for its active turn or cleanup to finish.');
    const args = provider === 'claude' || provider === 'codex' ? ['update'] : provider === 'opencode' ? ['upgrade'] : null;
    if (latest.method === 'native' && !args) { release(); throw new Error('No supported update command is available for this provider.'); }
    let state: ProviderUpdateInfo = { ...latest, status: 'updating', message: 'Updating the provider CLI.', progress: latest.method === 'managed' ? 'Preparing a private versioned installation…' : 'Starting approved provider update command…' };
    this.updating.set(provider, state); this.changed();
    try {
      if (this.closed) throw new Error('Mingle is shutting down.');
      if (latest.method === 'native' && !await this.inspectInstall(provider, diagnostic.executable)) throw new Error(this.instructions(provider));
      if (latest.method === 'native' && provider === 'codex') {
        const help = await this.runFixed(diagnostic.executable, ['--help']);
        if (!/^\s*update(?:\s|$)/m.test(help)) throw new Error('This Codex CLI does not advertise native update support. ' + this.instructions(provider));
      }
      if (providerExecutable(provider, this.store.getSettings()) !== configuredPreference) throw new Error('The configured provider changed during the update check.');
      let managed: string | null = null;
      if (latest.method === 'managed') managed = await this.managedExecutable(provider, latest.latestVersion!);
      else await this.runFixed(diagnostic.executable, args!);
      const refreshed = await this.providers.refresh();
      const after = refreshed.find((row) => row.id === provider);
      if (latest.method === 'managed') {
        if (!managed || !await this.validateManaged(provider, latest.latestVersion!, managed, this.managedRoot)) throw new Error('Managed CLI validation failed; the existing provider preference is unchanged.');
        if (this.closed) throw new Error('Mingle is shutting down; the existing provider preference is unchanged.');
        if (providerExecutable(provider, this.store.getSettings()) !== configuredPreference) throw new Error('The configured provider changed during installation.');
        const executableKey = provider === 'claude' ? 'claudeExecutable' : provider === 'codex' ? 'codexExecutable' : 'opencodeExecutable';
        const preference = configuredPreference || '';
        const previousExecutable = typeof latest.previousExecutable === 'string' ? latest.previousExecutable : preference;
        state = { ...latest, status: 'updated', installedVersion: latest.latestVersion, managedExecutable: managed, previousExecutable,
          message: `Installed ${provider} ${latest.latestVersion} in Mingle's managed directory and selected it.` };
        this.store.tx(() => {
          this.store.updateSettings({ [executableKey]: managed } as never);
          this.store.saveProviderUpdateCheck(provider, { ...state, checkedAt: new Date(this.now()).toISOString() });
        });
        this.providers.invalidate();
        return state;
      } else if (!after || resolve(after.executable ?? '') !== configured || !after.version || compareVersions(after.version, diagnostic.version) !== 1) {
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

  private runFixed(executable: string, args: string[], cwd?: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Mingle is shutting down.'));
    return new Promise((resolvePromise, reject) => {
      const child = this.spawn(executable, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', USERPROFILE: process.env.USERPROFILE ?? '', TMP: process.env.TMP ?? '', TEMP: process.env.TEMP ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
