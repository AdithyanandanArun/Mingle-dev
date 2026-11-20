import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const command = promisify(execFile);
function applyPackage(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/pkexec', args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(Object.assign(new Error('Package installation failed.'), { code })));
  });
}
const versionPattern = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;
const policies = {
  'arch-x64': {
    probe: ['/usr/bin/pacman', '-Q', 'mingle-bin'],
    install: ['/usr/bin/pacman', '-U', '--noconfirm'],
    name: version => `mingle-bin-${version}-1-x86_64.pkg.tar.zst`,
  },
  'deb-x64': {
    probe: ['/usr/bin/dpkg-query', '-W', '-f=${Status}', 'mingle'],
    install: ['/usr/bin/apt-get', 'install', '-y'],
    name: version => `mingle_${version}_amd64.deb`,
    installed: 'install ok installed',
  },
};

async function releaseAsset(version, name, request) {
  const response = await request(`https://api.github.com/repos/AdithyanandanArun/Mingle-dev/releases/tags/v${version}`, {
    signal: AbortSignal.timeout(8000), redirect: 'error', headers: { accept: 'application/vnd.github+json', 'user-agent': 'Mingle Desktop' },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Could not read the Mingle release on GitHub.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 256 * 1024) { await reader.cancel(); throw new Error('The release metadata is too large.'); }
    chunks.push(value);
  }
  const release = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const asset = Array.isArray(release?.assets) ? release.assets.find(item => item?.name === name) : null;
  if (release?.tag_name !== `v${version}` || release.draft !== false || release.prerelease !== false
    || asset?.state !== 'uploaded' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
    || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 1024 ** 3) {
    throw new Error('A verified installer is unavailable for this release.');
  }
  return { name, size: asset.size, sha256: asset.digest.slice(7) };
}

/** Privileged installation is limited to an existing system installation and fixed package-manager arguments. */
export function createDesktopAppUpdate({ app, installer, resourcesPath, workspace, execute = command, apply = applyPackage, request = fetch,
  platform = process.platform, arch = process.arch, executable = process.execPath, read = readFile, canAccess = access }) {
  const running = app.getVersion();
  const readInstalled = async () => {
    if (!app.isPackaged) return null;
    try {
      const { version } = JSON.parse(await read(join(resourcesPath, 'app/package.json'), 'utf8'));
      return typeof version === 'string' && versionPattern.test(version) ? version : null;
    } catch { return null; }
  };
  const detectPolicy = async () => {
    if (!app.isPackaged || platform !== 'linux' || resolve(executable) !== '/opt/mingle/mingle') return null;
    try {
      const target = installer.installerTarget(platform, arch, await read('/etc/os-release', 'utf8'));
      const policy = policies[target];
      await canAccess('/usr/bin/pkexec');
      const [program, ...args] = policy.probe;
      const { stdout } = await execute(program, args, { timeout: 2000 });
      return !policy.installed || stdout.trim() === policy.installed ? policy : null;
    } catch { return null; }
  };
  let phase = 'idle';
  let policyCheck;
  const policy = () => policyCheck ??= detectPolicy();
  const state = async () => {
    const [installed, supported] = await Promise.all([readInstalled(), policy()]);
    return { canInstall: Boolean(supported), restartVersion: phase === 'idle' && installed && installed !== running ? installed : null, phase };
  };

  const install = async (version) => {
    if (phase !== 'idle') throw new Error('An update is already in progress.');
    if (typeof version !== 'string' || !versionPattern.test(version)) throw new Error('Invalid Mingle release version.');
    phase = 'downloading';
    let directory;
    try {
      const installation = await policy();
      if (!installation) throw new Error('Use the native installer for this Mingle installation.');
      if (await readInstalled() !== running) throw new Error('Restart Mingle before installing another update.');
      const origin = workspace();
      if (!origin) throw new Error('Mingle update service is unavailable.');
      const response = await request(new URL('/api/app-update?refresh=1', origin), { signal: AbortSignal.timeout(5000), redirect: 'error' });
      const info = response.ok ? await response.json() : null;
      if (info?.status !== 'available' || info.installedVersion !== running || info.latestVersion !== version) {
        throw new Error('The available version changed. Check for updates before retrying.');
      }
      const asset = await releaseAsset(version, installation.name(version), request);
      directory = await mkdtemp(join(tmpdir(), 'mingle-update-'));
      const path = join(directory, asset.name);
      await installer.downloadInstaller(version, asset, path, request);
      phase = 'installing';
      try { await apply([...installation.install, path]); }
      catch (cause) {
        if (cause?.code === 126) throw new Error('Installation authorization was cancelled.');
        throw new Error('The system package manager could not install Mingle.');
      }
      if (await readInstalled() !== version) throw new Error('The package manager did not report the expected installed version.');
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      phase = 'idle';
    }
    return state();
  };

  return { state, install };
}
