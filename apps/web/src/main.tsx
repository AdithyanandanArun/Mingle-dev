import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/app.css';
import './styles/shell.css';
import './styles/select-menu.css';
import './styles/context-menu.css';
import './styles/settings.css';
import './styles/conversation.css';
import './styles/message-context.css';
import './styles/usage.css';
import './styles/run-activity.css';
import './styles/run-changes.css';
import './styles/import-dialog.css';
import './styles/project-picker.css';
import './styles/browser.css';
import './styles/browser-footer.css';
import './styles/git.css';
import './styles/automation.css';
import './styles/groups.css';
import './styles/attachments.css';
import './styles/polish.css';
import { App } from './App';
import { Boundary } from './components/ui';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boundary label="Mingle">
      <App />
    </Boundary>
  </StrictMode>,
);
