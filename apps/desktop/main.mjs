import { app, BrowserWindow, WebContentsView, dialog, ipcMain, shell, safeStorage, session } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccountKeyManager } from './account-storage/account-key.mjs';
import { createAccountKeyIpcHandler } from './account-storage/account-key-ipc.mjs';
import { configureLinuxPasswordStore } from './account-storage/linux-backend.mjs';
import { createProjectInvitationDispatcher, focusProjectInvitationWindow, isProjectInvitationWorkspaceUrl } from './project-invitation.mjs';
import { createEmbeddedBrowserHost } from './embedded-browser/host.mjs';

const root = app.isPackaged ? join(process.resourcesPath, 'workspace') : fileURLToPath(new URL('../../', import.meta.url));
const serverRoot = join(root, 'apps/server');
app.setName('Mingle');
configureLinuxPasswordStore({ app });
const mingleUserData = app.getPath('userData');
const legacyUserData = join(dirname(mingleUserData), 'Relay');
const mingleWorkspace = join(mingleUserData, 'workspace');
const legacyWorkspace = join(legacyUserData, 'workspace');
const hasDatabase = (directory) => existsSync(join(directory, 'relay.sqlite'));
// Keep the existing Electron profile together with the workspace it belongs to. If both roots
// have a database, the legacy root wins so an earlier first-launch cannot mask the old workspace.
const userData = hasDatabase(legacyWorkspace) ? legacyUserData
  : hasDatabase(mingleWorkspace) ? mingleUserData
    : existsSync(legacyWorkspace) || existsSync(legacyUserData) ? legacyUserData
      : mingleUserData;
mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setPath('userData', userData);
app.setPath('sessionData', userData);
const runtimeNodeOverride = process.env.MINGLE_NODE_EXECUTABLE !== undefined ? process.env.MINGLE_NODE_EXECUTABLE : process.env.RELAY_NODE_EXECUTABLE;
const runtimeNode = app.isPackaged ? join(process.resourcesPath, 'runtime/bin', process.platform === 'win32' ? 'node.exe' : 'node') : runtimeNodeOverride?.trim() || 'node';
if (process.platform === 'linux') {
  app.setDesktopName('mingle.desktop');
  app.commandLine.appendSwitch('class', 'mingle');
}
let backend;
let quitting = false;
let shutdownPending = false;
let mainWindow;
let workspaceUrl;
let embeddedBrowserHost;
const embeddedViewsByWindow = new Map();
const browserWindows = new Map();
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function isLiveWindow(window) { return Boolean(window && !window.isDestroyed()); }

function isWorkspaceFrame(event) {
  if (!workspaceUrl || event.senderFrame !== event.sender.mainFrame) return false;
  return isProjectInvitationWorkspaceUrl(event.senderFrame.url, workspaceUrl);
}

function openExternalWebTarget(target, origin) {
  try {
    const parsed = new URL(target);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin !== origin) void shell.openExternal(parsed.href);
  } catch { /* invalid targets are blocked */ }
}

function configureWorkspaceWindow(window, origin) {
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternalWebTarget(target, origin);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    let sameOrigin = false;
    try { sameOrigin = new URL(target).origin === origin; } catch { /* invalid targets are blocked */ }
    if (!sameOrigin) {
      event.preventDefault();
      if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    }
  });
}

function notifyBrowserPopoutClosed(sessionId) {
  if (isLiveWindow(mainWindow) && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('mingle.browser.popout.closed', sessionId);
  }
}

function focusMainWindow() {
  focusProjectInvitationWindow(mainWindow);
}

function sendProjectInvitation(window, token) {
  if (!isLiveWindow(window) || window !== mainWindow || !window.webContents || window.webContents.isDestroyed()) return;
  if (!isProjectInvitationWorkspaceUrl(window.webContents.getURL(), workspaceUrl)) return;
  window.webContents.send('mingle.project-invitation', token);
}

const projectInvitationDispatcher = createProjectInvitationDispatcher({
  getWorkspaceUrl: () => workspaceUrl,
  getWindow: () => isLiveWindow(mainWindow) ? mainWindow : null,
  focusWindow: () => focusMainWindow(),
  sendInvitation: sendProjectInvitation,
});

