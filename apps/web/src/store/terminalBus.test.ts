import { expect, it } from 'vitest';
import { terminalBus } from './terminalBus';
it('clears retained output and renderer scrollback without a shell-reset event', () => {
  terminalBus.reset();
  const received: (string | null)[] = [];
  const off = terminalBus.subscribe((chunk) => received.push(chunk));
  terminalBus.push('Example old output'); terminalBus.clear();
  expect(terminalBus.snapshot()).toBe('');
  expect(received).toEqual(['Example old output', '\x1b[2J\x1b[3J\x1b[H']);
  terminalBus.push('Example new output'); expect(terminalBus.snapshot()).toBe('Example new output');
  off(); terminalBus.reset();
});
