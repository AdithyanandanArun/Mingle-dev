import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Debian packaging requires Linux x86-64.');
const { version } = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Debian packaging requires a stable x.y.z version.');
const probe = spawnSync('dpkg-deb', ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) throw new Error('dpkg-deb is required. Build on Debian/Ubuntu or use the desktop packages workflow.');
const release = join(root, 'release');
const stage = join(release, `mingle-${version}-linux-x64`);
const info = JSON.parse(await readFile(join(stage, 'resources/build-info.json'), 'utf8'));
if (info.version !== version || info.target !== 'linux-x64') throw new Error('Build the matching Linux desktop stage first.');
const tree = join(release, 'deb-build');
await rm(tree, { recursive: true, force: true });
for (const dir of ['DEBIAN', 'opt', 'usr/bin', 'usr/share/applications', 'usr/share/icons/hicolor/scalable/apps', 'usr/share/doc/mingle']) {
  await mkdir(join(tree, dir), { recursive: true });
}
await cp(stage, join(tree, 'opt/mingle'), { recursive: true, verbatimSymlinks: true });
await chmod(join(tree, 'opt/mingle/chrome-sandbox'), 0o4755);
await copyFile(join(root, 'packaging/linux-launcher.sh'), join(tree, 'usr/bin/mingle'));
await chmod(join(tree, 'usr/bin/mingle'), 0o755);
await copyFile(join(stage, 'mingle.desktop'), join(tree, 'usr/share/applications/mingle.desktop'));
await copyFile(join(stage, 'mingle.svg'), join(tree, 'usr/share/icons/hicolor/scalable/apps/mingle.svg'));
await cp(join(stage, 'resources/licenses'), join(tree, 'usr/share/doc/mingle/licenses'), { recursive: true });
const size = spawnSync('du', ['-sk', join(tree, 'opt'), join(tree, 'usr')], { encoding: 'utf8' });
if (size.status !== 0) throw new Error(size.stderr || 'Cannot calculate installed size.');
const installedSize = size.stdout.trim().split('\n').reduce((sum, line) => sum + Number(line.split(/\s+/)[0]), 0);
await writeFile(join(tree, 'DEBIAN/control'), `Package: mingle
Version: ${version}
Architecture: amd64
Section: devel
Priority: optional
Maintainer: Mingle maintainers <noreply@github.com>
Homepage: https://github.com/AdithyanandanArun/Mingle-dev
Installed-Size: ${installedSize}
Depends: git, libc6 (>= 2.35), libgcc-s1, libstdc++6, libatomic1, libasound2 | libasound2t64, libatk1.0-0 | libatk1.0-0t64, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libatspi2.0-0 | libatspi2.0-0t64, libcairo2, libcups2 | libcups2t64, libdbus-1-3, libdrm2, libexpat1, libgbm1, libglib2.0-0 | libglib2.0-0t64, libgtk-3-0 | libgtk-3-0t64, libnspr4, libnss3, libpango-1.0-0, libudev1, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxkbcommon0, libxrandr2, xdg-utils
Description: Local development workspace for independent coding-agent sessions
 Mingle includes its desktop shell, Node runtime and local workspace server.
 Provider command-line tools and their logins are installed separately.
`);
// dpkg owns every installed file. No maintainer script touches user profiles.
const name = `mingle_${version}_amd64.deb`;
const result = spawnSync('dpkg-deb', ['--root-owner-group', '-Zxz', '-z6', '--build', tree, join(release, name)], { stdio: 'inherit' });
if (result.error || result.status !== 0) throw result.error ?? new Error('dpkg-deb failed.');
const hash = createHash('sha256');
for await (const chunk of createReadStream(join(release, name))) hash.update(chunk);
await writeFile(join(release, `${name}.sha256`), `${hash.digest('hex')}  ${name}\n`);
console.log(`Debian package: ${join(release, name)}`);
