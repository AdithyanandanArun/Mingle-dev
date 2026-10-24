import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const environment = { ...process.env };
// Electron-based developer tools can propagate this variable to their terminals.
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;
const child = spawn(require('electron'), [fileURLToPath(new URL('.', import.meta.url)), ...process.argv.slice(2)], {
  env: environment,
  stdio: 'inherit',
});
child.once('error', error => { console.error(`Could not launch Electron: ${error.message}`); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
