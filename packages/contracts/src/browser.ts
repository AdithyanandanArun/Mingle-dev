import { z } from 'zod';

export interface BrowserSource { id: string; name: string; userDataDir: string; debuggingAvailable: boolean }
/**
 * Linux only (null elsewhere). Ubuntu 23.10+ blocks unprivileged user namespaces through AppArmor unless a profile
 * names the browser binary, which stops a downloaded Chromium's sandbox from starting.
 */
export interface BrowserSandboxStatus {
  /** kernel.apparmor_restrict_unprivileged_userns (or the older unprivileged_userns_clone=0) is in effect. */
  userNamespacesRestricted: boolean;
  /** Mingle's own AppArmor profile for the managed Chromium is installed and names the current executable. */
  profileInstalled: boolean;
  /** One admin prompt (pkexec + apparmor_parser) can install that profile. */
  canInstallProfile: boolean;
  /** The managed Chromium is expected to start with its sandbox on this machine. */
  managedReady: boolean;
  /** Shell commands a person can run themselves instead of the one-click fix; null when nothing is needed. */
  manualFix: string | null;
}
/** A Chromium-family browser installed system-wide that can be used as the managed engine instead of a download. */
export interface SystemBrowser { id: string; name: string; executable: string; sandboxReady: boolean }
export interface BrowserDiscovery {
  sources: BrowserSource[]; managedAvailable: boolean; managedExecutable: string | null;
  installing: boolean; notices: string[];
  sandbox: BrowserSandboxStatus | null;
  systemBrowsers: SystemBrowser[];
}
/** Idle time after a person's last input before a touch claim hands the tab back to the agent. */
export const BROWSER_TOUCH_IDLE_MS = 2500;
/**
 * Who drives a tab. The agent drives by default. Any input from a person claims the tab at once with a `touch`
 * lease that returns to the agent after BROWSER_TOUCH_IDLE_MS without input; `hold` keeps it until released.
 */
export interface BrowserControl {
  owner: 'agent' | 'human';
  /** Stream client id of the person holding the tab; null while the agent drives. */
  holderId: string | null;
  lease: 'touch' | 'hold' | null;
  /** Epoch ms when a touch lease ends if no more input arrives; null for hold and agent. */
  expiresAt: number | null;
}
/** The agent's last pointer position on the page, in viewport pixels, so viewers can see what it is doing. */
export interface BrowserAgentPointer { x: number; y: number; kind: 'move' | 'click' | 'type' | 'scroll'; at: number }
export interface BrowserTab {
  id: string; url: string; title: string; managed: boolean;
  viewport: { width: number; height: number };
  /** @deprecated Same as control.holderId; kept for older clients. */
  controlOwner: string | null;
  control: BrowserControl;
  agentPointer: BrowserAgentPointer | null;
  dialog: { type: string; message: string } | null;
}
export interface BrowserSessionState {
  /** 'signing-in': automation is paused while a normal, non-automated browser window is open on this session's profile. */
  sessionId: string; status: 'disconnected' | 'connecting' | 'connected' | 'signing-in' | 'error';
  mode: 'managed' | 'existing' | null; tabs: BrowserTab[]; activeTabId: string | null;
  error: string | null; notices: string[];
}
export interface BrowserSnapshot {
  tab: BrowserTab; accessibility: string; text: string; truncated: boolean;
  screenshot?: { data: string; mimeType: 'image/png' };
}
export const BrowserConnectSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('managed') }).strict(),
  z.object({ mode: z.literal('existing'), sourceId: z.string().min(1).max(200).optional(), endpoint: z.string().min(1).max(2048).optional(), consent: z.literal(true) }).strict(),
]);
export type BrowserConnect = z.infer<typeof BrowserConnectSchema>;
/** @deprecated Legacy stream URL values remain readable; the server normalizes all viewers to one fixed stream. */
export const BrowserStreamProfileSchema = z.enum(['saver', 'balanced', 'sharp', 'smooth']);
export type BrowserStreamProfile = z.infer<typeof BrowserStreamProfileSchema>;
const target = {
  selector: z.string().min(1).max(2000).optional(), ref: z.string().min(1).max(100).optional(),
  role: z.string().min(1).max(80).optional(), name: z.string().max(500).optional(),
};
const coordinate = z.number().finite().min(0).max(16384);
export const BrowserActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.string().min(1).max(4096) }).strict(),
  z.object({ type: z.enum(['back', 'forward', 'reload', 'close']) }).strict(),
  z.object({ type: z.literal('click'), ...target, x: coordinate.optional(), y: coordinate.optional(), button: z.enum(['left', 'middle', 'right']).optional() }).strict(),
  z.object({ type: z.literal('hover'), ...target }).strict(),
  z.object({ type: z.literal('type'), ...target, text: z.string().max(10000), clear: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('select'), ...target, values: z.array(z.string().max(500)).min(1).max(30) }).strict(),
  z.object({ type: z.literal('press'), key: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('text'), text: z.string().max(10000) }).strict(),
  z.object({ type: z.literal('scroll'), deltaX: z.number().finite().min(-10000).max(10000).default(0), deltaY: z.number().finite().min(-10000).max(10000), x: coordinate.optional(), y: coordinate.optional() }).strict(),
  z.object({ type: z.literal('resize'), width: z.number().int().min(320).max(2560), height: z.number().int().min(240).max(1600) }).strict(),
  z.object({ type: z.literal('evaluate'), expression: z.string().min(1).max(20000) }).strict(),
  z.object({ type: z.literal('wait'), ...target, text: z.string().max(500).optional(), timeoutMs: z.number().int().min(1).max(10000).optional() }).strict(),
  z.object({ type: z.literal('dialog'), accept: z.boolean(), promptText: z.string().max(10000).optional() }).strict(),
  z.object({ type: z.literal('pointer'), phase: z.enum(['move', 'down', 'up']), x: coordinate, y: coordinate, button: z.enum(['left', 'middle', 'right']).optional() }).strict(),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
export const BrowserClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ack'), sequence: z.number().int().min(0) }).strict(),
  /** Explicit control. owner 'human' pins a hold lease; owner 'agent' releases. Plain input claims a touch lease on its own. */
  z.object({ type: z.literal('control'), owner: z.enum(['human', 'agent']) }).strict(),
  z.object({ type: z.literal('input'), action: BrowserActionSchema }).strict(),
]);
export type BrowserServerMessage =
  | { type: 'hello'; clientId: string; tab: BrowserTab }
  | { type: 'state'; tab: BrowserTab }
  | { type: 'frame'; sequence: number; width: number; height: number }
  | { type: 'error'; message: string };
/** Opens a normal (non-automated, headed) browser window on the session's managed profile so a person can sign in to sites that block automated browsers. */
export const BrowserSignInSchema = z.object({ url: z.string().min(1).max(4096).optional() }).strict();
export type BrowserSignIn = z.infer<typeof BrowserSignInSchema>;
/** Ephemeral capability supplied only to a provider process; never persisted or exposed in bootstrap. */
export interface BrowserMcpConnection { url: string; token: string }
