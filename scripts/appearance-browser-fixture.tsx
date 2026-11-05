import { useEffect } from 'react';
import { applyAppearance } from '../apps/web/src/lib/appearance';
import { createRoot } from 'react-dom/client';
import type { AppSettings, Bootstrap, ProviderInfo } from '@mingle/contracts';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/color-style.css';
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
  useMingle.setState({ boot, bootLoading: false, bootError: null, staleError: null, view: 'settings', settingsSection: 'appearance', activeProjectId: null, settingsProjectId: null });
  function Fixture() {
    const current = useMingle((state) => state.boot?.settings);
    useEffect(() => { if (current) applyAppearance(document.documentElement, current.theme, current.colorStyle); }, [current]);
    return <div className="app">
      <aside className="sidebar" aria-label="Example workspace sidebar"><div className="sidebar__brand"><span className="brand-name">Mingle</span></div><button className="sitem is-active">Example session</button></aside>
      <main className="main">
        <header className="header header--settings"><div className="crumbs"><span className="crumbs__current">Settings</span></div><span className="small muted">Example appearance workspace · no provider calls</span></header>
        <div className="main__body"><SettingsPage onReplayOnboarding={() => {}} /></div>
      </main>
    </div>;
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('Fixture root element is missing.');
  createRoot(root).render(<Fixture />);
}

void mountFixture();
