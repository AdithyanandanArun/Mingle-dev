import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linuxPasswordStoreCandidates, selectLinuxPasswordStore } from './linux-backend.mjs';

const BACKENDS = new Set(['gnome-libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
const RELAUNCH_FLAG = '--mingle-credential-store-relaunch';
const PROBE = 'mingle credential storage check';

export function credentialStorePath(userData) { return join(userData, 'credential-store.json'); }

export function readCredentialStore(userData, fileSystem = { existsSync, readFileSync }) {
  try {
    const path = credentialStorePath(userData);
    if (!fileSystem.existsSync(path)) return null;
    const value = JSON.parse(fileSystem.readFileSync(path, 'utf8'));
    if (!BACKENDS.has(value?.backend) || !['auto', 'user'].includes(value?.chosenBy)) return null;
    return { backend: value.backend, chosenBy: value.chosenBy };
  } catch { return null; }
}

export function writeCredentialStore(userData, value, fileSystem = { mkdirSync, writeFileSync, renameSync, rmSync }) {
  if (!BACKENDS.has(value?.backend) || !['auto', 'user'].includes(value?.chosenBy)) return false;
  const path = credentialStorePath(userData);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    fileSystem.mkdirSync(userData, { recursive: true, mode: 0o700 });
    fileSystem.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    fileSystem.renameSync(temporary, path);
    return true;
  } catch {
    try { fileSystem.rmSync(temporary, { force: true }); } catch { /* bounded cleanup */ }
    return false;
  }
}

export function backendFromArgs(argv = process.argv) {
  const argument = argv.find(value => typeof value === 'string' && value.startsWith('--password-store='));
  const backend = argument?.slice('--password-store='.length);
  return BACKENDS.has(backend) ? backend : null;
}

export function configureCredentialStoreStartup({ app, safeStorage, userData, argv = process.argv, platform = process.platform, run }) {
  const stored = readCredentialStore(userData);
  const explicit = argv.some(value => value === '--password-store' || value.startsWith('--password-store='));
  const backend = explicit ? null : stored?.backend ?? backendFromArgs(argv) ?? selectLinuxPasswordStore({ platform, argv, run }).backend;
  if (backend && !explicit) app.commandLine.appendSwitch('password-store', backend);
  return { backend, chosenBy: explicit ? null : stored?.chosenBy ?? (backend ? 'auto' : null), explicit, stored };
}

function roundTrip(safeStorage) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const encrypted = safeStorage.encryptString(PROBE);
    return Buffer.isBuffer(encrypted) && encrypted.length > 0 && safeStorage.decryptString(encrypted) === PROBE;
  } catch { return false; }
}

/** An existing wrapped account key must remain readable before a provider choice is accepted. */
function existingKeyReadable(safeStorage, existingKey) {
  if (!existingKey) return true;
  try { return typeof safeStorage.decryptString(existingKey) === 'string'; } catch { return false; }
}

export function verifyCredentialStore({ app, safeStorage, userData, startup, argv = process.argv, platform = process.platform, run, fileSystem, existingKey = null }) {
  const actual = startup.backend ?? backendFromArgs(argv);
  if (!actual) return { status: roundTrip(safeStorage) ? 'available' : 'unavailable', backend: null };
  const readableExistingKey = existingKeyReadable(safeStorage, existingKey);
  if (roundTrip(safeStorage) && readableExistingKey) {
    writeCredentialStore(userData, { backend: actual, chosenBy: startup.chosenBy ?? 'auto' }, fileSystem);
    return { status: 'available', backend: actual };
  }
  // Do not pin an automatically selected provider that can encrypt new values but cannot
  // decrypt the existing account key. Preserve the saved choice and let the user select
  // the keyring that owns the old key in Account settings.
  if (!readableExistingKey) return { status: 'unavailable', backend: actual };
  if (startup.chosenBy === 'user' || argv.includes(RELAUNCH_FLAG)) return { status: 'unavailable', backend: actual };
  const candidates = linuxPasswordStoreCandidates({ platform, argv: [], run });
  const index = candidates.indexOf(actual);
  const next = candidates[index >= 0 ? index + 1 : 0];
  if (!next) return { status: 'unavailable', backend: actual };
  if (!writeCredentialStore(userData, { backend: next, chosenBy: 'auto' }, fileSystem)) return { status: 'unavailable', backend: actual };
  app.relaunch({ args: [...argv.slice(1).filter(value => value !== RELAUNCH_FLAG && !value.startsWith('--password-store=')), `--password-store=${next}`, RELAUNCH_FLAG] });
  app.exit(0);
  return { status: 'relaunching', backend: next };
}

export function saveUserCredentialStore(userData, backend) {
  if (backend === 'auto') {
    try { rmSync(credentialStorePath(userData), { force: true }); return true; } catch { return false; }
  }
  return writeCredentialStore(userData, { backend, chosenBy: 'user' });
}

export function credentialStoreOptions({ userData, platform = process.platform, run } = {}) {
  const stored = userData ? readCredentialStore(userData) : null;
  const candidates = linuxPasswordStoreCandidates({ platform, argv: [], run });
  const selection = selectLinuxPasswordStore({ platform, argv: [], run });
  const available = stored?.chosenBy === 'user' && stored.backend && !candidates.includes(stored.backend)
    ? [...candidates, stored.backend] : candidates;
  return { available, selected: stored?.backend ?? readCredentialStoreForDisplay(selection, candidates), chosenBy: stored?.chosenBy ?? 'auto' };
}

function readCredentialStoreForDisplay(selection, candidates) {
  return selection.backend ?? candidates[0] ?? null;
}
