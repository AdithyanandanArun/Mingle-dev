import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configureLinuxPasswordStore,
  hasExplicitPasswordStore,
  selectLinuxPasswordStore,
} from './linux-backend.mjs';

function dbusOutput(names) {
  return `as ${names.length}${names.map(name => ` "${name}"`).join('')}`;
}

function successfulBus({ owned = [], activatable = [], provider = 'gnome-keyring-d' } = {}) {
  const calls = [];
  return {
    calls,
    run(command, args, options) {
      calls.push({ command, args, options });
      const query = args.at(-1);
      if (query === 'GetNameOwner') return { status: 0, stdout: 's ":1.42"' };
      if (query === 'GetConnectionUnixProcessID') return { status: 0, stdout: 'u 4242' };
      if (command === 'cat') return { status: 0, stdout: `${provider}\n` };
      return {
        status: 0,
        stdout: query === 'ListNames' ? dbusOutput(owned) : dbusOutput(activatable),
      };
    },
  };
}

test('auto-selects the actual Secret Service even when the desktop session is not GNOME', () => {
  const probe = successfulBus({ owned: ['org.freedesktop.DBus', 'org.freedesktop.secrets'] });
  const selection = selectLinuxPasswordStore({ platform: 'linux', argv: ['electron', 'main.mjs'], run: probe.run });

  assert.deepEqual(selection, { status: 'selected', backend: 'gnome-libsecret', explicit: false });
  assert.equal(probe.calls.length, 3);
  assert.equal(probe.calls.every(call => call.command === 'busctl'), true);
});

test('uses the detected KWallet major version when KWallet is the running provider', () => {
  const probe = successfulBus({ owned: ['org.kde.kwalletd6'] });
  const selection = selectLinuxPasswordStore({ platform: 'linux', argv: [], run: probe.run });

  assert.deepEqual(selection, { status: 'selected', backend: 'kwallet6', explicit: false });
});

test('prefers owned Secret Service for KDE when both providers run and GNOME Keyring owns it', () => {
  const probe = successfulBus({ owned: ['org.freedesktop.secrets', 'org.kde.kwalletd6'] });
  const selection = selectLinuxPasswordStore({
    platform: 'linux', argv: [], environment: { XDG_CURRENT_DESKTOP: 'KDE:Plasma' }, run: probe.run,
  });

  assert.deepEqual(selection, { status: 'selected', backend: 'gnome-libsecret', explicit: false });
});

test('uses Secret Service for KDE when KWallet owns the Secret Service name', () => {
  const probe = successfulBus({ owned: ['org.freedesktop.secrets', 'org.kde.kwalletd6'], provider: 'kwalletd6' });
  const selection = selectLinuxPasswordStore({
    platform: 'linux', argv: [], environment: { XDG_CURRENT_DESKTOP: 'KDE' }, run: probe.run,
  });
  assert.deepEqual(selection, { status: 'selected', backend: 'gnome-libsecret', explicit: false });
});

test('prefers owned Secret Service when both native providers are running', () => {
  const probe = successfulBus({ owned: ['org.freedesktop.secrets', 'org.kde.kwalletd5'] });
  const selection = selectLinuxPasswordStore({
    platform: 'linux', argv: [], environment: { XDG_CURRENT_DESKTOP: 'GNOME' }, run: probe.run,
  });

  assert.deepEqual(selection, { status: 'selected', backend: 'gnome-libsecret', explicit: false });
});

test('prefers running Secret Service for both providers on an unknown compositor', () => {
  const probe = successfulBus({ owned: ['org.freedesktop.secrets', 'org.kde.kwalletd6'] });
  const selection = selectLinuxPasswordStore({
    platform: 'linux', argv: [], environment: { XDG_CURRENT_DESKTOP: 'Hyprland' }, run: probe.run,
  });

  assert.deepEqual(selection, { status: 'selected', backend: 'gnome-libsecret', explicit: false });
});

