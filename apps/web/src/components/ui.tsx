import {
  Component, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type ButtonHTMLAttributes, type ErrorInfo, type ReactNode, type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import type { Provider, SessionStatus } from '@mingle/contracts';
import { cx } from '../lib/format';
import { usePresence } from '../lib/motion';
import { PROVIDER_NAMES } from '../lib/providers';
import { AntigravityMark } from './AntigravityMark';
import { OpenCodeMark } from './OpenCodeMark';

/* ——— Brand ——— */
export function MingleGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 18V6l7 7 7-7v12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="5" cy="18" r="1.4" fill="currentColor" />
      <circle cx="5" cy="6" r="1.4" fill="currentColor" />
      <circle cx="12" cy="13" r="1.4" fill="currentColor" />
      <circle cx="19" cy="6" r="1.4" fill="currentColor" />
      <circle cx="19" cy="18" r="1.4" fill="currentColor" />
    </svg>
  );
}

export const PROVIDER_NAME: Record<Provider, string> = PROVIDER_NAMES;

export function ProviderMark({ provider, size = 16 }: { provider: Provider; size?: number }) {
  return (
    <span className={cx('pmark', `pmark--${provider}`)} style={{ width: size, height: size }} role="img" aria-label={PROVIDER_NAME[provider]} title={PROVIDER_NAME[provider]}>
      {provider === 'codex' ? (
        <svg viewBox="0 0 16 16" width={size * 0.66} height={size * 0.66} fill="none" aria-hidden="true">
          <path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : provider === 'claude' ? (
        <svg viewBox="0 0 16 16" width={size * 0.7} height={size * 0.7} fill="none" aria-hidden="true">
          <path d="M8 2v12M2.8 5l10.4 6M13.2 5 2.8 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      ) : provider === 'opencode' ? (
        <OpenCodeMark size={size * 0.76} />
      ) : (
        <AntigravityMark size={size * 0.76} />
      )}
    </span>
  );
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: 'Idle', running: 'Running', waiting: 'Needs approval', interrupted: 'Interrupted', error: 'Error',
};
export function StatusDot({ status, label = true }: { status: SessionStatus; label?: boolean }) {
  return (
    <span className={cx('sdot', `sdot--${status}`)} title={STATUS_LABEL[status]}>
      <i aria-hidden="true" />
      {label ? <span>{STATUS_LABEL[status]}</span> : <span className="sr-only">{STATUS_LABEL[status]}</span>}
    </span>
  );
}

/* ——— Buttons ——— */
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  busy?: boolean;
  /** Explains why the control is disabled; shown as a tooltip and to assistive tech. */
  why?: string;
}
export function Button({ variant = 'secondary', size = 'md', busy, why, className, children, disabled, title, type = 'button', ...rest }: BtnProps) {
  const whyId = useId();
  const isDisabled = Boolean(disabled || busy);
  const describedBy = [rest['aria-describedby'], why && isDisabled ? whyId : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <button
      type={type}
      className={cx('btn', `btn--${variant}`, `btn--${size}`, className)}
      disabled={isDisabled}
      title={isDisabled && why ? why : title}
      {...rest}
      aria-busy={busy || undefined}
      aria-describedby={describedBy}
    >
      {busy ? <Loader2 className="spin" size={14} aria-hidden="true" /> : null}
      {children}
      {isDisabled && why ? <span id={whyId} className="sr-only"> (unavailable: {why})</span> : null}
    </button>
  );
}

export function IconButton({ label, children, active, why, busy, className, disabled, ...rest }: Omit<BtnProps, 'variant' | 'size'> & { label: string; active?: boolean }) {
  const whyId = useId();
  const isDisabled = Boolean(disabled || busy);
  return (
    <button
      type="button"
      className={cx('ibtn', active && 'is-active', className)}
      aria-label={busy ? `${label} (busy)` : label}
      aria-busy={busy || undefined}
      aria-describedby={[rest['aria-describedby'], isDisabled && why ? whyId : undefined].filter(Boolean).join(' ') || undefined}
      title={isDisabled && why ? `${label} — ${why}` : label}
      aria-pressed={active}
      disabled={isDisabled}
      {...rest}
    >
      {busy ? <Loader2 className="spin" size={14} aria-hidden="true" /> : null}
      {children}
      {isDisabled && why ? <span id={whyId} className="sr-only"> (unavailable: {why})</span> : null}
    </button>
  );
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'err' | 'info'; children: ReactNode; title?: string }) {
  return <span className={cx('badge', `badge--${tone}`)} title={title}>{children}</span>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-label={label}>
      <Loader2 className="spin" size={16} aria-hidden="true" />
    </span>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon ? <div className="empty__icon" aria-hidden="true">{icon}</div> : null}
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}

