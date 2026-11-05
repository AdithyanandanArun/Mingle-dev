import path from 'node:path';
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Provider, ProviderInfo } from '@mingle/contracts';
import { ProviderUpdateService, withinNativeInstallRoot } from './service.ts';

const diagnostic = (version = '1.0.0', executable = '/home/test/.local/bin/codex', provider: Provider = 'codex'): ProviderInfo => ({
  id: provider, name: provider, available: true, version, executable, reason: null, models: [],
});
function harness(options: { provider?: Provider; version?: string; executable?: string; fetch?: typeof fetch; spawn?: (...args: never[]) => never; reserve?: () => (() => void) | null; managedRoot?: string; installManagedPackage?: (target: string, spec: string) => Promise<void> } = {}) {
  const data: Record<string, unknown> = {};
  const settings: Record<string, unknown> = { codexExecutable: '', claudeExecutable: '', opencodeExecutable: '' };
  const store = {
    getProviderUpdateChecks: () => ({ ...data }), saveProviderUpdateCheck: (provider: string, value: unknown) => { data[provider] = value; },
    providerUpdateDismissed: () => false, recordEvent: vi.fn(), dismissProviderUpdate: vi.fn(), touch: vi.fn(), getSettings: () => ({ ...settings }),
    updateSettings: (patch: Record<string, unknown>) => Object.assign(settings, patch),
  };
  let current = diagnostic(options.version, options.executable, options.provider);
  const providers = { list: vi.fn(async () => [current]), refresh: vi.fn(async () => [current]), invalidate: vi.fn() };
  const release = vi.fn();
  const reserve = vi.fn(options.reserve ?? (() => release));
  const runtime = { reserveProviderMaintenance: reserve };
  const fetcher = options.fetch ?? (async () => new Response(JSON.stringify({ version: '1.1.0' }), { status: 200 }));
  const service = new ProviderUpdateService(store as never, providers as never, runtime as never, { fetch: fetcher, spawn: options.spawn as never, now: () => 1_800_000_000_000, inspectInstall: async () => true,
    managedRoot: options.managedRoot, installManagedPackage: options.installManagedPackage });
  return { service, store, providers, runtime, release, data, settings, setInstalled: (version: string) => { current = diagnostic(version, options.executable, options.provider); } };
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

  it.each([
    ['codex', '@openai/codex'], ['claude', '@anthropic-ai/claude-code'], ['opencode', 'opencode-ai'],
  ] as const)('requests supported JSON from the %s latest-version endpoint', async (provider, packageName) => {
    // /latest rejects the install-v1 packument media type with HTTP 406.
    const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => new Response(JSON.stringify({ version: '1.1.0' }), {
      status: new Headers(options?.headers).get('accept') === 'application/json' ? 200 : 406,
    }));
    const app = harness({ provider, fetch: fetcher });
    expect(await app.service.checkOne(provider)).toMatchObject({ status: 'available', latestVersion: '1.1.0' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`);
    expect(fetcher.mock.calls[0]![1]?.headers).toEqual({ accept: 'application/json' });
    await app.service.close();
  });

  it('retries a persisted failed check at startup without waiting for the success cache to expire', async () => {
    const old = harness({ fetch: async () => new Response('', { status: 406 }) });
    expect(await old.service.checkOne('codex')).toMatchObject({ status: 'error', latestVersion: null });
    await old.service.close();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ version: '1.1.0' })));
    const restarted = harness({ fetch: fetcher });
    Object.assign(restarted.data, old.data);
    await restarted.service.snapshot();
    expect(fetcher).not.toHaveBeenCalled(); // reading state never retries network requests
    await restarted.service.checkAll();
    expect((await restarted.service.snapshot()).providers[0]).toMatchObject({ status: 'available', latestVersion: '1.1.0' });
    await restarted.service.checkAll(); await restarted.service.snapshot();
    expect(fetcher).toHaveBeenCalledOnce(); // successful checks retain their normal cache
    await restarted.service.close();
  });

  it('checks again when the installed version or executable changes inside the cache window', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ version: '1.2.0' })));
    const app = harness({ fetch: fetcher });
    await app.service.checkOne('codex');
    app.setInstalled('1.1.0');
    await app.service.checkAll();
    app.providers.list.mockResolvedValue([diagnostic('1.1.0', '/example/other/codex')]);
    await app.service.checkAll();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((await app.service.snapshot()).providers[0]).toMatchObject({ installedVersion: '1.1.0', checkedExecutable: '/example/other/codex', latestVersion: '1.2.0' });
    await app.service.close();
  });

  it('an explicit recheck recovers after an HTTP error and refreshes a cached successful check', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 406 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '1.1.0' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '1.2.0' })));
    const app = harness({ fetch: fetcher });
    expect((await app.service.checkOne('codex')).status).toBe('error');
    expect(await app.service.checkOne('codex', true)).toMatchObject({ status: 'available', latestVersion: '1.1.0' });
    expect(await app.service.checkOne('codex', true)).toMatchObject({ status: 'available', latestVersion: '1.2.0' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    await app.service.close();
  });

  it('keeps Antigravity pinned-runtime guidance with unknown installed version and makes no registry request', async () => {
    const fetcher = vi.fn();
    const app = harness({ provider: 'antigravity', fetch: fetcher });
    const noVersion = { ...diagnostic('1.0.0', '/example/antigravity', 'antigravity'), version: null };
    app.providers.list.mockResolvedValue([noVersion] as never);
    for (const row of [(await app.service.snapshot()).providers[2], await app.service.checkOne('antigravity'), (await app.service.snapshot()).providers[2]]) {
      expect(row).toMatchObject({ status: 'unknown', installedVersion: null, latestVersion: null, method: 'unsupported', message: expect.stringContaining('checksum-pinned') });
    }
    expect(fetcher).not.toHaveBeenCalled();
    await app.service.close();
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

  it('serializes duplicate apply requests before their diagnostics finish', async () => {
    const app = harness({ reserve: () => null });
    let releaseDiagnostics!: (value: ProviderInfo[]) => void;
    app.providers.list.mockImplementationOnce(() => new Promise((resolve) => { releaseDiagnostics = resolve; }));
    const first = app.service.update('codex', '1.0.0');
    await expect(app.service.update('codex', '1.0.0')).rejects.toMatchObject({ status: 409 });
    releaseDiagnostics([diagnostic()]);
    await expect(first).rejects.toMatchObject({ status: 409 });
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

  it('offers an isolated managed action for system-managed executables without invoking them', async () => {
    const spawn = vi.fn();
    const app = harness({ executable: '/usr/bin/codex', spawn: spawn as never });
    const check = await app.service.checkOne('codex');
    expect(check).toMatchObject({ status: 'available', method: 'managed', installationDescription: expect.stringContaining('@openai/codex') });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('recomputes an actionable managed method for old cached unsupported rows', async () => {
    const app = harness({ executable: '/usr/bin/codex' });
    app.data.codex = { provider: 'codex', installedVersion: '1.0.0', checkedExecutable: '/usr/bin/codex', latestVersion: '1.1.0',
      source: 'npm registry', checkedAt: new Date(1_800_000_000_000).toISOString(), status: 'available', channel: 'stable', method: 'unsupported', message: 'old cached row' };
    expect((await app.service.snapshot()).providers[0]).toMatchObject({ method: 'managed', installationDescription: expect.stringContaining('@openai/codex') });
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

  it.each([['codex', 'codex', '@openai/codex'], ['claude', 'claude', '@anthropic-ai/claude-code'], ['opencode', 'opencode', 'opencode-ai']] as const)(
    'installs and validates an exact %s package in a disposable managed directory', async (provider, command, packageName) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'mingle-provider-update-'));
      try {
        const app = harness({ provider, executable: `/usr/bin/${provider}`, managedRoot: path.join(directory, 'managed'), installManagedPackage: async (target, spec) => {
          expect(spec).toBe(`${packageName}@1.1.0`);
          const bin = path.join(target, 'node_modules', '.bin');
          await mkdir(bin, { recursive: true });
          const executable = path.join(bin, command);
          await writeFile(executable, '#!/usr/bin/env node\nconsole.log("1.1.0")\n', { mode: 0o700 });
          await chmod(executable, 0o700);
        } });
        const result = await app.service.update(provider, '1.0.0');
        expect(result).toMatchObject({ status: 'updated', installedVersion: '1.1.0', method: 'managed', previousExecutable: '' });
        expect(app.settings[`${provider}Executable`]).toBe(result.managedExecutable);
        expect(app.providers.invalidate).toHaveBeenCalledOnce();
        expect(app.release).toHaveBeenCalledOnce();
        await app.service.close();
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  );

  it('keeps the current executable selected when the staged CLI reports a different version', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mingle-provider-update-'));
    try {
      const app = harness({ executable: '/usr/bin/codex', managedRoot: path.join(directory, 'managed'), installManagedPackage: async (target) => {
        const bin = path.join(target, 'node_modules', '.bin');
        await mkdir(bin, { recursive: true });
        const executable = path.join(bin, 'codex');
        await writeFile(executable, '#!/usr/bin/env node\nconsole.log("1.0.9")\n', { mode: 0o700 });
        await chmod(executable, 0o700);
      } });
      expect(await app.service.update('codex', '1.0.0')).toMatchObject({ status: 'failed', message: expect.stringContaining('exact checked version') });
      expect(app.settings.codexExecutable).toBe('');
      expect(app.release).toHaveBeenCalledOnce();
      await app.service.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects a staged executable symlink that resolves outside the managed root', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mingle-provider-update-'));
    try {
      const outside = path.join(directory, 'outside');
      await writeFile(outside, '#!/usr/bin/env node\nconsole.log("1.1.0")\n', { mode: 0o700 });
      await chmod(outside, 0o700);
      const app = harness({ executable: '/usr/bin/codex', managedRoot: path.join(directory, 'managed'), installManagedPackage: async (target) => {
        const bin = path.join(target, 'node_modules', '.bin');
        await mkdir(bin, { recursive: true });
        await symlink(outside, path.join(bin, 'codex'));
      } });
      expect(await app.service.update('codex', '1.0.0')).toMatchObject({ status: 'failed' });
      expect(app.settings.codexExecutable).toBe('');
      await app.service.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('cleans failed staging directories so a later explicit install can retry', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mingle-provider-update-'));
    let attempts = 0;
    try {
      const app = harness({ executable: '/usr/bin/codex', managedRoot: path.join(directory, 'managed'), installManagedPackage: async (target) => {
        attempts++;
        if (attempts === 1) throw new Error('registry offline');
        const bin = path.join(target, 'node_modules', '.bin');
        await mkdir(bin, { recursive: true });
        const executable = path.join(bin, 'codex');
        await writeFile(executable, '#!/usr/bin/env node\nconsole.log("1.1.0")\n', { mode: 0o700 });
        await chmod(executable, 0o700);
      } });
      expect(await app.service.update('codex', '1.0.0')).toMatchObject({ status: 'failed', message: expect.stringContaining('registry offline') });
      expect(await app.service.update('codex', '1.0.0')).toMatchObject({ status: 'updated', installedVersion: '1.1.0' });
      expect(attempts).toBe(2);
      expect(app.settings.codexExecutable).toContain(`${path.sep}1.1.0${path.sep}`);
      await app.service.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('does not activate a validated install after shutdown begins', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mingle-provider-update-'));
    let finishRefresh!: (rows: ProviderInfo[]) => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
    try {
      const app = harness({ executable: '/usr/bin/codex', managedRoot: path.join(directory, 'managed'), installManagedPackage: async (target) => {
        const bin = path.join(target, 'node_modules', '.bin');
        await mkdir(bin, { recursive: true });
        const executable = path.join(bin, 'codex');
        await writeFile(executable, '#!/usr/bin/env node\nconsole.log("1.1.0")\n', { mode: 0o700 });
        await chmod(executable, 0o700);
      } });
      app.providers.refresh.mockImplementationOnce(async () => [diagnostic('1.0.0', '/usr/bin/codex')])
        .mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; refreshStarted(); }));
      const update = app.service.update('codex', '1.0.0');
      await started;
      const closing = app.service.close();
      finishRefresh([diagnostic()]);
      expect(await update).toMatchObject({ status: 'failed' });
      await closing;
      expect(app.settings.codexExecutable).toBe('');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

 it('recognizes Windows native roots while rejecting siblings and other drives', () => {
  expect(withinNativeInstallRoot('C:\\Users\\Example\\.local\\bin', 'c:\\Users\\Example\\.local\\bin\\codex.exe', path.win32)).toBe(true);
  expect(withinNativeInstallRoot('C:\\Users\\Example\\.local\\bin', 'C:\\Users\\Example\\.local\\binary\\codex.exe', path.win32)).toBe(false);
  expect(withinNativeInstallRoot('C:\\Users\\Example\\.local\\bin', 'D:\\Users\\Example\\.local\\bin\\codex.exe', path.win32)).toBe(false);
  expect(withinNativeInstallRoot('/home/example/.local/bin', '/home/example/.local/bin/codex', path.posix)).toBe(true);
  expect(withinNativeInstallRoot('/home/example/.local/bin', '/home/example/.local/bin/../other/codex', path.posix)).toBe(false);
});
