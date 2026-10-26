import type { GroupSnapshot, Session } from '@mingle/contracts';

const SHAREABLE_PROVIDERS = new Set<Session['provider']>(['claude', 'codex', 'opencode']);

export interface TeamSessionShareEligibility {
  allowed: boolean;
  message: string;
}

/** Validate every local provider the host would need to publish for this conversation. */
export function teamSessionShareEligibility(
  session: Session | null,
  projectId: string,
  sessions: readonly Session[],
  groups: readonly GroupSnapshot[] | undefined,
): TeamSessionShareEligibility {
  if (!session || session.projectId !== projectId) {
    return { allowed: false, message: 'Open a local session in this project before sharing it.' };
  }

  const group = groups?.find((candidate) => candidate.group.projectId === projectId
    && (candidate.group.anchorSessionId === session.id || candidate.members.some((member) => !member.removedAt && member.sessionId === session.id)));
  const requiredIds = new Set<string>([session.id]);
  if (group) {
    requiredIds.add(group.group.anchorSessionId);
    for (const member of group.members) {
      if (!member.removedAt && !member.sessionId.startsWith('proxy_')) requiredIds.add(member.sessionId);
    }
    const lead = group.members.find((member) => !member.removedAt && member.id === group.group.orchestratorMemberId)
      ?? group.members.find((member) => !member.removedAt && member.role === 'orchestrator')
      ?? group.members.find((member) => !member.removedAt && member.sessionId === group.group.anchorSessionId);
    if (lead && !lead.sessionId.startsWith('proxy_')) requiredIds.add(lead.sessionId);
  }

  const localSessions = new Map(sessions.filter((item) => item.projectId === projectId).map((item) => [item.id, item]));
  // The session was captured when Teammates opened. Preserve it even if bootstrap refreshed
  // before this validation, while still requiring all other group members to resolve locally.
  localSessions.set(session.id, session);
  const required = [...requiredIds].filter((id) => !id.startsWith('proxy_'));
  const unresolved = required.filter((id) => !localSessions.has(id));
  if (unresolved.length) {
    return { allowed: false, message: 'Mingle could not verify every local agent in this conversation. Refresh the project before sharing.' };
  }

  const unsupported = required.map((id) => localSessions.get(id)!).filter((item) => !SHAREABLE_PROVIDERS.has(item.provider));
  if (unsupported.length) {
    const names = unsupported.map((item) => `${item.name} (${item.provider})`).join(', ');
    return {
      allowed: false,
      message: `Team sharing supports Codex, Claude Code, and OpenCode. This conversation includes an unsupported local agent: ${names}. Use a conversation whose local agents use a supported provider.`,
    };
  }
  return { allowed: true, message: '' };
}
