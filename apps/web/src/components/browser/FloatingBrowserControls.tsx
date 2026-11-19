import { AppWindow, Maximize2, Minus, PanelRight, Unplug, type LucideIcon } from 'lucide-react';

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
  return (
    <nav className="browser-float-controls" aria-label="Floating browser controls">
      {onPopout ? <Control icon={AppWindow} label="Open desktop window" onClick={onPopout} /> : null}
      <Control icon={PanelRight} label="Dock browser" onClick={onDock} />
      {onExpand ? <Control icon={Maximize2} label="Open full browser" onClick={onExpand} /> : null}
      {onMinimize ? <Control icon={Minus} label="Minimize floating browser" onClick={onMinimize} /> : null}
      {onDisconnect ? <Control icon={Unplug} label="Disconnect browser" onClick={onDisconnect} disabled={disconnectDisabled} /> : null}
    </nav>
  );
}
