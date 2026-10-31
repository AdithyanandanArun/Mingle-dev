import { spawn as nodeSpawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { delimiter, isAbsolute } from 'node:path';

const START = '__MINGLE_LOGIN_PATH_START_7f6c9b__';
const END = '__MINGLE_LOGIN_PATH_END_7f6c9b__';

function splitPath(value) {
  return value.split(delimiter).map(entry => entry.trim()).filter(Boolean);
}

export function mergePath(loginPath, currentPath) {
  const current = splitPath(currentPath ?? '');
  const seen = new Set(current);
  const merged = [];
  for (const entry of splitPath(loginPath ?? '')) {
    if (!seen.has(entry)) { seen.add(entry); merged.push(entry); }
  }
  return [...merged, ...current].join(delimiter);
}

async function trustedShell(shell, exists) {
  if (!isAbsolute(shell) || !(await exists(shell))) return false;
  try {
    const lines = (await readFile('/etc/shells', 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    return lines.includes(shell);
  } catch {
    return false;
  }
}

export async function readLoginPath({ env = process.env, platform = process.platform, exists = async () => true, isListedShell, spawn = nodeSpawn, timeoutMs = 3000 } = {}) {
  const currentPath = env.PATH ?? '';
  if (platform === 'win32') return { path: currentPath, warning: null };
  const requestedShell = env.SHELL;
  const shell = requestedShell && (isListedShell ? await isListedShell(requestedShell) : await trustedShell(requestedShell, exists)) && await exists(requestedShell) ? requestedShell : '/bin/bash';
  if (!(await exists(shell))) return { path: currentPath, warning: 'Login shell PATH could not be read; keeping the inherited PATH.' };

  const command = `printf '${START}%s${END}' "$PATH"`;
  const childEnv = { ...env, TERM: 'dumb' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  let child;
  try {
    child = spawn(shell, ['-ilc', command], { env: childEnv, stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs });
    const stdout = await new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; fn(value); };
      const timer = setTimeout(() => { child.kill(); finish(reject, new Error('timeout')); }, timeoutMs);
      child.stdout?.on('data', chunk => { output = (output + chunk.toString()).slice(-64 * 1024); });
      child.once('error', error => { clearTimeout(timer); finish(reject, error); });
      child.once('close', code => {
        clearTimeout(timer);
        const start = output.lastIndexOf(START);
        const end = start < 0 ? -1 : output.indexOf(END, start + START.length);
        if (code !== 0 || start < 0 || end < 0) return finish(reject, new Error('invalid shell output'));
        finish(resolve, output.slice(start + START.length, end));
      });
    });
    return { path: mergePath(stdout, currentPath), warning: null };
  } catch {
    return { path: currentPath, warning: 'Login shell PATH could not be read; keeping the inherited PATH.' };
  }
}
