import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { deferred, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const boot = async () => { const t = await startTestApp(); apps.push(t); return t; };
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

describe('provider executable settings maintenance', () => {
  it('rejects executable changes during a provider turn but allows appearance changes', async () => {
    const t = await boot(); const gate = deferred(); t.fake.script = async () => { await gate.promise; };
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'Example held turn' });
    await waitFor(() => t.fake.runs.length === 1);
    const before = t.app.store.getSettings().codexExecutable;
    try {
      const refused = await t.api('PATCH', '/api/settings', { codexExecutable: '/example/previous/codex', theme: 'light' });
      expect(refused.status).toBe(409);
      expect(t.app.store.getSettings()).toMatchObject({ codexExecutable: before, theme: 'dark' });
      expect((await t.api('PATCH', '/api/settings', { theme: 'light' })).status).toBe(200);
      expect(t.app.store.getSettings().theme).toBe('light');
    } finally { gate.resolve(); }
    await waitFor(() => !t.app.runtime.isActive(EXAMPLE_CONTRACT_SESSION_ID));
    expect((await t.api('PATCH', '/api/settings', { codexExecutable: '' })).status).toBe(200);
  });

  it('ignores the removed color preference in old databases and requests', async () => {
    const t = await boot();
    t.app.store.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('colorStyle', JSON.stringify('subtle'));
    expect((await t.api('GET', '/api/settings')).json).not.toHaveProperty('colorStyle');
    const saved = await t.api('PATCH', '/api/settings', { theme: 'light', colorStyle: 'subtle' });
    expect(saved.status).toBe(200);
    expect(saved.json.theme).toBe('light');
    expect(saved.json).not.toHaveProperty('colorStyle');
    expect((await t.api('GET', '/api/bootstrap')).json.settings).not.toHaveProperty('colorStyle');
  });

  it('atomically refuses a multi-provider change and releases earlier reservations', async () => {
    const t = await boot(); const before = t.app.store.getSettings();
    const release = t.app.runtime.reserveProviderMaintenance('claude');
    expect(release).not.toBeNull();
    try {
      const response = await t.api('PATCH', '/api/settings', { codexExecutable: '/example/codex', claudeExecutable: '/example/claude' });
      expect(response.status).toBe(409);
      expect(t.app.store.getSettings()).toMatchObject({ codexExecutable: before.codexExecutable, claudeExecutable: before.claudeExecutable });
      expect(t.app.runtime.isProviderUnderMaintenance('codex')).toBe(false);
    } finally { release!(); }
    expect((await t.api('PATCH', '/api/settings', { codexExecutable: '/example/codex' })).status).toBe(200);
    expect(t.app.runtime.isProviderUnderMaintenance('codex')).toBe(false);
    expect((await t.api('PATCH', '/api/settings', { codexExecutable: '' })).status).toBe(200);
    expect(t.app.store.getSettings().codexExecutable).toBe('');
  });
});
