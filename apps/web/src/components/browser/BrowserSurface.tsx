import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { BrowserAction, BrowserTab } from '@mingle/contracts';
import { chunkText, keyToAction } from '../../lib/browserKeys';
import { cx } from '../../lib/format';
import { Spinner } from '../ui';
import type { BrowserStream } from './useBrowserStream';

const MOVE_INTERVAL_MS = 50;
const WHEEL_INTERVAL_MS = 40;
const WHEEL_LIMIT = 4000;
const BUTTONS = ['left', 'middle', 'right'] as const;
/** Moves keyboard focus out of the page (which captures Tab) to the toolbar. */
const isFocusExit = (e: { key: string; altKey: boolean; shiftKey: boolean }) => e.key === 'Escape' && e.altKey && e.shiftKey;

interface Mapped { x: number; y: number; inside: boolean }
/** Maps a screen point to server viewport coordinates, accounting for the letterboxing of a contained image. */
function mapPoint(stage: HTMLElement, clientX: number, clientY: number, frame: { width: number; height: number } | null, viewport: BrowserTab['viewport']): Mapped {
  const rect = stage.getBoundingClientRect();
  const aspect = frame && frame.height > 0 ? frame.width / frame.height : viewport.width / viewport.height;
  let width = rect.width;
  let height = rect.height;
  if (width / height > aspect) width = height * aspect; else height = width / aspect;
  const nx = (clientX - (rect.left + (rect.width - width) / 2)) / width;
  const ny = (clientY - (rect.top + (rect.height - height) / 2)) / height;
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  return { x: clamp(nx * viewport.width, viewport.width), y: clamp(ny * viewport.height, viewport.height), inside: nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 };
}

