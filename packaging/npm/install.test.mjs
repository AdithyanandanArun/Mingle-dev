import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { downloadInstaller, installerTarget } from './install.mjs';

test('selects only supported native installers', () => {
  assert.throws(() => installerTarget('darwin', 'arm64'), /No npm desktop installer/);
  assert.throws(() => installerTarget('darwin', 'x64'), /No npm desktop installer/);
  assert.equal(installerTarget('win32', 'x64'), 'win32-x64');
  assert.equal(installerTarget('linux', 'x64', 'ID=ubuntu\nID_LIKE=debian'), 'deb-x64');
  assert.equal(installerTarget('linux', 'x64', 'ID=manjaro\nID_LIKE="arch manjaro"'), 'arch-x64');
  assert.throws(() => installerTarget('linux', 'x64', 'ID=fedora'), /No npm desktop installer/);
  assert.throws(() => installerTarget('win32', 'arm64'), /No npm desktop installer/);
});

test('downloads the versioned installer and rejects mismatched or oversized content', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mingle-npm-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const content = 'Example installer';
  const asset = {
    name: 'mingle-1.2.3-win32-x64-setup.exe',
    sha256: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content),
  };
  const path = join(directory, 'verified.exe');
  await downloadInstaller('1.2.3', asset, path, async url => {
    assert.equal(url, 'https://github.com/AdithyanandanArun/Mingle-dev/releases/download/v1.2.3/mingle-1.2.3-win32-x64-setup.exe');
    return new Response(content);
  });
  assert.equal(await readFile(path, 'utf8'), content);
  await assert.rejects(downloadInstaller('1.2.3', { ...asset, sha256: '0'.repeat(64) },
    join(directory, 'mismatch.exe'), async () => new Response(content)), /did not match/);
  await assert.rejects(downloadInstaller('1.2.3', asset,
    join(directory, 'oversized.exe'), async () => new Response(content + '!')), /exceeded/);
  await assert.rejects(downloadInstaller('1.2.3', { ...asset, name: '../outside.exe' },
    join(directory, 'unsafe.exe'), async () => assert.fail('must reject before fetching')), /Invalid installer manifest/);
});
