import { describe, expect, it } from 'vitest';
import { deriveSessionName, isAutomaticSessionPlaceholder } from './session-naming.ts';

describe('session title derivation', () => {
  it('takes a concise first meaningful human request and handles Markdown and Unicode', () => {
    expect(deriveSessionName('## 🧭 Résumé this café app\n\nPlease preserve the colors.')).toBe('🧭 Résumé this café app');
    expect(deriveSessionName('**Fix** the broken `login` flow')).toBe('Fix the broken login flow');
  });

  it('rejects internal helpers, commands, attachment-only and empty content', () => {
    expect(deriveSessionName('/compact')).toBeUndefined();
    expect(deriveSessionName('[internal handoff] continue')).toBeUndefined();
    expect(deriveSessionName('   ')).toBeUndefined();
    expect(deriveSessionName('Here is my key: sk-123456789012345678901234')).toBeUndefined();
  });

  it('ignores fenced code and strips terminal controls before choosing a title', () => {
    expect(deriveSessionName('```ts\nconst secret = true;\n```\nImprove the settings page')).toBe('Improve the settings page');
    expect(deriveSessionName('\u001b[31m\u001b[0mFix\u0007 the search panel')).toBe('Fix the search panel');
  });

  it('bounds titles by Unicode code points and recognizes only numeric placeholders', () => {
    expect(Array.from(deriveSessionName('a'.repeat(100)) ?? '')).toHaveLength(64);
    expect(isAutomaticSessionPlaceholder('Session 3')).toBe(true);
    expect(isAutomaticSessionPlaceholder('Session One')).toBe(false);
  });
});
