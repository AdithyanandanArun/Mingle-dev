import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ServerEvent, StateChangeScope, WorkspaceEvent } from '@mingle/contracts';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Security } from './security.ts';
import type { Logger } from './types.ts';

export const MAX_WS_CLIENTS = 64;
export const MAX_WS_PAYLOAD = 256 * 1024;

export type ClientMessageHandler = (socket: WebSocket, raw: string) => void;

/** WebSocket registry: broadcasts server events to every client and delegates client messages to the terminal manager. */
export class Hub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  private readonly clients = new Set<WebSocket>();
  private readonly alive = new WeakSet<WebSocket>();
  private heartbeat: NodeJS.Timeout | null = null;
  private onMessage: ClientMessageHandler = () => undefined;
  private onClose: (socket: WebSocket) => void = () => undefined;

  constructor(private readonly security: Security, private readonly log: Logger) {}

  bind(handlers: { onMessage: ClientMessageHandler; onClose: (socket: WebSocket) => void }): void {
    this.onMessage = handlers.onMessage;
    this.onClose = handlers.onClose;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  start(): void {
    this.heartbeat = setInterval(() => {
      for (const socket of this.clients) {
        if (!this.alive.has(socket)) { socket.terminate(); continue; }
        this.alive.delete(socket);
        socket.ping();
      }
    }, 30_000);
    this.heartbeat.unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let pathname = '';
    try { pathname = new URL(req.url ?? '/', 'http://relay.local').pathname; } catch { return reject(400, 'Bad Request'); }
    if (pathname !== '/ws') return reject(404, 'Not Found');
    const verdict = this.security.checkWebSocket(req);
    if (!verdict.ok) {
      this.log('warn', `Rejected WebSocket upgrade: ${verdict.reason}`);
      return reject(403, 'Forbidden');
    }
    if (this.clients.size >= MAX_WS_CLIENTS) return reject(503, 'Service Unavailable');
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.clients.add(ws);
      this.alive.add(ws);
      ws.on('pong', () => this.alive.add(ws));
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        this.onMessage(ws, data.toString('utf8'));
      });
      ws.on('close', () => {
        this.clients.delete(ws);
        this.onClose(ws);
      });
      ws.on('error', (error) => this.log('warn', 'WebSocket error', error));
      this.wss.emit('connection', ws, req);
    });
  }

  send(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.clients) if (socket.readyState === socket.OPEN) socket.send(payload);
  }

  /** `scope` narrows what changed to specific sessions; without it clients must treat everything as changed. */
  notify(event?: WorkspaceEvent, scope?: StateChangeScope): void {
    this.broadcast({ type: 'state.changed', ...(event ? { event } : {}), ...(scope ? { scope } : {}) });
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const socket of this.clients) socket.close(1001, 'server shutting down');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { for (const s of this.clients) s.terminate(); resolve(); }, 1000);
      timer.unref();
      this.wss.close(() => { clearTimeout(timer); resolve(); });
    });
  }
}
