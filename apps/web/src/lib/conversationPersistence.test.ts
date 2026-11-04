import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_CACHE_KEY, MAX_CACHED_SESSIONS, MAX_DRAFT_CHARS, clearDraftIfMatches,
  loadDraft, loadReaderPosition, saveDraft, saveReaderPosition, type StorageLike,
} from './conversationPersistence';

class MemoryStorage implements StorageLike {
  value: string | null = null;
  getItem(key: string) { return key === CONVERSATION_CACHE_KEY ? this.value : null; }
  setItem(key: string, value: string) { if (key === CONVERSATION_CACHE_KEY) this.value = value; }
}

describe('conversation persistence', () => {
  it('bounds and validates drafts, and clears only the exact successfully sent text', () => {
    const storage = new MemoryStorage();
    saveDraft('session-a', 'sent version', storage);
    clearDraftIfMatches('session-a', 'older version', storage);
    expect(loadDraft('session-a', storage)).toBe('sent version');
    clearDraftIfMatches('session-a', 'sent version', storage);
    expect(loadDraft('session-a', storage)).toBeNull();
    saveDraft('session-a', 'x'.repeat(MAX_DRAFT_CHARS + 100), storage);
    expect(loadDraft('session-a', storage)).toHaveLength(MAX_DRAFT_CHARS);
  });

  it('keeps a bounded set of sessions and rejects invalid reader positions', () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < MAX_CACHED_SESSIONS + 4; i++) saveDraft(`session-${i}`, `draft-${i}`, storage);
    expect(JSON.parse(storage.value!).sessions).toHaveProperty(`session-${MAX_CACHED_SESSIONS + 3}`);
    expect(Object.keys(JSON.parse(storage.value!).sessions)).toHaveLength(MAX_CACHED_SESSIONS);
    saveReaderPosition('session-last', { pinned: false, messageId: 'message-a', offset: 48 }, storage);
    expect(loadReaderPosition('session-last', storage)).toEqual({ pinned: false, messageId: 'message-a', offset: 48 });
    saveReaderPosition('session-last', { pinned: false, messageId: 'x'.repeat(201), offset: Infinity }, storage);
    expect(loadReaderPosition('session-last', storage)).toEqual({ pinned: false, messageId: 'message-a', offset: 48 });
  });

  it('bounds the combined UTF-8 draft size as well as session count', () => {
    const storage = new MemoryStorage();
    const draft = '🧪'.repeat(10_000);
    for (let i = 0; i < 20; i++) saveDraft(`unicode-${i}`, draft, storage);
    const sessions = Object.values(JSON.parse(storage.value!).sessions) as Array<{ draft?: string }>;
    const bytes = sessions.reduce((sum, session) => sum + new TextEncoder().encode(session.draft ?? '').byteLength, 0);
    expect(bytes).toBeLessThanOrEqual(480_000);
  });

  it('treats corrupt or oversized storage as empty and tolerates write failures', () => {
    const corrupt: StorageLike = { getItem: () => '{', setItem: () => { throw new Error('quota'); } };
    expect(loadDraft('session-a', corrupt)).toBeNull();
    expect(() => saveDraft('session-a', 'draft', corrupt)).toThrow('quota');
    const oversized: StorageLike = { getItem: () => 'x'.repeat(200_000), setItem: () => {} };
    expect(loadDraft('session-a', oversized)).toBeNull();
  });
});
