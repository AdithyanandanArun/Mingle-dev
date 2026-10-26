import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { verifyGitRepositoryDetection } from './git-repository-smoke.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = join(root, 'release');
const desktopPackage = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'));
const serverPackage = JSON.parse(await readFile(join(root, 'apps/server/package.json'), 'utf8'));
if (desktopPackage.version !== serverPackage.version) throw new Error('Desktop and server versions must match before packaging.');
if (!/^\d+\.\d+\.\d+$/.test(desktopPackage.version)) throw new Error('Windows installers require a stable x.y.z version.');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build Windows installers on a native Windows x64 runner.');

const version = desktopPackage.version;
const target = 'win32-x64';
const stageName = `mingle-${version}-${target}`;
const stage = join(release, stageName);
const installer = join(release, `${stageName}-setup.exe`);
const installerScript = join(root, 'packaging/windows/installer.nsi');
const runtimeNode = join(stage, 'resources/runtime/bin/node.exe');
const serverRoot = join(stage, 'resources/workspace/apps/server');
const webRoot = join(stage, 'resources/workspace/apps/web/dist');

async function present(path) { try { await access(path); return true; } catch { return false; } }

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', timeout: 15 * 60_000, ...options, shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} failed (${signal ?? code}): ${stderr.trim()}`)));
  });
}

async function sha256(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function findMakensis() {
  const candidates = [
    process.env.MAKENSIS,
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'NSIS/makensis.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'NSIS/makensis.exe'),
    'C:\\tools\\NSIS\\makensis.exe',
  ].filter(Boolean);
  for (const candidate of candidates) if (await present(candidate)) return candidate;
  try {
    const result = await runCapture('where.exe', ['makensis.exe']);
    const path = result.split(/\r?\n/).find(Boolean);
    if (path) return path;
  } catch { /* report the actionable setup failure below */ }
  throw new Error('NSIS makensis.exe was not found. Install NSIS 3.11 (the workflow does this with Chocolatey).');
}

function makensisArgs(outputPath, extraDefines = {}) {
  return [
    '/V2',
    `/DAPP_VERSION=${version}`,
    `/DSTAGE=${stage}`,
    `/DOUTPUT=${outputPath}`,
    ...Object.entries(extraDefines).map(([key, value]) => `/D${key}=${value}`),
    installerScript,
  ];
}

async function smokeRuntime(smokeRoot) {
  const dataDir = join(smokeRoot, 'runtime-data');
  await mkdir(dataDir, { recursive: true });
  if (!(await present(runtimeNode)) || !(await present(join(serverRoot, 'dist/index.mjs'))) || !(await present(join(webRoot, 'index.html')))) {
    throw new Error('Windows desktop staging is incomplete. Run the shared native staging step before packaging.');
  }
  const buildInfo = JSON.parse(await readFile(join(stage, 'resources/build-info.json'), 'utf8'));
  if (buildInfo.target !== target || buildInfo.node !== '26.8.2') throw new Error('Staged build metadata does not match the Windows x64 Node runtime.');

  const environment = { ...process.env, NODE_ENV: 'production', MINGLE_HOST: '127.0.0.1', MINGLE_PORT: '0', MINGLE_DATA_DIR: dataDir, MINGLE_WEB_DIST: webRoot, MINGLE_ALLOWED_ORIGINS: '' };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.PATH = [dirname(runtimeNode), process.env.PATH ?? ''].join(';');
  const child = spawn(runtimeNode, [join(serverRoot, 'dist/index.mjs')], { cwd: dataDir, env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, shell: false });
  let logs = '';
  const append = (chunk) => { logs = `${logs}${chunk}`.slice(-12_000); };
  child.stdout.setEncoding('utf8').on('data', append);
  child.stderr.setEncoding('utf8').on('data', append);
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let baseUrl;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Staged Node server exited before health check (${child.exitCode}). ${logs}`);
      const match = logs.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { baseUrl = match[1]; break; }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!baseUrl) throw new Error(`Staged Node server did not report its listen address. ${logs}`);

    const healthResponse = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
    if (!healthResponse.ok) throw new Error(`Staged server health returned HTTP ${healthResponse.status}.`);
    const health = await healthResponse.json();
    if (!health.database?.ok || !health.web?.served || health.node !== 'v26.8.2') throw new Error(`Unexpected staged health payload: ${JSON.stringify(health)}`);
    const uiResponse = await fetch(baseUrl, { signal: AbortSignal.timeout(10_000) });
    const ui = await uiResponse.text();
    if (!uiResponse.ok || !ui.includes('<div id="root"')) throw new Error(`Staged static UI check failed (HTTP ${uiResponse.status}).`);
    const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`, { signal: AbortSignal.timeout(15_000) });
    if (!bootstrapResponse.ok) throw new Error(`Staged bootstrap returned HTTP ${bootstrapResponse.status}.`);
    const bootstrap = await bootstrapResponse.json();
    if (!Array.isArray(bootstrap.projects) || !Array.isArray(bootstrap.sessions)) throw new Error('Staged bootstrap omitted the project/session collections.');

    await verifyGitRepositoryDetection(baseUrl, join(smokeRoot, 'git-repository-check'));

    // Keep native ConPTY cleanup handles out of the packaging process. The probe
    // exits only after its real command has exited and its output is verified.
    const ptyProbe = join(smokeRoot, 'pty-check.cjs');
    await writeFile(ptyProbe, `
const { createRequire } = require('node:module');
const requireFromServer = createRequire(${JSON.stringify(join(serverRoot, 'package.json'))});
const pty = requireFromServer('node-pty');
const terminal = pty.spawn(process.env.COMSPEC || 'cmd.exe', ['/d', '/c', 'echo', 'MINGLE_PTY_SMOKE'], {
  cwd: ${JSON.stringify(dataDir)}, cols: 80, rows: 24, env: process.env,
});
let output = '';
const timer = setTimeout(() => { terminal.kill(); console.error('ConPTY probe timed out'); process.exit(1); }, 15000);
terminal.onData(data => output += data);
terminal.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (exitCode !== 0 || !output.includes('MINGLE_PTY_SMOKE')) {
    console.error('ConPTY command failed:', exitCode, output); process.exit(1);
  }
  // node-pty can retain native Windows handles after this event. This process
  // owns only the completed probe, so close it explicitly after verification.
  process.exit(0);
});
`);
    await run(runtimeNode, [ptyProbe], { env: environment, cwd: dataDir, windowsHide: true, timeout: 20_000 });
    console.log('Windows runtime smoke passed: Node, SQLite health, bootstrap, static UI, and node-pty.');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const graceful = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]);
      if (!graceful && child.exitCode === null) child.kill();
      await exited;
    }
  }
}

