import { describe, expect, it } from 'vitest';
import type { ProgressBoardMember, TeamStructureMember } from '@mingle/contracts';
import { boardDeviceLabel, progressBoardCardModel, relativeTime, syncedBoardLabel } from './model';

const base: ProgressBoardMember = {
  memberId: 'member-1', handle: 'builder', role: 'worker', provider: 'codex', model: 'gpt-6.1-sol', device: 'this device',
  state: 'waiting-approval', currentTask: { id: 'task-1', title: 'Build the board', status: 'running' },
  step: { label: 'Reviewing the implementation', current: 3, total: 7 },
  branch: { name: 'mingle/builder/work', lastCommit: { sha: 'abcdef0123456789abcdef0123456789abcdef01', subject: 'Add progress board', at: '2026-10-29T10:00:00.000Z' }, pushed: true, merged: false },
  blockers: ['Approval is required', 'One task is blocked'], health: null, updatedAt: '2026-10-29T10:00:00.000Z',
};

describe('progress board card model', () => {
  it('derives state pill, numbered step, bounded blockers, short commit and relative time', () => {
    expect(progressBoardCardModel(base, Date.parse('2026-10-29T10:01:05.000Z'))).toEqual({
      stateLabel: 'Needs approval', stateClass: 'waiting-approval',
      stepLabel: 'Step 3/7 · Reviewing the implementation',
      branchCommit: 'abcdef0 · Add progress board', commitAge: '1m ago',
      blockers: ['Approval is required', 'One task is blocked'],
      healthIndicator: null, assignmentHandoffText: null,
    });
  });

  it('labels a step without an invented count and clamps future timestamps', () => {
    expect(progressBoardCardModel({ ...base, step: { label: 'Checking the result' }, blockers: ['A', 'B', 'C', 'D'] }, Date.parse('2026-10-29T09:59:00.000Z')))
      .toMatchObject({ stepLabel: 'Checking the result', commitAge: 'just now', blockers: ['A', 'B', 'C'] });
    expect(relativeTime('not-a-date')).toBe('Time unavailable');
  });

  it('shows health countdowns and recovery handoff transcript lines without duplicate blockers', () => {
    const now = Date.parse('2026-10-29T10:00:00.000Z');
    const cooldown = progressBoardCardModel({ ...base,
      health: { state: 'cooldown', until: '2026-10-29T10:12:00.000Z', reason: 'Provider quota exhausted' },
      blockers: ['Approval is required', 'Provider quota exhausted', 'One task is blocked'],
      assignmentHandoff: { action: 'moved', handle: 'backup' },
    }, now);
    expect(cooldown.healthIndicator).toEqual({ label: 'Out of usage · back in 12m', tone: 'warning', title: 'Provider quota exhausted' });
    expect(cooldown.blockers).toEqual(['Approval is required', 'Provider quota exhausted', 'One task is blocked']);
    expect(cooldown.assignmentHandoffText).toBe('Task moved to @backup (out of usage)');
    expect(progressBoardCardModel({ ...base, health: { state: 'stalled', reason: 'No recent activity' } }, now).healthIndicator)
      .toEqual({ label: 'Stalled · no activity', tone: 'error', title: 'No recent activity' });
    expect(progressBoardCardModel({ ...base, health: { state: 'failed' }, assignmentHandoff: { action: 'took-over', handle: 'builder' } }, now))
      .toMatchObject({ healthIndicator: { label: 'Failed', tone: 'error' }, assignmentHandoffText: 'Took over from @builder' });
  });

  it('labels host-synced boards and resolves device labels for local and remote teammates', () => {
    const now = Date.parse('2026-10-29T10:02:00.000Z');
    expect(syncedBoardLabel({ source: 'host', syncedAt: '2026-10-29T10:00:00.000Z' }, now)).toBe('Synced from host · 2m ago');
    expect(syncedBoardLabel({ source: 'local' }, now)).toBeNull();
    const teammate: TeamStructureMember = {
      agentId: 'agent-1', name: 'Builder', handle: 'builder', ownerAccountId: 'owner', ownerDisplayName: 'Alex Host',
      deviceId: 'device-1', deviceName: 'MacBook', local: false, sessionId: null, provider: 'codex', model: 'gpt-6.1-sol',
      effort: null, role: 'worker', fallbackRank: null, state: 'idle', consent: 'granted', currentTask: null, lastActivityAt: null, failure: null,
    };
  expect(boardDeviceLabel(base, [teammate])).toBe('Alex Host');
  expect(boardDeviceLabel(base, [{ ...teammate, local: true }])).toBe('This device');
  expect(boardDeviceLabel({ ...base, ownerAccountId: 'owner', ownerDisplayName: 'Alex Host' }, [teammate], 'owner')).toBe('This device');
  expect(boardDeviceLabel({ ...base, ownerAccountId: 'member', ownerDisplayName: 'My Name' }, [teammate], 'member')).toBe('This device');
  expect(boardDeviceLabel({ ...base, ownerAccountId: 'owner', ownerDisplayName: 'Alex Host' }, [{ ...teammate, local: true }], 'member')).toBe('Alex Host');
  });
});
