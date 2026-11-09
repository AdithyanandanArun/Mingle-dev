import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import { cx } from '../lib/format';

export type ContextMenuEntry =
  | { type: 'separator'; id: string }
  | {
      id: string; label: string; onSelect?: () => void; disabled?: boolean; danger?: boolean;
      checked?: boolean; children?: ContextMenuEntry[];
    };

interface Point { left: number; top: number }

const isSeparator = (item: ContextMenuEntry): item is Extract<ContextMenuEntry, { type: 'separator' }> => 'type' in item && item.type === 'separator';
const enabledIndices = (items: ContextMenuEntry[]): number[] => items.flatMap((item, index) => !isSeparator(item) && !item.disabled ? [index] : []);
const childrenOf = (item: ContextMenuEntry): ContextMenuEntry[] => !isSeparator(item) ? item.children ?? [] : [];

export function ContextMenu({ x, y, items, onClose, returnFocus, open = true, closing = false }: {
  x: number; y: number; items: ContextMenuEntry[]; onClose: () => void; returnFocus?: HTMLElement | null; open?: boolean; closing?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const mainButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const childButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const [rootPoint, setRootPoint] = useState<Point | null>(null);
  const [submenuIndex, setSubmenuIndex] = useState<number | null>(null);
  const [submenuPoint, setSubmenuPoint] = useState<Point | null>(null);
  const [activeIndex, setActiveIndex] = useState(() => enabledIndices(items)[0] ?? -1);
  const [activeChildIndex, setActiveChildIndex] = useState(-1);
  const typeahead = useRef({ text: '', at: 0 });

  const close = (restoreFocus: boolean): void => {
    onClose();
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
  };

  const openSubmenu = (index: number, focusFirst: boolean): void => {
    const children = childrenOf(items[index]!);
    if (!children.length) return;
    setActiveIndex(index);
    setSubmenuIndex(index);
    const first = enabledIndices(children)[0] ?? -1;
    setActiveChildIndex(first);
    if (focusFirst && first >= 0) requestAnimationFrame(() => childButtons.current[first]?.focus());
  };

  const runItem = (item: ContextMenuEntry): void => {
    if (isSeparator(item) || item.disabled || !item.onSelect) return;
    close(true);
    item.onSelect();
  };

  const activateMain = (index: number): void => {
    const item = items[index];
    if (!item || isSeparator(item) || item.disabled) return;
    if (childrenOf(item).length) { openSubmenu(index, true); return; }
    runItem(item);
  };

  const activateChild = (parentIndex: number, index: number): void => {
    const item = childrenOf(items[parentIndex]!)[index];
    if (!item || isSeparator(item) || item.disabled) return;
    if (childrenOf(item).length) { setActiveChildIndex(index); return; }
    runItem(item);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const element = root.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    setRootPoint({ left, top });
  }, [open, x, y]);

  // Hidden controls cannot receive focus until their measured position has rendered.
  useLayoutEffect(() => {
    if (!open || closing || !rootPoint || activeIndex < 0) return;
    let frame = 0;
    let attempts = 0;
    const focusVisible = () => {
      const item = mainButtons.current[activeIndex];
      if (!item?.isConnected) return;
      // Chromium can retain inherited visibility for a frame after the portal is positioned.
      if (getComputedStyle(item).visibility !== 'visible' && ++attempts < 4) { frame = requestAnimationFrame(focusVisible); return; }
      item.focus({ preventScroll: true });
    };
    frame = requestAnimationFrame(focusVisible);
    return () => cancelAnimationFrame(frame);
  }, [open, closing, rootPoint]);

  useLayoutEffect(() => {
    if (submenuIndex === null || !submenu.current) return;
    const parent = mainButtons.current[submenuIndex];
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const childRect = submenu.current.getBoundingClientRect();
    const gap = 4;
    const right = parentRect.right + gap;
    const left = right + childRect.width <= window.innerWidth - 8 ? right : Math.max(8, parentRect.left - childRect.width - gap);
    const top = Math.max(8, Math.min(parentRect.top, window.innerHeight - childRect.height - 8));
    setSubmenuPoint({ left, top });
  }, [submenuIndex, rootPoint]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !submenu.current?.contains(target)) close(false);
    };
    const outsideContext = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !submenu.current?.contains(target)) close(false);
    };
    const onViewportChange = (): void => close(true);
    const onScroll = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && (root.current?.contains(target) || submenu.current?.contains(target))) return;
      close(false);
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('contextmenu', outsideContext, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('contextmenu', outsideContext, true);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, onClose, returnFocus]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const inSubmenu = Boolean(submenu.current?.contains(event.target as Node));
    const currentItems = inSubmenu && submenuIndex !== null ? childrenOf(items[submenuIndex]!) : items;
    const enabled = enabledIndices(currentItems);
    const currentIndex = inSubmenu ? activeChildIndex : activeIndex;
    const focusAt = (index: number): void => {
      if (inSubmenu) {
        setActiveChildIndex(index);
        childButtons.current[index]?.focus();
      } else {
        setActiveIndex(index);
        mainButtons.current[index]?.focus();
      }
    };

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (inSubmenu && submenuIndex !== null) {
        setSubmenuIndex(null);
        mainButtons.current[submenuIndex]?.focus();
      } else close(true);
      return;
    }
    if (event.key === 'Tab') {
      close(true);
      return;
    }
    if (event.key === 'ArrowLeft' && inSubmenu && submenuIndex !== null) {
      event.preventDefault();
      setSubmenuIndex(null);
      mainButtons.current[submenuIndex]?.focus();
      return;
    }
    if (event.key === 'ArrowRight' && !inSubmenu && activeIndex >= 0 && childrenOf(items[activeIndex]!).length) {
      event.preventDefault();
      openSubmenu(activeIndex, true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      if (!enabled.length) return;
      event.preventDefault();
      let next: number;
      if (event.key === 'Home') next = enabled[0]!;
      else if (event.key === 'End') next = enabled[enabled.length - 1]!;
      else {
        const at = enabled.indexOf(currentIndex);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        next = enabled[(at + step + enabled.length) % enabled.length]!;
      }
      focusAt(next);
      if (!inSubmenu) setSubmenuIndex(null);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (inSubmenu && submenuIndex !== null) activateChild(submenuIndex, activeChildIndex);
      else if (activeIndex >= 0) activateMain(activeIndex);
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      const character = event.key.toLocaleLowerCase();
      const previous = now - typeahead.current.at < 700 ? typeahead.current.text : '';
      const text = previous.length > 0 && [...previous].every((part) => part === character) ? character : previous + character;
      typeahead.current = { text, at: now };
      const ordered = enabled.slice(enabled.indexOf(currentIndex) + 1).concat(enabled.slice(0, enabled.indexOf(currentIndex) + 1));
      const match = ordered.find((index) => !isSeparator(currentItems[index]!) && currentItems[index]!.label.toLocaleLowerCase().startsWith(text));
      if (match !== undefined) { event.preventDefault(); focusAt(match); }
    }
  };

  const renderEntry = (item: ContextMenuEntry, index: number, nested: boolean): ReactNode => {
    if (isSeparator(item)) return <div key={item.id} className="menu__sep" role="separator" />;
    const hasChildren = childrenOf(item).length > 0;
    const buttonRef = (element: HTMLButtonElement | null): void => {
      if (nested) childButtons.current[index] = element;
      else mainButtons.current[index] = element;
    };
    return <button
      key={item.id} ref={buttonRef} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={item.checked} aria-haspopup={hasChildren ? 'menu' : undefined}
      aria-expanded={hasChildren ? submenuIndex === index : undefined}
      disabled={item.disabled} tabIndex={-1}
      className={cx('menu__item', 'context-menu__item', item.danger && 'is-danger', hasChildren && 'has-submenu')}
      onFocus={() => {
        if (nested) setActiveChildIndex(index);
        else {
          setActiveIndex(index);
          if (submenuIndex !== null && submenuIndex !== index) setSubmenuIndex(null);
        }
      }}
      onMouseEnter={() => {
        if (item.disabled) return;
        if (nested) {
          setActiveChildIndex(index);
          childButtons.current[index]?.focus();
        }
        else {
          setActiveIndex(index);
          mainButtons.current[index]?.focus();
          if (hasChildren) openSubmenu(index, false);
          else setSubmenuIndex(null);
        }
      }}
      onClick={() => nested ? activateChild(submenuIndex ?? -1, index) : activateMain(index)}
    >
      <span className="context-menu__check-slot">{item.checked ? <Check size={14} className="context-menu__check" aria-hidden="true" /> : null}</span>
      <span className="menu__label">{item.label}</span>
      {hasChildren ? <ChevronRight size={14} className="context-menu__chevron" aria-hidden="true" /> : null}
    </button>;
  };

  const rootStyle: CSSProperties = rootPoint
    ? { left: rootPoint.left, top: rootPoint.top }
    : { left: x, top: y, visibility: 'hidden' };
  const submenuStyle: CSSProperties = submenuPoint
    ? { left: submenuPoint.left, top: submenuPoint.top }
    : { visibility: 'hidden' };
  const submenuLabel = submenuIndex === null ? 'More' : (() => {
    const item = items[submenuIndex];
    return item && !isSeparator(item) ? item.label : 'More';
  })();

  return createPortal(
    <>
      <div ref={root} role="menu" aria-label="Session actions" aria-hidden={closing || undefined} inert={closing} className={cx('menu context-menu', closing && 'is-closing')} style={rootStyle} onKeyDown={onKeyDown}>
        {items.map((item, index) => renderEntry(item, index, false))}
      </div>
      {submenuIndex !== null ? (
        <div ref={submenu} role="menu" aria-label={`${submenuLabel} options`} aria-hidden={closing || undefined} inert={closing} className={cx('menu context-menu context-menu--submenu', closing && 'is-closing')} style={submenuStyle}
          onKeyDown={(event) => { event.stopPropagation(); onKeyDown(event); }}>
          {childrenOf(items[submenuIndex]!).map((item, index) => renderEntry(item, index, true))}
        </div>
      ) : null}
    </>,
    document.body,
  );
}
