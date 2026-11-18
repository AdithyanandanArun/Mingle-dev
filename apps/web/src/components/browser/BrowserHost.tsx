import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/format';
import { usePresence } from '../../lib/motion';

interface Geometry { left: number; top: number; width: number; height: number }
type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';
type PointerInteraction = { kind: 'move' } | { kind: 'resize'; corner: ResizeCorner };

const PIP_GUTTER = 12;
const PIP_MIN_WIDTH = 320;
const PIP_MIN_HEIGHT = 240;
const RESIZE_CORNERS: { corner: ResizeCorner; label: string }[] = [
  { corner: 'nw', label: 'top-left' },
  { corner: 'ne', label: 'top-right' },
  { corner: 'sw', label: 'bottom-left' },
  { corner: 'se', label: 'bottom-right' },
];

function viewportBounds() {
  const gutterX = Math.min(PIP_GUTTER, Math.max(0, (window.innerWidth - 1) / 2));
  const gutterY = Math.min(PIP_GUTTER, Math.max(0, (window.innerHeight - 1) / 2));
  const maxWidth = Math.max(1, window.innerWidth - gutterX * 2);
  const maxHeight = Math.max(1, window.innerHeight - gutterY * 2);
  return {
    gutterX, gutterY, maxWidth, maxHeight,
    minWidth: Math.min(PIP_MIN_WIDTH, maxWidth), minHeight: Math.min(PIP_MIN_HEIGHT, maxHeight),
  };
}

function initialGeometry(): Geometry {
  const { gutterX, gutterY, maxWidth, maxHeight } = viewportBounds();
  const width = Math.min(480, maxWidth), height = Math.min(360, maxHeight);
  return {
    left: Math.max(gutterX, window.innerWidth - width - gutterX),
    top: Math.max(gutterY, window.innerHeight - height - gutterY), width, height,
  };
}

function clampGeometry(value: Geometry): Geometry {
  const { gutterX, gutterY, maxWidth, maxHeight, minWidth, minHeight } = viewportBounds();
  const width = Math.min(maxWidth, Math.max(minWidth, value.width));
  const height = Math.min(maxHeight, Math.max(minHeight, value.height));
  return {
    left: Math.max(gutterX, Math.min(window.innerWidth - gutterX - width, value.left)),
    top: Math.max(gutterY, Math.min(window.innerHeight - gutterY - height, value.top)), width, height,
  };
}

function resizeFromCorner(origin: Geometry, corner: ResizeCorner, dx: number, dy: number): Geometry {
  const { gutterX, gutterY } = viewportBounds();
  const west = corner.endsWith('w'), north = corner.startsWith('n');
  const right = origin.left + origin.width, bottom = origin.top + origin.height;
  const maxWidth = Math.max(1, west ? right - gutterX : window.innerWidth - gutterX - origin.left);
  const maxHeight = Math.max(1, north ? bottom - gutterY : window.innerHeight - gutterY - origin.top);
  const minWidth = Math.min(PIP_MIN_WIDTH, maxWidth), minHeight = Math.min(PIP_MIN_HEIGHT, maxHeight);
  const width = Math.max(minWidth, Math.min(maxWidth, origin.width + (west ? -dx : dx)));
  const height = Math.max(minHeight, Math.min(maxHeight, origin.height + (north ? -dy : dy)));
  return {
    left: west ? right - width : origin.left,
    top: north ? bottom - height : origin.top,
    width, height,
  };
}

/**
 * Moves one browser host between its docked slot, a modeless in-app picture-in-picture panel, and a full-window
 * overlay. The host is never cloned, so its socket, canvas and held-input cleanup survive layout changes.
 */
