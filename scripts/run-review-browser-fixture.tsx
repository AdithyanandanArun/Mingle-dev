// Example-only completion review: no provider, account, network or inference. Drives the real SessionPane, store, transcript layout and
// RunReview/RunChanges against in-page stand-ins for /api/runs/:id/review and /changes. The review stand-in applies the server's rules
// (metadata only, 50 command rows, 20 problem rows, counts over every stored call, goal turn only for its own run, 409 while running);
// the real rules are covered by the server tests. Every record below is an explicit example.
import { createRoot } from 'react-dom/client';
import type { Bootstrap, Message, RunChanges, RunChangesSummary, RunReviewEvidence, Session, SessionRun, SessionWorkflow, Task, ToolCall } from '@mingle/contracts';
import { SessionPane } from '../apps/web/src/components/Chat';
import { useMingle } from '../apps/web/src/store/store';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/base.css';
import '../apps/web/src/styles/ui.css';
import '../apps/web/src/styles/app.css';
import '../apps/web/src/styles/conversation.css';
import '../apps/web/src/styles/message-context.css';
import '../apps/web/src/styles/run-activity.css';
import '../apps/web/src/styles/run-changes.css';
import '../apps/web/src/styles/run-review.css';

const T0 = Date.parse('2026-11-04T10:00:00Z');
const stamp = (n: number) => new Date(T0 + n * 1000).toISOString();

const session: Session = {
  id: 'a', projectId: 'p1', name: 'Example completion review', provider: 'claude', model: 'example-model', effort: 'medium', status: 'idle', policy: 'supervised', isolated: false,
  worktreePath: '/example', branch: null, providerSessionId: null, createdAt: stamp(0), updatedAt: stamp(0), error: null, inputTokens: 0, outputTokens: 0, costUsd: null, pinned: false, unread: false,
};
const file = (path: string, status: 'A' | 'M' | 'D', additions: number, deletions: number) => ({ path, status, additions, deletions, binary: false });
const capture = (files: ReturnType<typeof file>[], extra: Partial<RunChangesSummary> = {}): RunChangesSummary => ({
  status: 'available', capturedAt: stamp(1), fileCount: files.length, files, additions: files.reduce((n, f) => n + (f.additions ?? 0), 0), deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0), truncated: false, notices: [], ...extra,
});

