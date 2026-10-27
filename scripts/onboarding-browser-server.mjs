/** Disposable first-launch fixture runtime. Provider discovery and inference are deterministic and local-only. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../apps/server/src/app.ts';
import { FakeProviders } from '../apps/server/src/test-utils.ts';

const dataDir = await mkdtemp(join(tmpdir(), 'mingle-onboarding-fixture-'));
let app;
let closing = false;

async function shutdown() {
  if (closing) return;
  closing = true;
  try { await app?.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
}

try {
  const webDevPort = Number(process.env.MINGLE_ONBOARDING_WEB_PORT);
  if (!Number.isInteger(webDevPort) || webDevPort < 1 || webDevPort > 65535) throw new Error('MINGLE_ONBOARDING_WEB_PORT must be an ephemeral local dev-server port.');
  app = createApplication({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    webDevPort,
    webDistDir: null,
    providers: new FakeProviders(),
    log: () => undefined,
    exampleWorkspace: true,
    detectOnStart: false,
    env: { ...process.env, MINGLE_DATA_DIR: dataDir, MINGLE_SUPABASE_URL: '', MINGLE_SUPABASE_PUBLISHABLE_KEY: '' },
  });
  const address = await app.listen();
  if (app.store.getSettings().onboardingCompletedVersion !== undefined) throw new Error('Expected a fresh example workspace without onboarding completion.');
  process.stdout.write(`READY ${JSON.stringify({ url: address.url, exampleWorkspace: true, dataDir, providers: 'FakeProviders' })}\n`);
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('beforeExit', () => { void shutdown(); });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  await shutdown();
  process.exitCode = 1;
}
