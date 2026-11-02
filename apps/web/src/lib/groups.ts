import type {
  AgentConfiguration, AppSettings, GroupDelivery, GroupMember, GroupMode, GroupSnapshot, Policy, Provider, ProviderInfo, ProviderModel, Session, SessionStatus,
} from '@mingle/contracts';
import { defaultProviderModel, PROVIDER_NAMES, reasoningEffortChoices, usesNativeModelDefault } from './providers';

export const MODE_LABEL: Record<GroupMode, string> = { cowork: 'Cowork', orchestrated: 'Orchestrated', 'current-leads': 'Current agent leads' };
export const MODE_TAGLINE: Record<GroupMode, string> = {
  cowork: 'You lead. Agents work together.',
  orchestrated: 'An agent coordinates the work.',
  'current-leads': 'Keep your agent in charge.',
};
export const MODE_EXPLANATION: Record<GroupMode, string> = {
  cowork: 'Your message reaches both agents. One proposes a work split, then both do their share and communicate directly.',
  orchestrated: 'Your message goes to a separate orchestrator. It splits the work between agents and brings their results together.',
  'current-leads': 'Your current agent keeps its context and leads the new agent. It delegates work and reviews the results, without adding a separate orchestrator.',
};
export const MODE_FLOW: Record<GroupMode, string[]> = {
  cowork: ['Both receive', 'One splits', 'Both work'],
  orchestrated: ['Orchestrator receives', 'Delegates', 'Summarizes'],
  'current-leads': ['Current agent receives', 'Delegates', 'Reviews'],
};
export const ROLE_LABEL: Record<GroupMember['role'], string> = { peer: 'Peer', orchestrator: 'Orchestrator', worker: 'Worker' };
export const POLICY_LABEL: Record<Policy, string> = { supervised: 'Supervised', balanced: 'Auto-accept edits', auto: 'Auto', 'full-access': 'Full access' };
export const POLICY_DESCRIPTION: Record<Policy, string> = {
  supervised: 'Ask before taking actions that change files or run commands.',
  balanced: 'Allow file edits while keeping command approvals.',
  auto: 'Allow common actions automatically with safety checks.',
  'full-access': 'Allow all actions without approval prompts.',
};
export const DELIVERY_LABEL: Record<GroupDelivery['status'], string> = {
  queued: 'Queued', running: 'Running', completed: 'Delivered', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled',
};

export const effortLabel = (id: string): string => {
  const known: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', 'extra-high': 'Extra High', max: 'Max', ultra: 'Ultra' };
  return known[id.toLowerCase()] ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
};
export const tierLabel = (id: string, name?: string): string => (id === 'standard' ? 'Standard' : id === 'priority' ? 'Fast' : name ?? id);
export const policyLabel = (policy: string): string => POLICY_LABEL[policy as Policy] ?? policy;
export const providerName = (provider: Provider): string => PROVIDER_NAMES[provider];

/** Effective turn ceiling: legacy maxTurns when unset, no ceiling when null, explicit value otherwise. */
export const effectiveTurnCeiling = (maxTurns: number, emergencyTurnLimit?: number | null): number | null =>
  emergencyTurnLimit === undefined ? maxTurns : emergencyTurnLimit;

/* ——— Membership ——— */
export const activeMembers = (snapshot: GroupSnapshot): GroupMember[] => snapshot.members.filter((member) => !member.removedAt);
export const retiredHandles = (snapshot: GroupSnapshot): string[] => snapshot.members.filter((member) => member.removedAt).map((member) => member.handle);
export const allHandles = (snapshot: GroupSnapshot): Set<string> => new Set(snapshot.members.map((member) => member.handle.toLowerCase()));

export function findGroupForSession(groups: readonly GroupSnapshot[] | undefined, sessionId: string | null | undefined): GroupSnapshot | undefined {
  if (!groups || !sessionId) return undefined;
  return groups.find((snapshot) => snapshot.group.anchorSessionId === sessionId || snapshot.members.some((member) => !member.removedAt && member.sessionId === sessionId));
}

/** Member sessions other than each group's anchor: they are reached through the anchor and stay out of the session list. */
export function groupChildSessionIds(groups: readonly GroupSnapshot[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const snapshot of groups ?? []) {
    for (const member of snapshot.members) if (!member.removedAt && member.sessionId !== snapshot.group.anchorSessionId) out.add(member.sessionId);
  }
  return out;
}

