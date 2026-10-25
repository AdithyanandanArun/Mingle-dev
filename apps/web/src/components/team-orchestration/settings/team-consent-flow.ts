export function initialConsentSessionIds(
  joinSelection: readonly string[] | undefined,
  previouslyShared: readonly string[],
  localSessionIds: readonly string[],
): string[] {
  const selected = joinSelection ?? (previouslyShared.length ? previouslyShared : localSessionIds.length === 1 ? localSessionIds : []);
  return [...new Set(selected)];
}
