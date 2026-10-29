import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type EventDetail = { message?: Record<string, unknown>; snapshot?: unknown };
const events: Array<[string, EventDetail]> = [];
const target = new EventTarget();
target.addEventListener('mingle:optimistic-session-message', (event) => events.push(['session', (event as CustomEvent<EventDetail>).detail]));
target.addEventListener('mingle:optimistic-session-remove', (event) => events.push(['session-remove', (event as CustomEvent<EventDetail>).detail]));
target.addEventListener('mingle:optimistic-group-message', (event) => events.push(['group', (event as CustomEvent<EventDetail>).detail]));
target.addEventListener('mingle:optimistic-group-accepted', (event) => events.push(['group-accepted', (event as CustomEvent<EventDetail>).detail]));
target.addEventListener('mingle:optimistic-group-remove', (event) => events.push(['group-remove', (event as CustomEvent<EventDetail>).detail]));
const { api } = await import('./api');
beforeEach(() => vi.stubGlobal('window', target));
afterEach(() => {
  events.length = 0;
  vi.unstubAllGlobals();
});

it('publishes the user message optimistically and rolls it back on a rejected send', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202 })));
  await api.sendMessage('session-1', 'hello');
  expect(events[0][0]).toBe('session');
  expect(events[0][1].message).toMatchObject({ sessionId: 'session-1', role: 'user', content: 'hello' });

  events.length = 0;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'busy' }), { status: 409 })));
  await expect(api.sendMessage('session-1', 'try again')).rejects.toMatchObject({ status: 409 });
  expect(events.map(([name]) => name)).toEqual(['session', 'session-remove']);
});

it('retries a failed message through the server-owned message and attachment clone endpoint', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  await expect(api.retryMessage('session/one', 'message one')).resolves.toEqual({ accepted: true });
  expect(fetch).toHaveBeenCalledWith('/api/sessions/session%2Fone/messages/message%20one/retry', expect.objectContaining({
    method: 'POST', body: '{}',
  }));
});

it('publishes a group message before sending and adopts the durable response snapshot', async () => {
  const snapshot = { group: { id: 'group-1' }, members: [], messages: [], requests: [], deliveries: [], assignments: [] };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 202 })));
  const result = await api.sendGroupMessage('group-1', { content: 'hello team', intent: 'normal', clientMessageId: 'client-1' });
  expect(result).toEqual(snapshot);
  expect(events.map(([name]) => name)).toEqual(['group', 'group-accepted']);
  expect(events[0][1].message).toMatchObject({ groupId: 'group-1', kind: 'user', content: 'hello team' });
  expect(events[1][1].snapshot).toEqual(snapshot);
});
