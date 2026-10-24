import type {
  AcceptTeamConsent,
  EnableTeamOrchestration,
  TeamStructureSnapshot,
  UpdateTeamOrchestration,
} from '@mingle/contracts';

export type TeamConsentUpdate = { state: 'granted' | 'paused' | 'revoked' };

export class TeamOrchestrationApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TeamOrchestrationApiError';
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
    throw new TeamOrchestrationApiError('Cannot reach Mingle’s local runtime. Check that Mingle is still running.', 0);
  }
  const text = await response.text();
  if (!response.ok) {
    let message = '';
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string') message = parsed.error;
    } catch { /* use the status if the response is not JSON */ }
    throw new TeamOrchestrationApiError(message || `Team settings request failed with status ${response.status}.`, response.status);
  }
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; }
  catch { throw new TeamOrchestrationApiError('Mingle returned an unreadable team settings response.', response.status); }
}

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

export const teamOrchestrationApi = {
  structure: (projectId: string, signal?: AbortSignal) =>
    call<TeamStructureSnapshot>(`${projectPath(projectId)}/team-structure`, 'GET', undefined, signal),
  enable: (projectId: string, input: EnableTeamOrchestration) =>
    call<unknown>(`${projectPath(projectId)}/team-orchestration/enable`, 'POST', input),
  updateSettings: (projectId: string, input: UpdateTeamOrchestration) =>
    call<unknown>(`${projectPath(projectId)}/team-orchestration`, 'PATCH', input),
  acceptConsent: (projectId: string, input: AcceptTeamConsent) =>
    call(`${projectPath(projectId)}/team-consent`, 'POST', input),
  updateConsent: (projectId: string, input: TeamConsentUpdate) =>
    call(`${projectPath(projectId)}/team-consent`, 'PATCH', input),
};
