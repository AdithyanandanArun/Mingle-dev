import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SystemBrowser } from '@mingle/contracts';

export interface BrowserFs { access(p: string): Promise<void>; readFile(p: string): Promise<string>; realpath(p: string): Promise<string>; stat(p: string): Promise<{ uid?: number; mode: number }>; readdir(p:string):Promise<string[]> }
const nativeFs: BrowserFs = { access: async (p) => { await stat(p); }, readFile: async (p) => String(await readFile(p, 'utf8')), realpath, stat, readdir: async p => (await import('node:fs/promises')).readdir(p) };
const candidates: [string,string][] = [
  ['/opt/google/chrome/chrome', 'Google Chrome'], ['/opt/google/chrome-beta/chrome', 'Google Chrome Beta'], ['/usr/bin/chromium', 'Chromium'],
  ['/usr/lib/chromium/chromium', 'Chromium'], ['/usr/bin/chromium-browser', 'Chromium'], ['/opt/brave.com/brave/brave', 'Brave'],
  ['/opt/microsoft/msedge/msedge', 'Microsoft Edge'], ['/opt/vivaldi/vivaldi-bin', 'Vivaldi'],
];
export async function discoverSystemBrowsers(opts: { platform?: NodeJS.Platform; restricted?: boolean; fs?: BrowserFs } = {}): Promise<SystemBrowser[]> {
  const platform = opts.platform ?? process.platform, fs = opts.fs ?? nativeFs;
  let paths: [string,string][] = [];
  if (platform === 'linux') paths = candidates;
  else if (platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const root of roots) for (const [rel,name] of [['Google/Chrome/Application/chrome.exe','Google Chrome'],['Microsoft/Edge/Application/msedge.exe','Microsoft Edge'],['BraveSoftware/Brave-Browser/Application/brave.exe','Brave']] as [string,string][]) paths.push([path.join(root,rel),name]);
  } else if (platform === 'darwin') paths = [['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','Google Chrome'],['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','Microsoft Edge'],['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser','Brave'],['/Applications/Chromium.app/Contents/MacOS/Chromium','Chromium']];
  const result: SystemBrowser[] = [];
  for (const [candidate,name] of paths) {
    try {
      const executable = await fs.realpath(candidate);
      const contents = platform === 'linux' && candidate.endsWith('chromium-browser') ? await fs.readFile(candidate).catch(()=>'') : '';
      if (platform === 'linux' && (executable.startsWith('/snap/') || contents.includes('snap'))) continue;
      const sandboxReady = platform !== 'linux' || !opts.restricted || await linuxReady(executable, fs);
      result.push({ id: executable, name, executable, sandboxReady });
    } catch { /* absent */ }
  }
  return result;
}
async function linuxReady(exe: string, fs: BrowserFs): Promise<boolean> {
  try { const entries = await fs.readdir('/etc/apparmor.d'); for (const e of entries) if ((await fs.readFile(path.join('/etc/apparmor.d',e)).catch(()=>'')).includes(exe)) return true; } catch { /* no profiles */ }
  try { const s = await fs.stat(path.join(path.dirname(exe),'chrome-sandbox')); return s.uid === 0 && (s.mode & 0o4000) !== 0; } catch { return false; }
}
