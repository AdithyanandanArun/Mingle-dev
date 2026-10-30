import { BROWSER_TOUCH_IDLE_MS } from '@mingle/contracts';
import { BrowserError } from './errors.ts';

export interface Actor { kind: 'agent' | 'human'; id: string }
export type BrowserLease = 'touch' | 'hold' | null;

/** Per-tab writer lease. Claims are synchronous so the first human event is never lost. */
export class TabControl {
  private holder: string | null = null;
  private leaseValue: BrowserLease = null;
  private expiry: number | null = null;
  private epoch = 0;
  private pressedValue = false;
  private timer: NodeJS.Timeout | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly cleanup: () => Promise<void> = async () => undefined, private readonly onChange: () => void = () => undefined) {}
  get ownerId(): string | null { return this.holder; }
  get lease(): BrowserLease { return this.leaseValue; }
  get expiresAt(): number | null { return this.expiry; }
  get pressed(): boolean { return this.pressedValue; }
  get epochValue(): number { return this.epoch; }

  authorize(actor: Actor): void {
    if (actor.kind === 'agent') {
      if (this.holder !== null) throw new BrowserError(409, this.leaseValue === 'touch'
        ? 'A person is using this tab right now. Control comes back to you about 2.5 s after they stop. Wait, take a fresh snapshot, then retry.'
        : 'A person is holding control of this tab. Snapshots still work; wait until they hand it back.');
      return;
    }
    if (this.holder !== null && this.holder !== actor.id) throw new BrowserError(409, 'Another person is using this tab right now.');
  }

  run<T>(actor: Actor, task: () => Promise<T>): Promise<T> {
    try {
      this.authorize(actor);
      if (actor.kind === 'human' && this.holder === null) {
        this.holder = actor.id; this.leaseValue = 'touch'; this.expiry = Date.now() + BROWSER_TOUCH_IDLE_MS; this.epoch++;
        this.arm(); this.onChange();
      }
      if (actor.kind === 'human' && this.leaseValue === 'touch') this.extend();
    } catch (error) { return Promise.reject(error); }
    const admittedIn = this.epoch;
    const result = this.tail.then(() => {
      if (this.epoch !== admittedIn) throw new BrowserError(409, 'Control of this tab changed while this action was queued, so it was not run. Take a fresh snapshot and retry.');
      return task();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  pointer(phase: 'down' | 'up'): void {
    this.pressedValue = phase === 'down';
    if (this.leaseValue === 'touch') this.extend();
  }

  take(clientId: string): void {
    if (this.holder === clientId) { this.leaseValue = 'hold'; this.expiry = null; this.clearTimer(); this.epoch++; this.onChange(); return; }
    if (this.holder !== null) throw new BrowserError(409, 'Another person is using this tab right now.');
    this.holder = clientId; this.leaseValue = 'hold'; this.expiry = null; this.epoch++; this.clearTimer(); this.onChange();
  }

  release(clientId: string): Promise<void> {
    if (this.holder === null) return Promise.resolve();
    if (this.holder !== clientId) return Promise.reject(new BrowserError(403, 'Only the person holding control can hand it back.'));
    return this.handoff();
  }
  releaseIfOwner(clientId: string): Promise<void> { return this.holder === clientId ? this.handoff() : Promise.resolve(); }

  /** Pushes state only when the visible deadline moves by a quarter second or more, not on every pointer move. */
  private extend(): void {
    const previous = this.expiry ?? 0;
    this.expiry = Date.now() + BROWSER_TOUCH_IDLE_MS;
    this.arm();
    if (this.expiry - previous >= 250) this.onChange();
  }
  private arm(): void {
    this.clearTimer();
    if (this.leaseValue !== 'touch' || this.pressedValue) return;
    const delay = Math.max(0, (this.expiry ?? Date.now()) - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.leaseValue !== 'touch') return;
      if (this.pressedValue) return;
      if ((this.expiry ?? 0) > Date.now()) return this.arm();
      void this.handoff();
    }, delay);
    this.timer.unref();
  }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private handoff(): Promise<void> {
    if (this.holder === null) return Promise.resolve();
    const admitted = this.tail;
    this.clearTimer(); this.epoch++;
    this.holder = null; this.leaseValue = null; this.expiry = null; this.pressedValue = false;
    const work = async () => { await admitted.catch(() => undefined); await this.cleanup().catch(() => undefined); this.onChange(); };
    const result = Promise.resolve().then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
