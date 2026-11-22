import type { AppUpdateInfo } from '@mingle/contracts';

const registry = 'https://registry.npmjs.org/@mingledev%2fmingle/latest';
const packageName = '@mingledev/mingle';
const release = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;

async function fetchLatestVersion(request: typeof fetch): Promise<string> {
  const response = await request(registry, { signal: AbortSignal.timeout(4000), redirect: 'error', headers: { accept: 'application/json' } });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('npm release metadata is unavailable');
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 64 * 1024) {
      await reader.cancel();
      throw new Error('npm release metadata exceeds the size limit');
    }
    parts.push(value);
  }
  const metadata = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (metadata?.name !== packageName || typeof metadata.version !== 'string' || !release.test(metadata.version)) {
    throw new Error('npm has not reported a stable Mingle release');
  }
  return metadata.version;
}

function compareStableVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}

export function createAppUpdateCheck(installedVersion: string, request: typeof fetch = fetch, now = Date.now) {
  let cached: AppUpdateInfo | undefined;
  let inflight: Promise<AppUpdateInfo> | undefined;

  return (refresh = false): Promise<AppUpdateInfo> => {
    if (inflight) return inflight;
    const cacheMs = refresh ? 30_000 : cached?.status === 'unavailable' ? 60_000 : 10 * 60_000;
    if (cached) {
      const age = now() - Date.parse(cached.checkedAt);
      if (age >= 0 && age < cacheMs) return Promise.resolve(cached);
    }
    inflight = (async () => {
      const latestVersion = await fetchLatestVersion(request).catch(() => null);
      const status = !latestVersion || !release.test(installedVersion) ? 'unavailable'
        : compareStableVersions(latestVersion, installedVersion) > 0 ? 'available' : 'current';
      cached = { installedVersion, latestVersion, status, checkedAt: new Date(now()).toISOString() };
      return cached;
    })().finally(() => { inflight = undefined; });
    return inflight;
  };
}
