import type { DatabaseSync } from 'node:sqlite';
import { decryptChromiumValue } from './keys.ts';
export function escapeLike(value:string):string { return value.replace(/[\\%_]/gu,'\\$&'); }
export function matchesDomain(host:string,domain:string):boolean { return host===domain || host===`.${domain}` || host.endsWith(`.${domain}`); }
/** Chromium: -1 unspecified (browsers treat it as Lax), 0 None, 1 Lax, 2 Strict. */
function chromiumSameSite(value:number):'Strict'|'Lax'|'None' { return value===2?'Strict':value===0?'None':'Lax'; }
export async function readChromium(db:DatabaseSync, sourceId:string, platform:NodeJS.Platform, domains:string[]) {
  // Chromium keeps its schema version in the meta table, not in PRAGMA user_version.
  let version=0; try { version=Number((db.prepare("SELECT value FROM meta WHERE key='version'").get() as any)?.value ?? 0); } catch { version=0; }
  const rows:any[]=[];
  for (const domain of domains) {
    const pat=`%.${escapeLike(domain)}`;
    rows.push(...db.prepare(`SELECT host_key,name,value,encrypted_value,path,expires_utc,is_secure,is_httponly,samesite FROM cookies WHERE host_key = ? OR host_key = ? OR host_key LIKE ? ESCAPE '\\'`).all(domain,`.${domain}`,pat) as any[]);
  }
  const cookies=[]; let skipped=0;
  for (const row of rows) {
    let value=String(row.value ?? '');
    if (!value) { try { value=await decryptChromiumValue(sourceId,platform,Buffer.from(row.encrypted_value ?? []),String(row.host_key),version); } catch { skipped++; continue; } }
    const expires=row.expires_utc ? (Number(row.expires_utc)/1e6 - 11644473600) : -1;
    if(expires>0 && expires<=Date.now()/1000) { skipped++; continue; }
    cookies.push({name:String(row.name),value,domain:String(row.host_key),path:String(row.path||'/'),expires:expires>0?expires:-1,httpOnly:Boolean(row.is_httponly),secure:Boolean(row.is_secure),sameSite:chromiumSameSite(Number(row.samesite))});
  }
  return {cookies,skipped};
}
