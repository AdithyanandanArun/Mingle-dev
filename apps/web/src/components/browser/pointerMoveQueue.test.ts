import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAction } from '@mingle/contracts';
import { createPointerMoveQueue } from './pointerMoveQueue';

describe('pointer move queue', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('coalesces a burst to the latest coordinates on the next display frame', () => {
    let callback: FrameRequestCallback | undefined;
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { callback = cb; return 17; });
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const send = vi.fn();
    const queue = createPointerMoveQueue(send);
    queue.queue({ type: 'pointer', phase: 'move', x: 2, y: 3 });
    queue.queue({ type: 'pointer', phase: 'move', x: 8, y: 9 });
    expect(send).not.toHaveBeenCalled();
    callback?.(16);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ type: 'pointer', phase: 'move', x: 8, y: 9 });
  });

  it('flushes a pending move before ordered button input and cancels on clear', () => {
    vi.stubGlobal('requestAnimationFrame', () => 18);
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const sent: BrowserAction[] = [];
    const queue = createPointerMoveQueue((action) => sent.push(action));
    queue.queue({ type: 'pointer', phase: 'move', x: 4, y: 5 });
    queue.flush();
    sent.push({ type: 'pointer', phase: 'down', x: 4, y: 5, button: 'left' });
    queue.queue({ type: 'pointer', phase: 'move', x: 6, y: 7 });
    queue.clear();
    expect(sent.map((action) => action.type === 'pointer' ? action.phase : action.type)).toEqual(['move', 'down']);
    expect(cancel).toHaveBeenCalledWith(18);
  });
});
