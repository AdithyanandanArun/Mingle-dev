import { afterEach, describe, expect, it } from 'vitest';
import type { Bootstrap, SessionSnapshot, ToolCall } from '@mingle/contracts';
import { makeRepo, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = (count: number, tag: string) => Array.from({ length: count }, (_, i) => `${tag} ${i}`).join('\n');

async function session() {
  const t = await startTestApp();
  apps.push(t);
  const project = t.app.store.insertProject({ name: 'Tool revision fixture (example)', path: makeRepo() });
  const row = t.app.store.insertSession({ projectId: project.id, name: 'Example', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', policy: 'supervised', isolated: false, worktreePath: project.path, branch: 'main' });
  return { t, sessionId: row.id };
}
async function runToEnd(t: TestApp, sessionId: string): Promise<void> {
  expect((await t.api('POST', `/api/sessions/${sessionId}/messages`, { content: 'go' })).status).toBe(202);
  await waitFor(() => t.app.store.bootstrapRuns().find((run) => run.sessionId === sessionId && run.status !== 'running') ?? undefined, 8000);
}
const storedCall = (t: TestApp, providerId: string): ToolCall => {
  const run = t.app.store.bootstrapRuns()[0]!;
  return t.app.store.listRunTools(run.id).find((call) => call.providerId === providerId)!;
};

describe('tool call versions', () => {
  it('orders every stored change and tracks content separately from lifecycle facts', async () => {
    const { t, sessionId } = await session();
    const seen: Array<{ status: string; revision?: number; contentRevision?: number; output: string }> = [];
    const sample = () => {
      const run = t.app.store.bootstrapRuns()[0];
      const call = run && t.app.store.listRunTools(run.id).find((entry) => entry.providerId === 'a');
      if (call && !seen.some((entry) => entry.revision === call.revision)) seen.push({ status: call.status, revision: call.revision, contentRevision: call.contentRevision, output: call.output });
    };
    t.fake.script = async (_options, emit) => {
      emit({ type: 'tool.activity', activity: { id: 'a', name: 'Bash', category: 'command', status: 'running', command: 'make', input: '{"cmd":"make"}' } });
      sample();
      emit({ type: 'tool.output', id: 'a', delta: 'step 1\n' });
      await pause(80); sample();
      emit({ type: 'tool.output', id: 'a', delta: 'step 2\n' });
      await pause(80); sample();
      // A lifecycle-only update: the same output is reported again, nothing about the content changes.
      emit({ type: 'tool.activity', activity: { id: 'a', name: 'Bash', category: 'command', status: 'running', processId: '4242' } });
      sample();
      // The provider replaces (not appends to) the output while finishing.
      emit({ type: 'tool.activity', activity: { id: 'a', name: 'Bash', category: 'command', status: 'completed', output: 'final result only', exitCode: 0 } });
      sample();
    };
    await runToEnd(t, sessionId);
    sample();
    expect(seen.map((entry) => entry.revision)).toEqual([...new Set(seen.map((entry) => entry.revision))].sort((a, b) => a! - b!));
    expect(seen.length).toBeGreaterThanOrEqual(4);
    const lifecycleOnly = seen.find((entry, index) => index > 0 && entry.contentRevision === seen[index - 1]!.contentRevision);
    expect(lifecycleOnly, 'a lifecycle-only change keeps the content revision').toBeDefined();
    expect(seen.every((entry) => entry.contentRevision! <= entry.revision!)).toBe(true);
    const done = storedCall(t, 'a');
    expect(done.output).toBe('final result only');
    expect(done.status).toBe('completed');
    expect(done.contentRevision).toBeGreaterThan(seen[0]!.contentRevision!);
  });

  it('does not bump a record again when the run end rewrites it unchanged', async () => {
    const { t, sessionId } = await session();
    t.fake.script = async (_options, emit) => {
      emit({ type: 'tool.activity', activity: { id: 'a', name: 'Bash', category: 'command', status: 'completed', output: 'done', exitCode: 0 } });
    };
    await runToEnd(t, sessionId);
    const first = storedCall(t, 'a');
    await pause(150);
    const later = storedCall(t, 'a');
    expect(later.revision).toBe(first.revision);
    expect(later.contentRevision).toBe(first.contentRevision);
    expect(first.revision).toBeGreaterThan(0);
  });

  it('marks bounded previews with the stored lengths while detail endpoints return the complete record', async () => {
    const { t, sessionId } = await session();
    const longOutput = lines(1000, 'output row'); // about 13k characters, inside the 20k capture bound
    const longInput = JSON.stringify({ script: lines(900, 'input row') });
    t.fake.script = async (_options, emit) => {
      emit({ type: 'tool.activity', activity: { id: 'big', name: 'Bash', category: 'command', status: 'completed', input: longInput, output: longOutput, exitCode: 0 } });
      emit({ type: 'tool.activity', activity: { id: 'small', name: 'Read', category: 'file', status: 'completed', input: '{}', output: 'tiny' } });
      emit({ type: 'tool.activity', activity: { id: 'clipped', name: 'Bash', category: 'command', status: 'completed', output: 'z'.repeat(25_000) } });
    };
    await runToEnd(t, sessionId);
    const boot = (await t.api<Bootstrap>('GET', '/api/bootstrap')).json;
    const snap = (await t.api<SessionSnapshot>('GET', `/api/sessions/${sessionId}/snapshot`)).json;
    for (const source of [boot.toolCalls, snap.toolCalls]) {
      const big = source.find((call) => call.providerId === 'big')!;
      expect(big.output).toBe(longOutput.slice(-2000));
      expect(big.input).toBe(longInput.slice(0, 4000));
      expect(big.preview).toEqual({ inputChars: longInput.length, outputChars: longOutput.length });
      expect(big.outputTruncated ?? false, 'a preview is not a capture clip').toBe(false);
      const small = source.find((call) => call.providerId === 'small')!;
      expect(small.preview).toBeUndefined();
      expect(small.output).toBe('tiny');
      const clipped = source.find((call) => call.providerId === 'clipped')!;
      expect(clipped.outputTruncated).toBe(true);
      expect(clipped.preview).toEqual({ inputChars: 0, outputChars: 20_000 });
    }
    const bigPreview = boot.toolCalls.find((call) => call.providerId === 'big')!;
    const full = (await t.api<ToolCall>('GET', `/api/tool-calls/${bigPreview.id}`)).json;
    expect(full.output).toBe(longOutput);
    expect(full.input).toBe(longInput);
    expect(full.preview).toBeUndefined();
    expect(full.revision).toBe(bigPreview.revision);
    expect(full.contentRevision).toBe(bigPreview.contentRevision);
    const list = (await t.api<ToolCall[]>('GET', `/api/runs/${bigPreview.runId}/tools`)).json;
    expect(list.find((call) => call.providerId === 'big')!.output).toBe(longOutput);
    expect(list.find((call) => call.providerId === 'clipped')!.outputTruncated).toBe(true);
    expect(list.find((call) => call.providerId === 'clipped')!.output).toHaveLength(20_000);
  });

  it('gives records stored before revisions a stable revision of 0 everywhere, and recovery bumps it', async () => {
    const { t, sessionId } = await session();
    t.fake.script = async (_options, emit) => { emit({ type: 'text', text: 'ok' }); };
    await runToEnd(t, sessionId);
    const run = t.app.store.bootstrapRuns()[0]!;
    const legacy: ToolCall = {
      id: 'tool_legacy', runId: run.id, sessionId, providerId: 'legacy', parentProviderId: null, name: 'Bash', category: 'command', status: 'running', summary: '', command: null,
      input: '', output: lines(600, 'legacy'), cwd: null, exitCode: null, processId: null, startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
    };
    t.app.store.putToolCall(legacy);
    expect(t.app.store.getToolCall('tool_legacy')).toMatchObject({ revision: 0, contentRevision: 0 });
    const boot = (await t.api<Bootstrap>('GET', '/api/bootstrap')).json;
    expect(boot.toolCalls.find((call) => call.id === 'tool_legacy')).toMatchObject({ revision: 0, contentRevision: 0, preview: { inputChars: 0, outputChars: legacy.output.length } });

    // Startup recovery marks a tool the server never finished as interrupted and gives that change its own revision.
    const open = t.app.store.insertRun({ id: 'run_open', sessionId, userMessageId: run.userMessageId, provider: 'claude', model: 'claude-sonnet-5-5', startedAt: new Date().toISOString() });
    t.app.store.putToolCall({ ...legacy, id: 'tool_open', runId: open.id, providerId: 'open' });
    t.app.store.recoverRuns();
    const recovered = t.app.store.getToolCall('tool_open')!;
    expect(recovered).toMatchObject({ status: 'interrupted', revision: 1, contentRevision: 0 });
    expect(recovered.output).toBe(legacy.output);
  });
});
