import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWindowDecorationPreference } from './window-decoration.mjs';

async function tempDir() { return mkdtemp(join(tmpdir(), 'mingle-decoration-')); }

test('defaults to system and gates decoration to Linux', async () => {
  const userData = await tempDir();
  try {
    const linux = createWindowDecorationPreference({ userData, platform: 'linux' });
    assert.deepEqual(linux.getState(), { supported: true, titleBar: 'system', activeTitleBar: 'system', restartRequired: false });
    assert.deepEqual(linux.windowOptions(), { frame: true });
    const other = createWindowDecorationPreference({ userData, platform: 'darwin' });
    assert.deepEqual(other.getState(), { supported: false, titleBar: 'system', activeTitleBar: 'system', restartRequired: false });
    assert.deepEqual(other.windowOptions(), {});
    assert.deepEqual(await other.setTitleBar('hidden'), other.getState());
  } finally { await rm(userData, { recursive: true, force: true }); }
});

test('persists requested setting, keeps active value until restart', async () => {
  const userData = await tempDir();
  try {
    const pref = createWindowDecorationPreference({ userData, platform: 'linux' });
    assert.deepEqual(await pref.setTitleBar('hidden'), { supported: true, titleBar: 'hidden', activeTitleBar: 'system', restartRequired: true });
    assert.deepEqual(pref.windowOptions(), { frame: true });
    assert.deepEqual(JSON.parse(await readFile(join(userData, 'window-decoration.json'), 'utf8')), { titleBar: 'hidden' });
    const { mode } = await import('node:fs/promises').then(fs => fs.stat(join(userData, 'window-decoration.json')));
    assert.equal(mode & 0o777, 0o600);
    const next = createWindowDecorationPreference({ userData, platform: 'linux' });
    assert.deepEqual(next.getState(), { supported: true, titleBar: 'hidden', activeTitleBar: 'hidden', restartRequired: false });
    assert.deepEqual(next.windowOptions(), { frame: false });
  } finally { await rm(userData, { recursive: true, force: true }); }
});

test('tolerates malformed and oversized files, validates input and preserves state on failed save', async () => {
  const userData = await tempDir();
  try {
    const file = join(userData, 'window-decoration.json');
    await (await import('node:fs/promises')).writeFile(file, '{broken');
    assert.equal(createWindowDecorationPreference({ userData, platform: 'linux' }).getState().titleBar, 'system');
    await (await import('node:fs/promises')).writeFile(file, ' '.repeat(4097));
    assert.equal(createWindowDecorationPreference({ userData, platform: 'linux' }).getState().titleBar, 'system');
    const pref = createWindowDecorationPreference({ userData, platform: 'linux' });
    await assert.rejects(pref.setTitleBar('invalid'), /titleBar/);
    await rm(file);
    await mkdir(file);
    const before = pref.getState();
    await assert.rejects(pref.setTitleBar('hidden'));
    assert.deepEqual(pref.getState(), before);
  } finally { await rm(userData, { recursive: true, force: true }); }
});
