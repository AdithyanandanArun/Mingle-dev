import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Eraser, RotateCw, Square, X } from 'lucide-react';
import { useMingle } from '../store/store';
import { terminalBus } from '../store/terminalBus';
import { Button, IconButton } from './ui';
import { ScopeSwitch } from './context/scope';

const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export default function TerminalPanel({ active }: { active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const term = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  const alive = useRef(true);
  const setupFrame = useRef<number | null>(null);
  const disposeTerminal = useRef<(() => void) | null>(null);
  activeRef.current = active;
  const status = useMingle((s) => s.terminal.status);
  const exitCode = useMingle((s) => s.terminal.exitCode);
  const label = useMingle((s) => s.terminal.label);
  const note = useMingle((s) => s.terminal.note);
  const connection = useMingle((s) => s.connection);
  const theme = useMingle((s) => s.boot?.settings.theme);
  const hasProject = useMingle((s) => Boolean(s.activeProjectId));

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (setupFrame.current !== null) window.cancelAnimationFrame(setupFrame.current);
      setupFrame.current = null;
      disposeTerminal.current?.();
      disposeTerminal.current = null;
    };
  }, []);

  useEffect(() => {
    if (!active || term.current || setupFrame.current !== null) return;
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    // Opening on the next frame avoids xterm touching a renderer that StrictMode tears down immediately.
    const frame = window.requestAnimationFrame(() => {
      setupFrame.current = null;
      if (cancelled || !alive.current || !activeRef.current) return;
      const t = new Terminal({
        fontFamily: 'JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace', fontSize: 12.5, lineHeight: 1.25, cursorBlink: true,
        scrollback: 5000, theme: { background: css('--bg-inset'), foreground: css('--fg-0'), cursor: css('--accent'), selectionBackground: css('--accent-soft') },
      });
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(el);
      fitRef.current = fit;
      term.current = t;
      const safeFit = () => { if (alive.current && activeRef.current && term.current === t) { try { fit.fit(); } catch { /* host not measurable yet */ } } };
      safeFit();

      const snapshot = terminalBus.snapshot();
      if (snapshot) t.write(snapshot);
      const off = terminalBus.subscribe((d) => (d === null ? t.reset() : t.write(d)));
      const dataSub = t.onData((d) => useMingle.getState().sendTerminalInput(d));
      const resizeSub = t.onResize(({ cols, rows }) => useMingle.getState().resizeTerminal(cols, rows));
      const ro = new ResizeObserver(() => safeFit());
      ro.observe(el);

      const s = useMingle.getState();
      if (s.terminal.status === 'idle' && s.connection === 'online' && s.activeProjectId) s.startTerminal(t.cols, t.rows);

      cleanup = () => {
        ro.disconnect(); off(); dataSub.dispose(); resizeSub.dispose(); t.dispose();
        term.current = null; fitRef.current = null;
      };
      disposeTerminal.current = cleanup;
    });
    setupFrame.current = frame;

    return () => {
      if (setupFrame.current !== frame) return;
      cancelled = true;
      window.cancelAnimationFrame(frame);
      setupFrame.current = null;
    };
  }, [active]);

  useEffect(() => {
    if (term.current) term.current.options.theme = { background: css('--bg-inset'), foreground: css('--fg-0'), cursor: css('--accent'), selectionBackground: css('--accent-soft') };
  }, [theme]);

  const restart = () => {
    const s = useMingle.getState();
    s.stopTerminal();
    const t = term.current;
    if (t) { fitRef.current?.fit(); s.startTerminal(t.cols, t.rows); t.focus(); }
  };

  const dead = status === 'exited' || status === 'lost' || status === 'idle';
  const why = note ? note : status === 'exited' ? `Process exited with code ${exitCode ?? '?'}` : status === 'lost' ? (connection === 'online' ? 'Terminal could not start' : 'Connection lost — the shell was closed by the server') : 'Terminal is stopped';

  return (
    <section className="term" aria-label="Terminal">
      <header className="term__bar">
        <strong>Terminal</strong>
        <span className="term__label" title={label}>{label || 'not started'}</span>
        <span className="spacer" />
        <ScopeSwitch compact />
        <IconButton label="Clear terminal output" title="Clear local output without stopping the shell" onClick={() => { terminalBus.clear(); term.current?.focus(); }}><Eraser size={14} /></IconButton>
        <IconButton label="Restart terminal in current scope" onClick={restart} disabled={connection !== 'online' || !hasProject} why={connection !== 'online' ? 'Disconnected' : 'No project'}><RotateCw size={14} /></IconButton>
        <IconButton label="Stop terminal" onClick={() => useMingle.getState().stopTerminal()} disabled={dead} why="Not running"><Square size={13} /></IconButton>
        <IconButton label="Hide terminal" onClick={() => useMingle.getState().toggleTerminal(false)}><X size={15} /></IconButton>
      </header>
      <div className="term__body">
        <div ref={host} className="term__host" />
        {dead ? (
          <div className="term__overlay" role="status">
            <p>{why}</p>
            <Button size="sm" variant="primary" onClick={restart} disabled={connection !== 'online' || !hasProject} why={connection !== 'online' ? 'Waiting for the server connection' : 'No project'}>Start new terminal</Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