const STATUS_RANK: Record<SessionStatus, number> = { idle: 0, interrupted: 1, running: 2, error: 3, waiting: 4 };
export function groupSessionStatus(snapshot: GroupSnapshot, sessions: readonly Session[]): SessionStatus {
  let status: SessionStatus = 'idle';
  for (const member of activeMembers(snapshot)) {
    const session = sessions.find((item) => item.id === member.sessionId);
    if (session && STATUS_RANK[session.status] > STATUS_RANK[status]) status = session.status;
  }
  return status;
}

export const isBusy = (session: Session | undefined): boolean => session?.status === 'running' || session?.status === 'waiting';
export const isActiveDelivery = (delivery: GroupDelivery): boolean => delivery.status === 'queued' || delivery.status === 'running';

export function memberHasActiveWork(snapshot: GroupSnapshot, member: GroupMember, session: Session | undefined): boolean {
  return isBusy(session) || snapshot.deliveries.some((delivery) => delivery.memberId === member.id && isActiveDelivery(delivery));
}

/** Where an unaddressed message goes under each mode, always as concrete member IDs. */
export function defaultRecipients(snapshot: GroupSnapshot): GroupMember[] {
  const members = activeMembers(snapshot);
  if (snapshot.group.mode === 'cowork') return members;
  const lead = members.find((member) => member.id === snapshot.group.orchestratorMemberId);
  return lead ? [lead] : [];
}

export function routingSummary(mode: GroupMode, members: { handle: string; role: GroupMember['role'] }[]): string {
  const handles = members.map((member) => `@${member.handle}`);
  const lead = members.find((member) => member.role === 'orchestrator');
  if (mode === 'cowork') return `No @mention → ${handles.join(' and ') || 'all peers'}. A mention reaches only that agent.`;
  return `No @mention → ${lead ? `@${lead.handle}` : 'the orchestrator'}${mode === 'current-leads' ? ', your existing orchestrator' : ''}. A mention reaches only that agent.`;
}

/* ——— Handles ——— */
export function suggestHandle(provider: Provider, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (handle) => handle.toLowerCase()));
  for (let n = 1; n < 100; n++) if (!used.has(`${provider}${n}`)) return `${provider}${n}`;
  return `${provider}-${Date.now().toString(36)}`;
}

export function validateHandle(raw: string, taken: Iterable<string>): string | null {
  const handle = raw.trim().toLowerCase();
  if (handle.length < 2) return 'Use at least 2 characters.';
  if (handle.length > 32) return 'Use 32 characters or fewer.';
  if (!/^[a-z][a-z0-9_-]*$/.test(handle)) return 'Use letters, numbers, underscores or hyphens, starting with a letter.';
  for (const used of taken) if (used.toLowerCase() === handle) return `@${handle} is already used in this conversation. Retired handles are not reused.`;
  return null;
}

/* ——— Provider-backed configuration ——— */
export interface Choice { id: string; label: string; description?: string }
export const modelOf = (info: ProviderInfo | undefined, id: string): ProviderModel | undefined => info?.models.find((model) => model.id === id || model.aliases?.includes(id));
export const effortChoices = (model: ProviderModel | undefined): Choice[] =>
  reasoningEffortChoices(model);
export const tierChoices = (model: ProviderModel | undefined): Choice[] =>
  (model?.serviceTiers ?? []).map((tier) => ({ id: tier.id, label: tierLabel(tier.id, tier.name), description: tier.description }));
export const policyChoices = (info: ProviderInfo | undefined, model: ProviderModel | undefined): Policy[] => model?.policies ?? info?.policies ?? [];

const defaultModelFor = defaultProviderModel;