interface Turn { n: number; run: string; assistant: boolean; status: SessionRun['status']; changes: RunChangesSummary | null; startedAt?: string; orphan?: boolean }
const turns: Turn[] = [
  { n: 1, run: 'run-ok', assistant: true, status: 'completed', changes: capture([file('src/helper.ts', 'M', 12, 1), file('docs/notes.md', 'A', 4, 0)]) },
  { n: 2, run: 'run-nocalls', assistant: true, status: 'completed', changes: capture([file('src/only.ts', 'A', 3, 0)]) },
  { n: 3, run: 'run-partial', assistant: true, status: 'completed', changes: capture([file('src/many.ts', 'M', 1, 1)]) },
  { n: 4, run: 'run-unavail', assistant: true, status: 'completed', changes: { status: 'unavailable', capturedAt: stamp(1), fileCount: 0, files: [], additions: 0, deletions: 0, truncated: false, notices: ['Example capture notice: the repository was locked.'] } },
  { n: 5, run: 'run-failed', assistant: false, status: 'failed', changes: null },
  { n: 6, run: 'run-interrupted', assistant: true, status: 'interrupted', changes: capture([file('src/half.ts', 'M', 2, 0)]) },
  { n: 7, run: 'run-plain', assistant: true, status: 'completed', changes: capture([]) },
  { n: 8, run: 'run-goal', assistant: true, status: 'completed', changes: null },
  { n: 8.5, run: 'run-tool-failure', assistant: true, status: 'completed', changes: null },
  { n: 9, run: 'run-latest', assistant: true, status: 'completed', changes: capture([file('src/build.ts', 'M', 5, 2)]) },
];
const messages: Message[] = [];
const runs: SessionRun[] = [];
const tool = (id: string, runId: string, n: number, extra: Partial<ToolCall>): ToolCall => ({
  id, runId, sessionId: 'a', providerId: `p-${id}`, parentProviderId: null, name: 'Bash', category: 'command', status: 'completed', summary: '', command: null, input: '{}', output: 'EXAMPLE-OUTPUT-NOT-SHOWN-IN-REVIEW', cwd: '/example',
  exitCode: 0, processId: null, startedAt: stamp(n), finishedAt: stamp(n + 1), durationMs: 1200, revision: 1, contentRevision: 1, ...extra,
});
/** Everything the "server" stored, including tool calls a bootstrap does not carry. */
const stored = new Map<string, ToolCall[]>();
const fullTools: Record<string, ToolCall[]> = {
  'run-ok': [
    tool('ok-test', 'run-ok', 2, { command: 'node --test', summary: 'Run the example tests' }),
    tool('ok-diff', 'run-ok', 3, { command: 'git diff --stat' }),
    tool('ok-lint', 'run-ok', 4, { command: 'npm run lint', status: 'failed', exitCode: 2 }),
    tool('ok-done', 'run-ok', 5, { command: 'echo done', exitCode: null }),
    tool('ok-grep', 'run-ok', 6, { name: 'Grep', category: 'search', command: null, summary: 'Search for TODO', exitCode: null }),
  ],
  'run-partial': [
    ...Array.from({ length: 55 }, (_, i) => tool(`part-${i}`, 'run-partial', 10 + i, { command: `step-${i}`, exitCode: i === 3 ? 1 : 0 })),
    tool('part-file', 'run-partial', 100, { name: 'Edit', category: 'file', command: null, summary: 'Edit many.ts', status: 'failed', exitCode: null }),
  ],
  'run-unavail': [0, 1, 2].map((i) => tool(`un-${i}`, 'run-unavail', 20 + i, { command: `check-${i}`, exitCode: 0 })),
  'run-failed': [tool('fail-1', 'run-failed', 30, { command: 'missing-binary --run', status: 'failed', exitCode: 127 })],
  'run-interrupted': [tool('int-1', 'run-interrupted', 40, { command: 'sleep 60', status: 'interrupted', exitCode: null, finishedAt: null, durationMs: null })],
  'run-tool-failure': [tool('tool-fail-1', 'run-tool-failure', 45, { name: 'Edit', category: 'file', command: null, summary: 'Example file write failed', status: 'failed', exitCode: null })],
  'run-latest': [tool('latest-1', 'run-latest', 50, { command: 'npm run build', summary: 'Build the example', exitCode: 0 })],
  'run-orphan': [tool('orphan-1', 'run-orphan', 1, { command: 'ls', exitCode: 0 })],
};
// A bootstrap carries only some of them: the partial run shows three of 55, and the unavailable run none of its three.
const carried: Record<string, number> = { 'run-ok': 5, 'run-partial': 3, 'run-unavail': 0, 'run-failed': 1, 'run-interrupted': 1, 'run-latest': 1, 'run-orphan': 1 };

const goalReports: Record<string, RunReviewEvidence['goalTurn']> = {
  'run-ok': { workflowId: 'wfl_example', sequence: 2, kind: 'verify', report: { outcome: 'complete', summary: 'Example agent report: the helper is finished.', state: 'applied' } },
  'run-goal': { workflowId: 'wfl_example', sequence: 3, kind: 'continue', report: { outcome: 'blocked', summary: 'Example agent report: waiting for credentials.', state: 'applied' } },
};
const failures: Record<string, RunReviewEvidence['failure']> = {
  'run-failed': { kind: 'quota_exhausted', message: 'Example provider quota was exhausted.', occurredAt: stamp(31), outcomeUnknown: true },
};

