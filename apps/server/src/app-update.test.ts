import { describe, expect, it, vi } from 'vitest';
import { createAppUpdateCheck } from './app-update.ts';

const metadata = (version: string, name = '@mingledev/mingle') => Response.json({ name, version });

describe('Mingle npm updates', () => {
  it.each([
    ['0.1.5', '0.1.10', 'available'],
    ['0.1.5', '0.1.5', 'current'],
    ['0.2.0', '0.1.10', 'current'],
    ['0.1.5', '0.0.0-stage', 'unavailable'],
    ['0.1.5', '0.2.0-beta.1', 'unavailable'],
  ])('compares installed %s with npm latest %s', async (installed, latest, status) => {
    const request = vi.fn(async () => metadata(latest));
    await expect(createAppUpdateCheck(installed, request)()).resolves.toMatchObject({ installedVersion: installed, status });
    expect(request).toHaveBeenCalledWith('https://registry.npmjs.org/@mingledev%2fmingle/latest', expect.objectContaining({ redirect: 'error' }));
  });

  it('coalesces checks, respects the cache, and throttles manual refreshes', async () => {
    let now = 0;
    const request = vi.fn(async () => metadata('0.1.6'));
    const check = createAppUpdateCheck('0.1.5', request, () => now);
    const pending = check();
    expect(check(true)).toBe(pending);
    const first = await pending;
    now = 10_000;
    expect(await check(true)).toBe(first);
    now = 31_000;
    expect(await check()).toBe(first);
    expect(await check(true)).not.toBe(first);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reports registry failures explicitly and retries after a short cache', async () => {
    let now = 0;
    const request = vi.fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(metadata('0.1.6', 'different-package'))
      .mockResolvedValueOnce(metadata('0.1.6'));
    const check = createAppUpdateCheck('0.1.5', request, () => now);
    expect(await check()).toMatchObject({ status: 'unavailable', latestVersion: null });
    now = 61_000;
    expect(await check()).toMatchObject({ status: 'unavailable', latestVersion: null });
    now = 122_000;
    expect(await check()).toMatchObject({ status: 'available', latestVersion: '0.1.6' });
  });
});
