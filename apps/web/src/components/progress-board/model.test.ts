import { describe, expect, it } from 'vitest';
import type { ProgressBoardMember } from '@mingle/contracts';
import { progressBoardCardModel, relativeTime } from './model';

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
    });
  });

  it('labels a step without an invented count and clamps future timestamps', () => {
    expect(progressBoardCardModel({ ...base, step: { label: 'Checking the result' }, blockers: ['A', 'B', 'C', 'D'] }, Date.parse('2026-10-29T09:59:00.000Z')))
      .toMatchObject({ stepLabel: 'Checking the result', commitAge: 'just now', blockers: ['A', 'B', 'C'] });
    expect(relativeTime('not-a-date')).toBe('Time unavailable');
  });
});
