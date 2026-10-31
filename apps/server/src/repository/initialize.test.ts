import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, repoInfo } from '../git.ts';
import { tmpDir } from '../test-utils.ts';
import { initializeProjectRepository } from './initialize.ts';

const dirs: string[] = [];
const folder = () => { const dir = tmpDir('mingle-git-init-'); dirs.push(dir); return dir; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('project Git initialization', () => {
  it('initializes main with a minimal ignore file and an initial commit', async () => {
    const cwd = folder();
    writeFileSync(path.join(cwd, 'README.md'), '# Demo\n');
    const result = await initializeProjectRepository({ cwd, fallbackIdentity: { name: 'Mingle User', email: 'user@example.test' }, getState: async () => ({}) as never });
    expect(result.notices).toEqual([]);
    expect(readFileSync(path.join(cwd, '.gitignore'), 'utf8')).toContain('node_modules/');
    expect(await repoInfo(cwd)).toMatchObject({ isRepo: true, hasHead: true, branch: 'main' });
    expect((await git(cwd, ['log', '-1', '--format=%s'])).stdout.trim()).toBe('Initial commit');
  });

  it('leaves a user ignore file intact and adds environment secrets to it', async () => {
    const cwd = folder();
    writeFileSync(path.join(cwd, '.gitignore'), 'custom-cache/\n');
    writeFileSync(path.join(cwd, '.env'), 'SECRET=do-not-commit\n');
    writeFileSync(path.join(cwd, 'id_rsa'), 'private-key\n');
    const result = await initializeProjectRepository({ cwd, fallbackIdentity: { name: 'Mingle User', email: 'user@example.test' }, getState: async () => ({}) as never });
    const ignore = readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    expect(ignore).toContain('custom-cache/');
    expect(ignore).toContain('.env*');
    expect(ignore).toContain('id_rsa');
    expect(result.notices).toHaveLength(2);
    expect((await git(cwd, ['ls-tree', '-r', '--name-only', 'HEAD'])).stdout).not.toMatch(/\.env|id_rsa/);
  });

  it('passes validated GitHub argv and returns the created URL', async () => {
    const cwd = folder();
    const calls: Array<{ args: string[]; cwd?: string; timeoutMs?: number }> = [];
    const runner = vi.fn(async (args: string[], options: { cwd?: string; timeoutMs?: number }) => {
      calls.push({ args, ...options });
      return { stdout: args[0] === 'repo' ? 'https://github.com/acme/demo\n' : '', stderr: '', code: 0, timedOut: false, aborted: false, truncated: false, spawnError: null };
    });
    const result = await initializeProjectRepository({ cwd, github: { name: 'demo', visibility: 'private' }, runGh: runner as never, fallbackIdentity: { name: 'Mingle User', email: 'user@example.test' }, getState: async () => ({}) as never });
    expect(calls.map((call) => call.args)).toEqual([
      ['auth', 'status'],
      ['repo', 'create', 'demo', '--private', '--source', '.', '--remote', 'origin', '--push'],
    ]);
    expect(calls.every((call) => call.cwd === cwd)).toBe(true);
    expect(calls[1]?.timeoutMs).toBe(60_000);
    expect(result.github).toEqual({ status: 'created', url: 'https://github.com/acme/demo' });
  });

  it('refuses an existing repository', async () => {
    const cwd = folder();
    await git(cwd, ['init', '-b', 'main']);
    await expect(initializeProjectRepository({ cwd, fallbackIdentity: { name: 'Mingle User', email: 'user@example.test' }, getState: async () => ({}) as never })).rejects.toMatchObject({ status: 409 });
  });

  it('skips files larger than 50 MB', async () => {
    const cwd = folder();
    mkdirSync(path.join(cwd, 'oversized'));
    const file = path.join(cwd, 'oversized', 'large.bin');
    const fd = openSync(file, 'w');
    ftruncateSync(fd, 50 * 1024 * 1024 + 1);
    closeSync(fd);
    const result = await initializeProjectRepository({ cwd, fallbackIdentity: { name: 'Mingle User', email: 'user@example.test' }, getState: async () => ({}) as never });
    expect(result.notices.join(' ')).toMatch(/larger than 50 MB/);
    expect((await git(cwd, ['ls-tree', '-r', '--name-only', 'HEAD'])).stdout).not.toContain('large.bin');
  });
  it('commits an empty folder and keeps .env.example tracked', async () => {
    const empty = folder();
    await initializeProjectRepository({ cwd: empty, fallbackIdentity: { name: 'Mingle User', email: 'user@example.test' }, getState: async () => ({}) as never });
    expect(await repoInfo(empty)).toMatchObject({ isRepo: true, hasHead: true });
    const cwd = folder();
    writeFileSync(path.join(cwd, '.env.example'), 'API_KEY=\n');
    writeFileSync(path.join(cwd, '.env'), 'API_KEY=secret\n');
    await initializeProjectRepository({ cwd, fallbackIdentity: { name: 'Mingle User', email: 'user@example.test' }, getState: async () => ({}) as never });
    const tracked = (await git(cwd, ['ls-tree', '-r', '--name-only', 'HEAD'])).stdout.split('\n');
    expect(tracked).toContain('.env.example');
    expect(tracked).not.toContain('.env');
  });
});
