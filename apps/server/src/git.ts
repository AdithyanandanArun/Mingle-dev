import { execFile } from 'node:child_process';
import path from 'node:path';
import fsp from 'node:fs/promises';
import type { GitFile, GitStatus } from '@mingle/contracts';
import { SECRET_PATHSPEC_EXCLUDES, isDeniedName, resolveInside } from './paths.ts';
import { gitNullPath } from './git-null-path.ts';
import { HttpError } from './util.ts';

export interface GitResult { stdout: string; stderr: string; code: number }

export class GitError extends Error {
  constructor(message: string, readonly stderr: string, readonly code: number) {
    super(message);
    this.name = 'GitError';
  }
}

const MAX_BUFFER = 16 * 1024 * 1024;

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_')) continue; // never inherit GIT_DIR / GIT_INDEX_FILE etc. from the launching shell
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_PAGER = 'cat';
  env.LC_ALL = 'C';
  return env;
}

export interface GitOptions { timeoutMs?: number; allowFailure?: boolean; maxBuffer?: number; extraConfig?: string[]; stdin?: string | Buffer }

/** Runs git with an argv array (never through a shell) and repository-config command execution hooks disabled. */
export function git(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  const base = ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${gitNullPath()}`, ...(options.extraConfig ?? []).flatMap((c) => ['-c', c])];
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...base, ...args], { cwd, env: gitEnv(), timeout: options.timeoutMs ?? 20_000, maxBuffer: options.maxBuffer ?? MAX_BUFFER, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr, code: 0 });
      const code = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((error as unknown as { code: number }).code) : -1;
      if (options.allowFailure && code >= 0) return resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
      const detail = String(stderr || error.message).trim().split('\n').slice(0, 4).join(' ');
      reject(new GitError(`git ${args[0] ?? ''} failed: ${detail}`, String(stderr ?? ''), code));
    });
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}

export interface RepoInfo { isRepo: boolean; topLevel: string | null; prefix: string; hasHead: boolean; head: string | null; branch: string | null }

export async function repoInfo(cwd: string): Promise<RepoInfo> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true }).catch(() => null);
  if (!inside || inside.code !== 0 || inside.stdout.trim() !== 'true') return { isRepo: false, topLevel: null, prefix: '', hasHead: false, head: null, branch: null };
  const [top, prefix, head, branch] = await Promise.all([
    git(cwd, ['rev-parse', '--show-toplevel']),
    git(cwd, ['rev-parse', '--show-prefix']),
    git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true }),
    git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true }),
  ]);
  const hasHead = head.code === 0;
  return {
    isRepo: true,
    topLevel: top.stdout.trim(),
    prefix: prefix.stdout.trim().replace(/\/$/, ''),
    hasHead,
    head: hasHead ? head.stdout.trim() : null,
    branch: branch.code === 0 ? branch.stdout.trim() : hasHead ? 'HEAD (detached)' : null,
  };
}

const IDENTITY_FREE: string[] = ['commit.gpgsign=false', 'tag.gpgsign=false'];

/** Creates an isolated worktree on a new branch below `worktreePath`. */
export async function addWorktree(repoCwd: string, worktreePath: string, branch: string): Promise<void> {
  const exists = await git(repoCwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true });
  if (exists.code === 0) throw new HttpError(409, `Branch ${branch} already exists`);
  await fsp.mkdir(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
  await git(repoCwd, ['worktree', 'add', '-b', branch, '--', worktreePath, 'HEAD'], { timeoutMs: 60_000, extraConfig: IDENTITY_FREE });
}

export function parsePorcelain(output: string): GitFile[] {
  const files: GitFile[] = [];
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.length < 4) continue;
    const x = record[0]!;
    const y = record[1]!;
    const file = record.slice(3);
    if (x === 'R' || x === 'C') i++; // rename/copy records are followed by the original path
    let status: string;
    if (x === '?' && y === '?') status = '??';
    else if (x === '!' && y === '!') continue;
    else if (x !== ' ' && y !== ' ') status = x === y ? x : `${x}${y}`;
    else status = (x !== ' ' ? x : y);
    files.push({ path: file, status });
  }
  return files;
}

const MAX_DIFF_BYTES = 1_000_000;
const MAX_UNTRACKED_DIFFS = 20;
const MAX_UNTRACKED_BYTES = 100_000;

/** Read-only status and combined staged+unstaged diff, scoped to `cwd` (a project directory or a session worktree). */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  const info = await repoInfo(cwd);
  if (!info.isRepo) return { branch: '', files: [], diff: '', isRepo: false };
  const status = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  const files = parsePorcelain(status.stdout);
  const diffArgs = ['--no-ext-diff', '--no-textconv', '--no-color', '--submodule=short'];
  const scope = ['--', '.', ...SECRET_PATHSPEC_EXCLUDES];
  let diff: string;
  if (info.hasHead) diff = (await git(cwd, ['diff', 'HEAD', ...diffArgs, ...scope], { allowFailure: true })).stdout;
  else diff = (await git(cwd, ['diff', '--cached', ...diffArgs, ...scope], { allowFailure: true })).stdout;
  let untrackedShown = 0;
  for (const file of files) {
    if (file.status !== '??') continue;
    if (untrackedShown >= MAX_UNTRACKED_DIFFS) break;
    if (file.path.split('/').some(isDeniedName)) continue;
    try {
      const target = await resolveInside(cwd, relativeToCwd(info, file.path));
      const stat = await fsp.stat(target.real);
      if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) continue;
      const result = await git(cwd, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', gitNullPath(), target.rel], { allowFailure: true });
      if (result.code === 1) {
        diff += (diff && !diff.endsWith('\n') ? '\n' : '') + result.stdout;
        untrackedShown++;
      }
    } catch {
      // Unreadable or escaping untracked paths are simply left out of the diff text.
    }
  }
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) diff = `${diff.slice(0, MAX_DIFF_BYTES)}\n… diff truncated at ${MAX_DIFF_BYTES} bytes\n`;
  return { branch: info.branch ?? '', files, diff, isRepo: true };
}

// `git status` reports paths relative to the repository root; convert to paths relative to cwd for scoped lookups.
function relativeToCwd(info: RepoInfo, repoRelative: string): string {
  if (!info.prefix) return repoRelative;
  return path.posix.relative(info.prefix, repoRelative);
}
