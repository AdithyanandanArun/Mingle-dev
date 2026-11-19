import { useEffect, useId, useRef, useState } from 'react';
import { AppWindow, Maximize2, Menu, Minus, PanelRight, Unplug, type LucideIcon } from 'lucide-react';

function Control({ icon: Icon, label, onClick, disabled }: {
  icon: LucideIcon;
  label: string;
  onClick(): void;
  disabled?: boolean;
}) {
  return (
    <button type="button" aria-label={label} data-tooltip={label} onClick={onClick} disabled={disabled}>
      <Icon size={15} aria-hidden="true" />
    </button>
  );
}

export function FloatingBrowserControls({ onPopout, onDock, onDisconnect, disconnectDisabled, onExpand, onMinimize }: {
  onPopout?: () => void; onDock: () => void; onDisconnect?: () => void; disconnectDisabled?: boolean; onExpand?: () => void; onMinimize?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const actionsId = useId();
  const container = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = container.current;
    const panel = element?.parentElement;
    if (!element || !panel) return;
    const updateInset = () => {
      const available = panel.clientWidth - 42;
      const width = element.scrollWidth;
      element.style.setProperty('--browser-controls-shift', `${Math.max(0, width - available)}px`);
    };
    const observer = new ResizeObserver(updateInset);
    observer.observe(panel);
    observer.observe(element);
    updateInset();
    return () => observer.disconnect();
  }, [open, onPopout, onDock, onExpand, onMinimize, onDisconnect]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div className="browser-float-controls" ref={container} onKeyDown={(event) => {
      if (!open || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      toggle.current?.focus({ preventScroll: true });
    }}>
      <button
        ref={toggle}
        className="browser-float-controls__toggle"
        type="button"
        aria-label="Floating browser controls"
        aria-expanded={open}
        aria-controls={actionsId}
        data-browser-focus-exit
        onClick={() => setOpen((value) => !value)}
      >
        <Menu size={16} aria-hidden="true" />
      </button>
      <nav id={actionsId} className="browser-float-controls__bubble" aria-label="Floating browser actions" data-open={open} inert={!open}>
        {onPopout ? <Control icon={AppWindow} label="Open desktop window" onClick={onPopout} /> : null}
        <Control icon={PanelRight} label="Dock browser" onClick={onDock} />
        {onExpand ? <Control icon={Maximize2} label="Open full browser" onClick={onExpand} /> : null}
        {onMinimize ? <Control icon={Minus} label="Minimize floating browser" onClick={onMinimize} /> : null}
        {onDisconnect ? <Control icon={Unplug} label="Disconnect browser" onClick={onDisconnect} disabled={disconnectDisabled} /> : null}
      </nav>
    </div>
  );
}
