import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from './relay.mjs';
import { stripUserAgent } from './user-agent.mjs';

export function electronCookieToCdp(cookie) {
  return { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, expires: cookie.expirationDate ?? -1,
    httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite === 'strict' ? 'Strict' : cookie.sameSite === 'no_restriction' ? 'None' : cookie.sameSite === 'lax' ? 'Lax' : undefined };
}
export function cdpCookieToElectron(cookie) {
  const domain = String(cookie.domain ?? '').replace(/^\./, '');
  const hostPrefix = cookie.name?.startsWith('__Host-') === true;
  const secure = Boolean(cookie.secure) || hostPrefix;
  const path = cookie.path || '/';
  const url = `${secure ? 'https' : 'http'}://${domain}${path.startsWith('/') ? path : `/${path}`}`;
  // Chromium marks domain cookies with a leading dot; a bare host is host-only.
  const hostOnly = cookie.hostOnly === true || !cookie.domain || !String(cookie.domain).startsWith('.') || hostPrefix;
  return { url, name: cookie.name, value: cookie.value, path, ...(!hostOnly && cookie.domain ? { domain: cookie.domain } : {}), secure,
    httpOnly: Boolean(cookie.httpOnly), ...(Number.isFinite(cookie.expires) && cookie.expires >= 0 ? { expirationDate: cookie.expires } : {}),
    ...(cookie.sameSite ? { sameSite: cookie.sameSite === 'Strict' ? 'strict' : cookie.sameSite === 'None' ? 'no_restriction' : 'lax' } : {}) };
}

const sessionPattern = /^[A-Za-z0-9_-]{1,80}$/;
const wsPathPattern = /^\/devtools\/browser\/[A-Za-z0-9-]{8,80}$/;

/** Size background tabs render at while nobody is looking at them. */
const PARKED_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 };

/** Apply a hide only while the hiding window still owns the native view. */
export function hideOwnedEmbeddedView(window, view, park) {
  if (view.parentWindow !== window) return false;
  park(view);
  return true;
}

/**
 * Background tabs are parked beneath the app's own UI inside `getHostWindow()` (normally the main window), so they keep
 * painting for screenshots and screencasts without a separate window (Wayland compositors ignore off-screen positions
 * and would show such a window). A hidden fallback window is used only when no app window exists (smoke tests).
 */
