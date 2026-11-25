import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { BrowserStreamServer } from './stream-server.ts';

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<{ value: unknown; binary: boolean }> = [];
  close = vi.fn(() => { this.readyState = 3; });
  send = vi.fn((value: unknown, options?: { binary?: boolean }) => this.sent.push({ value, binary: options?.binary === true }));
  ping = vi.fn();
  terminate = vi.fn();
}

describe('BrowserStreamServer viewer lifecycle', () => {
  it('closes an outbound viewer whose socket buffer is already at its limit', async () => {
    const socket = new FakeSocket();
    let state!: (tab: any) => void;
    const entry = {
      viewerCount: 0,
      subscribe: vi.fn((subscriber) => { state = subscriber.state; return vi.fn(); }),
      attachViewer: vi.fn(() => vi.fn()),
      touch: vi.fn(),
      describe: () => ({ id: 'tab_test' }),
      page: { context: () => ({ newCDPSession: async () => ({
        on: vi.fn(), send: vi.fn(async () => ({})), detach: vi.fn(async () => undefined),
      }) }) },
      viewport: { width: 800, height: 600 },
      setViewport: vi.fn(),
    } as any;
    const host = { dropClient: vi.fn(async () => undefined) } as any;
    const server = new BrowserStreamServer(host, vi.fn());
    (server as any).accept(socket, 'session_test', 'tab_test', entry);
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    socket.bufferedAmount = 2 * 1024 * 1024;
    state({ id: 'tab_test', title: 'updated' });
    expect(socket.close).toHaveBeenCalledWith(1013, 'viewer too slow');
    socket.emit('close');
    await vi.waitFor(() => expect(host.dropClient).toHaveBeenCalledOnce());
    await server.close();
  });
});
