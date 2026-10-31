import { access, constants, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { ProbeFn } from './process.js';
import { describeProbeFailure, runProbe } from './process.js';

export type ExecutableSource = 'setting' | 'path' | 'home-local' | 'npm-global' | 'opencode' | 'bun' | 'volta' | 'nvm' | 'pnpm' | 'cargo' | 'homebrew' | 'npm-prefix' | 'sdk-bundled';
export type ProviderBinary = 'claude' | 'codex' | 'opencode';

export interface SkippedExecutable { path: string; source: ExecutableSource; reason: string }
export interface ResolvedExecutable { path: string; version: string; source: ExecutableSource; skipped: SkippedExecutable[] }
export type ResolveResult =
  | { ok: true; executable: ResolvedExecutable }
  | { ok: false; reason: string; skipped: SkippedExecutable[] };

export interface ResolveOptions {
  name: ProviderBinary;
  /** AppSettings override; when non-empty it is authoritative and never silently replaced. */
  override: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  probe?: ProbeFn;
  probeTimeoutMs?: number;
  /** Extra last-resort candidates (for example the binary bundled with an SDK). */
  extraCandidates?: { path: string; source: ExecutableSource }[];
  /** Testable filesystem and npm prefix hooks. */
  fs?: { executable: (path: string) => Promise<boolean>; directories: (path: string) => Promise<string[]> };
  npmPrefix?: string;
}

const VERSION_PATTERN = /(?:^|[^0-9A-Za-z])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=$|[^0-9A-Za-z])/;

export function parseVersion(output: string): string | null {
  return VERSION_PATTERN.exec(output)?.[1] ?? null;
}

export function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2));
  return value;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Every executable named `name` along PATH, in PATH order. */
export async function findOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name];
  const found: string[] = [];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const candidate of names) {
      const full = join(dir, candidate);
      if (!found.includes(full) && (await isExecutableFile(full))) found.push(full);
    }
  }
  return found;
}

/**
 * Picks the executable used for a provider.
 * The settings override wins and is never replaced silently. Otherwise each PATH match, then
 * ~/.local/bin and ~/.npm-global/bin, is tested with `--version` and the first one that runs wins,
 * so a broken PATH shim does not hide a working install.
 */
