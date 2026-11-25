import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { BrowserAction, BrowserServerMessage, BrowserTab } from '@mingle/contracts';

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'closed';
export interface FrameSize { width: number; height: number }

const MAX_ERROR_LENGTH = 240;
const ERROR_VISIBLE_MS = 9000;
const RETRY_DELAYS_MS = [1000, 2500, 5000];

const isServerMessage = (value: unknown): value is BrowserServerMessage => {
  const v = value as { type?: unknown } | null;
  return typeof v === 'object' && v !== null && (v.type === 'hello' || v.type === 'state' || v.type === 'frame' || v.type === 'error');
};

const streamUrl = (sessionId: string, tabId: string): string => {
  const params = new URLSearchParams({ sessionId, tabId });
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/browser?${params}`;
};

export interface BrowserStream {
  status: StreamStatus;
  clientId: string | null;
  /** Freshest tab snapshot from the stream; null until the hello message arrives. */
  tab: BrowserTab | null;
  /** Size of the last decoded frame; kept between frames so pointer mapping never loses its reference. */
  frameSize: FrameSize | null;
  error: string | null;
  dismissError(): void;
  /** Sends a human input action; false when the socket is not open. */
  sendInput(action: BrowserAction): boolean;
  setControl(owner: 'human' | 'agent'): boolean;
  reconnect(): void;
}

/**
 * One viewer socket per (session, tab). Frames arrive as a JSON header then a JPEG blob; at most one image is
 * decoding at a time and its acknowledgement is sent only after it loads, which paces the server's screencast.
 */
export function useBrowserStream(sessionId: string | undefined, tabId: string | undefined, enabled: boolean, canvasRef: RefObject<HTMLCanvasElement | null>): BrowserStream {
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [clientId, setClientId] = useState<string | null>(null);
  const [tab, setTab] = useState<BrowserTab | null>(null);
  const [frameSize, setFrameSize] = useState<FrameSize | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const errorTimer = useRef(0);

  const showError = useCallback((message: string) => {
    window.clearTimeout(errorTimer.current);
    setError(message.slice(0, MAX_ERROR_LENGTH));
    errorTimer.current = window.setTimeout(() => setError(null), ERROR_VISIBLE_MS);
  }, []);
  const dismissError = useCallback(() => { window.clearTimeout(errorTimer.current); setError(null); }, []);
  useEffect(() => () => window.clearTimeout(errorTimer.current), []);

  useEffect(() => {
    setClientId(null);
    setTab(null);
    setFrameSize(null);
    setError(null);
    const canvas = canvasRef.current;
    // Release the previous page's backing store while the stream is inactive or switching tabs.
    if (canvas && (canvas.width !== 1 || canvas.height !== 1)) {
      canvas.width = 1;
      canvas.height = 1;
    }
    if (!enabled || !sessionId || !tabId) { setStatus('idle'); return; }

    let disposed = false;
    let retries = 0;
    let retryTimer = 0;
    let ws: WebSocket | null = null;
    // Per-connection frame pipeline.
    let header: { sequence: number; width: number; height: number } | null = null;
    let decoding: { sequence: number } | null = null;
    let waiting: { blob: Blob; sequence: number } | null = null;

    const ack = (socket: WebSocket, sequence: number) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack', sequence }));
    };
    const finish = (socket: WebSocket, sequence: number) => {
      if (decoding?.sequence === sequence) decoding = null;
      ack(socket, sequence);
      const next = waiting;
      waiting = null;
      if (next && !disposed) void show(socket, next.blob, next.sequence);
    };
    const show = async (socket: WebSocket, blob: Blob, sequence: number) => {
      const frame = { sequence };
      decoding = frame;
      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = await createImageBitmap(blob);
        if (disposed || socketRef.current !== socket) return;
        retries = 0;
        const { width, height } = bitmap;
        const target = canvasRef.current;
        if (target) {
          if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
          target.getContext('2d')?.drawImage(bitmap, 0, 0);
        }
        setFrameSize((previous) => (previous && previous.width === width && previous.height === height ? previous : { width, height }));
      } catch {
        if (!disposed && socketRef.current === socket) showError('A browser frame could not be decoded.');
      } finally {
        bitmap?.close();
        if (decoding === frame) finish(socket, sequence);
      }
    };

    const open = () => {
      const socket = new WebSocket(streamUrl(sessionId, tabId));
      socket.binaryType = 'blob';
      ws = socket;
      socketRef.current = socket;
      setStatus('connecting');
      socket.onmessage = (event: MessageEvent<unknown>) => {
        if (disposed || socketRef.current !== socket) return;
        if (typeof event.data === 'string') {
          let message: unknown;
          try { message = JSON.parse(event.data); } catch { return; }
          if (!isServerMessage(message)) return;
          if (message.type === 'hello') { setClientId(message.clientId); setTab(message.tab); setStatus('live'); }
          else if (message.type === 'state') setTab(message.tab);
          else if (message.type === 'frame') header = { sequence: message.sequence, width: message.width, height: message.height };
          else showError(message.message || 'The browser reported an error.');
        } else if (event.data instanceof Blob) {
          const current = header;
          header = null;
          if (!current) return;
          if (decoding) {
            if (waiting) ack(socket, waiting.sequence);
            waiting = { blob: event.data, sequence: current.sequence };
            return;
          }
          void show(socket, event.data, current.sequence);
        }
      };
      socket.onclose = () => {
        if (disposed || socketRef.current !== socket) return;
        socketRef.current = null;
        header = null;
        waiting = null;
        decoding = null;
        const delay = RETRY_DELAYS_MS[retries];
        if (delay === undefined) {
          setStatus('closed');
          showError('The browser stream disconnected. Reconnect to keep watching.');
          return;
        }
        retries += 1;
        setStatus('connecting');
        retryTimer = window.setTimeout(open, delay);
      };
    };
    open();

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      decoding = null;
      waiting = null;
      if (ws) { ws.onmessage = null; ws.onclose = null; ws.close(); }
      if (socketRef.current === ws) socketRef.current = null;
    };
    // canvasRef is a stable ref object; the effect must restart only when the target or reconnect counter changes.
  }, [sessionId, tabId, enabled, attempt, canvasRef, showError]);

  const sendJson = useCallback((payload: unknown): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }, []);
  const sendInput = useCallback((action: BrowserAction) => sendJson({ type: 'input', action }), [sendJson]);
  const setControl = useCallback((owner: 'human' | 'agent') => sendJson({ type: 'control', owner }), [sendJson]);
  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  return { status, clientId, tab, frameSize, error, dismissError, sendInput, setControl, reconnect };
}
