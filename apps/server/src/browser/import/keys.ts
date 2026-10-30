import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDecipheriv, pbkdf2Sync, createHash } from 'node:crypto';
const execFile=promisify(nodeExecFile);

export function linuxKey(password='peanuts'): Buffer { return pbkdf2Sync(password,'saltysalt',1,16,'sha1'); }
export function macKey(password: Buffer|string): Buffer { return pbkdf2Sync(password,'saltysalt',1003,16,'sha1'); }
export function decryptAesCbc(payload: Buffer, key: Buffer): Buffer {
  const decipher=createDecipheriv('aes-128-cbc',key,Buffer.alloc(16,0x20));
  return Buffer.concat([decipher.update(payload),decipher.final()]);
}
export function stripHostHash(value: Buffer, host: string, dbVersion: number): Buffer {
  if (dbVersion >= 24 && value.length >= 32) {
    const expected=createHash('sha256').update(host).digest();
    if (value.subarray(0,32).equals(expected)) return value.subarray(32);
  }
  return value;
}

const safeStorage: Record<string,string>={chrome:'Chrome Safe Storage',chromium:'Chromium Safe Storage',brave:'Brave Safe Storage',edge:'Microsoft Edge Safe Storage',vivaldi:'Vivaldi Safe Storage'};
export async function decryptChromiumValue(sourceId:string, platform:NodeJS.Platform, encrypted:Buffer, host:string, dbVersion:number):Promise<string> {
  const prefix=encrypted.subarray(0,3).toString();
  if (prefix!=='v10' && prefix!=='v11') throw new Error('Unsupported Chromium cookie encryption format.');
  let key:Buffer;
  if (platform==='linux') {
    if (prefix==='v10') key=linuxKey();
    else {
      const attrs:Record<string,string>={chrome:'chrome',chromium:'chromium',brave:'brave',edge:'microsoft-edge',vivaldi:'vivaldi'};
      try { const {stdout}=await execFile('secret-tool',['lookup','application',attrs[sourceId] ?? sourceId],{timeout:10000,windowsHide:true}); const secret=String(stdout).trim(); if(!secret) throw new Error('empty'); key=linuxKey(secret); }
      catch { throw new Error('Install libsecret-tools (secret-tool) or use Firefox / the sign-in window. KWallet cookie decryption is unsupported.'); }
    }
  } else if (platform==='darwin') {
    let password:string;
    try { const {stdout}=await execFile('security',['find-generic-password','-w','-s',safeStorage[sourceId] ?? 'Chrome Safe Storage'],{timeout:10000,windowsHide:true}); password=String(stdout).trim(); if(!password) throw new Error('empty'); }
    catch { throw new Error('Could not read this browser’s Safe Storage password from Keychain.'); }
    key=macKey(password);
  } else throw new Error('Windows Chromium cookie import is unsupported. Use Firefox, or the sign-in window instead.');
  const plain=decryptAesCbc(encrypted.subarray(3),key);
  return stripHostHash(plain,host,dbVersion).toString('utf8');
}
