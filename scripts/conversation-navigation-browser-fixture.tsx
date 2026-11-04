import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationNavigation } from '../apps/web/src/components/ConversationNavigation';
import { QueuedMessages } from '../apps/web/src/components/composer/QueuedMessages';
import { TranscriptList } from '../apps/web/src/components/TranscriptList';
import { createTranscriptDeriver } from '../apps/web/src/lib/transcript';
import { useMingle } from '../apps/web/src/store/store';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/base.css';
import '../apps/web/src/styles/ui.css';
import '../apps/web/src/styles/polish.css';
import '../apps/web/src/styles/conversation.css';
import '../apps/web/src/styles/run-activity.css';
import '../apps/web/src/styles/run-review.css';
import '../apps/web/src/styles/app.css';

const at = '2026-11-04T00:00:00.000Z';
const examples = [
  { id: 'example-message-1', sessionId: 'example-session', role: 'user' as const, content: 'Example duplicate phrase: check the parser', createdAt: at },
  { id: 'example-message-2', sessionId: 'example-session', role: 'assistant' as const, content: 'Example duplicate phrase: check the parser', createdAt: at },
  { id: 'example-message-3', sessionId: 'example-session', role: 'assistant' as const, content: 'Example newest response token=secret-value-must-not-persist', createdAt: at },
];
const run = { id: 'example-run', sessionId: 'example-session', userMessageId: examples[0]!.id, provider: 'claude' as const, model: 'example-model', status: 'completed' as const, startedAt: at, finishedAt: at, durationMs: 1, toolCount: 1, toolCounts: { command: 1 }, changes: { status: 'available' as const, capturedAt: at, fileCount: 1, files: [], additions: 1, deletions: 0, truncated: false, notices: [] } };
let messages = [...examples]; let older = false;
const queued = [{ id: 'example-queued', sessionId: 'example-session', content: 'Example queued text', intent: 'normal' as const, skills: ['skill-a'], attachmentIds: ['attachment-a'], contextRefs: [], createdAt: at }];
const bootForQueue = (items: typeof queued) => ({ queuedMessages: items }) as never;
type FixtureWindow = Window & { setRemoteQueueText?: (content: string) => void };
useMingle.setState({ refreshNow: async () => {}, boot: bootForQueue(queued) } as never);
const calls = [{ id: 'example-call', runId: run.id, sessionId: run.sessionId, providerId: 'example-provider-call', parentProviderId: null, name: 'Read', category: 'file' as const, status: 'completed' as const, summary: 'Example tool', command: null, input: '', output: '', cwd: null, exitCode: 0, processId: null, startedAt: at, finishedAt: at, durationMs: 1 }];
const derive = createTranscriptDeriver();
function App() {
  const [, update] = React.useState(0);
  const [active, setActive] = React.useState(true);
  const [queueItems, setQueueItems] = React.useState(queued);
  (window as FixtureWindow).setRemoteQueueText = (content) => {
    const next = queueItems.map((item) => ({ ...item, content }));
    setQueueItems(next);
    useMingle.setState({ boot: bootForQueue(next) });
  };
  const loadOlder = () => { if (!older) { older = true; messages = [{ ...examples[0]!, id: 'example-older-message', content: 'Example older history needle' }, ...messages]; update((x) => x + 1); } };
  const transcript = derive({ sessionId: 'example-session', provider: 'claude', model: 'example-model', running: false, messages, runs: [run], toolCalls: calls, streamIds: [], tasks: [], workflows: [] });
  return <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column', padding: 20, fontFamily: 'system-ui' }}><p>Example workspace fixture · no provider or server calls</p>
    <button type="button" onClick={() => setActive(!active)}>Toggle example run</button><QueuedMessages sessionId="example-session" items={queueItems} active={active} />
    <div className="chat__history"><ConversationNavigation projectId="example-project" sessionId="example-session" messages={messages} runs={[run]} calls={calls} hasOlder={!older} onLoadOlder={loadOlder} />
      <div className="chat__scroll"><div className="chat__inner chat__inner--history"><section style={{ width: 680, maxWidth: '100%' }}><TranscriptList layout={transcript.layout} sessionId="example-session" provider="claude" onOpenSubagent={() => {}} onGrow={() => {}} /></section></div></div>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