export function createEmbeddedBrowserHost({ electron, ws, log = () => undefined, getHostWindow = () => null }) {
  const token = randomBytes(32).toString('hex');
  const sessions = new Map();
  const issuedPaths = new Map();
  const http = createServer((req, res) => void handleHttp(req, res));
  const wss = new (ws.WebSocketServer ?? ws.Server)({ noServer: true });
  let hostWindow;
  let disposed = false;

  function authenticated(req, port) {
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
    return req.headers.host === `127.0.0.1:${port}` && req.headers.origin === undefined
      && actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  function reply(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }
  async function handleHttp(req, res) {
    const addr = http.address(); const port = addr && typeof addr !== 'string' ? addr.port : 0;
    if (!authenticated(req, port)) return reply(res, req.headers.origin === undefined ? 401 : 403, { error: 'Unauthorized' });
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    const presentationMatch = /^\/sessions\/([^/]+)\/browser\/targets\/([^/]+)\/presentation$/.exec(path);
    const match = /^\/sessions\/([^/]+)\/browser(?:\/(events))?$/.exec(path);
    if (!presentationMatch && (!match || !sessionPattern.test(match[1]))) return reply(res, 400, { error: 'Invalid session id or path' });
    if (presentationMatch && (!sessionPattern.test(presentationMatch[1]) || !/^[A-Za-z0-9_-]{1,128}$/.test(presentationMatch[2]))) return reply(res, 400, { error: 'Invalid session id or target id' });
    if (presentationMatch) {
      if (req.method !== 'GET') return reply(res, 404, { error: 'Not found' });
      const [, id, targetId] = presentationMatch;
      const state = sessions.get(id);
      const item = state?.views.get(targetId);
      const view = item?.webContentsView;
      const contents = view?.webContents;
      const visible = Boolean(state && item && contents && !contents.isDestroyed?.() && state.presentedTargetId === targetId && state.presentedView === view && state.presentedWindow && view.parentWindow === state.presentedWindow && !state.presentedWindow.isDestroyed?.());
      return reply(res, 200, { visible });
    }
    const [, id, events] = match;
    if (req.method === 'GET' && events) {
      const state = sessions.get(id); if (!state) return reply(res, 404, { error: 'Session not found' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      state.events.add(res); res.write(': connected\n\n'); res.on('close', () => state.events.delete(res)); return;
    }
    if (req.method === 'POST' && !events) {
      let state = sessions.get(id);
      if (!state || state.relay.closed) {
        const devtoolsPath = `/devtools/browser/${randomUUID()}`;
        state = makeSession(id, devtoolsPath, port); sessions.set(id, state); issuedPaths.set(devtoolsPath, state);
      }
      return reply(res, 200, { wsUrl: state.wsUrl });
    }
    if (req.method === 'DELETE' && !events) { const state = sessions.get(id); if (state) await closeSession(state); return reply(res, 200, { success: true }); }
    return reply(res, 404, { error: 'Not found' });
  }
  function parkingWindow() {
    const preferred = getHostWindow();
    if (preferred && !preferred.isDestroyed()) return preferred;
    if (!hostWindow || hostWindow.isDestroyed()) {
      hostWindow = new electron.BrowserWindow({ show: false, paintWhenInitiallyHidden: true, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } });
      hostWindow.showInactive?.();
    }
    return hostWindow;
  }
  /** Moves a view beneath the parking window's own content (index 0), at the background size. */
  function park(view) {
    const owner = view.parentWindow;
    const ownerState = [...sessions.values()].find(state => state.presentedView === view);
    if (ownerState) { ownerState.presentedView = null; ownerState.presentedTargetId = null; ownerState.presentedWindow = null; }
    const target = parkingWindow();
    view.parentWindow = target;
    for (const window of electron.BrowserWindow.getAllWindows()) if (window !== target && !window.isDestroyed()) { try { window.contentView.removeChildView(view); } catch {} }
    target.contentView.addChildView(view, 0);
    view.setBounds(PARKED_BOUNDS);
  }
  /** Shows a view on top of `window`'s content at `rect` (CSS px of that window). */
  function present(window, view, rect, state, targetId) {
    for (const other of electron.BrowserWindow.getAllWindows()) if (other !== window && !other.isDestroyed()) { try { other.contentView.removeChildView(view); } catch {} }
    window.contentView.addChildView(view);
    view.parentWindow = window;
    view.setBounds(rect);
    state.presentedView = view;
    state.presentedTargetId = targetId;
    state.presentedWindow = window;
  }
  function makeSession(id, path, port) {
    const partition = `persist:mingle-browser-${createHash('sha256').update(id).digest('hex').slice(0, 20)}`;
    const ses = electron.session.fromPartition(partition);
    const allowed = permission => permission === 'clipboard-sanitized-write' || permission === 'fullscreen';
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allowed(permission));
    ses.on('will-download', (_event, item) => item.cancel());
    ses.setUserAgent(stripUserAgent(ses.getUserAgent()));
    const state = { id, partition, ses, views: new Map(), events: new Set(), relay: null, ws: null, path, wsUrl: `ws://127.0.0.1:${port}${path}`, presentedView: null, presentedTargetId: null, presentedWindow: null };
    const createView = async url => {
      const view = new electron.WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, preload: fileURLToPath(new URL('./guest-preload.cjs', import.meta.url)) } });
      view.webContents.setBackgroundThrottling(false);
      park(view);
      view.webContents.debugger.attach('1.3');
      const info = await view.webContents.debugger.sendCommand('Target.getTargetInfo');
      const item = { targetId: info.targetInfo.targetId, url: () => view.webContents.getURL(), title: () => view.webContents.getTitle(), debugger: view.webContents.debugger, webContentsView: view, markAgentInput() {} };
      view.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape' && input.alt && input.shift) {
          event.preventDefault();
          (view.parentWindow ?? getHostWindow())?.webContents?.focus?.();
        }
      });
      state.views.set(item.targetId, item);
      view.webContents.setWindowOpenHandler(({ url: target, features }) => {
        let parsed; try { parsed = new URL(target); } catch { return { action: 'deny' }; }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { action: 'deny' };
        if (/\b(?:width|height)\s*=/.test(features ?? '')) {
          return { action: 'allow', overrideBrowserWindowOptions: { width: 800, height: 600, webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, preload: fileURLToPath(new URL('./guest-preload.cjs', import.meta.url)) } } };
        }
        void state.relay?.createViewFromOpen(target); return { action: 'deny' };
      });
      view.webContents.on('destroyed', () => { state.views.delete(item.targetId); state.relay?.onViewClosed(item); });
      await view.webContents.loadURL(url);
      view.webContents.startPainting?.();
      view.webContents.invalidate?.();
      return item;
    };
    state.relay = createRelay({ createView, closeView: async targetId => { const item = state.views.get(targetId); if (!item) return; state.views.delete(targetId); item.webContentsView.webContents.close(); }, listViews: () => [...state.views.values()], version: process.versions.chrome, userAgent: ses.getUserAgent(),
      getCookies: async () => (await ses.cookies.get({})).map(electronCookieToCdp),
      setCookies: async cookies => { for (const cookie of cookies) await ses.cookies.set(cdpCookieToElectron(cookie)); },
      clearCookies: async () => { await ses.clearStorageData({ storages: ['cookies'] }); } });
    state.relay.createViewFromOpen = createView;
    return state;
  }
  async function closeSession(state) {
    sessions.delete(state.id); issuedPaths.delete(state.path); state.ws?.close();
    for (const item of [...state.views.values()]) { try { item.webContentsView.webContents.close(); } catch {} }
    state.views.clear(); state.relay.close(); for (const res of state.events) res.end(); state.events.clear();
  }
  http.on('upgrade', (req, socket, head) => {
    const addr = http.address(); const port = addr && typeof addr !== 'string' ? addr.port : 0;
    if (!authenticated(req, port) || !wsPathPattern.test(req.url) || req.headers.origin !== undefined) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    const state = issuedPaths.get(req.url);
    if (!state) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, client => { state.ws?.close(); state.ws = client; state.relay.attachSocket(client); });
  });
  function humanInput(event, detail) {
    if (!detail || !['pointer', 'key', 'wheel'].includes(detail.kind) || !isHumanInputEvent({ isTrusted: true, timeStamp: detail.timeStamp })) return;
    const state = [...sessions.values()].find(candidate => [...candidate.views.values()].some(item => item.webContentsView.webContents === event.sender));
    const item = [...(state?.views.values() ?? [])].find(entry => entry.webContentsView.webContents === event.sender);
    if (!state || !item) return;
    const phase = detail.kind === 'pointer' && ['down', 'up'].includes(detail.phase) ? detail.phase : undefined;
    const data = `data: ${JSON.stringify({ type: 'human-input', targetId: item.targetId, kind: detail.kind, ...(phase ? { phase } : {}) })}\n\n`;
    for (const client of state.events) client.write(data);
  }
  function isHumanInputEvent(event) { return event?.isTrusted === true && Number.isFinite(event.timeStamp) && event.timeStamp > 0; }
  electron.ipcMain.on('mingle.embedded.human-input', humanInput);
  const ready = new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${http.address().port}`)); });
  return { token, url: ready, ready, getSession: id => sessions.get(id), park, present, isHumanInputEvent, setPresented(sessionId, targetId, window, view, rect) { const state = sessions.get(sessionId); if (!state || state.views.get(targetId)?.webContentsView !== view || !view?.webContents || view.webContents.isDestroyed?.() || !window || window.isDestroyed?.()) return false; present(window, view, rect, state, targetId); return true; }, async dispose() { if (disposed) return; disposed = true; electron.ipcMain.removeListener('mingle.embedded.human-input', humanInput); await Promise.all([...sessions.values()].map(closeSession)); wss.close(); await new Promise(resolve => http.close(resolve)); if (hostWindow && !hostWindow.isDestroyed()) hostWindow.destroy(); void log; } };
}
