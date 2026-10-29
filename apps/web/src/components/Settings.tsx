import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import type { AppSettings, Project, ProviderInfo, ProviderModel } from '@mingle/contracts';
import { useMingle, type SettingsSection } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { Button, InlineError } from './ui';
import { copyText } from '../lib/clipboard';
import { SelectMenu } from './SelectMenu';
import { SettingRow } from './SettingRow';
import { BrowserSettings } from './browser/BrowserSettings';
import { AccountSettings } from './AccountSettings';
import { AgentsSettings } from './AgentsSettings';
import { defaultProviderModel, usesNativeModelDefault, providerModelChoices, providerModelSetting, PROVIDER_NAMES } from '../lib/providers';
import { AntigravityRuntimeSetup } from './AntigravityRuntimeSetup';
import { ProviderExecutableSetting, executableSetting } from './ProviderExecutableSetting';
import { RemoveProjectButton } from './RemoveProjectDialog';
import { TeamWorkspace } from './distributed/TeamWorkspace';

const CATEGORIES: { id: SettingsSection; name: string }[] = [
  { id: 'general', name: 'General' }, { id: 'account', name: 'Account' }, { id: 'team', name: 'Team workspace' }, { id: 'project', name: 'Project' }, { id: 'agents', name: 'Agents' }, { id: 'providers', name: 'Providers' }, { id: 'browser', name: 'Browser' }, { id: 'appearance', name: 'Appearance' },
];
const effortName = (id: string, label: string) => ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', 'extra-high': 'Extra High', max: 'Max', ultra: 'Ultra' } as Record<string, string>)[id.toLowerCase()] ?? label;
const serviceTiersFor = (model: ProviderModel | undefined) => [
  { id: 'standard', name: 'Standard', description: 'Standard service tier.' },
  ...(model?.serviceTiers ?? []).filter((tier) => tier.id !== 'standard'),
];
function ProviderStatus({ provider, settings, disabled, onSavePath }: { provider: ProviderInfo; settings: AppSettings; disabled: boolean; onSavePath: (value: string) => Promise<boolean> }) {
  return <section className="settings-provider" aria-label={`${provider.name} status`}>
    <div className="settings-provider__head"><h3>{provider.name}</h3><span className={provider.available ? 'settings-provider__state is-ready' : 'settings-provider__state'}><i aria-hidden="true" />{provider.available ? 'Configured' : 'Setup needed'}</span></div>
    <p className="settings-provider__version">{provider.version ? `Version ${provider.version}` : 'Executable not detected'}</p>
    <ProviderExecutableSetting provider={provider} settings={settings} disabled={disabled} onSave={onSavePath} />
    {!provider.available ? <p className="settings-provider__reason">{provider.reason}</p> : null}
    <details className="settings-provider__details"><summary>Connection details</summary><p>{provider.reason ?? 'Authentication and model access are checked when a session runs.'}</p>{provider.executable ? <code>{provider.executable}</code> : null}</details>
  </section>;
}

