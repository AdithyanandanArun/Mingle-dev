import { afterEach, expect, it, vi } from 'vitest';
import { dispatchTeamUpdate, subscribeToTeamUpdates } from './team-live-updates.ts';

afterEach(() => vi.useRealTimers());

it('maps durable structure and chat updates to project-scoped browser events', () => {
  const target = new EventTarget();
  const structure = vi.fn();
  const chat = vi.fn();
  target.addEventListener('mingle:team-structure-updated', structure);
  target.addEventListener('mingle:team-chat-updated', chat);

  dispatchTeamUpdate({ type: 'team.structure.updated', projectId: 'project-a' }, target);
  dispatchTeamUpdate({ type: 'team.chat.updated', projectId: 'project-b' }, target);
  dispatchTeamUpdate({ type: 'session.updated', projectId: 'project-a' }, target);

  expect(structure).toHaveBeenCalledTimes(1);
  expect(structure.mock.calls[0][0].detail).toEqual({ projectId: 'project-a' });
  expect(chat).toHaveBeenCalledTimes(1);
  expect(chat.mock.calls[0][0].detail).toEqual({ projectId: 'project-b' });
});

it('debounces same-project updates and ignores unrelated projects', async () => {
  vi.useFakeTimers();
  const target = new EventTarget();
  const refresh = vi.fn();
  const unsubscribe = subscribeToTeamUpdates('project-a', refresh, { target, kinds: ['structure'], debounceMs: 50 });
  try {
    dispatchTeamUpdate({ type: 'team.structure.updated', projectId: 'project-b' }, target);
    dispatchTeamUpdate({ type: 'team.structure.updated', projectId: 'project-a' }, target);
    dispatchTeamUpdate({ type: 'team.structure.updated', projectId: 'project-a' }, target);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
  }
});