export function InlineError({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="inline-error" role="alert">
      <AlertTriangle size={14} aria-hidden="true" />
      <span>{children}</span>
      {onRetry ? <button type="button" className="link-btn" onClick={onRetry}>Retry</button> : null}
    </div>
  );
}

/* ——— Form helpers ——— */
export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <p className="field__hint">{hint}</p> : null}
      {error ? <p className="field__error" role="alert">{error}</p> : null}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; label: string;
  options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[];
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
  const selected = options.findIndex((option) => option.value === value && !option.disabled);
  const tabStop = selected >= 0 ? selected : enabled[0] ?? -1;
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key) || !enabled.length) return;
    const current = enabled.indexOf(options.findIndex((option) => option.value === value));
    const target = e.key === 'Home' ? enabled[0]!
      : e.key === 'End' ? enabled.at(-1)!
        : enabled[(Math.max(0, current) + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length]!;
    onChange(options[target]!.value);
    buttons.current[target]?.focus();
    e.preventDefault();
  };
  return (
    <div className="seg" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o) => (
        <button
          key={o.value} ref={(element) => { buttons.current[options.indexOf(o)] = element; }} type="button" role="radio" aria-checked={o.value === value} tabIndex={options.indexOf(o) === tabStop ? 0 : -1}
          className={cx('seg__item', o.value === value && 'is-on')} title={o.title} disabled={o.disabled} onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, description, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode; id?: string }) {
  const auto = useId();
  const sid = id ?? auto;
  const descriptionId = `${sid}-description`;
  return (
    <div className="switch-row">
      <div>
        <label htmlFor={sid} className="switch-row__label">{label}</label>
        {description ? <p id={descriptionId} className="field__hint">{description}</p> : null}
      </div>
      <button id={sid} type="button" role="switch" aria-label={label} aria-describedby={description ? descriptionId : undefined} aria-checked={checked} className={cx('switch', checked && 'is-on')} onClick={() => onChange(!checked)}>
        <i />
      </button>
    </div>
  );
}

/* ——— Modal / sheet ——— */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
export const DialogMotionContext = createContext(false);

