import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Exercises packaged Git discovery without an account, network access or inference. */
export async function verifyGitRepositoryDetection(baseUrl, scratch) {
  await mkdir(scratch, { recursive: true });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(environment, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Example packaging check', GIT_AUTHOR_EMAIL: 'example@example.invalid',
    GIT_COMMITTER_NAME: 'Example packaging check', GIT_COMMITTER_EMAIL: 'example@example.invalid',
  });
  const git = (cwd, args) => execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', ...args], { cwd, env: environment, timeout: 10_000, maxBuffer: 256 * 1024, windowsHide: true });
  const source = join(scratch, 'source');
  const checkout = join(scratch, 'Shared café checkout');
  const worktree = join(scratch, 'Linked worktree');
  const plain = join(scratch, 'Plain folder');
  await mkdir(source);
  await mkdir(plain);
  await git(source, ['init', '--quiet', '--initial-branch=main', '--template=']);
  await git(source, ['commit', '--quiet', '--allow-empty', '-m', 'Example packaging fixture']);
  await git(scratch, ['clone', '--quiet', '--no-hardlinks', '--', source, checkout]);
  await git(checkout, ['remote', 'set-url', 'origin', 'https://github.com/example/packaging-check.git']);
  await git(checkout, ['worktree', 'add', '--quiet', '--detach', '--', worktree, 'HEAD']);

  async function request(route, body) {
    const response = await fetch(`${baseUrl}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: await response.json() };
  }
  for (const [name, folder, isRepo] of [['Example cloned project', checkout, true], ['Example linked worktree', worktree, true], ['Example nonrepository', plain, false]]) {
    const opened = await request('/api/projects', { name, path: folder });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    for (const endpoint of ['git', 'repository']) {
      const state = await request(`/api/projects/${opened.body.id}/${endpoint}`);
      assert.equal(state.status, 200, JSON.stringify(state.body));
      assert.equal(state.body.isRepo, isRepo, `${name}: ${endpoint}`);
      if (endpoint === 'repository' && isRepo) assert.equal(state.body.root, await realpath(folder));
    }
    const joined = await request('/api/project-invitations/join', {
      token: 'A'.repeat(43), localProjectId: opened.body.id,
      agent: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised' },
    });
    // A valid checkout must reach the account boundary, before any invitation is accepted.
    assert.equal(joined.status, isRepo ? 401 : 409, JSON.stringify(joined.body));
    if (isRepo) assert.doesNotMatch(joined.body.error, /not an existing Git repository/);
    else assert.match(joined.body.error, /not an existing Git repository/);
  }
  console.log('Packaged Git discovery passed: cloned Unicode/space path, linked worktree, nonrepository and join account boundary.');
}
