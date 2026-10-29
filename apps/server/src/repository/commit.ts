import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeniedName } from '../paths.ts';
import { HttpError, conflict, unprocessable } from '../util.ts';
import { git, GitFailure } from './git-run.ts';
import { identityArgs, type GitIdentity } from './identity.ts';

export interface CreatedCommit { commit: string; paths: string[]; indexSynced: boolean }

export interface CommitOptions {
  /** The user's Git configuration requires signed commits (commit.gpgsign). */
  sign: boolean;
  /** Runs after the private tree is built and just before the commit object is written; throw to abort. */
  beforeCommit: () => Promise<void>;
  signal?: AbortSignal;
  identity?: GitIdentity;
  env?: Record<string, string>;
}

interface RawChange { oldMode: string; newMode: string; newSha: string; status: string; path: string }

function parseRawDiff(output: string): RawChange[] {
  const tokens = output.split('\0');
  const changes: RawChange[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i]!;
    if (!meta.startsWith(':')) break;
    const [oldMode, newMode, , newSha, status] = meta.slice(1).split(' ');
    changes.push({ oldMode: oldMode!, newMode: newMode!, newSha: newSha!, status: status![0]!, path: tokens[i + 1]! });
  }
  return changes;
}

/**
 * Commits exactly `paths` (current work-tree content) on top of `head` without touching unrelated staged or unstaged work.
 * The commit is built in a private index seeded from HEAD, the branch is advanced with a compare-and-swap, and only then are the
 * committed paths refreshed in the real index. Nothing is reset, discarded or force-updated.
 */
export async function createCommit(top: string, branch: string, head: string | null, paths: string[], message: string, options: CommitOptions): Promise<CreatedCommit> {
  const { signal } = options;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mingle-index-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    if (head) await git(top, ['read-tree', head], { env, signal });
    else await git(top, ['read-tree', '--empty'], { env, signal });
    const listed = new Set(paths);
    await git(top, ['update-index', '--add', '--remove', '-z', '--stdin'], { env, stdin: `${paths.join('\0')}\0`, signal });
    const tree = (await git(top, ['write-tree'], { env, signal })).stdout.trim();
    const baseTree = head
      ? (await git(top, ['rev-parse', '--verify', `${head}^{tree}`], { signal })).stdout.trim()
      : (await git(top, ['hash-object', '-t', 'tree', '--stdin'], { stdin: '', signal })).stdout.trim();
    if (tree === baseTree) throw conflict('The selected files have no changes to commit.');

    const raw = await git(top, ['diff-tree', '-r', '--no-renames', '--raw', '-z', '--no-ext-diff', baseTree, tree], { signal });
    const changes = parseRawDiff(raw.stdout);
    for (const change of changes) {
      if (!listed.has(change.path)) throw conflict('Committing the selection would also change files that were not selected (a path replaced by a directory?). Nothing was committed.');
      if (change.newMode === '160000' || change.oldMode === '160000') throw unprocessable('Submodule changes are not committed from Mingle.');
      if (change.path.split('/').some(isDeniedName)) throw unprocessable('A protected file was part of the selection. Nothing was committed.');
    }

    await options.beforeCommit();

    const subject = (message.split('\n', 1)[0] ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
    const commit = await writeCommit(top, tree, head, message, options);
    const ref = `refs/heads/${branch}`;
    await requireBranchCheckedOut(top, ref, signal);
    try {
      // Advance the captured branch explicitly (never "whatever HEAD is now"), and only from the HEAD that was reviewed.
      await git(top, ['update-ref', '-m', `commit: ${subject}`, ref, commit, head ?? '0'.repeat(commit.length)], { signal });
    } catch (error) {
      if (error instanceof GitFailure && !error.timedOut) throw conflict(`The branch moved while committing, so nothing was committed. Refresh and try again. (${error.message})`);
      throw error;
    }

    // Make the real index agree with the new HEAD for exactly the committed paths; every other staged entry is left alone.
    const entries = changes.map((c) => (c.status === 'D' ? `0 ${'0'.repeat(c.newSha.length)}\t${c.path}` : `${c.newMode} ${c.newSha}\t${c.path}`));
    let indexSynced = true;
    try {
      await requireBranchCheckedOut(top, ref, signal); // HEAD must still be the branch we just advanced
      await git(top, ['update-index', '-z', '--index-info'], { stdin: `${entries.join('\0')}\0`, signal });
    } catch {
      indexSynced = false;
    }
    return { commit, paths: changes.map((c) => c.path), indexSynced };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeCommit(top: string, tree: string, head: string | null, message: string, options: CommitOptions): Promise<string> {
  const args = [...await identityArgs(top, options.identity, options.env), 'commit-tree', ...(options.sign ? ['-S'] : []), tree, ...(head ? ['-p', head] : [])];
  try {
    const result = await git(top, args, { stdin: `${message.replace(/\s+$/, '')}\n`, signal: options.signal, env: options.env, detached: options.sign, timeoutMs: options.sign ? 60_000 : 20_000 });
    return result.stdout.trim();
  } catch (error) {
    if (!options.sign || !(error instanceof GitFailure)) throw error;
    // Never fall back to an unsigned commit when the user's configuration asks for signing.
    throw new HttpError(422, error.timedOut
      ? 'Commit signing timed out waiting for your signing key. Nothing was committed. Unlock the key (for example with your gpg-agent) and try again.'
      : `Commit signing failed and nothing was committed. Mingle cannot show a passphrase prompt, so unlock your signing key (for example with your gpg-agent) or change commit.gpgsign in your Git configuration. ${error.message}`);
  }
}

async function requireBranchCheckedOut(top: string, ref: string, signal?: AbortSignal): Promise<void> {
  const current = await git(top, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true, signal });
  if (current.code !== 0 || current.stdout.trim() !== ref) throw conflict('HEAD no longer points at the branch being committed to. Nothing was committed; refresh and try again.');
}
