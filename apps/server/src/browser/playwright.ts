import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';
import { BrowserError, cleanMessage } from './errors.ts';

export type PlaywrightModule = typeof import('playwright');
export type { Browser, BrowserContext, CDPSession, Dialog, Download, Locator, Page } from 'playwright';

let loaded: Promise<PlaywrightModule> | null = null;

/** Playwright is imported lazily so the server starts quickly and works without it until a browser is used. */
export function loadPlaywright(): Promise<PlaywrightModule> {
  loaded ??= import('playwright').catch((error: unknown) => {
    loaded = null;
    throw new BrowserError(503, `Playwright is not available: ${cleanMessage(error, 200)}`);
  });
  return loaded;
}

export interface ManagedExecutable {
  /** Absolute path of the executable that would be used, or null when nothing is installed. */
  path: string | null;
  /** True when the path comes from the browserExecutable setting rather than Playwright's pinned download. */
  configured: boolean;
  /** Why a configured executable cannot be used. */
  problem: string | null;
}

async function isRegularFile(target: string): Promise<boolean> {
  try { return (await stat(target)).isFile(); } catch { return false; }
}

export async function resolveManagedExecutable(configured: string | undefined): Promise<ManagedExecutable> {
  const requested = configured?.trim();
  if (requested) {
    if (!path.isAbsolute(requested)) return { path: null, configured: true, problem: 'The browser executable setting must be an absolute path.' };
    if (!(await isRegularFile(requested))) return { path: null, configured: true, problem: `No browser executable exists at ${requested}.` };
    if (process.platform !== 'win32') {
      try { await access(requested, constants.X_OK); } catch { return { path: null, configured: true, problem: `${requested} is not executable.` }; }
    }
    return { path: requested, configured: true, problem: null };
  }
  try {
    const bundled = (await loadPlaywright()).chromium.executablePath();
    return { path: bundled && (await isRegularFile(bundled)) ? bundled : null, configured: false, problem: null };
  } catch {
    return { path: null, configured: false, problem: null };
  }
}

/** Translates launch failures into guidance without enabling --no-sandbox behind the user's back. */
export function diagnoseLaunchError(error: unknown, sandbox?: { userNamespacesRestricted: boolean; profileInstalled: boolean }): BrowserError {
  if (error instanceof BrowserError) return error;
  const message = cleanMessage(error, 800);
  if (/Executable doesn't exist|browserType\.launch.*(?:install|executable)/isu.test(message)) {
    return new BrowserError(503, 'Chromium is not installed. Use "Install Chromium" in the Browser panel or set a browser executable in settings.');
  }
  if (/missing dependencies|error while loading shared libraries|cannot open shared object file/iu.test(message)) {
    return new BrowserError(503, 'Chromium cannot start because system libraries are missing. Install the Chromium runtime dependencies for this OS (for example with `npx playwright install-deps chromium`), then try again.');
  }
  if (/running as root/iu.test(message)) return new BrowserError(503, 'Chromium refuses to run as root with its sandbox enabled. Run Mingle as your normal desktop user.');
  if (sandbox?.userNamespacesRestricted && !sandbox.profileInstalled) return new BrowserError(503, "Ubuntu's AppArmor is blocking Chromium's sandbox. Use 'Allow Chromium' in the Browser panel (one admin prompt), or use an installed browser such as Google Chrome.");
  if (/sandbox|namespace|setuid/iu.test(message)) {
    return new BrowserError(503, 'Chromium\'s sandbox could not start. Mingle keeps the sandbox enabled; run Mingle as a regular user and, on Linux, allow unprivileged user namespaces (on Ubuntu 23.10+ this needs an AppArmor profile for the browser).');
  }
  if (/ProcessSingleton|SingletonLock|profile.*(?:in use|locked)/iu.test(message)) {
    return new BrowserError(409, 'This session\'s browser profile is already in use by another Chromium process. Disconnect the session and try again.');
  }
  return new BrowserError(503, `Chromium failed to start: ${message}`);
}

export function diagnoseConnectError(error: unknown, kind: 'source' | 'endpoint'): BrowserError {
  if (error instanceof BrowserError) return error;
  const message = cleanMessage(error, 400);
  if (/ECONNREFUSED|ECONNRESET|socket hang up|ENOTFOUND/iu.test(message)) {
    return new BrowserError(502, kind === 'source'
      ? 'The browser is not accepting remote debugging connections. Make sure it is running with remote debugging enabled (chrome://inspect/#remote-debugging), then try again.'
      : 'Nothing is listening on that debugging endpoint. Check that the browser is running with remote debugging enabled.');
  }
  if (/Timeout .*exceeded|timed out/iu.test(message)) {
    return new BrowserError(504, 'Timed out waiting for the browser. If it asked for permission to allow remote debugging, approve the prompt in the browser and connect again.');
  }
  if (/403|Forbidden|Rejected|denied/iu.test(message)) {
    return new BrowserError(403, 'The browser refused the remote debugging connection. Approve the prompt in the browser if it shows one, then connect again.');
  }
  return new BrowserError(502, `Could not connect to the browser: ${message}`);
}
