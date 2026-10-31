import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw } from 'node:zlib';
import type { AntigravityInstallState } from '@mingle/contracts';
import { errorMessage, redactSecrets, truncate } from './util.ts';

// Google's official ACP registry release, pinned locally rather than executing an install script.
// Archive digests are recorded from dl.google.com; they are Mingle pins, not Google signatures.
const VERSION = '1.4.1';
const RELEASES: Record<string, { platform: string; archive: string; sha256: string }> = {
  'linux-x64': { platform: 'linux', archive: 'linux-x86_64', sha256: '2e37012ceb2a5c7fc7309b6e6596234fb637ee3c62a5199f65d4cbe777871384' },
  'linux-arm64': { platform: 'linux', archive: 'linux-arm64', sha256: '609336a1c97545487e3ddd55dbd153dc0f40f4e6534486cc1c5f4c0ebb85c2da' },
  'darwin-arm64': { platform: 'macos', archive: 'darwin-arm64', sha256: 'f9bdd68291ae78c38d2141e63bc86b84e6cc7b9f60f71652c68435a7943deb17' },
  'darwin-x64': { platform: 'macos', archive: 'darwin-x86_64', sha256: '27e31f096874704f14167b07ef9e84cc77134615ee41d024f7b1c957add85307' },
  'win32-x64': { platform: 'windows', archive: 'windows-x86_64', sha256: '5f5b7d0328df17c128b2be338d4567b0d24e56ace8196e88794fec37d1372554' },
  'win32-arm64': { platform: 'windows', archive: 'windows-arm64', sha256: '24c52bbc12aae20f55eb53d373669412d95a9c44fd59be4ea4e355918b91fbf7' },
};
const MAX_ARCHIVE_BYTES = 400 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1536 * 1024 * 1024;
interface InstallJob { running: boolean; error: string | null; controller: AbortController; settled?: Promise<void> }
const jobs = new Map<string, InstallJob>();

function release() { return RELEASES[`${process.platform}-${process.arch}`]; }
export function antigravityRuntimeDirectory(dataDir: string): string { return join(dataDir, 'providers', 'antigravity', VERSION); }
export function antigravityRuntimeFilenames(): [string, string] {
  return process.platform === 'win32' ? ['agy_acp_server.exe', 'localharness_external.exe'] : ['agy_acp_server.par', 'localharness_external'];
}

async function installed(dataDir: string): Promise<boolean> {
  try {
    await Promise.all(antigravityRuntimeFilenames().map(async (name) => {
      const path = join(antigravityRuntimeDirectory(dataDir), name);
      const info = await lstat(path);
      if (!info.isFile() || !info.size) throw new Error('Runtime is not a nonempty regular file.');
      await access(path, process.platform === 'win32' ? constants.R_OK : constants.X_OK);
    }));
    return true;
  }
  catch { return false; }
}

export async function antigravityInstallState(dataDir: string): Promise<AntigravityInstallState> {
  const job = jobs.get(dataDir);
  const exists = await installed(dataDir);
  return { supported: Boolean(release()), version: VERSION,
    state: job?.running ? 'installing' : exists ? 'installed' : job?.error ? 'error' : 'not-installed',
    executable: exists ? join(antigravityRuntimeDirectory(dataDir), antigravityRuntimeFilenames()[0]) : null,
    error: job?.error ?? (!release() ? 'Automatic installation is unavailable on this platform. Set a Google Antigravity ACP executable in Settings.' : null) };
}

async function readAt(file: Awaited<ReturnType<typeof open>>, offset: number, length: number): Promise<Buffer> {
  const data = Buffer.alloc(length);
  let position = 0;
  while (position < length) {
    const { bytesRead } = await file.read(data, position, length - position, offset + position);
    if (!bytesRead) throw new Error('The Antigravity archive is truncated.');
    position += bytesRead;
  }
  return data;
}

