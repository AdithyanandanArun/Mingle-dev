import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@mingle/contracts';
import { BrowserService } from './service.ts';
import { NATIVE_HOLDER } from './embedded.ts';
import { TabEntry } from './tab.ts';
import type { Page } from './playwright.ts';

const settings = {} as AppSettings;

function connectedService(embedded: boolean) {
  const service = new BrowserService({ dataDir: '/tmp/mingle-browser-test', getSettings: () => settings, onChange: () => undefined });
  const page = { url: () => 'about:blank', viewportSize: () => ({ width: 1024, height: 768 }) } as unknown as Page;
  const entry = new TabEntry(page, true, 'native-target', embedded);
  const runtime = {
    state: () => ({ sessionId: 'session_test', status: 'connected', mode: embedded ? 'embedded' : 'managed', tabs: [], activeTabId: entry.id, error: null, notices: [] }),
    requireTab: () => entry,
    requireConnected: () => ({}),
    assertShareable: () => undefined,
    act: vi.fn(async () => ({ ok: true })),
    takeControl: async (tab: TabEntry, clientId: string) => { tab.control.take(clientId); },
    releaseControl: async (tab: TabEntry, clientId: string) => tab.control.release(clientId),
    disconnect: vi.fn(async () => undefined),
  };
  // Keep the test at BrowserService's trust boundary while avoiding launching a browser process.
  (service as unknown as { runtimes: Map<string, unknown> }).runtimes.set('session_test', runtime);
  return { service, entry, runtime };
}

describe('BrowserService native action authorization', () => {
  afterEach(() => vi.useRealTimers());

  it('allows native toolbar actions after authenticated embedded input claimed touch control', async () => {
    const { service, entry, runtime } = connectedService(true);
    expect(entry.control.claimTouch(NATIVE_HOLDER)).toBe(true);
    await expect(service.act('session_test', entry.id, { type: 'navigate', url: 'https://example.com' }, { kind: 'human', id: NATIVE_HOLDER })).resolves.toEqual({ ok: true });
    expect(runtime.act).toHaveBeenCalledOnce();
    await service.close();
  });

  it('allows native keep-control and hand-back after authenticated embedded input', async () => {
    const { service, entry } = connectedService(true);
    entry.control.claimTouch(NATIVE_HOLDER);
    const held = await service.control('session_test', entry.id, 'human', NATIVE_HOLDER);
    expect(held.control).toMatchObject({ holderId: NATIVE_HOLDER, lease: 'hold', expiresAt: null });
    const released = await service.control('session_test', entry.id, 'agent', NATIVE_HOLDER);
    expect(released.control).toMatchObject({ holderId: null, lease: null });
    await service.close();
  });

  it('rejects the native id without the native touch lease and rejects it in non-embedded mode', async () => {
    const embedded = connectedService(true);
    await expect(embedded.service.act('session_test', embedded.entry.id, { type: 'back' }, { kind: 'human', id: NATIVE_HOLDER })).rejects.toMatchObject({ status: 403 });
    await expect(embedded.service.control('session_test', embedded.entry.id, 'human', NATIVE_HOLDER)).rejects.toMatchObject({ status: 403 });
    await embedded.service.close();

    const managed = connectedService(false);
    managed.entry.control.claimTouch(NATIVE_HOLDER);
    await expect(managed.service.act('session_test', managed.entry.id, { type: 'back' }, { kind: 'human', id: NATIVE_HOLDER })).rejects.toMatchObject({ status: 403 });
    await expect(managed.service.control('session_test', managed.entry.id, 'human', NATIVE_HOLDER)).rejects.toMatchObject({ status: 403 });
    expect(managed.runtime.act).not.toHaveBeenCalled();
    await managed.service.close();
  });

  it('keeps ordinary human actions bound to a live viewer', async () => {
    const { service, entry, runtime } = connectedService(true);
    entry.control.claimTouch('fake-viewer-id');
    await expect(service.act('session_test', entry.id, { type: 'back' }, { kind: 'human', id: 'fake-viewer-id' })).rejects.toMatchObject({ status: 403 });
    expect(runtime.act).not.toHaveBeenCalled();
    await service.close();
  });
});
