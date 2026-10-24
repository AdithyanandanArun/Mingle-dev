import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { DistributedDeviceEnvelopeSchema, DistributedProjectBindingSchema } from '../../../../packages/contracts/src/remote-git.ts';
import type { DistributedDeviceEnvelope } from '../../../../packages/contracts/src/remote-git.ts';
import { conflict, notFound, nowIso } from '../util.ts';

export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
// Base64 expands a chunk by 4/3 before JSON and envelope metadata are added.
// Half of the mailbox's 256 KiB plaintext ceiling leaves safe room for both.
export const BUNDLE_CHUNK_BYTES = 128 * 1024;
export const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
export const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;
export const OPERATION_TIMEOUT_MS = 20_000;

export interface VerifiedAccountUser { id: string }
export interface AccountBridge {
  withAuthenticatedClient<T>(callback: (client: unknown, user: VerifiedAccountUser) => Promise<T>): Promise<T>;
}
export interface LocalDeviceSnapshot { deviceId?: string | null }
export interface DeviceTransport {
  snapshot(teamId?: string): LocalDeviceSnapshot;
  send(input: { teamId: string; toDeviceId: string; kind: string; payload: unknown; idempotencyKey: string }): Promise<unknown>;
}
export interface WorkspaceProject { id: string; path: string }
export interface WorkspaceResolver { getProject(id: string): WorkspaceProject | undefined | Promise<WorkspaceProject | undefined> }
export interface GitRepositoryExecutor { runGit(cwd: string, args: string[], options?: GitRunOptions): Promise<GitProcessResult> }
export interface TeamArtifactAuthorization {
  teamId: string; sharedProjectId: string; deliveryId: string; peerDeviceId: string; direction: 'export' | 'import';
}
export interface DistributedServiceOptions {
  store: { db: DatabaseSync } | DatabaseSync;
  account: AccountBridge;
  transport: DeviceTransport;
  workspace: WorkspaceResolver;
  /** Optional existing repository adapter; it must preserve argv-only execution and the restrictions used by runGit. */
  repository?: GitRepositoryExecutor;
  /** Must revalidate live team membership, local device ownership and (when supplied) mutual peer links/pins. */
  authorizeTeam: (input: { teamId: string; peerDeviceId?: string }) => Promise<void>;
  /** Team-artifact authority additionally verifies the delivery owner and integration-device relationship. */
  authorizeTeamArtifact?: (input: TeamArtifactAuthorization) => Promise<void>;
  changed?: () => void;
  /** Optional resolver for embedding hosts which do not expose Store.getProject. Returned paths are canonicalized here. */
  resolveBinding?: (input: { localProjectId: string }) => WorkspaceProject | undefined | Promise<WorkspaceProject | undefined>;
}

export interface GitProcessResult { code: number; stdout: Buffer; stderr: Buffer; outputTruncated: boolean }
export interface GitRunOptions { timeoutMs?: number; maxOutputBytes?: number; allowFailure?: boolean; env?: NodeJS.ProcessEnv }

const SAFE_CONFIG: Array<[string, string]> = [
  ['core.hooksPath', os.devNull],
  ['core.fsmonitor', 'false'],
  ['core.untrackedCache', 'false'],
  ['core.pager', 'cat'],
  ['core.attributesFile', os.devNull],
  ['core.excludesFile', os.devNull],
  ['diff.external', ''],
  ['diff.trustExitCode', 'false'],
  ['credential.helper', ''],
  ['protocol.ext.allow', 'never'],
  ['protocol.file.allow', 'always'],
  ['fetch.fsckObjects', 'true'],
  ['transfer.fsckObjects', 'true'],
  ['merge.autoStash', 'false'],
];

function cleanGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:CONFIG_|DIR$|WORK_TREE$|COMMON_DIR$|INDEX_FILE$|PREFIX$|CEILING_DIRECTORIES$|EXEC_PATH$|TRACE)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_SSH_COMMAND: 'ssh -F /dev/null -o BatchMode=yes',
    ...extra,
  });
  return env;
}

