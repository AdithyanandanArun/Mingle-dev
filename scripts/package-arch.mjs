import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Arch packages currently support Linux x86-64 only.');
if (process.getuid?.() === 0) throw new Error('makepkg must run as an ordinary user, not root.');
const { version } = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Arch release packaging currently requires a stable x.y.z version.');
const release = join(root, 'release');
const archiveName = `mingle-${version}-linux-x64.tar.gz`;
const archive = join(release, archiveName);
const digest = createHash('sha256');
for await (const chunk of createReadStream(archive)) digest.update(chunk);
const checksum = digest.digest('hex');
const checksumRecord = (await readFile(`${archive}.sha256`, 'utf8')).trim();
if (checksumRecord !== `${checksum}  ${archiveName}`) throw new Error('Linux archive checksum sidecar does not match the Arch packaging source.');
const build = join(release, 'arch-build');
await rm(build, { recursive: true, force: true });
await mkdir(build, { recursive: true });
await copyFile(archive, join(build, archiveName));
const template = await readFile(join(root, 'packaging/arch/PKGBUILD'), 'utf8');
if (!/^pkgver=.*$/m.test(template) || !/^sha256sums=.*$/m.test(template)) throw new Error('Arch recipe is missing its version or checksum field.');
const recipe = template.replace(/^pkgver=.*$/m, `pkgver=${version}`).replace(/^sha256sums=.*$/m, `sha256sums=('${checksum}')`);
await writeFile(join(build, 'PKGBUILD'), recipe);
// Only package already-built files. Runtime dependencies are recorded, without installing anything on the builder.
await writeFile(join(build, 'makepkg.conf'), 'source /etc/makepkg.conf\nPKGEXT=".pkg.tar.zst"\nCOMPRESSZST=(zstd -c -T2 -6 -)\n');
await new Promise((resolvePromise, reject) => {
  const child = spawn('makepkg', ['--config', join(build, 'makepkg.conf'), '--nodeps', '--noconfirm', '--force'], {
    cwd: build, stdio: 'inherit', env: { ...process.env, PKGDEST: release },
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`makepkg failed (${signal ?? code}). Run this step on Arch Linux with base-devel installed.`)));
});
const name = (await readdir(release)).find((entry) => entry === `mingle-bin-${version}-1-x86_64.pkg.tar.zst`);
if (!name) throw new Error('makepkg completed without the expected Arch artifact.');
const pkgHash = createHash('sha256');
for await (const chunk of createReadStream(join(release, name))) pkgHash.update(chunk);
await writeFile(join(release, `${name}.sha256`), `${pkgHash.digest('hex')}  ${name}\n`);
console.log(`Arch package: ${join(release, name)}\nInstall explicitly with: sudo pacman -U ${join(release, name)}`);
