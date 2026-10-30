import { randomBytes } from 'node:crypto';
import type { BrowserTab } from '@mingle/contracts';
import type { BrowserAgentPointer } from '@mingle/contracts';
import { TabControl } from './control.ts';
import { DEFAULT_VIEWPORT, DETACH_TIMEOUT_MS } from './limits.ts';
import type { Dialog, Page } from './playwright.ts';

export type MouseButton = 'left' | 'middle' | 'right';

export interface TabSubscriber {
  state(tab: BrowserTab): void;
  closed(reason: string): void;
}

/** A stream viewer attached to a tab (a WebSocket with its screencast); closed when the tab or session goes away. */
export interface ViewerHandle {
  close(reason: string): Promise<void>;
}

/** Everything Mingle tracks for one browser page. */
export class TabEntry {
  readonly id = `tab_${randomBytes(6).toString('hex')}`;
  readonly control: TabControl;
  agentPointer: BrowserAgentPointer | null = null;
  title = '';
  reusable = false;
  viewport: { width: number; height: number } = { ...DEFAULT_VIEWPORT };
  dialog: { type: string; message: string; handle: Dialog } | null = null;
  readonly pressed = new Set<MouseButton>();
  /** Counter for snapshots of this tab; scoped refs carry the number of the snapshot they came from. */
  snapshotCounter = 0;
  /** Number of the latest completed snapshot whose refs may be used; null while one is running or after one failed. */
  liveSnapshot: number | null = null;
  navigationVersion = 0;
  /** An action that had already begun when a JavaScript dialog interrupted it; it finishes once the dialog is answered. */
  begun: Promise<void> | null = null;
  /** Removes the page listeners installed for this entry (set by the session runtime). */
  unwire: (() => void) | null = null;
  private snapshotTail: Promise<unknown> = Promise.resolve();
  private readonly subscribers = new Set<TabSubscriber>();
  private readonly viewers = new Set<ViewerHandle>();
  private readonly dialogWaiters = new Set<() => void>();
  private ended = false;

  constructor(readonly page: Page, readonly managed: boolean, readonly targetId: string | null, readonly embedded = false) {
    this.control = new TabControl(() => this.releaseInput(), () => this.touch());
    const size = page.viewportSize();
    if (size) this.viewport = { ...size };
  }

  describe(): BrowserTab {
    return {
      id: this.id,
      url: this.page.url(),
      title: this.title,
      managed: this.managed,
      viewport: { ...this.viewport },
      controlOwner: this.control.ownerId,
      control: { owner: this.control.ownerId ? 'human' : 'agent', holderId: this.control.ownerId, lease: this.control.lease, expiresAt: this.control.expiresAt },
      agentPointer: this.agentPointer,
      embeddedTargetId: this.embedded ? this.targetId : null,
      dialog: this.dialog ? { type: this.dialog.type, message: this.dialog.message } : null,
    };
  }

  /** Snapshots of one tab run one at a time so the refs of the newest snapshot are unambiguous. */
  serializeSnapshot<T>(task: () => Promise<T>): Promise<T> {
    const result = this.snapshotTail.then(task);
    this.snapshotTail = result.catch(() => undefined);
    return result;
  }

  /** Waits (bounded) for an action that a dialog interrupted. Nothing to wait for while the dialog is still open. */
  async settleBegun(ms: number): Promise<void> {
    const begun = this.begun;
    if (!begun || this.dialog) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([begun, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
    clearTimeout(timer);
    if (this.begun === begun) this.begun = null;
  }

  setViewport(width: number, height: number): boolean {
    if (!(width > 0 && height > 0) || (this.viewport.width === width && this.viewport.height === height)) return false;
    this.viewport = { width, height };
    return true;
  }

  subscribe(subscriber: TabSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => { this.subscribers.delete(subscriber); };
  }

  /** Pushes the current tab state to stream subscribers. */
  touch(): void {
    if (this.ended) return;
    const tab = this.describe();
    for (const subscriber of this.subscribers) subscriber.state(tab);
  }

  attachViewer(handle: ViewerHandle): () => void {
    this.viewers.add(handle);
    return () => { this.viewers.delete(handle); };
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  setDialog(dialog: TabEntry['dialog']): void {
    this.dialog = dialog;
    if (dialog) for (const wake of [...this.dialogWaiters]) wake();
    this.touch();
  }

  /** Resolves with true when a dialog opens; the returned cancel function stops listening. */
  watchDialog(): { opened: Promise<true>; cancel: () => void } {
    let wake: () => void = () => undefined;
    const opened = new Promise<true>((resolve) => { wake = () => resolve(true); this.dialogWaiters.add(wake); });
    return { opened, cancel: () => { this.dialogWaiters.delete(wake); } };
  }

  /** Releases any mouse buttons a human left pressed (viewer disconnect or hand-off). */
  async releaseInput(): Promise<void> {
    const buttons = [...this.pressed];
    this.pressed.clear();
    for (const button of buttons) await this.page.mouse.up({ button }).catch(() => undefined);
  }

  /** Marks the tab gone: tells subscribers and detaches every stream viewer. */
  async end(reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    for (const subscriber of [...this.subscribers]) subscriber.closed(reason);
    this.subscribers.clear();
    const handles = [...this.viewers];
    this.viewers.clear();
    await Promise.race([
      Promise.allSettled(handles.map((handle) => handle.close(reason))),
      new Promise((resolve) => setTimeout(resolve, DETACH_TIMEOUT_MS).unref()),
    ]);
  }
}
