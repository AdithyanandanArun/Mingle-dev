import { createHash } from 'node:crypto';
import { git } from './git-run.ts';
import { isMirrorRemote, remotes } from './inspect.ts';
import { parseRemoteUrl } from './remote.ts';

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const TEAM_BRANCH = /^mingle\/[a-z][a-z0-9_-]{1,31}\/[a-z0-9][a-z0-9-]{0,79}$/;

function slug(value: string, max: number): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
}

function workerSlug(handle: string): string {
  const worker = slug(handle, 32).replace(/-+/g, '-') || 'agent';
  return (/^[a-z]/.test(worker) ? worker : `agent-${worker}`).slice(0, 32);
}

/** Permanent branch shared by every delivery for one cross-device worker. */
export function teamAgentBranch(handle: string): string {
  return `mingle/${workerSlug(handle)}/work`;
}

/** Unique reserved ref for one worker delivery; never derives a push destination from model text. */
export function teamCompletionBranch(handle: string, taskOrDeliveryId: string, deliveryId: string): string {
  const safeWorker = workerSlug(handle);
  const task = slug(taskOrDeliveryId, 60) || 'delivery';
  const suffix = createHash('sha256').update(deliveryId).digest('hex').slice(0, 10);
  return `mingle/${safeWorker.slice(0, 32)}/${task.slice(0, 60)}-${suffix}`;
}