/** Moves a configuration onto values the provider currently advertises; used only when the user changes provider or model. */
export function normalizeConfig(config: AgentConfiguration, providers: readonly ProviderInfo[], settings: AppSettings): AgentConfiguration {
  const info = providers.find((provider) => provider.id === config.provider);
  const configuredDefault = defaultModelFor(config.provider, settings);
  const reportedCurrent = modelOf(info, config.model);
  const nativeDefault = usesNativeModelDefault(config.provider);
  const preserveNativeDefault = nativeDefault && config.model === 'default' && !reportedCurrent;
  const preserveUnreportedClaudeModel = config.provider === 'claude' && !reportedCurrent;
  const model = reportedCurrent ?? (preserveNativeDefault || preserveUnreportedClaudeModel ? undefined : modelOf(info, configuredDefault))
    ?? (preserveNativeDefault || preserveUnreportedClaudeModel || nativeDefault && (config.model === 'default' || configuredDefault === 'default') ? undefined : info?.models[0]);
  const efforts = effortChoices(model);
  const tiers = tierChoices(model);
  const policies = policyChoices(info, model);
  return {
    provider: config.provider,
    model: model?.id ?? (nativeDefault && (preserveNativeDefault || configuredDefault === 'default' && !reportedCurrent) ? 'default' : config.model),
    effort: efforts.some((item) => item.id === config.effort) ? config.effort : model?.defaultReasoningEffort && efforts.some((item) => item.id === model.defaultReasoningEffort) ? model.defaultReasoningEffort : efforts[0]?.id ?? 'none',
    policy: policies.includes(config.policy) ? config.policy : policies.includes(settings.defaultPolicy) ? settings.defaultPolicy : policies[0] ?? config.policy,
    serviceTier: tiers.some((item) => item.id === config.serviceTier) ? config.serviceTier : model?.defaultServiceTier ?? 'standard',
  };
}

export function defaultConfigFor(provider: Provider, settings: AppSettings, providers: readonly ProviderInfo[]): AgentConfiguration {
  return normalizeConfig({
    provider, model: defaultModelFor(provider, settings), effort: settings.defaultEffort, policy: settings.defaultPolicy, serviceTier: settings.defaultServiceTier ?? 'standard',
  }, providers, settings);
}

/** Worker defaults from Settings; falls back to new-session defaults and then to a provider that is actually available. */
export function initialWorkerConfig(settings: AppSettings, providers: readonly ProviderInfo[]): AgentConfiguration {
  const configured = settings.groupDefaults?.worker;
  if (configured) return normalizeConfig(configured, providers, settings);
  const preferred = providers.find((provider) => provider.id === settings.defaultProvider && provider.available) ?? providers.find((provider) => provider.available);
  return defaultConfigFor(preferred?.id ?? settings.defaultProvider, settings, providers);
}

export const sessionConfig = (session: Session): AgentConfiguration => ({
  provider: session.provider, model: session.model, effort: session.effort, policy: session.policy, serviceTier: session.serviceTier ?? 'standard',
});
export const sameConfig = (a: AgentConfiguration, b: AgentConfiguration): boolean =>
  a.provider === b.provider && a.model === b.model && a.effort === b.effort && a.policy === b.policy && a.serviceTier === b.serviceTier;

export function configSummary(config: Pick<AgentConfiguration, 'model' | 'effort' | 'policy' | 'serviceTier'>, providers: readonly ProviderInfo[], provider: Provider): { model: string; detail: string } {
  const info = providers.find((item) => item.id === provider);
  const model = modelOf(info, config.model);
  const tier = config.serviceTier === 'standard' ? '' : ` · ${tierLabel(config.serviceTier, model?.serviceTiers?.find((item) => item.id === config.serviceTier)?.name)}`;
  const reportedEffort = model?.reasoningEfforts?.find((item) => item.id === config.effort)?.label;
  const effort = reportedEffort ?? (config.effort === 'none' || !model?.reasoningEfforts?.length ? 'Native/default' : 'Not available');
  const policies = policyChoices(info, model);
  const policy = policies.includes(config.policy) ? policyLabel(config.policy) : policies.length ? 'Not available' : 'Native/default';
  return { model: model?.name ?? config.model, detail: `${effort}${tier} · ${policy}` };
}

export function providerAvailability(providers: readonly ProviderInfo[], provider: Provider): { available: boolean; reason: string | null } {
  const info = providers.find((item) => item.id === provider);
  if (!info) return { available: false, reason: `${providerName(provider)} status is not known yet.` };
  return { available: info.available, reason: info.available ? null : info.reason ?? `${info.name} needs setup.` };
}

/* ——— Mentions ——— */
export interface MentionCandidate { id: string; handle: string; provider?: Provider }
export interface MentionProblem { token: string; message: string }
export interface MentionResolution { ids: string[]; problems: MentionProblem[] }
interface MentionToken { handle: string; start: number; end: number }

