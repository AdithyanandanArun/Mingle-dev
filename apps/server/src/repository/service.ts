import { realpathSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  GitHubState, InitializeGitRequest, InitializeGitResult, RepositoryBranch, RepositoryCommit, RepositoryMutationResult, RepositoryPullRequest, RepositoryPush, RepositoryState,
} from '@mingle/contracts';
import type { Session } from '@mingle/contracts';
import type { SessionRuntime } from '../runtime.ts';
import type { Store } from '../store.ts';
import type { Logger } from '../types.ts';
import { HttpError, badRequest, conflict, errorMessage, notFound, unprocessable } from '../util.ts';
import type { WorkspaceService } from '../workspace.ts';
import { createCommit } from './commit.ts';
import { classify, ghRun, isRepositorySlug } from './gh.ts';
import { ciSummary, GitHubReader, listPullRequests, type GitHubReading, type GitHubTarget } from './github.ts';
import { git, GitFailure } from './git-run.ts';
import { basics, configuredPushRemote, identityProblem, isMirrorRemote, locate, remotes as readRemotes, signingConfigured, tracking as readTracking, type RemoteInfo, type Tracking } from './inspect.ts';
import { KeyedLock } from './lock.ts';
import { isValidBranchName } from './refs.ts';
import { failureSummary, scrub } from './scrub.ts';
import { initializeProjectRepository } from './initialize.ts';
import { readSnapshot, type Entry, type Scope, type Snapshot } from './snapshot.ts';

export interface RepositoryServiceOptions {
  store: Store;
  workspace: WorkspaceService;
  runtime: Pick<SessionRuntime, 'isActive'>;
  log: Logger;
  getAccountIdentity?: () => { name?: string | null; email?: string | null } | null;
}

interface MutationContext { scope: Scope; snap: Snapshot; top: string }

/** Held for the whole of a mutation so no provider run can start in the folder while Git is being changed. */
interface Lease { top: string; sessionId?: string }

const PUSH_TIMEOUT_MS = 120_000;
const PR_TIMEOUT_MS = 60_000;
const MEMORY_LIMIT = 200;

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MEMORY_LIMIT) map.delete(map.keys().next().value!);
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Git and read-only GitHub status for registered projects and session worktrees, with explicit, serialized local mutations. */
export class RepositoryService {
  private readonly store: Store;
  private readonly workspace: WorkspaceService;
  private readonly runtime: Pick<SessionRuntime, 'isActive'>;
  private readonly log: Logger;
  private readonly getAccountIdentity: NonNullable<RepositoryServiceOptions['getAccountIdentity']>;
  private readonly abort = new AbortController();
  private readonly locks = new KeyedLock();
  private readonly reader = new GitHubReader(this.abort.signal);
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly reads = new Map<string, Promise<Snapshot>>();
  private readonly leases = new Set<Lease>();
  /** Work-tree root of session folders that overlap a mutation, so unrelated nested worktrees are not blocked. */
  private readonly topOf = new Map<string, string>();
  private readonly ciSeen = new Map<string, string>();
  private readonly prSeen = new Map<string, string>();
  private closed = false;

