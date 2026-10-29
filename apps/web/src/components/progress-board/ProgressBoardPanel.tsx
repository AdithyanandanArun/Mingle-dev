import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, GitBranch, Loader2, RefreshCw } from 'lucide-react';
import type { GroupSnapshot, ProgressBoardMember, ProgressBoardResponse, Session, TaskStatus, TeamAgentState, TeamStructureMember } from '@mingle/contracts';
import { AgentIdentity } from '../group/AgentIdentity';
import { AgentActivityDrawer, type ActivityAgent } from '../team-orchestration/activity/AgentActivityDrawer';
import { api, errorMessage } from '../../lib/api';
import { subscribeToTeamUpdates } from '../../lib/team-live-updates';
import { useMingle } from '../../store/store';
import { Button, EmptyState } from '../ui';
import { boardDeviceLabel, progressBoardCardModel, relativeTime, syncedBoardLabel } from './model';
import './progress-board.css';

const EMPTY_SESSIONS: Session[] = [];

const TASK_STATUS: Record<TaskStatus, string> = {
  backlog: 'Backlog', ready: 'Ready', running: 'Running', blocked: 'Blocked', review: 'Review', done: 'Accepted',
};

const TEAM_ACTIVITY_STATE: Record<ProgressBoardMember['state'], TeamAgentState> = {
  idle: 'idle', working: 'working', 'waiting-approval': 'awaiting-approval', 'waiting-answer': 'working',
  paused: 'paused', failed: 'failed', stalled: 'failed',
};

function stateWord(state: ProgressBoardMember['state']): string {
  return {
    idle: 'Idle', working: 'Working', 'waiting-approval': 'Needs approval', 'waiting-answer': 'Needs answer',
    paused: 'Paused', failed: 'Failed', stalled: 'Stalled',
  }[state];
}

function shortSha(sha: string): string { return sha.slice(0, 7); }

function IntegrationHeader({ board, now }: { board: ProgressBoardResponse; now: number }) {
  const head = board.integration.head;
  const push = board.integration.lastPush;
  return <section className="progress-board__integration" aria-label="Integration branch status">
    <div className="progress-board__integration-main">
      <span className="progress-board__integration-label">Integration</span>
      <strong><GitBranch size={13} aria-hidden="true" />{board.integration.branch ?? 'Branch unavailable'}</strong>
      {head ? <span className="progress-board__commit"><code>{shortSha(head.sha)}</code><span title={head.subject}>{head.subject}</span><time dateTime={head.at}>{relativeTime(head.at, now)}</time></span>
        : <span className="progress-board__muted">Head unavailable</span>}
    </div>
    <div className={`progress-board__last-push${push?.failure ? ' is-failed' : ''}`}>
      <span className="progress-board__integration-label">Last push</span>
      {push ? <span><code>{shortSha(push.sha)}</code><time dateTime={push.at}>{relativeTime(push.at, now)}</time></span>
        : <span className="progress-board__muted">No integration push recorded</span>}
      {push?.failure ? <span className="progress-board__push-failure" title={push.failure}>{push.failure}</span> : null}
    </div>
  </section>;
}

