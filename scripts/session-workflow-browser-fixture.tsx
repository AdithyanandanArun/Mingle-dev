import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SubagentRail } from '../apps/web/src/components/subagents/SubagentRail';
import { Composer } from '../apps/web/src/components/Composer';
import { ApprovalCard, UserQuestionCard } from '../apps/web/src/components/ConversationParts';
import { useMingle } from '../apps/web/src/store/store';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/base.css';
import '../apps/web/src/styles/ui.css';
import '../apps/web/src/styles/app.css';
import '../apps/web/src/styles/select-menu.css';
import '../apps/web/src/styles/conversation.css';
import '../apps/web/src/styles/message-context.css';
import '../apps/web/src/styles/attachments.css';
import '../apps/web/src/styles/git.css';
import '../apps/web/src/styles/groups.css';
import '../apps/web/src/styles/usage.css';
import '../apps/web/src/styles/polish.css';

// Example fixture page: the acceptance script answers every /api request and mocks the store WebSocket locally.
// The real store is bootstrapped through its normal refresh path, with no connection to an installed runtime.
useMingle.setState({ connection: 'online' });
// Lets the acceptance script deliver a changed Example snapshot through the store's normal bootstrap path.
(window as unknown as { refreshExampleBootstrap: () => Promise<void> }).refreshExampleBootstrap = () => useMingle.getState().refreshNow();
(window as unknown as { getExampleSettingsState: () => { view: string; section: string } }).getExampleSettingsState = () => ({ view: useMingle.getState().view, section: useMingle.getState().settingsSection });

function Fixture() {
  const sessions = useMingle((state) => state.boot?.sessions ?? []);
  const projects = useMingle((state) => state.boot?.projects ?? []);
  const delegated = useMingle(state => state.boot?.delegatedSubagents);
  const runs = useMingle(state => state.boot?.runs ?? []);
  const approvals = useMingle(state => state.boot?.approvals ?? []);
  const questions = useMingle(state => state.boot?.questions ?? []);
  const integrated = new URLSearchParams(location.search).has('progress');
  const [openedHelper, setOpenedHelper] = useState('');
  const contextTab = useMingle((state) => state.contextTab);
  const [selected, setSelected] = useState(sessions[0]?.id ?? '');
  const session = sessions.find((item) => item.id === selected) ?? sessions[0];
  const project = projects.find((item) => item.id === session?.projectId);
  return <main className="workflow-fixture" style={{ maxWidth: 760, minHeight: '100dvh', margin: '0 auto', display: 'flex', flexDirection: 'column', padding: 10, gap: 10 }}>
    <header>
      <p style={{ fontSize: 11 }}>Example workspace · fixture data only · no provider or cloud access</p>
      <h1 style={{ fontSize: 14 }}>Autonomous workflow acceptance</h1>
      <nav aria-label="Example sessions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {sessions.map((item) => <button key={item.id} type="button" aria-pressed={item.id === session?.id} onClick={() => setSelected(item.id)}>Open {item.name}</button>)}
      </nav>
      <p id="fixture-project" role="status">Project: {project?.name ?? 'none'}</p>
      <p id="fixture-context-tab" role="status">Context tab: {contextTab ?? 'none'}</p>
    </header>
    <p>{openedHelper ? `Opened helper ${openedHelper}` : ''}</p>
    {runs.filter((run) => run.status !== 'running').map((run) => <section key={run.id} data-run-id={run.id} tabIndex={-1} aria-label="Example run review target">Example run review for {run.id}</section>)}
    <div style={{ flex: 1 }} />
    {questions.filter((item) => item.sessionId === session?.id).map((item) => <UserQuestionCard key={item.id} question={item} />)}
    {approvals.filter((item) => item.sessionId === session?.id).map((item) => <ApprovalCard key={item.id} approval={item} provider={session?.provider} />)}
    {session ? <Composer key={session.id} session={session}
      progressState={integrated ? { primary: 'Example current activity', running: session.status === 'running', steps: [{ id: 'example-step', title: 'Verify the Example change', status: 'in_progress' }] } : undefined}
      helperCount={delegated?.filter(item => item.parentSessionId === session.id).length ?? 0}
      helperRail={integrated ? <SubagentRail embedded subagents={[]} delegated={delegated?.filter(item => item.parentSessionId === session.id)} provider={session.provider} onOpen={() => {}} onOpenDelegated={item => setOpenedHelper(item.name)} /> : undefined} /> : <p role="alert">Example bootstrap failed.</p>}
  </main>;
}

void useMingle.getState().refreshNow().then(() => {
  createRoot(document.getElementById('root')!).render(<Fixture />);
});
