// Example-only tool activity: no provider, account, network or inference. Drives the real SessionPane, store, transcript and
// RunActivity against an in-page stand-in for the tool endpoints. The "database" holds complete records and bumps `revision` /
// `contentRevision` exactly as the server's runtime does; bootstrap copies are bounded previews like Store.bootstrapToolCalls.
import { createRoot } from 'react-dom/client';
import type { Bootstrap, Message, Session, SessionRun, ToolCall } from '@mingle/contracts';
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

const T0 = Date.parse('2026-11-04T10:00:00Z');
const stamp = (n: number) => new Date(T0 + n * 1000).toISOString();
const rows = (count: number, tag: string) => Array.from({ length: count }, (_, i) => `${tag} ${String(i).padStart(4, '0')}`).join('\n');

const session: Session = {
  id: 'a', projectId: 'p1', name: 'Example tool output', provider: 'claude', model: 'example-model', effort: 'medium', status: 'running', policy: 'supervised', isolated: false,
  worktreePath: '/example', branch: null, providerSessionId: null, createdAt: stamp(0), updatedAt: stamp(0), error: null, inputTokens: 0, outputTokens: 0, costUsd: null, pinned: false, unread: false,
};
const messages: Message[] = [
  { id: 'u1', sessionId: 'a', role: 'user', content: 'Example request: build and test the example module.', createdAt: stamp(1) },
  { id: 'a1', sessionId: 'a', role: 'assistant', runId: 'run-main', content: 'Example reply: the build finished.', createdAt: stamp(20) },
  { id: 'u2', sessionId: 'a', role: 'user', content: 'Example follow-up: keep watching the long task.', createdAt: stamp(30) },
];
const runs: SessionRun[] = [
  { id: 'run-main', sessionId: 'a', userMessageId: 'u1', provider: 'claude', model: 'example-model', status: 'completed', startedAt: stamp(1), finishedAt: stamp(19), durationMs: 18000, toolCount: 5, toolCounts: { command: 3, search: 1, file: 1 }, changes: null },
  { id: 'run-live', sessionId: 'a', userMessageId: 'u2', provider: 'claude', model: 'example-model', status: 'running', startedAt: stamp(30), finishedAt: null, durationMs: null, toolCount: 1, toolCounts: { command: 1 }, changes: null },
];

const base = (id: string, runId: string, providerId: string, extra: Partial<ToolCall>): ToolCall => ({
  id, runId, sessionId: 'a', providerId, parentProviderId: null, name: 'Bash', category: 'command', status: 'completed', summary: '', command: null, input: '', output: '', cwd: '/example', exitCode: 0, processId: null,
  startedAt: stamp(2), finishedAt: stamp(3), durationMs: 1000, revision: 1, contentRevision: 1, ...extra,
});
const BUILD_OUTPUT = `BEGIN-OF-BUILD-OUTPUT\n${rows(900, 'build line')}\nEND-OF-BUILD-OUTPUT`; // about 11k characters
const BUILD_INPUT = JSON.stringify({ command: 'node build.mjs', env: rows(300, 'INPUT_ENTRY') }); // above the 4,000 character head
const CLIPPED_OUTPUT = `${rows(3000, 'clipped line')}`.slice(-20_000); // already the end of longer output when captured

const db = new Map<string, ToolCall>();
const seed = () => {
  db.clear();
  for (const call of [
    base('tool-build', 'run-main', 'p-build', { summary: 'Build bundle', command: 'node build.mjs', input: BUILD_INPUT, output: BUILD_OUTPUT, durationMs: 2400, startedAt: stamp(2) }),
    base('tool-grep', 'run-main', 'p-grep', { name: 'Grep', category: 'search', summary: 'Search for TODO', command: null, input: '{"pattern":"TODO"}', output: 'src/a.ts:4: TODO', parentProviderId: 'p-build', startedAt: stamp(3), exitCode: null }),
    base('tool-status', 'run-main', 'p-status', { summary: '', command: 'git status --short', output: ' M src/a.ts', startedAt: stamp(5) }),
    base('tool-tests', 'run-main', 'p-tests', { summary: 'Run test suite', command: 'npm test', status: 'failed', exitCode: 1, output: `${rows(250, 'test line')}\n1 failing`, startedAt: stamp(8) }),
    base('tool-clipped', 'run-main', 'p-clipped', { summary: 'Capture a very long log', command: 'cat big.log', output: CLIPPED_OUTPUT, outputTruncated: true, category: 'file', startedAt: stamp(12) }),
    base('tool-live', 'run-live', 'p-live', { summary: 'Long running task', command: 'node watch.mjs', status: 'running', finishedAt: null, durationMs: null, exitCode: null, output: rows(300, 'live line'), startedAt: stamp(31) }),
  ]) db.set(call.id, call);
};

