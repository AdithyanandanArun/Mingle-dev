import type { Bootstrap, Project, Session } from '@mingle/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { bootstrap, rememberProject } = vi.hoisted(() => ({ bootstrap: vi.fn(), rememberProject: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { bootstrap, rememberProject }, errorMessage: (error: unknown) => String(error) }));

const project = (id: string, isExample = false): Project => ({ id, name: id, path: `/fixture/${id}`, isExample, createdAt: '2026-01-01' });
const payload = (lastProjectId: string | null = null): Bootstrap => ({
  projects: [project('example', true), project('older'), project('recent')],
  sessions: [], messages: [], tasks: [], events: [], approvals: [], plans: [], questions: [], providers: [],
  settings: {} as Bootstrap['settings'], version: 'startup-test', runs: [], toolCalls: [], lastProjectId,
});

beforeEach(() => {
  vi.resetModules();
  bootstrap.mockReset();
  rememberProject.mockReset().mockResolvedValue({});
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal('window', { location: { search: '' } });
});
afterEach(() => vi.unstubAllGlobals());

it('restores the device selection on a new origin and preserves navigation during refresh', async () => {
  localStorage.setItem('relay.ui.v2', JSON.stringify({ activeProjectId: 'example' }));
  const { useMingle } = await import('./store');
  bootstrap.mockResolvedValue(payload('older'));
  await useMingle.getState().refreshNow();
  expect(useMingle.getState().activeProjectId).toBe('older');

  useMingle.getState().selectProject('recent');
  // A stale server preference must not send this window back to its startup project.
  bootstrap.mockResolvedValue({ ...payload('older'), version: 'refreshed' });
  await useMingle.getState().refreshNow();
  expect(useMingle.getState().activeProjectId).toBe('recent');
  await vi.waitFor(() => expect(rememberProject).toHaveBeenLastCalledWith('recent'));
});

it('falls back to recent real activity when the remembered project was removed', async () => {
  const { useMingle } = await import('./store');
  bootstrap.mockResolvedValue({ ...payload('removed'), sessions: [
    { id: 'old', projectId: 'older', updatedAt: '2026-01-01' },
    { id: 'new', projectId: 'recent', updatedAt: '2026-10-01' },
    { id: 'sample', projectId: 'example', updatedAt: '2026-11-01' },
  ] as Session[] });
  await useMingle.getState().refreshNow();
  expect(useMingle.getState().activeProjectId).toBe('recent');
});

it('shows an empty workspace when only legacy example data is available', async () => {
  const { useMingle } = await import('./store');
  bootstrap.mockResolvedValue({ ...payload(), projects: [project('example', true)] });
  await useMingle.getState().refreshNow();
  expect(useMingle.getState().activeProjectId).toBeNull();
  expect(rememberProject).not.toHaveBeenCalled();
});

it('serializes project saves so a slow earlier request cannot overwrite a newer selection', async () => {
  let finishFirst!: () => void;
  rememberProject.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
  const { useMingle } = await import('./store');
  bootstrap.mockResolvedValue(payload('older'));
  await useMingle.getState().refreshNow();
  await vi.waitFor(() => expect(rememberProject).toHaveBeenCalledWith('older'));
  useMingle.getState().selectProject('recent');
  await Promise.resolve();
  expect(rememberProject).toHaveBeenCalledTimes(1);
  finishFirst();
  await vi.waitFor(() => expect(rememberProject).toHaveBeenLastCalledWith('recent'));
  expect(rememberProject).toHaveBeenCalledTimes(2);
});

it('does not let a browser popout overwrite the main workspace preference', async () => {
  vi.stubGlobal('window', { location: { search: '?browserPopout=browser-session' } });
  const { useMingle } = await import('./store');
  bootstrap.mockResolvedValue(payload('older'));
  await useMingle.getState().refreshNow();
  useMingle.getState().selectProject('recent');
  await Promise.resolve();
  expect(rememberProject).not.toHaveBeenCalled();
});
