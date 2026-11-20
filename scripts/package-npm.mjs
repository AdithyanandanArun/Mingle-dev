import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = resolve(process.argv[2] ?? join(root, 'release'));
const { version } = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('npm packaging needs a stable desktop version.');
const names = {
  'arch-x64': `mingle-bin-${version}-1-x86_64.pkg.tar.zst`,
  'deb-x64': `mingle_${version}_amd64.deb`,
  'win32-x64': `mingle-${version}-win32-x64-setup.exe`,
};

const assets = {};
for (const [target, name] of Object.entries(names)) {
  const file = join(release, name);
  const metadata = await stat(file).catch(error => {
    if (error.code === 'ENOENT') throw new Error(`Missing release installer for ${target}: ${name}`);
    throw error;
  });
  if (!metadata.isFile() || !metadata.size) throw new Error(`Missing installer content: ${name}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  if ((await readFile(`${file}.sha256`, 'utf8')).trim() !== `${sha256}  ${name}`) throw new Error(`Installer checksum mismatch: ${name}`);
  assets[target] = { name, size: metadata.size, sha256 };
}

await mkdir(release, { recursive: true });
const packageDir = await mkdtemp(join(release, 'npm-stage-'));
const manifest = {
  name: '@mingledev/mingle',
  version,
  description: 'Install the Mingle desktop app for your platform',
  license: 'MIT',
  type: 'module',
  bin: { 'mingle-install': 'install.mjs' },
  files: ['install.mjs', 'assets.json'],
  engines: { node: '>=22' },
  repository: { type: 'git', url: 'git+https://github.com/AdithyanandanArun/Mingle-dev.git' },
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
};
await copyFile(join(root, 'packaging/npm/install.mjs'), join(packageDir, 'install.mjs'));
await copyFile(join(root, 'packaging/npm/README.md'), join(packageDir, 'README.md'));
await copyFile(join(root, 'LICENSE'), join(packageDir, 'LICENSE'));
await writeFile(join(packageDir, 'assets.json'), JSON.stringify({ version, assets }, null, 2) + '\n');
await writeFile(join(packageDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(packageDir);