test('desktop hints cannot select a provider without a matching bus service', () => {
  const secretOnly = successfulBus({ owned: ['org.freedesktop.secrets'] });
  const walletOnly = successfulBus({ owned: ['org.kde.kwalletd6'] });

  assert.deepEqual(selectLinuxPasswordStore({
    platform: 'linux', argv: [], environment: { XDG_CURRENT_DESKTOP: 'KDE' }, run: secretOnly.run,
  }), { status: 'selected', backend: 'gnome-libsecret', explicit: false });
  assert.deepEqual(selectLinuxPasswordStore({
    platform: 'linux', argv: [], environment: { XDG_CURRENT_DESKTOP: 'GNOME' }, run: walletOnly.run,
  }), { status: 'selected', backend: 'kwallet6', explicit: false });
});

test('detects an installed but activatable KWallet service', () => {
  const probe = successfulBus({ activatable: ['org.kde.kwalletd5'] });
  const selection = selectLinuxPasswordStore({ platform: 'linux', argv: [], run: probe.run });

  assert.deepEqual(selection, { status: 'selected', backend: 'kwallet5', explicit: false });
});

test('selects an activatable Secret Service without relying on desktop-name variables', () => {
  const probe = successfulBus({ activatable: ['org.freedesktop.secrets'] });
  const selection = selectLinuxPasswordStore({ platform: 'linux', argv: [], run: probe.run });

  assert.deepEqual(selection, { status: 'selected', backend: 'gnome-libsecret', explicit: false });
});

test('preserves either explicit password-store switch form and skips probes', () => {
  assert.equal(hasExplicitPasswordStore(['electron', '--password-store=basic']), true);
  assert.equal(hasExplicitPasswordStore(['electron', '--password-store', 'kwallet6']), true);
  const run = () => { throw new Error('must not probe an explicit choice'); };
  const selection = selectLinuxPasswordStore({ platform: 'linux', argv: ['electron', '--password-store=kwallet6'], run });

  assert.deepEqual(selection, { status: 'explicit', backend: null, explicit: true });
});

test('appends the detected choice before readiness, but never replaces an explicit choice', () => {
  const appended = [];
  const app = { commandLine: { appendSwitch: (...args) => appended.push(args) } };
  const probe = successfulBus({ owned: ['org.kde.kwalletd'] });

  configureLinuxPasswordStore({ app, platform: 'linux', argv: [], run: probe.run });
  assert.deepEqual(appended, [['password-store', 'kwallet']]);

  const explicit = configureLinuxPasswordStore({ app, platform: 'linux', argv: ['--password-store=basic'], run: () => assert.fail() });
  assert.equal(explicit.status, 'explicit');
  assert.deepEqual(appended, [['password-store', 'kwallet']]);
});

test('leaves Electron defaults unchanged on other platforms', () => {
  const selection = selectLinuxPasswordStore({ platform: 'darwin', argv: [], run: () => assert.fail() });
  assert.deepEqual(selection, { status: 'unchanged', backend: null, explicit: false });
});

test('fails closed when neither bus utilities nor the session bus are available', () => {
  const calls = [];
  const selection = selectLinuxPasswordStore({
    platform: 'linux', argv: [],
    run(command, args, options) {
      calls.push({ command, args, options });
      return { status: 1, stdout: '', error: new Error('private probe detail') };
    },
  });

  assert.deepEqual(selection, { status: 'unavailable', backend: null, explicit: false });
  assert.equal(calls.some(call => call.command === 'busctl'), true);
  assert.equal(calls.some(call => call.command === 'dbus-send'), true);
  assert.equal(calls.every(call => call.options.timeout <= 300), true);
});

test('bounds a hung D-Bus utility and does not infer a provider from the desktop name', () => {
  const calls = [];
  const selection = selectLinuxPasswordStore({
    platform: 'linux', argv: [],
    run(command, args, options) {
      calls.push({ command, args, options });
      return { status: null, stdout: '', error: new Error('timeout') };
    },
  });

  assert.deepEqual(selection, { status: 'unavailable', backend: null, explicit: false });
  assert.equal(calls.length <= 4, true);
  assert.equal(calls.every(call => call.options.timeout <= 300), true);
});
