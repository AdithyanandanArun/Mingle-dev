import type { Approval, Message, QueuedMessage, Session, SessionRun, ToolCall } from './index';
import type { DelegatedSubagent } from './delegated-subagents';
import type { SessionPlan, UserQuestion } from './planning';
import type { SessionWorkflow } from './session-workflow';

/** Messages a session snapshot (and a bootstrap) carries per session; older history pages through the messages route. */
export const SESSION_SNAPSHOT_MESSAGES = 300;
/** Largest session set one scoped notification may name; a bigger burst is announced as a full change instead. */
export const MAX_SCOPED_SESSIONS = 8;

/**
 * Everything one standalone session owns in `Bootstrap`, read in a single synchronous pass: replacing these collections
 * for `sessionId` in a bootstrap gives the rows a fresh bootstrap would carry for that session (same message window, same
 * global run/tool/approval/plan/question limits). Projects, groups, tasks, events, providers and settings are never part
 * of it, so the endpoint refuses sessions whose state spans those (group members, helpers, team proxies).
 */
export interface SessionSnapshot {
  sessionId: string;
  /** Newest recorded workspace event id when the snapshot was read. Diagnostic only: unrecorded changes do not move it, so it is not a freshness fence. */
  eventCursor: number;
  session: Session;
  messages: Message[];
  runs: SessionRun[];
  toolCalls: ToolCall[];
  queuedMessages: QueuedMessage[];
  approvals: Approval[];
  plans: SessionPlan[];
  questions: UserQuestion[];
  workflows: SessionWorkflow[];
  delegatedSubagents: DelegatedSubagent[];
}

/**
 * Narrows a `state.changed` notification. Absent means anything may have changed, so a client refreshes everything.
 * Present means the change is confined to these sessions' `SessionSnapshot` collections.
 */
export interface StateChangeScope { sessionIds: string[] }
