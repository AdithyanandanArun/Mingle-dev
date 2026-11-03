// Example-only transcript: no provider, account, network or inference. Drives the real SessionPane and store with synthetic streamed text.
import { createRoot } from 'react-dom/client';
import type { Bootstrap, Message, Session, SessionRun, ToolCall } from '@mingle/contracts';
import { SessionPane } from '../apps/web/src/components/Chat';
import { useMingle } from '../apps/web/src/store/store';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/base.css';
import '../apps/web/src/styles/ui.css';
import '../apps/web/src/styles/app.css';

const T0 = Date.parse('2026-11-01T10:00:00Z');
const stamp = (n: number) => new Date(T0 + n * 1000).toISOString();
const session = (id: string, status: Session['status']): Session => ({
  id, projectId: 'p1', name: `Example ${id}`, provider: 'claude', model: 'example-model', effort: 'medium', status, policy: 'supervised', isolated: false,
  worktreePath: '/example', branch: null, providerSessionId: null, createdAt: stamp(0), updatedAt: stamp(0), error: null, inputTokens: 0, outputTokens: 0, costUsd: null, pinned: false, unread: false,
});

function transcript(sessionId: string, turns: number): { messages: Message[]; runs: SessionRun[]; toolCalls: ToolCall[] } {
  const messages: Message[] = []; const runs: SessionRun[] = []; const toolCalls: ToolCall[] = [];
  for (let i = 0; i < turns; i++) {
    const runId = `${sessionId}-run-${i}`; const userId = `${sessionId}-u-${i}`;
    const last = i === turns - 1;
    messages.push({ id: userId, sessionId, role: 'user', content: `Example question ${i}: explain the **example** module ${i}.`, createdAt: stamp(i * 10) });
    messages.push({ id: `${sessionId}-a-${i}`, sessionId, role: 'assistant', runId, content: last ? '' : `Example answer ${i}.\n\n- point one\n- point two\n\n\`\`\`ts\nconst value = ${i};\n\`\`\``, createdAt: stamp(i * 10 + 5), kind: last ? 'streaming' : undefined });
    runs.push({ id: runId, sessionId, userMessageId: userId, provider: 'claude', model: 'example-model', status: last ? 'running' : 'completed', startedAt: stamp(i * 10), finishedAt: last ? null : stamp(i * 10 + 6), durationMs: last ? null : 6000, toolCount: 2, toolCounts: { command: 2 },
      changes: last ? null : { status: 'available', capturedAt: stamp(i * 10 + 6), fileCount: 1, files: [{ path: `src/example${i}.ts`, status: 'M', additions: 3, deletions: 1, binary: false }], additions: 3, deletions: 1, truncated: false, notices: [] } });
    for (let t = 0; t < 2; t++) toolCalls.push({ id: `${runId}-t${t}`, runId, sessionId, providerId: `${runId}-p${t}`, parentProviderId: null, name: 'Bash', category: 'command', status: 'completed', summary: 'ls', command: 'ls', input: '{}', output: 'ok', cwd: null, exitCode: 0, processId: null, startedAt: stamp(i * 10 + 1 + t), finishedAt: stamp(i * 10 + 2 + t), durationMs: 1000 });
  }
  return { messages, runs, toolCalls };
}

const w = window as unknown as { __perf: unknown };
w.__perf = {
  mount(turns: number) {
    const a = transcript('a', turns); const b = transcript('b', turns);
    const boot = {
      projects: [{ id: 'p1', name: 'Example project', path: '/example', createdAt: stamp(0), isExample: true }],
      sessions: [session('a', 'running'), session('b', 'running')],
      messages: [...a.messages, ...b.messages], runs: [...a.runs, ...b.runs], toolCalls: [...a.toolCalls, ...b.toolCalls],
      tasks: [], events: [], approvals: [], plans: [], questions: [], providers: [], version: 'example', delegatedSubagents: [], groups: [],
      settings: { defaultProvider: 'claude', defaultCodexModel: 'x', defaultClaudeModel: 'x', defaultEffort: 'medium', defaultIsolated: false, defaultPolicy: 'supervised', theme: 'dark', claudeExecutable: '', codexExecutable: '' },
    } as unknown as Bootstrap;
    useMingle.setState({ boot, activeProjectId: 'p1', sessionByProject: { p1: 'a' }, connection: 'online', streams: {} });
    createRoot(document.getElementById('root')!).render(<div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}><SessionPane /></div>);
  },
  stream(sessionId: string, messageId: string, delta: string) {
    const { streams } = useMingle.getState(); const existing = streams[messageId];
    useMingle.setState({ streams: { ...streams, [messageId]: { sessionId, base: existing?.base ?? '', text: (existing?.text ?? '') + delta } } });
  },
  refreshBoot() {
    // Mimics the debounced bootstrap refetch: structurally identical data, all-new object identities.
    const boot = JSON.parse(JSON.stringify(useMingle.getState().boot)) as Bootstrap;
    useMingle.setState({ boot });
  },
  workflowInstructions() {
    useMingle.setState((state) => ({ boot: state.boot ? { ...state.boot, messages: [...state.boot.messages,
      ...['workflow-continuation', 'workflow-verification', 'workflow-resume'].map((kind, index): Message => ({
        id: `example-${kind}`, sessionId: 'a', role: 'user', kind,
        content: `Example internal follow-through prompt ${index}.`, createdAt: stamp(2000 + index),
      })),
    ] } : null }));
  },
};
