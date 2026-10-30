import { randomUUID } from 'node:crypto';

const unsupported = method => ({ code: -32000, message: `Not supported by Mingle's built-in browser: ${method}` });

export function createRelay({ createView, closeView, listViews, version, userAgent }) {
  const pageSessions = new Map();
  const childSessions = new Map();
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
  function attach(view) {
    let sessionId = [...pageSessions].find(([, item]) => item === view)?.[0];
    if (!sessionId) { sessionId = randomUUID(); pageSessions.set(sessionId, view); }
    send({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: targetInfo(view), waitingForDebugger: false } });
    return sessionId;
  }
  function unbindView(view) {
    for (const [sid, item] of pageSessions) if (item === view) { send({ method: 'Target.detachedFromTarget', params: { sessionId: sid, targetId: view.targetId } }); pageSessions.delete(sid); }
    for (const [sid, item] of childSessions) if (item === view) childSessions.delete(sid);
    if (discover) send({ method: 'Target.targetDestroyed', params: { targetId: view.targetId } });
  }
  function onDebugger(view, event, method, params, sessionId) {
    if (sessionId) childSessions.set(sessionId, view);
    const pageId = [...pageSessions].find(([, item]) => item === view)?.[0];
    send({ method: method ?? event?.method, params: params ?? event?.params ?? {}, ...(sessionId ? { sessionId } : pageId ? { sessionId: pageId } : {}) });
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
      if (sessionId) {
        let view = pageSessions.get(sessionId);
        const child = childSessions.has(sessionId);
        if (child) view = childSessions.get(sessionId);
        if (!view) return fail(unsupported(method));
        if (method === 'Runtime.runIfWaitingForDebugger' && !child) return respond({});
        if (/^(Input\.|Page\.navigate$|Runtime\.(evaluate|callFunctionOn)$)/.test(method)) view.markAgentInput();
        return respond(await view.debugger.sendCommand(method, params, child ? sessionId : undefined));
      }
      switch (method) {
        case 'Browser.getVersion': return respond({ protocolVersion: '1.3', product: `Chrome/${version}`, revision: '', userAgent, jsVersion: '' });
        case 'Target.setDiscoverTargets': discover = Boolean(params.discover); if (discover) views().forEach(view => send({ method: 'Target.targetCreated', params: { targetInfo: targetInfo(view) } })); return respond({});
        case 'Target.getTargets': return respond({ targetInfos: views().map(targetInfo) });
        case 'Target.setAutoAttach': autoAttach = Boolean(params.autoAttach); if (autoAttach) views().forEach(attach); return respond({});
        case 'Target.attachToTarget': { const view = views().find(item => item.targetId === params.targetId); if (!view) return respond({ sessionId: '' }); return respond({ sessionId: attach(view) }); }
        case 'Target.detachFromTarget': pageSessions.delete(params.sessionId); send({ method: 'Target.detachedFromTarget', params: { sessionId: params.sessionId } }); return respond({});
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
    pageSessions.clear(); childSessions.clear();
    for (const [view, { message, detach }] of listeners) {
      view.debugger.removeListener?.('message', message);
      view.debugger.removeListener?.('detach', detach);
    }
    listeners.clear(); socket?.close(); socket = undefined;
  }
  return { attachSocket, handle, close, announce, onViewClosed: unbindView, get closed() { return closed; } };
}
