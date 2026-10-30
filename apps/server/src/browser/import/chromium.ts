import type { DatabaseSync } from 'node:sqlite';
import { decryptChromiumValue } from './keys.ts';
export function escapeLike(value:string):string { return value.replace(/[\\%_]/gu,'\\$&'); }
export function matchesDomain(host:string,domain:string):boolean { return host===domain || host===`.${domain}` || host.endsWith(`.${domain}`); }
export async function readChromium(db:DatabaseSync, sourceId:string, platform:NodeJS.Platform, domains:string[]) {
  const version=Number((db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
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
    cookies.push({name:String(row.name),value,domain:String(row.host_key),path:String(row.path||'/'),expires:expires>0?expires:-1,httpOnly:Boolean(row.is_httponly),secure:Boolean(row.is_secure),sameSite:Number(row.samesite)===2?'Strict' as const:Number(row.samesite)===1?'Lax' as const:'None' as const});
  }
  return {cookies,skipped};
}
