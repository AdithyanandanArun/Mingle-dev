import { useEffect, useRef, useState } from 'react';
import { BrowserSurface } from './BrowserSurface';
import type { BrowserStream } from './useBrowserStream';
import type { BrowserTab } from '@mingle/contracts';
import type { RefObject } from 'react';
import { hideEmbedded, showEmbedded } from './desktopBridge';

const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], .toast, [data-overlay], .browser-confirm';

function intersects(a: DOMRect, b: DOMRect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function NativeBrowserView({ sessionId, targetId, active, stream, tab, canvasRef, canInput }: {
  sessionId: string; targetId: string; active: boolean; stream: BrowserStream; tab: BrowserTab;
  canvasRef: RefObject<HTMLCanvasElement | null>; canInput: boolean;
}) {
  const placeholder = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    let frame = 0;
    const hide = () => { void hideEmbedded(sessionId); };
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = placeholder.current;
        if (!active || document.hidden || !element) { hide(); return; }
        const rect = element.getBoundingClientRect();
        const overlay = [...document.querySelectorAll<HTMLElement>(OVERLAYS)].some((item) => {
          if (item.closest('[aria-hidden="true"]') || item.closest('[inert]')) return false;
          const style = getComputedStyle(item);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
          const box = item.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && intersects(rect, box);
        });
        setFallback(overlay);
        const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
        const maxWidth = Math.max(0, window.innerWidth - Math.max(0, rect.left));
        const maxHeight = Math.max(0, window.innerHeight - Math.max(0, rect.top));
        const x = Math.max(0, Math.round(rect.left));
        const y = Math.max(0, Math.round(rect.top));
        const width = Math.min(Math.round(rect.width), Math.round(maxWidth));
        const height = Math.min(Math.round(rect.height), Math.round(maxHeight));
        if (overlay || width < 40 || height < 40) { hide(); return; }
        void showEmbedded(sessionId, targetId, { x: Math.round(x * zoom), y: Math.round(y * zoom), width: Math.round(width * zoom), height: Math.round(height * zoom) });
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
      cancelAnimationFrame(frame); observer.disconnect(); mutation.disconnect();
      window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true);
      document.removeEventListener('visibilitychange', measure);
      hide();
    };
  }, [sessionId, targetId, active]);

  return <><div ref={placeholder} className="browser-native-placeholder" tabIndex={0} role="application" aria-label="Web page (built-in browser). Click to use it. Press Alt+Shift+Escape to return to Mingle." onKeyDown={(event) => {
    if (event.altKey && event.shiftKey && event.key === 'Escape') {
      event.preventDefault();
      document.getElementById('browser-address')?.focus({ preventScroll: true });
    }
  }} />{fallback ? <BrowserSurface stream={stream} tab={tab} canvasRef={canvasRef} canInput={canInput} /> : null}</>;
}
