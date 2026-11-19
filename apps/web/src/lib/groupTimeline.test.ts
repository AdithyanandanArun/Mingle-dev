import { expect, it } from 'vitest';
import type { GroupSnapshot, Message, SessionRun, UserQuestion } from '@mingle/contracts';
import { buildTimeline } from './groupTimeline';

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 20, 0, 0, seconds)).toISOString();

it('keeps member questions and completion evidence ahead of newer group messages without the original run message', () => {
  const snapshot: GroupSnapshot = {
    group: { id: 'g1', projectId: 'p1', title: 'Example group', anchorSessionId: 's1', mode: 'cowork', orchestratorMemberId: null,
      paused: false, pauseReason: null, maxParallel: 2, maxTurns: 3, maxHops: 3, createdAt: at(0), updatedAt: at(7) },
    members: [{ id: 'member-1', groupId: 'g1', sessionId: 's1', joinedAt: at(0), removedAt: at(7), handle: 'example', role: 'peer' }],
    messages: [{ id: 'follow-up', seq: 1, groupId: 'g1', senderMemberId: null, recipientMemberIds: [], kind: 'user', content: 'Example follow-up',
      requestId: null, replyToId: null, sourceMessageId: null, sourceRunId: null, createdAt: at(6) }],
    requests: [], deliveries: [], assignments: [],
  };
  const messages: Message[] = [
    { id: 'first', sessionId: 's1', role: 'assistant', content: 'Example before question', createdAt: at(2), runId: 'r1' },
    { id: 'resumed', sessionId: 's1', role: 'assistant', content: 'Example after question', createdAt: at(4), runId: 'r1' },
  ];
  const run: SessionRun = { id: 'r1', sessionId: 's1', userMessageId: 'unloaded', provider: 'codex', model: 'example',
    status: 'completed', startedAt: at(1), finishedAt: at(5), durationMs: 1, toolCount: 0, toolCounts: {} };
  const question: UserQuestion = { id: 'q1', sessionId: 's1', runId: 'r1', provider: 'codex', tool: 'Example', questions: [],
    status: 'answered', createdAt: at(3), resolvedAt: at(4) };
  const timeline = buildTimeline({ snapshot, sessions: [], messages, streams: {}, runs: [run],
    questions: [question, { ...question, id: 'after-removal', createdAt: at(8) }] });
  expect(timeline.map(item => item.key)).toEqual(['activity:r1', 'n:first', 'question:q1', 'n:resumed', 'changes:r1', 'g:follow-up']);
});