  constructor(options: RepositoryServiceOptions) {
    this.store = options.store;
    this.workspace = options.workspace;
    this.runtime = options.runtime;
    this.log = options.log;
    this.getAccountIdentity = options.getAccountIdentity ?? (() => null);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async state(projectId: string, sessionId?: string): Promise<RepositoryState> {
    return this.guard(async () => {
      const scope = this.workspace.resolveScope(projectId, sessionId);
      return (await this.snapshot(scope)).state;
    });
  }

  async initializeGit(projectId: string, body: InitializeGitRequest): Promise<InitializeGitResult> {
    const scope = this.workspace.resolveScope(projectId);
    const sessions = this.store.listSessions(projectId);
    if (sessions.some((session) => this.runtime.isActive(session.id) || session.status === 'running' || session.status === 'waiting')) {
      throw conflict('Stop active sessions before setting up Git in this folder.');
    }
    const result = await initializeProjectRepository({
      cwd: scope.project.path,
      github: body.createGitHub,
      fallbackIdentity: this.getAccountIdentity() ?? undefined,
      getState: () => this.state(projectId),
    });
    this.store.recordEvent({ projectId, type: 'repository.initialized', summary: `Git repository initialized: ${scope.project.name}`, payload: { github: result.github?.status ?? null, notices: result.notices } });
    return result;
  }

  async github(projectId: string, sessionId?: string, refresh = false): Promise<GitHubState> {
    return this.guard(async () => {
      const scope = this.workspace.resolveScope(projectId, sessionId);
      const signal = this.abort.signal;
      const located = await locate(scope.root, signal);
      if (located.kind !== 'ok') return this.unsupported(located.kind === 'missing' ? 'This folder no longer exists on disk.' : located.detail ?? 'This folder is not a Git repository.');
      const top = located.top;
      const local = await basics(top, signal);
      const [remotes, tracking] = await Promise.all([readRemotes(top, signal), readTracking(top, local.branch, signal)]);
      if (!remotes.length) return this.unsupported('No Git remote is configured, so GitHub information is unavailable.', local);
      const remote = this.githubRemote(remotes, tracking);
      if (!remote?.repository) {
        const hosts = [...new Set(remotes.map((r) => r.host ?? 'a non-network location'))];
        return this.unsupported(`Only github.com remotes are supported. Remotes point to ${hosts.join(', ')}.`, local);
      }
      if (!local.head) return { ...this.unsupported('This repository has no commits yet.', local), status: 'unavailable', repository: remote.repository, url: `https://github.com/${remote.repository}` };
      const remoteBranch = local.branch
        ? (tracking.remote === remote.name && tracking.merge?.startsWith('refs/heads/') ? tracking.merge.slice('refs/heads/'.length) : local.branch)
        : null;
      const target: GitHubTarget = { repository: remote.repository, branch: local.branch, remoteBranch, head: local.head };
      const state = await this.reader.read(target, refresh);
      this.observe(scope, state);
      return state;
    });
  }

  // ── mutations ────────────────────────────────────────────────────────────

  /** Shares the local repository lease with approved distributed Git operations. */
  withExternalMutation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    return this.mutate(projectId, undefined, async () => operation());
  }