const db = { runs: new Map<string, SessionRun>(), tasks: [] as Task[], workflows: [] as SessionWorkflow[] };
function seed() {
  messages.length = 0; runs.length = 0; db.runs.clear(); stored.clear();
  for (const turn of turns) {
    const base = turn.n * 100;
    messages.push({ id: `u${turn.n}`, sessionId: 'a', role: 'user', content: `Example request ${turn.n}: ${turn.run}.`, createdAt: stamp(base) });
    if (turn.assistant) messages.push({ id: `a${turn.n}`, sessionId: 'a', role: 'assistant', runId: turn.run, content: `Example reply ${turn.n} from ${turn.run}.`, createdAt: stamp(base + 50) });
    const full = fullTools[turn.run] ?? [];
    const counts: Partial<Record<ToolCall['category'], number>> = {};
    for (const call of full) counts[call.category] = (counts[call.category] ?? 0) + 1;
    const row: SessionRun = {
      id: turn.run, sessionId: 'a', userMessageId: `u${turn.n}`, provider: 'claude', model: 'example-model', status: turn.status, startedAt: stamp(base), finishedAt: stamp(base + 40),
      durationMs: 40_000, toolCount: full.length, toolCounts: counts, changes: turn.changes,
    };
    runs.push(row);
  }
  // An orphan whose user message is not loaded (older history), the oldest run by start time.
  const orphanTools = fullTools['run-orphan']!;
  runs.push({ id: 'run-orphan', sessionId: 'a', userMessageId: 'u-not-loaded', provider: 'claude', model: 'example-model', status: 'completed', startedAt: stamp(-50), finishedAt: stamp(-40), durationMs: 10_000, toolCount: orphanTools.length, toolCounts: { command: 1 }, changes: capture([file('src/orphan.ts', 'M', 1, 0)]) });
  for (const row of runs) db.runs.set(row.id, row);
  db.workflows = [{
    id: 'wfl_example', sessionId: 'a', taskId: 'task-goal', goal: 'Example goal: finish the helper.', state: 'paused', version: 4, stopReason: 'agent-blocked', summary: 'Latest goal summary that must not appear on other runs.',
    limits: { maxTurns: 8, maxElapsedMinutes: 240, maxStalls: 2 }, counters: { turns: 3, stalls: 0 }, currentRunId: null, lastRunId: 'run-goal',
    configuration: { provider: 'claude', model: 'example-model', effort: 'medium', policy: 'supervised', serviceTier: 'standard', worktreePath: '/example', branch: null }, createdAt: stamp(0), updatedAt: stamp(900), deadlineAt: stamp(90_000),
  }];
  const provider = (id: string, title: string, reported: 'pending' | 'in_progress' | 'completed' | 'blocked', status: Task['status'], order: number, runId = 'run-ok'): Task => ({
    id, projectId: 'p1', title, description: '', acceptanceCriteria: '', sessionId: 'a', dependsOn: [], status, createdAt: stamp(order), updatedAt: stamp(order),
    source: { kind: 'provider', key: `provider:a:plan:${id}`, runId, providerId: id, reportedStatus: reported },
  });
  db.tasks = [
    provider('step-1', 'Example step: write the helper', 'completed', 'review', 1),
    provider('step-2', 'Example step: document the helper', 'pending', 'ready', 2),
    provider('step-3', 'Example step: publish the helper', 'blocked', 'blocked', 3),
    provider('step-x', 'Example step on a later run', 'completed', 'review', 4, 'run-latest'),
  ];
}

const trimmed = (id: string): ToolCall[] => (fullTools[id] ?? []).slice(0, carried[id] ?? 0).map((call) => ({ ...call, output: call.output.slice(-2000) }));

