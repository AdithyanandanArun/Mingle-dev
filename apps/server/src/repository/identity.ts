import { git } from './git-run.ts';

export interface GitIdentity { name?: string | null; email?: string | null }

/** Git configuration wins; otherwise return a validated per-command identity from the signed-in owner. */
export async function identityArgs(cwd: string, fallback?: GitIdentity): Promise<string[]> {
  const configured = await git(cwd, ['var', 'GIT_COMMITTER_IDENT'], { allowFailure: true });
  if (configured.code === 0) return [];
  const name = fallback?.name?.trim() ?? '';
  const email = fallback?.email?.trim() ?? '';
  if (!name || !email || /[\r\n<>]/.test(name) || /[\r\n<>]/.test(email)) {
    throw new Error('Git needs a committer identity. Set your Git name and email (git config --global user.name/user.email), then retry.');
  }
  return ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
}
