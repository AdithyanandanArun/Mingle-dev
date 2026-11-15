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
