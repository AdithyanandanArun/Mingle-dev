import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Bootstrap, QueuedMessage, Session } from '@mingle/contracts';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/base.css';
import '../apps/web/src/styles/ui.css';
import '../apps/web/src/styles/app.css';
import '../apps/web/src/styles/shell.css';
import '../apps/web/src/styles/polish.css';
import '../apps/web/src/styles/select-menu.css';
import '../apps/web/src/styles/context-menu.css';
import '../apps/web/src/styles/settings.css';
import '../apps/web/src/styles/workspace-ux.css';

// Explicit Example fixtures; no provider discovery, commands, shell or cloud connection.
class ExampleIdleWebSocket { static readonly OPEN = 1; readyState = 3; close() {} }
Object.defineProperty(window, 'WebSocket', { configurable: true, value: ExampleIdleWebSocket });
const [{ useMingle }, { useEditor }, { Markdown }, { Files }, { ConversationNavigation }, { QueuedMessages }, { terminalBus }, { default: TerminalPanel }, { Palette }, { Button, IconButton, Segmented, Switch, Modal }, { SelectMenu }, { ContextMenu }] = await Promise.all([
  import('../apps/web/src/store/store'), import('../apps/web/src/store/editor'), import('../apps/web/src/components/Markdown'),
  import('../apps/web/src/components/context/Files'), import('../apps/web/src/components/ConversationNavigation'),
  import('../apps/web/src/components/composer/QueuedMessages'), import('../apps/web/src/store/terminalBus'),
  import('../apps/web/src/components/TerminalPanel'), import('../apps/web/src/components/Palette'),
  import('../apps/web/src/components/ui'), import('../apps/web/src/components/SelectMenu'), import('../apps/web/src/components/ContextMenu'),
]);
const now = '2026-11-09T06:30:00Z';
const session: Session = { id: 'example-session', projectId: 'example-project', name: 'Example session', provider: 'codex', model: 'Example model', effort: 'medium', status: 'idle', policy: 'supervised', isolated: false, worktreePath: '/example', branch: null, providerSessionId: null, createdAt: now, updatedAt: now, error: null, inputTokens: 0, outputTokens: 0, costUsd: null, pinned: false, unread: false };
const boot: Bootstrap = {
  projects: [{ id: 'example-project', name: 'Example project', path: '/example', isExample: true, createdAt: now }], sessions: [session],
  messages: [], tasks: [], events: [], approvals: [], plans: [], questions: [], providers: [], runs: [], toolCalls: [], groups: [], version: 'Example UX fixture',
  settings: { defaultProvider: 'codex', defaultCodexModel: 'Example model', defaultClaudeModel: 'Example model', defaultEffort: 'medium', defaultIsolated: false, defaultPolicy: 'supervised', theme: 'dark', claudeExecutable: '', codexExecutable: '' },
};
const messages = Array.from({ length: 105 }, (_, i) => ({ id: `example-message-${i}`, sessionId: session.id, role: i % 2 ? 'assistant' as const : 'user' as const, content: `Example find needle ${i}`, createdAt: now }));
const queue: QueuedMessage[] = [{ id: 'example-queue', sessionId: session.id, content: 'Example original queued task', intent: 'normal', skills: [], attachmentIds: [], contextRefs: [], createdAt: now }];
const stats = { shellStarts: 0, shellStops: 0, shellInputs: 0 };
await useMingle.getState().refreshNow();
useMingle.setState({ boot, bootLoading: false, activeProjectId: 'example-project', sessionByProject: { 'example-project': session.id }, connection: 'online', scope: 'project', refreshNow: async () => {},
  terminal: { status: 'running', terminalId: 'example-terminal', exitCode: null, projectId: 'example-project', sessionId: null, label: 'Example shell (scripted output only)', note: null },
  startTerminal: () => { stats.shellStarts++; }, stopTerminal: () => { stats.shellStops++; }, sendTerminalInput: () => { stats.shellInputs++; }, resizeTerminal: () => {},
});
const scene = new URLSearchParams(location.search).get('scene') || 'markdown';
// Resolve Monaco before mounting so Vite dependency discovery cannot reload an in-progress edit.
const EditorPane = scene === 'editor' ? (await import('../apps/web/src/components/EditorPane')).default : null;
const globals = window as unknown as { exampleUX: { stats: typeof stats; terminalText: () => string; setTheme: (theme: 'dark' | 'light') => void } };
globals.exampleUX = { stats, terminalText: terminalBus.snapshot, setTheme: (theme) => { document.documentElement.dataset.theme = theme; } };
function Fixture() {
  const [queued, setQueued] = useState(queue);
  const [choice, setChoice] = useState('disabled');
  const [checked, setChecked] = useState(false);
  const [context, setContext] = useState(false);
  const [modal, setModal] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState(false);
  const [key, setKey] = useState('');
  const editor = useEditor();
  const mountEditor = () => { useEditor.getState().open('example-project', null, 'example.txt'); setKey(useEditor.getState().tabs[0]!.key); };
  return <main style={{ padding: 12, height: '100dvh', overflow: 'auto' }}>
    <p>Example workspace UX · no inference or real shell</p>
    {scene === 'controls' ? <section aria-label="Example controls" style={{ display: 'grid', gap: 12 }}>
      <Button aria-busy="true">Example external busy</Button>
      <p id="example-description">Example shared description</p>
      <IconButton label="Example refresh" busy why="Example work in progress" aria-describedby="example-description">↻</IconButton>
      <Segmented label="Example choices" value={choice} onChange={setChoice} options={[{ value: 'disabled', label: 'Disabled', disabled: true }, { value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }, { value: 'gamma', label: 'Gamma' }]} />
      <Switch label="Example switch" description="Example switch explanation" checked={checked} onChange={setChecked} />
      <SelectMenu label="Example read only" value="apple" readOnly onChange={() => { throw new Error('Read-only selection changed'); }} options={[{ value: 'apple', label: 'Apple' }, { value: 'apricot', label: 'Apricot' }, { value: 'disabled', label: 'Disabled choice', disabled: true }]} />
      <button ref={opener} onClick={() => setContext(true)}>Example context menu</button>
      <button onClick={() => setModal(true)}>Example dialog</button>
      {context ? <ContextMenu x={40} y={50} returnFocus={opener.current} items={[{ id: 'first', label: 'Alpha one' }, { id: 'second', label: 'Alpha two' }]} onClose={() => setContext(false)} /> : null}
      {modal ? <Modal title="Example dialog" onClose={() => setModal(false)} footer={<><Button>Cancel example</Button><Button variant="primary">Continue example</Button></>}><input data-autofocus aria-label="Example hidden field" hidden /><input data-autofocus aria-label="Example visible field" /></Modal> : null}
    </section> : null}
    {scene === 'markdown'  ? <Markdown text={'Example answer\n\n```typescript\n' + 'const example = "' + 'a'.repeat(180) + '";\nconsole.log(example);\n```'} /> : null}
    {scene === 'files' ? <div style={{ width: 360, maxWidth: '100%', height: 480 }}><Files active /></div> : null}
    {scene === 'find' ? <><ConversationNavigation projectId="example-project" sessionId="example-session" messages={messages} runs={[]} calls={[]} hasOlder={false} onLoadOlder={() => {}} /><div>{messages.map((message) => <p key={message.id} data-message-id={message.id} tabIndex={-1}>{message.content}</p>)}</div></> : null}
    {scene === 'queue' ? <><QueuedMessages sessionId={session.id} items={queued} /><button onClick={() => { setQueued([{ ...queue[0]!, content: 'Example newer queued task' }]); useMingle.setState({ boot: { ...boot, queuedMessages: [{ ...queue[0]!, content: 'Example newer queued task' }] } }); }}>Example remote edit</button></> : null}
    {scene === 'terminal' ? <><button onClick={() => { terminalBus.push('Example retained terminal output\r\n'); setPanel(true); }}>Open example terminal</button>{panel ? <div style={{ height: 260 }}><TerminalPanel active /></div> : null}</> : null}
    {scene === 'editor' ? <><button onClick={() => void mountEditor()}>Open example editor</button><button onClick={() => useEditor.getState().edit(key, 'Example edited file')}>Example edit file</button><output aria-label="Example editor state">{JSON.stringify(editor.tabs.map(({ draft, original, saveError, saving }) => ({ draft, original, saveError, saving })))}</output>{EditorPane && key ? <div style={{ height: 400 }}><EditorPane tabKey={key} /></div> : null}</> : null}
    {scene === 'palette' ? <><button onClick={() => { useMingle.setState({ activeProjectId: null }); setPanel(true); }}>Open example palette</button>{panel ? <Palette /> : null}</> : null}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
