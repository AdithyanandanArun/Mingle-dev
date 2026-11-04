import type { SessionRun, ToolCall } from '@mingle/contracts';
import { formatElapsed } from './activity';

/**
 * Versions of one tool call arrive from three places: bootstrap/session snapshots (bounded previews), a per-call
 * detail fetch and the per-run list (complete stored copies). The server orders versions with `revision` and says
 * which one last changed input/output with `contentRevision`, so nothing here guesses at overlapping text:
 *
 * - lifecycle facts (status, duration, exit code, children text, ...) come from the higher `revision`;
 * - input/output come from the higher `contentRevision`, and for the same content a complete copy beats a preview;
 * - a copy without `revision` (an unversioned example fixture) cannot be ordered, so the incoming one simply wins.
 */
export function reconcileToolCall(known: ToolCall | undefined, incoming: ToolCall): ToolCall {
  if (!known || known.id !== incoming.id) return incoming;
  if (known.revision === undefined || incoming.revision === undefined) return incoming;
  const knownContent = known.contentRevision ?? 0;
  const incomingContent = incoming.contentRevision ?? 0;
  // Same version of the record: nothing to learn, except that the incoming copy may be the complete one.
  if (incoming.revision === known.revision && incomingContent === knownContent) return isPreview(known) && !isPreview(incoming) ? incoming : known;
  const facts = incoming.revision >= known.revision ? incoming : known;
  const content = incomingContent !== knownContent
    ? (incomingContent > knownContent ? incoming : known)
    : (isPreview(known) ? incoming : known);
  if (facts === content) return facts;
  const { preview: _preview, ...rest } = facts;
  return {
    ...rest, input: content.input, output: content.output, contentRevision: content.contentRevision,
    ...(content.outputTruncated === undefined ? {} : { outputTruncated: content.outputTruncated }),
    ...(content.preview ? { preview: content.preview } : {}),
  };
}

/** Folds `incoming` into `current` (sorted by start). Returns `current` itself when nothing changed, so callers can bail out of a render. */
export function mergeToolCalls(current: readonly ToolCall[], incoming: readonly ToolCall[]): readonly ToolCall[] {
  if (!incoming.length) return current;
  const byId = new Map(current.map((call) => [call.id, call]));
  let changed = false;
  for (const call of incoming) {
    const known = byId.get(call.id);
    const next = reconcileToolCall(known, call);
    if (next !== known) { byId.set(call.id, next); changed = true; }
  }
  if (!changed) return current;
  return [...byId.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** True when `input`/`output` are a bounded preview of a longer stored record. */
export function isPreview(call: ToolCall): boolean {
  return call.preview !== undefined;
}

/** A running call's content keeps changing and arrives with snapshots; the complete copy is only worth loading once it has finished. */
export function needsFullDetail(call: ToolCall): boolean {
  return call.status !== 'running' && isPreview(call);
}

const count = (value: number): string => value.toLocaleString('en-US');

export function toolInputLabel(call: ToolCall): string {
  return call.preview ? `Input · first ${count(call.input.length)} of ${count(call.preview.inputChars)} characters` : 'Input';
}

export function toolOutputLabel(call: ToolCall): string {
  const length = count(call.output.length);
  if (call.preview) {
    return `Output tail · last ${length} of ${count(call.preview.outputChars)} characters${call.outputTruncated ? ' (earlier output was not captured)' : ''}`;
  }
  return call.outputTruncated ? `Output · last ${length} characters captured (earlier output was not kept)` : 'Output';
}

export function formatToolDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  return formatElapsed(ms);
}

/** Facts shown on a collapsed tool row. Only values the provider or host recorded; nothing is derived from the tool's name or text. */
export function toolRowFacts(call: ToolCall, elapsedMs: number | null, childCount: number): string[] {
  const facts: string[] = [];
  if (call.exitCode !== null) facts.push(`exit ${call.exitCode}`);
  if (elapsedMs !== null) facts.push(formatToolDuration(elapsedMs));
  if (childCount > 0) facts.push(`${childCount} ${childCount === 1 ? 'child call' : 'child calls'}`);
  return facts;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * Compact line for a run's disclosure. Category counts come from the run record; outcome counts come from the loaded calls
 * and are given only when every reported call is loaded. "Exited non-zero" restates a recorded exit code: a tool called
 * "test" that exited 0 is never described as passing tests.
 */
export function runActivitySummary(run: SessionRun, calls: readonly ToolCall[]): string[] {
  const counts = run.toolCounts ?? {};
  const parts: string[] = [];
  const commands = counts.command ?? 0;
  if (commands > 0) parts.push(`Ran ${plural(commands, 'command')}`);
  const searches = counts.search ?? 0;
  if (searches > 0) parts.push(`${plural(searches, 'search', 'searches')}`);
  const files = counts.file ?? 0;
  if (files > 0) parts.push(`${plural(files, 'file action')}`);
  const browsers = counts.browser ?? 0;
  if (browsers > 0) parts.push(`${plural(browsers, 'browser action')}`);
  const agents = counts.agent ?? 0;
  if (agents > 0) parts.push(`${plural(agents, 'agent call')}`);
  const others = counts.other ?? 0;
  if (others > 0) parts.push(`${plural(others, 'other tool')}`);
  const categorised = commands + searches + files + browsers + agents + others;
  if (run.toolCount > categorised) parts.push(`${plural(run.toolCount - categorised, 'tool call')}`);

  const own = calls.filter((call) => call.runId === run.id);
  if (run.toolCount > 0 && own.length >= run.toolCount) {
    const failed = own.filter((call) => call.status === 'failed').length;
    const interrupted = own.filter((call) => call.status === 'interrupted').length;
    const running = own.filter((call) => call.status === 'running').length;
    const nonZero = own.filter((call) => call.exitCode !== null && call.exitCode !== 0).length;
    if (running > 0) parts.push(`${running} running`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (interrupted > 0) parts.push(`${interrupted} interrupted`);
    if (nonZero > 0) parts.push(`${plural(nonZero, 'call')} exited non-zero`);
  }
  return parts;
}
