import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '@mingle/contracts';
import { EXAMPLE_CLIENT_SESSION_ID, EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { startTestApp, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

/** Interleaves two sessions so a global message sequence number never equals a per-session position. */
async function seeded(count = 12) {
  const t = await startTestApp();
  apps.push(t);
  await t.api('GET', '/api/bootstrap');
  const mine: Message[] = [];
  const other: Message[] = [];
  for (let index = 0; index < count; index++) {
    mine.push(t.app.store.insertMessage({ sessionId: EXAMPLE_CLIENT_SESSION_ID, role: index % 2 ? 'assistant' : 'user', content: `mine ${index}` }));
    other.push(t.app.store.insertMessage({ sessionId: EXAMPLE_CONTRACT_SESSION_ID, role: 'user', content: `other ${index}` }));
  }
  // Earlier seeded example messages may exist; the pages below are always compared against the stored order.
  const stored = t.app.store.listMessages(EXAMPLE_CLIENT_SESSION_ID, { limit: 2000 });
  return { t, mine, other, stored };
}

const page = async (t: TestApp, sessionId: string, query: string) => t.api<Message[]>('GET', `/api/sessions/${sessionId}/messages${query}`);

describe('session message history cursors', () => {
  it('pages strictly older messages in chronological order without gaps or overlap', async () => {
    const { t, stored } = await seeded();
    const newest = await page(t, EXAMPLE_CLIENT_SESSION_ID, '?limit=5');
    expect(newest.status).toBe(200);
    expect(newest.json.map((message) => message.id)).toEqual(stored.slice(-5).map((message) => message.id));
    const second = await page(t, EXAMPLE_CLIENT_SESSION_ID, `?limit=5&before=${newest.json[0]!.id}`);
    expect(second.json.map((message) => message.id)).toEqual(stored.slice(-10, -5).map((message) => message.id));
    const seen = new Set<string>([...newest.json, ...second.json].map((message) => message.id));
    expect(seen.size).toBe(10);
    expect(second.json.every((message) => message.sessionId === EXAMPLE_CLIENT_SESSION_ID)).toBe(true);
  });

  it('returns an empty page before the first message instead of the newest page', async () => {
    const { t, stored } = await seeded();
    const first = await page(t, EXAMPLE_CLIENT_SESSION_ID, `?limit=5&before=${stored[0]!.id}`);
    expect(first.status).toBe(200);
    expect(first.json).toEqual([]);
  });

  it('rejects unknown and other-session cursors identically, so neither is silently the newest page', async () => {
    const { t, other, mine } = await seeded();
    const unknown = await page(t, EXAMPLE_CLIENT_SESSION_ID, '?limit=5&before=msg_doesnotexist');
    const foreign = await page(t, EXAMPLE_CLIENT_SESSION_ID, `?limit=5&before=${other[6]!.id}`);
    expect(unknown.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual(unknown.json);
    expect(JSON.stringify(foreign.json)).not.toContain(other[6]!.id);
    // The same cursor is valid in its own session.
    const own = await page(t, EXAMPLE_CONTRACT_SESSION_ID, `?limit=3&before=${other[6]!.id}`);
    expect(own.status).toBe(200);
    expect(own.json.map((message) => message.content)).toEqual(['other 3', 'other 4', 'other 5']);
    expect(mine.length).toBe(12);
  });

  it('rejects an empty cursor and still serves the newest page without one', async () => {
    const { t } = await seeded();
    expect((await page(t, EXAMPLE_CLIENT_SESSION_ID, '?before=')).status).toBe(400);
    expect((await page(t, EXAMPLE_CLIENT_SESSION_ID, '?limit=3')).json).toHaveLength(3);
    expect((await page(t, EXAMPLE_CLIENT_SESSION_ID, '?limit=0&before=x')).status).toBe(400);
  });

  it('the store never falls back to the newest page for a cursor outside the session', async () => {
    const { t, other } = await seeded();
    expect(t.app.store.listMessages(EXAMPLE_CLIENT_SESSION_ID, { limit: 5, beforeId: other[3]!.id })).toEqual([]);
    expect(t.app.store.hasSessionMessage(EXAMPLE_CLIENT_SESSION_ID, other[3]!.id)).toBe(false);
    expect(t.app.store.hasSessionMessage(EXAMPLE_CONTRACT_SESSION_ID, other[3]!.id)).toBe(true);
  });

  it('keeps the bootstrap window the web history control assumes (BOOTSTRAP_MESSAGES_PER_SESSION = 300)', async () => {
    const { t } = await seeded(1);
    for (let index = 0; index < 310; index++) t.app.store.insertMessage({ sessionId: EXAMPLE_CLIENT_SESSION_ID, role: 'user', content: `bulk ${index}` });
    const boot = await t.api<{ messages: Message[] }>('GET', '/api/bootstrap');
    const mine = boot.json.messages.filter((message) => message.sessionId === EXAMPLE_CLIENT_SESSION_ID);
    expect(mine).toHaveLength(300);
    // The newest window plus pages before its first message reach every stored message exactly once.
    const older = await page(t, EXAMPLE_CLIENT_SESSION_ID, `?limit=2000&before=${mine[0]!.id}`);
    const all = t.app.store.listMessages(EXAMPLE_CLIENT_SESSION_ID, { limit: 2000 });
    expect([...older.json, ...mine].map((message) => message.id)).toEqual(all.map((message) => message.id));
  });
});
