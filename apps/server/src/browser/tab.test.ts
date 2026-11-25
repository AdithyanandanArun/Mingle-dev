import { describe, expect, it, vi } from 'vitest';
import { TabEntry } from './tab.ts';

function fixture() {
  const page = {
    viewportSize: () => ({ width: 800, height: 600 }),
    url: () => 'about:blank',
    mouse: { up: vi.fn(async () => undefined) },
  } as any;
  return new TabEntry(page, true, null);
}

describe('TabEntry viewer lifecycle', () => {
  it('does no state work when there are no subscribers', () => {
    const entry = fixture();
    const describe = vi.spyOn(entry, 'describe');
    entry.touch();
    expect(describe).not.toHaveBeenCalled();
  });

  it('removes a detached viewer and releases its handle when the tab ends', async () => {
    const entry = fixture();
    const close = vi.fn(async () => undefined);
    const detach = entry.attachViewer({ close });
    expect(entry.viewerCount).toBe(1);
    detach();
    expect(entry.viewerCount).toBe(0);
    await entry.end('closed');
    expect(close).not.toHaveBeenCalled();
  });

  it('closes every remaining viewer once when the tab ends', async () => {
    const entry = fixture();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    entry.attachViewer({ close: first });
    entry.attachViewer({ close: second });
    await entry.end('closed');
    await entry.end('closed again');
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(entry.viewerCount).toBe(0);
  });
});
