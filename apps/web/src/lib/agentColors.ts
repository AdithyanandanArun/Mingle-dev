import type { GroupMember, GroupSnapshot } from '@mingle/contracts';

/** Distinct hues for the eight active membership slots; the light theme uses the same hues at readable contrast. */
export const AGENT_PALETTE = [
  { dark: '#b8b8b8', light: '#646464' }, // silver
  { dark: '#79c3ae', light: '#316e60' }, // teal
  { dark: '#dfbb70', light: '#806124' }, // amber
  { dark: '#d991a1', light: '#975261' }, // rose
  { dark: '#c4a4bd', light: '#79546f' }, // mauve
  { dark: '#b1c47c', light: '#61712f' }, // olive
  { dark: '#dfa077', light: '#975f31' }, // orange
  { dark: '#bcb4a8', light: '#6a6256' }, // stone
] as const;
export type AgentColor = (typeof AGENT_PALETTE)[number];

/**
 * Replay durable membership lifetimes to choose colors. Later removals cannot change an earlier join's
 * allocation. Freed slots are reused only by subsequent members, so the active roster stays distinct
 * while historical agents retain their colors across reloads, additions and removals.
 */
export function groupAgentColors(members: readonly GroupMember[]): Map<string, AgentColor> {
  const ordered = members.map((member, index) => ({ member, index })).sort((a, b) =>
    a.member.joinedAt.localeCompare(b.member.joinedAt) || a.index - b.index,
  );
  const slots = new Map<string, number>();
  const colors = new Map<string, AgentColor>();
  for (let index = 0; index < ordered.length; index++) {
    const { member } = ordered[index]!;
    const occupied = new Set<number>();
    for (let earlier = 0; earlier < index; earlier++) {
      const prior = ordered[earlier]!.member;
      if (!prior.removedAt || prior.removedAt > member.joinedAt) {
        const slot = slots.get(prior.id);
        if (slot !== undefined) occupied.add(slot);
      }
    }
    const preferred = index % AGENT_PALETTE.length;
    let slot = preferred;
    for (let offset = 0; offset < AGENT_PALETTE.length; offset++) {
      const candidate = (preferred + offset) % AGENT_PALETTE.length;
      if (!occupied.has(candidate)) { slot = candidate; break; }
    }
    slots.set(member.id, slot);
    colors.set(member.sessionId, AGENT_PALETTE[slot]!);
  }
  return colors;
}

const cache = new WeakMap<GroupSnapshot, Map<string, AgentColor>>();
export function recordedAgentColor(group: GroupSnapshot | undefined, sessionId: string): AgentColor | undefined {
  if (!group) return undefined;
  let colors = cache.get(group);
  if (!colors) { colors = groupAgentColors(group.members); cache.set(group, colors); }
  return colors.get(sessionId);
}

/** Uncreated preview participants have no durable slot yet. */
export function previewAgentColor(key: string): AgentColor {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  return AGENT_PALETTE[(hash >>> 0) % AGENT_PALETTE.length]!;
}
