import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./actions.ts', () => ({ refreshViewport: vi.fn(async () => undefined) }));
import { ScreencastViewer } from './screencast.ts';
import { refreshViewport } from './actions.ts';

class FakeCDP extends EventEmitter {
  commands: string[] = [];
  async send(method: string) {
    this.commands.push(method);
    if (method === 'Page.captureScreenshot') return { data: Buffer.from('jpeg').toString('base64') };
    return {};
  }
  async detach() {}
}

function fixture() {
  const cdp = new FakeCDP();
  const entry = {
    page: { context: () => ({ newCDPSession: async () => cdp }) },
    viewport: { width: 800, height: 600 },
    setViewport: (width: number, height: number) => { entry.viewport = { width, height }; return true; },
  } as any;
  const send = vi.fn();
  const viewer = new ScreencastViewer(entry, { send }, vi.fn());
  return { cdp, entry, send, viewer };
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('ScreencastViewer fallback lifecycle', () => {
  it('cancels the still-frame fallback as soon as a live frame arrives', async () => {
    vi.useFakeTimers();
    const { cdp, send, viewer } = fixture();
    await viewer.start();
    cdp.emit('Page.screencastFrame', { data: Buffer.from('live').toString('base64'), sessionId: 1, metadata: { deviceWidth: 800, deviceHeight: 600 } });
    await vi.advanceTimersByTimeAsync(700);
    expect(send).toHaveBeenCalledTimes(1);
    expect(refreshViewport).not.toHaveBeenCalled();
    await viewer.stop();
  });

  it('captures one still frame when the page emits no live frame', async () => {
    vi.useFakeTimers();
    const { send, viewer } = fixture();
    await viewer.start();
    await vi.advanceTimersByTimeAsync(700);
    expect(refreshViewport).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    await viewer.stop();
  });

  it('skips the still capture if a live frame arrives during viewport refresh', async () => {
    vi.useFakeTimers();
    let finishRefresh!: () => void;
    const refresh = new Promise<void>(resolve => { finishRefresh = resolve; });
    vi.mocked(refreshViewport).mockImplementationOnce(() => refresh);
    const { cdp, send, viewer } = fixture();
    await viewer.start();
    await vi.advanceTimersByTimeAsync(700);
    cdp.emit('Page.screencastFrame', { data: Buffer.from('live').toString('base64'), sessionId: 1, metadata: { deviceWidth: 800, deviceHeight: 600 } });
    finishRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(cdp.commands).not.toContain('Page.captureScreenshot');
    expect(send).toHaveBeenCalledOnce();
    await viewer.stop();
  });

  it('shares completion when the socket and tab both stop a viewer', async () => {
    const { cdp, viewer } = fixture();
    const detach = vi.spyOn(cdp, 'detach');
    await viewer.start();
    const closing = viewer.stop();
    expect(viewer.stop()).toBe(closing);
    await closing;
    expect(detach).toHaveBeenCalledOnce();
    expect(cdp.commands.filter(method => method === 'Page.stopScreencast')).toHaveLength(1);
  });
});