async function smokeInstaller(makensis, smokeRoot) {
  await mkdir(smokeRoot, { recursive: true });
  const installDir = join(smokeRoot, 'installed-app');
  const testInstaller = join(smokeRoot, 'installer-smoke.exe');
  const userData = join(smokeRoot, 'user-data');
  const preservedData = join(userData, 'workspace', 'relay.sqlite');
  await mkdir(dirname(preservedData), { recursive: true });
  await writeFile(preservedData, 'Mingle installer smoke user data must survive uninstall.\n');

  // Compile the same installer script with an isolated destination, then verify the actual
  // uninstaller removes only the app directory and leaves the independent user-data sentinel.
  const defines = { INSTALL_DIR: installDir, EXPECTED_INSTALL_DIR: installDir };
  await run(makensis, makensisArgs(testInstaller, defines));
  console.log('Testing isolated silent Windows installation...');
  await run(testInstaller, ['/S', `/D=${installDir}`], { windowsHide: true, timeout: 120_000 });
  for (const payload of ['mingle.exe', 'Uninstall.exe', 'resources/runtime/bin/node.exe', 'resources/workspace/apps/server/dist/index.mjs']) {
    if (!(await present(join(installDir, payload)))) throw new Error(`Fresh silent install omitted ${payload}.`);
  }
  await run(process.execPath, [join(root, 'scripts/smoke-desktop.mjs'), join(installDir, 'mingle.exe')], { windowsHide: true });
  // _?= suppresses NSIS's temp-copy handoff, so this call returns only after uninstall completes.
  await run(join(installDir, 'Uninstall.exe'), ['/S', `_?=${installDir}`], { windowsHide: true, timeout: 60_000 });
  if (await present(join(installDir, 'mingle.exe'))) throw new Error('Silent uninstall left the application executable behind.');
  if ((await readFile(preservedData, 'utf8')) !== 'Mingle installer smoke user data must survive uninstall.\n') throw new Error('Silent uninstall changed the isolated user-data sentinel.');
  console.log('Windows installer smoke passed: isolated silent install/uninstall preserved user data.');
}

const makensis = await findMakensis();
const lstatStage = await lstat(stage).catch(() => null);
if (!lstatStage?.isDirectory()) throw new Error(`Missing staged payload ${stage}. Run the shared package-desktop step first.`);
if (await present(join(stage, 'resources/workspace/apps/server/node_modules/.pnpm/node_modules/@mingle/server'))) {
  throw new Error('Staged pnpm self-reference was not removed; NSIS must not recurse through it.');
}

// NSIS normalizes 8.3 aliases; use the canonical temp root for both path guards.
const smokeRoot = await mkdtemp(join(await realpath(tmpdir()), 'mp-'));
try {
  await smokeRuntime(smokeRoot);
  await run(makensis, makensisArgs(installer));
  if (!(await present(installer))) throw new Error('NSIS returned success without creating the installer executable.');
  await smokeInstaller(makensis, smokeRoot);
  const checksum = await sha256(installer);
  await writeFile(`${installer}.sha256`, `${checksum}  ${stageName}-setup.exe\n`);
  console.log(`Unsigned Windows installer: ${installer}\nSHA256: ${checksum}`);
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}
