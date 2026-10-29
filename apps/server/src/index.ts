import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApplication, type ApplicationOptions, type MingleApplication } from './app.ts';
import * as providers from './providers/index.ts';
import { beginProcessShutdown } from './runtime.ts';

export { createApplication, buildServer, type ApplicationOptions, type MingleApplication } from './app.ts';
export { resolveConfig, SOURCE_ROOT, type ServerConfig } from './config.ts';

/** Starts the production-intended local runtime with the real provider adapters. */
export async function startMingleServer(options: Partial<ApplicationOptions> = {}): Promise<MingleApplication & { url: string }> {
  const app = createApplication({ providers, ...options });
  const { url } = await app.listen();
  return Object.assign(app, { url });
}

async function main(): Promise<void> {
  const app = await startMingleServer();
  console.log(`[mingle] listening on ${app.url}  (data: ${app.config.dataDir})`);
  if (!app.config.webDistDir) console.log('[mingle] apps/web/dist not found; API only. Use the Vite dev server for the UI.');
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    beginProcessShutdown();
    stopping = true;
    console.log(`[mingle] ${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 35_000);
    force.unref();
    app.close().then(() => process.exit(0), (error) => { console.error('[mingle] shutdown failed', error); process.exit(1); });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGHUP', () => stop('SIGHUP'));
  process.on('unhandledRejection', (reason) => console.error('[mingle] unhandled rejection', reason));
  process.on('uncaughtException', (error) => { console.error('[mingle] uncaught exception', error); stop('uncaughtException'); });
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error('[mingle] failed to start:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
