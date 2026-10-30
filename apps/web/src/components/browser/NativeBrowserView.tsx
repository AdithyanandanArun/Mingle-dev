import { useEffect, useRef, useState } from 'react';
import { BrowserSurface } from './BrowserSurface';
import type { BrowserStream } from './useBrowserStream';
import type { BrowserTab } from '@mingle/contracts';
import type { RefObject } from 'react';
import { hideEmbedded, showEmbedded } from './desktopBridge';
import { cx } from '../../lib/format';

const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], .toast, [data-overlay], .browser-confirm';

function intersects(a: DOMRect, b: DOMRect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function NativeBrowserView({ sessionId, targetId, active, stream, tab, canvasRef, canInput, onFallbackChange }: {
  sessionId: string; targetId: string; active: boolean; stream: BrowserStream; tab: BrowserTab;
  canvasRef: RefObject<HTMLCanvasElement | null>; canInput: boolean;
  /** Tells the pane when the screencast is needed (an overlay covers the native view), so the stream runs only then. */
  onFallbackChange?: (fallback: boolean) => void;
}) {
  const placeholder = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState(false);
  const fallbackListener = useRef(onFallbackChange);
  fallbackListener.current = onFallbackChange;
  useEffect(() => { fallbackListener.current?.(fallback); }, [fallback]);
  useEffect(() => () => fallbackListener.current?.(false), []);

  useEffect(() => {
    let frame = 0;
    let disposed = false;
    let bridgeFailed = false;
    // The body observer fires on most UI updates; only tell the desktop app when what it shows actually changes.
    let shown: string | null = null;
    let hidden = false;
    const hide = () => { if (hidden) return; hidden = true; shown = null; void hideEmbedded(sessionId); };
    const show = (rect: { x: number; y: number; width: number; height: number }) => {
      const key = `${targetId}:${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
      if (key === shown) return;
      shown = key; hidden = false;
      void showEmbedded(sessionId, targetId, rect).then((ok) => {
        if (disposed || ok) return;
        bridgeFailed = true;
        hide();
        setFallback(true);
      }, () => {
        if (disposed) return;
        bridgeFailed = true;
        hide();
        setFallback(true);
      });
    };
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = placeholder.current;
        if (!active || document.hidden || !element) { hide(); return; }
        const rect = element.getBoundingClientRect();
        const overlay = [...document.querySelectorAll<HTMLElement>(OVERLAYS)].some((item) => {
          // Full-view/float browser containers can themselves be dialogs. They host this
          // native page; only a separate overlay covering the page needs a stream fallback.
          if (item.contains(element)) return false;
          if (item.closest('[aria-hidden="true"]') || item.closest('[inert]')) return false;
          const style = getComputedStyle(item);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
          const box = item.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && intersects(rect, box);
        });
        setFallback(overlay || bridgeFailed);
        const maxWidth = Math.max(0, window.innerWidth - Math.max(0, rect.left));
        const maxHeight = Math.max(0, window.innerHeight - Math.max(0, rect.top));
        const x = Math.max(0, Math.round(rect.left));
        const y = Math.max(0, Math.round(rect.top));
        const width = Math.min(Math.round(rect.width), Math.round(maxWidth));
        const height = Math.min(Math.round(rect.height), Math.round(maxHeight));
        if (overlay || bridgeFailed || width < 40 || height < 40) { hide(); return; }
        show({ x, y, width, height });
      });
    };
    const observer = new ResizeObserver(measure);
    if (placeholder.current) observer.observe(placeholder.current);
    const mutation = new MutationObserver(measure);
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'aria-hidden', 'inert'] });
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    document.addEventListener('visibilitychange', measure);
    measure();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame); observer.disconnect(); mutation.disconnect();
      window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true);
      document.removeEventListener('visibilitychange', measure);
      hidden = false;
      hide();
    };
  }, [sessionId, targetId, active]);

  return <><div ref={placeholder} className={cx('browser-native-placeholder', fallback && 'is-fallback')} tabIndex={0} role="application" aria-label="Web page (built-in browser). Click to use it. Press Alt+Shift+Escape to return to Mingle." onKeyDown={(event) => {
    if (event.altKey && event.shiftKey && event.key === 'Escape') {
      event.preventDefault();
      document.getElementById('browser-address')?.focus({ preventScroll: true });
    }
  }} />{fallback ? <BrowserSurface stream={stream} tab={tab} canvasRef={canvasRef} canInput={canInput} /> : null}</>;
}
