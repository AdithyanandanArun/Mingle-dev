import { describe, expect, it } from 'vitest';
import { normalizeCookie } from './index.ts';
import { stripHostHash } from './keys.ts';
import { createHash } from 'node:crypto';

describe('imported cookie normalization', () => {
  it('turns SameSite=None without Secure into Lax', () => {
    expect(normalizeCookie({ name: 'a', value: 'b', domain: '.google.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'None' }).sameSite).toBe('Lax');
  });
  it('sets __Host- cookies by URL without a domain or path', () => {
    const cookie = normalizeCookie({ name: '__Host-GAPS', value: 'x', domain: 'accounts.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' });
    expect(cookie).toMatchObject({ url: 'https://accounts.google.com/', secure: true });
    expect(cookie.domain).toBeUndefined();
    expect(cookie.path).toBeUndefined();
  });
  it('strips the host hash prefix by content even without a schema version', () => {
    const host = '.google.com';
    const value = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from('secret')]);
    expect(stripHostHash(value, host, 0).toString()).toBe('secret');
    expect(stripHostHash(Buffer.from('plain-value'), host, 0).toString()).toBe('plain-value');
  });
});
