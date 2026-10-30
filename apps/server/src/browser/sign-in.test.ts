import { describe, expect, it } from 'vitest';
import { buildSignInArgv, validateSignInUrl } from './sign-in.ts';
import { diagnoseLaunchError } from './playwright.ts';
describe('browser sign-in helpers',()=>{
  it('uses the persistent profile and validates http(s) URLs',()=>{
    expect(buildSignInArgv('/tmp/profile','https://accounts.google.com/')).toEqual(['--user-data-dir=/tmp/profile','--no-first-run','--no-default-browser-check','--password-store=basic','--use-mock-keychain','--new-window','https://accounts.google.com/']);
    expect(validateSignInUrl()).toBe('https://accounts.google.com/');
    expect(()=>validateSignInUrl('javascript:alert(1)')).toThrow();
  });
  it('gives Ubuntu AppArmor guidance when restricted without a profile',()=>expect(diagnoseLaunchError(new Error('sandbox namespace failed'),{userNamespacesRestricted:true,profileInstalled:false}).message).toContain("Use 'Allow Chromium'"));
});
