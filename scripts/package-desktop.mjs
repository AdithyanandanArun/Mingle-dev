import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, cp, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'));
const serverPackage = JSON.parse(await readFile(join(root, 'apps/server/package.json'), 'utf8'));
if (pkg.version !== serverPackage.version) throw new Error('Desktop and server versions must match before packaging.');
const runtime = JSON.parse(await readFile(join(root, 'packaging/node-runtime.json'), 'utf8'));
const target = `${process.platform}-${process.arch}`;
if (!['linux-x64', 'win32-x64'].includes(target)) throw new Error(`Desktop release packaging does not support ${target}.`);
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Desktop version must be a semantic version.');
if (!runtime[target]?.url || !runtime[target]?.sha256) throw new Error(`Pinned Node runtime metadata is missing for ${target}.`);
const name = `mingle-${pkg.version}-${target}`;
const release = join(root, 'release');
const stage = join(release, name);
const cache = join(release, '.cache/node');
// Node's official Windows archives use "win", while process.platform is "win32".
const nodeTarget = target === 'win32-x64' ? 'win-x64' : target;
const nodeArchive = join(cache, `node-v${runtime.version}-${nodeTarget}.${target === 'win32-x64' ? 'zip' : 'tar.xz'}`);
const nodeDir = join(cache, `node-v${runtime.version}-${nodeTarget}`);
const artifact = join(release, `${name}.tar.gz`);

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}
async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function present(path) { try { await access(path); return true; } catch { return false; } }

async function runPnpm(args, options = {}) {
  const cli = process.env.npm_execpath;
  if (cli && /\.(?:c?js|mjs)$/i.test(cli) && await present(cli)) return run(process.execPath, [cli, ...args], options);
  if (process.platform === 'win32') throw new Error('Run Windows packaging through pnpm so npm_execpath can invoke pnpm without a shell.');
  return run('pnpm', args, options);
}

