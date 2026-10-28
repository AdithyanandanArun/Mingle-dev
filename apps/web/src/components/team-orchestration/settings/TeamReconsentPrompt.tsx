import { Button } from '../../ui';
import { TEAM_RECONSENT_EXPLANATION } from '../../../lib/team-consent';

export function TeamReconsentPrompt({ busy, onReshare }: { busy: boolean; onReshare: () => void }) {
  return <>
    <small>{TEAM_RECONSENT_EXPLANATION}</small>
    <Button size="sm" variant="primary" disabled={busy} busy={busy} onClick={onReshare}>Re-share</Button>
  </>;
}
