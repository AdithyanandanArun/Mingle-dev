import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as installer from '../../packaging/npm/native-installer.mjs';
import { createDesktopAppUpdate } from './app-update.mjs';

function fixture({ platform = 'linux', installVersion = '0.1.6', corrupt = false } = {}) {
  let installed = '0.1.5';
  const name = 'mingle-bin-0.1.6-1-x86_64.pkg.tar.zst';
  const content = 'Example installer fixture';
  const digest = createHash('sha256').update(content).digest('hex');
  const requests = [];
  const calls = [];
  const update = createDesktopAppUpdate({
    app: { isPackaged: true, getVersion: () => '0.1.5' }, platform, arch: 'x64', executable: '/opt/mingle/mingle',
    installer, resourcesPath: '/opt/mingle/resources', workspace: () => 'http://127.0.0.1:3000',
    read: async path => path === '/etc/os-release' ? 'ID=arch' : JSON.stringify({ version: installed }),
    canAccess: async path => assert.equal(path, '/usr/bin/pkexec'),
    execute: async (path, args) => {
      assert.equal(path, '/usr/bin/pacman');
      assert.deepEqual(args, ['-Q', 'mingle-bin']);
      return { stdout: 'mingle-bin 0.1.5-1\n' };
    },
    request: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith('http://127.0.0.1:3000/')) return Response.json({ status: 'available', installedVersion: '0.1.5', latestVersion: '0.1.6' });
      if (url.startsWith('https://api.github.com/')) return Response.json({ tag_name: 'v0.1.6', draft: false, prerelease: false,
        assets: [{ name, size: content.length, digest: `sha256:${digest}`, state: 'uploaded' }] });
      return new Response(corrupt ? content.replace('Example', 'Corrupt') : content);
    },
    apply: async (args) => {
      calls.push(args);
      assert.equal(await readFile(args[3], 'utf8'), content);
      installed = installVersion;
    },
  });
  return { update, calls, requests, name };
}

test('checks the offered version and verifies the installer before requesting a restart', async () => {
  const { update, calls, requests, name } = fixture();
  assert.deepEqual(await update.state(), { canInstall: true, phase: 'idle', restartVersion: null });
  await assert.rejects(update.install('0.1.7'), /available version changed/);
  assert.equal(calls.length, 0);
  const pending = update.install('0.1.6');
  await assert.rejects(update.install('0.1.6'), /already in progress/);
  assert.deepEqual(await pending, { canInstall: true, phase: 'idle', restartVersion: '0.1.6' });
  assert.deepEqual(calls[0].slice(0, 3), ['/usr/bin/pacman', '-U', '--noconfirm']);
  assert.ok(requests.includes(`https://github.com/AdithyanandanArun/Mingle-dev/releases/download/v0.1.6/${name}`));
  await assert.rejects(update.install('0.1.6'), /Restart Mingle/);
});

test('keeps failures and unsupported installations out of the restart state', async () => {
  const invalid = fixture({ corrupt: true });
  await assert.rejects(invalid.update.install('0.1.6'), /did not match/);
  assert.equal(invalid.calls.length, 0);
  const unchanged = fixture({ installVersion: '0.1.5' });
  await assert.rejects(unchanged.update.install('0.1.6'), /expected installed version/);
  assert.equal((await unchanged.update.state()).restartVersion, null);
  const windows = fixture({ platform: 'win32' });
  assert.equal((await windows.update.state()).canInstall, false);
  await assert.rejects(windows.update.install('0.1.6'), /native installer/);
  assert.equal(windows.requests.length, 0);
});