export async function resolveExecutable(options: ResolveOptions): Promise<ResolveResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const probe = options.probe ?? runProbe;
  const timeoutMs = options.probeTimeoutMs ?? 6_000;
  const skipped: SkippedExecutable[] = [];
  const executable = options.fs?.executable ?? isExecutableFile;
  const directories = options.fs?.directories ?? (async (path: string) => {
    try { return await readdir(path); } catch { return []; }
  });

  const test = async (path: string, source: ExecutableSource): Promise<ResolvedExecutable | null> => {
    const result = await probe(path, ['--version'], { timeoutMs, env });
    const version = result.ok ? parseVersion(`${result.stdout}\n${result.stderr}`) : null;
    if (version) return { path, version, source, skipped };
    skipped.push({ path, source, reason: result.ok ? 'ran but did not print a version' : describeProbeFailure(result, timeoutMs) });
    return null;
  };

  const override = options.override.trim();
  if (override) {
    const expanded = expandHome(override, home);
    const hasSeparator = /[\\/]/.test(expanded);
    const path = hasSeparator ? resolve(expanded) : (await findOnPath(expanded, env))[0];
    if (!path) return { ok: false, reason: `Configured ${options.name} executable "${override}" was not found on PATH.`, skipped };
    if (hasSeparator && !(await executable(path))) {
      return { ok: false, reason: `Configured ${options.name} executable ${path} does not exist or is not executable.`, skipped };
    }
    const resolved = await test(path, 'setting');
    if (resolved) return { ok: true, executable: resolved };
    return { ok: false, reason: `Configured ${options.name} executable ${path} failed \`--version\`: ${skipped[0]?.reason ?? 'unknown error'}.`, skipped };
  }

  const candidates: { path: string; source: ExecutableSource }[] = [];
  const add = (path: string, source: ExecutableSource): void => {
    if (!candidates.some((candidate) => candidate.path === path)) candidates.push({ path, source });
  };
  for (const path of await findOnPath(options.name, env)) add(path, 'path');
  const exe = process.platform === 'win32' ? `${options.name}.exe` : options.name;
  const fallbackDirs: [string, ExecutableSource][] = [
    [join(home, '.local', 'bin'), 'home-local'], [join(home, '.npm-global', 'bin'), 'npm-global'],
    [join(home, '.opencode', 'bin'), 'opencode'], [join(home, '.bun', 'bin'), 'bun'], [join(home, '.volta', 'bin'), 'volta'],
    [join(home, '.local', 'share', 'pnpm'), 'pnpm'], [join(home, '.cargo', 'bin'), 'cargo'],
    ['/home/linuxbrew/.linuxbrew/bin', 'homebrew'], ['/opt/homebrew/bin', 'homebrew'], ['/usr/local/bin', 'homebrew'],
  ];
  const nvmRoot = join(home, '.nvm', 'versions', 'node');
  const nvmVersions = (await directories(nvmRoot)).sort((a, b) => {
    const pa = parseSemver(a); const pb = parseSemver(b);
    if (pa && pb) return compareSemver(pb, pa);
    if (pa) return -1; if (pb) return 1;
    return b.localeCompare(a, undefined, { numeric: true });
  });
  for (const version of nvmVersions) fallbackDirs.push([join(nvmRoot, version, 'bin'), 'nvm']);
  if (options.npmPrefix?.trim()) fallbackDirs.push([join(options.npmPrefix.trim(), 'bin'), 'npm-prefix']);
  else {
    const prefix = env.npm_config_prefix?.trim();
    if (prefix) fallbackDirs.push([join(prefix, 'bin'), 'npm-prefix']);
  }
  for (const [dir, source] of fallbackDirs) {
    const path = join(dir, exe);
    if (await executable(path)) add(path, source);
  }
  for (const extra of options.extraCandidates ?? []) if (await executable(extra.path)) add(extra.path, extra.source);

  for (const candidate of candidates) {
    const resolved = await test(candidate.path, candidate.source);
    if (resolved) return { ok: true, executable: resolved };
  }
  const tried = skipped.map((entry) => `${entry.path} (${entry.reason})`).join('; ');
  return {
    ok: false,
    reason: tried
      ? `No working ${options.name} executable found. Tried: ${tried}. Set the executable path in settings.`
      : `${options.name} executable not found. Looked on PATH and in ${fallbackDirs.map(([dir]) => dir).join(', ')}. Install it or set its executable path in Settings.`,
    skipped,
  };
}

function parseSemver(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Location of the native Claude Code binary shipped with the Agent SDK, when installed. */
export function bundledClaudeCandidates(): { path: string; source: ExecutableSource }[] {
  const require = createRequire(import.meta.url);
  const suffixes = process.platform === 'linux' ? ['', '-musl'] : [''];
  const file = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const found: { path: string; source: ExecutableSource }[] = [];
  for (const suffix of suffixes) {
    try {
      const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/package.json`);
      found.push({ path: join(pkg, '..', file), source: 'sdk-bundled' });
    } catch {
      // Optional dependency not installed for this platform.
    }
  }
  return found;
}

interface CacheEntry { expires: number; value: Promise<ResolveResult> }
const cache = new Map<string, CacheEntry>();

/** Short-lived memoisation so repeated runs do not re-probe `--version` every time. */
export function resolveExecutableCached(options: ResolveOptions, ttlMs = 30_000): Promise<ResolveResult> {
  const env = options.env ?? process.env;
  const key = JSON.stringify([options.name, options.override, env.PATH, options.home ?? homedir()]);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const value = resolveExecutable(options);
  cache.set(key, { expires: now + ttlMs, value });
  void value.then((result) => { if (!result.ok) cache.delete(key); }, () => cache.delete(key));
  return value;
}

export function clearExecutableCache(): void { cache.clear(); }
