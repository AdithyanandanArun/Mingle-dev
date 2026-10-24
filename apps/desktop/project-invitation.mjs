const INVITATION_PATTERN = /^mingle:(?:\/\/join|join)\/?\?token=([A-Za-z0-9_-]{43,128})(?![\s\S])/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
export const MAX_PENDING_PROJECT_INVITATIONS = 16;

function isCanonicalBase64UrlToken(token) {
  return typeof token === 'string'
    && token.length >= 43
    && token.length <= 128
    && token.length % 4 !== 1
    && /^[A-Za-z0-9_-]+$/.test(token)
    && Buffer.from(token, 'base64url').toString('base64url') === token;
}

/** Accepts the canonical invitation link and common OS/browser slash variants. */
export function parseProjectInvitationUrl(value) {
  if (typeof value !== 'string' || value.length > 160 || value.includes('#') || CONTROL_CHARACTERS.test(value)) return null;
  const match = INVITATION_PATTERN.exec(value);
  return match && isCanonicalBase64UrlToken(match[1]) ? match[1] : null;
}

/** Restores a live window and gives it focus, including when it was hidden or minimized. */
export function focusProjectInvitationWindow(window) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** Builds a renderer handoff URL only for Mingle's local loopback workspace. */
export function createProjectInvitationUrl(workspaceUrl, token) {
  if (!isCanonicalBase64UrlToken(token) || typeof workspaceUrl !== 'string') return null;
  let workspace;
  try { workspace = new URL(workspaceUrl); } catch { return null; }
  if (workspace.protocol !== 'http:' || workspace.hostname !== '127.0.0.1' || workspace.username || workspace.password) return null;
  const target = new URL('/', workspace.origin);
  target.search = `?join=${encodeURIComponent(token)}`;
  return target.href;
}

/** Checks a candidate page against Mingle's exact loopback workspace origin. */
export function isProjectInvitationWorkspaceUrl(candidateUrl, workspaceUrl) {
  if (typeof candidateUrl !== 'string' || typeof workspaceUrl !== 'string') return false;
  let candidate;
  let workspace;
  try {
    candidate = new URL(candidateUrl);
    workspace = new URL(workspaceUrl);
  } catch { return false; }
  return workspace.protocol === 'http:'
    && workspace.hostname === '127.0.0.1'
    && !workspace.username
    && !workspace.password
    && !candidate.username
    && !candidate.password
    && candidate.origin === workspace.origin;
}

/**
 * Uses the first pre-window link as the cold-start URL, then sends all later
 * invitations to the existing window without navigating it.
 */
export function createProjectInvitationDispatcher({ getWorkspaceUrl, getWindow, focusWindow, sendInvitation }) {
  let ready = false;
  let startupUrlClaimed = false;
  let startupToken = null;
  let draining = false;
  const pending = [];
  const queuedTokens = new Set();

  function drain() {
    if (!ready || draining || pending.length === 0) return;
    const window = getWindow();
    if (!window) return;

    draining = true;
    try {
      while (pending.length > 0) {
        const token = pending.shift();
        try {
          focusWindow(window);
          sendInvitation(window, token);
        } catch { /* Failed delivery must not expose invitation data in logs. */ }
        finally {
          queuedTokens.delete(token);
        }
      }
    } finally { draining = false; }
  }

  return Object.freeze({
    accept(value) {
      const token = parseProjectInvitationUrl(value);
      if (!token) return false;
      if (queuedTokens.has(token)) return true;
      if (queuedTokens.size >= MAX_PENDING_PROJECT_INVITATIONS) return false;
      pending.push(token);
      queuedTokens.add(token);
      const window = getWindow();
      if (window && !ready) {
        try { focusWindow(window); } catch { /* Focus is best-effort. */ }
      }
      drain();
      return true;
    },
    getStartupUrl() {
      const workspaceUrl = getWorkspaceUrl();
      if (startupUrlClaimed) return workspaceUrl;
      startupUrlClaimed = true;
      const token = pending.shift();
      if (!token) return workspaceUrl;
      startupToken = token;
      return createProjectInvitationUrl(workspaceUrl, token) ?? workspaceUrl;
    },
    markWorkspaceReady() {
      ready = true;
      if (startupToken) {
        queuedTokens.delete(startupToken);
        startupToken = null;
      }
      drain();
    },
    getPendingCount() { return queuedTokens.size; },
  });
}
