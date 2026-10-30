import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listImportSources } from './sources.ts';

describe('browser import sources', () => {
  it('lists only profiles containing cookie databases and uses names from Local State', async () => {
    const home=await mkdtemp(path.join(os.tmpdir(),'mingle-import-sources-'));
    try {
      const root=path.join(home,'.config','google-chrome');
      await mkdir(path.join(root,'Default','Network'),{recursive:true});
      await mkdir(path.join(root,'Profile 2'),{recursive:true});
      await mkdir(path.join(root,'Profile 3'),{recursive:true});
      await writeFile(path.join(root,'Default','Network','Cookies'),'');
      await writeFile(path.join(root,'Profile 2','Cookies'),'');
      await writeFile(path.join(root,'Local State'),JSON.stringify({profile:{info_cache:{Default:{name:'Main'},'Profile 2':{name:'Work'}}}}));
      const sources=await listImportSources({platform:'linux',home,env:{}});
      expect(sources.find(x=>x.id==='chrome')?.profiles.map(x=>x.name)).toEqual(['Main','Work']);
    } finally { await rm(home,{recursive:true,force:true}); }
  });
});
