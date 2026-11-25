import type { BrowserAction } from '@mingle/contracts';

const MOVE_INTERVAL_MS = 50;

/** Keeps the latest move, paced independently of the display refresh rate. */
export function createPointerMoveQueue(send: (action: BrowserAction) => void) {
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSentAt = -Infinity;
  let pending: BrowserAction | null = null;

  const cancel = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    cancel();
    if (pending) {
      const action = pending;
      pending = null;
      lastSentAt = performance.now();
      send(action);
    }
  };
  return {
    queue(action: BrowserAction) {
      pending = action;
      if (frame || timer !== undefined) return;
      const wait = MOVE_INTERVAL_MS - (performance.now() - lastSentAt);
      if (wait <= 0) frame = requestAnimationFrame(flush);
      else timer = setTimeout(() => {
        timer = undefined;
        frame = requestAnimationFrame(flush);
      }, wait);
    },
    flush,
    clear() {
      cancel();
      pending = null;
    },
  };
}
