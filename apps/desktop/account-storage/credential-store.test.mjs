import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureCredentialStoreStartup, readCredentialStore, verifyCredentialStore, writeCredentialStore } from './credential-store.mjs';

function directory(t) {
  const value = mkdtempSync(join(tmpdir(), 'mingle-credential-store-'));
  t.after(() => rmSync(value, { recursive: true, force: true }));
  return value;
}

test('persists and validates only supported credential store choices', t => {
  const userData = directory(t);
  assert.equal(writeCredentialStore(userData, { backend: 'kwallet6', chosenBy: 'user' }), true);
  assert.deepEqual(readCredentialStore(userData), { backend: 'kwallet6', chosenBy: 'user' });
  assert.equal(writeCredentialStore(userData, { backend: 'basic_text', chosenBy: 'user' }), false);
  assert.match(readFileSync(join(userData, 'credential-store.json'), 'utf8'), /"chosenBy":"user"/);
});

test('loads a saved backend before probing and preserves explicit Electron overrides', t => {
  const userData = directory(t);
  writeCredentialStore(userData, { backend: 'gnome-libsecret', chosenBy: 'auto' });
  const appended = [];
  const app = { commandLine: { appendSwitch: (...args) => appended.push(args) } };
  assert.equal(configureCredentialStoreStartup({ app, userData, argv: [], platform: 'linux' }).backend, 'gnome-libsecret');
  assert.deepEqual(appended, [['password-store', 'gnome-libsecret']]);
  const explicit = configureCredentialStoreStartup({ app, userData, argv: ['electron', '--password-store=basic'], platform: 'linux' });
  assert.equal(explicit.explicit, true);
  assert.equal(appended.length, 1);
});

test('round trips encryption and remembers the working provider', t => {
  const userData = directory(t);
  const startup = { backend: 'gnome-libsecret', chosenBy: 'auto' };
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  assert.deepEqual(verifyCredentialStore({ app: {}, safeStorage, userData, startup, platform: 'linux' }), { status: 'available', backend: 'gnome-libsecret' });
  assert.deepEqual(readCredentialStore(userData), { backend: 'gnome-libsecret', chosenBy: 'auto' });
});

test('does not relaunch again after the guarded automatic retry', t => {
  const userData = directory(t);
  const calls = [];
  const app = { relaunch: options => calls.push(options), exit: code => calls.push(code) };
  const safeStorage = { isEncryptionAvailable: () => false };
  assert.deepEqual(verifyCredentialStore({ app, safeStorage, userData, startup: { backend: 'gnome-libsecret', chosenBy: 'auto' }, argv: ['electron', '--mingle-credential-store-relaunch'], platform: 'linux' }), { status: 'unavailable', backend: 'gnome-libsecret' });
  assert.deepEqual(calls, []);
});

test('relaunches once with the next detected candidate after an automatic store fails', t => {
  const userData = directory(t);
  const calls = [];
  const app = { relaunch: options => calls.push(options), exit: code => calls.push(code) };
  const safeStorage = { isEncryptionAvailable: () => false };
  const run = (_command, args) => {
    const method = args.at(-1);
    if (method === 'ListNames') return { status: 0, stdout: 'as 3 "org.freedesktop.secrets" "org.kde.kwalletd6"' };
    if (method === 'ListActivatableNames') return { status: 0, stdout: 'as 0' };
    if (method === 'GetNameOwner') return { status: 0, stdout: 's ":1.1"' };
    if (method === 'GetConnectionUnixProcessID') return { status: 0, stdout: 'u 21' };
    if (_command === 'cat') return { status: 0, stdout: 'gnome-keyring-d\n' };
    return { status: 1, stdout: '' };
  };
  const result = verifyCredentialStore({ app, safeStorage, userData, startup: { backend: 'gnome-libsecret', chosenBy: 'auto' }, argv: ['electron', 'main.mjs'], platform: 'linux', run });
  assert.deepEqual(result, { status: 'relaunching', backend: 'kwallet6' });
  assert.deepEqual(calls, [{ args: ['main.mjs', '--password-store=kwallet6', '--mingle-credential-store-relaunch'] }, 0]);
  assert.deepEqual(readCredentialStore(userData), { backend: 'kwallet6', chosenBy: 'auto' });
});
