import { redactSecrets } from './util.ts';

/** A stable title derived locally from the first human request. This never calls a provider. */
const MAX_TITLE = 64;

const INTERNAL_PREFIX = /^\s*(?:\/|<\|?(?:system|assistant|user|developer)|\[?(?:internal|system|handoff|workflow|continuation)\b)/i;

export function isAutomaticSessionPlaceholder(name: string): boolean {
  return /^Session\s+\d+$/i.test(name.trim());
}

/** Return a useful, bounded title, or undefined when the input is not a human task. */
export function deriveSessionName(content: string): string | undefined {
  let text = content.normalize('NFKC')
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/\r\n?/g, '\n').trim();
  // Canonicalization can reveal an obfuscated credential; check both representations.
  if (redactSecrets(content) !== content || redactSecrets(text) !== text) return undefined;
  if (!text || INTERNAL_PREFIX.test(text)) return undefined;
  // Strip common metadata/context envelopes while retaining the user's actual request.
  text = text.replace(/^\s*(?:\[?(?:user request|task|prompt)\]?\s*:\s*)/i, '');
  if (!text.trim() || text.length > 20_000) return undefined;
  const lines: string[] = [];
  let fence: '`' | '~' | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const fenceMarker = line.match(/^(`{3,}|~{3,})/);
    if (fenceMarker) {
      const marker = fenceMarker[1]![0] as '`' | '~';
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (!fence && line) lines.push(line);
  }
  const meaningful = lines.find((line) => !/^[-*_]{3,}$/.test(line) && !/^https?:\/\//i.test(line));
  if (!meaningful || /^\s*\//.test(meaningful)) return undefined;
  let title = meaningful
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '')
    .trim();
  if (!title || /^\/(?:\w+)?$/.test(title) || /^\p{Extended_Pictographic}+$/u.test(title)) return undefined;
  if (/^(?:continue|go on|yes|ok|okay|thanks|thank you)[.!?]*$/i.test(title)) return undefined;
  const points = Array.from(title);
  if (points.length > MAX_TITLE) title = `${points.slice(0, MAX_TITLE - 1).join('').trimEnd()}…`;
  return title || undefined;
}
