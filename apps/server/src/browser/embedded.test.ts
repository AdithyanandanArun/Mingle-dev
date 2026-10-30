import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { EmbeddedBrowserClient } from './embedded.ts';

describe('EmbeddedBrowserClient', () => {
  let server: ReturnType<typeof createServer> | undefined;
  afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; });

  it('validates the host and opens/closes a session with bearer auth', async () => {
    await new Promise<void>(resolve => { server = createServer((req, res) => {
      expect(req.headers.authorization).toBe('Bearer secret');
      if (req.method === 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ wsUrl: 'ws://127.0.0.1:1234/devtools/browser/12345678-1234-1234-1234-123456789abc' })); }
      else { res.writeHead(404); res.end(); }
    }).listen(0, '127.0.0.1', resolve); });
    const address = server!.address(); if (!address || typeof address === 'string') throw new Error('No server address');
    const client = new EmbeddedBrowserClient(`http://127.0.0.1:${address.port}`, 'secret');
    await expect(client.open('session_1')).resolves.toContain('/devtools/browser/');
    await expect(client.close('session_1')).resolves.toBeUndefined();
    expect(() => new EmbeddedBrowserClient('http://localhost:1234', 'secret')).toThrow('127.0.0.1');
  });

  it('parses event lines and stops on abort', async () => {
    let release!: () => void;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"human-input","targetId":"target","kind":"key"}\n\n')); release = () => controller.close(); } });
    const client = new EmbeddedBrowserClient('http://127.0.0.1:1234', 'secret', async () => new Response(stream));
    const abort = new AbortController(); const events: unknown[] = [];
    const running = client.events('session_1', event => events.push(event), abort.signal);
    await new Promise(resolve => setTimeout(resolve, 0)); abort.abort(); release(); await running;
    expect(events).toEqual([{ type: 'human-input', targetId: 'target', kind: 'key' }]);
  });
});
