import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@mingle/contracts';
import { BrowserService } from './service.ts';
import { NATIVE_HOLDER } from './embedded.ts';
import { TabEntry } from './tab.ts';
import type { Page } from './playwright.ts';

const settings = {} as AppSettings;

function connectedService(embedded: boolean, isPresented: (sessionId: string, targetId: string) => Promise<boolean> = async () => false) {
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
  (service as unknown as { embedded: { isPresented: typeof isPresented } }).embedded = { isPresented };
  (service as unknown as { runtimes: Map<string, unknown> }).runtimes.set('session_test', runtime);
  return { service, entry, runtime };
}

describe('BrowserService native action authorization', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ['embedded', true, 'embedded'],
    ['embedded', false, 'managed'],
    ['managed', true, 'managed'],
  ] as const)('opens with preference %s and desktop availability %s', async (preference, available, expected) => {
    const { service, runtime } = connectedService(true);
    const connect = vi.fn(async () => undefined);
    const open = vi.fn(async () => ({ id: 'opened' }));
    Object.assign(runtime, { isConnected: false, connect, open });
    const internal = service as unknown as { options: { getSettings(): AppSettings }; embedded: unknown };
    internal.options.getSettings = () => ({ ...settings, browserDefaultMode: preference });
    if (!available) internal.embedded = null;
    await expect(service.open('session_test')).resolves.toEqual({ id: 'opened' });
    expect(connect).toHaveBeenCalledWith(expected, expect.any(Function));
    await service.close();
  });

  it('allows initial native toolbar actions only with authenticated exact-target presentation proof', async () => {
    const proof = vi.fn(async (sessionId: string, targetId: string) => sessionId === 'session_test' && targetId === 'native-target');
    const { service, entry, runtime } = connectedService(true, proof);
    await expect(service.act('session_test', entry.id, { type: 'navigate', url: 'https://example.com' }, { kind: 'human', id: NATIVE_HOLDER })).resolves.toEqual({ ok: true });
    expect(runtime.act).toHaveBeenCalledOnce();
    expect(proof).toHaveBeenCalledWith('session_test', 'native-target');
    await service.close();
  });

  it('allows native keep-control with presentation proof and hand-back when parked', async () => {
    const proof = vi.fn(async () => true);
    const { service, entry } = connectedService(true, proof);
    const held = await service.control('session_test', entry.id, 'human', NATIVE_HOLDER);
    expect(held.control).toMatchObject({ holderId: NATIVE_HOLDER, lease: 'hold', expiresAt: null });
    proof.mockResolvedValue(false);
    const released = await service.control('session_test', entry.id, 'agent', NATIVE_HOLDER);
    expect(released.control).toMatchObject({ holderId: null, lease: null });
    await service.close();
  });

  it('rejects the native id when hidden, unprovable, targetless, or non-embedded', async () => {
    const embedded = connectedService(true);
    await expect(embedded.service.act('session_test', embedded.entry.id, { type: 'back' }, { kind: 'human', id: NATIVE_HOLDER })).rejects.toMatchObject({ status: 403 });
    await expect(embedded.service.control('session_test', embedded.entry.id, 'human', NATIVE_HOLDER)).rejects.toMatchObject({ status: 403 });
    await embedded.service.close();

    const failedProof = connectedService(true, async () => { throw new Error('offline'); });
    await expect(failedProof.service.act('session_test', failedProof.entry.id, { type: 'back' }, { kind: 'human', id: NATIVE_HOLDER })).rejects.toMatchObject({ status: 403 });
    await failedProof.service.close();

    const managed = connectedService(false, async () => true);
    managed.entry.control.claimTouch(NATIVE_HOLDER);
    await expect(managed.service.act('session_test', managed.entry.id, { type: 'back' }, { kind: 'human', id: NATIVE_HOLDER })).rejects.toMatchObject({ status: 403 });
    await expect(managed.service.control('session_test', managed.entry.id, 'human', NATIVE_HOLDER)).rejects.toMatchObject({ status: 403 });
    expect(managed.runtime.act).not.toHaveBeenCalled();
    await managed.service.close();

    const targetless = connectedService(true, async () => true);
    (targetless.entry as unknown as { targetId: string | null }).targetId = null;
    await expect(targetless.service.act('session_test', targetless.entry.id, { type: 'back' }, { kind: 'human', id: NATIVE_HOLDER })).rejects.toMatchObject({ status: 403 });
    await targetless.service.close();
  });

  it('keeps ordinary human actions bound to a live viewer', async () => {
    const { service, entry, runtime } = connectedService(true);
    entry.control.claimTouch('fake-viewer-id');
    await expect(service.act('session_test', entry.id, { type: 'back' }, { kind: 'human', id: 'fake-viewer-id' })).rejects.toMatchObject({ status: 403 });
    expect(runtime.act).not.toHaveBeenCalled();
    await service.close();
  });
});
