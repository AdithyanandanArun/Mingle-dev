import type { BrowserAction } from '@mingle/contracts';

/** Keeps only the latest move per display frame and flushes before ordered button events. */
export function createPointerMoveQueue(send: (action: BrowserAction) => void) {
  let frame = 0;
  let pending: BrowserAction | null = null;

  const flush = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (pending) {
      const action = pending;
      pending = null;
      send(action);
    }
  };
  return {
    queue(action: BrowserAction) {
      pending = action;
      if (!frame) frame = requestAnimationFrame(flush);
    },
    flush,
    clear() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pending = null;
    },
  };
}