/** Extract exactly the two pinned runtime filenames. No archive paths become filesystem paths. */
async function unpack(archive: string, destination: string, signal: AbortSignal): Promise<void> {
  const file = await open(archive, 'r');
  try {
    const size = (await file.stat()).size;
    const tailLength = Math.min(size, 65557);
    const tail = await readAt(file, size - tailLength, tailLength);
    let end = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
      if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) { end = index; break; }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error('Unsupported Antigravity ZIP structure.');
    const count = tail.readUInt16LE(end + 10);
    const centralSize = tail.readUInt32LE(end + 12);
    const centralOffset = tail.readUInt32LE(end + 16);
    if (count !== 2 || tail.readUInt16LE(end + 8) !== count || centralSize > 65536 || centralOffset + centralSize > size - tailLength + end) throw new Error('Unexpected Antigravity ZIP contents.');
    const central = await readAt(file, centralOffset, centralSize);
    const expected = new Set<string>(antigravityRuntimeFilenames());
    let offset = 0; let totalExpanded = 0;
    for (let index = 0; index < count; index++) {
      signal.throwIfAborted();
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid Antigravity ZIP directory.');
      const flags = central.readUInt16LE(offset + 8);
      const method = central.readUInt16LE(offset + 10);
      const checksum = central.readUInt32LE(offset + 16);
      const compressed = central.readUInt32LE(offset + 20);
      const expanded = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const localOffset = central.readUInt32LE(offset + 42);
      if (offset + 46 + nameLength + extraLength + commentLength > central.length) throw new Error('Invalid Antigravity ZIP entry.');
      const name = central.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      offset += 46 + nameLength + extraLength + commentLength;
      totalExpanded += expanded;
      if (!expected.delete(name) || flags & 1 || ![0, 8].includes(method) || !compressed || !expanded || totalExpanded > MAX_EXPANDED_BYTES) throw new Error('Unexpected Antigravity runtime entry.');
      const local = await readAt(file, localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(8) !== method || local.readUInt16LE(6) & 1) throw new Error('Invalid Antigravity ZIP local header.');
      const localNameLength = local.readUInt16LE(26);
      const localName = await readAt(file, localOffset + 30, localNameLength);
      if (localName.toString('utf8') !== name) throw new Error('Antigravity ZIP filenames disagree.');
      const start = localOffset + 30 + localNameLength + local.readUInt16LE(28);
      if (start + compressed > centralOffset) throw new Error('Invalid Antigravity ZIP file range.');
      let bytes = 0; let actualChecksum = 0;
      const verify = new Transform({ transform(chunk: Buffer, _encoding, next) {
        bytes += chunk.length;
        if (bytes > expanded) { next(new Error('Antigravity runtime expanded past its declared limit.')); return; }
        actualChecksum = crc32(chunk, actualChecksum); next(null, chunk);
      } });
      const source = createReadStream(archive, { start, end: start + compressed - 1 });
      const output = createWriteStream(join(destination, name), { flags: 'wx', mode: 0o600 });
      if (method === 8) await pipeline(source, createInflateRaw(), verify, output, { signal });
      else await pipeline(source, verify, output, { signal });
      if (bytes !== expanded || actualChecksum !== checksum) throw new Error('Antigravity runtime failed ZIP integrity checks.');
      await chmod(join(destination, name), 0o755);
    }
    if (expected.size || offset !== central.length) throw new Error('Antigravity archive is incomplete.');
  } finally { await file.close(); }
}

async function downloadAndInstall(dataDir: string, signal: AbortSignal): Promise<string> {
  const selected = release();
  if (!selected) throw new Error('This platform has no managed Antigravity runtime.');
  const parent = join(dataDir, 'providers', 'antigravity');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(parent, '.install-'));
  try {
    const archive = join(temporary, 'runtime.zip');
    const url = `https://dl.google.com/agy-extensions/releases/${selected.platform}/agy-acp-server-${VERSION}-${selected.archive}.zip`;
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]) });
    if (!response.ok || !response.body) throw new Error(`Google runtime download failed (${response.status}).`);
    if (Number(response.headers.get('content-length') ?? 0) > MAX_ARCHIVE_BYTES) throw new Error('Google runtime archive exceeds the download limit.');
    let bytes = 0; const hash = createHash('sha256');
    const limit = new Transform({ transform(chunk: Buffer, _encoding, next) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) { next(new Error('Google runtime download exceeded the size limit.')); return; }
      hash.update(chunk); next(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
    if (hash.digest('hex') !== selected.sha256) throw new Error('Antigravity archive checksum mismatch. No runtime was installed.');
    await unpack(archive, temporary, signal);
    await rm(archive);
    await writeFile(join(temporary, 'release.json'), JSON.stringify({ version: VERSION, url, archiveSha256: selected.sha256 }) + '\n', { mode: 0o600 });
    // Atomic publish: an incomplete install never becomes the selected runtime.
    if (await installed(dataDir)) return join(antigravityRuntimeDirectory(dataDir), antigravityRuntimeFilenames()[0]);
    signal.throwIfAborted();
    await rm(antigravityRuntimeDirectory(dataDir), { recursive: true, force: true });
    await rename(temporary, antigravityRuntimeDirectory(dataDir));
    return join(antigravityRuntimeDirectory(dataDir), antigravityRuntimeFilenames()[0]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Explicit user action only. Returns immediately so Settings can poll bounded status requests. */
export async function startAntigravityInstall(dataDir: string, onInstalled: (executable: string) => void): Promise<AntigravityInstallState> {
  if (jobs.get(dataDir)?.running || !release()) return antigravityInstallState(dataDir);
  // Claim before the first await so simultaneous clicks cannot create competing installers.
  const job: InstallJob = { running: true, error: null, controller: new AbortController() };
  jobs.set(dataDir, job);
  job.settled = (async () => {
    const exists = await installed(dataDir);
    job.controller.signal.throwIfAborted();
    return exists ? join(antigravityRuntimeDirectory(dataDir), antigravityRuntimeFilenames()[0]) : downloadAndInstall(dataDir, job.controller.signal);
  })().then((executable) => {
    if (!job.controller.signal.aborted) onInstalled(executable);
  }).catch((error) => {
    if (!job.controller.signal.aborted) job.error = truncate(redactSecrets(errorMessage(error)), 500);
  }).finally(() => { job.running = false; });
  return antigravityInstallState(dataDir);
}

export async function closeAntigravityInstall(dataDir: string): Promise<void> {
  const job = jobs.get(dataDir);
  job?.controller.abort();
  await job?.settled;
}
