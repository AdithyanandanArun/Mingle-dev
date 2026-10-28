import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { makeRepo, runGit, tmpDir } from '../test-utils.ts';
import { fetchTeamCompletionBranch, pushTeamCompletionBranch, teamCompletionBranch } from './team-branch.ts';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function bareOrigin(repo: string): { root: string; origin: string; base: string } {
  const root = tmpDir('mingle-team-remote-'); roots.push(root);
  const origin = path.join(root, 'origin.git');
  mkdirSync(origin);
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
  runGit(repo, 'remote', 'add', 'origin', origin);
  runGit(repo, 'push', '-u', 'origin', 'main');
  return { root, origin, base: runGit(repo, 'rev-parse', 'HEAD').trim() };
}

it('pushes only the dedicated mingle branch to origin without changing main or creating tags', async () => {
  const repo = makeRepo(); roots.push(repo);
  const { origin, base } = bareOrigin(repo);
  const branch = teamCompletionBranch('sam', 'Task 42 / UI', 'delivery-unique-42');
  expect(branch).toMatch(/^mingle\/sam\/task-42-ui-[0-9a-f]{10}$/);
  runGit(repo, 'switch', '-c', branch);
  runGit(repo, 'config', 'user.name', 'Worker');
  runGit(repo, 'config', 'user.email', 'worker@example.test');
  runGit(repo, 'commit', '--allow-empty', '-m', 'worker result');
  const expectedHead = runGit(repo, 'rev-parse', 'HEAD').trim();

  const pushed = await pushTeamCompletionBranch({ worktreePath: repo, branch, expectedHead });
  expect(pushed).toEqual({ branch, commitSha: expectedHead });
  expect(runGit(origin, 'rev-parse', 'refs/heads/main').trim()).toBe(base);
  expect(runGit(origin, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(expectedHead);
  expect(runGit(origin, 'tag', '--list').trim()).toBe('');
});

it('reports missing origin instead of pretending a worker branch was published', async () => {
  const repo = makeRepo(); roots.push(repo);
  const branch = teamCompletionBranch('sam', 'task-1', 'delivery-1');
  runGit(repo, 'switch', '-c', branch);
  await expect(pushTeamCompletionBranch({ worktreePath: repo, branch, expectedHead: runGit(repo, 'rev-parse', 'HEAD').trim() }))
    .rejects.toThrow('no origin remote');
});

it('does not force-update an existing worker branch after a non-fast-forward result', async () => {
  const repo = makeRepo(); roots.push(repo);
  const { origin, base } = bareOrigin(repo);
  const branch = teamCompletionBranch('sam', 'task-1', 'delivery-1');
  runGit(repo, 'switch', '-c', branch);
  runGit(repo, 'config', 'user.name', 'Worker');
  runGit(repo, 'config', 'user.email', 'worker@example.test');
  runGit(repo, 'commit', '--allow-empty', '-m', 'first worker result');
  const remoteCommit = runGit(repo, 'rev-parse', 'HEAD').trim();
  await pushTeamCompletionBranch({ worktreePath: repo, branch, expectedHead: remoteCommit });

  runGit(repo, 'reset', '--hard', base);
  runGit(repo, 'commit', '--allow-empty', '-m', 'divergent local result');
  const divergentCommit = runGit(repo, 'rev-parse', 'HEAD').trim();
  await expect(pushTeamCompletionBranch({ worktreePath: repo, branch, expectedHead: divergentCommit })).rejects.toThrow();
  expect(runGit(origin, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(remoteCommit);
});

it('fetches an exact worker commit to a delivery-specific review ref without checking it out', async () => {
  const repo = makeRepo(); roots.push(repo);
  const { origin } = bareOrigin(repo);
  const branch = teamCompletionBranch('sam', 'task-1', 'delivery-1');
  runGit(repo, 'switch', '-c', branch);
  runGit(repo, 'config', 'user.name', 'Worker');
  runGit(repo, 'config', 'user.email', 'worker@example.test');
  runGit(repo, 'commit', '--allow-empty', '-m', 'worker result');
  const commitSha = runGit(repo, 'rev-parse', 'HEAD').trim();
  await pushTeamCompletionBranch({ worktreePath: repo, branch, expectedHead: commitSha });

  // Use a second clone as the host's integration repository.
  const hostRepo = path.join(tmpDir('mingle-team-host-'), 'host'); roots.push(path.dirname(hostRepo));
  execFileSync('git', ['clone', '-q', origin, hostRepo]);
  const branchResult = runGit(hostRepo, 'branch', '--show-current').trim();
  const fetched = await fetchTeamCompletionBranch({ worktreePath: hostRepo, branch, commitSha, deliveryId: 'host-delivery-1' });
  expect(fetched.commitSha).toBe(commitSha);
  expect(fetched.ref).toMatch(/^refs\/mingle\/team\/review\/[0-9a-f]{24}$/);
  expect(runGit(hostRepo, 'rev-parse', fetched.ref).trim()).toBe(commitSha);
  expect(runGit(hostRepo, 'branch', '--show-current').trim()).toBe(branchResult);
});
