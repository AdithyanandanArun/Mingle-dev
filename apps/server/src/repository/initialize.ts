import fsp from 'node:fs/promises';
import type { InitializeGitResult } from '@mingle/contracts';
import { initializeRepository, repoInfo } from '../git.ts';
import { conflict, HttpError, notFound } from '../util.ts';
import { ghRun, classify } from './gh.ts';
import { identityArgs } from './identity.ts';
import type { GitIdentity } from './identity.ts';

export interface InitializeRepositoryOptions {
  cwd: string;
  github?: { name: string; visibility: 'private' | 'public' };
  fallbackIdentity?: GitIdentity;
  runGh?: typeof ghRun;
  getState: () => Promise<InitializeGitResult['repository']>;
}

export async function initializeProjectRepository(options: InitializeRepositoryOptions): Promise<InitializeGitResult> {
  const { cwd } = options;
  const exists = await fsp.stat(cwd).catch(() => null);
  if (!exists?.isDirectory()) throw notFound('Project folder does not exist.');
  const info = await repoInfo(cwd);
  if (info.isRepo) throw conflict('This folder is already inside a Git repository.');

  let identity: string[];
  try { identity = await identityArgs(cwd, options.fallbackIdentity); }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Set your Git name and email, then retry.'); }
  const initialized = await initializeRepository(cwd, identity);
  let github: InitializeGitResult['github'] = null;
  if (options.github) {
    const runGh = options.runGh ?? ghRun;
    const auth = await runGh(['auth', 'status'], { cwd, timeoutMs: 15_000 });
    if (auth.code !== 0 || auth.spawnError) {
      github = { status: 'unavailable', reason: auth.spawnError?.code === 'ENOENT' ? `${classify(auth).message} Install GitHub CLI and run \`gh auth login\`, or connect GitHub in Mingle.` : `GitHub CLI authentication is unavailable. Install GitHub CLI and run \`gh auth login\`, or connect GitHub in Mingle.` };
    } else {
      const result = await runGh(['repo', 'create', options.github.name, options.github.visibility === 'private' ? '--private' : '--public', '--source', '.', '--remote', 'origin', '--push'], { cwd, timeoutMs: 60_000 });
      if (result.code === 0 && !result.spawnError) {
        const url = result.stdout.trim().split(/\s+/).find((value) => /^https:\/\/github\.com\//.test(value)) ?? `https://github.com/${options.github.name}`;
        github = { status: 'created', url };
      } else {
        const failure = classify(result);
        github = { status: 'unavailable', reason: failure.message };
      }
    }
  }
  return { repository: await options.getState(), github, notices: initialized.notices };
}
