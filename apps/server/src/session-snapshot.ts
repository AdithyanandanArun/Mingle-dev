import { SESSION_SNAPSHOT_MESSAGES, type SessionSnapshot, type StateChangeScope, type WorkspaceEvent } from '@mingle/contracts';
import type { DelegatedSubagentService } from './delegated-subagents.ts';
import type { SessionRuntime } from './runtime.ts';
import type { SessionWorkflowService } from './session-workflow/service.ts';
import type { Store } from './store.ts';
import { conflict, notFound } from './util.ts';

export interface SessionSnapshotSources {
  store: Store;
  runtime: Pick<SessionRuntime, 'isSteerable'>;
  workflows: Pick<SessionWorkflowService, 'get'>;
  subagents: Pick<DelegatedSubagentService, 'list'>;
}

/**
 * The collections `/api/bootstrap` carries for one standalone session, without the providers discovery, groups, projects,
 * tasks, events or other sessions' rows. It is synchronous end to end, so every collection comes from the same instant
 * and no other request can interleave between them.
 *
 * Sessions whose state spans more than their own rows are refused (409) rather than represented partially: group members
 * (shared timeline and delivery state), helper sessions (parent progress) and shared-team proxies (remote ownership).
 * Unknown and archived sessions are 404. Callers fall back to a full bootstrap on either.
 */
export function buildSessionSnapshot(sources: SessionSnapshotSources, sessionId: string): SessionSnapshot {
  const { store } = sources;
  const session = store.getSession(sessionId);
  if (!session) throw notFound('Session not found');
  if (session.parentSessionId) throw conflict('Helper sessions refresh with the whole workspace.');
  if (store.isGroupSession(sessionId) || store.isTeamProxySession(sessionId)) throw conflict('Group and shared-team sessions refresh with the whole workspace.');
  const { runs, toolCalls } = store.sessionBootstrapRunsAndTools(sessionId);
  const workflow = sources.workflows.get(sessionId);
  return {
    sessionId,
    eventCursor: store.lastEventId(),
    session: { ...session, steerable: sources.runtime.isSteerable(sessionId) },
    messages: store.listMessages(sessionId, { limit: SESSION_SNAPSHOT_MESSAGES }),
    runs, toolCalls,
    queuedMessages: store.listQueuedMessages(sessionId),
    approvals: store.sessionBootstrapApprovals(sessionId, 50),
    plans: store.sessionBootstrapPlans(sessionId),
    questions: store.sessionBootstrapQuestions(sessionId),
    workflows: workflow ? [workflow] : [],
    delegatedSubagents: sources.subagents.list(sessionId),
  };
}

/**
 * Named session events whose entire effect lands in that session's `SessionSnapshot` collections (approval, question,
 * plan and queue rows, the session's own status, and progress that lives only in the event). Lifecycle events such as
 * `session.run.*` also move tasks, workflows, project context and plans, and every unknown, task, group, project or team
 * event can change shared state, so none of those are listed: they keep the full-snapshot recovery path.
 */
const SESSION_CONFINED_EVENTS: ReadonlySet<string> = new Set([
  'approval.requested', 'approval.resolved', 'approval.denied', 'approval.expired',
  'session.question.asked', 'session.question.answered', 'session.question.cancelled',
  'session.plan.updated', 'session.plan.approved', 'session.plan.edited',
  'session.queue.start-failed', 'session.progress.status',
]);

/** The scope to announce an event with, or undefined when clients must reload the whole workspace. */
export function sessionScopeOf(event: WorkspaceEvent): StateChangeScope | undefined {
  return event.sessionId && SESSION_CONFINED_EVENTS.has(event.type) ? { sessionIds: [event.sessionId] } : undefined;
}
