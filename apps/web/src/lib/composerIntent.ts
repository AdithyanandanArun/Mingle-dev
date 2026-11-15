export type ComposerIntent = 'normal' | 'plan' | 'autonomous';

/** Conservative, deterministic routing. Only an explicit leading directive can change intent. */
export function inferComposerIntent(input: string): { intent: ComposerIntent; content: string } {
  const trimmed = input.trimStart();
  const plan = /^\/plan(?:\s+|$)/i.exec(trimmed);
  if (plan) return { intent: 'plan', content: trimmed.slice(plan[0].length).trimStart() };
  // Commands, skill markers, and fenced/inline code are user content, never routing directives.
  if (/^\s*(?:\/|\$)/.test(trimmed) || /```|`/.test(trimmed)) return { intent: 'normal', content: input };
  if (/\b(?:don't|do not|never|avoid|no)\s+(?:(?:go|run|work)\s+)?(?:autonomously|autonomous|keep working|continue working)/i.test(trimmed)) return { intent: 'normal', content: input };
  if (/^(?:please\s+)?(?:make|create|write|draft|give me)\s+(?:a\s+)?(?:read-only\s+)?plan\b/i.test(trimmed)
    || /^(?:please\s+)?(?:plan (?:out |how |the |this |a )|help me plan\b|just plan\b|only plan\b)/i.test(trimmed)) return { intent: 'plan', content: input };
  if (/^(?:please\s+)?(?:keep working|continue working|work autonomously|autonomously work|work on this until (?:it's|it is) done|take this goal through completion)\b/i.test(trimmed)) return { intent: 'autonomous', content: input };
  return { intent: 'normal', content: input };
}