export function SettingsPage({ onReplayOnboarding }: { onReplayOnboarding: () => void }) {
  const boot = useMingle((s) => s.boot);
  const settings = boot?.settings;
  const category = useMingle((s) => s.settingsSection);
  const teamTab = useMingle((s) => s.settingsTeamTab);
  const projectId = useMingle((s) => s.settingsProjectId ?? s.activeProjectId);
  const project = boot?.projects.find((item) => item.id === projectId);
  const setCategory = useMingle.getState().setSettingsSection;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const refreshAntigravityAfterInstall = useCallback(async () => {
    await useMingle.getState().refreshNow();
  }, []);

  if (!settings || !boot) return null;
  const update = async (patch: Partial<AppSettings>, key: string) => {
    setBusy(key); setError(null);
    try {
      await api.updateSettings(patch);
      await useMingle.getState().refreshNow();
      setSaved(true);
      return true;
    } catch (cause) { setError(errorMessage(cause)); return false; }
    finally { setBusy(null); }
  };
  const refreshProviders = async () => {
    setBusy('providers'); setError(null);
    try { await api.refreshProviders(); await useMingle.getState().refreshNow(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(null); }
  };
  const disabled = busy !== null;
  const modelKey = providerModelSetting(settings.defaultProvider);
  const defaultModel = defaultProviderModel(settings.defaultProvider, settings);
  const providerInfo = boot.providers.find((p) => p.id === settings.defaultProvider);
  const models = providerModelChoices(providerInfo, defaultModel);
  const selectedModel = models.find((m) => m.id === defaultModel || m.aliases?.includes(defaultModel));
  const selectedModelId = selectedModel?.id ?? defaultModel;
  const efforts = selectedModel?.reasoningEfforts ?? [];
  const tiers = serviceTiersFor(selectedModel);
  const policies = selectedModel?.policies ?? boot.providers.find((p) => p.id === settings.defaultProvider)?.policies ?? [];
  const updateDefaultModel = (value: string) => {
    const nextModel = models.find((model) => model.id === value);
    if (!nextModel) return;
    const patch: Partial<AppSettings> = { [modelKey]: value };
    const nextEfforts = nextModel.reasoningEfforts ?? [];
    if (nextEfforts.length && !nextEfforts.some((item) => item.id === settings.defaultEffort)) patch.defaultEffort = nextModel.defaultReasoningEffort ?? nextEfforts[0]!.id;
    const nextTiers = serviceTiersFor(nextModel);
    if (nextTiers.length && !nextTiers.some((item) => item.id === (settings.defaultServiceTier ?? 'standard'))) patch.defaultServiceTier = nextModel.defaultServiceTier ?? nextTiers[0]!.id;
    void update(patch, 'model');
  };
  const updateDefaultProvider = (provider: AppSettings['defaultProvider']) => {
    const info = boot.providers.find((item) => item.id === provider);
    const preferredModel = defaultProviderModel(provider, settings);
    const model = info?.models.find((item) => item.id === preferredModel || item.aliases?.includes(preferredModel))
      ?? info?.models[0];
    const patch: Partial<AppSettings> = { defaultProvider: provider };
    if (model) patch[providerModelSetting(provider)] = model.id;
    else if (usesNativeModelDefault(provider) && preferredModel === 'default') patch[providerModelSetting(provider)] = 'default';

    const efforts = model?.reasoningEfforts ?? [];
    if (efforts.length && !efforts.some((item) => item.id === settings.defaultEffort)) {
      patch.defaultEffort = model?.defaultReasoningEffort && efforts.some((item) => item.id === model.defaultReasoningEffort)
        ? model.defaultReasoningEffort : efforts[0]!.id;
    }
    const policies = model?.policies ?? info?.policies ?? [];
    if (policies.length && !policies.includes(settings.defaultPolicy)) {
      patch.defaultPolicy = policies.includes('supervised') ? 'supervised' : policies[0]!;
    }
    const tiers = serviceTiersFor(model);
    if (tiers.length && !tiers.some((item) => item.id === (settings.defaultServiceTier ?? 'standard'))) {
      patch.defaultServiceTier = model?.defaultServiceTier && tiers.some((item) => item.id === model.defaultServiceTier)
        ? model.defaultServiceTier : tiers[0]!.id;
    }
    void update(patch, 'provider');
  };
  const status = category === 'account' ? 'Mingle account' : busy === 'providers' ? 'Checking providers…' : busy ? 'Saving…' : error ? 'Could not complete change' : category === 'providers' ? 'Provider settings' : saved ? 'All changes saved' : category === 'project' ? 'Project details' : 'Changes save automatically';

  return <div className="settings-page" aria-labelledby="settings-title">
    <div className="settings-page__inner">
      <header className="settings-page__head"><div><h1 id="settings-title" tabIndex={-1}>Settings</h1><p>Account, projects, models and appearance.</p></div><span className="settings-page__save" role="status">{status}</span></header>
      <nav className="settings-page__tabs" aria-label="Settings sections">
        {CATEGORIES.filter((item) => item.id !== 'project' || project).map((item) => <button type="button" key={item.id} aria-current={category === item.id ? 'page' : undefined} onClick={() => setCategory(item.id)}>{item.name}</button>)}
      </nav>
      {error ? <InlineError>{error}</InlineError> : null}
      {category === 'account' ? <AccountSettings settings={settings} /> : null}
      {category === 'team' ? <TeamWorkspace initialTab={teamTab} /> : null}
      {category === 'general' ? <div className="settings-page__section">
        <div className="settings-page__section-head"><h2>New sessions</h2><p>Defaults for your next session. Existing conversations keep their own settings.</p></div>
        <SettingRow title="Provider" description="The agent used when you start a session." htmlFor="st-provider">
          <SelectMenu id="st-provider" label="Default provider" value={settings.defaultProvider} disabled={disabled} options={boot.providers.map((provider) => ({ value: provider.id, label: PROVIDER_NAMES[provider.id], description: provider.available ? 'Available' : provider.reason ?? 'Needs setup' }))} onChange={(value) => updateDefaultProvider(value as AppSettings['defaultProvider'])} />
        </SettingRow>
        <SettingRow title="Model" description={`Default for ${PROVIDER_NAMES[settings.defaultProvider]} sessions.`} htmlFor="st-model">
          <SelectMenu id="st-model" label="Default model" value={selectedModelId} disabled={disabled || models.length === 0} options={models.map((m) => ({ value: m.id, label: m.name }))} onChange={updateDefaultModel} />
        </SettingRow>
        <SettingRow title="Reasoning effort" description="How much reasoning to use for a response." htmlFor="st-effort">
          <SelectMenu id="st-effort" label="Default effort" value={settings.defaultEffort} displayValue={efforts.length ? efforts.some((item) => item.id === settings.defaultEffort) ? undefined : 'Not available' : usesNativeModelDefault(settings.defaultProvider) ? 'Native/default' : effortName(settings.defaultEffort, settings.defaultEffort)} disabled={disabled || efforts.length === 0} options={efforts.map((item) => ({ value: item.id, label: `${effortName(item.id, item.label)}${item.id === selectedModel?.defaultReasoningEffort ? ' · Default' : ''}`, description: item.description }))} onChange={(value) => void update({ defaultEffort: value }, 'effort')} />
        </SettingRow>
        <SettingRow title="Service tier" description="Request speed for the default model." htmlFor="st-tier">
          <SelectMenu id="st-tier" label="Default service tier" value={settings.defaultServiceTier ?? 'standard'} displayValue={tiers.length ? tiers.some((item) => item.id === (settings.defaultServiceTier ?? 'standard')) ? undefined : 'Not available' : 'Native/default'} disabled={disabled || tiers.length === 0} options={tiers.map((item) => ({ value: item.id, label: `${item.id === 'priority' ? 'Fast' : item.name}${item.id === selectedModel?.defaultServiceTier ? ' · Default' : ''}`, description: item.description }))} onChange={(value) => void update({ defaultServiceTier: value }, 'tier')} />
        </SettingRow>
        <div className="settings-page__section-head settings-page__section-head--next"><h2>Context</h2></div>
        <AutoCompactSetting settings={settings} disabled={disabled} update={update} />
        <div className="settings-page__section-head settings-page__section-head--next"><h2>Workspace & permissions</h2></div>
        <SettingRow title="Resume after restart" description="Automatically continue local sessions that were interrupted when Mingle closed. Group deliveries and remote-device team work keep their separate recovery behavior." htmlFor="st-auto-resume">
          <SelectMenu id="st-auto-resume" label="Resume sessions after restart" value={settings.autoResumeOnRestart === false ? 'off' : 'on'} disabled={disabled} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={(value) => void update({ autoResumeOnRestart: value === 'on' }, 'auto-resume')} />
        </SettingRow>
        <SettingRow title="Workspace" description="Use a separate Git worktree, or edit the existing project folder." htmlFor="st-workspace">
          <SelectMenu id="st-workspace" label="Default workspace" value={settings.defaultIsolated ? 'worktree' : 'project'} disabled={disabled} options={[{ value: 'worktree', label: 'Isolated worktree' }, { value: 'project', label: 'Project folder' }]} onChange={(value) => void update({ defaultIsolated: value === 'worktree' }, 'workspace')} />
        </SettingRow>
        <SettingRow title="Approval policy" description="Supervised asks before changes. Balanced allows edits with fewer prompts." htmlFor="st-policy">
          <SelectMenu id="st-policy" label="Default approval policy" value={settings.defaultPolicy} displayValue={policies.length ? policies.includes(settings.defaultPolicy) ? undefined : 'Not available' : 'Native/default'} disabled={disabled || policies.length === 0} options={policies.map((value) => ({ value, label: value === 'balanced' ? 'Auto-accept edits' : value === 'full-access' ? 'Full access' : value[0]!.toUpperCase() + value.slice(1), description: value === 'supervised' ? 'Ask before taking actions that change files or run commands.' : value === 'balanced' ? 'Allow file edits while keeping command approvals.' : value === 'auto' ? 'Allow common actions automatically with safety checks.' : 'Allow all actions without approval prompts.' }))} onChange={(value) => void update({ defaultPolicy: value as AppSettings['defaultPolicy'] }, 'policy')} />
        </SettingRow>
        <div className="settings-onboarding-replay">
          <div><h3>Welcome tour</h3><p>Revisit the introduction, account options and provider availability. Your settings stay as they are.</p></div>
          <button type="button" onClick={onReplayOnboarding}><RotateCcw size={13} /> Replay welcome</button>
        </div>
      </div> : null}
      {category === 'agents' ? <AgentsSettings settings={settings} providers={boot.providers} disabled={disabled} update={update} /> : null}
      {category === 'browser' ? <BrowserSettings settings={settings} disabled={disabled} update={update} /> : null}
      {category === 'project' && project ? <ProjectSettings key={`${project.id}:${project.name}`} project={project} /> : null}
      {category === 'providers' ? <div className="settings-page__section">
        <div className="settings-page__section-head settings-page__section-head--actions"><div><h2>Connected agents</h2><p>Local installations and login status.</p></div><Button size="sm" disabled={disabled} busy={busy === 'providers'} onClick={() => void refreshProviders()}><RefreshCw size={12} /> Re-check</Button></div>
        <p className="settings-page__hint">Set a full executable path or command name below. Leave it empty for automatic detection.</p>
        {boot.providers.map((provider) => <ProviderStatus key={provider.id} provider={provider} settings={settings} disabled={disabled} onSavePath={async (value) => {
          const saved = await update({ [executableSetting(provider.id)]: value }, `path:${provider.id}`);
          if (saved) await refreshProviders();
          return saved;
        }} />)}
        {!boot.providers.length ? <p className="settings-page__hint">Provider information is loading. Re-check to request a fresh status.</p> : null}
        <AntigravityRuntimeSetup providerInfo={boot.providers.find((provider) => provider.id === 'antigravity')} onProviderChanged={refreshAntigravityAfterInstall} />
        <div className="settings-page__login"><p>Sign in on this machine with <code>claude auth login</code> or <code>codex login</code>, then re-check. Antigravity sign-in opens its native Google browser flow. OpenCode uses its own provider logins (<code>opencode providers login</code>) and lists the models it exposes; Mingle never reads its credential files.</p><p>Claude uses its existing login. An <code>ANTHROPIC_API_KEY</code> in the server environment takes precedence and uses API billing. Provider credentials stay with each provider.</p></div>
      </div> : null}
      {category === 'appearance' ? <div className="settings-page__section">
        <div className="settings-page__section-head"><h2>Appearance</h2><p>Simple surfaces, readable text and quiet controls.</p></div>
        <SettingRow title="Theme" description="Choose a dark or light workspace." htmlFor="st-theme">
          <SelectMenu id="st-theme" label="Theme" value={settings.theme} disabled={disabled} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} onChange={(value) => void update({ theme: value as AppSettings['theme'] }, 'theme')} />
        </SettingRow>
      </div> : null}
      <footer className="settings-page__foot">Mingle {boot.version}<span>Local workspace</span></footer>
    </div>
  </div>;
}

