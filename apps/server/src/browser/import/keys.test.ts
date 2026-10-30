import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptAesCbc, linuxKey, stripHostHash } from './keys.ts';

describe('cookie decryption helpers', () => {
  it('decrypts a Linux v10 AES-CBC payload', () => {
    const key=linuxKey(), cipher=createCipheriv('aes-128-cbc',key,Buffer.alloc(16,0x20));
    const encrypted=Buffer.concat([cipher.update('cookie secret'),cipher.final()]);
    expect(decryptAesCbc(encrypted,key).toString()).toBe('cookie secret');
  });
  it('strips the Chromium host hash for database version 24+', () => {
    const host='accounts.google.com', payload=Buffer.from('secret');
    const prefixed=Buffer.concat([createHash('sha256').update(host).digest(),payload]);
    expect(stripHostHash(prefixed,host,24).toString()).toBe('secret');
  });
});
