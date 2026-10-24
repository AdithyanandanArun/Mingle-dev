/** Project-first collaboration API client plus its display-oriented roster helpers. */
import type { JoinProjectInvitationInput, ProjectInvitationJoinResult } from '@mingle/contracts';
export interface CollaborationProject {
  teamId: string;
  sharedProjectId: string;
  name: string;
  repositoryUrl: string;
}

export type CollaborationRecord = Record<string, unknown>;
export interface ProjectCollaborationSnapshot {
  project: CollaborationProject | null;
  members: CollaborationRecord[];
  agents: CollaborationRecord[];
  invitations: CollaborationRecord[];
  email: { configured: boolean; message?: string };
  [key: string]: unknown;
}

export interface InvitationPreview {
  invitationId: string;
  projectName: string;
  repositoryUrl: string;
  email: string;
  expiresAt: string;
  role: 'member' | 'admin';
  inviterDisplayName?: string;
  inviterEmail?: string;
  [key: string]: unknown;
}

export type InvitationJoinResult = ProjectInvitationJoinResult;

export interface InvitationCreateResult {
  invitation: CollaborationRecord & { id: string; email: string; expiresAt: string; joinUrl?: string };
  delivery: { status: 'sent' | 'failed' | 'not_configured'; message: string };
  joinUrl?: string;
}

export class CollaborationApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'CollaborationApiError';
  }
}

async function call<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new CollaborationApiError('Cannot reach Mingle’s local runtime. Check that Mingle is still running.', 0);
  }
  const text = await response.text();
  if (!response.ok) {
    let message = '';
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string') message = parsed.error;
    } catch { /* use a short plain-text error when available */ }
    if (!message && text && text.length < 300 && !text.trimStart().startsWith('<')) message = text.trim();
    throw new CollaborationApiError(message || `Request failed with status ${response.status}.`, response.status);
  }
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; }
  catch { throw new CollaborationApiError('Mingle returned an unreadable collaboration response.', response.status); }
}

export const projectCollaborationApi = {
  snapshot: (projectId: string, signal?: AbortSignal) => call<ProjectCollaborationSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/collaboration`, 'GET', undefined, signal),
  invite: (projectId: string, input: { email: string; role: 'member' | 'admin' }) => call<InvitationCreateResult>(`/api/projects/${encodeURIComponent(projectId)}/collaboration/invitations`, 'POST', input),
  preview: (token: string, signal?: AbortSignal) => call<InvitationPreview>('/api/project-invitations/preview', 'POST', { token }, signal),
  join: (input: JoinProjectInvitationInput) => call<InvitationJoinResult>('/api/project-invitations/join', 'POST', input),
};

export function recordText(record: CollaborationRecord | null | undefined, keys: string[], fallback = ''): string {
  if (!record) return fallback;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return fallback;
}

export function recordValue(record: CollaborationRecord | null | undefined, keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return undefined;
}