  /** Serializes isolated-ref/object imports with Git mutations while allowing existing provider runs to continue. */
  withExternalRefMutation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    return this.guard(async () => {
      const first = this.workspace.resolveScope(projectId, undefined);
      const located = await locate(first.root, this.abort.signal);
      if (located.kind === 'missing') throw conflict('This folder no longer exists on disk.');
      if (located.kind === 'not-repo') throw unprocessable(located.detail ?? 'This folder is not a Git repository.');
      const lease: Lease = { top: located.top };
      this.leases.add(lease);
      try {
        return await this.locks.run(located.top, async () => {
          this.open();
          const current = this.workspace.resolveScope(projectId, undefined);
          const currentLocation = await locate(current.root, this.abort.signal);
          if (currentLocation.kind !== 'ok' || currentLocation.top !== located.top) throw conflict('The repository location changed. Refresh and try again.');
          return operation();
        });
      } finally { this.leases.delete(lease); }
    });
  }

  commit(projectId: string, input: RepositoryCommit): Promise<RepositoryMutationResult> {
    return this.mutate(projectId, input.sessionId, async ({ scope, snap, top }) => {
      const state = snap.state;
      if (state.detached) throw unprocessable('HEAD is detached. Switch to or create a branch before committing.');
      this.requireNoOperation(snap);
      this.expectHead(state, input.expectedHead);
      if (state.fingerprint !== input.expectedFingerprint) throw conflict('The working tree or index changed since you reviewed it. Refresh and review the changes again.');
      if (input.message.includes('\0')) throw badRequest('The commit message contains a NUL byte.');

      const selected = new Map<string, Entry>();
      for (const requested of input.paths) {
        const entry = snap.entries.get(requested) ?? [...snap.entries.values()].find((e) => e.companion === requested);
        if (!entry) throw badRequest(`"${scrub(requested, 200)}" is not a current change. Refresh and select again.`);
        selected.set(entry.path, entry);
      }
      const blocked = [...selected.values()].filter((e) => !e.eligible);
      if (blocked.length) throw unprocessable(`Cannot commit ${blocked.slice(0, 3).map((e) => `${scrub(e.path, 120)} (${e.reason ?? 'not eligible'})`).join(', ')}${blocked.length > 3 ? ` and ${blocked.length - 3} more` : ''}.`);
      const problem = await identityProblem(top, this.abort.signal);
      if (problem) throw unprocessable(problem);

      const paths = [...new Set([...selected.values()].flatMap((e) => (e.companion ? [e.path, e.companion] : [e.path])))];
      const signal = this.abort.signal;
      const created = await createCommit(top, state.branch!, state.head, paths, input.message, {
        sign: await signingConfigured(top, signal),
        signal,
        // Last look before the commit object is written: any edit, stage or HEAD move since the locked read aborts it.
        beforeCommit: async () => {
          const again = await readSnapshot(scope, signal);
          if (again.state.fingerprint !== state.fingerprint) throw conflict('The working tree or index changed while committing. Nothing was committed; review the changes again.');
        },
      });
      const notices: string[] = [];
      if (!created.indexSynced) notices.push('The commit was created, but Git could not refresh the index for the committed files. Run `git status` to review it.');
      const subject = scrub(input.message.split('\n', 1)[0] ?? '', 100);
      this.store.recordEvent({
        projectId, sessionId: scope.session?.id ?? null, type: 'repository.committed',
        summary: `Committed ${created.paths.length} file${created.paths.length === 1 ? '' : 's'} to ${state.branch}: ${subject}`,
        payload: { commit: created.commit, branch: state.branch, files: created.paths.length, subject },
      });
      this.log('info', 'repository commit created', { projectId, commit: created.commit, files: created.paths.length });
      return { state: (await readSnapshot(scope, this.abort.signal)).state, commit: created.commit, notices };
    });
  }

  branch(projectId: string, input: RepositoryBranch): Promise<RepositoryMutationResult> {
    return this.mutate(projectId, input.sessionId, async ({ scope, snap, top }) => {
      const state = snap.state;
      this.requireNoOperation(snap);
      this.expectHead(state, input.expectedHead);
      if (!(await isValidBranchName(top, input.name))) throw badRequest(`"${scrub(input.name, 80)}" is not a valid branch name.`);
      const exists = (await git(top, ['show-ref', '--verify', '--quiet', `refs/heads/${input.name}`], { allowFailure: true, signal: this.abort.signal })).code === 0;
      const notices: string[] = [];
      if (input.create) {
        if (exists) throw conflict(`Branch "${input.name}" already exists.`);
        if (snap.dirty) throw conflict('The working tree has uncommitted changes. Commit them before creating or switching branches; Mingle never discards or stashes work.');
        await this.switchBranch(top, ['switch', '--no-recurse-submodules', '-q', '-c', input.name]);
      } else {
        if (!exists) throw notFound(`Branch "${input.name}" does not exist.`);
        if (state.branch === input.name) return { state, notices: [`Already on ${input.name}.`] };
        if (snap.dirty) throw conflict('The working tree has uncommitted changes. Commit them before creating or switching branches; Mingle never discards or stashes work.');
        await this.switchBranch(top, ['switch', '--no-guess', '--no-recurse-submodules', '-q', '--', input.name]);
      }
      const updated = await this.syncSessionBranches(top, input.name);
      this.store.recordEvent({
        projectId, sessionId: scope.session?.id ?? null, type: input.create ? 'repository.branch.created' : 'repository.branch.switched',
        summary: `${input.create ? 'Created and switched to' : 'Switched to'} branch ${input.name}`,
        payload: { branch: input.name, from: state.branch, sessions: updated },
      });
      return { state: (await readSnapshot(scope, this.abort.signal)).state, notices };
    });
  }

  push(projectId: string, input: RepositoryPush): Promise<RepositoryMutationResult> {
    return this.mutate(projectId, input.sessionId, async ({ scope, snap, top }) => {
      const state = snap.state;
      if (state.detached || !state.branch) throw unprocessable('HEAD is detached. Switch to a branch before pushing.');
      if (snap.unborn || !state.head) throw unprocessable('There is nothing to push: this repository has no commits yet.');
      this.expectHead(state, input.expectedHead);
      const signal = this.abort.signal;
      const names = snap.remotes.map((r) => r.name);
      let name = input.remote ?? null;
      if (name !== null && !names.includes(name)) throw badRequest(`Remote "${scrub(name, 60)}" is not configured.`);
      if (name === null) {
        const preferred = (await configuredPushRemote(top, state.branch, signal)) ?? snap.tracking.remote ?? (names.includes('origin') ? 'origin' : names.length === 1 ? names[0]! : null);
        if (!preferred || !names.includes(preferred)) throw unprocessable(names.length ? 'Choose which remote to push to.' : 'No Git remote is configured.');
        name = preferred;
      }
      const remote = snap.remotes.find((r) => r.name === name)!;
      if (remote.credentials) throw unprocessable(`Remote "${name}" embeds credentials in its URL. Mingle will not push to it; use an SSH URL or a Git credential helper.`);
      if (await isMirrorRemote(top, name, signal)) throw unprocessable(`Remote "${name}" is configured as a mirror, which would overwrite remote branches. Mingle will not push to it.`);

      const merge = snap.tracking.remote === name && snap.tracking.merge?.startsWith('refs/heads/') ? snap.tracking.merge : `refs/heads/${state.branch}`;
      if ((await git(top, ['check-ref-format', merge], { allowFailure: true, signal })).code !== 0) throw unprocessable('The configured upstream branch name is not valid.');
      const args = ['push', '--no-follow-tags', '--recurse-submodules=no', ...(state.upstream ? [] : ['--set-upstream']), '--', name, `refs/heads/${state.branch}:${merge}`];
      const result = await git(top, args, { network: true, timeoutMs: PUSH_TIMEOUT_MS, allowFailure: true, signal });
      if (result.code !== 0) throw this.pushFailure(result.stderr);
      if (remote.repository) this.reader.invalidate(remote.repository);
      const notices = /up[- ]to[- ]date/i.test(result.stderr) ? ['Everything was already up to date on the remote.'] : [`Pushed ${state.branch} to ${name}.`];
      if (!state.upstream) notices.push(`${name}/${merge.slice('refs/heads/'.length)} is now this branch's upstream.`);
      this.store.recordEvent({
        projectId, sessionId: scope.session?.id ?? null, type: 'repository.pushed',
        summary: `Pushed ${state.branch} to ${name}`,
        payload: { branch: state.branch, remote: name, destination: merge, head: state.head, repository: remote.repository },
      });
      this.log('info', 'repository push completed', { projectId, remote: name, branch: state.branch });
      return { state: (await readSnapshot(scope, signal)).state, notices };
    });
  }

  pullRequest(projectId: string, input: RepositoryPullRequest): Promise<RepositoryMutationResult> {
    return this.mutate(projectId, input.sessionId, async ({ scope, snap, top }) => {
      const state = snap.state;
      const signal = this.abort.signal;
      if (state.detached || !state.branch) throw unprocessable('HEAD is detached. Switch to a branch before opening a pull request.');
      if (snap.unborn || !state.head) throw unprocessable('This repository has no commits yet.');
      this.expectHead(state, input.expectedHead);
      if (/[\u0000-\u001f\u007f]/.test(input.title)) throw badRequest('The pull request title contains control characters.');
      if (input.body.includes('\0')) throw badRequest('The pull request body contains a NUL byte.');
      const { tracking } = snap;
      const remote = snap.remotes.find((r) => r.name === tracking.remote);
      if (!state.upstream || !remote || !tracking.merge?.startsWith('refs/heads/')) throw unprocessable('Push this branch to GitHub first; it has no upstream branch.');
      if (remote.host !== 'github.com' || !remote.repository) throw unprocessable('Pull requests can only be opened for github.com remotes.');
      if (state.ahead === null) throw conflict('The upstream branch no longer exists. Push this branch again before opening a pull request.');
      if (state.ahead > 0) throw conflict(`${state.ahead} commit${state.ahead === 1 ? ' is' : 's are'} not pushed yet. Push this branch before opening a pull request; Mingle never pushes implicitly.`);
      const repository = remote.repository;
      const headBranch = tracking.merge.slice('refs/heads/'.length);
      if (!(await isValidBranchName(top, input.base))) throw badRequest(`"${scrub(input.base, 80)}" is not a valid base branch name.`);
      if (input.base === headBranch) throw badRequest('The base branch must differ from the branch being proposed.');

      const notices: string[] = [];
      if (snap.dirty) notices.push('Uncommitted changes are not part of the pull request.');
      const existing = await listPullRequests(repository, headBranch, signal);
      if (!existing.ok) throw new HttpError(502, existing.failure.message);
      const open = existing.data.find((pr) => pr.state === 'OPEN');
      if (open) {
        notices.unshift(`Pull request #${open.number} is already open for ${headBranch}; nothing was created.`);
        return { state, url: open.url, notices };
      }

      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mingle-pr-'));
      try {
        const bodyFile = path.join(dir, 'body.md');
        await fsp.writeFile(bodyFile, input.body, { mode: 0o600 });
        const result = await ghRun([
          'pr', 'create', `--repo=${repository}`, `--head=${headBranch}`, `--base=${input.base}`, `--title=${input.title}`, `--body-file=${bodyFile}`, ...(input.draft ? ['--draft'] : []),
        ], { cwd: dir, timeoutMs: PR_TIMEOUT_MS, signal });
        const url = this.pullRequestUrl(repository, `${result.stdout}\n${result.stderr}`);
        if (result.code !== 0 && !(url && /already exists/i.test(result.stderr))) throw new HttpError(502, classify(result).message);
        if (!url) throw new HttpError(502, `GitHub did not report a pull request URL: ${failureSummary(result.stdout || result.stderr)}`);
        this.reader.invalidate(repository);
        if (result.code !== 0) return { state, url, notices: ['A pull request for this branch already exists; nothing was created.', ...notices] };
        this.store.recordEvent({
          projectId, sessionId: scope.session?.id ?? null, type: 'repository.pull_request.created',
          summary: `Opened ${input.draft ? 'draft ' : ''}pull request for ${headBranch} into ${input.base}`,
          payload: { url, repository, head: headBranch, base: input.base, draft: input.draft, title: scrub(input.title, 200) },
        });
        this.log('info', 'repository pull request created', { projectId, repository });
        return { state, url, notices };
      } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    await Promise.allSettled([...this.inflight]);
    this.reader.clear();
    this.reads.clear();
    this.ciSeen.clear();
    this.prSeen.clear();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private open(): void {
    if (this.closed) throw new HttpError(503, 'The repository service is shutting down.');
  }

  private async guard<T>(task: () => Promise<T>): Promise<T> {
    this.open();
    const promise = task();
    this.inflight.add(promise);
    try {
      return await promise;
    } catch (error) {
      throw this.toHttp(error);
    } finally {
      this.inflight.delete(promise);
    }
  }

  private toHttp(error: unknown): Error {
    if (error instanceof HttpError) return error;
    if (error instanceof GitFailure) return new HttpError(error.timedOut ? 504 : 502, error.message);
    this.log('error', 'repository operation failed', { error: scrub(errorMessage(error)) });
    return new HttpError(500, 'The repository operation failed unexpectedly.');
  }

  /** Coalesces concurrent identical local reads. Mutations never use this; they read fresh inside their lock. */
  private snapshot(scope: Scope): Promise<Snapshot> {
    const key = `${scope.project.id}\0${scope.session?.id ?? ''}`;
    const pending = this.reads.get(key);
    if (pending) return pending;
    const read = readSnapshot(scope, this.abort.signal).finally(() => { if (this.reads.get(key) === read) this.reads.delete(key); });
    this.reads.set(key, read);
    return read;
  }

  /** Serializes by canonical worktree, rereads state under the lock and refuses while any session is running in the same folder. */
  private mutate<T>(projectId: string, sessionId: string | undefined, task: (context: MutationContext) => Promise<T>): Promise<T> {
    return this.guard(async () => {
      const signal = this.abort.signal;
      const first = this.workspace.resolveScope(projectId, sessionId);
      const located = await locate(first.root, signal);
      if (located.kind === 'missing') throw conflict('This folder no longer exists on disk.');
      if (located.kind === 'not-repo') throw unprocessable(located.detail ?? 'This folder is not a Git repository.');
      // The lease is taken synchronously after the path is canonical and before any idle check, so a run that starts later is
      // refused by assertSessionAvailable and a run that started earlier is seen by assertIdle.
      const lease: Lease = { top: located.top, ...(first.session ? { sessionId: first.session.id } : {}) };
      this.leases.add(lease);
      try {
        return await this.locks.run(located.top, async () => {
          this.open();
          const scope = this.workspace.resolveScope(projectId, sessionId);
          const snap = await readSnapshot(scope, signal);
          if (!snap.top || snap.top !== located.top) throw conflict('The repository location changed. Refresh and try again.');
          await this.indexSessionTops(snap.top);
          await this.assertIdle(scope, snap.top);
          return task({ scope, snap, top: snap.top });
        });
      } finally {
        this.leases.delete(lease);
      }
    });
  }

  /**
   * Synchronous guard for the runtime: throws while a repository mutation holds this session's folder. Sessions whose folder
   * overlaps the mutated work tree are refused unless they are known to belong to a different repository (conservative otherwise).
   */
  assertSessionAvailable(session: Session): void {
    if (!this.leases.size) return;
    let real: string;
    try { real = realpathSync(session.worktreePath); } catch { real = path.resolve(session.worktreePath); }
    for (const lease of this.leases) {
      if (lease.sessionId !== session.id) {
        if (!isInside(lease.top, real) && !isInside(real, lease.top)) continue;
        const known = this.topOf.get(real);
        if (known !== undefined && known !== lease.top) continue;
      }
      throw conflict('A repository change (commit, branch switch, push or pull request) is in progress for this folder. Try again in a moment.');
    }
  }

  assertProjectAvailable(projectId: string): void {
    const project = this.store.getProject(projectId);
    if (!project) throw notFound('Project not found');
    if (!this.leases.size) return;
    const roots = [project.path, ...this.store.listSessions(projectId).map((session) => session.worktreePath)].map((root) => {
      try { return realpathSync(root); } catch { return path.resolve(root); }
    });
    if ([...this.leases].some((lease) => roots.some((root) => isInside(lease.top, root) || isInside(root, lease.top)))) {
      throw conflict('Wait for the project’s repository operation to finish before removing it.');
    }
  }

  private async indexSessionTops(top: string): Promise<void> {
    for (const session of this.store.listSessions()) {
      const real = await fsp.realpath(session.worktreePath).catch(() => null);
      if (!real || (!isInside(top, real) && !isInside(real, top))) continue;
      const located = await locate(real, this.abort.signal);
      if (located.kind === 'ok') remember(this.topOf, real, located.top);
    }
  }

  /** Rejects when the scoped session, or any session sharing this work tree (including sessions of nested projects), is running. */
  private async assertIdle(scope: Scope, top: string): Promise<void> {
    const signal = this.abort.signal;
    for (const session of this.store.listSessions()) {
      if (!(this.runtime.isActive(session.id) || session.status === 'running' || session.status === 'waiting')) continue;
      if (session.id === scope.session?.id) throw conflict(`"${session.name}" is running. Wait for it to finish or interrupt it first.`);
      const real = await fsp.realpath(session.worktreePath).catch(() => null);
      if (!real || !isInside(top, real)) continue;
      const located = await locate(real, signal);
      if (located.kind === 'ok' && located.top === top) throw conflict(`Session "${session.name}" is running in this repository folder. Wait for it to finish or interrupt it first.`);
    }
  }

  private expectHead(state: RepositoryState, expected: string | null): void {
    if ((state.head ?? null) !== expected) throw conflict('The branch moved since you last refreshed. Refresh and review before continuing.');
  }

  private requireNoOperation(snap: Snapshot): void {
    if (snap.operation) throw conflict(`A ${snap.operation} is in progress. Finish or abort it outside Mingle first.`);
  }

  private async switchBranch(top: string, args: string[]): Promise<void> {
    const result = await git(top, args, { allowFailure: true, signal: this.abort.signal });
    if (result.code === 0) return;
    const reason = failureSummary(result.stderr || result.stdout);
    throw conflict(/already (?:used by|checked out)/i.test(reason) ? `That branch is checked out in another worktree. ${reason}` : `Git could not switch branches: ${reason}`);
  }

  /** Keeps stored session branch names in step with the actual branch of every session working in this work tree. */
  private async syncSessionBranches(top: string, branch: string): Promise<string[]> {
    const matching: string[] = [];
    for (const session of this.store.listSessions()) {
      if (session.branch === branch) continue;
      const real = await fsp.realpath(session.worktreePath).catch(() => null);
      if (!real || !isInside(top, real)) continue;
      const located = await locate(real, this.abort.signal);
      if (located.kind === 'ok' && located.top === top) matching.push(session.id);
    }
    if (matching.length) this.store.tx(() => { for (const id of matching) this.store.updateSession(id, { branch }); });
    return matching;
  }

  private pushFailure(stderr: string): HttpError {
    const text = stderr.toLowerCase();
    if (/non-fast-forward|fetch first|\(stale info\)|tip of your current branch is behind/.test(text)) {
      return new HttpError(409, 'The remote has commits that this branch does not. Integrate them outside Mingle, then push again; Mingle never force-pushes.');
    }
    if (/permission denied|authentication failed|could not read username|could not read password|terminal prompts disabled|invalid username or password|publickey/.test(text)) {
      return new HttpError(502, 'The remote rejected the credentials. Mingle cannot prompt for them; configure an SSH key or Git credential helper and try again.');
    }
    if (/protected branch|declined|hook declined|rejected/.test(text)) return new HttpError(409, `The remote rejected the push: ${failureSummary(stderr)}`);
    return new HttpError(502, `Push failed: ${failureSummary(stderr)}`);
  }

  private pullRequestUrl(repository: string, text: string): string | null {
    if (!isRepositorySlug(repository)) return null;
    const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`https://github\\.com/${escaped}/pull/\\d+`, 'i').exec(text);
    return match ? match[0] : null;
  }

  private githubRemote(remotes: RemoteInfo[], tracking: Tracking): RemoteInfo | null {
    const candidates = remotes.filter((r) => r.host === 'github.com' && r.repository);
    return candidates.find((r) => r.name === tracking.remote) ?? candidates.find((r) => r.name === 'origin') ?? candidates[0] ?? null;
  }

  private unsupported(notice: string, local?: { branch: string | null; head: string | null }): GitHubState {
    return { status: 'unsupported', repository: null, url: null, branch: local?.branch ?? null, head: local?.head ?? null, pullRequest: null, checks: [], workflows: [], fetchedAt: new Date().toISOString(), notices: [notice] };
  }

  /** Records an event only when CI for the same commit, or a pull request, genuinely changes state between observations. */
  private observe(scope: Scope, state: GitHubReading): void {
    if (state.status !== 'available' || !state.repository || !state.head) return;
    const sessionId = scope.session?.id ?? null;
    const ciKey = `${state.repository}\0${state.head}`;
    const ci = ciSummary(state);
    const previousCi = this.ciSeen.get(ciKey);
    // An incomplete read says nothing reliable about CI, so it neither emits nor becomes the baseline for the next comparison.
    if (ci !== 'unknown') remember(this.ciSeen, ciKey, ci);
    if (ci !== 'unknown' && previousCi !== undefined && previousCi !== ci && (ci === 'success' || ci === 'neutral' || ci === 'failure')) {
      const failing = [...state.checks, ...state.workflows.filter((w) => w.headSha === state.head)].filter((i) => i.conclusion && !['success', 'neutral', 'skipped'].includes(i.conclusion)).slice(0, 10).map((i) => i.name);
      this.store.recordEvent({
        projectId: scope.project.id, sessionId, type: 'repository.checks.changed',
        summary: `Checks ${ci === 'failure' ? 'failed' : ci === 'neutral' ? 'finished without a pass (neutral or skipped)' : 'passed'} for ${state.repository} at ${state.head.slice(0, 7)}`,
        payload: { repository: state.repository, head: state.head, branch: state.branch, from: previousCi, state: ci, failing },
      });
    }
    if (state.pullRequest && state.branch) {
      const prKey = `${state.repository}\0${state.branch}\0${state.pullRequest.number}`;
      const previous = this.prSeen.get(prKey);
      remember(this.prSeen, prKey, state.pullRequest.state);
      if (previous !== undefined && previous !== state.pullRequest.state) {
        this.store.recordEvent({
          projectId: scope.project.id, sessionId, type: 'repository.pull_request.state',
          summary: `Pull request #${state.pullRequest.number} is now ${state.pullRequest.state.toLowerCase()}`,
          payload: { repository: state.repository, number: state.pullRequest.number, url: state.pullRequest.url, from: previous, state: state.pullRequest.state },
        });
      }
    }
  }
}
