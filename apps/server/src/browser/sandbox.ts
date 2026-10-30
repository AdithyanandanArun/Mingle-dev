import { access, mkdtemp, readFile, realpath, stat, unlink, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { BrowserSandboxStatus } from '@mingle/contracts';
import { resolveManagedExecutable } from './playwright.ts';

export interface SandboxDeps { platform?: NodeJS.Platform; readFile?(p:string):Promise<string>; exists?(p:string):Promise<boolean>; realpath?(p:string):Promise<string>; execFile?(file:string,args:string[],opts?:object):Promise<{stdout?:string}>; managedExecutable?:string|null; configured?:boolean; systemSandboxReady?:boolean; }
const present = async (p:string) => { try { await access(p); return true; } catch { return false; } };
export async function profileAttachment(executable: string, configured: boolean, deps: Pick<SandboxDeps,'realpath'> = {}): Promise<string> {
  let attach: string;
  if (configured) attach = await (deps.realpath ?? realpath)(executable);
  else {
    const rp=deps.realpath ?? realpath;
    const match=executable.match(/^(.*\/)(chromium-[^/]+)\/(chrome-linux[^/]*)\/chrome$/u);
    if(!match) throw new Error('Could not determine the Playwright Chromium installation directory.');
    attach = `${await rp(match[1].replace(/\/$/u,''))}/chromium-*/chrome-linux*/chrome`;
  }
  if (!path.isAbsolute(attach) || attach.includes('..') || /["'\\\n\r]/u.test(attach) || !/^[A-Za-z0-9._/+@ -]+(?:\*\/[-A-Za-z0-9._/+@ ]+)*$/u.test(attach)) throw new Error('Unsafe Chromium path for an AppArmor profile.');
  return attach;
}
export function generateProfile(attach:string):string { return `abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile mingle-chromium "${attach}" flags=(unconfined) {\n  userns,\n  include if exists <local/mingle-chromium>\n}\n`; }
export async function detectSandbox(deps:SandboxDeps = {}):Promise<BrowserSandboxStatus|null> {
  if ((deps.platform ?? process.platform)!=='linux') return null;
  const rd=deps.readFile ?? (async p=>String(await readFile(p,'utf8'))), ex=deps.exists ?? present;
  const aa=(await rd('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').catch(()=>'' )).trim()==='1';
  const old=(await rd('/proc/sys/kernel/unprivileged_userns_clone').catch(()=>'' )).trim()==='0';
  const restricted=aa||old;
  const profile='/etc/apparmor.d/mingle-chromium'; let installed=false;
  const executable=deps.managedExecutable ?? (await resolveManagedExecutable(undefined)).path;
  if (restricted && executable && await ex(profile)) {
    const text=await rd(profile).catch(()=> '');
    try {
      if (deps.configured) installed=text.includes(`profile mingle-chromium "${await profileAttachment(executable,true)}"`);
      else installed=/profile mingle-chromium "[^"\n]*\/chromium-\*\/chrome-linux\*\/chrome"/u.test(text);
    } catch { installed=false; }
  }
  const pathHas=async(name:string)=>{ for(const dir of (process.env.PATH??'').split(path.delimiter)){if(await ex(path.join(dir,name)))return true;} return false; };
  const canInstallProfile=aa && await pathHas('pkexec') && (await ex('/usr/sbin/apparmor_parser')||await ex('/sbin/apparmor_parser')) && await ex('/etc/apparmor.d');
  let profileText='';
  if(executable) { try { profileText=generateProfile(await profileAttachment(executable,Boolean(deps.configured))); } catch { /* unavailable executable */ } }
  const manualFix=restricted ? (aa ? `sudo tee /etc/apparmor.d/mingle-chromium <<'EOF'\n${profileText || 'abi <abi/4.0>,\ninclude <tunables/global>\n'}EOF\nsudo apparmor_parser -r /etc/apparmor.d/mingle-chromium` : 'sudo sysctl -w kernel.unprivileged_userns_clone=1') : null;
  return { userNamespacesRestricted:restricted, profileInstalled:installed, canInstallProfile, managedReady:!restricted||installed||Boolean(deps.systemSandboxReady && executable), manualFix };
}
export async function installSandboxProfile(executable:string, configured:boolean, deps: { execFile?:SandboxDeps['execFile']; realpath?:SandboxDeps['realpath'] } = {}):Promise<void> {
  const attach=await profileAttachment(executable,configured,deps), dir=await mkdtemp(path.join(os.tmpdir(),'mingle-aa-')), tmp=path.join(dir,'profile');
  try {
    await writeFile(tmp,generateProfile(attach),{mode:0o600,flag:'wx'});
    const script='install -m 0644 -o root -g root "$1" "$2" && apparmor_parser -r "$2"';
    const run=deps.execFile ?? ((file,args)=>new Promise((resolve,reject)=>execFile(file,args,{timeout:120_000},(error,stdout)=>error?reject(error):resolve({stdout}))));
    try { await run('pkexec',['/bin/sh','-c',script,'sh',tmp,'/etc/apparmor.d/mingle-chromium']); }
    catch(e) { const code=String((e as NodeJS.ErrnoException & {code?:string}).code ?? ''); if(code==='126'||code==='127') throw new Error('The administrator prompt was dismissed or authorization was denied.'); throw e; }
  } finally { await unlink(tmp).catch(()=>undefined); await rm(dir,{recursive:true,force:true}); }
}
