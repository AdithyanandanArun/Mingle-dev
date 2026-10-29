import type { ProgressBoardAssignmentHandoff, ProgressBoardHealth, ProgressBoardMember, ProgressBoardResponse, ProgressBoardState, TeamStructureMember } from '@mingle/contracts';

const STATE_LABEL: Record<ProgressBoardState, string> = {
  idle: 'Idle', working: 'Working', 'waiting-approval': 'Needs approval', 'waiting-answer': 'Needs answer',
  paused: 'Paused', failed: 'Failed', stalled: 'Stalled',
};

export interface ProgressBoardCardModel {
  stateLabel: string;
  stateClass: string;
  stepLabel: string | null;
  branchCommit: string | null;
  commitAge: string | null;
  blockers: string[];
  healthIndicator: { label: string; tone: 'warning' | 'error'; title?: string } | null;
  assignmentHandoffText: string | null;
}

export function relativeTime(value: string, now = Date.now()): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return 'Time unavailable';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function boardStepLabel(member: ProgressBoardMember): string | null {
  if (!member.step) return null;
  const step = member.step;
  const count = step.current !== undefined && step.total !== undefined ? `Step ${step.current}/${step.total} · ` : '';
  return `${count}${step.label}`;
}

export function boardHealthIndicator(health: ProgressBoardHealth | null, now = Date.now()): ProgressBoardCardModel['healthIndicator'] {
  if (!health || health.state === 'ok') return null;
  const title = health.reason || undefined;
  if (health.state === 'cooldown') {
    const until = health.until ? Date.parse(health.until) : Number.NaN;
    if (!Number.isFinite(until)) return { label: 'Out of usage', tone: 'warning', title };
    const minutes = Math.ceil(Math.max(0, until - now) / 60_000);
    return { label: `Out of usage · back ${minutes ? `in ${minutes}m` : 'now'}`, tone: 'warning', title };
  }
  if (health.state === 'stalled') return { label: 'Stalled · no activity', tone: 'error', title };
  return { label: 'Failed', tone: 'error', title };
}

export function assignmentHandoffText(handoff: ProgressBoardAssignmentHandoff | undefined): string | null {
  if (!handoff) return null;
  return handoff.action === 'moved' ? `Task moved to @${handoff.handle} (out of usage)` : `Took over from @${handoff.handle}`;
}

export function progressBoardCardModel(member: ProgressBoardMember, now = Date.now()): ProgressBoardCardModel {
  const commit = member.branch?.lastCommit;
  const blockers = member.blockers.slice(0, 3);
  const healthReason = member.health?.reason;
  if (healthReason && !blockers.includes(healthReason)) {
    if (blockers.length >= 3) blockers.pop();
    blockers.push(healthReason);
  }
  return {
    stateLabel: STATE_LABEL[member.state], stateClass: member.state,
    stepLabel: boardStepLabel(member),
    branchCommit: commit ? `${commit.sha.slice(0, 7)} · ${commit.subject}` : null,
    commitAge: commit ? relativeTime(commit.at, now) : null,
    blockers,
    healthIndicator: boardHealthIndicator(member.health, now),
    assignmentHandoffText: assignmentHandoffText(member.assignmentHandoff),
  };
}

export function syncedBoardLabel(board: Pick<ProgressBoardResponse, 'source' | 'syncedAt'>, now = Date.now()): string | null {
  return board.source === 'host' && board.syncedAt ? `Synced from host · ${relativeTime(board.syncedAt, now)}` : null;
}

export function boardDeviceLabel(member: ProgressBoardMember, teamMembers: readonly TeamStructureMember[], accountId?: string | null): string {
  const teamMember = teamMembers.find((candidate) => candidate.handle === member.handle);
  if (!teamMember) return member.device;
  if (accountId && member.ownerAccountId) return member.ownerAccountId === accountId ? 'This device' : member.ownerDisplayName?.trim() || teamMember.ownerDisplayName.trim() || member.device;
  if (teamMember.local) return 'This device';
  return teamMember.ownerDisplayName.trim() || member.device;
}
