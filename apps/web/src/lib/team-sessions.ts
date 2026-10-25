import type {
  AddTeamAgent, GroupSnapshot, TeamAvailableAgentsSnapshot, TeamStructureSnapshot,
} from '@mingle/contracts';

export class TeamSessionsApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TeamSessionsApiError';
  }
}

async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
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
    throw new TeamSessionsApiError('Cannot reach Mingle’s local runtime. Check that Mingle is still running.', 0);
  }

  const text = await response.text();
  if (!response.ok) {
    let message = '';
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string') message = parsed.error;
    } catch { /* use a short plain-text message when available */ }
    if (!message && text && text.length < 300 && !text.trimStart().startsWith('<')) message = text.trim();
    throw new TeamSessionsApiError(message || `Request failed with status ${response.status}.`, response.status);
  }
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; }
  catch { throw new TeamSessionsApiError('Mingle returned an unreadable team response.', response.status); }
}

const projectBase = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

export const teamSessionsApi = {
  structure: (projectId: string, signal?: AbortSignal) =>
    request<TeamStructureSnapshot>(`${projectBase(projectId)}/team-structure`, 'GET', undefined, signal),
  availableAgents: (projectId: string, signal?: AbortSignal) =>
    request<TeamAvailableAgentsSnapshot>(`${projectBase(projectId)}/team-agents`, 'GET', undefined, signal),
  addToSession: (sessionId: string, input: AddTeamAgent) =>
    request<GroupSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/team-agents`, 'POST', input),
  addToGroup: (groupId: string, input: AddTeamAgent) =>
    request<GroupSnapshot>(`/api/groups/${encodeURIComponent(groupId)}/team-agents`, 'POST', input),
};
