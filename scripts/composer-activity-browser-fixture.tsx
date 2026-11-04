// Example fixture page for composer activity acceptance. Mounts the real SessionPane (Chat, Composer, SubagentRail,
// UserQuestionCard) against the Zustand store; the acceptance script answers every /api request and the store socket
// locally, so no provider, provider process or cloud service is reached. All records are labelled Example data.
import { createRoot } from 'react-dom/client';
import { SessionPane } from '../apps/web/src/components/Chat';
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
import '../apps/web/src/styles/import-dialog.css';
import '../apps/web/src/styles/project-picker.css';
import '../apps/web/src/styles/browser.css';
import '../apps/web/src/styles/browser-footer.css';
import '../apps/web/src/styles/git.css';
import '../apps/web/src/styles/automation.css';
import '../apps/web/src/styles/groups.css';
import '../apps/web/src/styles/attachments.css';
import '../apps/web/src/styles/polish.css';

// The acceptance script drives the store's normal bootstrap path; no installed runtime is contacted.
useMingle.setState({ connection: 'online' });
(window as unknown as { refreshExampleBootstrap: () => Promise<void> }).refreshExampleBootstrap = () => useMingle.getState().refreshNow();

function Fixture() {
  const booted = useMingle((state) => state.boot !== null);
  if (!booted) return <p role="alert">Example bootstrap failed.</p>;
  return <main className="composer-activity-fixture" style={{ height: '100dvh', display: 'flex', flexDirection: 'column', position: 'relative' }}>
    <p role="status" className="composer-activity-fixture__label">Example workspace · fixture data only · no provider or cloud access</p>
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <SessionPane />
    </div>
  </main>;
}

void useMingle.getState().refreshNow().then(() => {
  createRoot(document.getElementById('root')!).render(<Fixture />);
});
