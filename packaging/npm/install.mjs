#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { downloadInstaller, installerTarget } from './native-installer.mjs';

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