export function BrowserHost({
  expanded, floating, onDismiss, onDock, onMinimize, onPopout, children,
}: {
  expanded: boolean; floating: boolean; onDismiss(): void; onDock(): void; onMinimize?: () => void; onPopout?: () => void; children: ReactNode;
}) {
  const host = useMemo(() => {
    const element = document.createElement('div');
    element.className = 'browser';
    return element;
  }, []);
  const inline = useRef<HTMLDivElement>(null);
  const floatingSlot = useRef<HTMLDivElement>(null);
  const floatingPanel = useRef<HTMLElement>(null);
  const floatingHeader = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const interactionCleanup = useRef<(() => void) | null>(null);
  const [overlaySlot, setOverlaySlot] = useState<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<Geometry>(initialGeometry);
  const { present: overlayPresent, closing: overlayClosing } = usePresence(expanded);

  useLayoutEffect(() => {
    const target = expanded ? overlaySlot : floating ? floatingSlot.current : inline.current;
    if (!target || host.parentNode === target) return;
    const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null;
    if (expanded && focused) returnFocus.current = focused;
    target.appendChild(host);
    const wasRestored = floating && document.activeElement?.classList.contains('browser-restore');
    const next = focused ?? (wasRestored ? floatingHeader.current : null) ?? (!expanded ? returnFocus.current : null);
    if (next?.isConnected) next.focus({ preventScroll: true });
    if (!expanded) returnFocus.current = null;
  }, [expanded, floating, overlaySlot, host]);

  useEffect(() => () => interactionCleanup.current?.(), []);
  useEffect(() => () => interactionCleanup.current?.(), [floating, expanded]);
  useEffect(() => {
    const resize = () => {
      interactionCleanup.current?.();
      setGeometry((value) => clampGeometry(value));
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useLayoutEffect(() => {
    if (!expanded || !overlaySlot) return;
    const focusable = () => Array.from(host.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])'))
      .filter((element) => element.getClientRects().length > 0);
    if (!host.contains(document.activeElement)) (focusable()[0] ?? overlaySlot).focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0], last = items.at(-1);
      if (!first || !last) { event.preventDefault(); overlaySlot.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    overlaySlot.addEventListener('keydown', onKey);
    return () => overlaySlot.removeEventListener('keydown', onKey);
  }, [expanded, overlaySlot, host]);

  const startInteraction = useCallback((event: ReactPointerEvent<HTMLElement>, interaction: PointerInteraction) => {
    if (event.button !== 0 || !event.isPrimary) return;
    if (interaction.kind === 'move' && (event.target as HTMLElement).closest('button')) return;
    const panel = floatingPanel.current;
    const originRect = panel?.getBoundingClientRect();
    if (!originRect) return;
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    try { target.setPointerCapture(pointerId); }
    catch { return; }
    event.preventDefault();
    interactionCleanup.current?.();
    const origin = clampGeometry({ left: originRect.left, top: originRect.top, width: originRect.width, height: originRect.height });
    const startX = event.clientX, startY = event.clientY;
    let active = true;
    const cleanup = () => {
      if (!active) return;
      active = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', cleanup);
      target.removeEventListener('lostpointercapture', cleanup);
      if (interactionCleanup.current === cleanup) interactionCleanup.current = null;
      try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId); }
      catch { /* The target may have been detached during a mode change. */ }
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      next.preventDefault();
      const dx = next.clientX - startX, dy = next.clientY - startY;
      setGeometry(interaction.kind === 'move'
        ? clampGeometry({ ...origin, left: origin.left + dx, top: origin.top + dy })
        : resizeFromCorner(origin, interaction.corner, dx, dy));
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId === pointerId) cleanup();
    };
    const end = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      move(next);
      cleanup();
    };
    target.addEventListener('lostpointercapture', cleanup);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', cleanup);
    interactionCleanup.current = cleanup;
  }, []);

  const onDragStart = (event: ReactPointerEvent<HTMLElement>) => startInteraction(event, { kind: 'move' });

  const onDragKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    const delta = event.shiftKey ? 40 : 12;
    const next = { ...geometry };
    if (event.key === 'ArrowLeft') next.left -= delta;
    else if (event.key === 'ArrowRight') next.left += delta;
    else if (event.key === 'ArrowUp') next.top -= delta;
    else if (event.key === 'ArrowDown') next.top += delta;
    else return;
    event.preventDefault();
    setGeometry(clampGeometry(next));
  };

  const onResizeKey = (event: React.KeyboardEvent<HTMLElement>, corner: ResizeCorner) => {
    const delta = event.shiftKey ? 40 : 12;
    const dx = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0;
    const dy = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    setGeometry((value) => resizeFromCorner(value, corner, dx, dy));
  };

  return (
    <>
      <div className="browser-slot" ref={inline} />
      {floating && !expanded ? createPortal(
        <section
          className="browser-pip" ref={floatingPanel}
          style={{ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height }}
          aria-label="Floating shared browser"
        >
          <header ref={floatingHeader} className="browser-pip__handle" tabIndex={0} aria-label="Move floating browser with arrow keys; hold Shift to move farther" onPointerDown={onDragStart} onKeyDown={onDragKey}>
            <span className="browser-pip__title">Shared browser</span>
            {onPopout ? <button type="button" className="browser-pip__action" onClick={onPopout}>Open desktop window</button> : null}
            {onMinimize ? <button type="button" className="browser-pip__action" aria-label="Minimize floating browser" onClick={onMinimize}>Minimize</button> : null}
            <button type="button" className="browser-pip__action" onClick={onDock}>Dock browser</button>
          </header>
          <div className="browser-pip__content" ref={floatingSlot} />
          {RESIZE_CORNERS.map(({ corner, label }) => (
            <div
              key={corner}
              className={`browser-pip__resize-handle browser-pip__resize-handle--${corner}`}
              role="group"
              tabIndex={0}
              aria-label={`Resize floating browser from ${label} corner with arrow keys; hold Shift to resize farther`}
              onPointerDown={(event) => startInteraction(event, { kind: 'resize', corner })}
              onKeyDown={(event) => onResizeKey(event, corner)}
            />
          ))}
        </section>, document.body,
      ) : null}
      {overlayPresent ? createPortal(
        <div className={cx('browser-overlay', overlayClosing && 'is-closing')} aria-hidden={overlayClosing || undefined} inert={overlayClosing} onMouseDown={(e) => { if (!overlayClosing && e.target === e.currentTarget) onDismiss(); }}>
          <div className="browser-overlay__panel" role="dialog" aria-modal="true" aria-label="Shared browser" tabIndex={-1} ref={setOverlaySlot} />
        </div>,
        document.body,
      ) : null}
      {createPortal(children, host)}
    </>
  );
}
