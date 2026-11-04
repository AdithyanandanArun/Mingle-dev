import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/format';
import { usePresence } from '../../lib/motion';

interface Placement { left: number; top: number; width: number; maxHeight: number }

// A choice menu can portal outside this panel while remaining owned by a
// control inside it. Keep that menu's clicks and scrolling inside the panel.
function owns(root: HTMLElement | null, target: Node | null) {
  if (!root || !target) return false;
  if (root.contains(target)) return true;
  const list = target instanceof Element ? target.closest<HTMLElement>('[role="listbox"][id]') : null;
  return Boolean(list && [...root.querySelectorAll('[aria-controls]')].some(control => control.getAttribute('aria-controls') === list.id));
}

/**
 * Non-modal anchored panel: portal-rendered, flips above/below the anchor, closes on Escape / outside press / resize,
 * and returns focus to its anchor. Content may contain any focusable controls.
 */
export function Popover({ anchor, open, onClose, label, children, width = 320, align = 'end', className }: {
  anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void; label: string; children: ReactNode;
  width?: number; align?: 'start' | 'end'; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [place, setPlace] = useState<Placement | null>(null);
  const id = useId();
  const focused = useRef(false);
  const { present, closing } = usePresence(open);

  useLayoutEffect(() => {
    if (!open) return;
    const anchorEl = anchor.current;
    const pop = ref.current;
    if (!anchorEl || !pop) return;
    const rect = anchorEl.getBoundingClientRect();
    const w = Math.min(width, window.innerWidth - 24);
    pop.style.width = `${w}px`;
    const above = rect.top - 16;
    const below = window.innerHeight - rect.bottom - 16;
    const natural = pop.scrollHeight + 2;
    const useTop = below < Math.min(natural, 280) && above > below;
    const maxHeight = Math.max(80, Math.min(520, useTop ? above : below));
    const height = Math.min(natural, maxHeight);
    setPlace({
      width: w, maxHeight,
      left: Math.max(12, Math.min(align === 'end' ? rect.right - w : rect.left, window.innerWidth - w - 12)),
      top: useTop ? Math.max(12, rect.top - height - 8) : rect.bottom + 8,
    });
  }, [open, anchor, width, align, children]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!owns(ref.current, target) && !anchor.current?.contains(target)) closeRef.current();
    };
    const dismiss = () => closeRef.current();
    const scrolled = (event: Event) => { if (!owns(ref.current, event.target as Node)) closeRef.current(); };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', scrolled, true);
    };
  }, [open, anchor]);

  useEffect(() => {
    if (!open) { focused.current = false; return; }
    if (!place || focused.current) return;
    const frame = window.requestAnimationFrame(() => {
      const root = ref.current;
      if (!root) return;
      if (!owns(root, document.activeElement)) (root?.querySelector<HTMLElement>('[data-autofocus]') ?? root)?.focus({ preventScroll: true });
      focused.current = owns(root, document.activeElement);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, place]);

  if (!present) return null;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      closeRef.current();
      anchor.current?.focus();
    }
  };
  return createPortal(
    <div
      ref={ref} id={id} role="dialog" aria-label={label} aria-hidden={closing || !place || undefined} inert={closing || !place} tabIndex={-1} className={cx('popover', className, closing && 'is-closing')}
      style={place ? { ...place, opacity: 1 } : { opacity: 0, pointerEvents: 'none' }} onKeyDown={onKeyDown}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && !owns(ref.current, next) && !anchor.current?.contains(next)) closeRef.current();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
