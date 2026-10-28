import { expect, it, vi } from 'vitest';
import { TEAM_CONSENT_DISCLAIMER_VERSION, type TeamStructureSnapshot } from '@mingle/contracts';
import { buildTeamReconsentInput, reshareTeamConsent, teamConsentStatusLabel } from './team-consent';

const snapshot = {
  projectId: 'project-a', settings: { version: 8 },
  myConsent: { agentIds: ['agent-b', 'agent-a'], permissionLevel: 'full-access', settingsVersion: 4, state: 'needs-reconsent' },
  members: [
    { agentId: 'agent-a', local: true, sessionId: 'session-a', ownerDisplayName: 'Alex' },
    { agentId: 'agent-b', local: true, sessionId: 'session-b', ownerDisplayName: 'Alex' },
    { agentId: 'remote-agent', local: false, sessionId: null, ownerDisplayName: 'Morgan' },
  ],
} as unknown as TeamStructureSnapshot;

it('rebuilds one-click re-consent using the same agents and permission level with current versions', () => {
  expect(buildTeamReconsentInput(snapshot)).toEqual({
    sessionIds: ['session-b', 'session-a'], permissionLevel: 'full-access', settingsVersion: 8,
    disclaimerVersion: TEAM_CONSENT_DISCLAIMER_VERSION,
  });
});

it('sends the re-consent request through the existing accept-consent action', async () => {
  const accept = vi.fn(async () => undefined);
  await expect(reshareTeamConsent('project-a', snapshot, accept)).resolves.toBe(true);
  expect(accept).toHaveBeenCalledWith('project-a', buildTeamReconsentInput(snapshot));
});

it('requires consent review instead of silently raising the saved permission level', () => {
  const upgraded = {
    ...snapshot,
    settings: { ...snapshot.settings, permissionLevel: 'full-access' },
    myConsent: { ...snapshot.myConsent, permissionLevel: 'supervised' },
  } as TeamStructureSnapshot;
  expect(buildTeamReconsentInput(upgraded)).toBeNull();
});

it('shows the teammate name in the lead-side re-consent state', () => {
  expect(teamConsentStatusLabel('needs-reconsent', 'Morgan Lee')).toBe('Waiting for Morgan Lee to re-share');
});
