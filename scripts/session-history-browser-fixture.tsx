// Example-only long conversation: no provider, account, network or inference. Drives the real SessionPane, store and
// history client against an in-page stand-in for GET /api/sessions/:id/messages that follows the server's cursor rules.
import { createRoot } from 'react-dom/client';
import type { Bootstrap, Message, Session, SessionRun, ToolCall } from '@mingle/contracts';
import { SessionPane } from '../apps/web/src/components/Chat';
import { Header } from '../apps/web/src/components/Header';
import { Sidebar } from '../apps/web/src/components/Sidebar';
import { useMingle } from '../apps/web/src/store/store';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/base.css';
import '../apps/web/src/styles/ui.css';
import '../apps/web/src/styles/app.css';
import '../apps/web/src/styles/shell.css';
import '../apps/web/src/styles/select-menu.css';
import '../apps/web/src/styles/context-menu.css';
import '../apps/web/src/styles/settings.css';
import '../apps/web/src/styles/conversation.css';
import '../apps/web/src/styles/message-context.css';
import '../apps/web/src/styles/usage.css';
import '../apps/web/src/styles/run-activity.css';
import '../apps/web/src/styles/run-changes.css';
import '../apps/web/src/styles/run-review.css';
import '../apps/web/src/styles/git.css';
import '../apps/web/src/styles/groups.css';
import '../apps/web/src/styles/attachments.css';
import '../apps/web/src/styles/polish.css';

const WINDOW = 300; // the server's bootstrap window per session
const RUN_WINDOW = 200; // the server's bootstrap run limit
const T0 = Date.parse('2026-11-01T10:00:00Z');
const stamp = (n: number) => new Date(T0 + n * 1000).toISOString();
const pad = (n: number) => String(n).padStart(4, '0');
const session = (id: string, status: Session['status']): Session => ({
  id, projectId: 'p1', name: `Example ${id}`, provider: 'claude', model: 'example-model', effort: 'medium', status, policy: 'supervised', isolated: false,
  worktreePath: '/example', branch: null, providerSessionId: null, createdAt: stamp(0), updatedAt: stamp(0), error: null, inputTokens: 0, outputTokens: 0, costUsd: null, pinned: false, unread: false,
});

interface Turn { messages: Message[]; run: SessionRun; calls: ToolCall[] }
function turn(sessionId: string, i: number, last: boolean): Turn {
  const runId = `${sessionId}-run-${pad(i)}`; const userId = `${sessionId}-u-${pad(i)}`;
  const body = `Example answer ${i}.\n\n${'This paragraph is example filler so each answer takes realistic vertical space in the transcript. '.repeat(3)}\n\n- point one\n- point two\n\n\`\`\`ts\nconst value = ${i};\n\`\`\``;
  return {
    messages: [
      { id: userId, sessionId, role: 'user', content: `Example question ${pad(i)}: explain the **example** module ${i}.`, createdAt: stamp(i * 10) },
      { id: `${sessionId}-a-${pad(i)}`, sessionId, role: 'assistant', runId, content: last ? '' : body, createdAt: stamp(i * 10 + 5), kind: last ? 'streaming' : undefined },
    ],
    run: { id: runId, sessionId, userMessageId: userId, provider: 'claude', model: 'example-model', status: last ? 'running' : 'completed', startedAt: stamp(i * 10), finishedAt: last ? null : stamp(i * 10 + 6), durationMs: last ? null : 6000, toolCount: 2, toolCounts: { command: 2 },
      changes: last ? null : { status: 'available', capturedAt: stamp(i * 10 + 6), fileCount: 1, files: [{ path: `src/example${i}.ts`, status: 'M', additions: 3, deletions: 1, binary: false }], additions: 3, deletions: 1, truncated: false, notices: [] } },
    calls: [0, 1].map((t) => ({ id: `${runId}-t${t}`, runId, sessionId, providerId: `${runId}-p${t}`, parentProviderId: null, name: 'Bash', category: 'command' as const, status: 'completed' as const, summary: 'ls', command: 'ls', input: '{}', output: 'ok', cwd: null, exitCode: 0, processId: null, startedAt: stamp(i * 10 + 1 + t), finishedAt: stamp(i * 10 + 2 + t), durationMs: 1000 })),
  };
}

// The "database": every stored message of session a, in order.
let turnsA = 0;
let storedA: Message[] = [];
let turnData: Turn[] = [];
let statusA: Session['status'] = 'running';
const bTurns = Array.from({ length: 6 }, (_, i) => turn('b', i, false));

const log: Array<{ session: string; before: string | null; limit: number | null; status: number }> = [];
const control: { hold: Promise<void> | null; release: (() => void) | null; failNext: string | null } = { hold: null, release: null, failNext: null };
let sendFailure: string | null = null;
const sends: unknown[] = [];
let sendGate: { promise: Promise<void>; release: () => void } | null = null;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function ExampleAppShell() {
  const sidebarOpen = useMingle((state) => state.sidebarOpen);
  return <div className="app"><Sidebar /><button type="button" className={`sidebar-scrim${sidebarOpen ? ' is-open' : ''}`} aria-label="Close sidebar" aria-hidden={!sidebarOpen} inert={!sidebarOpen} tabIndex={-1} onClick={() => useMingle.getState().setSidebarOpen(false)} /><main className="main" id="main"><Header /><div className="main__body"><SessionPane /></div></main></div>;
}

