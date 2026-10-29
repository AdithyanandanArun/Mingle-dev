import { createHash } from 'node:crypto';
import { git } from './git-run.ts';
import { identityArgs, type GitIdentity } from './identity.ts';
import { isMirrorRemote, remotes } from './inspect.ts';
import { parseRemoteUrl } from './remote.ts';

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const TEAM_BRANCH = /^mingle\/[a-z][a-z0-9_-]{1,31}\/[a-z0-9][a-z0-9-]{0,79}$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const safeRemoteDiagnostic = (text: string) => text
  .replace(/\b(?:https?|ssh|git):\/\/[^\s'"<>]+/gi, '[remote]')
  .replace(/\b[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:[^\s'"<>]+/g, '[remote]');

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

/** Offline-tolerant fetch used only to make a host-supplied integration branch commit available. */
export async function fetchTeamIntegrationBranch(input: {
  worktreePath: string; branch: string; signal?: AbortSignal;
}): Promise<boolean> {
  const { worktreePath, branch, signal } = input;
  if (!SAFE_BRANCH.test(branch) || branch.includes('..') || branch.includes('//') || branch.includes('@{')
    || branch.endsWith('/') || branch.split('/').some((part) => !part || part === '.' || part === '..' || part.endsWith('.lock'))) return false;
  const validRef = await git(worktreePath, ['check-ref-format', `refs/heads/${branch}`], { allowFailure: true, signal });
  if (validRef.code !== 0) return false;
  try { await assertOriginSafe(worktreePath, 'fetch', signal); }
  catch { return false; }
  const fetched = await git(worktreePath, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', branch],
    { network: true, allowFailure: true, signal, timeoutMs: 120_000 });
  return fetched.code === 0;
}

/** Merge origin/<target> into the current integration worktree branch when it has advanced. */
export async function mergeTeamIntegrationTarget(input: {
  worktreePath: string; targetBranch: string; identity?: GitIdentity; signal?: AbortSignal;
}): Promise<boolean> {
  const { worktreePath, targetBranch, identity, signal } = input;
  if (!SAFE_BRANCH.test(targetBranch) || targetBranch.includes('..') || targetBranch.includes('//') || targetBranch.includes('@{')
    || targetBranch.endsWith('/') || targetBranch.split('/').some((part) => !part || part === '.' || part === '..' || part.endsWith('.lock'))) {
    throw new Error('The integration target branch is invalid.');
  }
  const format = await git(worktreePath, ['check-ref-format', `refs/heads/${targetBranch}`], { allowFailure: true, signal });
  if (format.code !== 0) throw new Error('The integration target branch is invalid.');
  const trackingRef = `refs/remotes/origin/${targetBranch}`;
  const fetched = await git(worktreePath, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', `refs/heads/${targetBranch}:${trackingRef}`],
    { network: true, allowFailure: true, signal, timeoutMs: 120_000 });
  if (fetched.code !== 0) throw new Error(`Could not fetch origin/${targetBranch}; accepted work was not published.`);
  const remoteHead = await git(worktreePath, ['rev-parse', '--verify', `${trackingRef}^{commit}`], { signal });
  const alreadyIncluded = await git(worktreePath, ['merge-base', '--is-ancestor', remoteHead.stdout.trim(), 'HEAD'], { allowFailure: true, signal });
  if (alreadyIncluded.code === 0) return false;
  const identityArgsList = await identityArgs(worktreePath, identity);
  const merged = await git(worktreePath, [...identityArgsList, '-c', 'commit.gpgSign=false', 'merge', '--no-edit', trackingRef],
    { allowFailure: true, signal, timeoutMs: 120_000 });
  if (merged.code === 0) return true;
  const unresolved = await git(worktreePath, ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true, signal });
  await git(worktreePath, ['merge', '--abort'], { allowFailure: true, signal });
  if (unresolved.code === 0 && unresolved.stdout.trim()) throw new Error(`origin/${targetBranch} conflicts with the accepted integration.`);
  throw new Error(`Could not merge origin/${targetBranch}.`);
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
  if (result.code !== 0) throw new Error(safeRemoteDiagnostic(result.stderr.trim()).slice(0, 1_500) || 'The origin rejected the team branch push.');
  return { branch, commitSha: head };
}

/** Publishes only the integration worktree's current branch as a normal non-force push; default branches are allowed. */
export async function pushTeamIntegrationBranch(input: {
  worktreePath: string; branch: string; sourceBranch?: string; destinationBranch?: string; expectedHead: string; signal?: AbortSignal;
}): Promise<{ branch: string; commitSha: string }> {
  const { worktreePath, expectedHead, signal } = input;
  const sourceBranch = input.sourceBranch ?? input.branch;
  const destinationBranch = input.destinationBranch ?? input.branch;
  const valid = (branch: string) => SAFE_BRANCH.test(branch) && !branch.includes('..') && !branch.includes('//') && !branch.includes('@{')
    && !branch.endsWith('/') && !branch.split('/').some((part) => !part || part === '.' || part === '..' || part.endsWith('.lock'));
  if (!valid(sourceBranch) || !valid(destinationBranch)
    || !FULL_SHA.test(expectedHead)) throw new Error('The integration branch or commit revision is invalid.');
  const [sourceFormat, destinationFormat] = await Promise.all([sourceBranch, destinationBranch].map((branch) =>
    git(worktreePath, ['check-ref-format', `refs/heads/${branch}`], { allowFailure: true, signal })));
  if (sourceFormat.code !== 0 || destinationFormat.code !== 0) throw new Error('The integration branch is not a valid Git branch name.');
  const [headResult, branchResult] = await Promise.all([
    git(worktreePath, ['rev-parse', '--verify', 'HEAD'], { signal }),
    git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true, signal }),
  ]);
  const head = headResult.stdout.trim();
  if (head.toLowerCase() !== expectedHead.toLowerCase() || branchResult.stdout.trim() !== sourceBranch) {
    throw new Error('The team integration worktree changed before Mingle could publish its branch.');
  }
  await assertOriginSafe(worktreePath, 'push', signal);
  const result = await git(worktreePath,
    ['push', '--no-follow-tags', '--recurse-submodules=no', '--', 'origin', `refs/heads/${sourceBranch}:refs/heads/${destinationBranch}`],
    { network: true, allowFailure: true, signal, timeoutMs: 120_000 });
  if (result.code !== 0) throw new Error(safeRemoteDiagnostic(result.stderr.trim()).slice(0, 1_500) || 'The origin rejected the integration branch push.');
  return { branch: destinationBranch, commitSha: head };
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
  if (fetched.code !== 0) throw new Error(safeRemoteDiagnostic(fetched.stderr.trim()).slice(0, 1_500) || 'The origin branch could not be fetched.');
  const resolved = await git(worktreePath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { signal });
  const fetchedTip = resolved.stdout.trim();
  const containsCommit = await git(worktreePath, ['merge-base', '--is-ancestor', commitSha, fetchedTip], { allowFailure: true, signal });
  if (containsCommit.code !== 0) {
    throw new Error(`Origin branch ${branch} no longer contains the worker-reported commit.`);
  }
  // A stable per-agent branch may advance before this completion envelope reaches the host. Keep
  // the delivery's review ref pinned to its exact reported turn commit, not the later branch tip.
  if (fetchedTip.toLowerCase() !== commitSha.toLowerCase()) {
    await git(worktreePath, ['update-ref', ref, commitSha], { signal });
  }
  return { ref, commitSha };
}