ipcMain.handle('mingle.browser.open-popout', async (event, sessionId) => {
  if (!isLiveWindow(mainWindow) || event.sender !== mainWindow.webContents || !isWorkspaceFrame(event) || typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return false;
  const existing = browserWindows.get(sessionId);
  if (isLiveWindow(existing)) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return true;
  }
  const origin = new URL(workspaceUrl).origin;
  const window = new BrowserWindow({
    parent: mainWindow, title: 'Mingle Browser', width: 1120, height: 780, minWidth: 560, minHeight: 420,
    backgroundColor: '#111111', autoHideMenuBar: true,
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), 'browser-preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    },
  });
  browserWindows.set(sessionId, window);
  window.once('closed', () => {
    if (browserWindows.get(sessionId) === window) browserWindows.delete(sessionId);
    notifyBrowserPopoutClosed(sessionId);
  });
  configureWorkspaceWindow(window, origin);
  try {
    await window.loadURL(`${workspaceUrl}/?browserPopout=${encodeURIComponent(sessionId)}`);
    if (!isLiveWindow(window)) return false;
    window.show();
    window.focus();
    return true;
  } catch {
    if (isLiveWindow(window)) window.destroy();
    return false;
  }
});

ipcMain.handle('mingle.browser.is-popout-open', (event, sessionId) => {
  if (!isLiveWindow(mainWindow) || event.sender !== mainWindow.webContents || !isWorkspaceFrame(event) || typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return false;
  return isLiveWindow(browserWindows.get(sessionId));
});

ipcMain.handle('mingle.browser.focus-popout', (event, sessionId) => {
  if (!isLiveWindow(mainWindow) || event.sender !== mainWindow.webContents || !isWorkspaceFrame(event) || typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return false;
  const window = browserWindows.get(sessionId);
  if (!isLiveWindow(window)) return false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return true;
});

ipcMain.handle('mingle.browser.dock-popout', (event, sessionId) => {
  let target = null;
  if (!isWorkspaceFrame(event)) return false;
  if (isLiveWindow(mainWindow) && event.sender === mainWindow.webContents) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return false;
    target = browserWindows.get(sessionId);
  } else {
    if (sessionId !== undefined) return false;
    for (const window of browserWindows.values()) if (window.webContents === event.sender) { target = window; break; }
  }
  if (!isLiveWindow(target)) return false;
  target.close();
  focusMainWindow();
  return true;
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('Could not reserve a local port'));
      probe.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForBackend(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (backend?.exitCode !== null) throw new Error('Local runtime exited before it was ready.');
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* The child is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('The local runtime did not become ready within 15 seconds.');
}

async function openWorkspace() {
  if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
    throw new Error(app.isPackaged ? 'The installed application is missing its UI files. Reinstall Mingle.' : 'Build Mingle first with pnpm build, then run pnpm desktop.');
  }
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  workspaceUrl = url;
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  const dataOverride = process.env.MINGLE_DATA_DIR !== undefined ? process.env.MINGLE_DATA_DIR : process.env.RELAY_DATA_DIR;
  const workspaceDataDir = dataOverride?.trim() || join(userData, 'workspace');
  const getAccountKey = createAccountKeyManager({ userData, workspaceDataDir, safeStorage });
  const serverRequire = createRequire(join(serverRoot, 'package.json'));
  const ws = serverRequire('ws');
  embeddedBrowserHost = createEmbeddedBrowserHost({ electron: { app, BrowserWindow, WebContentsView, ipcMain, session }, ws, getHostWindow: () => (isLiveWindow(mainWindow) ? mainWindow : null) });
  const embeddedUrl = await embeddedBrowserHost.ready;
  // Canonical values override any legacy environment inherited from another local server.
  const environment = {
    ...process.env, NODE_ENV: 'production', MINGLE_HOST: '127.0.0.1',
    MINGLE_PORT: String(port), PORT: String(port), MINGLE_DATA_DIR: workspaceDataDir,
    MINGLE_WEB_DIST: join(root, 'apps/web/dist'), MINGLE_ALLOWED_ORIGINS: '',
    MINGLE_ACCOUNT_IPC: '1',
    MINGLE_EMBEDDED_BROWSER_URL: embeddedUrl,
    MINGLE_EMBEDDED_BROWSER_TOKEN: embeddedBrowserHost.token,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  if (app.isPackaged) environment.PATH = [dirname(runtimeNode), process.env.PATH || (process.platform === 'win32' ? '' : '/usr/local/bin:/usr/bin:/bin')].join(delimiter);
  const serverArgs = app.isPackaged ? [join(serverRoot, 'dist/index.mjs')] : ['--import', join(serverRoot, 'node_modules/tsx/dist/loader.mjs'), join(serverRoot, 'src/index.ts')];
  backend = spawn(runtimeNode, serverArgs, {
    cwd: app.isPackaged ? userData : root,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const keyReceiver = createAccountKeyIpcHandler({
    getAccountKey,
    send: message => new Promise((resolve, reject) => {
      if (!backend?.connected) return reject(new Error('IPC unavailable'));
      backend.send(message, error => error ? reject(error) : resolve());
    }),
  });
  backend.on('message', keyReceiver);
  let startupErrors = '';
  backend.stdout.on('data', chunk => process.stdout.write(chunk));
  backend.stderr.on('data', chunk => {
    startupErrors = (startupErrors + chunk.toString()).slice(-4000);
    process.stderr.write(chunk);
  });
  backend.on('error', error => {
    if (!quitting) {
      dialog.showErrorBox('Mingle runtime failed', error.message);
      app.quit();
    }
  });
  backend.on('exit', () => {
    if (!quitting && BrowserWindow.getAllWindows().length) {
      dialog.showErrorBox('Mingle runtime stopped', 'The local runtime stopped. Restart Mingle to reconnect your workspace.');
      app.quit();
    }
  });
  try { await waitForBackend(url); }
  catch (error) { throw new Error(`${error.message}\n${startupErrors}`); }
  const window = new BrowserWindow({
    title: 'Mingle', icon: app.isPackaged ? join(root, 'apps/web/dist/mingle-icon.png') : join(root, 'apps/web/public/mingle-icon.png'),
    width: 1540, height: 1000, minWidth: 900, minHeight: 620,
    backgroundColor: '#0a0a0a', autoHideMenuBar: true,
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), 'browser-preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    },
  });
  mainWindow = window;
  configureWorkspaceWindow(window, new URL(url).origin);
  await window.loadURL(projectInvitationDispatcher.getStartupUrl());
  focusMainWindow();
  projectInvitationDispatcher.markWorkspaceReady();
}

function rectIsValid(rect, window) {
  if (!rect || typeof rect !== 'object' || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]) && rect[key] >= 0)) return false;
  const size = window.getContentSize();
  return rect.width > 0 && rect.height > 0 && rect.x + rect.width <= size[0] && rect.y + rect.height <= size[1];
}

