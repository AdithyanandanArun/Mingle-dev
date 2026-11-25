import { randomUUID } from 'node:crypto';

const unsupported = method => ({ code: -32000, message: `Not supported by Mingle's built-in browser: ${method}` });
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_OBJECT_CONSOLE_EVENTS = 32;

export function createRelay({ createView, closeView, listViews, version, userAgent, getCookies, setCookies, clearCookies }) {
  const pageSessions = new Map();
  // Event routing is per view. Keep its aliases indexed so a busy page does
  // not scan every session attached to unrelated pages for each CDP event.
  const pageSessionsByView = new Map();
  const childSessions = new Map();
  const autoAttachSessions = new Map();
  const browserSessions = new Set();
  const listeners = new Map();
  const screencasts = new Map();
  const consoleBuffers = new Map();
  const pageConsole = Symbol('page console');
  let frameSequence = 0;
  let socket;
  let discover = false;
  let autoAttach = false;
  let closed = false;
  const send = payload => {
    if (socket?.readyState !== 1) return;
    // CDP carries all page traffic. If the server stops reading, disconnect
    // rather than building an unbounded queue or dropping protocol events.
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) { socket.terminate(); return; }
    socket.send(JSON.stringify(payload));
  };
  const targetInfo = view => ({ targetId: view.targetId, type: 'page', title: view.title(), url: view.url(), attached: true, canAccessOpener: false, browserContextId: 'mingle-default' });
  function announce(view) {
    if (discover) send({ method: 'Target.targetCreated', params: { targetInfo: targetInfo(view) } });
    if (autoAttach) attach(view);
  }
  function attach(view, emitEvent = true) {
    const sessionId = randomUUID();
    pageSessions.set(sessionId, view);
    let aliases = pageSessionsByView.get(view);
    if (!aliases) pageSessionsByView.set(view, aliases = new Set());
    aliases.add(sessionId);
    if (emitEvent) send({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: targetInfo(view), waitingForDebugger: false } });
    return sessionId;
  }
  function detachPageSession(sessionId) {
    const view = pageSessions.get(sessionId);
    if (!view) return;
    pageSessions.delete(sessionId);
    const aliases = pageSessionsByView.get(view);
    aliases?.delete(sessionId);
    if (!aliases?.size) pageSessionsByView.delete(view);
  }
  function unbindView(view) {
    const handlers = listeners.get(view);
    if (!handlers) return;
    listeners.delete(view);
    view.debugger.removeListener('message', handlers.message);
    view.debugger.removeListener('detach', handlers.detach);
    screencasts.delete(view);
    consoleBuffers.delete(view);
    for (const sid of [...(pageSessionsByView.get(view) ?? [])]) { send({ method: 'Target.detachedFromTarget', params: { sessionId: sid, targetId: view.targetId } }); detachPageSession(sid); }
    for (const [sid, item] of childSessions) if (item === view) childSessions.delete(sid);
    autoAttachSessions.delete(view);
    if (discover) send({ method: 'Target.targetDestroyed', params: { targetId: view.targetId } });
  }
  function accountForConsoleObjects(view, sessionId, args) {
    if (!Array.isArray(args)) return false;
    const count = args.filter(value => typeof value?.objectId === 'string').length;
    if (!count) return false;
    const key = sessionId || pageConsole;
    const target = sessionId ? [sessionId] : [];
    let buffers = consoleBuffers.get(view);
    if (!buffers) consoleBuffers.set(view, buffers = new Map());
    let buffer = buffers.get(key);
    if (!buffer) buffers.set(key, buffer = { count: 0, clearing: false });
    buffer.count += count;
    const prune = () => {
      if (buffer.clearing || buffer.count < MAX_OBJECT_CONSOLE_EVENTS || consoleBuffers.get(view)?.get(key) !== buffer) return;
      buffer.count = 0;
      buffer.clearing = true;
      // Inspector console history retains the actual logged object graphs. Mingle
      // has no console viewer. Release inspector handles and history after a burst.
      void view.debugger.sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'console' }, ...target).catch(() => undefined)
        .then(() => view.debugger.sendCommand('Runtime.discardConsoleEntries', {}, ...target))
        .catch(() => undefined)
        .finally(() => { buffer.clearing = false; prune(); });
    };
    prune();
    return true;
  }
  function acknowledge(view, cast) {
    const frame = cast.frame;
    if (!frame || frame.waiting.size) return;
    cast.frame = null;
    return view.debugger.sendCommand('Page.screencastFrameAck', { sessionId: frame.chromeSession });
  }
  async function removeViewer(view, sessionId) {
    const cast = screencasts.get(view);
    if (!cast?.viewers.delete(sessionId)) return;
    if (!cast.viewers.size) {
      screencasts.delete(view);
      await view.debugger.sendCommand('Page.stopScreencast');
    } else if (cast.frame?.waiting.delete(sessionId)) {
      await acknowledge(view, cast);
    }
  }
  function stopScreencasts() {
    for (const view of screencasts.keys()) void view.debugger.sendCommand('Page.stopScreencast').catch(() => undefined);
    screencasts.clear();
  }
  async function handleScreencast(view, sessionId, method, params) {
    let cast = screencasts.get(view);
    if (method === 'Page.startScreencast') {
      if (!cast) {
        // Multiple page aliases share a single real Electron debugger session.
        cast = { viewers: new Set(), frame: null, ready: view.debugger.sendCommand(method, { ...params, maxFramesInFlight: 1 }) };
        screencasts.set(view, cast);
      }
      cast.viewers.add(sessionId);
      try {
        return await cast.ready;
      } catch (error) {
        if (screencasts.get(view) === cast) screencasts.delete(view);
        throw error;
      }
    }
    if (method === 'Page.stopScreencast') return removeViewer(view, sessionId);
    const frame = cast?.frame;
    if (frame?.sequence === params.sessionId && frame.waiting.delete(sessionId)) return acknowledge(view, cast);
  }
  function onDebugger(view, event, method, params, sessionId) {
    if (sessionId) childSessions.set(sessionId, view);
    // Register iframe/worker sessions as soon as they are announced: Playwright sends them commands before they emit events.
    if (method === 'Target.attachedToTarget' && typeof params?.sessionId === 'string') childSessions.set(params.sessionId, view);
    if (method === 'Target.detachedFromTarget' && typeof params?.sessionId === 'string') {
      childSessions.delete(params.sessionId);
      consoleBuffers.get(view)?.delete(params.sessionId);
    }
    const eventName = method ?? event?.method;
    const eventParams = params ?? event?.params ?? {};
    // Keep primitive logs, including Playwright's internal console markers.
    // Object previews can be large and Mingle has no consumer for their handles.
    if (eventName === 'Runtime.consoleAPICalled' && accountForConsoleObjects(view, sessionId, eventParams.args)) return;
    if (!sessionId && eventName === 'Page.screencastFrame') {
      const cast = screencasts.get(view);
      if (!cast || cast.frame) return;
      const sequence = ++frameSequence;
      cast.frame = { sequence, chromeSession: eventParams.sessionId, waiting: new Set(cast.viewers) };
      // The normal Playwright page alias automatically acknowledges any frame
      // it receives. Send frames only to the aliases that started the cast.
      for (const viewer of cast.viewers) send({ method: eventName, params: { ...eventParams, sessionId: sequence }, sessionId: viewer });
      return;
    }
    // Iframe/worker events already belong to a real child CDP session. Only the
    // page's root events fan out to the outer aliases attached to that page.
    const pageIds = sessionId ? [] : [...(pageSessionsByView.get(view) ?? [])];
    const routedIds = sessionId ? [sessionId] : pageIds.length ? pageIds : [undefined];
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
        if (!child && ['Page.startScreencast', 'Page.stopScreencast', 'Page.screencastFrameAck'].includes(method)) {
          return respond(await handleScreencast(view, sessionId, method, params));
        }
        if (method === 'Runtime.runIfWaitingForDebugger' && !child) return respond({});
        // Chromium's soft-navigation metrics require real, ordered event
        // timestamps. Attribute synthetic input in the host without stamping it.
        const release = view.beginSyntheticInput?.(method, params);
        try {
          return respond(await view.debugger.sendCommand(method, params, child ? sessionId : undefined));
        } finally {
          release?.();
        }
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
            detachPageSession(sessionId);
            void removeViewer(view, sessionId).catch(() => undefined);
            send({ method: 'Target.detachedFromTarget', params: { sessionId, targetId: view.targetId } });
          }
          if (!autoAttach) autoAttachSessions.clear();
          return respond({});
        }
        case 'Target.attachToTarget': { const view = views().find(item => item.targetId === params.targetId); if (!view) return respond({ sessionId: '' }); return respond({ sessionId: attach(view, false) }); }
        case 'Target.attachToBrowserTarget': { const browserSession = randomUUID(); browserSessions.add(browserSession); return respond({ sessionId: browserSession }); }
        case 'Target.detachFromTarget': {
          const view = pageSessions.get(params.sessionId);
          detachPageSession(params.sessionId);
          if (autoAttachSessions.get(view) === params.sessionId) autoAttachSessions.delete(view);
          if (view) await removeViewer(view, params.sessionId).catch(() => undefined);
          send({ method: 'Target.detachedFromTarget', params: { sessionId: params.sessionId, ...(view ? { targetId: view.targetId } : {}) }, ...(sessionId ? { sessionId } : {}) });
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
    stopScreencasts();
    socket = ws;
    ws.on('message', message => { if (socket === ws) void handle(message); });
    ws.on('close', () => { if (socket === ws) { socket = undefined; stopScreencasts(); } });
    views();
  }
  function close() {
    closed = true;
    stopScreencasts();
    for (const view of listeners.keys()) unbindView(view);
    pageSessions.clear(); pageSessionsByView.clear(); childSessions.clear(); browserSessions.clear();
    socket?.close(); socket = undefined;
    consoleBuffers.clear();
  }
  return { attachSocket, handle, close, announce, onViewClosed: unbindView, get closed() { return closed; } };
}
