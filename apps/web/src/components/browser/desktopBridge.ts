export interface BrowserDesktopBridge {
  chooseCredentialStore(backend: string): Promise<boolean>;
  credentialStoreState(): Promise<{ available: string[]; selected: string | null; chosenBy: 'auto' | 'user' } | null>;
  restartForCredentialStore(): Promise<boolean>;
  openPopout(sessionId: string): Promise<boolean>;
  isPopoutOpen(sessionId: string): Promise<boolean>;
  focusPopout(sessionId: string): Promise<boolean>;
  dockPopout(sessionId?: string): Promise<boolean>;
  onPopoutClosed(listener: (sessionId: string) => void): () => void;
  embedded: {
    show(sessionId: string, targetId: string, rect: { x: number; y: number; width: number; height: number }): Promise<boolean>;
    hide(sessionId: string): Promise<boolean>;
  };
}

declare global {
  interface Window { mingleBrowserDesktop?: BrowserDesktopBridge }
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
const TARGET_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function canShowEmbedded(): boolean {
  return typeof window !== 'undefined' && Boolean(window.mingleBrowserDesktop?.embedded);
}

export async function showEmbedded(sessionId: string, targetId: string, rect: { x: number; y: number; width: number; height: number }): Promise<boolean> {
  if (!SESSION_ID.test(sessionId) || !TARGET_ID.test(targetId) || !Object.values(rect).every((v) => Number.isFinite(v) && v >= 0)) return false;
  return window.mingleBrowserDesktop?.embedded.show(sessionId, targetId, rect) ?? false;
}

export async function hideEmbedded(sessionId: string): Promise<boolean> {
  if (!SESSION_ID.test(sessionId)) return false;
  return window.mingleBrowserDesktop?.embedded.hide(sessionId) ?? false;
}

export function canOpenBrowserPopout(): boolean {
  return typeof window !== 'undefined' && Boolean(window.mingleBrowserDesktop);
}

export async function openBrowserPopout(sessionId: string): Promise<boolean> {
  if (!SESSION_ID.test(sessionId)) return false;
  return window.mingleBrowserDesktop?.openPopout(sessionId) ?? false;
}

export async function isBrowserPopoutOpen(sessionId: string): Promise<boolean> {
  if (!SESSION_ID.test(sessionId)) return false;
  return window.mingleBrowserDesktop?.isPopoutOpen(sessionId) ?? false;
}

export async function focusBrowserPopout(sessionId: string): Promise<boolean> {
  if (!SESSION_ID.test(sessionId)) return false;
  return window.mingleBrowserDesktop?.focusPopout(sessionId) ?? false;
}

export async function dockBrowserPopout(sessionId?: string): Promise<boolean> {
  if (sessionId !== undefined && !SESSION_ID.test(sessionId)) return false;
  return window.mingleBrowserDesktop?.dockPopout(sessionId) ?? false;
}

export function onBrowserPopoutClosed(listener: (sessionId: string) => void): () => void {
  return window.mingleBrowserDesktop?.onPopoutClosed(listener) ?? (() => undefined);
}
