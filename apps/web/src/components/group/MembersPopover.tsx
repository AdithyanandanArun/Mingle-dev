import { useEffect, useRef, useState, type RefObject } from 'react';
import { Play, Settings2, Square, UserMinus, UserPlus } from 'lucide-react';
import type { GroupMember, GroupSnapshot, Session, SessionRun } from '@mingle/contracts';
import { useMingle } from '../../store/store';
import { shortPath } from '../../lib/format';
import { interruptMember, removeMember, resumeMember } from '../../lib/groupActions';
import {
  MODE_LABEL, ROLE_LABEL, activeMembers, configSummary, effectiveTurnCeiling, isActiveDelivery, isBusy, memberHasActiveWork, providerAvailability, providerName,
} from '../../lib/groups';
import { Button, IconButton, StatusDot } from '../ui';
import { Popover } from '../git/Popover';
import { AgentIdentity } from './AgentIdentity';
import { usePresence } from '../../lib/motion';
import { cx } from '../../lib/format';

const EMPTY_RUNS: SessionRun[] = [];

function removalBlock(snapshot: GroupSnapshot, member: GroupMember, session: Session | undefined, online: boolean): string | null {
  if (!online) return 'Reconnect to the server first.';
  if (member.sessionId === snapshot.group.anchorSessionId) return 'The anchor session cannot be removed from its group.';
  if (member.id === snapshot.group.orchestratorMemberId) return 'Change the orchestrator before removing it.';
  if (memberHasActiveWork(snapshot, member, session)) return 'Wait for this member’s run and queued work to finish, or stop it first.';
  return null;
}

