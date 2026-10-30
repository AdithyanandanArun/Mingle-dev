import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { BrowserClientMessageSchema, type BrowserAction, type BrowserServerMessage, type BrowserTab } from '@mingle/contracts';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Security } from '../security.ts';
import type { Logger } from '../types.ts';
import type { Actor } from './control.ts';
import { BrowserError, toBrowserError } from './errors.ts';
import {
  ID_PATTERN, STREAM_MAX_BUFFERED, STREAM_MAX_CONNECTIONS, STREAM_MAX_PAYLOAD, STREAM_MAX_PENDING_INPUTS, STREAM_MAX_PENDING_MOVES,
  STREAM_MAX_VIEWERS_PER_TAB, STREAM_PATH,
} from './limits.ts';
import { ScreencastViewer } from './screencast.ts';
import type { TabEntry } from './tab.ts';

/** What the stream needs from the browser service. */
export interface StreamHost {
  sessionExists(sessionId: string): boolean;
  tab(sessionId: string, tabId: string): TabEntry | null;
  act(sessionId: string, tabId: string, action: BrowserAction, actor: Actor): Promise<unknown>;
  control(sessionId: string, tabId: string, owner: 'agent' | 'human', clientId: string): Promise<BrowserTab>;
  dropClient(sessionId: string, tabId: string, clientId: string): Promise<void>;
}

const MAX_INVALID_MESSAGES = 20;
const HEARTBEAT_MS = 30_000;
const CLOSE_TAB_GONE = 4404;

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

function isHighRate(action: BrowserAction): boolean {
  return action.type === 'scroll' || (action.type === 'pointer' && action.phase === 'move');
}

/**
 * /ws/browser?sessionId&tabId: JPEG frames out (JSON header, then a binary frame), JSON control and input in.
 * Viewers can watch freely; the first viewer input claims a short touch lease automatically.
 */
