import type { Approval, GroupMember, GroupSnapshot, Session, SessionRun } from '@mingle/contracts';

export type PresenceState = 'working' | 'approval' | 'queued' | 'paused' | 'error' | 'interrupted' | 'idle' | 'unavailable' | 'offline';
export interface MemberPresence {
  state: PresenceState;
  label: string;
  detail: string | null;
  queuedCount: number;
  /** Native run start only. Queue creation timestamps must never become an elapsed work timer. */
  startedAt: string | null;
  working: boolean;
}
export interface MemberPresenceInput {
  snapshot: GroupSnapshot;
  member: GroupMember;
  session: Session | undefined;
  runs: readonly SessionRun[];
  approvals: readonly Approval[];
  connection: 'online' | 'connecting' | 'offline';
}

/** Current work takes precedence over queued follow-ups, so a busy agent can never look free. */
export function memberPresence(input: MemberPresenceInput): MemberPresence {
  const { snapshot, member, session, runs, approvals, connection } = input;
  const deliveries = snapshot.deliveries.filter(delivery => delivery.memberId === member.id);
  const queuedCount = deliveries.filter(delivery => delivery.status === 'queued').length;
  const queued = queuedCount ? `${queuedCount} queued` : null;
  const nativeRun = runs.filter(run => run.sessionId === member.sessionId && run.status === 'running')
    .reduce<SessionRun | undefined>((latest, run) => !latest || run.startedAt > latest.startedAt ? run : latest, undefined);
  const startedAt = nativeRun?.startedAt ?? null;
  const presence = (state: PresenceState, label: string, detail: string | null = null, working = false): MemberPresence =>
    ({ state, label, detail, queuedCount, startedAt: working ? startedAt : null, working });

  const current = (): MemberPresence => {
    if (!session) return presence('unavailable', 'Unavailable', queued ?? 'Session details unavailable');
    if (session.status === 'waiting' || approvals.some(approval => approval.sessionId === member.sessionId && approval.status === 'pending')) {
      return presence('approval', 'Awaiting approval', queued ? `${queued} behind this run` : 'Needs your approval to continue');
    }
    if (session.status === 'running' || nativeRun || deliveries.some(delivery => delivery.status === 'running')) {
      return presence('working', 'Working', queued ? `${queued} behind this run` : null, true);
    }
    if (session.status === 'error') return presence('error', 'Error', session.error ?? queued);
    if (member.held || snapshot.group.paused) {
      const reason = member.held ? 'Agent paused in this group' : snapshot.group.pauseReason ?? 'Group paused';
      return presence('paused', 'Paused', queued ? `${queued} · ${reason}` : reason);
    }
    if (queuedCount) return presence('queued', 'Queued', `${queued} · waiting to start`);
    if (session.status === 'interrupted') return presence('interrupted', 'Interrupted');
    return presence('idle', 'Idle');
  };

  const state = current();
  if (connection === 'online') return state;
  return {
    ...state, state: 'offline', label: connection === 'connecting' ? 'Reconnecting' : 'Offline',
    detail: `Last known: ${state.label.toLowerCase()}${queued ? ` · ${queued}` : ''}`,
    startedAt: null, working: false,
  };
}
