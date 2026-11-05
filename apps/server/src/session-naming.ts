/** A stable title derived locally from the first human request. This never calls a provider. */
const MAX_TITLE = 64;

const INTERNAL_PREFIX = /^(?:\s*(?:\/|<\|?(?:system|assistant|user|developer)|\[?(?:internal|system|handoff|workflow|continuation)\b)/i;

export function isAutomaticSessionPlaceholder(name: string): boolean {
  return /^Session\s+\d+$/i.test(name.trim());
}

/** Return a useful, bounded title, or undefined when the input is not a human task. */
export function deriveSessionName(content: string): string | undefined {
  let text = content.normalize('NFKC').replace(/\r\n?/g, '\n').trim();
  if (!text || INTERNAL_PREFIX.test(text)) return undefined;
  // Strip common metadata/context envelopes while retaining the user's actual request.
  text = text.replace(/^\s*(?:\[?(?:user request|task|prompt)\]?\s*:\s*)/i, '');
  if (!text.trim() || text.length > 20_000) return undefined;
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const meaningful = lines.find((line) => !/^```/.test(line) && !/^[-*_]{3,}$/.test(line) && !/^https?:\/\//i.test(line));
  if (!meaningful || /^\s*\//.test(meaningful)) return undefined;
  let title = meaningful
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\s]+$/gu, '')
    .trim();
  if (!title || /^\/(?:\w+)?$/.test(title) || /^\p{Extended_Pictographic}+$/u.test(title)) return undefined;
  if (/^(?:continue|go on|yes|ok|okay|thanks|thank you)[.!?]*$/i.test(title)) return undefined;
  const points = Array.from(title);
  if (points.length > MAX_TITLE) title = `${points.slice(0, MAX_TITLE - 1).join('').trimEnd()}…`;
  return title || undefined;
}
