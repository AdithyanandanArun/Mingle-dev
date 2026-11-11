import { useEffect, useRef, useState } from 'react';
import type { WindowDecorationState } from '../lib/windowDecoration';
import { SettingRow } from './SettingRow';
import { SelectMenu } from './SelectMenu';
import { Button, InlineError } from './ui';

/** Window-manager preferences belong to this desktop, independently of synced app settings. */
export function WindowDecorationSetting() {
  const bridge = window.mingleWindowDecoration;
  const [state, setState] = useState<WindowDecorationState | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    if (bridge) {
      setError('');
      void bridge.getState().then(value => {
        if (!active) return;
        if (!value) throw new Error('Unavailable');
        setState(value);
      }).catch(() => { if (active) setError('Could not load the title bar choice.'); });
    }
    return () => { active = false; mounted.current = false; };
  }, [bridge, attempt]);

  if (!bridge || (state && !state.supported)) return null;
  if (!state) return error ? <div><InlineError>{error}</InlineError><Button size="sm" onClick={() => setAttempt(value => value + 1)}>Retry title bar settings</Button></div> : null;

  const save = async (value: string) => {
    if (saving || (value !== 'system' && value !== 'hidden')) return;
    setSaving(true); setError('');
    try {
      const next = await bridge.setTitleBar(value);
      if (!next) throw new Error('Unavailable');
      if (mounted.current) setState(next);
    } catch {
      if (mounted.current) setError('Could not save the title bar choice. Try again.');
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return <>
    <SettingRow title="System title bar" htmlFor="st-title-bar" description="Keep your desktop’s title bar, or hide it when your window manager handles moving, resizing and closing windows.">
      <SelectMenu id="st-title-bar" label="System title bar" value={state.titleBar} disabled={saving}
        options={[{ value: 'system', label: 'Show (default)' }, { value: 'hidden', label: 'Hide' }]}
        onChange={value => void save(value)} />
    </SettingRow>
    <p className="settings-page__hint" role="status">{saving ? 'Saving title bar choice…' : state.restartRequired ? 'Saved. Quit and reopen Mingle to apply this change.' : 'Applies to this Linux device only.'}</p>
    {error ? <InlineError>{error}</InlineError> : null}
  </>;
}
