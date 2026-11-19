import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '@mingle/contracts';
import { api } from '../../lib/api';
import { useMingle } from '../../store/store';
import { usePresence } from '../../lib/motion';
import { compactBlocker, contextReading } from './ContextUsageModel';
import { contextPopoverPosition } from './ContextPopoverPosition';
import { useContextCompaction } from './useContextCompaction';
import './ContextUsage.css';

export function ContextUsage({ session, disabled = false, disabledReason }: { session: Session | null; disabled?: boolean; disabledReason?: string }) {
  const reading = contextReading(session);
  const { state, start, cancel } = useContextCompaction(session?.id ?? null);
  const compacting = state.status === 'running';
  const blocker = compactBlocker(session, disabled, disabledReason);
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const compactButton = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focusRequested, setFocusRequested] = useState(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof contextPopoverPosition> | null>(null);
  const { present, closing } = usePresence(open);
  const id = useId();
  const keepOpen = () => { if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = null; setOpen(true); };
  const closeSoon = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (!panel.current?.contains(document.activeElement) && document.activeElement !== button.current) setOpen(false);
    }, 180);
  };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useEffect(() => { setOpen(false); setPosition(null); setFocusRequested(false); }, [session?.id]);
  useLayoutEffect(() => {
    if (!open || !panel.current || !button.current) return;
    const place = () => {
      if (!panel.current || !button.current) return;
      const viewport = window.visualViewport;
      setPosition(contextPopoverPosition(button.current.getBoundingClientRect(), {
        width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight,
        left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
      }, panel.current.scrollHeight));
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(panel.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!panel.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      // A hover alone does not take keyboard control away from the composer.
      const focused = document.activeElement;
      if (focused === button.current || panel.current?.contains(focused)) {
        event.preventDefault();
        event.stopPropagation();
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true);
    document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); document.removeEventListener('focusin', outside); };
  }, [open]);
  useEffect(() => {
    if (!open || !position || !focusRequested) return;
    setFocusRequested(false);
    const action = compactButton.current;
    (action?.getAttribute('aria-disabled') === 'false' ? action : panel.current)?.focus({ preventScroll: true });
  }, [open, position, focusRequested]);
  const circumference = 2 * Math.PI * 7;
  return <>
    <button ref={button} type="button" className={`context-usage context-usage--${reading.tone}${compacting ? ' is-compacting' : ''}`}
      aria-label={reading.label} aria-haspopup="dialog" aria-expanded={open} aria-controls={present ? id : undefined}
      onPointerEnter={event => { if (event.pointerType !== 'touch') keepOpen(); }} onPointerLeave={closeSoon}
      onClick={event => { setFocusRequested(event.detail === 0); keepOpen(); }}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setFocusRequested(true); keepOpen(); } }}>
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <circle className="context-usage__track" cx="10" cy="10" r="7" />
        <circle className="context-usage__arc" cx="10" cy="10" r="7" transform="rotate(-90 10 10)"
          strokeDasharray={reading.fraction === null ? '2 3' : circumference} strokeDashoffset={reading.fraction === null ? 0 : circumference * (1 - reading.fraction)} />
      </svg>
    </button>
    {present ? createPortal(<div ref={panel} id={id} role="dialog" aria-label="Conversation context" tabIndex={-1}
      aria-hidden={closing || !position || undefined} inert={closing || !position}
      className={`context-details${closing ? ' is-closing' : ''}`} style={position ?? { visibility: 'hidden' }}
      onPointerEnter={keepOpen} onPointerLeave={closeSoon}>
      <strong>{reading.percent === null ? reading.label : `${reading.percent.toFixed(1)}% of context used`}</strong>
      {reading.usedTokens !== null ? <p>{reading.usedTokens.toLocaleString()} tokens{reading.capacity ? ` of ${reading.capacity.toLocaleString()}` : ' · capacity unreported'}</p> : <p>{session?.providerSessionId ? 'Waiting for the provider’s next context report.' : session ? 'Context usage appears after the provider reports it on a turn.' : 'Select one agent to view its context.'}</p>}
      {reading.estimated ? <p>Estimated from the provider’s latest report.</p> : null}
      {reading.updatedAt ? <p><time dateTime={reading.updatedAt}>Last reported {new Date(reading.updatedAt).toLocaleTimeString()}</time></p> : null}
      <p>Compact older conversation context using the provider’s native compaction.</p>
      {session?.provider === 'antigravity' ? <p>Custom auto-compaction is unavailable for Antigravity.</p>
        : session ? <AutoCompactionThreshold key={session.id} session={session} /> : null}
      {blocker && !compacting ? <p id={`${id}-blocked`}>{blocker}</p> : null}
      <button ref={compactButton} type="button"
        aria-disabled={compacting ? state.cancelling : Boolean(blocker)}
        aria-describedby={blocker && !compacting ? `${id}-blocked` : undefined}
        onClick={() => {
          if (compacting && !state.cancelling) void cancel();
          else if (!compacting && !blocker && session) void start();
        }}>
        {compacting ? (state.cancelling ? 'Cancelling…' : 'Cancel compaction') : 'Compact conversation'}
      </button>
      {state.status !== 'idle' ? <p role={state.status === 'failed' ? 'alert' : 'status'}>{state.message}</p> : null}
    </div>, document.body) : null}
  </>;
}

function AutoCompactionThreshold({ session }: { session: Session }) {
  const saved = session.autoCompactionPercent == null ? '' : String(session.autoCompactionPercent);
  const [draft, setDraft] = useState(saved);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const helpId = useId();
  useEffect(() => setDraft(saved), [saved]);

  const save = async () => {
    const value = draft.trim();
    const percent = value ? Number(value) : null;
    if (percent !== null && (!/^\d+$/.test(value) || percent < 1 || percent > 100)) {
      setError('Enter a whole percentage from 1 to 100, or clear the field to turn it off.');
      return;
    }
    if (pending || percent === (session.autoCompactionPercent ?? null)) return;
    setPending(true);
    setError('');
    try {
      const updated = await api.updateSessionAutoCompaction(session.id, percent);
      useMingle.setState(state => ({ boot: state.boot ? { ...state.boot,
        sessions: state.boot.sessions.map(row => row.id === updated.id ? { ...row, autoCompactionPercent: updated.autoCompactionPercent } : row),
      } : state.boot }));
      setDraft(updated.autoCompactionPercent == null ? '' : String(updated.autoCompactionPercent));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save auto-compaction.');
    } finally {
      setPending(false);
    }
  };

  return <form className="context-auto-compact" aria-busy={pending} onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="context-auto-compact__row">
      <label>Auto-compact at
        <input aria-label="Auto-compact at percentage" aria-describedby={helpId} aria-invalid={Boolean(error)}
          inputMode="numeric" value={draft} disabled={pending} placeholder="Off"
          onChange={event => { setDraft(event.target.value); setError(''); }} />
        <span aria-hidden="true">%</span>
      </label>
      <button type="submit" disabled={pending || draft === saved}>{pending ? 'Saving…' : 'Save'}</button>
    </div>
    <p id={helpId}>Pauses and resumes this conversation after compaction. Clear to turn off.</p>
    {error ? <p role="alert">{error}</p> : null}
  </form>;
}