/** The runtime's rule: any stored change bumps `revision`; a change to input/output also moves `contentRevision`. */
const mutate = (id: string, patch: Partial<ToolCall>): void => {
  const previous = db.get(id)!;
  const revision = (previous.revision ?? 0) + 1;
  const content = (patch.input !== undefined && patch.input !== previous.input) || (patch.output !== undefined && patch.output !== previous.output);
  db.set(id, { ...previous, ...patch, revision, contentRevision: content ? revision : previous.contentRevision });
};
const preview = (call: ToolCall): ToolCall => call.input.length <= 4000 && call.output.length <= 2000 ? { ...call }
  : { ...call, input: call.input.slice(0, 4000), output: call.output.slice(-2000), preview: { inputChars: call.input.length, outputChars: call.output.length } };

let root: ReturnType<typeof createRoot> | null = null;
interface Entry { kind: 'tool' | 'list'; id: string; status: number }
const log: Entry[] = [];
const control = { holding: false, gates: [] as Array<() => void>, fail: 0, listFails: false };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  const tool = url.pathname.match(/^\/api\/tool-calls\/([^/]+)$/);
  const list = url.pathname.match(/^\/api\/runs\/([^/]+)\/tools$/);
  if ((!tool && !list) || (init?.method ?? 'GET') !== 'GET') return json(404, { error: 'Example fixture route only.' });
  const entry: Entry = tool ? { kind: 'tool', id: decodeURIComponent(tool[1]!), status: 200 } : { kind: 'list', id: decodeURIComponent(list![1]!), status: 200 };
  log.push(entry);
  // The server reads its record when the request arrives; a held response therefore carries older data than the database holds later.
  const body = tool ? db.get(entry.id) : [...db.values()].filter((call) => call.runId === entry.id);
  const copy = JSON.parse(JSON.stringify(body ?? null)) as unknown;
  if (control.holding && tool) await new Promise<void>((resolve) => { control.gates.push(resolve); });
  if (entry.kind === 'list' && control.listFails) { entry.status = 503; return json(503, { error: 'Example list failure.' }); }
  if (entry.kind === 'tool' && control.fail > 0) { control.fail--; entry.status = 500; return json(500, { error: 'Example detail failure.' }); }
  if (!copy) { entry.status = 404; return json(404, { error: 'Not found' }); }
  return json(200, copy);
};

function bootstrap(): Bootstrap {
  return {
    projects: [{ id: 'p1', name: 'Example project', path: '/example', createdAt: stamp(0), isExample: true }],
    sessions: [session], messages, runs, toolCalls: [...db.values()].map(preview),
    tasks: [], events: [], approvals: [], plans: [], questions: [], providers: [], version: 'example', delegatedSubagents: [], groups: [],
    settings: { defaultProvider: 'claude', defaultCodexModel: 'x', defaultClaudeModel: 'x', defaultEffort: 'medium', defaultIsolated: false, defaultPolicy: 'supervised', theme: 'dark', claudeExecutable: '', codexExecutable: '' },
  } as unknown as Bootstrap;
}
const publish = () => useMingle.setState({ boot: JSON.parse(JSON.stringify(bootstrap())) as Bootstrap });

(window as unknown as { __tools: unknown }).__tools = {
  log: () => log.map((entry) => ({ ...entry })),
  clearLog: () => { log.length = 0; },
  mount() {
    seed();
    useMingle.setState({ boot: bootstrap(), activeProjectId: 'p1', sessionByProject: { p1: 'a' }, connection: 'online', streams: {} });
    root = createRoot(document.getElementById('root')!);
    root.render(<div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}><SessionPane /></div>);
  },
  /** Store a provider change and publish a fresh snapshot, as a scoped refresh would. */
  change(id: string, patch: Partial<ToolCall>) { mutate(id, patch); publish(); },
  /** Store a change without publishing, so a held response can carry older data than a later snapshot. */
  store(id: string, patch: Partial<ToolCall>) { mutate(id, patch); },
  publish,
  unmount() { root?.unmount(); root = null; },
  /** Hold every following detail response until released; each held request carries the data of when it arrived. */
  hold() { control.holding = true; },
  heldCount: () => control.gates.length,
  /** Release one held response (by arrival order) while the rest stay held. */
  releaseNth(n: number) { control.gates[n]?.(); control.gates[n] = () => undefined; },
  releaseAll() { control.holding = false; control.gates.splice(0).forEach((resolve) => resolve()); },
  failDetail(times = 1) { control.fail = times; },
  failList(on: boolean) { control.listFails = on; },
  record: (id: string) => db.get(id),
  constants: { BUILD_OUTPUT_LENGTH: BUILD_OUTPUT.length, BUILD_INPUT_LENGTH: BUILD_INPUT.length, CLIPPED_LENGTH: CLIPPED_OUTPUT.length },
};
