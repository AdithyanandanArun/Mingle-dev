import type { HandoffSchema, WorkspaceEvent } from '@mingle/contracts';
import { existsSync } from 'node:fs';
import type { z } from 'zod';
import { git, repoInfo } from './git.ts';
import { normalizeRelative } from './paths.ts';
import type { Store } from './store.ts';
import { conflict, notFound, redactSecrets, unprocessable } from './util.ts';

type HandoffInput = z.infer<typeof HandoffSchema>;
/** Internal server-side proof for an authenticated imported artifact; never derived from request fields. */
type ExternalArtifactVerifier = (input: { revision: string; path: string; blob: string }) => boolean | Promise<boolean>;

const REVISION = /^[0-9A-Za-z][0-9A-Za-z._/@{}~^-]{0,99}$/;
const INLINE_LIMIT = 16 * 1024;

export class HandoffService {
  constructor(private readonly store: Store) {}

  /**
   * Records an artifact handoff. The artifact must be a committed regular file at a revision in the source session's
   * history, or an exact external revision authorized by the supplied verifier. Nothing is merged and no provider run
   * is started; the receiving session gets a durable system message included in its next explicit run.
   */
  async create(input: HandoffInput, assertAuthorized?: () => void, verifyExternalArtifact?: ExternalArtifactVerifier): Promise<WorkspaceEvent> {
    if (input.fromSessionId === input.toSessionId) throw unprocessable('Source and target sessions must differ');
    const from = this.store.getSession(input.fromSessionId);
    const to = this.store.getSession(input.toSessionId);
    if (!from || !to) throw notFound('Source or target session not found');
    if (from.projectId !== to.projectId) throw unprocessable('Handoffs are only allowed between sessions of the same project');
    if (input.taskId) {
      const task = this.store.getTask(input.taskId);
      if (!task) throw notFound('Task not found');
      if (task.projectId !== from.projectId) throw unprocessable('Task belongs to a different project');
    }
    const artifactPath = normalizeRelative(input.path);
    if (!artifactPath) throw unprocessable('Artifact path must name a file');
    if (/[*?[\]\\]/.test(artifactPath) || artifactPath.startsWith(':')) throw unprocessable('Artifact path must not contain glob characters');
    if (!REVISION.test(input.revision) || input.revision.includes('..')) throw unprocessable('Revision must be a commit id or ref name');
    if (!existsSync(from.worktreePath)) throw conflict('The source session worktree no longer exists');
    const info = await repoInfo(from.worktreePath);
    if (!info.isRepo || !info.hasHead) throw unprocessable('The source session is not in a Git repository with commits');

    const resolved = await git(from.worktreePath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${input.revision}^{commit}`], { allowFailure: true });
    if (resolved.code !== 0) throw unprocessable(`Revision ${input.revision} does not exist in the source repository`);
    const commit = resolved.stdout.trim();
    const ancestor = await git(from.worktreePath, ['merge-base', '--is-ancestor', commit, 'HEAD'], { allowFailure: true });
    if (ancestor.code !== 0 && ancestor.code !== 1) throw unprocessable('The source revision ancestry could not be verified');

    const entry = await git(from.worktreePath, ['ls-tree', '-z', commit, '--', artifactPath], { allowFailure: true });
    const records = entry.stdout.split('\0').filter(Boolean);
    const match = records.length === 1 ? /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/.exec(records[0]!) : null;
    if (!match) throw unprocessable(`${artifactPath} is not committed at revision ${commit.slice(0, 12)} in the source repository`);
    const [, mode, type, blob] = match;
    if (type !== 'blob' || mode === '120000') throw unprocessable('Artifact must be a regular committed file');

    const size = Number((await git(from.worktreePath, ['cat-file', '-s', blob!])).stdout.trim());
    let inline: string | null = null;
    if (size <= INLINE_LIMIT) {
      const content = (await git(from.worktreePath, ['cat-file', 'blob', blob!])).stdout;
      if (!content.includes('\0')) inline = redactSecrets(content);
    }
    const verifiedExternal = ancestor.code !== 0 && verifyExternalArtifact
      ? await verifyExternalArtifact({ revision: commit, path: artifactPath, blob: blob! }) : false;
    if (ancestor.code !== 0 && !verifiedExternal) {
      throw unprocessable('Revision is not part of the source session history (not reachable from its HEAD)');
    }
    const shortCommit = commit.slice(0, 12);
    const reference = `handoff:${from.id}@${shortCommit}:${artifactPath}#${blob!.slice(0, 12)}`;

    return this.store.tx(() => {
      assertAuthorized?.();
      const content = this.composeMessage({ from: from.name, provider: from.provider, branch: from.branch, worktree: from.worktreePath, artifactPath, commit, blob: blob!, size, reference, note: input.note, inline });
      const message = this.store.insertMessage({ sessionId: to.id, role: 'system', kind: 'handoff', content });
      return this.store.recordEvent({
        projectId: from.projectId, sessionId: to.id, type: 'handoff.created', summary: `Handoff: ${artifactPath} from ${from.name} to ${to.name} @ ${shortCommit}`,
        payload: { fromSessionId: from.id, toSessionId: to.id, taskId: input.taskId ?? null, path: artifactPath, revision: commit, blob, size, reference, messageId: message.id, inlined: inline !== null },
      });
    });
  }

  private composeMessage(d: { from: string; provider: string; branch: string | null; worktree: string; artifactPath: string; commit: string; blob: string; size: number; reference: string; note: string; inline: string | null }): string {
    const lines = [
      `Handoff from session "${d.from}" (${d.provider}).`,
      `Reference: ${d.reference}`,
      `Artifact: ${d.artifactPath} at commit ${d.commit} (blob ${d.blob.slice(0, 12)}, ${d.size} bytes)${d.branch ? ` on branch ${d.branch}` : ''}`,
      `Source worktree (read-only reference, do not modify): ${d.worktree}`,
    ];
    if (d.note.trim()) lines.push('', `Note from sender: ${d.note.trim()}`);
    if (d.inline !== null) {
      const fence = '`'.repeat(Math.max(3, longestBacktickRun(d.inline) + 1));
      lines.push('', `Artifact content:`, `${fence}`, d.inline.replace(/\n$/, ''), fence);
    } else {
      lines.push('', `The artifact is larger than ${INLINE_LIMIT} bytes or binary, so it was not inlined. Read it from the source repository with: git -C <source worktree> show ${d.commit.slice(0, 12)}:${d.artifactPath}`);
    }
    lines.push('', 'Nothing has been merged into your worktree.');
    return lines.join('\n');
  }
}

function longestBacktickRun(text: string): number {
  let max = 0;
  for (const run of text.match(/`+/g) ?? []) max = Math.max(max, run.length);
  return max;
}
