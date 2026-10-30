import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { matchesDomain, readChromium } from './chromium.ts';
import { firefoxExpiry, readFirefox } from './firefox.ts';

describe('cookie database readers', () => {
  it('filters to the requested exact domain and subdomains', async () => {
    const db=new DatabaseSync(':memory:');
    db.exec('CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER)');
    const add=db.prepare('INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?,?)');
    add.run('.google.com','a','1',Buffer.alloc(0),'/',0,1,1,1); add.run('accounts.google.com','b','2',Buffer.alloc(0),'/',0,0,0,0); add.run('evilgoogle.com','c','3',Buffer.alloc(0),'/',0,0,0,-1);
    expect(matchesDomain('accounts.google.com','google.com')).toBe(true); expect(matchesDomain('.google.com','google.com')).toBe(true); expect(matchesDomain('evilgoogle.com','google.com')).toBe(false);
    const out=await readChromium(db,'chrome','linux',['google.com']); expect(out.cookies.map(x=>x.name)).toEqual(['a','b']); db.close();
  });
  it('reads Firefox expiry values in seconds and milliseconds', () => {
    expect(firefoxExpiry(1700000000)).toBe(1700000000); expect(firefoxExpiry(1700000000000)).toBe(1700000000);
  });
  it('reads Firefox rows from a SQLite fixture', () => {
    const db=new DatabaseSync(':memory:'); db.exec('CREATE TABLE moz_cookies(name TEXT,value TEXT,host TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER)');
    db.prepare('INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?,?)').run('sid','x','.google.com','/',0,1,1,2);
    expect(readFirefox(db,['google.com']).map((row:any)=>row.name)).toEqual(['sid']); db.close();
  });
});