/** Best-effort refresh of one worker's stable branch into the local origin-tracking namespace. */
export async function fetchTeamAgentBranch(input: {
  worktreePath: string; branch: string; signal?: AbortSignal;
}): Promise<string | null> {
  const { worktreePath, branch, signal } = input;
  if (!TEAM_BRANCH.test(branch)) throw new Error('The team agent branch is invalid.');
  try { await assertOriginSafe(worktreePath, 'fetch', signal); }
  catch { return null; }
  await git(worktreePath,
    ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`],
    { network: true, allowFailure: true, signal, timeoutMs: 120_000 });
  const tracked = await git(worktreePath,
    ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], { allowFailure: true, signal });
  if (tracked.code !== 0) return null;
  // A failed fetch may simply mean the network is offline. An existing tracking ref remains a
  // usable fallback, but never expose remote stderr (which can contain credentials or URLs).
  return tracked.stdout.trim();
}

async function assertOriginSafe(top: string, action: 'push' | 'fetch', signal?: AbortSignal): Promise<void> {
  const available = await remotes(top, signal);
  const origin = available.find((remote) => remote.name === 'origin');
  if (!origin) throw new Error(`The shared project has no origin remote; Mingle could not ${action} the team branch.`);
  if (origin.credentials) throw new Error('The origin push URL embeds credentials. Mingle will not publish a team branch; configure SSH or a Git credential helper.');
  if (await isMirrorRemote(top, 'origin', signal)) throw new Error('Origin is configured as a mirror, which could overwrite remote branches. Mingle will not publish a team branch.');

  // Fetch and push URLs can differ. Require one explicit destination and inspect effective URLs,
  // including insteadOf expansion, without returning either URL in errors or logs.
  const [fetchUrls, pushUrls] = await Promise.all([false, true].map(async (push) => {
    const result = await git(top, ['remote', 'get-url', ...(push ? ['--push'] : []), '--all', 'origin'], { allowFailure: true, signal });
    return result.code === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  }));
  if (fetchUrls.length !== 1 || pushUrls.length !== 1) {
    throw new Error('Origin must have exactly one fetch and push destination before Mingle can use a team branch.');
  }
  if (fetchUrls[0] !== pushUrls[0]) {
    throw new Error('Origin fetch and push destinations differ. Mingle will not publish a team branch to an ambiguous remote.');
  }
  const configuredUrls = await Promise.all(['remote.origin.url', 'remote.origin.pushurl'].map(async (key) => {
    const result = await git(top, ['config', '--get-all', key], { allowFailure: true, signal });
    return result.code === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  }));
  if ([...fetchUrls, ...pushUrls, ...configuredUrls.flat()].some((url) => parseRemoteUrl(url).credentials)) {
    throw new Error(`The origin ${action} URL embeds credentials. Mingle will not use it; configure SSH or a Git credential helper.`);
  }
}

/** Pushes only an explicitly generated reserved team branch. No tags, force flags, or default-branch target are accepted. */
export async function pushTeamCompletionBranch(input: {
  worktreePath: string; branch: string; expectedHead: string; signal?: AbortSignal;
}): Promise<{ branch: string; commitSha: string }> {
  const { worktreePath, branch, expectedHead, signal } = input;
  if (!TEAM_BRANCH.test(branch) || !FULL_SHA.test(expectedHead)) throw new Error('The completion branch or commit revision is invalid.');
  const format = await git(worktreePath, ['check-ref-format', `refs/heads/${branch}`], { allowFailure: true, signal });
  if (format.code !== 0) throw new Error('The generated team branch is not a valid Git branch name.');
  const [headResult, branchResult] = await Promise.all([
    git(worktreePath, ['rev-parse', '--verify', 'HEAD'], { signal }),
    git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true, signal }),
  ]);
  const head = headResult.stdout.trim();
  if (head.toLowerCase() !== expectedHead.toLowerCase() || branchResult.stdout.trim() !== branch) {
    throw new Error('The isolated completion worktree changed before Mingle could publish its branch.');
  }
  await assertOriginSafe(worktreePath, 'push', signal);
  const defaultBranch = await git(worktreePath, ['ls-remote', '--symref', 'origin', 'HEAD'], { network: true, allowFailure: true, signal });
  if (defaultBranch.code !== 0) throw new Error('Mingle could not verify origin’s default branch and refused to publish the worker branch.');
  const defaultRef = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(defaultBranch.stdout)?.[1];
  if (defaultRef === branch) throw new Error('Mingle refused to publish a team completion to origin’s default branch.');
  const result = await git(worktreePath, ['push', '--no-follow-tags', '--recurse-submodules=no', '--', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], {
    network: true, allowFailure: true, signal, timeoutMs: 120_000,
  });
  if (result.code !== 0) throw new Error(result.stderr.trim().slice(0, 1_500) || 'The origin rejected the team branch push.');
  return { branch, commitSha: head };
}

/** Fetches a worker branch into a delivery-specific review ref without checking it out or moving HEAD. */
export async function fetchTeamCompletionBranch(input: {
  worktreePath: string; branch: string; commitSha: string; deliveryId: string; signal?: AbortSignal;
}): Promise<{ ref: string; commitSha: string }> {
  const { worktreePath, branch, commitSha, deliveryId, signal } = input;
  if (!TEAM_BRANCH.test(branch) || !FULL_SHA.test(commitSha)) throw new Error('The remote completion branch or commit revision is invalid.');
  await assertOriginSafe(worktreePath, 'fetch', signal);
  const suffix = createHash('sha256').update(deliveryId).digest('hex').slice(0, 24);
  const ref = `refs/mingle/team/review/${suffix}`;
  const current = await git(worktreePath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true, signal });
  if (current.code === 0) {
    if (current.stdout.trim().toLowerCase() !== commitSha.toLowerCase()) throw new Error('A different commit already occupies this delivery’s local review ref.');
    return { ref, commitSha: current.stdout.trim() };
  }
  const refspec = `refs/heads/${branch}:${ref}`;
  const fetched = await git(worktreePath, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', refspec], {
    network: true, allowFailure: true, signal, timeoutMs: 120_000,
  });
  if (fetched.code !== 0) throw new Error(fetched.stderr.trim().slice(0, 1_500) || 'The origin branch could not be fetched.');
  const resolved = await git(worktreePath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { signal });
  if (resolved.stdout.trim().toLowerCase() !== commitSha.toLowerCase()) {
    throw new Error(`Origin branch ${branch} no longer points at the worker-reported commit.`);
  }
  return { ref, commitSha: resolved.stdout.trim() };
}
