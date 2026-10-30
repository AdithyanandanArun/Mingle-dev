import { randomUUID } from 'node:crypto';

const unsupported = method => ({ code: -32000, message: `Not supported by Mingle's built-in browser: ${method}` });

export function createRelay({ createView, closeView, listViews, version, userAgent, getCookies, setCookies, clearCookies }) {
  const pageSessions = new Map();
  const childSessions = new Map();
  const autoAttachSessions = new Map();
  const browserSessions = new Set();
  const listeners = new Map();
  let socket;
  let discover = false;
  let autoAttach = false;
  let closed = false;
  const send = payload => { if (socket?.readyState === 1) socket.send(JSON.stringify(payload)); };
  const targetInfo = view => ({ targetId: view.targetId, type: 'page', title: view.title(), url: view.url(), attached: true, canAccessOpener: false, browserContextId: 'mingle-default' });
  function announce(view) {
    if (discover) send({ method: 'Target.targetCreated', params: { targetInfo: targetInfo(view) } });
    if (autoAttach) attach(view);
  }
  function attach(view, emitEvent = true) {
    const sessionId = randomUUID();
    pageSessions.set(sessionId, view);
    if (emitEvent) send({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: targetInfo(view), waitingForDebugger: false } });
    return sessionId;
  }
  function unbindView(view) {
    for (const [sid, item] of pageSessions) if (item === view) { send({ method: 'Target.detachedFromTarget', params: { sessionId: sid, targetId: view.targetId } }); pageSessions.delete(sid); }
    for (const [sid, item] of childSessions) if (item === view) childSessions.delete(sid);
    autoAttachSessions.delete(view);
    if (discover) send({ method: 'Target.targetDestroyed', params: { targetId: view.targetId } });
  }
  function onDebugger(view, event, method, params, sessionId) {
    if (sessionId) childSessions.set(sessionId, view);
    // Register iframe/worker sessions as soon as they are announced: Playwright sends them commands before they emit events.
    if (method === 'Target.attachedToTarget' && typeof params?.sessionId === 'string') childSessions.set(params.sessionId, view);
    if (method === 'Target.detachedFromTarget' && typeof params?.sessionId === 'string') childSessions.delete(params.sessionId);
    const pageIds = [...pageSessions].filter(([, item]) => item === view).map(([sid]) => sid);
    const eventName = method ?? event?.method;
    const eventParams = params ?? event?.params ?? {};
    const routedIds = pageIds.length ? pageIds : sessionId ? [sessionId] : [undefined];
    for (const pageId of routedIds) {
      send({ method: eventName, params: eventParams, ...(pageId ? { sessionId: pageId } : {}) });
    }
  }
  function bindView(view) {
    if (listeners.has(view)) return;
    const message = (...args) => onDebugger(view, ...args);
    const detach = () => unbindView(view);
    listeners.set(view, { message, detach });
    view.debugger.on('message', message);
    view.debugger.on('detach', detach);
    announce(view);
  }
  const views = () => { const result = listViews(); for (const view of result) bindView(view); return result; };
  async function handle(message) {
    let request;
    try { request = JSON.parse(String(message)); } catch { return; }
    if (!request || typeof request !== 'object' || !Number.isFinite(request.id)) return;
    const { id, method, params = {}, sessionId } = request;
    const respond = result => send({ id, result: result ?? {}, ...(sessionId ? { sessionId } : {}) });
    const fail = error => send({ id, error: typeof error === 'string' ? unsupported(error) : error, ...(sessionId ? { sessionId } : {}) });
    try {
      if (sessionId && !browserSessions.has(sessionId)) {
        let view = pageSessions.get(sessionId);
        const child = childSessions.has(sessionId);
        if (child) view = childSessions.get(sessionId);
        if (!view) return fail(unsupported(method));
        if (method === 'Runtime.runIfWaitingForDebugger' && !child) return respond({});
        let forwardedParams = params;
        if (method === 'Input.dispatchMouseEvent' || method === 'Input.dispatchKeyEvent' || method === 'Input.dispatchTouchEvent') {
          // Chromium exposes this CDP timestamp as the trusted DOM event's timeStamp.
          // Zero distinguishes Mingle's dispatched input from physical input without a time window.
          forwardedParams = { ...params, timestamp: 0 };
        }
        if (/^(Input\.|Page\.navigate$|Runtime\.(evaluate|callFunctionOn)$)/.test(method)) view.markAgentInput();
        return respond(await view.debugger.sendCommand(method, forwardedParams, child ? sessionId : undefined));
      }
      switch (method) {
        case 'Browser.getVersion': return respond({ protocolVersion: '1.3', product: `Chrome/${version}`, revision: '', userAgent, jsVersion: '' });
        case 'Storage.getCookies': return respond({ cookies: getCookies ? await getCookies() : [] });
        case 'Storage.setCookies': if (setCookies) await setCookies(params.cookies ?? []); return respond({});
        case 'Storage.clearCookies': if (clearCookies) await clearCookies(); return respond({});
        case 'Target.setDiscoverTargets': discover = Boolean(params.discover); if (discover) views().forEach(view => send({ method: 'Target.targetCreated', params: { targetInfo: targetInfo(view) } })); return respond({});
        case 'Target.getTargets': return respond({ targetInfos: views().map(targetInfo) });
        case 'Target.getTargetInfo': { const view = views().find(item => !params.targetId || item.targetId === params.targetId); return respond(view ? { targetInfo: targetInfo(view) } : { targetInfo: { targetId: '', type: 'browser', title: '', url: '', attached: false, canAccessOpener: false, browserContextId: 'mingle-default' } }); }
        case 'Target.setAutoAttach': {
          autoAttach = Boolean(params.autoAttach);
          if (autoAttach) views().forEach(view => {
            if (!autoAttachSessions.has(view)) autoAttachSessions.set(view, attach(view));
          });
          else for (const [view, sessionId] of autoAttachSessions) {
            pageSessions.delete(sessionId);
            send({ method: 'Target.detachedFromTarget', params: { sessionId, targetId: view.targetId } });
          }
          if (!autoAttach) autoAttachSessions.clear();
          return respond({});
        }
        case 'Target.attachToTarget': { const view = views().find(item => item.targetId === params.targetId); if (!view) return respond({ sessionId: '' }); return respond({ sessionId: attach(view, false) }); }
        case 'Target.attachToBrowserTarget': { const browserSession = randomUUID(); browserSessions.add(browserSession); return respond({ sessionId: browserSession }); }
        case 'Target.detachFromTarget': {
          const view = pageSessions.get(params.sessionId);
          pageSessions.delete(params.sessionId);
          if (autoAttachSessions.get(view) === params.sessionId) autoAttachSessions.delete(view);
          send({ method: 'Target.detachedFromTarget', params: { sessionId: params.sessionId, ...(view ? { targetId: view.targetId } : {}) } });
          return respond({});
        }
        case 'Target.createTarget': { const view = await createView(params.url ?? 'about:blank'); if (!listeners.has(view)) bindView(view); return respond({ targetId: view.targetId }); }
        case 'Target.closeTarget': await closeView(params.targetId); return respond({ success: true });
        case 'Target.activateTarget': case 'Browser.setDownloadBehavior': case 'Browser.grantPermissions': case 'Browser.resetPermissions': return respond({});
        case 'Target.getBrowserContexts': return respond({ browserContextIds: [] });
        case 'Browser.getWindowForTarget': return respond({ windowId: 1, bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: 'normal' } });
        default: return fail(method);
      }
    } catch (error) { return fail({ code: -32000, message: error?.message || String(error) }); }
  }
  function attachSocket(ws) {
    socket = ws;
    ws.on('message', handle);
    ws.on('close', () => { if (socket === ws) socket = undefined; });
    views();
  }
  function close() {
    closed = true;
    for (const view of new Set([...pageSessions.values(), ...childSessions.values()])) unbindView(view);
    pageSessions.clear(); childSessions.clear(); browserSessions.clear();
    for (const [view, { message, detach }] of listeners) {
      view.debugger.removeListener?.('message', message);
      view.debugger.removeListener?.('detach', detach);
    }
    listeners.clear(); socket?.close(); socket = undefined;
  }
  return { attachSocket, handle, close, announce, onViewClosed: unbindView, get closed() { return closed; } };
}
