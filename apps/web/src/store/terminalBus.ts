/** Output fan-out for the terminal. Kept outside React state so high-rate PTY data never re-renders the app. */
const MAX_BUFFER = 400_000;
let buffer = '';
const sinks = new Set<(data: string | null) => void>();

export const terminalBus = {
  push(data: string): void {
    buffer += data;
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(buffer.length - MAX_BUFFER);
    sinks.forEach((s) => s(data));
  },
  /** Clear local scrollback without resetting terminal modes or sending input to the shell. */
  clear(): void {
    buffer = '';
    sinks.forEach((sink) => sink('\x1b[2J\x1b[3J\x1b[H'));
  },
  reset(): void {
    buffer = '';
    sinks.forEach((s) => s(null));
  },
  snapshot: (): string => buffer,
  subscribe(sink: (data: string | null) => void): () => void {
    sinks.add(sink);
    return () => {
      sinks.delete(sink);
    };
  },
};