function MemberCard({ member, now, onOpen, onCopy }: {
  member: ProgressBoardMember; now: number; onOpen: (member: ProgressBoardMember) => void; onCopy: (branch: string) => void;
}) {
  const model = progressBoardCardModel(member, now);
  return <article className={`progress-board__card is-${model.stateClass}`}>
    <button type="button" className="progress-board__card-open" onClick={() => onOpen(member)} aria-label={`Open @${member.handle} conversation, ${stateWord(member.state)}`}>
      <span className="progress-board__card-heading">
        <AgentIdentity handle={member.handle} identityKey={member.memberId} provider={member.provider} />
        <span className={`progress-board__state is-${model.stateClass}`}><i aria-hidden="true" />{model.stateLabel}</span>
      </span>
      <span className="progress-board__card-meta"><span>{member.role}</span><span>{member.device}</span><span>{member.provider} · {member.model}</span></span>
      <span className="progress-board__task">
        <strong>{member.currentTask?.title ?? 'No active task'}</strong>
        {member.currentTask ? <span className={`progress-board__task-status is-${member.currentTask.status}`}>{TASK_STATUS[member.currentTask.status]}</span> : null}
      </span>
      {model.stepLabel ? <span className="progress-board__step">{model.stepLabel}</span> : <span className="progress-board__step is-empty">No current step reported</span>}
    </button>
    {model.healthIndicator ? <span className={`progress-board__health is-${model.healthIndicator.tone}`} title={model.healthIndicator.title} aria-label={model.healthIndicator.label}>
      {model.healthIndicator.label}
    </span> : null}
    {model.assignmentHandoffText ? <div className="progress-board__handoff">{model.assignmentHandoffText}</div> : null}
    <div className="progress-board__branch-row">
      {member.branch ? <>
        <button type="button" className="progress-board__branch-copy" onClick={() => onCopy(member.branch!.name)} aria-label={`Copy branch ${member.branch.name}`} title="Copy branch name">
          <GitBranch size={13} aria-hidden="true" /><code>{member.branch.name}</code><Copy size={12} aria-hidden="true" />
        </button>
        {member.branch.lastCommit ? <span className="progress-board__branch-commit" title={member.branch.lastCommit.subject}>
          <code>{shortSha(member.branch.lastCommit.sha)}</code><span>{member.branch.lastCommit.subject}</span>
          <time dateTime={member.branch.lastCommit.at}>{model.commitAge}</time>
        </span> : <span className="progress-board__muted">No commit reported</span>}
        <span className="progress-board__badges">
          {member.branch.pushed === true ? <span className="is-good">Pushed</span> : member.branch.pushed === false ? <span className="is-warn">Not pushed</span> : <span>Push unknown</span>}
          {member.branch.merged === true ? <span className="is-good">Merged</span> : member.branch.merged === false ? <span>Not merged</span> : <span>Merge unknown</span>}
        </span>
      </> : <span className="progress-board__muted">Branch unavailable</span>}
    </div>
    {model.blockers.length ? <ul className="progress-board__blockers" aria-label={`Blockers for @${member.handle}`}>
      {model.blockers.map((blocker, index) => <li key={`${index}:${blocker}`}><AlertTriangle size={13} aria-hidden="true" /><span>{blocker}</span></li>)}
    </ul> : <div className="progress-board__clear"><Check size={12} aria-hidden="true" />No blockers reported</div>}
    <time className="progress-board__updated" dateTime={member.updatedAt}>Updated {relativeTime(member.updatedAt, now)}</time>
  </article>;
}

function activityAgentFor(member: ProgressBoardMember, group: GroupSnapshot | undefined, teamMembers: readonly TeamStructureMember[], sessionName: string | undefined): ActivityAgent {
  const groupMember = group?.members.find((candidate) => candidate.id === member.memberId || candidate.handle === member.handle);
  const teamMember = teamMembers.find((candidate) => candidate.handle === member.handle);
  const sessionId = groupMember?.sessionId ?? teamMember?.sessionId ?? null;
  const local = teamMember ? teamMember.local && Boolean(teamMember.sessionId) : member.device === 'this device' && Boolean(groupMember);
  const role = teamMember?.role === 'orchestrator' ? 'orchestrator' : teamMember?.role === 'idle' ? 'idle' : member.role === 'orchestrator' ? 'orchestrator' : 'worker';
  return {
    agentId: teamMember?.agentId ?? groupMember?.id ?? member.memberId,
    handle: member.handle, name: teamMember?.name ?? sessionName ?? member.handle, provider: member.provider, model: member.model,
    local, ownerDisplayName: teamMember?.ownerDisplayName ?? member.device,
    deviceName: teamMember?.deviceName ?? member.device, role, state: TEAM_ACTIVITY_STATE[member.state],
    currentTask: member.currentTask?.title ?? teamMember?.currentTask ?? null, sessionId,
    failureMessage: member.state === 'failed' || member.state === 'stalled' ? member.blockers[0] ?? null : null,
  };
}

