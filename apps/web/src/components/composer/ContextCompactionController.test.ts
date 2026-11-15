import { describe, expect, it, vi } from 'vitest';
import type { ContextCompactionResult } from '@mingle/contracts';
import { ContextCompactionController } from './ContextCompactionController';
const result = (status: ContextCompactionResult['status'] = 'completed') => ({ sessionId: 'one', provider: 'codex', status, message: 'Native result', error: null } as ContextCompactionResult);
function fixture() {
  let finish!: (value: ContextCompactionResult) => void;
  const compact = vi.fn(() => new Promise<ContextCompactionResult>(resolve => { finish = resolve; }));
  const cancel = vi.fn(async () => ({ interrupted: true }));
  const refresh = vi.fn(async () => undefined);
  const controller = new ContextCompactionController('one', { compact, cancel, refresh, newId: () => 'operation-one' });
  return { controller, compact, cancel, refresh, finish: (value = result()) => finish(value) };
}
describe('native context compaction', () => {
  it('ignores a late cancellation acknowledgement after native completion', async () => {
    let finish!: (value: ContextCompactionResult) => void;
    let acknowledge!: (value: { interrupted: boolean }) => void;
    const controller = new ContextCompactionController('one', {
      compact: () => new Promise(resolve => { finish = resolve; }),
      cancel: () => new Promise(resolve => { acknowledge = resolve; }), refresh: async () => {}, newId: () => 'late-cancel',
    });
    const running = controller.start(); const cancelling = controller.cancel();
    finish(result()); await running;
    acknowledge({ interrupted: true }); await cancelling;
    expect(controller.snapshot()).toMatchObject({ status: 'completed', cancelling: false, message: 'Native result' });
  });
  it('retains a confirmed outcome if bootstrap refresh fails', async () => {
    const controller = new ContextCompactionController('one', {
      compact: async () => result(), cancel: async () => ({ interrupted: false }),
      refresh: async () => { throw new Error('Offline'); }, newId: () => 'refresh-failure',
    });
    await controller.start(); expect(controller.snapshot().status).toBe('completed');
  });
  it('reports unsupported providers and mismatched native responses honestly', async () => {
    const unsupported = new ContextCompactionController('one', { compact: async () => result('unsupported'), cancel: async () => ({ interrupted: false }), refresh: async () => {}, newId: () => 'unsupported' });
    await unsupported.start(); expect(unsupported.snapshot().status).toBe('unsupported');
    const mismatch = new ContextCompactionController('one', { compact: async () => ({ ...result(), sessionId: 'two' }), cancel: async () => ({ interrupted: false }), refresh: async () => {}, newId: () => 'mismatch' });
    await mismatch.start(); expect(mismatch.snapshot()).toMatchObject({ status: 'failed', message: 'Compaction returned a different conversation.' });
  });
  it('serializes duplicate clicks and refreshes after real completion', async () => {
    const f = fixture(); const pending = f.controller.start();
    await f.controller.start(); expect(f.compact).toHaveBeenCalledTimes(1);
    expect(f.controller.snapshot().status).toBe('running');
    f.finish(); await pending;
    expect(f.controller.snapshot().status).toBe('completed'); expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it('sends cancellation only for its own operation and waits for cleanup', async () => {
    const f = fixture(); const pending = f.controller.start();
    await f.controller.cancel(); await f.controller.cancel();
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith('one', 'operation-one');
    expect(f.controller.snapshot()).toMatchObject({ status: 'running', cancelling: true });
    f.finish(result('failed')); await pending;
    expect(f.controller.snapshot()).toMatchObject({ status: 'cancelled', cancelling: false });
  });
});
