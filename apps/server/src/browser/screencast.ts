import { withTimeout } from './errors.ts';
import { refreshViewport } from './actions.ts';
import { STREAM_ACK_TIMEOUT_MS, STREAM_SETTINGS } from './limits.ts';
import type { CDPSession } from './playwright.ts';
import type { TabEntry } from './tab.ts';

export interface FrameHeader { sequence: number; width: number; height: number }

/** Where frames go. `send` may throw when the consumer is gone; the viewer then stops itself. */
export interface FrameSink { send(header: FrameHeader, jpeg: Buffer): void }

interface Pending { data: string; chromeSession: number | null; width: number; height: number }

const FALLBACK_FRAME_DELAY_MS = 700;

/**
 * One screencast per viewer, on its own CDP session. Chromium only produces the next frame after the previous one
 * is acknowledged, so the viewer's acks pace the stream: at most one frame is in flight, only the newest frame waits
 * behind it, and a fixed frame interval paces each viewer. Chromium is always acknowledged
 * eventually (on viewer ack, on drop, or on timeout) so it never stalls.
 */
export class ScreencastViewer {
  private cdp: CDPSession | null = null;
  private pending: Pending | null = null;
  private inflight: { sequence: number; chromeSession: number | null; timer: NodeJS.Timeout } | null = null;
  private sequence = 0;
  private lastSentAt = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly entry: TabEntry,
    private readonly sink: FrameSink,
    private readonly onViewport: () => void,
  ) {}

  async start(): Promise<void> {
    const pending = this.entry.page.context().newCDPSession(this.entry.page);
    let cdp: CDPSession;
    try {
      cdp = await withTimeout(pending, 5000, 'Attaching the live view timed out.');
    } catch (error) {
      // A session that arrives after we gave up (or after stop) must not stay attached to the tab.
      void pending.then((late) => late.detach()).catch(() => undefined);
      if (this.stopped) return;
      throw error;
    }
    if (this.stopped) return void (await cdp.detach().catch(() => undefined));
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', (frame) => this.onFrame({ data: frame.data, chromeSession: frame.sessionId, width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight }));
    try {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg', quality: STREAM_SETTINGS.jpegQuality, everyNthFrame: 1,
        maxWidth: STREAM_SETTINGS.maxWidth, maxHeight: STREAM_SETTINGS.maxHeight, maxFramesInFlight: 1,
      });
    } catch (error) {
      // stop() may have detached the session while this was in flight; that failure is expected, not an error to report.
      const wasStopped = this.stopped;
      await this.stop();
      if (wasStopped) return;
      throw error;
    }
    if (this.stopped) {
      // stop() ran during startScreencast and already sent stopScreencast and detach; repeat the detach in case it was cut short.
      await cdp.detach().catch(() => undefined);
      return;
    }
    // An idle page may never produce a frame. Avoid fallback work if one arrived during startup.
    if (!this.sequence && !this.pending) {
      this.fallbackTimer = setTimeout(() => { this.fallbackTimer = null; void this.stillFrame(); }, FALLBACK_FRAME_DELAY_MS);
      this.fallbackTimer.unref();
    }
  }

  /** Viewer acknowledged a frame it has decoded and painted. */
  ack(sequence: number): void {
    if (this.inflight?.sequence === sequence) this.settle();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of [this.flushTimer, this.fallbackTimer, this.inflight?.timer]) if (timer) clearTimeout(timer);
    this.inflight = null;
    this.pending = null;
    const cdp = this.cdp;
    this.cdp = null;
    if (!cdp) return;
    await withTimeout(cdp.send('Page.stopScreencast'), 2000, 'stop timed out').catch(() => undefined);
    await withTimeout(cdp.detach(), 2000, 'detach timed out').catch(() => undefined);
  }

  private ackChrome(chromeSession: number | null): void {
    if (chromeSession === null || !this.cdp) return;
    void this.cdp.send('Page.screencastFrameAck', { sessionId: chromeSession }).catch(() => undefined);
  }

  private onFrame(frame: Pending): void {
    if (this.stopped) return void this.ackChrome(frame.chromeSession);
    // The fallback exists only for pages that produce no screencast frame. Once a real
    // frame arrives, cancel it instead of waking up later to perform a no-op check.
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (frame.width > 0 && frame.height > 0 && this.entry.setViewport(Math.round(frame.width), Math.round(frame.height))) this.onViewport();
    if (this.pending) this.ackChrome(this.pending.chromeSession);
    this.pending = frame;
    this.flush();
  }

  private settle(): void {
    const inflight = this.inflight;
    if (!inflight) return;
    clearTimeout(inflight.timer);
    this.inflight = null;
    this.ackChrome(inflight.chromeSession);
    this.flush();
  }

  private flush(): void {
    if (this.stopped || this.inflight || !this.pending) return;
    const wait = this.lastSentAt + STREAM_SETTINGS.minFrameIntervalMs - performance.now();
    if (wait > 0) {
      this.flushTimer ??= setTimeout(() => { this.flushTimer = null; this.flush(); }, wait);
      return;
    }
    const frame = this.pending;
    this.pending = null;
    const sequence = ++this.sequence;
    this.lastSentAt = performance.now();
    // If the viewer never acknowledges (hidden tab, stalled consumer) release Chromium and carry on.
    const timer = setTimeout(() => { if (this.inflight?.sequence === sequence) this.settle(); }, STREAM_ACK_TIMEOUT_MS);
    this.inflight = { sequence, chromeSession: frame.chromeSession, timer };
    try {
      this.sink.send({ sequence, width: frame.width, height: frame.height }, Buffer.from(frame.data, 'base64'));
    } catch {
      void this.stop();
    }
  }

  private async stillFrame(): Promise<void> {
    if (this.stopped || this.sequence > 0 || this.pending || !this.cdp) return;
    await refreshViewport(this.entry);
    if (this.stopped || this.sequence > 0 || this.pending || !this.cdp) return;
    const { width, height } = this.entry.viewport;
    const scale = Math.min(1, STREAM_SETTINGS.maxWidth / width, STREAM_SETTINGS.maxHeight / height);
    const shot = await withTimeout(this.cdp.send('Page.captureScreenshot', {
      format: 'jpeg', quality: STREAM_SETTINGS.jpegQuality, clip: { x: 0, y: 0, width, height, scale }, captureBeyondViewport: false,
      optimizeForSpeed: true,
    }), 5000, 'screenshot timed out').catch(() => null);
    if (!shot || this.stopped || this.sequence > 0 || this.pending) return;
    this.onFrame({ data: shot.data, chromeSession: null, width: this.entry.viewport.width, height: this.entry.viewport.height });
  }
}
