import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BrowserImport } from '@mingle/contracts';
import { listImportSources, resolveListedProfile } from './sources.ts';
import { readChromium } from './chromium.ts';
import { firefoxExpiry, readFirefox } from './firefox.ts';

export { listImportSources } from './sources.ts';
export type { ImportEnvironment } from './sources.ts';
export async function readImportedCookies(input:BrowserImport):Promise<{cookies:any[];skipped:number;domains:string[]}> {
  const sources=await listImportSources();
  const {source,path:profilePath}=resolveListedProfile(sources,input.sourceId,input.profileId);
  if(!source.supported) throw new Error(source.note ?? 'This browser cannot share sign-ins on this computer.');
  const dbPath=source.engine==='firefox'?path.join(profilePath,'cookies.sqlite'):
    await (async()=>{ const network=path.join(profilePath,'Network','Cookies'); try { await readFile(network); return network; } catch { return path.join(profilePath,'Cookies'); } })();
  const temp=await mkdtemp(path.join(os.tmpdir(),'mingle-cookie-import-'));
  try {
    await chmod(temp,0o700);
    const copy=path.join(temp,'cookies.sqlite'); await copyFile(dbPath,copy);
    try { await copyFile(`${dbPath}-wal`,`${copy}-wal`); } catch (e:any) { if(e?.code!=='ENOENT') throw e; }
    const db=new DatabaseSync(copy,{readOnly:true});
    try {
      if(source.engine==='chromium') { const out=await readChromium(db,source.id,process.platform,input.domains); return {...out,domains:input.domains}; }
      const rows=readFirefox(db,input.domains), cookies:any[]=[]; let skipped=0;
      for(const row of rows) {
        const expires=firefoxExpiry(Number(row.expiry));
        if(expires>0 && expires<=Date.now()/1000) { skipped++; continue; }
        cookies.push({name:String(row.name),value:String(row.value),domain:String(row.host),path:String(row.path||'/'),expires:expires>0?expires:-1,httpOnly:Boolean(row.isHttpOnly),secure:Boolean(row.isSecure),sameSite:Number(row.sameSite)===2?'Strict':Number(row.sameSite)===1?'Lax':'None'});
      }
      return {cookies,skipped,domains:input.domains};
    } finally { db.close(); }
  } finally { await rm(temp,{recursive:true,force:true}); }
}
