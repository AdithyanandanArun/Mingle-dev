import { z } from 'zod';
export interface RepositoryChange { path: string; originalPath?: string; status: string; indexStatus: string; worktreeStatus: string; eligible: boolean; reason?: string }
export interface RepositoryState {
  projectId: string; sessionId: string | null; root: string; isRepo: boolean; branch: string | null; head: string | null; detached: boolean;
  branches: { name: string; current: boolean; worktreePath?: string | null }[];
  remotes: { name: string; host: string | null; repository: string | null }[];
  upstream: string | null; ahead: number | null; behind: number | null; changes: RepositoryChange[];
  fetchedAt: string; fingerprint: string; notices: string[];
}
export interface GitHubState {
  status: 'available' | 'unavailable' | 'unsupported'; repository: string | null; url: string | null; branch: string | null; head: string | null;
  pullRequest: { number: number; title: string; url: string; state: string; isDraft: boolean; baseBranch: string; headBranch: string } | null;
  checksComplete?: boolean; workflowsComplete?: boolean;
  checks: { id: string; name: string; status: string; conclusion: string | null; url: string | null }[];
  workflows: { id: string; name: string; title: string; status: string; conclusion: string | null; url: string; headSha: string; branch: string; createdAt: string; updatedAt: string }[];
  fetchedAt: string; notices: string[];
}
const sessionId = z.string().min(1).max(100).optional();
const expectedHead = z.string().regex(/^[0-9a-f]{40,64}$/).nullable();
const safeText = z.string().refine(v => !/[\0\r\n]/.test(v), 'Contains control characters');
export const RepositoryCommitSchema = z.object({ sessionId, expectedHead, expectedFingerprint: z.string().min(1).max(100), message: z.string().trim().min(1).max(10000).refine(v => !v.includes('\0'), 'Commit message contains a NUL byte'), paths: z.array(z.string().min(1).max(4096)).min(1).max(500) }).strict();
export const RepositoryPushSchema = z.object({ sessionId, expectedHead, remote: safeText.pipe(z.string().min(1).max(100)).optional() }).strict();
export const RepositoryBranchSchema = z.object({ sessionId, expectedHead, name: safeText.pipe(z.string().min(1).max(200)), create: z.boolean().default(false) }).strict();
export const RepositoryPullRequestSchema = z.object({ sessionId, expectedHead, title: z.string().trim().min(1).max(250).refine(v => !/[\0\r\n]/.test(v), 'Pull request title contains control characters'), body: z.string().max(50000).default(''), base: safeText.pipe(z.string().min(1).max(200)), draft: z.boolean().default(false) }).strict();
export type RepositoryCommit = z.infer<typeof RepositoryCommitSchema>;
export type RepositoryPush = z.infer<typeof RepositoryPushSchema>;
export type RepositoryBranch = z.infer<typeof RepositoryBranchSchema>;
export type RepositoryPullRequest = z.infer<typeof RepositoryPullRequestSchema>;
export interface RepositoryMutationResult { state: RepositoryState; commit?: string; url?: string; notices: string[] }
export const InitializeGitSchema = z.object({ createGitHub: z.object({ name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/), visibility: z.enum(['private', 'public']) }).strict().optional() }).strict();
export type InitializeGitRequest = z.infer<typeof InitializeGitSchema>;
export interface InitializeGitResult { repository: RepositoryState; github: { status: 'created'; url: string } | { status: 'unavailable'; reason: string } | null; notices: string[] }
