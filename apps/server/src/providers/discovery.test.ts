import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { parseVersion, resolveExecutable } from './discovery.js';
import { detectClaude, detectCodex, detectProviders } from './detect.js';
import { Sandbox, posixOnly } from './testing/executables.js';
import { settings } from './testing/helpers.js';

describe('version parsing', () => {
  it('reads the versions printed by claude and codex', () => {
    expect(parseVersion('2.1.292 (Claude Code)')).toBe('2.1.292');
    expect(parseVersion('codex-cli 0.160.1\n')).toBe('0.160.1');
    expect(parseVersion('Error: claude native binary not installed.')).toBeNull();
    expect(parseVersion('OpenCode 1.19.5 (linux x64)')).toBe('1.19.5');
    expect(parseVersion('v2.0.0-beta.3')).toBe('2.0.0-beta.3');
  });
});

describe.skipIf(posixOnly)('executable discovery', () => {
  let box: Sandbox;
  beforeEach(async () => { box = await Sandbox.create(); });
  afterEach(async () => { await box.dispose(); });

  const good = 'echo "2.1.292 (Claude Code)"';
  const broken = 'echo "Error: claude native binary not installed." >&2; exit 1';

  it('skips a broken PATH executable and uses ~/.npm-global/bin', async () => {
    const shim = await box.script('usr/bin/claude', broken);
    const working = await box.script('home/.npm-global/bin/claude', good);
    const result = await resolveExecutable({ name: 'claude', override: '', env: { PATH: join(box.root, 'usr/bin') }, home: join(box.root, 'home') });
    expect(result.ok && result.executable).toMatchObject({ path: working, version: '2.1.292', source: 'npm-global' });
    expect(result.ok && result.executable.skipped[0]).toMatchObject({ path: shim, source: 'path', reason: expect.stringContaining('native binary not installed') });
  });

  it('prefers PATH, then ~/.local/bin, then ~/.npm-global/bin', async () => {
    const home = join(box.root, 'home');
    const local = await box.script('home/.local/bin/claude', good);
    await box.script('home/.npm-global/bin/claude', good);
    const env = { PATH: join(box.root, 'empty') };
    expect(await resolveExecutable({ name: 'claude', override: '', env, home })).toMatchObject({ ok: true, executable: { path: local, source: 'home-local' } });
    const onPath = await box.script('bin/claude', good);
    expect(await resolveExecutable({ name: 'claude', override: '', env: { PATH: join(box.root, 'bin') }, home })).toMatchObject({ ok: true, executable: { path: onPath, source: 'path' } });
  });

  it('honours the settings override without silently falling back', async () => {
    await box.script('home/.npm-global/bin/claude', good);
    const override = await box.script('custom/claude', good);
    const env = { PATH: join(box.root, 'none') };
    const home = join(box.root, 'home');
    expect(await resolveExecutable({ name: 'claude', override, env, home })).toMatchObject({ ok: true, executable: { path: override, source: 'setting' } });
    const brokenOverride = await box.script('custom/bad', broken);
    const failed = await resolveExecutable({ name: 'claude', override: brokenOverride, env, home });
    expect(failed).toMatchObject({ ok: false, reason: expect.stringContaining('failed `--version`') });
    expect(await resolveExecutable({ name: 'claude', override: join(box.root, 'custom/missing'), env, home })).toMatchObject({ ok: false, reason: expect.stringContaining('does not exist') });
    expect(await resolveExecutable({ name: 'claude', override: '~/.npm-global/bin/claude', env, home })).toMatchObject({ ok: true });
  });

  it('times out a hanging executable and reports every attempt', async () => {
    const hang = await box.script('bin/claude', `exec "${process.execPath}" -e "setTimeout(() => {}, 5000)"`);
    const result = await resolveExecutable({ name: 'claude', override: '', env: { PATH: join(box.root, 'bin') }, home: join(box.root, 'home'), probeTimeoutMs: 150 });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('timed out') });
    expect(!result.ok && result.reason).toContain(hang);
  });

  it('says so when nothing is installed', async () => {
    const result = await resolveExecutable({ name: 'codex', override: '', env: { PATH: join(box.root, 'none') }, home: join(box.root, 'home') });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('not found') });
    expect(!result.ok && result.reason).toContain('set its executable path in Settings');
    expect(!result.ok && result.reason).toContain('.bun/bin');
  });

  it('searches additional install directories and prefers the newest nvm version', async () => {
    const home = join(box.root, 'home');
    const found = new Map<string, string>();
    const executable = async (path: string) => found.has(path);
    const directories = async (path: string) => path.endsWith('/.nvm/versions/node') ? ['v18.1.0', 'v22.4.0', 'v20.18.1'] : [];
    const newest = join(home, '.nvm/versions/node/v22.4.0/bin/opencode');
    const older = join(home, '.nvm/versions/node/v20.18.1/bin/opencode');
    const bun = join(home, '.bun/bin/opencode');
    found.set(newest, 'latest'); found.set(older, 'older'); found.set(bun, 'bun');
    const result = await resolveExecutable({ name: 'opencode', override: '', env: { PATH: '' }, home,
      fs: { executable, directories }, probe: async (path) => ({ ok: true, stdout: `${found.get(path) === 'older' ? '1.2.3' : '2.4.0'}\n`, stderr: '', exitCode: 0, signal: null, timedOut: false, spawnError: null }) });
    expect(result).toMatchObject({ ok: true, executable: { path: bun, source: 'bun' } });
    // Established fallback order retains .bun before nvm.
    const onlyNvm = await resolveExecutable({ name: 'opencode', override: '', env: { PATH: '' }, home,
      fs: { executable: async (path) => path === newest || path === older, directories },
      probe: async (path) => ({ ok: true, stdout: `${path === newest ? '2.4.0' : '1.2.3'}\n`, stderr: '', exitCode: 0, signal: null, timedOut: false, spawnError: null }) });
    expect(onlyNvm).toMatchObject({ ok: true, executable: { path: newest, source: 'nvm' } });
  });

  it('searches npm configured prefix after standard candidates', async () => {
    const home = join(box.root, 'home');
    const prefixBinary = join(box.root, 'npm-prefix/bin/codex');
    const result = await resolveExecutable({ name: 'codex', override: '', env: { PATH: '', npm_config_prefix: join(box.root, 'npm-prefix') }, home,
      fs: { executable: async (path) => path === prefixBinary, directories: async () => [] },
      probe: async () => ({ ok: true, stdout: '1.2.3', stderr: '', exitCode: 0, signal: null, timedOut: false, spawnError: null }) });
    expect(result).toMatchObject({ ok: true, executable: { path: prefixBinary, source: 'npm-prefix' } });
  });
});