export function safeGitArgs(args: string[]): string[] {
  return [...SAFE_CONFIG.flatMap(([key, value]) => ['-c', `${key}=${value}`]), ...args];
}

export function runGit(cwd: string, args: string[], options: GitRunOptions = {}): Promise<GitProcessResult> {
  const timeoutMs = options.timeoutMs ?? OPERATION_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn('git', safeGitArgs(args), { cwd, env: cleanGitEnvironment(options.env), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputTruncated = false;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finishError(new Error(`Git operation exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
    const append = (target: Buffer[], chunk: Buffer) => {
      const remaining = maxOutputBytes - outputBytes;
      if (remaining <= 0) { outputTruncated = true; return; }
      const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      target.push(kept);
      outputBytes += kept.length;
      if (kept.length !== chunk.length) outputTruncated = true;
    };
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
    child.once('error', finishError);
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const result = { code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), outputTruncated };
      if (result.code !== 0 && !options.allowFailure) {
        reject(new Error(`Git operation failed (${result.code}): ${result.stderr.toString('utf8').slice(0, 1000).trim() || 'no diagnostic output'}`));
      } else resolve(result);
    });
    function finishError(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill('SIGKILL');
      reject(error);
    }
  });
}

export function repositoryGit(repository: GitRepositoryExecutor | undefined, cwd: string, args: string[], options: GitRunOptions = {}): Promise<GitProcessResult> {
  return repository ? repository.runGit(cwd, args, options) : runGit(cwd, args, options);
}

export function dbOf(store: DistributedServiceOptions['store']): DatabaseSync {
  return 'db' in store ? store.db : store;
}

export function ensureCommonTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mingle_distributed_project_bindings (
      team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL, local_project_id TEXT NOT NULL,
      canonical_path TEXT NOT NULL, owner_id TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(team_id, shared_project_id)
    );
  `);
}

export interface ProjectBinding {
  teamId: string; sharedProjectId: string; localProjectId: string; canonicalPath: string; ownerId: string; updatedAt: string;
}

export async function currentUser(account: AccountBridge): Promise<VerifiedAccountUser> {
  return account.withAuthenticatedClient(async (_client, user) => {
    if (!user || typeof user.id !== 'string' || user.id.length < 1 || user.id.length > 200) throw new Error('A verified signed-in account is required.');
    return { id: user.id };
  });
}

export async function canonicalProject(options: DistributedServiceOptions, localProjectId: string): Promise<WorkspaceProject & { path: string }> {
  const project = options.resolveBinding
    ? await options.resolveBinding({ localProjectId })
    : await options.workspace.getProject(localProjectId);
  if (!project || project.id !== localProjectId) throw notFound('The owner-selected local project is unavailable.');
  const root = await realpath(project.path);
  const info = await stat(root);
  if (!info.isDirectory()) throw conflict('The owner-selected project path is not a directory.');
  const topOutput = (await repositoryGit(options.repository, root, ['rev-parse', '--show-toplevel'], { maxOutputBytes: 4096 })).stdout.toString('utf8');
  // Git adds one newline delimiter. Do not trim: valid filesystem roots can end in spaces,
  // tabs, or newlines, and those characters are part of the canonical path.
  const top = topOutput.endsWith('\n') ? topOutput.slice(0, -1) : topOutput;
  if (!top || await realpath(top) !== root) throw conflict('The owner-selected project is not the canonical root of a Git repository.');
  return { id: project.id, path: root };
}

export async function bindProject(options: DistributedServiceOptions, db: DatabaseSync, input: unknown): Promise<ProjectBinding> {
  const parsed = DistributedProjectBindingSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid project binding: ${parsed.error.issues[0]?.message ?? 'schema validation failed'}`);
  const owner = await currentUser(options.account);
  await options.authorizeTeam({ teamId: parsed.data.teamId });
  const project = await canonicalProject(options, parsed.data.localProjectId);
  const updatedAt = nowIso();
  db.prepare(`INSERT INTO mingle_distributed_project_bindings(team_id,shared_project_id,local_project_id,canonical_path,owner_id,updated_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(team_id,shared_project_id) DO UPDATE SET local_project_id=excluded.local_project_id,
    canonical_path=excluded.canonical_path, owner_id=excluded.owner_id, updated_at=excluded.updated_at`)
    .run(parsed.data.teamId, parsed.data.sharedProjectId, parsed.data.localProjectId, project.path, owner.id, updatedAt);
  options.changed?.();
  return { ...parsed.data, canonicalPath: project.path, ownerId: owner.id, updatedAt };
}

export async function resolveProjectBinding(options: DistributedServiceOptions, db: DatabaseSync,
  input: { teamId: string; sharedProjectId: string; peerDeviceId?: string } | { team_id: string; shared_project_id: string; peer_device_id?: string }, ownerId?: string): Promise<ProjectBinding> {
  const teamId = 'teamId' in input ? input.teamId : input.team_id;
  const sharedProjectId = 'sharedProjectId' in input ? input.sharedProjectId : input.shared_project_id;
  const peerDeviceId = 'peerDeviceId' in input ? input.peerDeviceId : ('peer_device_id' in input ? input.peer_device_id : undefined);
  await options.authorizeTeam({ teamId, ...(peerDeviceId ? { peerDeviceId } : {}) });
  const row = db.prepare(`SELECT team_id,shared_project_id,local_project_id,canonical_path,owner_id,updated_at
    FROM mingle_distributed_project_bindings WHERE team_id=? AND shared_project_id=?`).get(teamId, sharedProjectId) as Record<string, unknown> | undefined;
  if (!row) throw notFound('Bind this shared project to an owner-selected local project first.');
  const binding: ProjectBinding = {
    teamId: row.team_id as string, sharedProjectId: row.shared_project_id as string, localProjectId: row.local_project_id as string,
    canonicalPath: row.canonical_path as string, ownerId: row.owner_id as string, updatedAt: row.updated_at as string,
  };
  if (ownerId && ownerId !== binding.ownerId) throw conflict('This project binding belongs to a different verified account. Rebind it explicitly.');
  const current = await canonicalProject(options, binding.localProjectId);
  if (current.path !== binding.canonicalPath) throw conflict('The owner-selected local project path changed. Rebind the shared project before continuing.');
  return binding;
}

export async function scopedDirectory(rootPath: string, relativePath: string): Promise<string> {
  if (typeof relativePath !== 'string' || relativePath.length > 1024 || relativePath.includes('\0') || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error('Working directory must be a relative path within the bound project.');
  }
  if (relativePath.includes('\\')) throw new Error('Backslash path separators are not accepted in remote working directories.');
  const parts = relativePath.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw new Error('Working directory traversal is not allowed.');
  const root = await realpath(rootPath);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('Symlink traversal is not allowed in remote working directories.');
    if (!info.isDirectory()) throw new Error('Remote working directory path is not a directory.');
  }
  const canonical = await realpath(current);
  if (canonical !== root && !canonical.startsWith(`${root}${path.sep}`)) throw new Error('Working directory escapes the bound project.');
  return canonical;
}

export async function fingerprintRepository(root: string, repository?: GitRepositoryExecutor): Promise<{ head: string; branch: string | null; fingerprint: string; dirty: boolean }> {
  const [headResult, branchResult, statusResult, diffResult, untrackedResult, configResult] = await Promise.all([
    repositoryGit(repository, root, ['rev-parse', '--verify', 'HEAD'], { maxOutputBytes: 4096 }),
    repositoryGit(repository, root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true, maxOutputBytes: 4096 }),
    repositoryGit(repository, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { maxOutputBytes: 2 * 1024 * 1024 }),
    repositoryGit(repository, root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], { maxOutputBytes: 8 * 1024 * 1024 }),
    repositoryGit(repository, root, ['ls-files', '--others', '--exclude-standard', '-z'], { maxOutputBytes: 2 * 1024 * 1024 }),
    repositoryGit(repository, root, ['config', '--local', '--null', '--list'], { maxOutputBytes: 2 * 1024 * 1024 }),
  ]);
  if ([statusResult, diffResult, untrackedResult, configResult].some((result) => result.outputTruncated)) throw conflict('Repository state is too large to fingerprint safely for an approval.');
  const hash = createHash('sha256');
  const head = headResult.stdout.toString('utf8').trim();
  const branch = branchResult.code === 0 ? branchResult.stdout.toString('utf8').trim() : null;
  hash.update(head); hash.update('\0'); hash.update(branch ?? 'detached'); hash.update('\0');
  hash.update(statusResult.stdout); hash.update('\0'); hash.update(diffResult.stdout); hash.update('\0'); hash.update(configResult.stdout); hash.update('\0');
  const untracked = untrackedResult.stdout.toString('utf8').split('\0').filter(Boolean);
  let totalUntrackedBytes = 0;
  for (const relative of untracked) {
    if (path.isAbsolute(relative) || relative.split('/').some((part) => part === '..' || part === '')) throw conflict('Git returned an unsafe untracked path.');
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);
    hash.update(relative); hash.update('\0');
    if (info.isSymbolicLink()) { hash.update('link:'); hash.update(await readlink(absolute)); }
    else if (info.isFile()) {
      if (info.size > 10 * 1024 * 1024 || totalUntrackedBytes + info.size > 32 * 1024 * 1024) throw conflict('Untracked files are too large to fingerprint safely for an approval.');
      totalUntrackedBytes += info.size;
      hash.update('file:'); hash.update(await readFile(absolute));
    } else throw conflict('An untracked non-file path cannot be safely fingerprinted.');
    hash.update('\0');
  }
  return { head, branch, fingerprint: hash.digest('hex'), dirty: statusResult.stdout.length > 0 };
}

export function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== 'string') throw new Error(`Invalid stored ${label}.`);
  try { return JSON.parse(value) as T; } catch { throw new Error(`Invalid stored ${label}.`); }
}

export function insertAudit(db: DatabaseSync, table: 'mingle_git_audit' | 'mingle_command_audit', input: {
  requestId?: string | null; action: string; actorDeviceId?: string | null; digest?: string | null; details?: Record<string, unknown>;
}): void {
  db.prepare(`INSERT INTO ${table}(id,request_id,action,actor_device_id,digest,details_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(randomUUID(), input.requestId ?? null, input.action, input.actorDeviceId ?? null, input.digest ?? null, JSON.stringify(input.details ?? {}), nowIso());
}

export function auditRows(db: DatabaseSync, table: 'mingle_git_audit' | 'mingle_command_audit', limit = 500): Array<Record<string, unknown>> {
  return db.prepare(`SELECT id,request_id,action,actor_device_id,digest,details_json,created_at FROM ${table} ORDER BY rowid DESC LIMIT ?`)
    .all(Math.max(1, Math.min(limit, 2000))) as Array<Record<string, unknown>>;
}

export function asSql(value: string | number | null): SQLInputValue { return value; }

export function validateEnvelope(input: unknown, ownDeviceId: string | ((teamId: string) => string)): DistributedDeviceEnvelope {
  const parsed = DistributedDeviceEnvelopeSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid authenticated transport envelope.');
  const expectedDeviceId = typeof ownDeviceId === 'string' ? ownDeviceId : ownDeviceId(parsed.data.teamId);
  if (parsed.data.toDeviceId !== expectedDeviceId) throw new Error('Envelope is not addressed to this device.');
  return parsed.data;
}

export function processOutput(result: GitProcessResult): { text: string; truncated: boolean } {
  return { text: `${result.stdout.toString('utf8')}${result.stderr.toString('utf8')}`, truncated: result.outputTruncated };
}
