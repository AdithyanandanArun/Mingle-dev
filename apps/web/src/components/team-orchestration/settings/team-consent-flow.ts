export function initialConsentSessionIds(
  joinSelection: readonly string[] | undefined,
  previouslyShared: readonly string[],
  localSessionIds: readonly string[],
): string[] {
  const selected = joinSelection ?? (previouslyShared.length ? previouslyShared : localSessionIds.length === 1 ? localSessionIds : []);
  return [...new Set(selected)];
}

export function sharedAgentCountLabel(count: number, state: 'paused' | 'shared', level: string): string {
  const normalized = Math.max(0, Math.floor(count));
  const noun = `${normalized} agent${normalized === 1 ? '' : 's'}`;
  return `Your ${noun} ${normalized === 1 ? 'is' : 'are'} ${state === 'paused' ? 'paused' : 'shared'} · ${level}`;
}