export function ProgressBoardPanel({ projectId, groupId, active, onViewChange, refreshKey, group, teamMembers = [] }: {
  projectId: string; groupId: string; active: boolean; onViewChange: (active: boolean) => void; refreshKey?: string;
  group?: GroupSnapshot; teamMembers?: readonly TeamStructureMember[];
}) {
  const sessions = useMingle((state) => state.boot?.sessions ?? EMPTY_SESSIONS);
  const [board, setBoard] = useState<ProgressBoardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<ActivityAgent | null>(null);
  const [now, setNow] = useState(Date.now());
  const inFlight = useRef(false);
  const refreshAgain = useRef(false);
  const boardRef = useRef(board);
  boardRef.current = board;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!active || signal?.aborted) return;
    if (inFlight.current) { refreshAgain.current = true; return; }
    inFlight.current = true;
    if (!boardRef.current) setLoading(true);
    try {
      const latest = await api.groupBoard(groupId, projectId, signal);
      if (!signal?.aborted) { boardRef.current = latest; setBoard(latest); setError(null); setNow(Date.now()); }
    } catch (cause) {
      if (!signal?.aborted) setError(errorMessage(cause));
    } finally {
      inFlight.current = false;
      if (!signal?.aborted) setLoading(false);
      if (refreshAgain.current && !signal?.aborted) {
        refreshAgain.current = false;
        window.setTimeout(() => { void refresh(signal); }, 0);
      }
    }
  }, [active, groupId, projectId]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    const unsubscribe = subscribeToTeamUpdates(projectId, () => void refresh(controller.signal), { debounceMs: 200 });
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(controller.signal);
    }, 15_000);
    const visibility = () => { if (document.visibilityState === 'visible') void refresh(controller.signal); };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      controller.abort(); refreshAgain.current = false; inFlight.current = false;
      unsubscribe(); window.clearInterval(interval); document.removeEventListener('visibilitychange', visibility);
    };
  }, [active, projectId, refresh]);

  useEffect(() => {
    if (!active || !refreshKey) return;
    const timer = window.setTimeout(() => void refresh(), 150);
    return () => window.clearTimeout(timer);
  }, [active, refresh, refreshKey]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const openAgent = (member: ProgressBoardMember) => {
    const name = sessions.find((session) => session.id === group?.members.find((row) => row.id === member.memberId)?.sessionId)?.name;
    setSelectedAgent(activityAgentFor(member, group, teamMembers, name));
  };

  const copyBranch = async (branch: string) => {
    try {
      await navigator.clipboard.writeText(branch);
      setCopyNotice(`Copied ${branch}`);
    } catch { setCopyNotice('Could not copy the branch name'); }
    window.setTimeout(() => setCopyNotice(''), 2200);
  };

  const cardRows = useMemo(() => board?.members.map((member) => ({ ...member, device: boardDeviceLabel(member, teamMembers) })) ?? [], [board, teamMembers]);
  const syncedLabel = board ? syncedBoardLabel(board, now) : null;
  return <>
    <div className="progress-board-switch" role="group" aria-label="Session view">
      <button type="button" aria-pressed={!active} className={!active ? 'is-active' : ''} onClick={() => onViewChange(false)}>Chat</button>
      <button type="button" aria-pressed={active} className={active ? 'is-active' : ''} onClick={() => onViewChange(true)}>Board</button>
    </div>
    <section className="progress-board-panel" aria-label="Live progress board" hidden={!active}>
      {loading && !board ? <div className="progress-board__status" role="status"><Loader2 size={17} className="spin" />Loading live progress…</div> : null}
      {error && !board ? <div className="progress-board__status is-error" role="alert"><span>{error}</span><Button variant="secondary" onClick={() => void refresh()}>Retry</Button></div> : null}
      {error && board ? <div className="progress-board__inline-error" role="status"><span>Showing the last available board · {error}</span><button type="button" onClick={() => void refresh()}>Retry</button></div> : null}
      {board ? <div className="progress-board__scroll">
        {syncedLabel ? <div className="progress-board__synced" role="status">{syncedLabel}</div> : null}
        <IntegrationHeader board={board} now={now} />
      {cardRows.length ? <div className="progress-board__grid">
          {cardRows.map((member) => <MemberCard key={member.memberId} member={member} now={now} onOpen={openAgent} onCopy={(branch) => void copyBranch(branch)} />)}
        </div> : <EmptyState title="No active agents">There are no current members in this group.</EmptyState>}
      </div> : null}
      {copyNotice ? <span className="progress-board__copy-notice" role="status">{copyNotice}</span> : null}
      <button type="button" className="progress-board__refresh" onClick={() => void refresh()} disabled={loading} aria-label="Refresh progress board" title="Refresh board">
        {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
      </button>
    </section>
    {selectedAgent ? <AgentActivityDrawer key={`${selectedAgent.agentId}:${selectedAgent.sessionId ?? ''}`} projectId={projectId} agent={selectedAgent} onClose={() => setSelectedAgent(null)} /> : null}
  </>;
}
