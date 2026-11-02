import type { PatchProjectMemoryInput, ProjectMemoryEntry, ProjectMemoryHistoryResponse, ProjectMemoryListResponse, ProjectMemoryWriteResult } from '@mingle/contracts';
import { ApiError } from '../../lib/api';
export type MemoryRecord = ProjectMemoryEntry;

async function request<T>(url: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { method, signal, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch (cause) { if (signal?.aborted) throw cause; throw new ApiError('Cannot reach the local runtime. Check that Mingle is still running.', 0); }
  const result = await response.json();
  if (!response.ok) throw new ApiError(typeof result?.error === 'string' ? result.error : 'Project memory is unavailable.', response.status);
  return result as T;
}
const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/memory`;
export const memoryApi = {
  list: (projectId: string, query: string, includeRetired: boolean, cursor?: string | null, signal?: AbortSignal) => request<ProjectMemoryListResponse>(`${base(projectId)}?${new URLSearchParams({ q: query, include: includeRetired ? 'retired' : 'live', ...(cursor ? { cursor } : {}) })}`, 'GET', undefined, signal),
  patch: (projectId: string, entry: MemoryRecord, patch: Omit<PatchProjectMemoryInput, 'expectedRevision'>) => request<ProjectMemoryWriteResult>(`${base(projectId)}/${encodeURIComponent(entry.id)}`, 'PATCH', { ...patch, expectedRevision: entry.revision }),
  history: (projectId: string, id: string, signal?: AbortSignal) => request<ProjectMemoryHistoryResponse>(`${base(projectId)}/${encodeURIComponent(id)}/history`, 'GET', undefined, signal),
};
