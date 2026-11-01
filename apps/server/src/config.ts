import { mkdirSync, readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root derived from this file's location, never from the caller's cwd. */
export const SOURCE_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4310;
export const WEB_DEV_PORT = 5173;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function environmentValue(env: NodeJS.ProcessEnv, currentName: string, legacyName: string): string | undefined {
  return env[currentName] !== undefined ? env[currentName] : env[legacyName];
}

/** Keep an existing checkout's local state in place when adopting the Mingle default. */
function defaultDataDirectory(sourceRoot: string): string {
  const current = path.join(sourceRoot, '.mingle');
  const legacy = path.join(sourceRoot, '.relay');
  const legacyDatabase = existsSync(path.join(legacy, 'relay.sqlite'));
  const currentDatabase = existsSync(path.join(current, 'relay.sqlite'));
  if (legacyDatabase || (!currentDatabase && existsSync(legacy))) return legacy;
  if (currentDatabase) return current;
  return current;
}

export interface ConfigOptions {
  /** Directory for the database and session worktrees. Defaults to MINGLE_DATA_DIR (or legacy RELAY_DATA_DIR) or <sourceRoot>/.mingle, reusing an existing .relay directory. */
  dataDir?: string;
  host?: string;
  /** 0 picks a free port (tests). */
  port?: number;
  sourceRoot?: string;
  /** Directory with the built web app; null disables static serving. Defaults to <sourceRoot>/apps/web/dist when present. */
  webDistDir?: string | null;
  /** Extra browser origins allowed to call mutating routes and open WebSockets. */
  allowedOrigins?: string[];
  /** Port of the Vite dev server whose origin is trusted. */
  webDevPort?: number;
  /** Content-Security-Policy for static responses; null disables it. */
  csp?: string | null;
}

export interface ServerConfig {
  sourceRoot: string;
  dataDir: string;
  host: string;
  port: number;
  webDistDir: string | null;
  allowedOrigins: string[];
  webDevPort: number;
  csp: string | null;
  version: string;
}

export const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* wss://127.0.0.1:* wss://localhost:*",
  "worker-src 'self' blob:",
  'frame-src http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*',
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.replace(/^\[|\]$/g, '').toLowerCase());
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${raw}`);
  return port;
}

function readVersion(sourceRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(sourceRoot, 'apps/server/package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function resolveConfig(options: ConfigOptions = {}, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : SOURCE_ROOT;
  const dataEnv = environmentValue(env, 'MINGLE_DATA_DIR', 'RELAY_DATA_DIR')?.trim();
  const dataSetting = options.dataDir ?? (dataEnv || defaultDataDirectory(sourceRoot));
  const dataDir = path.resolve(dataSetting);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const host = options.host ?? (environmentValue(env, 'MINGLE_HOST', 'RELAY_HOST')?.trim() || DEFAULT_HOST);
  if (!isLoopbackHost(host)) throw new Error(`Mingle only binds loopback addresses (got ${host}).`);
  const port = options.port ?? parsePort(environmentValue(env, 'MINGLE_PORT', 'RELAY_PORT'), DEFAULT_PORT);
  let webDistDir: string | null;
  if (options.webDistDir !== undefined) webDistDir = options.webDistDir;
  else if (environmentValue(env, 'MINGLE_WEB_DIST', 'RELAY_WEB_DIST')?.trim()) webDistDir = path.resolve(environmentValue(env, 'MINGLE_WEB_DIST', 'RELAY_WEB_DIST')!.trim());
  else {
    const candidate = path.join(sourceRoot, 'apps/web/dist');
    webDistDir = existsSync(path.join(candidate, 'index.html')) ? candidate : null;
  }
  if (webDistDir && !(existsSync(webDistDir) && statSync(webDistDir).isDirectory())) webDistDir = null;
  if (webDistDir) webDistDir = realpathSync(webDistDir);
  const envOrigins = (environmentValue(env, 'MINGLE_ALLOWED_ORIGINS', 'RELAY_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    sourceRoot,
    dataDir: realpathSync(dataDir),
    host,
    port,
    webDistDir,
    allowedOrigins: [...(options.allowedOrigins ?? []), ...envOrigins],
    webDevPort: options.webDevPort ?? parsePort(environmentValue(env, 'MINGLE_WEB_PORT', 'RELAY_WEB_PORT'), WEB_DEV_PORT),
    csp: options.csp === undefined ? DEFAULT_CSP : options.csp,
    version: readVersion(sourceRoot),
  };
}
