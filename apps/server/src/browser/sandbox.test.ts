import { describe, expect, it } from 'vitest';
import { detectSandbox, generateProfile, profileAttachment } from './sandbox.ts';
describe('sandbox detection and profile paths',()=>{
  it('returns null outside Linux and detects both restriction mechanisms',async()=>{
    expect(await detectSandbox({platform:'darwin'})).toBeNull();
    const status=await detectSandbox({platform:'linux',readFile:async p=>p.includes('apparmor')?'1':'',exists:async()=>false,managedExecutable:'/opt/chrome'});
    expect(status?.userNamespacesRestricted).toBe(true); expect(status?.managedReady).toBe(false); expect(status?.manualFix).toContain('apparmor_parser');
    const old=await detectSandbox({platform:'linux',readFile:async p=>p.includes('userns_clone')?'0':'',exists:async()=>false,managedExecutable:'/opt/chrome'});
    expect(old?.manualFix).toContain('unprivileged_userns_clone=1');
  });
  it('generates profile and rejects unsafe paths',async()=>{
    expect(generateProfile('/opt/pw/chromium-*/chrome-linux*/chrome')).toContain('userns,');
    expect(await profileAttachment('/opt/pw/chromium-123/chrome-linux64/chrome',false,{realpath:async p=>p})).toBe('/opt/pw/chromium-*/chrome-linux*/chrome');
    await expect(profileAttachment('/tmp/a"b',true,{realpath:async p=>p})).rejects.toThrow();
    await expect(profileAttachment('/tmp/a\\b',true,{realpath:async p=>p})).rejects.toThrow();
    await expect(profileAttachment('/tmp/../etc/chrome',true,{realpath:async p=>p})).rejects.toThrow();
  });
});
