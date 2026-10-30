import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import type { AppSettings } from '@mingle/contracts';
import { cx } from '../../lib/format';
import { Button, InlineError } from '../ui';
import { SelectMenu } from '../SelectMenu';
import { SettingRow } from '../SettingRow';
import { BrowserSourcePicker, ChromeSetupHelp } from './BrowserSources';
import { useBrowserDiscovery } from './useBrowserDiscovery';
import { BrowserSandboxCard } from './BrowserSandboxCard';

interface Props {
  settings: AppSettings;
  disabled: boolean;
  update(patch: Partial<AppSettings>, key: string): Promise<boolean>;
}

/** Browser defaults. Per-session connection and consent happen in the session's Browser pane, never here. */
export function BrowserSettings({ settings, disabled, update }: Props) {
  const { discovery, loading, error, installing, refresh, install } = useBrowserDiscovery();
  const agentEnabled = settings.browserAgentEnabled ?? true;
  const [executable, setExecutable] = useState(settings.browserExecutable ?? '');
  const [endpoint, setEndpoint] = useState(settings.browserCdpEndpoint ?? '');
  useEffect(() => setExecutable(settings.browserExecutable ?? ''), [settings.browserExecutable]);
  useEffect(() => setEndpoint(settings.browserCdpEndpoint ?? ''), [settings.browserCdpEndpoint]);

  const saveExecutable = async () => {
    const value = executable.trim();
    if (value === (settings.browserExecutable ?? '')) return;
    if (await update({ browserExecutable: value }, 'browser-exe')) void refresh();
  };
  const saveEndpoint = () => {
    const value = endpoint.trim();
    if (value !== (settings.browserCdpEndpoint ?? '')) void update({ browserCdpEndpoint: value }, 'browser-endpoint');
  };

  return <div className="settings-page__section">
    <div className="settings-page__section-head"><h2>Agent access</h2><p>Let sessions open and operate a shared browser that you can watch and take over. Mingle never imports cookies or passwords.</p></div>
    <SettingRow title="Let agents use the browser" description="Allow agents to inspect and operate shared tabs. Turning this off blocks their access immediately. You can still browse yourself." htmlFor="st-browser-agent">
      <button id="st-browser-agent" type="button" role="switch" aria-checked={agentEnabled} className={cx('switch', agentEnabled && 'is-on')} disabled={disabled} onClick={() => void update({ browserAgentEnabled: !agentEnabled }, 'browser-agent')}><i /></button>
    </SettingRow>
    <SettingRow title="Default browser" description="Preferred connection option. Existing browsers require an explicit connection." htmlFor="st-browser-mode">
      <SelectMenu id="st-browser-mode" label="Default browser" value={settings.browserDefaultMode ?? 'managed'} disabled={disabled} options={[{ value: 'managed', label: 'Mingle browser', description: 'A separate Chromium without your logins.' }, { value: 'existing', label: 'Your running browser', description: 'Attach to a browser you are already signed in to.' }]} onChange={(value) => void update({ browserDefaultMode: value as 'managed' | 'existing' }, 'browser-mode')} />
    </SettingRow>

    <div className="settings-page__section-head settings-page__section-head--next"><h2>Mingle browser</h2><p>A Chromium that Mingle manages for sessions.</p></div>
    {error ? <InlineError onRetry={() => void refresh()}>{error}</InlineError> : null}
    {discovery ? <BrowserSandboxCard discovery={discovery} refresh={refresh} onUseBrowser={async path=>{setExecutable(path);await update({browserExecutable:path},'browser-exe');await refresh();}} /> : null}
    <div className="settings-row browser-setting-status">
      <div className="settings-row__copy">
        <strong>{!discovery ? (loading ? 'Checking…' : 'Status unknown') : discovery.managedAvailable ? 'Chromium is ready' : 'Chromium is not installed'}</strong>
        {discovery?.managedExecutable ? <p><code>{discovery.managedExecutable}</code></p> : null}
        {discovery?.notices.map((notice) => <p key={notice}>{notice}</p>)}
        {installing ? <p role="status">Downloading. This can take a couple of minutes.</p> : null}
      </div>
      <div className="settings-row__control">
        {discovery && !discovery.managedAvailable ? <Button size="sm" onClick={() => void install()} busy={installing} disabled={disabled}><Download size={13} aria-hidden="true" /> Install Chromium</Button> : null}
      </div>
    </div>
    <SettingRow title="Executable" description="Use a Chromium or Chrome build you already have. Leave empty to use the downloaded one." htmlFor="st-browser-exe">
      <input id="st-browser-exe" className="input input--mono" value={executable} disabled={disabled} spellCheck={false} placeholder="Automatic" onChange={(e) => setExecutable(e.target.value)} onBlur={() => void saveExecutable()} onKeyDown={(e) => { if (e.key === 'Enter') void saveExecutable(); }} />
    </SettingRow>

    <div className="settings-page__section-head settings-page__section-head--next"><h2>Your running browser</h2><p>Reuse the logins and open tabs of a Chromium browser you already use. Mingle attaches to it when you connect a session; nothing is copied.</p></div>
    <div className="browser-settings-existing">
      <BrowserSourcePicker
        idPrefix="st" discovery={discovery} loading={loading} sourceId={settings.browserExistingSourceId ?? ''} endpoint={endpoint} disabled={disabled}
        onSource={(id) => { setEndpoint(''); void update({ browserExistingSourceId: id, browserCdpEndpoint: '' }, 'browser-source'); }} onEndpoint={setEndpoint} onEndpointBlur={saveEndpoint} onRefresh={() => void refresh()}
      />
      <ChromeSetupHelp />
    </div>
  </div>;
}
