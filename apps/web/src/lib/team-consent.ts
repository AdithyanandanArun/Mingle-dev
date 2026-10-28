import { TEAM_CONSENT_DISCLAIMER_VERSION } from '@mingle/contracts';
import type { AcceptTeamConsent, TeamStructureMember, TeamStructureSnapshot } from '@mingle/contracts';

export const TEAM_RECONSENT_EXPLANATION = "Mingle now pushes your agent's finished work to its own branch on GitHub so the team lead can review it";

export function teamConsentStatusLabel(consent: TeamStructureMember['consent'], ownerDisplayName: string, local = false): string {
  if (consent === 'needs-reconsent') return local ? 'Your agents need renewed consent' : `Waiting for ${ownerDisplayName} to re-share`;
  if (consent === 'paused') return 'Consent paused';
  if (consent === 'revoked') return 'Consent revoked';
  return 'Consent granted';
}

export function buildTeamReconsentInput(snapshot: TeamStructureSnapshot): AcceptTeamConsent | null {
  const consent = snapshot.myConsent;
  if (!consent || consent.state !== 'needs-reconsent') return null;
  if (snapshot.settings?.permissionLevel === 'full-access' && consent.permissionLevel !== 'full-access') return null;
  const sessionByAgent = new Map(snapshot.members
    .filter((member) => member.local && member.sessionId)
    .map((member) => [member.agentId, member.sessionId!]));
  const sessionIds = consent.agentIds.map((agentId) => sessionByAgent.get(agentId));
  if (!sessionIds.length || sessionIds.some((sessionId) => !sessionId)) return null;
  return {
    sessionIds: sessionIds as string[], permissionLevel: consent.permissionLevel,
    settingsVersion: snapshot.settings?.version ?? consent.settingsVersion,
    disclaimerVersion: TEAM_CONSENT_DISCLAIMER_VERSION,
  };
}

export async function reshareTeamConsent(
  projectId: string,
  snapshot: TeamStructureSnapshot,
  accept: (projectId: string, input: AcceptTeamConsent) => Promise<unknown>,
): Promise<boolean> {
  const input = buildTeamReconsentInput(snapshot);
  if (!input) return false;
  await accept(projectId, input);
  return true;
}