export function Modal({ title, description, onClose, children, footer, variant = 'dialog', width, labelledBy }: {
  title: string; description?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; variant?: 'dialog' | 'sheet' | 'palette'; width?: number; labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  const previousFocus = useRef<HTMLElement | null>(null);
  const focusRestored = useRef(false);
  const wasClosing = useRef(false);
  const closing = useContext(DialogMotionContext);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    focusRestored.current = false;
    const root = ref.current;
    if (root) {
      const auto = root.querySelector<HTMLElement>('[data-autofocus]');
      (auto ?? root.querySelector<HTMLElement>(FOCUSABLE) ?? root).focus({ preventScroll: true });
    }
    return () => {
      if (focusRestored.current) return;
      const previous = previousFocus.current;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      else document.getElementById('main')?.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    if (closing) {
      wasClosing.current = true;
      if (focusRestored.current) return;
      focusRestored.current = true;
      const previous = previousFocus.current;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      else document.getElementById('main')?.focus({ preventScroll: true });
      return;
    }
    if (!wasClosing.current) return;
    wasClosing.current = false;
    focusRestored.current = false;
    const root = ref.current;
    const auto = root?.querySelector<HTMLElement>('[data-autofocus]');
    (auto ?? root?.querySelector<HTMLElement>(FOCUSABLE) ?? root)?.focus({ preventScroll: true });
  }, [closing]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (closing) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      closeRef.current();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (items.length === 0) { e.preventDefault(); ref.current.focus(); return; }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (!ref.current.contains(active) || (e.shiftKey && active === first)) { (e.shiftKey ? last : first).focus(); e.preventDefault(); }
    else if (!e.shiftKey && active === last) { first.focus(); e.preventDefault(); }
  };

  return createPortal(
    <div className={cx('scrim', `scrim--${variant}`, closing && 'is-closing')} aria-hidden={closing || undefined} inert={closing}
      onMouseDown={(e) => { if (!closing && e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref} role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? titleId} tabIndex={-1}
        className={cx('modal', `modal--${variant}`)} style={width ? { width, maxWidth: variant === 'sheet' ? '100vw' : 'calc(100vw - 40px)' } : undefined} onKeyDown={onKeyDown}
      >
        {variant !== 'palette' ? (
          <header className="modal__head">
            <div>
              <h2 id={titleId}>{title}</h2>
              {description ? <p>{description}</p> : null}
            </div>
            <IconButton label="Close dialog" onClick={onClose}><X size={16} /></IconButton>
          </header>
        ) : <h2 id={titleId} className="sr-only">{title}</h2>}
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

/* ——— Popover menu ——— */
interface MenuCtx { close: () => void }
const MenuContext = createContext<MenuCtx>({ close: () => undefined });

export function Menu({ trigger, children, align = 'start', width }: {
  trigger: (props: { onClick: () => void; onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void; 'aria-haspopup': 'menu'; 'aria-expanded': boolean; ref: (el: HTMLButtonElement | null) => void }) => ReactNode;
  children: ReactNode; align?: 'start' | 'end'; width?: number;
}) {
  const [open, setOpen] = useState(false);
  const { present, closing } = usePresence(open);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const openFromEnd = useRef(false);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    anchor.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !pop.current) return;
    const r = anchor.current.getBoundingClientRect();
    const w = Math.min(width ?? Math.max(220, r.width), window.innerWidth - 24);
    pop.current.style.width = `${w}px`;
    const below = window.innerHeight - r.bottom - 20;
    const above = r.top - 20;
    const contentHeight = Math.min(pop.current.scrollHeight + 2, 340);
    const useTop = below < contentHeight && above > below;
    const maxHeight = Math.max(40, Math.min(340, useTop ? above : below));
    const height = Math.min(contentHeight, maxHeight);
    const left = Math.max(12, Math.min(align === 'end' ? r.right - w : r.left, window.innerWidth - w - 12));
    const top = useTop ? Math.max(12, r.top - height - 8) : r.bottom + 8;
    setPos({ left, top, width: w, maxHeight });
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return;
    const items = Array.from(pop.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    items[openFromEnd.current ? items.length - 1 : 0]?.focus();
    const down = (e: MouseEvent) => {
      if (!pop.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    const resized = () => setOpen(false);
    const scrolled = (event: Event) => { if (!pop.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', down);
    window.addEventListener('resize', resized);
    window.addEventListener('scroll', scrolled, true);
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('resize', resized); window.removeEventListener('scroll', scrolled, true); };
  }, [open, pos]);

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(pop.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { items[(i + 1) % items.length]?.focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { items[(i - 1 + items.length) % items.length]?.focus(); e.preventDefault(); }
    else if (e.key === 'Home') { items[0]?.focus(); e.preventDefault(); }
    else if (e.key === 'End') { items.at(-1)?.focus(); e.preventDefault(); }
    else if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close();
  };

  const ctx = useMemo(() => ({ close }), [close]);
  return (
    <>
      {trigger({ onClick: () => { openFromEnd.current = false; setOpen((o) => !o); }, onKeyDown: (event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openFromEnd.current = event.key === 'ArrowUp'; setOpen(true); } }, 'aria-haspopup': 'menu', 'aria-expanded': open, ref: (el) => { anchor.current = el; } })}
      {present ? createPortal(
        <MenuContext.Provider value={ctx}>
          <div ref={pop} role="menu" aria-hidden={closing || undefined} inert={closing} className={cx('menu', closing && 'is-closing')} style={pos ?? { visibility: 'hidden' }} onKeyDown={onKey}>{children}</div>
        </MenuContext.Provider>,
        document.body,
      ) : null}
    </>
  );
}

export function MenuItem({ children, onSelect, icon, hint, disabled, why, selected, danger }: {
  children: ReactNode; onSelect: () => void; icon?: ReactNode; hint?: ReactNode; disabled?: boolean; why?: string; selected?: boolean; danger?: boolean;
}) {
  const { close } = useContext(MenuContext);
  return (
    <button
      type="button" role="menuitem" disabled={disabled} title={disabled ? why : undefined}
      className={cx('menu__item', selected && 'is-selected', danger && 'is-danger')}
      onClick={() => { close(); onSelect(); }}
    >
      {icon ? <span className="menu__icon" aria-hidden="true">{icon}</span> : null}
      <span className="menu__label">{children}</span>
      {hint ? <span className="menu__hint">{hint}</span> : null}
      {selected ? <Check size={13} aria-label="Selected" /> : null}
    </button>
  );
}
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="menu__section" role="presentation">{children}</div>;
export const MenuSeparator = () => <div className="menu__sep" role="separator" />;

/* ——— Error boundary ——— */
export class Boundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('UI boundary caught', error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <EmptyState icon={<AlertTriangle size={20} />} title={`${this.props.label ?? 'This panel'} failed to render`} action={<Button onClick={() => this.setState({ error: null })}>Try again</Button>}>
        {this.state.error.message}
      </EmptyState>
    );
  }
}