export function BrowserSurface({ stream, tab, canvasRef, canInput }: { stream: BrowserStream; tab: BrowserTab; canvasRef: RefObject<HTMLCanvasElement | null>; canInput: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const live = useRef({ canInput, send: stream.sendInput, frame: stream.frameSize, viewport: tab.viewport });
  live.current = { canInput, send: stream.sendInput, frame: stream.frameSize, viewport: tab.viewport };
  const move = useRef<{ last: number; timer: number; pending: BrowserAction | null }>({ last: 0, timer: 0, pending: null });
  const pressed = useRef<{ button: (typeof BUTTONS)[number]; x: number; y: number } | null>(null);
  const wheel = useRef<{ timer: number; dx: number; dy: number; x: number; y: number }>({ timer: 0, dx: 0, dy: 0, x: 0, y: 0 });
  const pointer = tab.agentPointer;
  const pointerVisible = pointer !== null && Date.now() - pointer.at < 2000 && stream.frameSize !== null;
  let pointerStyle: React.CSSProperties | undefined;
  if (pointerVisible && pointer && stream.frameSize) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (rect) {
      const aspect = stream.frameSize.width / stream.frameSize.height;
      let width = rect.width; let height = rect.height;
      if (width / height > aspect) width = height * aspect; else height = width / aspect;
      pointerStyle = { left: `${(rect.width - width) / 2 + pointer.x / tab.viewport.width * width}px`, top: `${(rect.height - height) / 2 + pointer.y / tab.viewport.height * height}px` };
    }
  }

  const flushMove = () => {
    const m = move.current;
    window.clearTimeout(m.timer);
    m.timer = 0;
    if (m.pending) { live.current.send(m.pending); m.pending = null; m.last = performance.now(); }
  };
  const releaseAll = () => {
    const m = move.current;
    window.clearTimeout(m.timer); m.timer = 0; m.pending = null;
    window.clearTimeout(wheel.current.timer); wheel.current.timer = 0; wheel.current.dx = 0; wheel.current.dy = 0;
    const down = pressed.current;
    pressed.current = null;
    if (down && live.current.canInput) live.current.send({ type: 'pointer', phase: 'up', x: down.x, y: down.y, button: down.button });
  };
  // Dropping control (or unmounting) must not leave a button held on the remote page.
  useEffect(() => { if (!canInput) releaseAll(); }, [canInput]);
  useEffect(() => releaseAll, []);

  // Wheel handlers must be non-passive to stop the surrounding pane scrolling while the page does.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      const { canInput: ok, frame, viewport } = live.current;
      if (!ok || stream.status !== 'live') return;
      e.preventDefault();
      const point = mapPoint(stage, e.clientX, e.clientY, frame, viewport);
      if (!point.inside) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.height : 1;
      const scale = viewport.width / Math.max(1, stage.getBoundingClientRect().width);
      const w = wheel.current;
      w.dx += e.deltaX * unit * scale; w.dy += e.deltaY * unit * scale; w.x = point.x; w.y = point.y;
      if (w.timer) return;
      w.timer = window.setTimeout(() => {
        const clampDelta = (v: number) => Math.round(Math.max(-WHEEL_LIMIT, Math.min(WHEEL_LIMIT, v)));
        const action: BrowserAction = { type: 'scroll', deltaX: clampDelta(w.dx), deltaY: clampDelta(w.dy), x: w.x, y: w.y };
        w.timer = 0; w.dx = 0; w.dy = 0;
        if (action.deltaX !== 0 || action.deltaY !== 0) live.current.send(action);
      }, WHEEL_INTERVAL_MS);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!canInput || tab.control.holderId === null) return;
    const p = mapPoint(e.currentTarget, e.clientX, e.clientY, stream.frameSize, tab.viewport);
    if (!p.inside && !pressed.current) return;
    const m = move.current;
    m.pending = { type: 'pointer', phase: 'move', x: p.x, y: p.y };
    if (performance.now() - m.last >= MOVE_INTERVAL_MS) flushMove();
    else if (!m.timer) m.timer = window.setTimeout(flushMove, MOVE_INTERVAL_MS);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.focus({ preventScroll: true });
    if (!canInput) return;
    const p = mapPoint(e.currentTarget, e.clientX, e.clientY, stream.frameSize, tab.viewport);
    if (!p.inside) return;
    const button = BUTTONS[e.button];
    if (!button) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    move.current.pending = null;
    flushMove();
    pressed.current = { button, x: p.x, y: p.y };
    stream.sendInput({ type: 'pointer', phase: 'down', x: p.x, y: p.y, button });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const down = pressed.current;
    if (!canInput || !down) return;
    const p = mapPoint(e.currentTarget, e.clientX, e.clientY, stream.frameSize, tab.viewport);
    flushMove();
    pressed.current = null;
    stream.sendInput({ type: 'pointer', phase: 'up', x: p.x, y: p.y, button: down.button });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!canInput) return;
    // The page owns the keyboard while it has focus; keep Mingle's own shortcuts (command menu, terminal) out of it.
    e.stopPropagation();
    if (isFocusExit(e)) {
      e.preventDefault();
      e.currentTarget.closest('.browser')?.querySelector<HTMLElement>('[data-browser-focus-exit]')?.focus();
      return;
    }
    const action = keyToAction(e);
    if (!action) return;
    e.preventDefault();
    stream.sendInput(action);
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => { if (canInput) e.stopPropagation(); };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!canInput) return;
    e.preventDefault();
    e.stopPropagation();
    // Only the text the user explicitly pasted here is forwarded; the clipboard is never read on its own.
    const text = e.clipboardData.getData('text/plain');
    for (const chunk of chunkText(text)) stream.sendInput({ type: 'text', text: chunk });
  };

  const waiting = !stream.frameSize;
  return (
    <div
      ref={stageRef} className={cx('browser-stage', canInput && 'is-controlled')} tabIndex={0} role="application"
      aria-label={canInput ? 'Shared browser page. The agent is driving until you click or type; your input takes control.' : 'Shared browser page. Another person is driving.'}
      onPointerMove={onPointerMove} onPointerDown={onPointerDown} onPointerUp={onPointerUp}
      onLostPointerCapture={() => { if (pressed.current) releaseAll(); }}
      onContextMenu={(e) => { if (canInput) e.preventDefault(); }}
      onKeyDown={onKeyDown} onKeyUp={onKeyUp} onPaste={onPaste} onBlur={() => { if (pressed.current) releaseAll(); }}
    >
      <canvas ref={canvasRef} className={cx('browser-stage__canvas', waiting && 'is-empty')} />
      {waiting ? (
        <div className="browser-stage__note" role="status">
          {stream.status === 'closed' ? 'Stream disconnected.' : <><Spinner label="Connecting to the browser" /><span>{stream.status === 'live' ? 'Waiting for the first frame…' : 'Connecting to the browser…'}</span></>}
        </div>
      ) : null}
      {pointerVisible && pointerStyle ? <div className={`browser-agent-pointer${pointer.kind === 'click' ? ' is-click' : ''}`} style={pointerStyle} aria-hidden="true"><span className="browser-agent-pointer__ring" /><span className="browser-agent-pointer__dot" /><span className="browser-agent-pointer__label">Agent</span></div> : null}
    </div>
  );
}
