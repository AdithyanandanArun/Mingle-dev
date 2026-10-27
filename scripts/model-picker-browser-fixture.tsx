import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProviderInfo } from '@mingle/contracts';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/base.css';
import '../apps/web/src/styles/ui.css';
import { ModelPicker, type ModelSelection } from '../apps/web/src/components/ModelPicker';

// All entries in this fixture are explicitly synthetic and are never shipped by the application.
const fixturePolicies: NonNullable<ProviderInfo['policies']> = ['supervised'];
const fixtureProviders: ProviderInfo[] = [
  {
    id: 'codex', name: 'Codex', available: true, version: 'fixture metadata', executable: null, reason: null,
    policies: fixturePolicies, promptCapabilities: { image: true, embeddedContext: true },
    models: Array.from({ length: 12 }, (_, index) => ({
      id: `fixture-codex-search-${String(index + 1).padStart(2, '0')}`,
      name: `Fixture Codex Search Model ${String(index + 1).padStart(2, '0')}`,
      reasoningEfforts: [{ id: 'balanced', label: 'Balanced' }, { id: 'deep', label: 'Deep' }],
      defaultReasoningEffort: 'balanced', policies: fixturePolicies, inputModalities: ['text'],
    })),
  },
  {
    id: 'claude', name: 'Claude', available: true, version: 'fixture metadata', executable: null, reason: null,
    policies: fixturePolicies, promptCapabilities: { image: true, embeddedContext: true },
    models: [{ id: 'fixture-claude-model', name: 'Fixture Claude Model', reasoningEfforts: [{ id: 'deep', label: 'Deep' }], defaultReasoningEffort: 'deep', policies: fixturePolicies }],
  },
  {
    id: 'antigravity', name: 'Antigravity', available: true, version: 'fixture metadata', executable: null, reason: null,
    policies: fixturePolicies, promptCapabilities: { image: true, embeddedContext: false },
    models: [
      { id: 'fixture-antigravity-model-a', name: 'Fixture Antigravity Model A', reasoningEfforts: [{ id: 'default', label: 'Provider default' }], defaultReasoningEffort: 'default' },
      { id: 'fixture-antigravity-model-b', name: 'Fixture Antigravity Model B', reasoningEfforts: [{ id: 'default', label: 'Provider default' }], defaultReasoningEffort: 'default' },
    ],
  },
  {
    id: 'opencode', name: 'OpenCode', available: false, version: null, executable: null,
    reason: 'Example fixture: runtime metadata lookup failed.', policies: [], promptCapabilities: { image: false, embeddedContext: false },
    models: [{ id: 'fixture-opencode-reported-model', name: 'Fixture OpenCode Reported Model' }],
  },
];

function Fixture() {
  const [selection, setSelection] = useState<ModelSelection>({ provider: 'codex', model: 'fixture-codex-search-04' });
  const [lockedSelection, setLockedSelection] = useState<ModelSelection>({ provider: 'claude', model: 'fixture-claude-model' });
  const [savedUnknown, setSavedUnknown] = useState<ModelSelection>({ provider: 'antigravity', model: 'saved-model-not-in-fixture-catalog' });

  return <main className="model-fixture">
    <header>
      <p className="model-fixture__eyebrow">Example-only browser fixture</p>
      <h1>Model picker acceptance</h1>
      <p>All catalog entries below are synthetic test data. No provider runtime, inference or cloud service is used.</p>
    </header>
    <section className="model-fixture__card" aria-labelledby="unlocked-heading">
      <h2 id="unlocked-heading">Provider switching and catalog search</h2>
      <ModelPicker label="Model" value={selection} providers={fixtureProviders} onChange={setSelection} />
      <p id="model-fixture-selection" role="status">{selection.provider} · {selection.model}</p>
    </section>
    <section className="model-fixture__card" aria-labelledby="locked-heading">
      <h2 id="locked-heading">Provider-locked configuration</h2>
      <ModelPicker label="Locked model" value={lockedSelection} providers={fixtureProviders} lockProvider onChange={setLockedSelection} />
      <p id="model-fixture-locked-selection" role="status">{lockedSelection.provider} · {lockedSelection.model}</p>
    </section>
    <section className="model-fixture__card" aria-labelledby="saved-heading">
      <h2 id="saved-heading">Saved model missing from current catalog</h2>
      <ModelPicker label="Saved model" value={savedUnknown} providers={fixtureProviders} onChange={setSavedUnknown} />
      <p id="model-fixture-saved-selection" role="status">{savedUnknown.provider} · {savedUnknown.model}</p>
    </section>
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Fixture root element is missing.');
createRoot(root).render(<Fixture />);

const style = document.createElement('style');
style.textContent = `
  .model-fixture { width: min(720px, calc(100% - 40px)); margin: 52px auto; display: grid; gap: 20px; }
  .model-fixture header { display: grid; gap: 7px; }
  .model-fixture h1 { font-size: 25px; letter-spacing: -.025em; }
  .model-fixture h2 { font-size: 13px; font-weight: 600; margin-bottom: 9px; }
  .model-fixture p { max-width: 580px; color: var(--fg-2); font-size: 12px; line-height: 1.5; }
  .model-fixture .model-fixture__eyebrow { color: var(--blue-strong); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
  .model-fixture__card { display: grid; justify-items: start; gap: 8px; min-width: 0; padding: 16px; border: 1px solid var(--line); border-radius: var(--radius-lg, 16px); background: var(--bg-panel); }
  .model-fixture__card > .model-picker__trigger { width: min(300px, 100%); }
  #model-fixture-selection, #model-fixture-locked-selection, #model-fixture-saved-selection { font-family: var(--font-mono); font-size: 10px; }
  @media (max-width: 420px) { .model-fixture { width: calc(100% - 24px); margin: 24px auto; gap: 12px; } .model-fixture__card { padding: 12px; } }
`;
document.head.append(style);
