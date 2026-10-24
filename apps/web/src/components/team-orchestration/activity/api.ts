import type { TeamAgentActivity, TeamStructureSnapshot } from '@mingle/contracts';

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'GET', signal, headers: { accept: 'application/json' } });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new Error('Cannot reach the local runtime. Check that Mingle is still running.');
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = '';
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch { /* use status below */ }
    throw new Error(message || `Request failed with status ${response.status}`);
  }
  return await response.json() as T;
}

const projectBase = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

export const teamActivityApi = {
  structure: (projectId: string, signal?: AbortSignal) =>
    getJson<TeamStructureSnapshot>(`${projectBase(projectId)}/team-structure`, signal),
  activity: (projectId: string, agentId: string, before?: string, signal?: AbortSignal) => {
    const query = before ? `?${new URLSearchParams({ before }).toString()}` : '';
    return getJson<TeamAgentActivity>(`${projectBase(projectId)}/team-agents/${encodeURIComponent(agentId)}/activity${query}`, signal);
  },
};
