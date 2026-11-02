import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderInfo } from '@mingle/contracts';
import { ProviderUpdateService } from './service.ts';

const diagnostic = (version = '1.0.0', executable = '/home/test/.local/bin/codex'): ProviderInfo => ({
  id: 'codex', name: 'Codex', available: true, version, executable, reason: null, models: [],
});
function harness(options: { version?: string; executable?: string; fetch?: typeof fetch; spawn?: (...args: never[]) => never; reserve?: () => (() => void) | null } = {}) {
  const data: Record<string, unknown> = {};
  const store = {
    getProviderUpdateChecks: () => ({ ...data }), saveProviderUpdateCheck: (provider: string, value: unknown) => { data[provider] = value; },
    providerUpdateDismissed: () => false, recordEvent: vi.fn(), dismissProviderUpdate: vi.fn(), touch: vi.fn(), getSettings: () => ({ codexExecutable: '' }),
  };
  let current = diagnostic(options.version, options.executable);
  const providers = { list: vi.fn(async () => [current]), refresh: vi.fn(async () => [current]) };
  const release = vi.fn();
  const reserve = vi.fn(options.reserve ?? (() => release));
  const runtime = { reserveProviderMaintenance: reserve };
  const fetcher = options.fetch ?? (async () => new Response(JSON.stringify({ version: '1.1.0' }), { status: 200 }));
  const service = new ProviderUpdateService(store as never, providers as never, runtime as never, { fetch: fetcher, spawn: options.spawn as never, now: () => 1_800_000_000_000, inspectInstall: async () => true });
  return { service, store, providers, runtime, release, data, setInstalled: (version: string) => { current = diagnostic(version, options.executable); } };
}

describe('ProviderUpdateService', () => {
  it('compares stable metadata, labels its source and persists the result across service instances', async () => {
    const app = harness();
    const result = await app.service.checkOne('codex');
    expect(result).toMatchObject({ status: 'available', installedVersion: '1.0.0', latestVersion: '1.1.0', channel: 'stable', method: 'native' });
    expect((app.data.codex as { source: string }).source).toContain('@openai/codex');
    const second = harness();
    (second.store.getProviderUpdateChecks as unknown as () => unknown) = () => app.data;
    expect((await second.service.snapshot()).providers[0]).toMatchObject({ status: 'available', latestVersion: '1.1.0' });
  });

  it('reports partial public metadata and offline errors without claiming current', async () => {
    const partial = harness({ fetch: async () => new Response(JSON.stringify({ versions: {} }), { status: 200 }) });
    expect((await partial.service.checkOne('codex')).status).toBe('error');
    const offline = harness({ fetch: async () => { throw new Error('offline'); } });
    expect(await offline.service.checkOne('codex')).toMatchObject({ status: 'error', message: expect.stringContaining('offline') });
  });

  it('does not call the updater when metadata is prerelease or the executable/version is stale', async () => {
    const spawn = vi.fn();
    const app = harness({ version: '1.0.0-beta.1', spawn: spawn as never });
    await expect(app.service.update('codex', '1.0.0-beta.1')).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    const stale = harness();
    await expect(stale.service.update('codex', '0.9.0')).rejects.toThrow(/changed/);
    expect(stale.runtime.reserveProviderMaintenance).not.toHaveBeenCalled();
  });

  it('uses fixed argv, releases the provider lease, and refreshes discovery after success', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    const spawn = vi.fn((_file: string, args: string[]) => { queueMicrotask(() => { if (args[0] === '--help') child.stdout.write('  update Update Codex\n'); else app.setInstalled('1.1.0'); child.emit('close', 0); }); return child; });
    const app = harness({ spawn: spawn as never });
    const result = await app.service.update('codex', '1.0.0');
    expect(spawn).toHaveBeenCalledWith('/home/test/.local/bin/codex', ['update'], expect.objectContaining({ shell: false }));
    expect(app.providers.refresh).toHaveBeenCalledTimes(2);
    expect(app.release).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'updated', installedVersion: '1.1.0' });
  });

  it('releases the provider lease after updater failure and does not claim an update', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    const spawn = vi.fn((_file: string, args: string[]) => { queueMicrotask(() => { if (args[0] === '--help') child.stdout.write('  update Update Codex\n'); child.emit('close', args[0] === '--help' ? 0 : 2); }); return child; });
    const app = harness({ spawn: spawn as never });
    expect(await app.service.update('codex', '1.0.0')).toMatchObject({ status: 'failed' });
    expect(app.release).toHaveBeenCalledOnce();
  });

  it('refuses updates when provider maintenance cannot be atomically reserved', async () => {
    const app = harness({ reserve: () => null });
    await expect(app.service.update('codex', '1.0.0')).rejects.toMatchObject({ status: 409 });
  });
});

describe('provider update bounds and cached state', () => {
  it('uses the small public latest-version endpoint, caches checks and performs no idle rechecks', async () => {
    const fetcher = vi.fn(async (_url: unknown) => new Response(JSON.stringify({ version: '1.1.0' })));
    const app = harness({ fetch: fetcher });
    await app.service.checkAll(); await app.service.checkAll(); await app.service.snapshot();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://registry.npmjs.org/%40openai%2Fcodex/latest');
    app.setInstalled('1.1.0');
    expect((await app.service.snapshot()).providers[0]).toMatchObject({ status: 'current', installedVersion: '1.1.0' });
    await app.service.close();
  });

  it('rejects oversized responses and malformed release versions', async () => {
    for (const body of ['x'.repeat(65 * 1024), JSON.stringify({ version: '1.1.0-beta.1' })]) {
      const app = harness({ fetch: async () => new Response(body) });
      expect(await app.service.checkOne('codex')).toMatchObject({ status: 'error', latestVersion: null });
      await app.service.close();
    }
  });

  it('never runs an updater for system-managed or custom executables', async () => {
    const spawn = vi.fn();
    const app = harness({ executable: '/usr/bin/codex', spawn: spawn as never });
    const check = await app.service.checkOne('codex');
    expect(check).toMatchObject({ status: 'available', method: 'unsupported', instructions: expect.stringContaining('package manager') });
    await expect(app.service.update('codex', '1.0.0')).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not claim success when the updater exits zero without changing the configured CLI', async () => {
    const spawn = vi.fn((_file: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
      queueMicrotask(() => { child.stdout.write('  update Update Codex\n'); child.emit('close', 0); }); return child;
    });
    const app = harness({ spawn: spawn as never });
    expect(await app.service.update('codex', '1.0.0')).toMatchObject({ status: 'failed', installedVersion: '1.0.0' });
    expect((await app.service.snapshot()).providers[0]!.status).toBe('failed');
    expect(app.release).toHaveBeenCalledOnce();
  });
});
