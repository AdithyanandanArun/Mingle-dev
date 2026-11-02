import { expect, it } from 'vitest';
import { deferred, startTestApp, waitFor } from '../test-utils.ts';
import { EXAMPLE_CLIENT_SESSION_ID } from '../example.ts';

it('atomically excludes new turns and compaction, including cancellation cleanup, during provider maintenance', async () => {
  const app = await startTestApp();
  const cleanup = deferred();
  try {
    const release = app.app.runtime.reserveProviderMaintenance('claude');
    expect(release).not.toBeNull();
    expect(app.app.runtime.reserveProviderMaintenance('claude')).toBeNull();
    expect(() => app.app.runtime.start(EXAMPLE_CLIENT_SESSION_ID, 'do not run')).toThrow(/updated/);
    expect(() => app.app.runtime.compact(EXAMPLE_CLIENT_SESSION_ID)).toThrow(/updated/);
    expect(app.fake.runs).toHaveLength(0);
    release!(); release!();
    app.fake.script = async () => cleanup.promise;
    expect((await app.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`, { content: 'Fixture run only.' })).status).toBe(202);
    await waitFor(() => app.fake.runs.length === 1);
    expect(app.app.runtime.reserveProviderMaintenance('claude')).toBeNull();
    await app.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/interrupt`);
    await waitFor(() => app.app.store.getSession(EXAMPLE_CLIENT_SESSION_ID)?.status === 'interrupted');
    expect(app.app.runtime.reserveProviderMaintenance('claude')).toBeNull();
    cleanup.resolve(); await waitFor(() => !app.app.runtime.isActive(EXAMPLE_CLIENT_SESSION_ID));
    expect(app.app.runtime.reserveProviderMaintenance('claude')).not.toBeNull();
  } finally { cleanup.resolve(); await app.cleanup(); }
});

it('persists per-version dismissals and checks the guarded update HTTP boundary without calling an updater', async () => {
  const app = await startTestApp();
  try {
    const invalid = await app.api('POST', '/api/providers/updates/apply', { provider: 'claude', expectedVersion: null, command: 'arbitrary' });
    expect(invalid.status).toBe(400);
    expect((await app.api('POST', '/api/providers/updates/dismiss', { provider: 'claude', version: '9.9.9' })).status).toBe(200);
    expect(app.app.store.providerUpdateDismissed('claude', '9.9.9')).toBe(true);
    expect(app.app.store.providerUpdateDismissed('claude', '10.0.0')).toBe(false);
    const snapshot = await app.api('GET', '/api/providers/updates');
    expect(snapshot.status).toBe(200);
    expect(snapshot.json.providers.find((row: { provider: string }) => row.provider === 'claude')).toMatchObject({ status: 'unknown', installedVersion: 'fake' });
    expect(app.fake.runs).toHaveLength(0);
  } finally { await app.cleanup(); }
});
