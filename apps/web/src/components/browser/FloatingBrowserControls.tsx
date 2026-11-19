import type { ReactNode } from 'react';

function Icon({ children }: { children: ReactNode }) {
  return <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}

export function FloatingBrowserControls({ onPopout, onDock, onDisconnect, disconnectDisabled, onExpand, onMinimize }: {
  onPopout?: () => void; onDock: () => void; onDisconnect?: () => void; disconnectDisabled?: boolean; onExpand?: () => void; onMinimize?: () => void;
}) {
  return <nav className="browser-float-controls" aria-label="Floating browser controls">
    {onPopout && <button type="button" title="Open desktop window" aria-label="Open desktop window" onClick={onPopout}><Icon><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M7 8h6m-6 3h4"/></Icon></button>}
    <button type="button" title="Dock browser" aria-label="Dock browser" onClick={onDock}><Icon><path d="M4 4h12v12H4z"/><path d="M4 12h12"/></Icon></button>
    {onDisconnect && <button type="button" title="Disconnect browser" aria-label="Disconnect browser" disabled={disconnectDisabled} onClick={onDisconnect}><Icon><path d="M6 6l8 8M14 6l-8 8"/><circle cx="10" cy="10" r="7"/></Icon></button>}
    {onExpand && <button type="button" title="Open full browser" aria-label="Open full browser" onClick={onExpand}><Icon><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"/><path d="M7 7l-4-4m10 0 4-4M3 17l4-4m10 4-4-4"/></Icon></button>}
    {onMinimize && <button type="button" title="Minimize floating browser" aria-label="Minimize floating browser" onClick={onMinimize}><Icon><path d="M4 10h12"/></Icon></button>}
  </nav>;
}
