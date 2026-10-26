import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git as appGit, gitStatus, repoInfo } from './git.ts';
import { gitNullPath } from './git-null-path.ts';
import { runGit as distributedGit } from './distributed/git-common.ts';
import { git as repositoryGit } from './repository/git-run.ts';
import { locate } from './repository/inspect.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mingle-git-null-path-'));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return { root };
}

async function initRepo(root: string, committed: boolean): Promise<void> {
  mkdirSync(root, { recursive: true });
  const initialized = await distributedGit(root, ['init', '-q', '--initial-branch=main', '--template=']);
  expect(initialized.code).toBe(0);
  if (!committed) return;
  writeFileSync(path.join(root, 'README.md'), 'A real disposable repository\n');
  expect((await distributedGit(root, ['add', 'README.md'])).code).toBe(0);
  expect((await distributedGit(root, ['-c', 'user.name=Disposable Test', '-c', 'user.email=disposable@example.invalid', 'commit', '-q', '-m', 'initial'])).code).toBe(0);
}

async function expectAllRunnersToDetect(root: string): Promise<void> {
  const app = await appGit(root, ['rev-parse', '--is-inside-work-tree']);
  expect(app.stdout.trim()).toBe('true');

  const repository = await repositoryGit(root, ['rev-parse', '--is-inside-work-tree'], {
    env: { GIT_CONFIG_GLOBAL: gitNullPath(), GIT_CONFIG_NOSYSTEM: '1' },
  });
  expect(repository.stdout.trim()).toBe('true');

  const distributed = await distributedGit(root, ['rev-parse', '--is-inside-work-tree']);
  expect(distributed.stdout.toString('utf8').trim()).toBe('true');

  expect(await repoInfo(root)).toMatchObject({ isRepo: true });
  expect(await locate(root)).toMatchObject({ kind: 'ok' });
}

function isolatedGitEnv(globalConfig = gitNullPath()): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

describe('Git-specific null path', () => {
  it('uses real Git to detect, clone, and inspect committed, unborn, and linked worktree repositories with Unicode and spaces', async () => {
    const { root } = fixture();
    const source = path.join(root, 'source repo – café');
    await initRepo(source, true);
    await expectAllRunnersToDetect(source);

    // The legacy status path uses the Git null path as the first side of --no-index.
    writeFileSync(path.join(source, 'untracked – résumé.txt'), 'visible untracked content\n');
    expect((await gitStatus(source)).diff).toContain('+visible untracked content');

    // The distributed runner's null global-config path must remain a valid Git config file.
    const globalConfig = await distributedGit(source, ['config', '--global', '--list']);
    expect(globalConfig.code).toBe(0);
    expect(globalConfig.stdout.toString('utf8')).toBe('');
    const directGlobalConfig = spawnSync('git', ['config', '--global', '--list'], {
      cwd: source,
      env: isolatedGitEnv(),
      encoding: 'utf8',
    });
    expect(directGlobalConfig.status).toBe(0);
    expect(directGlobalConfig.stdout).toBe('');

    const clone = path.join(root, 'cloned project – 東京 with spaces');
    const cloned = await distributedGit(root, ['clone', '-q', source, clone]);
    expect(cloned.code).toBe(0);
    await expectAllRunnersToDetect(clone);

    const unborn = path.join(root, 'unborn repo – naïve');
    await initRepo(unborn, false);
    await expectAllRunnersToDetect(unborn);
    expect(await repoInfo(unborn)).toMatchObject({ isRepo: true, hasHead: false, branch: 'main' });

    const worktree = path.join(root, 'linked worktree – 東京 with spaces');
    const added = await repositoryGit(clone, ['worktree', 'add', '-b', 'null-path-worktree', '--', worktree, 'HEAD'], {
      env: { GIT_CONFIG_GLOBAL: gitNullPath(), GIT_CONFIG_NOSYSTEM: '1' },
    });
    expect(added.code).toBe(0);
    await expectAllRunnersToDetect(worktree);
  });

  it.skipIf(process.platform !== 'win32')('keeps Git working with the helper when raw Node os.devNull is rejected', async () => {
    const { root } = fixture();
    const repository = path.join(root, 'windows null-device repository');
    await initRepo(repository, true);

    const rawNodeNull = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repository,
      env: isolatedGitEnv(os.devNull),
      encoding: 'utf8',
    });
    const gitNull = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repository,
      env: isolatedGitEnv(gitNullPath()),
      encoding: 'utf8',
    });

    expect(gitNull.status).toBe(0);
    expect(gitNull.stdout.trim()).toBe('true');
    if (rawNodeNull.status !== 0) expect(rawNodeNull.stderr).toMatch(/unable to access.*nul.*invalid argument/i);
  });

});
