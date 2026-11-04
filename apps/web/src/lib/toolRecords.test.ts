import { describe, expect, it } from 'vitest';
import type { SessionRun, ToolCall } from '@mingle/contracts';
import { mergeToolCalls, needsFullDetail, reconcileToolCall, runActivitySummary, toolInputLabel, toolOutputLabel, toolRowFacts } from './toolRecords';

const LONG = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'); // about 3.3k characters

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tool-1', runId: 'run-1', sessionId: 's1', providerId: 'p1', parentProviderId: null, name: 'Bash', category: 'command', status: 'completed',
    summary: 'Run script', command: 'node script.js', input: '{}', output: LONG, cwd: '/example', exitCode: 0, processId: null,
    startedAt: '2026-11-04T10:00:00.000Z', finishedAt: '2026-11-04T10:00:02.000Z', durationMs: 2000, revision: 3, contentRevision: 3, ...overrides,
  };
}
/** What a bootstrap or snapshot carries for a stored record: bounded input head and output tail plus the stored lengths. */
function preview(full: ToolCall, overrides: Partial<ToolCall> = {}): ToolCall {
  return { ...full, input: full.input.slice(0, 4000), output: full.output.slice(-2000), preview: { inputChars: full.input.length, outputChars: full.output.length }, ...overrides };
}
function run(overrides: Partial<SessionRun> = {}): SessionRun {
  return { id: 'run-1', sessionId: 's1', userMessageId: 'm1', provider: 'claude', model: 'example', status: 'completed', startedAt: '2026-11-04T10:00:00.000Z', finishedAt: '2026-11-04T10:00:05.000Z', durationMs: 5000, toolCount: 0, toolCounts: {}, ...overrides };
}

describe('reconcileToolCall', () => {
  it('keeps a fetched complete copy when a preview of the same content arrives with unchanged revisions', () => {
    const full = call();
    expect(reconcileToolCall(full, preview(full))).toBe(full);
  });

  it('keeps the complete input/output but takes newer lifecycle facts when only a non-content field changed', () => {
    const full = call();
    const next = reconcileToolCall(full, preview(full, { revision: 4, subagentMessages: [{ id: 'm', content: 'hello', createdAt: full.startedAt }], durationMs: 2100 }));
    expect(next.output).toBe(LONG);
    expect(next.preview).toBeUndefined();
    expect(next.revision).toBe(4);
    expect(next.contentRevision).toBe(3);
    expect(next.durationMs).toBe(2100);
    expect(next.subagentMessages).toHaveLength(1);
  });

  it('replaces a fetched copy with the preview when the content changed: it is no longer the current output', () => {
    const full = call();
    const changed = preview(call({ output: `${LONG}\nreplacement result`, revision: 5, contentRevision: 5 }));
    const next = reconcileToolCall(full, changed);
    expect(next).toBe(changed);
    expect(next.output.endsWith('replacement result')).toBe(true);
    expect(next.preview).toBeDefined();
  });

  it('does not let an older response roll back a newer record, in either shape', () => {
    const current = call({ revision: 6, contentRevision: 6, output: `${LONG}\nnewest`, status: 'completed' });
    const stale = call({ revision: 4, contentRevision: 4, status: 'running', finishedAt: null, durationMs: null, output: 'older', exitCode: null });
    expect(reconcileToolCall(current, stale)).toBe(current);
    const currentPreview = preview(current);
    expect(reconcileToolCall(currentPreview, stale)).toBe(currentPreview);
  });

  it('applies a complete response whose content is newer than the held preview, then ignores the older snapshot that follows', () => {
    const heldPreview = preview(call({ revision: 4, contentRevision: 4, output: `${LONG}\nA` }));
    const fetched = call({ revision: 7, contentRevision: 7, output: `${LONG}\nB`, exitCode: 1, status: 'failed' });
    const afterFetch = reconcileToolCall(heldPreview, fetched);
    expect(afterFetch).toBe(fetched);
    const laterOlderSnapshot = preview(call({ revision: 5, contentRevision: 5, output: `${LONG}\nA2` }));
    expect(reconcileToolCall(afterFetch, laterOlderSnapshot)).toBe(fetched);
  });

  it('upgrades a preview with the complete copy of the same version', () => {
    const full = call();
    expect(reconcileToolCall(preview(full), full)).toBe(full);
  });

  it('mixes newest facts with older-but-latest content when a lifecycle update carries a preview', () => {
    const full = call({ status: 'running', finishedAt: null, durationMs: null, exitCode: null, revision: 2, contentRevision: 2 });
    const finished = preview(call({ revision: 3, contentRevision: 2, output: full.output, exitCode: 0 }));
    const next = reconcileToolCall(full, finished);
    expect(next.status).toBe('completed');
    expect(next.exitCode).toBe(0);
    expect(next.output).toBe(full.output);
    expect(next.preview).toBeUndefined();
  });

  it('lets an incoming copy win when either side has no revision (unversioned fixture)', () => {
    const bare = call({ revision: undefined, contentRevision: undefined });
    const incoming = call({ revision: undefined, contentRevision: undefined, status: 'failed' });
    expect(reconcileToolCall(bare, incoming)).toBe(incoming);
    expect(reconcileToolCall(call(), incoming)).toBe(incoming);
  });
});

