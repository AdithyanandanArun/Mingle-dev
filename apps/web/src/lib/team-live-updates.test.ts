import { afterEach, expect, it, vi } from 'vitest';
import { dispatchTeamUpdate, subscribeToTeamUpdates } from './team-live-updates';

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

it('coalesces a burst of chat updates into one refresh', async () => {
  vi.useFakeTimers();
  const target = new EventTarget();
  const refresh = vi.fn();
  const unsubscribe = subscribeToTeamUpdates('project-a', refresh, { target, kinds: ['chat'], debounceMs: 80 });
  try {
    for (let index = 0; index < 100; index++) dispatchTeamUpdate({ type: 'team.chat.updated', projectId: 'project-a' }, target);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(80);
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
  }
});

it('refreshes during continuous updates and cancels a pending refresh on unsubscribe', async () => {
  vi.useFakeTimers();
  const target = new EventTarget();
  const refresh = vi.fn();
  const unsubscribe = subscribeToTeamUpdates('project-a', refresh, { target, kinds: ['structure'], debounceMs: 80 });
  for (let index = 0; index < 10; index++) {
    dispatchTeamUpdate({ type: 'team.structure.updated', projectId: 'project-a' }, target);
    await vi.advanceTimersByTimeAsync(20);
  }
  expect(refresh).toHaveBeenCalledTimes(2);
  unsubscribe();
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh).toHaveBeenCalledTimes(2);
});
