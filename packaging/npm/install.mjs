#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createWriteStream, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

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

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Installer exited with ${signal ?? code}.`)));
  });
}

async function main([command, ...args]) {
  if (!command || command === '--help') {
    console.log('Usage: mingle-install install [--download-only]');
    return;
  }
  if (command !== 'install' || args.length > 1 || (args.length === 1 && args[0] !== '--download-only')) {
    throw new Error('Usage: mingle-install install [--download-only]');
  }
  const osRelease = process.platform === 'linux' ? await readFile('/etc/os-release', 'utf8') : '';
  const target = installerTarget(process.platform, process.arch, osRelease);
  const { version, assets } = JSON.parse(await readFile(new URL('./assets.json', import.meta.url), 'utf8'));
  const asset = assets[target];
  if (!asset) throw new Error(`This release has no installer for ${target}.`);
  const directory = await mkdtemp(join(tmpdir(), 'mingle-install-'));
  const path = join(directory, asset.name);
  let keep = false;
  try {
    console.log(`Downloading Mingle ${version} for ${target}…`);
    await downloadInstaller(version, asset, path);
    if (args[0] === '--download-only') {
      keep = true;
      console.log(path);
    } else if (target === 'win32-x64') {
      await run(path, []);
    } else {
      const installer = target === 'arch-x64' ? ['pacman', '-U'] : ['apt-get', 'install'];
      if (process.getuid() === 0) await run(installer[0], [...installer.slice(1), path]);
      else await run('sudo', [...installer, path]);
    }
  } finally {
    if (!keep) await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
