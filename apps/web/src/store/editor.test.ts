import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const { readFile, writeFile, toast, mingle } = vi.hoisted(() => {
  const toast = vi.fn();
  return { readFile: vi.fn(), writeFile: vi.fn(), toast, mingle: { centerTab: 'session', setCenterTab: vi.fn(), toast } };
});
vi.mock('../lib/api', () => ({ api: { readFile, writeFile }, errorMessage: (e: unknown) => e instanceof Error ? e.message : String(e) }));
vi.mock('./store', () => ({ useMingle: { getState: () => mingle } }));
const pending = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
beforeEach(() => {
  vi.resetModules(); readFile.mockReset(); writeFile.mockReset(); toast.mockReset();
  vi.stubGlobal('window', { addEventListener: vi.fn(), confirm: vi.fn(() => true) });
});
afterEach(() => vi.unstubAllGlobals());
async function open() {
  readFile.mockResolvedValueOnce({ content: 'original' });
  const { useEditor } = await import('./editor');
  useEditor.getState().open('example-project', null, 'example.txt');
  await vi.waitFor(() => expect(useEditor.getState().tabs[0]?.status).toBe('ready'));
  return { useEditor, key: useEditor.getState().tabs[0]!.key };
}
it('retains unsaved content and an actionable error until a save succeeds', async () => {
  const { useEditor, key } = await open();
  useEditor.getState().edit(key, 'draft'); writeFile.mockRejectedValueOnce(new Error('Example disconnected'));
  expect(await useEditor.getState().save(key)).toBe(false);
  expect(useEditor.getState().tabs[0]).toMatchObject({ draft: 'draft', original: 'original', saveError: 'Example disconnected', saving: false });
  writeFile.mockResolvedValueOnce({}); expect(await useEditor.getState().save(key)).toBe(true);
  expect(useEditor.getState().tabs[0]).toMatchObject({ original: 'draft', saveError: null });
});
it('preserves edits made while a successful save is in flight', async () => {
  const { useEditor, key } = await open(); const save = pending<unknown>(); writeFile.mockReturnValueOnce(save.promise);
  useEditor.getState().edit(key, 'first'); const action = useEditor.getState().save(key);
  useEditor.getState().edit(key, 'second'); save.resolve({}); await action;
  expect(useEditor.getState().tabs[0]).toMatchObject({ original: 'first', draft: 'second' });
});
it('does not reload over an in-flight save', async () => {
  const { useEditor, key } = await open(); const save = pending<unknown>(); writeFile.mockReturnValueOnce(save.promise);
  useEditor.getState().edit(key, 'draft'); const action = useEditor.getState().save(key);
  await useEditor.getState().reload(key); expect(readFile).toHaveBeenCalledTimes(1); save.resolve({}); await action;
});
it('ignores the old load after a file is closed and reopened', async () => {
  const { useEditor, key } = await open(); const old = pending<{ content: string }>(); readFile.mockReturnValueOnce(old.promise);
  const reload = useEditor.getState().reload(key); useEditor.getState().close(key);
  readFile.mockResolvedValueOnce({ content: 'new lifetime' }); useEditor.getState().open('example-project', null, 'example.txt');
  await vi.waitFor(() => expect(useEditor.getState().tabs[0]?.draft).toBe('new lifetime'));
  old.resolve({ content: 'stale' }); await reload; expect(useEditor.getState().tabs[0]?.draft).toBe('new lifetime');
});
it('ignores old save results after close and reopen', async () => {
  const { useEditor, key } = await open(); const save = pending<unknown>(); writeFile.mockReturnValueOnce(save.promise);
  useEditor.getState().edit(key, 'old draft'); const action = useEditor.getState().save(key); useEditor.getState().close(key);
  readFile.mockResolvedValueOnce({ content: 'reopened' }); useEditor.getState().open('example-project', null, 'example.txt');
  await vi.waitFor(() => expect(useEditor.getState().tabs[0]?.draft).toBe('reopened'));
  save.resolve({}); expect(await action).toBe(false); expect(useEditor.getState().tabs[0]?.original).toBe('reopened'); expect(toast).not.toHaveBeenCalled();
});
it('retains the later reload when requests complete out of order', async () => {
  const { useEditor, key } = await open(); const old = pending<{ content: string }>(); const newer = pending<{ content: string }>();
  readFile.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
  const a = useEditor.getState().reload(key); const b = useEditor.getState().reload(key);
  newer.resolve({ content: 'latest' }); await b; old.reject(new Error('Old failure')); await a;
  expect(useEditor.getState().tabs[0]).toMatchObject({ status: 'ready', draft: 'latest', error: null });
});
