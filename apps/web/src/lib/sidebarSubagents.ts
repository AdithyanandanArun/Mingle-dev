import type { DelegatedSubagent, Session, SessionStatus } from '@mingle/contracts';

/** A delegated helper that is still running, paired with its child session for navigation and status. */
export interface LiveSidebarSubagent { subagent: DelegatedSubagent; session: Session }

/**
 * Groups running delegated helpers by their parent session for the left sidebar. The delegated record is the authority:
 * a helper can be running while its child session is still idle (startup) or waiting for input, and a finished helper
 * (completed, failed or cancelled) never counts again, even if its child session is used later.
 */
export function liveSidebarSubagents(sessions: readonly Session[], delegatedSubagents: readonly DelegatedSubagent[] | undefined, projectId: string | undefined): Map<string, LiveSidebarSubagent[]> {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const seenChildren = new Set<string>();
  const byParent = new Map<string, LiveSidebarSubagent[]>();
  for (const subagent of delegatedSubagents ?? []) {
    if (subagent.status !== 'running' || seenChildren.has(subagent.childSessionId)) continue;
    const session = sessionsById.get(subagent.childSessionId);
    if (!session || session.projectId !== projectId || session.parentSessionId !== subagent.parentSessionId) continue;
    seenChildren.add(subagent.childSessionId);
    byParent.set(subagent.parentSessionId, [...(byParent.get(subagent.parentSessionId) ?? []), { subagent, session }]);
  }
  for (const live of byParent.values()) live.sort((a, b) => a.subagent.startedAt.localeCompare(b.subagent.startedAt));
  return byParent;
}

/** Dot state for a live helper. An idle or interrupted child session still means the helper is running. */
export function liveSubagentDotStatus(session: Session): Extract<SessionStatus, 'running' | 'waiting' | 'error'> {
  return session.status === 'waiting' || session.status === 'error' ? session.status : 'running';
}