/** Masks literal/code regions while preserving UTF-16 offsets used by the textarea. */
export function maskNonActionable(text: string): string {
  const chars = text.split('');
  const hide = (start: number, end: number): void => {
    for (let i = start; i < end; i++) if (chars[i] !== '\n') chars[i] = ' ';
  };
  let offset = 0;
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split('\n')) {
    const end = offset + line.length;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      hide(offset, end);
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(line)) fence = null;
    } else if (marker) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      hide(offset, end);
    } else if (/^(?: {0,3}>| {4}|\t)/.test(line)) hide(offset, end);
    offset = end + 1;
  }
  const escaped = (index: number): boolean => {
    let count = 0;
    while (index > 0 && text[--index] === '\\') count++;
    return count % 2 === 1;
  };
  const word = (char: string | undefined): boolean => Boolean(char && /[\p{L}\p{N}_]/u.test(char));
  // Include unfinished literals while typing, so completion never offers an agent inside one.
  for (let i = 0; i < chars.length; i++) {
    const opener = chars[i];
    if (escaped(i)) continue;
    if (opener === '`') {
      let width = 1;
      while (chars[i + width] === '`') width++;
      let close = i + width;
      let end = text.indexOf('\n', close);
      if (end < 0) end = chars.length;
      while (close < chars.length) {
        if (chars[close] !== '`') { close++; continue; }
        let count = 1;
        while (chars[close + count] === '`') count++;
        if (count === width && !escaped(close)) { end = close + count; break; }
        close += count;
      }
      hide(i, end); i = end - 1; continue;
    }
    const closer = opener === '“' ? '”' : opener === '‘' ? '’' : opener === '"' || opener === "'" ? opener : null;
    if (!closer || word(text[i - 1])) continue;
    let end = text.indexOf('\n', i + 1);
    if (end < 0) end = chars.length;
    for (let j = i + 1; j < chars.length; j++) {
      if (chars[j] !== closer || escaped(j)) continue;
      if ((closer === "'" || closer === '’') && word(text[j - 1]) && word(text[j + 1])) continue;
      end = j + 1; break;
    }
    hide(i, end); i = end - 1;
  }
  const literals = chars.join('');
  for (const pattern of [
    /\b(?:https?|ftp|ssh|git|file):\/\/[^\s<>]+/gi,
    /\bwww\.[^\s<>]+/gi,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
  ]) for (const match of literals.matchAll(pattern)) hide(match.index, match.index + match[0].length);
  return chars.join('');
}

export function mentionTokens(text: string): MentionToken[] {
  const masked = maskNonActionable(text);
  const out: MentionToken[] = [];
  for (const match of masked.matchAll(/(^|[\s([{"'“‘,;:!?])@([A-Za-z][A-Za-z0-9_-]*)(?![A-Za-z0-9_@])/g)) {
    const start = match.index + match[1]!.length;
    out.push({ handle: match[2]!.toLowerCase(), start, end: start + 1 + match[2]!.length });
  }
  return out;
}

/**
 * Resolves every actionable @mention to member IDs. Unknown and retired handles are errors,
 * so a typo can never silently fall back to the default recipients.
 */
export function resolveMentions(text: string, members: readonly MentionCandidate[], retired: readonly string[]): MentionResolution {
  const ids: string[] = [];
  const problems: MentionProblem[] = [];
  const retiredSet = new Set(retired.map((handle) => handle.toLowerCase()));
  for (const token of mentionTokens(text)) {
    const exact = members.find((member) => member.handle.toLowerCase() === token.handle);
    const label = `@${token.handle}`;
    if (exact) { if (!ids.includes(exact.id)) ids.push(exact.id); continue; }
    if (retiredSet.has(token.handle)) { problems.push({ token: label, message: `${label} was removed from this group.` }); continue; }
    if (token.handle === 'claude' || token.handle === 'codex' || token.handle === 'antigravity' || token.handle === 'opencode') {
      const matches = members.filter((member) => member.provider === token.handle);
      if (matches.length === 1) { if (!ids.includes(matches[0]!.id)) ids.push(matches[0]!.id); }
      else if (matches.length === 0) problems.push({ token: label, message: `No active ${providerName(token.handle)} agent in this group for ${label}.` });
      else problems.push({ token: label, message: `${label} matches ${matches.map((member) => `@${member.handle}`).join(' and ')}. Choose one of them.` });
      continue;
    }
    problems.push({ token: label, message: `No agent ${label} in this group. Choose an active handle: ${members.map((member) => `@${member.handle}`).join(', ') || 'none'}.` });
  }
  return { ids, problems };
}
