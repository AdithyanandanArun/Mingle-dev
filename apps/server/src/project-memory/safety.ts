import { createHash } from 'node:crypto';
import { isDeniedName, normalizeRelative } from '../paths.ts';
import { redactSecrets } from '../util.ts';

const SECRET_SHAPES: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{8,}/],
  ['API key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['Google key', /AIza[A-Za-z0-9_-]{30,}/],
  ['Google OAuth token', /ya29\.[A-Za-z0-9._~-]{16,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['GitHub token', /github_pat_[A-Za-z0-9_]{20,}/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ['credential in URL', /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/i],
  ['credential assignment', /\b(?:pass(?:word|wd)?|secret|(?:api|access|auth|private)[_-]?(?:key|token)|token|credential)s?["']?\s*[:=]\s*["']?[^\s"'`,;]{8,}/i],
];

function entropy(token: string): number {
  const counts = new Map<string, number>();
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) { const p = count / token.length; bits -= p * Math.log2(p); }
  return bits;
}

/** Returns a short label when `text` looks like it contains a credential, otherwise null. Memory is rejected, never redacted. */
export function detectSecret(text: string): string | null {
  for (const [label, pattern] of SECRET_SHAPES) if (pattern.test(text)) return label;
  if (redactSecrets(text) !== text) return 'credential';
  for (const token of text.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []) {
    if (/^[0-9a-f]+$/i.test(token)) continue; // commit and content hashes are ordinary memory content
    if (/^[A-Za-z]+$/.test(token) || /^[a-z0-9-]+$/.test(token)) continue; // long words and kebab-case names
    if (/^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.test(token)) continue; // CamelCaseIdentifiers
    if (/[A-Za-z]/.test(token) && /\d/.test(token) && entropy(token) >= 4.2) return 'high-entropy string';
  }
  return null;
}

/** Strips control characters (keeping newlines and tabs) so stored text cannot hide or forge structure. */
export function cleanText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '').trim();
}

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

/** Project-relative, forward-slash, traversal-free path that does not name a credential or VCS-internal file. */
export function checkMemoryPath(input: string): PathCheck {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'empty path' };
  if (trimmed.endsWith('/')) return { ok: false, reason: 'directories cannot be referenced' };
  let normalized: string;
  try { normalized = normalizeRelative(trimmed); }
  catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'invalid path' }; }
  if (!normalized) return { ok: false, reason: 'the project root cannot be referenced' };
  if (normalized.split('/').some((part) => isDeniedName(part))) return { ok: false, reason: 'protected file' };
  if (detectSecret(normalized)) return { ok: false, reason: 'path looks like a secret' };
  return { ok: true, path: normalized };
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'not', 'but', 'you', 'all', 'can', 'has', 'have',
  'use', 'used', 'using', 'when', 'then', 'into', 'its', 'our', 'any', 'should', 'would', 'could', 'will', 'does', 'just', 'than', 'also', 'how',
  'what', 'why', 'where', 'which', 'there', 'their', 'them', 'they', 'been', 'being', 'out', 'new', 'add', 'fix', 'please', 'make', 'need', 'want']);

/** Scripts written without spaces between words; they are indexed as overlapping character pairs. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function fold(text: string): string { return text.normalize('NFKC').toLowerCase(); }

/** Unicode-aware search tokens: letters and numbers of any script, camelCase splitting, and character bigrams for unspaced scripts. */
export function tokenize(text: string): string[] {
  const out = new Set<string>();
  const spaced = text.normalize('NFKC').replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2');
  for (const raw of fold(spaced).split(/[^\p{L}\p{N}_]+/u)) {
    for (const piece of [raw, ...raw.split('_')]) {
      if (!piece) continue;
      if (UNSPACED.test(piece)) {
        const chars = [...piece];
        if (chars.length === 1) out.add(piece);
        else for (let index = 0; index < chars.length - 1; index++) out.add(chars[index]! + chars[index + 1]!);
      } else if (([...piece].length >= 2 || /^\p{N}$/u.test(piece)) && !STOP_WORDS.has(piece)) out.add(piece);
    }
  }
  return [...out];
}

/** NFKC-folded letters and digits of every script, separated by single spaces. Punctuation-only text normalizes to ''. */
export function normalizeForKey(text: string): string {
  return fold(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function sha(text: string, length = 32): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

/** Same kind + same normalized title. Text with no letters or digits falls back to its exact form plus the body so unrelated entries never collide. */
export function titleKey(kind: string, title: string, body: string): string {
  const normalized = normalizeForKey(title);
  return normalized ? sha(`${kind}\0${normalized}`) : sha(`${kind}\0raw\0${title.normalize('NFKC').trim()}\0${normalizeForKey(body) || body.normalize('NFKC').trim()}`);
}
export function bodyKey(body: string): string {
  const normalized = normalizeForKey(body);
  return sha(normalized ? `n\0${normalized}` : `raw\0${body.normalize('NFKC').trim()}`);
}

export function jaccard(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const a = new Set(left);
  let shared = 0;
  for (const token of new Set(right)) if (a.has(token)) shared++;
  return shared / (a.size + new Set(right).size - shared);
}
