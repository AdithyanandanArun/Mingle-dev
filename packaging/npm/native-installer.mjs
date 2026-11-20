import { createHash, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const repository = 'https://github.com/AdithyanandanArun/Mingle-dev';

export function installerTarget(platform, arch, osRelease = '') {
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  if (platform === 'linux' && arch === 'x64') {
    const families = osRelease.split('\n').flatMap(line => {
      const match = /^(?:ID|ID_LIKE)=["']?([\w -]+)["']?\s*$/.exec(line);
      return match ? match[1].split(/\s+/) : [];
    });
    if (families.includes('arch')) return 'arch-x64';
    if (families.includes('debian') || families.includes('ubuntu')) return 'deb-x64';
  }
  throw new Error(`No npm desktop installer is available for ${platform}/${arch} on this system.`);
}

export async function downloadInstaller(version, asset, destination, request = fetch) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[A-Za-z0-9._-]+\.(?:deb|exe|pkg\.tar\.zst)$/.test(asset.name)
    || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error('Invalid installer manifest.');
  }
  const url = `${repository}/releases/download/v${version}/${asset.name}`;
  const response = await request(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Installer download failed (HTTP ${response.status}).`);
  const hash = createHash('sha256');
  let size = 0;
  const verify = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > asset.size) return callback(new Error('Installer download exceeded its expected size.'));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(destination, { flags: 'wx', mode: 0o700 }));
  if (size !== asset.size || !timingSafeEqual(hash.digest(), Buffer.from(asset.sha256, 'hex'))) {
    throw new Error('Installer download did not match its expected size and SHA-256.');
  }
}

