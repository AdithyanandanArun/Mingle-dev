export interface HumanInputEvent { type: 'human-input'; targetId: string; kind: 'pointer' | 'key' | 'wheel' }

/** Authenticated client for the Electron-owned embedded browser. */
export class EmbeddedBrowserClient {
  readonly baseUrl: string;

  constructor(baseUrl: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !/^\d+$/.test(parsed.port) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('Embedded browser URL must be http://127.0.0.1:<port>.');
    }
    this.baseUrl = parsed.origin;
  }
  authorizationHeader(): string { return `Bearer ${this.token}`; }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddedBrowserClient | null {
    const url = env.MINGLE_EMBEDDED_BROWSER_URL?.trim();
    const token = env.MINGLE_EMBEDDED_BROWSER_TOKEN?.trim();
    if (!url || !token) return null;
    try { return new EmbeddedBrowserClient(url, token); } catch { return null; }
  }

  private path(sessionId: string, suffix = ''): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(sessionId)) throw new Error('Invalid session id.');
    return `/sessions/${encodeURIComponent(sessionId)}/browser${suffix}`;
  }

  async open(sessionId: string): Promise<string> {
    const response = await this.fetcher(`${this.baseUrl}${this.path(sessionId)}`, { method: 'POST', headers: { Authorization: `Bearer ${this.token}` } });
    if (!response.ok) throw new Error(`Embedded browser session could not be opened (HTTP ${response.status}).`);
    const body = await response.json() as { wsUrl?: unknown };
    if (typeof body.wsUrl !== 'string') throw new Error('Embedded browser returned an invalid WebSocket endpoint.');
    const ws = new URL(body.wsUrl);
    if (ws.protocol !== 'ws:' || ws.hostname !== '127.0.0.1' || !/^\d+$/.test(ws.port) || !/^\/devtools\/browser\/[A-Za-z0-9-]{8,80}$/.test(ws.pathname)) throw new Error('Embedded browser returned an unsafe WebSocket endpoint.');
    return ws.href;
  }

  async close(sessionId: string): Promise<void> {
    try { await this.fetcher(`${this.baseUrl}${this.path(sessionId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${this.token}` } }); } catch { /* host may already be gone */ }
  }

  async events(sessionId: string, onHumanInput: (event: HumanInputEvent) => void, signal: AbortSignal): Promise<void> {
    const url = `${this.baseUrl}${this.path(sessionId, '/events')}`;
    let delay = 250;
    while (!signal.aborted) {
      try {
        const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${this.token}` }, signal });
        if (!response.ok || !response.body) throw new Error('Embedded browser event stream unavailable.');
        delay = 250;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            for (const line of block.split(/\r?\n/)) if (line.startsWith('data: ')) {
              try {
                const item = JSON.parse(line.slice(6)) as Partial<HumanInputEvent>;
                if (item.type === 'human-input' && typeof item.targetId === 'string' && ['pointer', 'key', 'wheel'].includes(item.kind ?? '')) onHumanInput(item as HumanInputEvent);
              } catch { /* ignore malformed event */ }
            }
          }
        }
        await reader.cancel().catch(() => undefined);
      } catch { if (signal.aborted) return; }
      if (signal.aborted) return;
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      delay = Math.min(delay * 2, 5000);
    }
  }
}