/** The stand-in server's review: metadata only, the first 50 commands, the first 20 problems, counts over everything stored. */
function review(runId: string): RunReviewEvidence | null {
  const run = db.runs.get(runId);
  if (!run) return null;
  const all = fullTools[runId] ?? [];
  const commands = all.filter((call) => call.category === 'command');
  const problem = (call: ToolCall) => call.status === 'failed' || call.status === 'interrupted' || (call.exitCode !== null && call.exitCode !== 0);
  const problems = all.filter(problem);
  const counts: RunReviewEvidence['tools']['counts'] = {};
  for (const call of all) counts[call.category] = (counts[call.category] ?? 0) + 1;
  return {
    runId, sessionId: 'a', status: run.status, readAt: new Date().toISOString(),
    tools: { total: all.length, counts, failed: all.filter((c) => c.status === 'failed').length, interrupted: all.filter((c) => c.status === 'interrupted').length, running: all.filter((c) => c.status === 'running').length, nonZeroExit: all.filter((c) => c.exitCode !== null && c.exitCode !== 0).length },
    commands: { total: commands.length, truncated: commands.length > 50, items: commands.slice(0, 50).map((c) => ({ id: c.id, name: c.name, command: c.command, summary: c.summary, status: c.status, exitCode: c.exitCode, durationMs: c.durationMs, cwd: c.cwd })) },
    problems: { total: problems.length, truncated: problems.length > 20, items: problems.slice(0, 20).map((c) => ({ id: c.id, name: c.name, category: c.category, status: c.status, exitCode: c.exitCode, summary: c.summary })) },
    failure: failures[runId] ?? null,
    goalTurn: goalReports[runId] ?? null,
  };
}
const DIFF = `diff --git a/src/helper.ts b/src/helper.ts
--- a/src/helper.ts
+++ b/src/helper.ts
@@ -1,3 +1,4 @@
 export const helper = () => 1;
-export const old = 0;
+export const next = 1;
+export const more = 2;
diff --git a/docs/notes.md b/docs/notes.md
new file mode 100644
--- /dev/null
+++ b/docs/notes.md
@@ -0,0 +1,2 @@
+Example notes
+for the example helper
`;

interface Entry { method: string; path: string; kind: 'review' | 'changes' | 'other'; id: string; status: number; aborted: boolean; seq: number }
const log: Entry[] = [];
const control = { holding: false, gates: [] as Array<() => void>, fail: 0 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let seq = 0;

window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  const method = init?.method ?? 'GET';
  const reviewMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/review$/);
  const changesMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/changes$/);
  const entry: Entry = { method, path: url.pathname, kind: reviewMatch ? 'review' : changesMatch ? 'changes' : 'other', id: decodeURIComponent((reviewMatch ?? changesMatch)?.[1] ?? ''), status: 200, aborted: false, seq: ++seq };
  log.push(entry);
  init?.signal?.addEventListener('abort', () => { entry.aborted = true; });
  if (method !== 'GET' || (!reviewMatch && !changesMatch)) { entry.status = 404; return json(404, { error: 'Example fixture route only.' }); }
  const run = db.runs.get(entry.id);
  if (!run) { entry.status = 404; return json(404, { error: 'Run not found' }); }
  if (changesMatch) {
    const body: RunChanges | null = run.changes ? { summary: run.changes, diff: DIFF, diffTruncated: false } : null;
    if (!body) { entry.status = 404; return json(404, { error: 'This run has no saved change snapshot' }); }
    return json(200, body);
  }
  if (run.status === 'running') { entry.status = 409; return json(409, { error: 'A review is available after the run finishes' }); }
  // The server reads when the request arrives; a held answer therefore carries older data than the database holds later.
  const body = review(entry.id);
  const copy = JSON.parse(JSON.stringify(body)) as RunReviewEvidence;
  if (control.holding) await new Promise<void>((resolve) => { control.gates.push(resolve); });
  if (control.fail > 0) { control.fail--; entry.status = 503; return json(503, { error: 'Example review failure.' }); }
  return json(200, copy);
};

