import { run, type RunResult } from './exec.ts';
import { gitNullPath } from '../git-null-path.ts';
import { failureSummary } from './scrub.ts';

export class GitFailure extends Error {
  constructor(message: string, readonly stderr: string, readonly code: number | null, readonly timedOut = false) {
    super(message);
    this.name = 'GitFailure';
  }
}

export interface GitRunOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  stdin?: string | Buffer;
  /** Extra environment (for example GIT_INDEX_FILE for a private index). */
  env?: Record<string, string>;
  /** Talks to a remote: keeps the user's SSH selection, disables every interactive prompt and drops the controlling terminal. */
  network?: boolean;
  /** Runs without a controlling terminal so tools such as gpg cannot block on a prompt Mingle cannot show. */
  detached?: boolean;
  signal?: AbortSignal;
  allowFailure?: boolean;
}

const CONFIG = [
  'core.quotepath=false', 'core.fsmonitor=false', `core.hooksPath=${gitNullPath()}`, 'protocol.ext.allow=never', 'submodule.recurse=false',
];
const SSH_PASSTHROUGH = new Set(['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT']);

function gitEnv(options: GitRunOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_') && !(options.network && SSH_PASSTHROUGH.has(key))) continue; // never inherit GIT_DIR, GIT_INDEX_FILE, GIT_ASKPASS ...
    if (key === 'SSH_ASKPASS' || key === 'SSH_ASKPASS_REQUIRE') continue;
    env[key] = value;
  }
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never' }, options.env);
  return env;
}

/** Runs git with an argv array, repository hooks and fsmonitor disabled, and a scrubbed environment. Throws GitFailure unless allowFailure. */
export async function git(cwd: string, args: string[], options: GitRunOptions = {}): Promise<RunResult> {
  const result = await run('git', [...CONFIG.flatMap((entry) => ['-c', entry]), ...args], {
    cwd, env: gitEnv(options), timeoutMs: options.timeoutMs ?? 20_000, maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    stdin: options.stdin, signal: options.signal, detached: options.network || options.detached,
  });
  if (result.spawnError) throw new GitFailure(result.spawnError.code === 'ENOENT' ? 'Git is not installed, is not on PATH, or the folder no longer exists' : `Git could not be started: ${failureSummary(result.spawnError.message)}`, '', null);
  if (result.aborted) throw new GitFailure('Git was cancelled because the server is shutting down', '', null);
  if (result.timedOut) throw new GitFailure(`git ${args[0] ?? ''} timed out`, result.stderr, null, true);
  if (result.truncated) throw new GitFailure(`git ${args[0] ?? ''} produced more output than Mingle will read`, result.stderr, result.code);
  if (result.code !== 0 && !options.allowFailure) throw new GitFailure(`git ${args[0] ?? ''} failed: ${failureSummary(result.stderr || result.stdout)}`, result.stderr, result.code);
  return result;
}

export const trimmed = (result: RunResult) => result.stdout.trim();
