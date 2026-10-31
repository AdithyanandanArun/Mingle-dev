import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Users } from 'lucide-react';
import type { GroupSnapshot } from '@mingle/contracts';
import { useMingle } from '../../store/store';
import { pauseGroup, resumeGroup } from '../../lib/groupActions';
import { api, errorMessage } from '../../lib/api';
import { activeMembers } from '../../lib/groups';
import { Button } from '../ui';
import { MembersPopover } from './MembersPopover';

export function GroupControl({ snapshot }: { snapshot: GroupSnapshot }) {
  const sessions = useMingle((s) => s.boot?.sessions);
  const approvals = useMingle((s) => s.boot?.approvals);
  const connection = useMingle((s) => s.connection);
  const membersOpen = useMingle((s) => s.groupMembersOpenId === snapshot.group.id);
  const busy = useMingle((s) => s.groupActionBusyId !== null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { group } = snapshot;
  const preferred = group.preferredCoordinatorMemberId ? snapshot.members.find((member) => member.id === group.preferredCoordinatorMemberId) : undefined;
  const [restoreStatus, setRestoreStatus] = useState<{ handle: string; cooldownUntil: string | null; reason: string | null } | null>(null);
  useEffect(() => {
    if (!preferred) { setRestoreStatus(null); return; }
    let active = true;
    const refresh = () => { void api.coordinatorRestoreStatus(group.id).then((value) => { if (active) setRestoreStatus(value); }).catch(() => undefined); };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [group.id, preferred?.id]);
  const restoreBlocked = restoreStatus?.cooldownUntil ? `@${preferred?.handle} is still in provider cooldown until ${new Date(restoreStatus.cooldownUntil).toLocaleTimeString()}.` : undefined;
  const restore = async () => {
    try { useMingle.getState().applyGroup(await api.restoreGroupCoordinator(group.id)); }
    catch (error) { useMingle.getState().toast('error', errorMessage(error)); }
  };
  const members = activeMembers(snapshot);
  const live = members.map((member) => sessions?.find((session) => session.id === member.sessionId));
  const running = live.filter((session) => session?.status === 'running').length;
  const waiting = live.filter((session) => session?.status === 'waiting').length;
  const erroring = live.filter((session) => session?.status === 'error').length;
  const unavailable = live.filter((session) => !session).length;
  const sessionIds = new Set(members.map((member) => member.sessionId));
  const pending = (approvals ?? []).filter((approval) => approval.status === 'pending' && sessionIds.has(approval.sessionId));
  const pendingSessions = new Set(pending.map((approval) => approval.sessionId));
  const pendingApprovals = pending.length;
  const waitingWithoutApproval = live.filter((session) => session?.status === 'waiting' && !pendingSessions.has(session.id)).length;
  const queued = snapshot.deliveries.filter((delivery) => delivery.status === 'queued').length;
  const runningDeliveries = snapshot.deliveries.filter((delivery) => delivery.status === 'running').length;
  const request = [...snapshot.requests].reverse().find((item) => item.status === 'active' || item.status === 'paused');
  const waitingForResults = request?.status === 'active' && queued === 0 && runningDeliveries === 0 && running === 0 && waiting === 0;
  const online = connection === 'online';

  useEffect(() => () => {
    const store = useMingle.getState();
    if (store.groupMembersOpenId === group.id) store.setGroupMembersOpen(null);
  }, [group.id]);

  const facts = [
    connection === 'offline' ? 'Offline' : connection === 'connecting' ? 'Connecting' : null,
    group.paused ? 'Paused' : null,
    pendingApprovals ? `${pendingApprovals} approval${pendingApprovals === 1 ? '' : 's'}` : null,
    erroring ? `${erroring} error${erroring === 1 ? '' : 's'}` : null,
    running ? `${running} running` : null,
    waitingForResults ? 'Waiting for results' : null,
    waitingWithoutApproval ? `${waitingWithoutApproval} waiting` : null,
    queued ? `${queued} queued` : null,
    unavailable ? `${unavailable} unavailable` : null,
  ].filter((fact): fact is string => Boolean(fact));
  const fullStatus = facts.length ? facts.join(' · ') : 'Idle';
  const status = connection !== 'online' ? (connection === 'offline' ? 'Offline' : 'Connecting')
      : group.paused ? `Paused${running + waiting ? ` · ${running + waiting} active` : queued ? ` · ${queued} queued` : ''}`
      : pendingApprovals ? `${pendingApprovals} approval${pendingApprovals === 1 ? '' : 's'}${running ? ` · ${running} running` : ''}`
        : erroring ? `${erroring} error${erroring === 1 ? '' : 's'}${running ? ` · ${running} running` : ''}`
          : running ? `${running} running${queued ? ` · ${queued} queued` : ''}`
            : waitingWithoutApproval ? `${waitingWithoutApproval} waiting`
              : queued ? `${queued} queued` : waitingForResults ? 'Waiting for results' : unavailable ? `${unavailable} unavailable` : 'Idle';
  const pauseReason = group.paused && group.pauseReason ? ` Pause reason: ${group.pauseReason}` : '';
  const detail = `Group status: ${fullStatus}.${pauseReason}`;
  const actionLabel = group.paused ? 'Resume group' : 'Pause group';
  const actionWhy = online ? undefined : connection === 'offline' ? 'Reconnect to the server first.' : 'Waiting for the server connection.';

  return (
    <>
      <div className="header__team">
        {preferred ? <span className="team-control__standin">Standing in for @{preferred.handle} (usage limit)</span> : null}
        <button
          ref={trigger}
          type="button"
          className="team-control"
          aria-label={`${members.length} agents. ${detail}`}
          aria-haspopup="dialog"
          aria-expanded={membersOpen}
          title={detail}
          onClick={() => useMingle.getState().setGroupMembersOpen(membersOpen ? null : group.id)}
        >
          <Users size={14} aria-hidden="true" />
          <span className="team-control__count">{members.length}<span> agents</span></span>
          <span className="team-control__state" data-state={connection !== 'online' ? 'offline' : erroring ? 'error' : pendingApprovals ? 'waiting' : group.paused ? 'paused' : 'normal'} aria-live="polite">{status}</span>
        </button>
        <Button
          size="sm"
          className="team-control__action"
          disabled={!online || busy}
          busy={busy}
          why={busy ? 'A group action is already in progress.' : actionWhy}
          title={group.paused ? 'Resume queued group work.' : 'Pause dispatch. Current runs keep going; queued work waits.'}
          aria-label={actionLabel}
          aria-busy={busy}
          onClick={() => {
            void (group.paused ? resumeGroup(group.id) : pauseGroup(group.id));
          }}
        >
          {group.paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
          <span className="team-control__action-label">{group.paused ? 'Resume' : 'Pause'}</span>
        </Button>
        {preferred ? <Button size="sm" variant="secondary" disabled={!online || busy || Boolean(restoreBlocked)} why={!online ? 'Reconnect to the server first.' : restoreBlocked ?? (busy ? 'A group action is already in progress.' : undefined)} onClick={() => void restore()}>Restore @{preferred.handle}</Button> : null}
      </div>
      <MembersPopover snapshot={snapshot} anchor={trigger} open={membersOpen} onClose={() => useMingle.getState().setGroupMembersOpen(null)} />
    </>
  );
}