describe.skipIf(posixOnly)('provider detection', () => {
  let box: Sandbox;
  beforeEach(async () => { box = await Sandbox.create(); });
  afterEach(async () => { await box.dispose(); });

  it('does not treat an installed Claude binary as authenticated', async () => {
    const claude = await box.script('home/.npm-global/bin/claude', `if [ "$1" = "auth" ]; then
  echo '{"loggedIn":false,"authMethod":"none"}'
  exit 1
fi
echo "2.1.292 (Claude Code)"`);
    const base = { settings: { ...settings, claudeExecutable: claude }, deps: { home: join(box.root, 'home') } };
    const noKey = await detectClaude(base.settings, { ...base.deps, env: { PATH: '' } });
    expect(noKey).toMatchObject({ id: 'claude', available: false, version: '2.1.292', executable: claude });
    expect(noKey.reason).toContain('no login was found');
    expect(noKey.reason).toContain('auth login');
    const withKey = await detectClaude(base.settings, { ...base.deps, env: { PATH: '', ANTHROPIC_API_KEY: 'sk-ant-secret-value-0000' } });
    expect(withKey.available).toBe(true);
    expect(withKey.reason).toContain('not validated');
    expect(JSON.stringify(withKey)).not.toContain('sk-ant-secret');
    expect(withKey.models.map((m) => m.id)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001']);
  });

  it('reports a missing Claude executable', async () => {
    const info = await detectClaude({ ...settings, claudeExecutable: join(box.root, 'nope') }, { env: { PATH: '', ANTHROPIC_API_KEY: 'sk-ant-x-0000000000' } });
    expect(info).toMatchObject({ available: false, version: null, executable: null });
    expect(info.reason).toContain('does not exist');
  });

  it('detects Codex through the app-server: models from model/list, account from account/read', async () => {
    const codex = await box.fakeCodex();
    const info = await detectCodex({ ...settings, codexExecutable: codex }, { env: { PATH: '', FAKE_CODEX_ACCOUNT: 'chatgpt' } });
    expect(info).toMatchObject({ id: 'codex', available: true, version: '9.9.9', executable: codex });
    expect(info.models).toMatchObject([{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }]);
    expect(info.reason).toContain('chatgpt');
    expect(info.reason).toContain('not validated');
  });

  it('marks Codex unavailable when no login exists', async () => {
    const codex = await box.fakeCodex();
    const info = await detectCodex({ ...settings, codexExecutable: codex }, { env: { PATH: '', FAKE_CODEX_ACCOUNT: 'none' } });
    expect(info.available).toBe(false);
    expect(info.version).toBe('9.9.9');
    expect(info.reason).toContain('codex login');
  });

  it('falls back to the documented default model when the app-server never answers', async () => {
    const codex = await box.fakeCodex();
    const info = await detectCodex({ ...settings, codexExecutable: codex }, { env: { PATH: '', FAKE_CODEX_MODE: 'no-initialize' }, codexProbeTimeoutMs: 1_200 });
    expect(info.available).toBe(false);
    expect(info.models).toEqual([{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }]);
    expect(info.reason).toContain('did not respond');
  });

  it('detectProviders returns all four providers in a stable order', async () => {
    const codex = await box.fakeCodex();
    const claude = await box.script('bin/claude', 'echo "2.1.292 (Claude Code)"');
    const result = await detectProviders({ ...settings, codexExecutable: codex, claudeExecutable: claude }, { env: { PATH: '' } });
    expect(result.map((p) => p.id)).toEqual(['codex', 'claude', 'antigravity', 'opencode']);
  });
});
