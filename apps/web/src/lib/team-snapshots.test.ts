import { expect, it } from 'vitest';
import type { TeamChatSnapshot, TeamStructureSnapshot } from '@mingle/contracts';
import { reconcileTeamChatSnapshot, retainTeamStructureSnapshot } from './team-snapshots';

const at = '2026-10-28T12:00:00.000Z';

function chatSnapshot(messages: TeamChatSnapshot['messages']): TeamChatSnapshot {
  return {
    project: { teamId: '10000000-0000-4000-8000-000000000001', sharedProjectId: '20000000-0000-4000-8000-000000000001', name: 'Example project' },
    messages, hasMore: false, nextBefore: null, groupView: null, members: [], agents: [],
    transport: { status: 'ready', error: null, localDeviceId: null, linkedDeviceCount: 0, onlineDeviceCount: 0, peers: [] },
  };
}

function message(id: string, body: string, createdAt = at): TeamChatSnapshot['messages'][number] {
  return {
    id, teamId: '10000000-0000-4000-8000-000000000001', sharedProjectId: '20000000-0000-4000-8000-000000000001',
    author: { kind: 'human', accountId: '30000000-0000-4000-8000-000000000001', displayName: 'Example teammate' },
    body, mentions: [], createdAt, deliveryState: 'sent', runState: null,
  };
}

it('keeps the current session snapshot and message row identities for unchanged refresh data', () => {
  const row = message('message-1', 'Example request');
  const current = chatSnapshot([row]);
  const refreshed = reconcileTeamChatSnapshot(current, structuredClone(current));

  expect(refreshed).toBe(current);
  expect(refreshed.messages).toBe(current.messages);
  expect(refreshed.messages[0]).toBe(row);
});

it('does not blank the mounted timeline when a refresh temporarily omits visible messages', () => {
  const row = message('message-1', 'Visible example request');
  const current = chatSnapshot([row]);
  const refreshed = reconcileTeamChatSnapshot(current, chatSnapshot([]));

  expect(refreshed).toBe(current);
  expect(refreshed.messages).toEqual([row]);
  expect(refreshed.messages[0]).toBe(row);
});

it('merges fetched rows without dropping older visible content and reuses unchanged rows', () => {
  const older = message('message-1', 'Older example request', '2026-10-28T11:00:00.000Z');
  const currentMessage = message('message-2', 'Current text');
  const current = chatSnapshot([older, currentMessage]);
  const refreshed = reconcileTeamChatSnapshot(current, chatSnapshot([
    message('message-2', 'Updated text'), message('message-3', 'New response', '2026-10-28T13:00:00.000Z'),
  ]));

  expect(refreshed.messages.map((row) => row.id)).toEqual(['message-1', 'message-2', 'message-3']);
  expect(refreshed.messages[0]).toBe(older);
  expect(refreshed.messages[1]?.body).toBe('Updated text');
});

it('retains the same team structure reference when a structure refetch has no changes', () => {
  const current = {
    projectId: 'project-a', teamId: 'team-a', sharedProjectId: 'shared-a', enabled: true,
    settings: null, host: { deviceId: 'device-a', accountId: 'account-a', displayName: 'Example lead', online: true, isThisDevice: false },
    canEdit: false, myConsent: null, members: [], leaderHistory: [], needsLeader: false, teamSession: null,
  } as unknown as TeamStructureSnapshot;

  expect(retainTeamStructureSnapshot(current, structuredClone(current))).toBe(current);
});
