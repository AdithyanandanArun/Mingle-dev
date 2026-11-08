import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cx } from '../lib/format';
import { usePresence } from '../lib/motion';

export interface SelectOption { value: string; label: string; group?: string; description?: string; badge?: string; disabled?: boolean }

/** A compact choice control with a shared popover, keyboard navigation and viewport-aware placement. */
export function SelectMenu({ id, label, value, onChange, options, disabled, readOnly, className, placement = 'bottom', title, triggerRef, displayValue, openRequest, selectedValues }: {
  id?: string; label: string; value: string; onChange: (value: string) => void; options: SelectOption[];
  disabled?: boolean; readOnly?: boolean; className?: string; placement?: 'top' | 'bottom'; title?: string; triggerRef?: Ref<HTMLButtonElement>;
  displayValue?: string; openRequest?: number; selectedValues?: string[];
}) {
  const listId = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: '', at: 0 });
  const handledOpenRequest = useRef(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const selected = options.find((option) => option.value === value);
  const enabled = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
  const effectiveOpen = open && !disabled;
  const { present, closing } = usePresence(effectiveOpen);

  const show = (fromEnd = false) => {
    if (disabled || enabled.length === 0) return;
    const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
    setActive(selectedIndex >= 0 ? selectedIndex : enabled[fromEnd ? enabled.length - 1 : 0]!);
    setPosition(null);
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!effectiveOpen || !anchor.current || !popup.current) return;
    const measure = () => {
      if (!anchor.current || !popup.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const width = Math.max(1, Math.min(Math.max(224, rect.width), window.innerWidth - 24));
      popup.current.style.width = `${width}px`;
      const above = Math.max(40, rect.top - 20);
      const below = Math.max(40, window.innerHeight - rect.bottom - 20);
      const preferTop = placement === 'top';
      const useTop = preferTop ? above >= Math.min(240, below) : below < Math.min(240, above);
      const maxHeight = Math.min(340, useTop ? above : below);
      const height = Math.min(popup.current.scrollHeight + 2, maxHeight);
      setPosition({
        width, maxHeight, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: useTop ? Math.max(12, rect.top - height - 8) : rect.bottom + 8,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor.current);
    observer.observe(popup.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [effectiveOpen, placement, options.length]);

  useEffect(() => {
    if (!effectiveOpen) return;
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
    };
  }, [effectiveOpen]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!openRequest || openRequest === handledOpenRequest.current || disabled || enabled.length === 0) return;
    handledOpenRequest.current = openRequest;
    anchor.current?.focus();
    show();
  }, [openRequest, disabled, enabled.length]);
  useLayoutEffect(() => {
    if (effectiveOpen && position) popup.current?.querySelector<HTMLElement>(`[data-option-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, effectiveOpen, position]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    anchor.current?.focus();
    if (!readOnly && option.value !== value) onChange(option.value);
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Tab') { setOpen(false); return; }
    if (event.key === 'Escape' && effectiveOpen) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (!effectiveOpen) { show(event.key === 'ArrowUp' || event.key === 'End'); return; }
      if (event.key === 'Enter' || event.key === ' ') { choose(active); return; }
      const current = enabled.indexOf(active);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
      if (enabled[next] !== undefined) setActive(enabled[next]);
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      const previous = now - typeahead.current.at < 700 ? typeahead.current.text : '';
      const text = previous.length > 0 && [...previous].every((character) => character === event.key.toLowerCase())
        ? event.key.toLowerCase() : previous + event.key.toLowerCase();
      typeahead.current = { text, at: now };
      const start = enabled.indexOf(active);
      const ordered = enabled.slice(start + 1).concat(enabled.slice(0, start + 1));
      const index = ordered.find((optionIndex) => options[optionIndex]!.label.toLowerCase().startsWith(text));
      if (index !== undefined) { event.preventDefault(); if (!effectiveOpen) show(); setActive(index); }
    }
  };

  return <>
    <button id={id} ref={(element) => { anchor.current = element; if (typeof triggerRef === 'function') triggerRef(element); else if (triggerRef) triggerRef.current = element; }} type="button" role="combobox" aria-label={label} aria-valuetext={displayValue ?? selected?.label ?? value} aria-readonly={readOnly || undefined} aria-haspopup="listbox"
      aria-expanded={effectiveOpen} aria-controls={effectiveOpen ? listId : undefined}
      aria-activedescendant={effectiveOpen ? `${listId}-${active}` : undefined}
      className={cx('select-menu__trigger', className)} disabled={disabled} title={title}
      onKeyDown={keyDown} onBlur={(event) => { if (!popup.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }}
      onClick={() => effectiveOpen ? setOpen(false) : show()}>
      <span>{displayValue ?? selected?.label ?? value}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
     {present ? createPortal(
      <div ref={popup} id={listId} role="listbox" aria-label={label} aria-hidden={closing || undefined} inert={closing} aria-multiselectable={selectedValues ? true : undefined} className={cx('select-menu__popup', closing && 'is-closing')}
        style={position ?? { visibility: 'hidden' }} onMouseDown={(event) => event.preventDefault()}>
        {options.map((option, index) => <div key={option.value} role="presentation">
          {option.group && (index === 0 || options[index - 1]?.group !== option.group) ? <div className="select-menu__group" role="presentation">{option.group}</div> : null}
          <div id={`${listId}-${index}`} role="option" aria-selected={selectedValues ? selectedValues.includes(option.value) : option.value === value} aria-disabled={option.disabled || undefined}
            data-option-index={index} className={cx('select-menu__option', active === index && 'is-active', (selectedValues ? selectedValues.includes(option.value) : option.value === value) && 'is-selected')}
            onMouseMove={() => { if (!option.disabled) setActive(index); }} onClick={() => choose(index)}>
            <span className="select-menu__option-copy"><span>{option.label}{option.badge ? <small className="select-menu__badge">{option.badge}</small> : null}</span>{option.description ? <small>{option.description}</small> : null}</span>{(selectedValues ? selectedValues.includes(option.value) : option.value === value) ? <Check size={13} aria-hidden="true" /> : null}
          </div>
        </div>)}
      </div>, document.body,
    ) : null}
  </>;
}