await access(join(root, 'apps/web/dist/index.html'));
await mkdir(cache, { recursive: true });
if (!(await present(nodeArchive))) {
  console.log(`Downloading pinned Node ${runtime.version} runtime…`);
  const response = await fetch(runtime[target].url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
  const temporary = `${nodeArchive}.partial`;
  await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
  if (await hash(temporary) !== runtime[target].sha256) { await rm(temporary); throw new Error('Node archive checksum mismatch.'); }
  await rename(temporary, nodeArchive);
}
if (await hash(nodeArchive) !== runtime[target].sha256) throw new Error('Cached Node archive checksum mismatch. Remove release/.cache/node and retry.');
await rm(nodeDir, { recursive: true, force: true });
await run('tar', [target === 'win32-x64' ? '-xf' : '-xJf', nodeArchive, '-C', cache]);
const node = target === 'win32-x64' ? join(nodeDir, 'node.exe') : join(nodeDir, 'bin/node');
await access(node);
const environment = { ...process.env, PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ''}`, NODE_ENV: 'production' };
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;
delete environment.ELECTRON_RUN_AS_NODE;

console.log(`Staging Mingle ${pkg.version} for ${target}…`);
await rm(stage, { recursive: true, force: true });
const electron = require('electron');
await cp(dirname(electron), stage, { recursive: true, dereference: true });
await rename(join(stage, target === 'win32-x64' ? 'electron.exe' : 'electron'), join(stage, target === 'win32-x64' ? 'mingle.exe' : 'mingle'));
await rm(join(stage, 'resources/default_app.asar'), { force: true });
const appDir = join(stage, 'resources/app');
await mkdir(appDir, { recursive: true });
await copyFile(join(root, 'apps/desktop/main.mjs'), join(appDir, 'main.mjs'));
await copyFile(join(root, 'apps/desktop/shell-environment.mjs'), join(appDir, 'shell-environment.mjs'));
await copyFile(join(root, 'apps/desktop/browser-preload.cjs'), join(appDir, 'browser-preload.cjs'));
await copyFile(join(root, 'apps/desktop/project-invitation.mjs'), join(appDir, 'project-invitation.mjs'));
await cp(join(root, 'apps/desktop/embedded-browser'), join(appDir, 'embedded-browser'), { recursive: true, filter: source => !source.endsWith('.test.mjs') && !source.endsWith('/smoke.mjs') });
await cp(join(root, 'apps/desktop/account-storage'), join(appDir, 'account-storage'), {
  recursive: true, filter: source => !source.endsWith('.test.mjs'),
});
await writeFile(join(appDir, 'package.json'), JSON.stringify({
  name: 'mingle', productName: 'Mingle', version: pkg.version, license: pkg.license, type: 'module', main: 'main.mjs',
}, null, 2) + '\n');
const workspace = join(stage, 'resources/workspace');
const server = join(workspace, 'apps/server');
await mkdir(dirname(server), { recursive: true });
// Deploy from an isolated copy so pnpm's production metadata never changes the developer checkout.
const deployWorkspace = join(release, '.deploy-workspace');
await rm(deployWorkspace, { recursive: true, force: true });
await mkdir(deployWorkspace, { recursive: true });
for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) await copyFile(join(root, file), join(deployWorkspace, file));
for (const project of ['apps/server', 'apps/web', 'apps/desktop', 'packages/contracts']) {
  await mkdir(join(deployWorkspace, project), { recursive: true });
  await copyFile(join(root, project, 'package.json'), join(deployWorkspace, project, 'package.json'));
}
for (const project of ['apps/server', 'packages/contracts']) await cp(join(root, project, 'src'), join(deployWorkspace, project, 'src'), { recursive: true });
try {
  // No source-workspace install is needed: deploy installs the selected production graph directly.
  // A conventional node_modules tree keeps installed Windows paths below the
  // limits of NSIS and Windows DLL loaders, without changing package versions.
  const linker = target === 'win32-x64' ? ['--config.node-linker=hoisted'] : [];
  await runPnpm(['--config.verify-deps-before-run=false', ...linker, '--dir', deployWorkspace, '--filter', '@mingle/server', 'deploy', '--legacy', '--prod', server], { env: environment });
} finally { await rm(deployWorkspace, { recursive: true, force: true }); }
// Mingle uses separately installed provider CLIs. Do not redistribute the optional native Claude CLI.
const virtualStore = join(server, 'node_modules/.pnpm');
// pnpm shortens long Windows store folder names with a hash. Inspect package names
// inside the store instead of assuming the store folder retains the full name.
async function removeNativeCliPackages(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (/^claude-agent-sdk-(?:linux|darwin|win32)-/.test(entry.name)) {
      await rm(path, { recursive: true, force: true });
    } else if (entry.isDirectory() && !entry.isSymbolicLink()) await removeNativeCliPackages(path);
  }
}
await removeNativeCliPackages(join(server, 'node_modules'));
// Legacy deploy hoists a package self-reference. It is unnecessary at runtime and can make
// recursive installers follow a directory link back to the server root.
await rm(join(virtualStore, 'node_modules/@mingle/server'), { recursive: true, force: true });
await rm(join(server, 'node_modules/@mingle/server'), { recursive: true, force: true });
// Remove dependency symlinks to the excluded optional CLI, retaining all JS SDK dependencies.
const serverRoot = resolve(server);
const pathIsWithin = (parent, candidate) => {
  const fromParent = relative(parent, candidate);
  return fromParent === '' || (fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent));
};
async function removeBrokenLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      // Windows access() can succeed on a dangling junction; realpath is the check.
      const resolved = await realpath(path).catch(error => { throw new Error(`Broken runtime dependency link: ${path}`, { cause: error }); });
      if (!pathIsWithin(serverRoot, resolved)) throw new Error(`Runtime dependency escapes the release directory: ${path}`);
      if (pathIsWithin(resolved, path)) throw new Error(`Recursive runtime dependency link is not safe to package: ${path}`);
    } else if (entry.isDirectory()) await removeBrokenLinks(path);
  }
}
await removeBrokenLinks(join(server, 'node_modules'));
// Installer bookkeeping and command shims are not runtime inputs and may contain builder paths.
for (const file of ['node_modules/.modules.yaml', 'node_modules/.pnpm-workspace-state-v1.json', 'node_modules/.pnpm/lock.yaml', 'node_modules/.bin', 'node_modules/.pnpm/node_modules/.bin']) {
  await rm(join(server, file), { recursive: true, force: true });
}
// Bundle our TypeScript and shared contracts; native modules and the provider SDK remain external.
await build({
  entryPoints: [join(root, 'apps/server/src/index.ts')], outfile: join(server, 'dist/index.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node26', packages: 'external',
  alias: { '@mingle/contracts': join(root, 'packages/contracts/src/index.ts') },
  logLevel: 'info',
});
await rm(join(server, 'src'), { recursive: true, force: true });
await rm(join(server, 'tsconfig.json'), { force: true });
await cp(join(root, 'apps/web/dist'), join(workspace, 'apps/web/dist'), { recursive: true });
const stagedNode = join(stage, 'resources/runtime/bin', target === 'win32-x64' ? 'node.exe' : 'node');
await mkdir(dirname(stagedNode), { recursive: true });
await copyFile(node, stagedNode);
if (target !== 'win32-x64') await chmod(stagedNode, 0o755);
await copyFile(join(root, 'apps/web/public/mingle.svg'), join(stage, 'mingle.svg'));
if (target === 'linux-x64') {
  await writeFile(join(stage, 'mingle.desktop'), `[Desktop Entry]\nType=Application\nName=Mingle\nComment=Local workspace for independent coding-agent sessions\nExec=mingle %u\nIcon=mingle\nTerminal=false\nCategories=Development;IDE;\nMimeType=x-scheme-handler/mingle;\nStartupWMClass=mingle\n`);
}

const licenses = join(stage, 'resources/licenses');
await mkdir(licenses, { recursive: true });
await copyFile(join(root, 'LICENSE'), join(licenses, 'Mingle-LICENSE'));
await copyFile(join(nodeDir, 'LICENSE'), join(licenses, 'Node-LICENSE'));
await copyFile(join(stage, 'LICENSE'), join(licenses, 'Electron-LICENSE'));
await writeFile(join(licenses, 'Mingle-NOTICE'), 'Mingle source: https://github.com/AdithyanandanArun/Mingle-dev\nMingle is licensed under the MIT License; see Mingle-LICENSE in this directory.\nThird-party components retain their own licenses, reproduced alongside their packages and in this directory.\n');
const inventory = [];
const inventoried = new Set();
async function inventoryPackage(packageDir) {
  const info = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  const key = `${info.name}@${info.version}`;
  if (inventoried.has(key)) return;
  inventoried.add(key);
  const destination = join(licenses, key.replaceAll('/', '+'));
  const files = (await readdir(packageDir)).filter((file) => /^(licen[cs]e|notice|copying|thirdpartynotices)(\.|$)/i.test(file));
  await mkdir(destination, { recursive: true });
  for (const file of files) await cp(join(packageDir, file), join(destination, file), { recursive: true });
  inventory.push({ name: info.name, version: info.version, license: info.license ?? 'unspecified', files });
}
// Preserve notices for deployed backend dependencies.
for (const versioned of target === 'linux-x64' ? await readdir(virtualStore) : []) {
  const modules = join(virtualStore, versioned, 'node_modules');
  if (!(await present(modules))) continue;
  const names = [];
  for (const entry of await readdir(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('@') && entry.isDirectory()) for (const child of await readdir(join(modules, entry.name))) names.push(`${entry.name}/${child}`);
    else names.push(entry.name);
  }
  for (const entry of names) {
    const packageDir = join(modules, entry);
    try {
      if (!pathIsWithin(resolve(packageDir), await realpath(packageDir))) continue;
      await inventoryPackage(packageDir);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
if (target === 'win32-x64') {
  async function inventoryModules(directory) {
    if (!(await present(directory))) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith('@')) {
        for (const name of await readdir(path)) await inventoryHoistedPackage(join(path, name));
      } else await inventoryHoistedPackage(path);
    }
  }
  async function inventoryHoistedPackage(directory) {
    if (!(await present(join(directory, 'package.json')))) return;
    await inventoryPackage(directory);
    await inventoryModules(join(directory, 'node_modules'));
  }
  await inventoryModules(join(server, 'node_modules'));
}
// The UI bundles its dependency code, so its notices must accompany the binary too.
const visitedFrontend = new Set();
async function resolveDependency(from, name) {
  for (let current = from; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name);
    if (await present(join(candidate, 'package.json'))) return realpath(candidate);
    if (current === dirname(current)) return null;
  }
}
async function frontendLicenses(packageDir, includePackage = true) {
  const resolved = await realpath(packageDir);
  if (visitedFrontend.has(resolved)) return;
  visitedFrontend.add(resolved);
  if (includePackage) await inventoryPackage(resolved);
  const info = JSON.parse(await readFile(join(resolved, 'package.json'), 'utf8'));
  for (const [name, optional] of [
    ...Object.keys(info.dependencies ?? {}).map((name) => [name, false]),
    ...Object.keys(info.optionalDependencies ?? {}).map((name) => [name, true]),
  ]) {
    const dependency = await resolveDependency(resolved, name);
    if (dependency) await frontendLicenses(dependency);
    else if (!optional) throw new Error(`Missing frontend dependency for license inventory: ${name}`);
  }
}
await frontendLicenses(join(root, 'apps/web'), false);
await writeFile(join(licenses, 'dependencies.json'), JSON.stringify(inventory.sort((a, b) => a.name.localeCompare(b.name)), null, 2) + '\n');
await writeFile(join(stage, 'resources/build-info.json'), JSON.stringify({ version: pkg.version, target, node: runtime.version, nodeArchiveSha256: runtime[target].sha256, electron: JSON.parse(await readFile(require.resolve('electron/package.json'), 'utf8')).version }, null, 2) + '\n');
if (target === 'linux-x64') {
  // Stable metadata keeps archive ordering, owners and timestamps independent of the build machine.
  const epoch = process.env.SOURCE_DATE_EPOCH ?? '0';
  if (!/^\d+$/.test(epoch)) throw new Error('SOURCE_DATE_EPOCH must be a nonnegative integer.');
  await run('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '-czf', artifact, '-C', release, name]);
  const checksum = await hash(artifact);
  await writeFile(`${artifact}.sha256`, `${checksum}  ${name}.tar.gz\n`);
  console.log(`Desktop archive: ${artifact}\nSHA256: ${checksum}`);
} else {
  console.log(`Windows app payload staged at ${stage}`);
}
