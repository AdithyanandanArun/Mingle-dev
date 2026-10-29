import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createCommit } from './commit.ts';
import { identityArgs } from './identity.ts';
import { makeRepo, runGit, tmpDir } from '../test-utils.ts';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

it('uses a validated fallback identity when Git has no configured identity', async () => {
  const repo = makeRepo(); roots.push(repo);
  const home = tmpDir('mingle-no-git-identity-'); roots.push(home);
  const env = { HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  expect(await identityArgs(repo, { name: 'Mingle owner', email: 'owner@example.test' }, env))
    .toEqual(['-c', 'user.name=Mingle owner', '-c', 'user.email=owner@example.test']);
  await expect(identityArgs(repo, { name: 'Invalid\nName', email: 'owner@example.test' }, env))
    .rejects.toThrow(/Set your Git name and email/);
  await expect(identityArgs(repo, undefined, env)).rejects.toThrow(/Set your Git name and email/);
});

it('creates a scoped commit with the fallback when the temporary Git environment has no identity', async () => {
  const repo = makeRepo(); roots.push(repo);
  const home = tmpDir('mingle-no-git-identity-home-'); roots.push(home);
  writeFileSync(path.join(repo, 'result.txt'), 'result\n');
  const head = runGit(repo, 'rev-parse', 'HEAD').trim();
  const result = await createCommit(repo, 'main', head, ['result.txt'], 'team output', {
    sign: false, beforeCommit: async () => undefined, identity: { name: 'Mingle owner', email: 'owner@example.test' },
    env: { HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  expect(runGit(repo, 'show', '-s', '--format=%an <%ae>', result.commit).trim()).toBe('Mingle owner <owner@example.test>');
});
