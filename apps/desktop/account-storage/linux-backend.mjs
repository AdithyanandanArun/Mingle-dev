import { spawnSync } from 'node:child_process';

const DBUS_DESTINATION = 'org.freedesktop.DBus';
const DBUS_OBJECT = '/org/freedesktop/DBus';
const DBUS_INTERFACE = 'org.freedesktop.DBus';
const KNOWN_SERVICES = new Set([
  'org.freedesktop.secrets',
  'org.kde.kwalletd',
  'org.kde.kwalletd5',
  'org.kde.kwalletd6',
]);
const PROBE_TIMEOUT_MS = 300;
const PROBE_BUDGET_MS = 800;

export function hasExplicitPasswordStore(argv = process.argv) {
  return argv.some(argument => argument === '--password-store' || argument.startsWith('--password-store='));
}

function readServiceNames(output) {
  const tokens = output.match(/"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+/g) ?? [];
  const names = new Set();
  for (const token of tokens) {
    const name = token.replace(/^['"]|['"]$/g, '');
    if (KNOWN_SERVICES.has(name)) names.add(name);
  }
  return names;
}

function invoke(run, command, args, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  let result;
  try {
    result = run(command, args, {
      encoding: 'utf8',
      timeout: Math.min(PROBE_TIMEOUT_MS, remaining),
      maxBuffer: 8192,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return null;
  }
  if (!result || result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout;
}

function queryServices(run, command, makeArgs, deadline) {
  const list = method => invoke(run, command, makeArgs(method), deadline);
  const ownedOutput = list('Names');
  const activatableOutput = list('ActivatableNames');
  if (ownedOutput === null || activatableOutput === null) return null;
  return {
    owned: readServiceNames(ownedOutput),
    activatable: readServiceNames(activatableOutput),
  };
}

function secretServiceOwner(run, command, deadline) {
  const args = command === 'busctl'
    ? ['--user', '--no-pager', 'call', DBUS_DESTINATION, DBUS_OBJECT, DBUS_INTERFACE, 'GetNameOwner', 's', 'org.freedesktop.secrets']
    : ['--session', '--print-reply=literal', `--dest=${DBUS_DESTINATION}`, DBUS_OBJECT, `${DBUS_INTERFACE}.GetNameOwner`, 'string:org.freedesktop.secrets'];
  const output = invoke(run, command, args, deadline);
  if (!output) return null;
  const match = output.match(/(?:"|'?)(:[0-9]+\.[0-9]+)(?:"|'?)/);
  return match?.[1] ?? null;
}

function secretServiceProcessId(run, command, owner, deadline) {
  const args = command === 'busctl'
    ? ['--user', '--no-pager', 'call', DBUS_DESTINATION, DBUS_OBJECT, DBUS_INTERFACE, 'GetConnectionUnixProcessID', 's', owner]
    : ['--session', '--print-reply=literal', `--dest=${DBUS_DESTINATION}`, DBUS_OBJECT, `${DBUS_INTERFACE}.GetConnectionUnixProcessID`, `string:${owner}`];
  const output = invoke(run, command, args, deadline);
  if (!output) return null;
  const match = output.match(/(?:^|\s)([1-9][0-9]{0,8})(?:\s|$)/);
  const pid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function identifySecretService(run, command, deadline) {
  const owner = secretServiceOwner(run, command, deadline);
  if (!owner) return null;
  const pid = secretServiceProcessId(run, command, owner, deadline);
  if (!pid) return null;
  try {
    const result = run('cat', [`/proc/${pid}/comm`], { encoding: 'utf8', timeout: 100, maxBuffer: 256, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    if (!result || result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
    return result.stdout.trim().toLowerCase();
  } catch { return null; }
}

function probeSessionServices(run = spawnSync) {
  const deadline = Date.now() + PROBE_BUDGET_MS;
  const busctl = queryServices(run, 'busctl', method => [
    '--user', '--no-pager', 'call', DBUS_DESTINATION, DBUS_OBJECT, DBUS_INTERFACE, `List${method}`,
  ], deadline);
  if (busctl) return { ...busctl, secretServiceProvider: busctl.owned.has('org.freedesktop.secrets')
    ? identifySecretService(run, 'busctl', deadline) : null };
  const dbusSend = queryServices(run, 'dbus-send', method => [
    '--session', '--print-reply=literal', `--dest=${DBUS_DESTINATION}`, DBUS_OBJECT, `${DBUS_INTERFACE}.List${method}`,
  ], deadline);
  return dbusSend ? { ...dbusSend, secretServiceProvider: dbusSend.owned.has('org.freedesktop.secrets')
    ? identifySecretService(run, 'dbus-send', deadline) : null } : null;
}

function walletBackend(names) {
  if (names.has('org.kde.kwalletd6')) return 'kwallet6';
  if (names.has('org.kde.kwalletd5')) return 'kwallet5';
  if (names.has('org.kde.kwalletd')) return 'kwallet';
  return null;
}

function chooseBackend(services) {
  const activeWallet = walletBackend(services.owned);
  const activatableWallet = walletBackend(services.activatable);
  const secretServiceAvailable = services.owned.has('org.freedesktop.secrets')
    || services.activatable.has('org.freedesktop.secrets');
  const walletAvailable = activeWallet ?? activatableWallet;

  // The Secret Service API may itself be backed by KWallet or another provider. Its
  // Electron backend remains libsecret, and a running owner beats an activatable service.
  if (services.owned.has('org.freedesktop.secrets')) return 'gnome-libsecret';
  if (activeWallet) return activeWallet;
  if (services.activatable.has('org.freedesktop.secrets')) return 'gnome-libsecret';
  return activatableWallet;
}

/**
 * Select Electron's Linux safeStorage provider from actual session-bus services.
 */
export function selectLinuxPasswordStore({
  platform = process.platform,
  argv = process.argv,
  environment = process.env,
  run = spawnSync,
} = {}) {
  if (platform !== 'linux') return { status: 'unchanged', backend: null, explicit: false };
  if (hasExplicitPasswordStore(argv)) return { status: 'explicit', backend: null, explicit: true };

  const services = probeSessionServices(run);
  if (!services) return { status: 'unavailable', backend: null, explicit: false };
  const backend = chooseBackend(services);
  return backend
    ? { status: 'selected', backend, explicit: false }
    : { status: 'unavailable', backend: null, explicit: false };
}

export function configureLinuxPasswordStore({ app, ...options }) {
  const selection = selectLinuxPasswordStore(options);
  if (selection.status === 'selected') app.commandLine.appendSwitch('password-store', selection.backend);
  return selection;
}

export function linuxPasswordStoreCandidates({ platform = process.platform, argv = process.argv, run = spawnSync } = {}) {
  if (platform !== 'linux' || hasExplicitPasswordStore(argv)) return [];
  const services = probeSessionServices(run);
  if (!services) return [];
  const activeSecret = services.owned.has('org.freedesktop.secrets');
  const activeWallet = walletBackend(services.owned);
  const activatableSecret = services.activatable.has('org.freedesktop.secrets');
  const activatableWallet = walletBackend(services.activatable);
  return [...new Set([
    ...(activeSecret ? ['gnome-libsecret'] : []),
    ...(activeWallet ? [activeWallet] : []),
    ...(!activeSecret && activatableSecret ? ['gnome-libsecret'] : []),
    ...(!activeWallet && activatableWallet ? [activatableWallet] : []),
  ])];
}
