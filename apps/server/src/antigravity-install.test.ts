import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { antigravityInstallState, antigravityRuntimeDirectory, antigravityRuntimeFilenames } from './antigravity-install.ts';

const roots: string[] = [];
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mingle-antigravity-install-test-'));
  roots.push(path);
  return path;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('managed Antigravity install state', () => {
  it('reports installed only when both runtime executables are present and executable', async () => {
    const data = await root();
    const directory = antigravityRuntimeDirectory(data);
    await mkdir(directory, { recursive: true });
    const [acp, harness] = antigravityRuntimeFilenames();
    await writeFile(join(directory, acp), 'runtime');
    await writeFile(join(directory, harness), 'harness');
    await chmod(join(directory, acp), 0o700);
    await chmod(join(directory, harness), 0o700);
    expect(await antigravityInstallState(data)).toMatchObject({ state: 'installed', executable: join(directory, acp) });
    await chmod(join(directory, harness), 0o600);
    expect(await antigravityInstallState(data)).toMatchObject({ state: 'not-installed', executable: null });
  });

  it('reports a partial install as not installed', async () => {
    const data = await root();
    const directory = antigravityRuntimeDirectory(data);
    await mkdir(directory, { recursive: true });
    const [acp] = antigravityRuntimeFilenames();
    await writeFile(join(directory, acp), 'runtime');
    await chmod(join(directory, acp), 0o700);
    expect(await antigravityInstallState(data)).toMatchObject({ state: 'not-installed', executable: null });
  });
});
