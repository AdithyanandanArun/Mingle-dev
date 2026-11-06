import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '../apps/web/src/components/ui';
import type { AppSettings, Bootstrap, ProviderInfo } from '@mingle/contracts';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/base.css';
import '../apps/web/src/styles/ui.css';
import '../apps/web/src/styles/app.css';
import '../apps/web/src/styles/shell.css';
import '../apps/web/src/styles/select-menu.css';
import '../apps/web/src/styles/context-menu.css';
import '../apps/web/src/styles/settings.css';
import '../apps/web/src/styles/usage.css';
import '../apps/web/src/styles/polish.css';

// Every provider and usage value in this fixture is synthetic example data.
const settings: AppSettings = {
  defaultProvider: 'codex', defaultCodexModel: 'example-codex-model', defaultClaudeModel: 'example-claude-model',
  defaultEffort: 'medium', defaultIsolated: true, defaultPolicy: 'supervised', theme: 'dark',
  claudeExecutable: 'claude', codexExecutable: 'codex',
};
const provider = (id: 'codex' | 'claude'): ProviderInfo => ({
  id, name: id === 'codex' ? 'Codex' : 'Claude', available: true, version: 'Example metadata', executable: null,
  reason: null, models: [{ id: `example-${id}-model`, name: `Example ${id} model`, reasoningEfforts: [{ id: 'medium', label: 'Medium' }] }],
});
const boot = {
  workflows: [], lastProjectId: null, projects: [], sessions: [], messages: [], tasks: [], events: [], approvals: [], plans: [], questions: [],
  providers: [provider('codex'), provider('claude')], settings, version: 'Example fixture', runs: [], toolCalls: [], groups: [],
} as Bootstrap;

async function mountFixture() {
  // The production store starts its local WebSocket when the dev module loads. Keep that unrelated connection inert here.
  class ExampleIdleWebSocket {
    static readonly OPEN = 1;
    readyState = 3;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor(_url: string) {}
    close() { this.readyState = 3; }
  }
  Object.defineProperty(window, 'WebSocket', { configurable: true, value: ExampleIdleWebSocket });
  const [{ SettingsPage }, { useMingle }] = await Promise.all([
    import('../apps/web/src/components/Settings'), import('../apps/web/src/store/store'),
  ]);
  await useMingle.getState().refreshNow();
  if (!useMingle.getState().boot) throw new Error('Example appearance bootstrap failed.');
  useMingle.setState({ boot: useMingle.getState().boot, bootLoading: false, bootError: null, staleError: null, view: 'settings', settingsSection: 'appearance', activeProjectId: null, settingsProjectId: null });
  function Fixture() {
    const current = useMingle((state) => state.boot?.settings);
    useEffect(() => { if (current) document.documentElement.dataset.theme = current.theme; }, [current?.theme]);
    return <div className="app">
      <aside className="sidebar" aria-label="Example workspace sidebar"><div className="sidebar__brand"><span className="brand-name">Mingle</span></div><button className="sitem is-active">Example session</button></aside>
      <main className="main">
        <header className="header header--settings"><div className="crumbs"><span className="crumbs__current">Settings</span></div><span className="small muted">Example appearance workspace · no provider calls</span></header>
        <section aria-label="Example controls" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '12px 20px', borderBottom: '1px solid var(--line)' }}>
          <Button variant="primary">Example primary</Button>
          <Button variant="secondary">Example secondary</Button>
          <Button variant="danger">Example destructive</Button>
          <Button variant="primary" disabled>Example disabled</Button>
          <button className="sendbtn" aria-label="Example send">↑</button>
        </section>
        <div className="main__body"><SettingsPage onReplayOnboarding={() => {}} /></div>
      </main>
    </div>;
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('Fixture root element is missing.');
  createRoot(root).render(<Fixture />);
}

void mountFixture();
