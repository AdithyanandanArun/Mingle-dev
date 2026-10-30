const { contextBridge, ipcRenderer } = require('electron');

const sessionPattern = /^[A-Za-z0-9_-]{1,80}$/;
const listeners = new Set();
const projectInvitationTokenPattern = /^[A-Za-z0-9_-]{43,128}$/;
const maxPendingProjectInvitations = 16;
const targetPattern = /^[A-Za-z0-9_-]{1,128}$/;
const projectInvitationListeners = new Set();
const pendingProjectInvitations = [];
const pendingProjectInvitationTokens = new Set();

// The main process enforces canonical base64url bytes. Sandboxed Electron preload Buffer shims
// do not necessarily implement Node's base64url encoding, so this boundary checks its safe shape.
function isProjectInvitationToken(token) {
  return typeof token === 'string'
    && projectInvitationTokenPattern.test(token)
    && token.length % 4 !== 1;
}

function notifyProjectInvitation(listener, token) {
  try { listener(token); } catch { /* Keep a renderer callback from blocking other listeners. */ }
}

ipcRenderer.on('mingle.project-invitation', (_event, token) => {
  if (!isProjectInvitationToken(token)) return;
  if (projectInvitationListeners.size > 0) {
    for (const listener of [...projectInvitationListeners]) notifyProjectInvitation(listener, token);
    return;
  }
  if (pendingProjectInvitationTokens.has(token) || pendingProjectInvitations.length >= maxPendingProjectInvitations) return;
  pendingProjectInvitationTokens.add(token);
  pendingProjectInvitations.push(token);
});

ipcRenderer.on('mingle.browser.popout.closed', (_event, sessionId) => {
  if (typeof sessionId !== 'string' || !sessionPattern.test(sessionId)) return;
  for (const listener of listeners) listener(sessionId);
});

contextBridge.exposeInMainWorld('mingleBrowserDesktop', Object.freeze({
  openPopout: (sessionId) => sessionPattern.test(sessionId) ? ipcRenderer.invoke('mingle.browser.open-popout', sessionId) : Promise.resolve(false),
  isPopoutOpen: (sessionId) => sessionPattern.test(sessionId) ? ipcRenderer.invoke('mingle.browser.is-popout-open', sessionId) : Promise.resolve(false),
  focusPopout: (sessionId) => sessionPattern.test(sessionId) ? ipcRenderer.invoke('mingle.browser.focus-popout', sessionId) : Promise.resolve(false),
  dockPopout: (sessionId) => sessionId === undefined || sessionPattern.test(sessionId)
    ? ipcRenderer.invoke('mingle.browser.dock-popout', sessionId)
    : Promise.resolve(false),
  embedded: Object.freeze({
    show: (sessionId, targetId, rect) => sessionPattern.test(sessionId) && targetPattern.test(targetId)
      && rect && typeof rect === 'object' && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]) && rect[key] >= 0)
      ? ipcRenderer.invoke('mingle.browser.embedded.show', sessionId, targetId, rect)
      : Promise.resolve(false),
    hide: sessionId => sessionPattern.test(sessionId) ? ipcRenderer.invoke('mingle.browser.embedded.hide', sessionId) : Promise.resolve(false),
  }),
  onPopoutClosed: (listener) => {
    if (typeof listener !== 'function') return () => undefined;
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));

contextBridge.exposeInMainWorld('mingleProjectInvitations', Object.freeze({
  onInvitation: (listener) => {
    if (typeof listener !== 'function') return () => undefined;
    projectInvitationListeners.add(listener);
    if (pendingProjectInvitations.length > 0) {
      const queued = pendingProjectInvitations.splice(0);
      pendingProjectInvitationTokens.clear();
      for (const token of queued) notifyProjectInvitation(listener, token);
    }
    return () => projectInvitationListeners.delete(listener);
  },
}));