function embeddedWindowForSender(sender) {
  const event = { sender, senderFrame: sender?.mainFrame };
  if (!isWorkspaceFrame(event)) return null;
  if (isLiveWindow(mainWindow) && sender === mainWindow.webContents) return mainWindow;
  for (const window of browserWindows.values()) if (isLiveWindow(window) && sender === window.webContents) return window;
  return null;
}

ipcMain.handle('mingle.browser.embedded.show', (event, sessionId, targetId, rect) => {
  const window = embeddedWindowForSender(event.sender);
  if (!window || !SESSION_ID_PATTERN.test(sessionId) || typeof targetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(targetId) || !rectIsValid(rect, window)) return false;
  const item = embeddedBrowserHost?.getSession(sessionId)?.views.get(targetId);
  if (!item) return false;
  const attached = embeddedViewsByWindow.get(window) ?? new Set();
  for (const view of attached) if (view !== item.webContentsView) embeddedBrowserHost.park(view);
  attached.clear();
  embeddedBrowserHost.present(window, item.webContentsView, rect);
  attached.add(item.webContentsView);
  embeddedViewsByWindow.set(window, attached);
  return true;
});

ipcMain.handle('mingle.browser.embedded.hide', (event, sessionId) => {
  const window = embeddedWindowForSender(event.sender);
  if (!window || !SESSION_ID_PATTERN.test(sessionId)) return false;
  const attached = embeddedViewsByWindow.get(window);
  if (!attached) return true;
  const sessionViews = new Set([...(embeddedBrowserHost?.getSession(sessionId)?.views.values() ?? [])].map(item => item.webContentsView));
  for (const view of [...attached]) {
    if (!sessionViews.has(view)) continue;
    embeddedBrowserHost.park(view);
    attached.delete(view);
  }
  return true;
});

function receiveProjectInvitation(value) {
  projectInvitationDispatcher.accept(value);
}

// Protocol links arrive in argv on Linux/Windows cold launches and in open-url
// on macOS. Invalid command-line arguments are ignored without logging them.
for (const argument of process.argv.slice(1)) receiveProjectInvitation(argument);
app.on('open-url', (event, value) => {
  event.preventDefault();
  receiveProjectInvitation(value);
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  if (app.isPackaged && (process.platform === 'linux' || process.platform === 'win32')) {
    try { app.setAsDefaultProtocolClient('mingle'); } catch { /* Native installers also register the packaged handler. */ }
  }
  app.on('second-instance', (_event, argv) => {
    for (const argument of argv) receiveProjectInvitation(argument);
    focusMainWindow();
  });
  app.whenReady().then(openWorkspace).catch(error => {
    dialog.showErrorBox('Could not start Mingle', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  // Runs once the backend has exited (before-quit waits for it), so the server never talks to a closed relay.
  app.on('will-quit', () => { void embeddedBrowserHost?.dispose(); });
  app.on('before-quit', event => {
    quitting = true;
    if (backend && backend.exitCode === null) {
      event.preventDefault();
      if (shutdownPending) return;
      shutdownPending = true;
      const child = backend;
      const forceKill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 38_000);
      child.once('exit', () => {
        clearTimeout(forceKill);
        backend = undefined;
        app.quit();
      });
      child.kill('SIGTERM');
    }
  });
}
