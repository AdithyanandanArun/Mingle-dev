import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationNavigation } from '../apps/web/src/components/ConversationNavigation';
import { QueuedMessages } from '../apps/web/src/components/composer/QueuedMessages';
import { useMingle } from '../apps/web/src/store/store';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/base.css';
import '../apps/web/src/styles/ui.css';
import '../apps/web/src/styles/polish.css';

const at = '2026-11-04T00:00:00.000Z';
const examples = [
  { id: 'example-message-1', sessionId: 'example-session', role: 'user' as const, content: 'Example duplicate phrase: check the parser', createdAt: at },
  { id: 'example-message-2', sessionId: 'example-session', role: 'assistant' as const, content: 'Example duplicate phrase: check the parser', createdAt: at },
  { id: 'example-message-3', sessionId: 'example-session', role: 'assistant' as const, content: 'Example newest response token=secret-value-must-not-persist', createdAt: at },
];
const run = { id: 'example-run', sessionId: 'example-session', userMessageId: examples[0]!.id, provider: 'claude' as const, model: 'example-model', status: 'completed' as const, startedAt: at, finishedAt: at, durationMs: 1, toolCount: 1, toolCounts: { command: 1 }, changes: { status: 'available' as const, capturedAt: at, fileCount: 1, files: [], additions: 1, deletions: 0, truncated: false, notices: [] } };
let messages = [...examples]; let older = false;
useMingle.setState({ refreshNow: async () => {} } as never);
const queued = [{ id: 'example-queued', sessionId: 'example-session', content: 'Example queued text', intent: 'normal' as const, skills: ['skill-a'], attachmentIds: ['attachment-a'], contextRefs: [], createdAt: at }];
function App() {
  const [, update] = React.useState(0);
  const [active, setActive] = React.useState(true);
  const loadOlder = () => { if (!older) { older = true; messages = [{ ...examples[0]!, id: 'example-older-message', content: 'Example older history needle' }, ...messages]; update((x) => x + 1); } };
  return <main style={{ padding: 20, fontFamily: 'system-ui' }}><p>Example workspace fixture · no provider or server calls</p>
    <ConversationNavigation projectId="example-project" sessionId="example-session" messages={messages} runs={[run]} calls={[{ id: 'example-call', runId: run.id, sessionId: run.sessionId, providerId: 'claude', parentProviderId: null, name: 'Read', category: 'file', status: 'completed', summary: 'Example tool', command: null, input: '', output: '', cwd: null, exitCode: 0, processId: null, startedAt: at, finishedAt: at, durationMs: 1 }]} hasOlder={!older} onLoadOlder={loadOlder} />
    <button type="button" onClick={() => setActive(!active)}>Toggle example run</button><QueuedMessages sessionId="example-session" items={queued} active={active} />
    {messages.map((message) => <article tabIndex={-1} data-message-id={message.id} key={message.id} style={{ marginTop: 500, minHeight: 120 }}>{message.content}</article>)}
    <div data-run-id={run.id} data-run-review-id={run.id} tabIndex={-1} style={{ marginTop: 500 }}>Example run and review</div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
