import os from 'node:os';
import path from 'node:path';
import { access, readFile, readdir } from 'node:fs/promises';
import type { BrowserImportSource, BrowserImportProfile } from '@mingle/contracts';

export interface ImportEnvironment { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string }
type Definition = { id: string; name: string; dir: string; engine: 'chromium'|'firefox' };
const exists = async (p: string) => access(p).then(() => true, () => false);

function chromiumDefinitions(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): Definition[] {
  const roots: [string,string][] = platform === 'win32' ? [
    ['chrome','Google/Chrome'],['chromium','Chromium'],['brave','BraveSoftware/Brave-Browser'],['edge','Microsoft/Edge'],['vivaldi','Vivaldi'],
  ].map(([id, rel]) => [id, path.join(env.LOCALAPPDATA ?? path.join(home,'AppData/Local'), rel, 'User Data')]) : platform === 'darwin' ? [
    ['chrome','Google/Chrome'],['chromium','Chromium'],['brave','BraveSoftware/Brave-Browser'],['edge','Microsoft Edge'],['vivaldi','Vivaldi'],
  ].map(([id, rel]) => [id, path.join(home,'Library/Application Support',rel)]) : [
    ['chrome','google-chrome'],['chromium','chromium'],['brave','BraveSoftware/Brave-Browser'],['edge','microsoft-edge'],['vivaldi','vivaldi'],
  ].map(([id, rel]) => [id, path.join(env.XDG_CONFIG_HOME ?? path.join(home,'.config'),rel)]);
  const names: Record<string,string> = { chrome:'Google Chrome',chromium:'Chromium',brave:'Brave',edge:'Microsoft Edge',vivaldi:'Vivaldi' };
  return roots.map(([id,dir]) => ({ id, name:names[id]!, dir, engine:'chromium' }));
}

function firefoxRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home,'AppData/Roaming'),'Mozilla','Firefox');
  if (platform === 'darwin') return path.join(home,'Library/Application Support/Firefox');
  return path.join(env.XDG_CONFIG_HOME ?? home, env.XDG_CONFIG_HOME ? 'mozilla/firefox' : '.mozilla/firefox');
}

const profileId = (p: string) => Buffer.from(p).toString('base64url');
const decodeProfileId = (id: string) => Buffer.from(id,'base64url').toString();
async function firefoxProfiles(root: string): Promise<BrowserImportProfile[]> {
  const ini = path.join(root,'profiles.ini');
  let contents: string;
  try { contents = await readFile(ini,'utf8'); } catch { return []; }
  const profiles: BrowserImportProfile[] = [];
  let section: Record<string,string> = {};
  const flush = async () => {
    if (section.Name === undefined || section.Path === undefined) return;
    const dir = path.resolve(section.IsRelative === '1' ? root : path.dirname(ini), section.Path);
    if (await exists(path.join(dir,'cookies.sqlite'))) profiles.push({ id:profileId(dir), name:section.Name });
  };
  for (const line of contents.split(/\r?\n/u)) {
    if (/^\s*\[Profile\d+\]\s*$/u.test(line)) { await flush(); section={}; }
    else { const m = /^([^=]+)=(.*)$/u.exec(line); if (m) section[m[1]!] = m[2]!; }
  }
  await flush(); return profiles;
}

export async function listImportSources(options: ImportEnvironment = {}): Promise<BrowserImportSource[]> {
  const platform=options.platform ?? process.platform, env=options.env ?? process.env, home=options.home ?? os.homedir();
  const result: BrowserImportSource[]=[];
  for (const def of chromiumDefinitions(platform,env,home)) {
    if (!await exists(def.dir)) continue;
    let dirs: string[]=[];
    try { dirs=await readdir(def.dir); } catch { continue; }
    const candidates=['Default',...dirs.filter(x=>/^Profile \d+$/u.test(x))];
    const profiles: BrowserImportProfile[]=[];
    let names: Record<string,{name?:string}> = {};
    try { const state=JSON.parse(await readFile(path.join(def.dir,'Local State'),'utf8')); names=state?.profile?.info_cache ?? {}; } catch { /* profile folder names remain usable */ }
    for (const dir of candidates) {
      const profilePath=path.join(def.dir,dir);
      if (!await exists(path.join(profilePath,'Cookies')) && !await exists(path.join(profilePath,'Network','Cookies'))) continue;
      profiles.push({ id:profileId(profilePath), name:names[dir]?.name || (dir==='Default' ? 'Default' : dir) });
    }
    if (!profiles.length) continue;
    result.push({ id:def.id,name:def.name,engine:'chromium',profiles,supported:platform!=='win32',note:platform==='win32'?'Chrome-based browsers on Windows lock their sign-ins to themselves. Use Firefox, or the sign-in window instead.':platform==='darwin'?'macOS will ask for your keychain password.': 'Your keyring may ask for permission.' });
  }
  const root=firefoxRoot(platform,env,home), profiles=await firefoxProfiles(root);
  if (profiles.length) result.push({ id:'firefox',name:'Firefox',engine:'firefox',profiles,supported:true,note:null });
  return result;
}

export function resolveListedProfile(sources: BrowserImportSource[], sourceId: string, id: string): {source:BrowserImportSource; profile:BrowserImportProfile; path:string} {
  const source=sources.find(x=>x.id===sourceId); const profile=source?.profiles.find(x=>x.id===id);
  if (!source || !profile) throw new Error('That browser profile is no longer available. Refresh the source list and try again.');
  const resolved=decodeProfileId(profile.id);
  if (profileId(resolved)!==profile.id) throw new Error('That browser profile id is invalid.');
  return {source,profile,path:resolved};
}
