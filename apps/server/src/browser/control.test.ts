import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_TOUCH_IDLE_MS } from '@mingle/contracts';
import { TabControl } from './control.ts';

describe('TabControl', () => {
  afterEach(() => vi.useRealTimers());
  it('claims on first human input and runs it', async () => {
    const control = new TabControl(); const task = vi.fn(async () => 'ran');
    await expect(control.run({ kind: 'human', id: 'a' }, task)).resolves.toBe('ran');
    expect(task).toHaveBeenCalledOnce(); expect(control.ownerId).toBe('a'); expect(control.lease).toBe('touch');
  });
  it('returns control after idle expiry', async () => {
    vi.useFakeTimers(); const control = new TabControl();
    await control.run({ kind: 'human', id: 'a' }, async () => undefined);
    await vi.advanceTimersByTimeAsync(BROWSER_TOUCH_IDLE_MS);
    expect(control.ownerId).toBeNull();
  });
  it('does not expire while a pointer button is pressed', async () => {
    vi.useFakeTimers(); const control = new TabControl();
    await control.run({ kind: 'human', id: 'a' }, async () => undefined);
    control.pointer('down'); await vi.advanceTimersByTimeAsync(BROWSER_TOUCH_IDLE_MS * 2);
    expect(control.ownerId).toBe('a');
    control.pointer('up'); await vi.advanceTimersByTimeAsync(BROWSER_TOUCH_IDLE_MS);
    expect(control.ownerId).toBeNull();
  });
  it('rejects a second human', async () => {
    const control = new TabControl(); await control.run({ kind: 'human', id: 'a' }, async () => undefined);
    await expect(control.run({ kind: 'human', id: 'b' }, async () => undefined)).rejects.toThrow('Another person');
  });
  it('holds indefinitely and releases to agent', async () => {
    vi.useFakeTimers(); const control = new TabControl(); control.take('a');
    await vi.advanceTimersByTimeAsync(BROWSER_TOUCH_IDLE_MS * 4); expect(control.lease).toBe('hold');
    await control.release('a'); expect(control.ownerId).toBeNull();
  });
  it('gives agent actionable touch and hold errors', async () => {
    const control = new TabControl(); await control.run({ kind: 'human', id: 'a' }, async () => undefined);
    await expect(control.run({ kind: 'agent', id: 'run' }, async () => undefined)).rejects.toThrow('2.5 s');
    control.take('a');
    await expect(control.run({ kind: 'agent', id: 'run' }, async () => undefined)).rejects.toThrow('holding control');
  });
  it('drops an agent write queued before a human claim', async () => {
    const control = new TabControl(); let finish!: () => void;
    const first = control.run({ kind: 'agent', id: 'run' }, () => new Promise<void>((resolve) => { finish = resolve; }));
    const queued = control.run({ kind: 'agent', id: 'run' }, async () => undefined);
    await Promise.resolve();
    const claimed = control.run({ kind: 'human', id: 'a' }, async () => undefined);
    finish(); await first; await claimed;
    await expect(queued).rejects.toThrow('fresh snapshot');
  });
});