const COMPACT_MIN = 1;
const COMPACT_MAX = 95;

/** Auto-compact threshold: the provider decides by default, or a custom share of the context window. */
function AutoCompactSetting({ settings, disabled, update }: { settings: AppSettings; disabled: boolean; update: (patch: Partial<AppSettings>, key: string) => Promise<boolean> }) {
  const saved = settings.autoCompactPercent ?? null;
  const [mode, setMode] = useState<'default' | 'custom'>(saved === null ? 'default' : 'custom');
  const [draft, setDraft] = useState(saved === null ? '' : String(saved));
  useEffect(() => { setMode(saved === null ? 'default' : 'custom'); setDraft(saved === null ? '' : String(saved)); }, [saved]);
  const value = Number(draft);
  const valid = draft.trim() !== '' && Number.isInteger(value) && value >= COMPACT_MIN && value <= COMPACT_MAX;
  const dirty = mode === 'custom' && valid && value !== saved;
  const save = () => { if (dirty) void update({ autoCompactPercent: value }, 'compact'); };
  return <>
    <SettingRow
      title="Auto-compact" htmlFor="st-compact"
      description="Summarise older conversation automatically as it nears the model’s context limit. The provider’s own reserve may compact earlier, and Codex needs the model to report its context size. Antigravity and OpenCode use their native compaction thresholds. Running sessions use a change on their next turn."
    >
      <SelectMenu id="st-compact" label="Auto-compact" value={mode} disabled={disabled} options={[{ value: 'default', label: 'Provider default' }, { value: 'custom', label: 'Custom percent' }]} onChange={(next) => {
        if (next === 'default') { setMode('default'); if (saved !== null) void update({ autoCompactPercent: null }, 'compact'); }
        else { setMode('custom'); setDraft((d) => d || '80'); }
      }} />
    </SettingRow>
    {mode === 'custom' ? <SettingRow title="Compact at" description={`Share of the context window used, from ${COMPACT_MIN} to ${COMPACT_MAX}.`} htmlFor="st-compact-percent">
      <div className="settings-percent">
        <input id="st-compact-percent" className="input" type="number" inputMode="numeric" min={COMPACT_MIN} max={COMPACT_MAX} step={1} value={draft} disabled={disabled} aria-invalid={draft !== '' && !valid ? true : undefined} onChange={(e) => setDraft(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
        <span aria-hidden="true">%</span>
        <Button size="sm" disabled={!dirty || disabled} onClick={save}>Save</Button>
      </div>
      {draft !== '' && !valid ? <p className="settings-percent__error" role="alert">Enter a whole number from {COMPACT_MIN} to {COMPACT_MAX}.</p> : null}
    </SettingRow> : null}
  </>;
}

function ProjectSettings({ project }: { project: Project }) {
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api.renameProject(project.id, name.trim());
      await useMingle.getState().refreshNow();
      useMingle.getState().toast('success', 'Project name saved.');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const copyPath = async () => {
    try { await copyText(project.path); useMingle.getState().toast('success', 'Project path copied.'); }
    catch (cause) { setError(errorMessage(cause)); }
  };
  return <section className="settings-page__section" aria-labelledby="project-settings-title">
    <div className="settings-page__section-head"><h2 id="project-settings-title">{project.name}</h2><p>{project.isExample ? 'Example workspace' : 'Project details and location.'}</p></div>
    {error ? <InlineError>{error}</InlineError> : null}
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <SettingRow title="Project name" description="Shown in the sidebar and session list." htmlFor="st-project-name">
        <input id="st-project-name" className="input" value={name} maxLength={100} required disabled={busy} onChange={(event) => setName(event.target.value)} />
      </SettingRow>
      <div className="settings-project__save"><Button type="submit" size="sm" busy={busy} disabled={busy || !name.trim() || name.trim() === project.name}>Save name</Button></div>
    </form>
    <div className="settings-project__location"><h3>Project folder</h3><div><code>{project.path}</code><Button size="sm" onClick={() => void copyPath()}>Copy path</Button></div></div>
    <div className="settings-project__remove"><p>Remove this project from Mingle. Files stay on disk.</p><RemoveProjectButton project={project} /></div>
  </section>;
}