export class BrowserStreamServer {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: STREAM_MAX_PAYLOAD, perMessageDeflate: false });
  private readonly sockets = new Set<WebSocket>();
  private readonly alive = new WeakSet<WebSocket>();
  /** Live viewers by client id. A client id only exists here while its socket is open. */
  private readonly clients = new Map<string, { sessionId: string; tabId: string }>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly host: StreamHost, private readonly log: Logger) {
    this.heartbeat = setInterval(() => {
      for (const socket of this.sockets) {
        if (!this.alive.has(socket)) { socket.terminate(); continue; }
        this.alive.delete(socket);
        socket.ping();
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, security: Security): void {
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://relay.local'); } catch { return reject(400, 'Bad Request'); }
    if (url.pathname !== STREAM_PATH) return reject(404, 'Not Found');
    const verdict = security.checkWebSocket(req);
    if (!verdict.ok) {
      this.log('warn', `Rejected browser stream upgrade: ${verdict.reason}`);
      return reject(403, 'Forbidden');
    }
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const tabId = url.searchParams.get('tabId') ?? '';
    if (!ID_PATTERN.test(sessionId) || !ID_PATTERN.test(tabId)) return reject(400, 'Bad Request');
    if (!this.host.sessionExists(sessionId)) return reject(404, 'Not Found');
    const entry = this.host.tab(sessionId, tabId);
    if (!entry) return reject(404, 'Not Found');
    if (this.sockets.size >= STREAM_MAX_CONNECTIONS || entry.viewerCount >= STREAM_MAX_VIEWERS_PER_TAB) return reject(503, 'Service Unavailable');
    // Ignore legacy `profile` query values so saved links cannot change stream quality or pacing.
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, sessionId, tabId, entry));
  }

  /** True while `clientId` is a connected viewer of exactly this session's tab. */
  hasViewer(sessionId: string, tabId: string, clientId: string): boolean {
    const client = this.clients.get(clientId);
    return client !== undefined && client.sessionId === sessionId && client.tabId === tabId;
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const socket of this.sockets) socket.close(1001, 'server shutting down');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { for (const socket of this.sockets) socket.terminate(); resolve(); }, 1000);
      timer.unref();
      this.wss.close(() => { clearTimeout(timer); resolve(); });
    });
  }

  private accept(ws: WebSocket, sessionId: string, tabId: string, entry: TabEntry): void {
    const clientId = `cli_${randomBytes(8).toString('hex')}`;
    // Registered before any host callback can run, removed on close: only live viewers can claim control.
    this.clients.set(clientId, { sessionId, tabId });
    this.sockets.add(ws);
    this.alive.add(ws);
    ws.on('pong', () => this.alive.add(ws));
    ws.on('error', (error) => this.log('warn', 'Browser stream socket error', error));

    const send = (message: BrowserServerMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); };
    let lastState = '';
    const pushState = (tab: BrowserTab) => {
      const encoded = JSON.stringify(tab);
      if (encoded === lastState) return;
      lastState = encoded;
      send({ type: 'state', tab });
    };

    const viewer = new ScreencastViewer(entry, {
      send: (header, jpeg) => {
        if (ws.readyState !== ws.OPEN) throw new BrowserError(409, 'closed');
        if (ws.bufferedAmount > STREAM_MAX_BUFFERED) { ws.close(1013, 'viewer too slow'); throw new BrowserError(409, 'slow viewer'); }
        ws.send(JSON.stringify({ type: 'frame', ...header } satisfies BrowserServerMessage));
        ws.send(jpeg, { binary: true });
      },
    }, () => entry.touch());

    const unsubscribe = entry.subscribe({
      state: pushState,
      closed: (reason) => { if (ws.readyState === ws.OPEN) ws.close(CLOSE_TAB_GONE, reason.slice(0, 100)); },
    });
    const detach = entry.attachViewer({
      close: async (reason) => {
        if (ws.readyState === ws.OPEN) ws.close(CLOSE_TAB_GONE, reason.slice(0, 100));
        await viewer.stop();
      },
    });

    let pending = 0;
    let pendingHighRate = 0;
    let invalid = 0;
    // The message keeps the real reason (policy, ownership, timeout, closed tab); the status shapes it but is not exposed on the socket.
    const fail = (error: unknown) => send({ type: 'error', message: toBrowserError(error).message });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message;
      try { message = BrowserClientMessageSchema.safeParse(JSON.parse(rawToString(data))); } catch { message = null; }
      if (!message?.success) {
        send({ type: 'error', message: 'Invalid message.' });
        if (++invalid >= MAX_INVALID_MESSAGES) ws.close(1008, 'too many invalid messages');
        return;
      }
      const value = message.data;
      if (value.type === 'ack') return viewer.ack(value.sequence);
      if (value.type === 'control') {
        this.host.control(sessionId, tabId, value.owner, clientId).catch(fail);
        return;
      }
      const highRate = isHighRate(value.action);
      if (pending >= STREAM_MAX_PENDING_INPUTS || (highRate && pendingHighRate >= STREAM_MAX_PENDING_MOVES)) {
        if (!highRate) send({ type: 'error', message: 'Input is backed up; the action was dropped.' });
        return;
      }
      pending++;
      if (highRate) pendingHighRate++;
      this.host.act(sessionId, tabId, value.action, { kind: 'human', id: clientId }).catch(fail).finally(() => {
        pending--;
        if (highRate) pendingHighRate--;
      });
    });

    ws.on('close', () => {
      this.clients.delete(clientId);
      this.sockets.delete(ws);
      unsubscribe();
      detach();
      void viewer.stop();
      void this.host.dropClient(sessionId, tabId, clientId).catch(() => undefined);
    });

    send({ type: 'hello', clientId, tab: entry.describe() });
    lastState = JSON.stringify(entry.describe());
    viewer.start().catch((error: unknown) => {
      this.log('warn', 'Could not start the browser screencast', error);
      send({ type: 'error', message: 'The live view could not start for this tab.' });
      ws.close(1011, 'screencast failed');
    });
  }
}