describe('mergeToolCalls', () => {
  it('returns the same array when nothing changed, so a snapshot of unchanged calls causes no re-render', () => {
    const full = call();
    const current = [full];
    expect(mergeToolCalls(current, [preview(full)])).toBe(current);
  });

  it('keeps a fetched call while a different call changes, and orders by start time', () => {
    const fetched = call({ id: 'a', providerId: 'pa', startedAt: '2026-11-04T10:00:01.000Z' });
    const other = call({ id: 'b', providerId: 'pb', startedAt: '2026-11-04T10:00:00.000Z', output: 'x', status: 'running', revision: 1, contentRevision: 1 });
    const merged = mergeToolCalls([fetched, other], [preview(fetched), { ...other, output: 'xy', revision: 2, contentRevision: 2 }]);
    expect(merged.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(merged.find((entry) => entry.id === 'a')).toBe(fetched);
    expect(merged.find((entry) => entry.id === 'b')?.output).toBe('xy');
  });

  it('retains calls that left the snapshot window', () => {
    const gone = call({ id: 'gone' });
    expect(mergeToolCalls([gone], [call({ id: 'new', providerId: 'pn' })]).map((entry) => entry.id).sort()).toEqual(['gone', 'new']);
  });
});

describe('detail loading and labels', () => {
  it('asks for the complete record only for finished previews', () => {
    const full = call();
    expect(needsFullDetail(preview(full))).toBe(true);
    expect(needsFullDetail(full)).toBe(false);
    expect(needsFullDetail(preview(full, { status: 'running' }))).toBe(false);
  });

  it('says what a preview and a clipped capture actually are', () => {
    const full = call({ input: 'i'.repeat(6000) });
    const shown = preview(full);
    expect(toolOutputLabel(shown)).toBe(`Output tail · last 2,000 of ${LONG.length.toLocaleString('en-US')} characters`);
    expect(toolInputLabel(shown)).toBe('Input · first 4,000 of 6,000 characters');
    expect(toolOutputLabel(full)).toBe('Output');
    expect(toolInputLabel(full)).toBe('Input');
    expect(toolOutputLabel(call({ outputTruncated: true, output: 'x'.repeat(20_000) }))).toBe('Output · last 20,000 characters captured (earlier output was not kept)');
    expect(toolOutputLabel(preview(call({ outputTruncated: true, output: 'x'.repeat(20_000) })))).toContain('earlier output was not captured');
  });
});

describe('factual summaries', () => {
  it('shows recorded exit code, duration and child count only', () => {
    expect(toolRowFacts(call({ exitCode: 1 }), 2000, 2)).toEqual(['exit 1', '2.0 s', '2 child calls']);
    expect(toolRowFacts(call({ exitCode: null }), null, 0)).toEqual([]);
    expect(toolRowFacts(call({ exitCode: 0 }), 250, 1)).toEqual(['exit 0', '250 ms', '1 child call']);
  });

  it('counts categories from the run and outcomes from loaded calls', () => {
    const calls = [
      call({ id: 'a', exitCode: 1, status: 'failed' }),
      call({ id: 'b', exitCode: 0 }),
      call({ id: 'c', category: 'search', exitCode: null, status: 'interrupted' }),
    ];
    const summary = runActivitySummary(run({ toolCount: 3, toolCounts: { command: 2, search: 1 } }), calls);
    expect(summary).toEqual(['Ran 2 commands', '1 search', '1 failed', '1 interrupted', '1 call exited non-zero']);
  });

  it('never claims tests passed from a tool name or summary, and does not guess outcomes for unloaded calls', () => {
    const tests = call({ name: 'run_tests', summary: 'All tests passed', command: 'npm test', exitCode: 0 });
    const summary = runActivitySummary(run({ toolCount: 1, toolCounts: { command: 1 } }), [tests]);
    expect(summary).toEqual(['Ran 1 command']);
    expect(summary.join(' ')).not.toMatch(/pass|success|green/i);
    const partial = runActivitySummary(run({ toolCount: 5, toolCounts: { command: 5 } }), [call({ exitCode: 2, status: 'failed' })]);
    expect(partial).toEqual(['Ran 5 commands']);
  });

  it('accounts for uncategorised tool calls instead of dropping them', () => {
    expect(runActivitySummary(run({ toolCount: 4, toolCounts: { command: 1 } }), [])).toEqual(['Ran 1 command', '3 tool calls']);
  });
});
