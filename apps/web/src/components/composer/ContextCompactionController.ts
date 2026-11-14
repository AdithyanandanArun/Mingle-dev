import type { ContextCompactionResult } from '@mingle/contracts';
export interface CompactState { status: 'idle' | 'running' | 'completed' | 'failed' | 'unsupported' | 'cancelled'; message: string; cancelling: boolean }
interface Ports {
  compact: (id: string, operationId: string) => Promise<ContextCompactionResult>;
  cancel: (id: string, operationId: string) => Promise<{ interrupted: boolean }>;
  refresh: () => Promise<unknown>;
  newId?: () => string;
}
/** One controller owns exactly one session. Leaving the view never interrupts native work. */
export class ContextCompactionController {
  private state: CompactState = { status: 'idle', message: '', cancelling: false };
  private listeners = new Set<() => void>();
  private operationId: string | null = null;
  private cancellationAccepted = false;
  constructor(private readonly sessionId: string, private readonly ports: Ports) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<CompactState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  async start(): Promise<void> {
    if (this.operationId) return;
    const operation = this.ports.newId?.() ?? crypto.randomUUID();
    this.operationId = operation; this.cancellationAccepted = false;
    this.set({ status: 'running', message: 'Compacting conversation…', cancelling: false });
    try {
      const result = await this.ports.compact(this.sessionId, operation);
      if (result.sessionId !== this.sessionId) throw new Error('Compaction returned a different conversation.');
      this.set({ status: result.status === 'failed' && this.cancellationAccepted ? 'cancelled' : result.status,
        message: result.error || result.message || 'Compaction finished.' });
    } catch (error) {
      this.set({ status: 'failed', message: error instanceof Error ? error.message : 'Could not compact this conversation.' });
    } finally {
      this.operationId = null;
      this.set({ cancelling: false });
      // A refresh failure cannot turn a confirmed native completion into a failed compaction.
      await this.ports.refresh().catch(() => undefined);
    }
  }
  async cancel(): Promise<void> {
    const operation = this.operationId;
    if (!operation || this.state.cancelling) return;
    this.set({ cancelling: true });
    try {
      const result = await this.ports.cancel(this.sessionId, operation);
      if (this.operationId !== operation) return;
      this.cancellationAccepted = result.interrupted;
      this.set({ message: result.interrupted ? 'Cancellation requested; waiting for native cleanup…' : 'Native compaction is already finishing.' });
    } catch {
      if (this.operationId === operation) this.set({ cancelling: false, message: 'Could not request cancellation. Try again while compaction finishes.' });
    }
  }
}