window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.pathname.endsWith('/attachments')) return json(200, []);
  if (url.pathname.endsWith('/repository')) {
    const projectId = url.pathname.split('/')[3] ?? 'p1';
    return json(200, {
      projectId, sessionId: url.searchParams.get('sessionId'), root: '/example', isRepo: true,
      branch: 'example/session-history', head: '0'.repeat(40), detached: false,
      branches: [{ name: 'example/session-history', current: true }], remotes: [], upstream: null,
      ahead: 0, behind: 0, changes: [], fetchedAt: stamp(0), fingerprint: 'example-fixture', notices: [],
    });
  }
  if (url.pathname.endsWith('/github')) {
    return json(200, { status: 'unavailable', repository: null, url: null, branch: null, head: null, pullRequest: null, checks: [], workflows: [], fetchedAt: stamp(0), notices: ['Example fixture has no GitHub connection.'] });
  }
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (!match) return json(404, { error: 'Example fixture route only.' });
  if ((init?.method ?? 'GET') === 'POST') {
    sends.push(JSON.parse(String(init?.body ?? '{}')));
    if (sendGate) await sendGate.promise;
    if (sendFailure) { const failure = sendFailure; sendFailure = null; return json(503, { error: failure }); }
    return json(202, { accepted: true });
  }
  if ((init?.method ?? 'GET') !== 'GET') return json(404, { error: 'Example fixture route only.' });
  const sessionId = decodeURIComponent(match[1]!);
  const before = url.searchParams.get('before');
  const limit = Number(url.searchParams.get('limit') ?? 500);
  const entry = { session: sessionId, before, limit, status: 200 };
  log.push(entry);
  if (control.hold) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
      void control.hold!.then(resolve);
    });
  }
  if (control.failNext) { const error = control.failNext; control.failNext = null; entry.status = 500; return json(500, { error }); }
  const stored = sessionId === 'a' ? storedA : sessionId === 'b' ? bTurns.flatMap((t) => t.messages) : null;
  if (!stored) { entry.status = 404; return json(404, { error: 'Session not found' }); }
  if (before === null) return json(200, stored.slice(-limit));
  const at = stored.findIndex((message) => message.id === before);
  if (at < 0) { entry.status = 404; return json(404, { error: 'History cursor not found in this session' }); }
  return json(200, stored.slice(Math.max(0, at - limit), at));
};

function bootstrap(): Bootstrap {
  const window_ = storedA.slice(-WINDOW);
  const firstTurn = Number(window_[0]!.id.slice(-4));
  const runs = turnData.slice(Math.max(0, turnData.length - RUN_WINDOW)).map((t) => t.run);
  const runIds = new Set(runs.map((r) => r.id));
  const b = bTurns;
  return {
    projects: [{ id: 'p1', name: 'Example project', path: '/example', createdAt: stamp(0), isExample: true }],
    sessions: [session('a', statusA), session('b', 'idle')],
    messages: [...window_, ...b.flatMap((t) => t.messages)],
    runs: [...runs, ...b.map((t) => t.run)],
    toolCalls: [...turnData.flatMap((t) => t.calls).filter((c) => runIds.has(c.runId)), ...b.flatMap((t) => t.calls)],
    tasks: [], events: [], approvals: [], plans: [], questions: [], providers: [], version: 'example', delegatedSubagents: [], groups: [], firstTurn,
    settings: { defaultProvider: 'claude', defaultCodexModel: 'x', defaultClaudeModel: 'x', defaultEffort: 'medium', defaultIsolated: false, defaultPolicy: 'supervised', theme: 'dark', claudeExecutable: '', codexExecutable: '' },
  } as unknown as Bootstrap;
}

const publish = () => useMingle.setState({ boot: JSON.parse(JSON.stringify(bootstrap())) as Bootstrap });

(window as unknown as { __history: unknown }).__history = {
  log: () => log.slice(),
  sends: () => sends.slice(),
  mount(turns: number) {
    turnsA = turns;
    turnData = Array.from({ length: turns }, (_, i) => turn('a', i, i === turns - 1));
    storedA = turnData.flatMap((t) => t.messages);
    useMingle.setState({ boot: bootstrap(), activeProjectId: 'p1', sessionByProject: { p1: 'a' }, connection: 'online', streams: {} });
    createRoot(document.getElementById('root')!).render(<ExampleAppShell />);
  },
  /** New messages the server stored after the page loaded: the bootstrap window slides forward. */
  slide(count: number) {
    // The turn that was streaming finishes first, as it would on the server.
    const previous = turnData.length - 1;
    if (turnData[previous]!.run.status === 'running') {
      turnData[previous] = turn('a', previous, false);
      storedA.splice(storedA.length - 2, 2, ...turnData[previous]!.messages);
    }
    for (let k = 0; k < count; k++) {
      const i = turnsA++;
      const t = turn('a', i, false);
      turnData.push(t);
      storedA.push(...t.messages);
    }
    publish();
  },
  holdNext() { control.hold = new Promise<void>((resolve) => { control.release = () => { control.hold = null; control.release = null; resolve(); }; }); },
  release() { control.release?.(); },
  failNext(message: string) { control.failNext = message; },
  failSend(message: string) { sendFailure = message; },
  holdSend() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); sendGate = { promise, release }; },
  releaseSend() { sendGate?.release(); sendGate = null; },
  setStatus(sessionId: string, status: Session['status']) { if (sessionId === 'a') statusA = status; publish(); },
  select(sessionId: string) { useMingle.setState((s) => ({ sessionByProject: { ...s.sessionByProject, p1: sessionId } })); },
  stream(sessionId: string, messageId: string, delta: string) {
    const { streams } = useMingle.getState(); const existing = streams[messageId];
    useMingle.setState({ streams: { ...streams, [messageId]: { sessionId, base: existing?.base ?? '', text: (existing?.text ?? '') + delta } } });
  },
  refreshBoot() { publish(); },
};
