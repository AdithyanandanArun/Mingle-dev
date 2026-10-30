import { describe, expect, it } from 'vitest';
import { discoverSystemBrowsers, type BrowserFs } from './system-browsers.ts';
describe('system browser detection',()=>{
  it('finds existing candidates and skips snap wrappers',async()=>{
    const fake:BrowserFs={access:async()=>{},readFile:async()=> '#!/bin/sh\nexec snap run chromium',realpath:async p=>p==='/usr/bin/chromium-browser'?'/snap/bin/chromium':p,stat:async()=>({uid:1000,mode:0o755}),readdir:async()=>[]};
    const found=await discoverSystemBrowsers({platform:'linux',restricted:true,fs:fake});
    expect(found.some(x=>x.executable==='/usr/bin/chromium-browser')).toBe(false);
    expect(found.every(x=>!x.sandboxReady)).toBe(true);
  });
});