/** Compact participant list: live status, per-member stop/settings/remove, and the group's queue and bounds. */
export function MembersPopover({ snapshot, anchor, open, onClose }: { snapshot: GroupSnapshot; anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void }) {
  const sessions = useMingle((s) => s.boot?.sessions);
  const runs = useMingle((s) => s.boot?.runs ?? EMPTY_RUNS);
  const providers = useMingle((s) => s.boot?.providers);
  const connection = useMingle((s) => s.connection);
  const project = useMingle((s) => s.boot?.projects.find((item) => item.id === snapshot.group.projectId));
  const [confirming, setConfirming] = useState<string | null>(null);
  const { present: confirmPresent, closing: confirmClosing } = usePresence(Boolean(confirming));
  const retainedConfirm = useRef<string | null>(null);
  if (confirming) retainedConfirm.current = confirming;
  const [busy, setBusy] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmOpener = useRef<HTMLButtonElement | null>(null);
  const previousConfirm = useRef<string | null>(null);
  const members = activeMembers(snapshot);
  const online = connection === 'online';
  const { group } = snapshot;
  const queued = snapshot.deliveries.filter((delivery) => delivery.status === 'queued');
  const running = snapshot.deliveries.filter((delivery) => delivery.status === 'running');
  const runIds = new Set(snapshot.deliveries.flatMap((delivery) => delivery.runId ? [delivery.runId] : []));
  const recordedRuns = runs.filter((run) => runIds.has(run.id));
  const knownDurationRuns = recordedRuns.filter((run) => run.durationMs !== null);
  const knownElapsed = knownDurationRuns.reduce((sum, run) => sum + (run.durationMs ?? 0), 0);
  const activeRunCount = recordedRuns.filter((run) => run.status === 'running').length;
  const unknownElapsedCount = Math.max(0, runIds.size - recordedRuns.filter((run) => run.durationMs !== null).length - activeRunCount);
  const request = [...snapshot.requests].reverse().find((item) => item.status === 'active' || item.status === 'paused');
  const requestDeliveries = request ? snapshot.deliveries.filter((delivery) => delivery.requestId === request.id) : [];
  const requestRunIds = new Set(requestDeliveries.flatMap((delivery) => delivery.runId ? [delivery.runId] : []));
  const requestRuns = runs.filter((run) => requestRunIds.has(run.id));
  const requestElapsedMs = request ? Date.now() - Date.parse(request.createdAt) : NaN;
  const requestElapsed = Number.isFinite(requestElapsedMs) ? formatDuration(requestElapsedMs) : 'not recorded';
  const turnCeiling = effectiveTurnCeiling(group.maxTurns, group.autonomy?.emergencyTurnLimit);
  const handleOf = (memberId: string) => snapshot.members.find((member) => member.id === memberId)?.handle ?? 'unknown';

  useEffect(() => { if (!open) setConfirming(null); }, [open]);
  useEffect(() => { if (confirming) cancelRef.current?.focus(); }, [confirming]);
  useEffect(() => {
    if (!open) { previousConfirm.current = confirming; return; }
    if (!confirming && previousConfirm.current) {
      const target = confirmOpener.current?.isConnected ? confirmOpener.current : anchor.current;
      target?.focus({ preventScroll: true });
    }
    previousConfirm.current = confirming;
  }, [confirming, open, anchor]);
  const dialog = (action: () => void) => () => { onClose(); action(); };

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} label="Group participants" width={420} className="members">
      <div className="members__head">
        <div><strong>Participants</strong><small>{MODE_LABEL[group.mode]} · {members.length} active</small></div>
        <Button size="sm" disabled={!online} why="Reconnect to the server first." onClick={dialog(() => useMingle.getState().openDialog({ kind: 'add-agent', sessionId: group.anchorSessionId }))}><UserPlus size={13} aria-hidden="true" /> Add agent</Button>
      </div>
      <ul className="members__list">
        {members.map((member) => {
          const session = sessions?.find((item) => item.id === member.sessionId);
          const busyMember = isBusy(session);
          const active = snapshot.deliveries.filter((delivery) => delivery.memberId === member.id && isActiveDelivery(delivery));
          const availability = session && providers ? providerAvailability(providers, session.provider) : null;
          const summary = session && providers ? configSummary({ model: session.model, effort: session.effort, policy: session.policy, serviceTier: session.serviceTier ?? 'standard' }, providers, session.provider) : null;
          const removeWhy = removalBlock(snapshot, member, session, online);
          const locked = memberHasActiveWork(snapshot, member, session);
          return (
            <li key={member.id} className="member">
              <div className="member__main">
                <div className="member__title">
                  <AgentIdentity handle={member.handle} identityKey={member.sessionId} provider={session?.provider} role={ROLE_LABEL[member.role]} />
                  {member.held ? <span className="roster__role">Paused in this group</span> : null}
                  {session ? <StatusDot status={session.status} /> : null}
                </div>
                {session && summary ? <small>{providerName(session.provider)} · {summary.model} · {summary.detail}</small> : <small>Session unavailable</small>}
                {session ? <small>{session.isolated ? `Worktree${session.branch ? ` · ${session.branch}` : ''}` : `Project folder${project ? ` · ${shortPath(project.path)}` : ''}`}</small> : null}
                {availability && !availability.available ? <small className="roster__warn">{providerName(session!.provider)} unavailable: {availability.reason}</small> : null}
                {active.length ? <small>{active.filter((delivery) => delivery.status === 'queued').length} queued · {active.filter((delivery) => delivery.status === 'running').length} running</small> : null}
                {session?.status === 'error' && session.error ? <small className="roster__warn">{session.error}</small> : null}
              </div>
              <div className="member__actions">
                <IconButton label={`Settings for @${member.handle}`} disabled={!online || locked} why={locked ? 'Only idle members can change settings' : 'Reconnect to the server first'}
                  onClick={dialog(() => useMingle.getState().openDialog({ kind: 'member-settings', groupId: group.id, memberId: member.id }))}><Settings2 size={14} /></IconButton>
                {member.held ? <IconButton label={`Resume @${member.handle}`} disabled={!online || busy === member.id} why="Reconnect to the server first" onClick={() => { setBusy(member.id); void resumeMember(group.id, member.id).finally(() => setBusy(null)); }}><Play size={14} /></IconButton> : null}
                <IconButton label={`Stop @${member.handle}`} disabled={!online || (!busyMember && active.length === 0) || busy === member.id} why={busyMember || active.length ? 'Reconnect to the server first' : 'No active or queued work'}
                  onClick={() => { setBusy(member.id); void interruptMember(group.id, member.id).finally(() => setBusy(null)); }}><Square size={12} fill="currentColor" /></IconButton>
                <IconButton label={`Remove @${member.handle}`} disabled={Boolean(removeWhy)} why={removeWhy ?? undefined} onClick={(event) => { confirmOpener.current = event.currentTarget; setConfirming(member.id); }}><UserMinus size={14} /></IconButton>
              </div>
              {confirmPresent && (confirming ?? retainedConfirm.current) === member.id ? (
                <div className={cx('member__confirm', confirmClosing && 'is-closing')} role="group" aria-label={`Remove @${member.handle}`} aria-hidden={confirmClosing || undefined} inert={confirmClosing}>
                  <p>Remove @{member.handle} from this conversation? It stops receiving group messages. Its earlier messages stay in the timeline and its worktree is not deleted.</p>
                  <div>
                    <button ref={cancelRef} type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirming(null)}>Cancel</button>
                    <Button size="sm" variant="danger" busy={busy === member.id} onClick={() => { setBusy(member.id); void removeMember(group.id, member.id).then((ok) => { if (ok) setConfirming(null); }).finally(() => setBusy(null)); }}>Remove</Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="members__coord" aria-label="Coordination">
        <div className="members__limits">
          <span>Parallel runs ≤ {group.maxParallel}</span><span>Turns {turnCeiling === null ? 'uncapped' : `≤ ${turnCeiling}`}</span><span>Message hops ≤ {group.maxHops}</span>
          {request ? <span>Current request {request.turnsUsed}/{turnCeiling ?? 'uncapped'} turns</span> : null}
        </div>
        {request ? <p className="field__hint">Current request: {request.turnsUsed} durable turns · {requestRunIds.size ? `${requestRunIds.size} delivery-linked run IDs, ${requestRuns.length} run records${requestRuns.length < requestRunIds.size ? ' (partial records)' : ''}` : 'no run IDs linked yet'} · {requestElapsed} elapsed since start, including queued and waiting time.</p> : null}
        {group.paused ? <p className="members__paused" role="status"><strong>Paused.</strong> {group.pauseReason ?? 'New work is not starting. Resume to continue queued work.'}</p> : null}
        {queued.length || running.length ? (
          <ul className="members__queue" aria-label="Deliveries">
            {[...running, ...queued].map((delivery) => {
              const member = snapshot.members.find((item) => item.id === delivery.memberId);
              const session = member && sessions?.find((item) => item.id === member.sessionId);
              return <li key={delivery.id}><AgentIdentity handle={handleOf(delivery.memberId)} identityKey={member?.sessionId ?? delivery.memberId} provider={session?.provider} /><span>{delivery.status === 'queued' ? 'Queued' : 'Running'}{delivery.hop ? ` · hop ${delivery.hop}` : ''}</span></li>;
            })}
          </ul>
        ) : <p className="field__hint">No queued deliveries.</p>}
        <details className="members__usage">
          <summary>Recorded run usage</summary>
          <p>{runIds.size} actual run ID{runIds.size === 1 ? '' : 's'} appear in retained group deliveries.</p>
          <p>Known elapsed time: {knownDurationRuns.length ? formatDuration(knownElapsed) : 'not recorded'} summed from {knownDurationRuns.length} run record{knownDurationRuns.length === 1 ? '' : 's'} with a final duration{activeRunCount ? ` · ${activeRunCount} active` : ''}{unknownElapsedCount ? ` · elapsed unavailable for ${unknownElapsedCount}` : ''}.</p>
          <p>Group cost is unknown; member/session totals are not a group cost.</p>
        </details>
      </div>
      <div className="members__foot">
        <Button size="sm" variant="ghost" disabled={!online} why="Reconnect to the server first." onClick={dialog(() => useMingle.getState().openDialog({ kind: 'group-mode', groupId: group.id }))}>Group settings…</Button>
      </div>
    </Popover>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
