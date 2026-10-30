import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from './relay.mjs';
import { stripUserAgent } from './user-agent.mjs';

const sessionPattern = /^[A-Za-z0-9_-]{1,80}$/;
const wsPathPattern = /^\/devtools\/browser\/[A-Za-z0-9-]{8,80}$/;

export function createEmbeddedBrowserHost({ electron, ws, log = () => undefined }) {
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
    const match = /^\/sessions\/([^/]+)\/browser(?:\/(events))?$/.exec(path);
    if (!match || !sessionPattern.test(match[1])) return reply(res, 400, { error: 'Invalid session id or path' });
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
  function makeSession(id, path, port) {
    const partition = `persist:mingle-browser-${createHash('sha256').update(id).digest('hex').slice(0, 20)}`;
    const ses = electron.session.fromPartition(partition);
    const allowed = permission => permission === 'clipboard-sanitized-write' || permission === 'fullscreen';
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allowed(permission));
    ses.on('will-download', (_event, item) => item.cancel());
    ses.setUserAgent(stripUserAgent(ses.getUserAgent()));
    if (!hostWindow || hostWindow.isDestroyed()) hostWindow = new electron.BrowserWindow({ show: false, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false } });
    const state = { id, partition, ses, views: new Map(), events: new Set(), relay: null, ws: null, path, wsUrl: `ws://127.0.0.1:${port}${path}` };
    const createView = async url => {
      const view = new electron.WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, preload: new URL('./guest-preload.cjs', import.meta.url).pathname } });
      view.webContents.setBackgroundThrottling(false);
      hostWindow.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
      view.webContents.debugger.attach('1.3');
      const info = await view.webContents.debugger.sendCommand('Target.getTargetInfo');
      const item = { targetId: info.targetInfo.targetId, url: () => view.webContents.getURL(), title: () => view.webContents.getTitle(), debugger: view.webContents.debugger, webContentsView: view, agentInputAt: 0, markAgentInput() { item.agentInputAt = Date.now(); } };
      state.views.set(item.targetId, item);
      view.webContents.setWindowOpenHandler(({ url: target, features }) => {
        let parsed; try { parsed = new URL(target); } catch { return { action: 'deny' }; }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { action: 'deny' };
        if (/\b(?:width|height)\s*=/.test(features ?? '')) {
          const popup = new electron.BrowserWindow({ width: 800, height: 600, webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, preload: new URL('./guest-preload.cjs', import.meta.url).pathname } });
          void popup.loadURL(target); return { action: 'allow' };
        }
        void state.relay?.createViewFromOpen(target); return { action: 'deny' };
      });
      view.webContents.on('destroyed', () => { state.views.delete(item.targetId); state.relay?.onViewClosed(item); });
      await view.webContents.loadURL(url);
      return item;
    };
    state.relay = createRelay({ createView, closeView: async targetId => { const item = state.views.get(targetId); if (!item) return; state.views.delete(targetId); item.webContentsView.webContents.close(); }, listViews: () => [...state.views.values()], version: electron.app.getVersion(), userAgent: ses.getUserAgent() });
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
    if (!detail || !['pointer', 'key', 'wheel'].includes(detail.kind)) return;
    const state = [...sessions.values()].find(candidate => [...candidate.views.values()].some(item => item.webContentsView.webContents === event.sender));
    const item = [...(state?.views.values() ?? [])].find(entry => entry.webContentsView.webContents === event.sender);
    if (!state || !item || Date.now() - item.agentInputAt <= 500) return;
    const data = `data: ${JSON.stringify({ type: 'human-input', targetId: item.targetId, kind: detail.kind })}\n\n`;
    for (const client of state.events) client.write(data);
  }
  electron.ipcMain.on('mingle.embedded.human-input', humanInput);
  const ready = new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${http.address().port}`)); });
  return { token, url: ready, ready, async dispose() { if (disposed) return; disposed = true; electron.ipcMain.removeListener('mingle.embedded.human-input', humanInput); await Promise.all([...sessions.values()].map(closeSession)); wss.close(); await new Promise(resolve => http.close(resolve)); if (hostWindow && !hostWindow.isDestroyed()) hostWindow.destroy(); void log; } };
}
