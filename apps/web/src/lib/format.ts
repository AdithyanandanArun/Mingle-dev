import { useEffect, useState } from 'react';

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' });

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export const clockTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

export const dayLabel = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown date';
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

/** Re-renders on an interval so relative timestamps stay honest. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export const formatCount = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const formatCost = (c: number | null): string => (c === null ? 'n/a' : `$${c.toFixed(c < 1 ? 4 : 2)}`);

export const basename = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;

export const shortPath = (p: string, keep = 3): string => {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= keep ? p : `…/${parts.slice(-keep).join('/')}`;
};

const LANGS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', mdx: 'markdown', css: 'css', scss: 'scss', html: 'html', yml: 'yaml', yaml: 'yaml',
  py: 'python', rs: 'rust', go: 'go', java: 'java', sh: 'shell', bash: 'shell', zsh: 'shell', sql: 'sql', toml: 'ini',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', rb: 'ruby', php: 'php', xml: 'xml', svg: 'xml', txt: 'plaintext',
};
export const languageFor = (path: string): string => LANGS[(path.split('.').pop() ?? '').toLowerCase()] ?? 'plaintext';

export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');

/** Subsequence fuzzy score; higher is better, -1 means no match. */
export function fuzzy(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return -1;
    streak = idx === ti ? streak + 1 : 0;
    score += 1 + streak * 2 + (idx === 0 || ' /-_.'.includes(t[idx - 1] ?? '') ? 3 : 0);
    ti = idx + 1;
  }
  return score - t.length * 0.01;
}
