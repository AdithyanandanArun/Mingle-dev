import type { DatabaseSync } from 'node:sqlite';
export function firefoxExpiry(value:number):number { return value>1e11 ? value/1000 : value; }
export function readFirefox(db:DatabaseSync, domains:string[]) {
  const rows: any[]=[];
  for (const domain of domains) {
    const pattern=`%.${domain.replace(/[\\%_]/gu,'\\$&')}`;
    rows.push(...db.prepare(`SELECT name,value,host,path,expiry,isSecure,isHttpOnly,sameSite FROM moz_cookies WHERE host = ? OR host = ? OR host LIKE ? ESCAPE '\\'`).all(domain,`.${domain}`,pattern) as any[]);
  }
  return rows;
}