let root: ReturnType<typeof createRoot> | null = null;
function bootstrap(): Bootstrap {
  const toolCalls = Object.keys(carried).flatMap((id) => trimmed(id));
  return {
    projects: [{ id: 'p1', name: 'Example project', path: '/example', createdAt: stamp(0), isExample: true }],
    sessions: [session], messages, runs: [...db.runs.values()], toolCalls, workflows: db.workflows,
    tasks: db.tasks, events: [], approvals: [], plans: [], questions: [], providers: [], version: 'example', delegatedSubagents: [], groups: [],
    settings: { defaultProvider: 'claude', defaultCodexModel: 'x', defaultClaudeModel: 'x', defaultEffort: 'medium', defaultIsolated: false, defaultPolicy: 'supervised', theme: 'dark', claudeExecutable: '', codexExecutable: '' },
  } as unknown as Bootstrap;
}
const publish = () => useMingle.setState({ boot: JSON.parse(JSON.stringify(bootstrap())) as Bootstrap });

(window as unknown as { __review: unknown }).__review = {
  log: () => log.map((entry) => ({ ...entry })),
  clearLog: () => { log.length = 0; },
  mount() {
    seed();
    useMingle.setState({ boot: JSON.parse(JSON.stringify(bootstrap())) as Bootstrap, activeProjectId: 'p1', sessionByProject: { p1: 'a' }, connection: 'online', streams: {} });
    root = createRoot(document.getElementById('root')!);
    root.render(<div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}><SessionPane /></div>);
  },
  unmount() { root?.unmount(); root = null; },
  publish,
  /** A new run starts and later finishes: the card appears only once it has finished. */
  startLive() {
    const n = 10;
    messages.push({ id: `u${n}`, sessionId: 'a', role: 'user', content: 'Example request 10: a live run.', createdAt: stamp(n * 100) });
    const live: SessionRun = { id: 'run-live', sessionId: 'a', userMessageId: `u${n}`, provider: 'claude', model: 'example-model', status: 'running', startedAt: stamp(n * 100), finishedAt: null, durationMs: null, toolCount: 0, toolCounts: {}, changes: null };
    db.runs.set(live.id, live);
    session.status = 'running';
    publish();
  },
  finishLive(toolCount = 1) {
    const base = db.runs.get('run-live')!;
    fullTools['run-live'] = Array.from({ length: toolCount }, (_, i) => tool(`live-${i}`, 'run-live', 1000 + i, { command: `live-step-${i}`, exitCode: 0 }));
    carried['run-live'] = toolCount;
    messages.push({ id: 'a10', sessionId: 'a', role: 'assistant', runId: 'run-live', content: 'Example reply 10 from run-live.', createdAt: stamp(1050) });
    db.runs.set(base.id, { ...base, status: 'completed', finishedAt: stamp(1040), durationMs: 40_000, toolCount, toolCounts: { command: toolCount }, changes: capture([file('src/live.ts', 'A', 1, 0)]) });
    session.status = 'idle';
    publish();
  },
  /** The run record changes after the review was read (a late tool write), so the earlier answer describes an older version. */
  addTool(runId: string) {
    const list = fullTools[runId] ?? [];
    list.push(tool(`extra-${list.length}`, runId, 200 + list.length, { command: `late-step-${list.length}`, exitCode: 0 }));
    fullTools[runId] = list;
    carried[runId] = list.length;
    const run = db.runs.get(runId)!;
    db.runs.set(runId, { ...run, toolCount: list.length, toolCounts: { ...run.toolCounts, command: (run.toolCounts.command ?? 0) + 1 } });
    publish();
  },
  setChecklist(stepId: string, reported: 'pending' | 'completed') {
    db.tasks = db.tasks.map((task) => task.id === stepId ? { ...task, source: { ...task.source!, reportedStatus: reported }, status: reported === 'completed' ? 'review' : 'ready' } : task);
    publish();
  },
  taskStatuses: () => Object.fromEntries((useMingle.getState().boot?.tasks ?? []).map((task) => [task.id, task.status])),
  hold() { control.holding = true; },
  heldCount: () => control.gates.length,
  releaseAll() { control.holding = false; control.gates.splice(0).forEach((resolve) => resolve()); },
  fail(times = 1) { control.fail = times; },
};
