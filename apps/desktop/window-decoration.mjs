import { open, rename, unlink } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const FILE_NAME = 'window-decoration.json';
const MAX_FILE_BYTES = 4096;

function readPreference(path, supported) {
  if (!supported) return 'system';
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return 'system';
    const contents = readFileSync(path, 'utf8');
    if (Buffer.byteLength(contents, 'utf8') > MAX_FILE_BYTES) return 'system';
    const value = JSON.parse(contents)?.titleBar;
    return value === 'hidden' || value === 'system' ? value : 'system';
  } catch { return 'system'; }
}

export function createWindowDecorationPreference({ userData, platform = process.platform }) {
  if (typeof userData !== 'string' || userData.length === 0) throw new TypeError('userData must be a non-empty path');
  const supported = platform === 'linux';
  const path = join(userData, FILE_NAME);
  let titleBar = 'system';
  let activeTitleBar = 'system';
  titleBar = readPreference(path, supported);
  activeTitleBar = supported ? titleBar : 'system';
  function getState() {
    return { supported, titleBar, activeTitleBar, restartRequired: titleBar !== activeTitleBar };
  }
  async function setTitleBar(value) {
    if (value !== 'system' && value !== 'hidden') throw new TypeError('titleBar must be system or hidden');
    if (!supported) return getState();
    const temporary = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ titleBar: value })}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, path);
      titleBar = value;
      return getState();
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  return Object.freeze({ getState, setTitleBar, windowOptions: () => supported ? { frame: activeTitleBar === 'system' } : {} });
}
