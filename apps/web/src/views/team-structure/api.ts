import type { TeamStructureChange, TeamStructureSnapshot } from '@mingle/contracts';

export class TeamStructureApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TeamStructureApiError';
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
    throw new TeamStructureApiError('Cannot reach Mingle’s local runtime. Check that Mingle is still running.', 0);
  }

  const text = await response.text();
  if (!response.ok) {
    let message = '';
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string') message = parsed.error;
    } catch { /* use a short plain-text message when available */ }
    if (!message && text && text.length < 300 && !text.trimStart().startsWith('<')) message = text.trim();
    throw new TeamStructureApiError(message || `Request failed with status ${response.status}.`, response.status);
  }
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; }
  catch { throw new TeamStructureApiError('Mingle returned an unreadable team structure response.', response.status); }
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/team-structure`;

export const teamStructureApi = {
  snapshot: (projectId: string, signal?: AbortSignal) => call<TeamStructureSnapshot>(base(projectId), 'GET', undefined, signal),
  change: (projectId: string, change: TeamStructureChange) => call<TeamStructureSnapshot>(`${base(projectId)}/changes`, 'POST', change),
};
