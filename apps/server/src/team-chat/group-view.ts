import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { GroupSnapshot, Task, TaskStatus, TeamChatGroupView } from '../../../../packages/contracts/src/index.ts';
import { TeamChatGroupViewSchema } from '../../../../packages/contracts/src/team-chat.ts';
import type { Store } from '../store.ts';
import { redactSecrets } from '../util.ts';

const MAX_PACKED_BODY = 18_000;
const MAX_UNPACKED_BYTES = 160_000;
const GROUP_VIEW_PREFIX = 'team-group-view:';

export function groupViewSourceId(groupId: string): string {
  return `${GROUP_VIEW_PREFIX}${createHash('sha256').update(groupId).digest('hex').slice(0, 32)}`;
}

function bounded(value: string, limit: number): string {
  const safe = redactSecrets(value).trim();
  return safe.length > limit ? `${safe.slice(0, limit).trimEnd()}…` : safe;
}

function relativeChangedPath(value: string): string | null {
  const path = value.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').some((part) => part === '..' || !part)) return null;
  return path.length > 300 ? `${path.slice(0, 299)}…` : path;
}

function taskStatus(status: TaskStatus | undefined): TeamChatGroupView['assignments'][number]['taskStatus'] {
  return status ?? 'unknown';
}

function resultFor(snapshot: GroupSnapshot, store: Store): TeamChatGroupView['result'] {
  const message = [...snapshot.messages].reverse().find((item) => item.kind === 'user');
  if (!message) return null;
  const request = snapshot.requests.filter((item) => item.messageId === message.id).at(-1);
  if (!request) return {
    requestId: `unrouted:${message.id}`, status: 'pending', title: 'Waiting to start',
    summary: 'This shared request has no recorded group turns yet.', facts: [], changedPaths: [],
  };
  const deliveries = snapshot.deliveries.filter((item) => item.requestId === request.id);
  const assignments = snapshot.assignments.filter((item) => item.requestId === request.id);
  const tasks = assignments.map((assignment) => store.getTask(assignment.taskId))
    .filter((task): task is Task => Boolean(task && task.projectId === snapshot.group.projectId));
  const active = deliveries.some((item) => item.status === 'queued' || item.status === 'running');
  const failed = deliveries.some((item) => item.status === 'failed');
  const stopped = deliveries.some((item) => item.status === 'interrupted' || item.status === 'cancelled');
  const requestState = request.status as string;
  const blocked = tasks.some((task) => task.status === 'blocked');
  const unfinished = tasks.some((task) => task.status === 'backlog' || task.status === 'ready' || task.status === 'running');
  const changedPaths = [...new Set(deliveries.flatMap((delivery) => {
    if (delivery.status !== 'completed' || !delivery.runId) return [];
    const run = store.getRun(delivery.runId);
    if (!run || run.status !== 'completed' || run.changes?.status !== 'available') return [];
    return run.changes.files.flatMap((file) => {
      const path = relativeChangedPath(file.path);
      return path ? [path] : [];
    });
  }))].slice(0, 100);

  let status: NonNullable<TeamChatGroupView['result']>['status'];
  let title: string;
  let summary: string;
  if (requestState === 'failed') {
    status = 'failed'; title = 'Request failed'; summary = 'The shared group request failed before a complete outcome was recorded.';
  } else if (requestState === 'interrupted' || requestState === 'cancelled') {
    status = 'stopped'; title = 'Request interrupted'; summary = 'The shared group request was interrupted or cancelled before completion.';
  } else if (requestState !== 'active' && requestState !== 'completed' && requestState !== 'paused') {
    status = 'unknown'; title = 'Outcome unavailable'; summary = 'The shared group request ended in an unrecognized state; completion is not claimed.';
  } else if (failed) {
    status = 'failed'; title = 'A turn failed'; summary = 'A shared group turn failed. The failure state is recorded below.';
  } else if (stopped) {
    status = 'stopped'; title = 'Stopped before finishing'; summary = 'A shared group turn was interrupted or cancelled.';
  } else if (requestState === 'paused' || (snapshot.group.paused && requestState === 'active')) {
    status = 'paused'; title = 'Paused'; summary = 'New group work is paused. Active work and queued work may remain.';
  } else if (active || requestState === 'active') {
    status = 'in-progress'; title = 'Finalizing request'; summary = 'Recorded turns have ended, but the group request is still active.';
  } else if (blocked) {
    status = 'blocked'; title = 'Blocked'; summary = 'At least one assigned task is blocked.';
  } else if (unfinished) {
    status = 'follow-up'; title = 'Follow-up needed'; summary = 'At least one assigned task still needs work.';
  } else if (tasks.length && tasks.every((task) => task.status === 'done')) {
    status = 'accepted'; title = 'Tasks accepted'; summary = 'All assigned tasks are marked done.';
  } else if (tasks.length) {
    status = 'review'; title = 'Ready for review'; summary = 'The shared task state is ready for human review.';
  } else if (!deliveries.length) {
    status = 'unknown'; title = 'Outcome unavailable'; summary = 'No group deliveries are recorded for this completed request.';
  } else {
    status = 'responded'; title = 'Team finished responding'; summary = 'The group finished responding; no task acceptance is recorded.';
  }

  const taskCounts = new Map<string, number>();
  for (const task of tasks) taskCounts.set(task.status, (taskCounts.get(task.status) ?? 0) + 1);
  const facts = [
    assignments.length ? `${assignments.length} assigned task${assignments.length === 1 ? '' : 's'}` : null,
    taskCounts.get('review') ? `${taskCounts.get('review')} need review` : null,
    taskCounts.get('done') ? `${taskCounts.get('done')} accepted` : null,
    changedPaths.length ? `${changedPaths.length} changed path${changedPaths.length === 1 ? '' : 's'} reported` : null,
  ].filter((item): item is string => Boolean(item));
  return { requestId: request.id, status, title, summary, facts, changedPaths };
}

export function projectGroupView(snapshot: GroupSnapshot, store: Store, version: number): TeamChatGroupView {
  const memberById = new Map(snapshot.members.map((member) => [member.id, member]));
  const activeMembers = snapshot.members.filter((member) => !member.removedAt);
  const removedMembers = snapshot.members.filter((member) => member.removedAt);
  const removedLimit = Math.max(0, 64 - activeMembers.length);
  const roster = [...activeMembers, ...(removedLimit ? removedMembers.slice(-removedLimit) : [])];
  const members: TeamChatGroupView['members'] = roster.map((member) => ({
    handle: member.handle, role: member.role, removed: Boolean(member.removedAt),
  }));
  const defaultMemberIds = snapshot.group.mode === 'cowork'
    ? snapshot.members.filter((member) => !member.removedAt).map((member) => member.id)
    : snapshot.group.orchestratorMemberId ? [snapshot.group.orchestratorMemberId] : [];
  const defaultRecipientHandles = defaultMemberIds.flatMap((id) => {
    const member = memberById.get(id);
    return member && !member.removedAt ? [member.handle] : [];
  });
  const messages: TeamChatGroupView['messages'] = snapshot.messages.slice(-50).map((message) => ({
    id: message.id, seq: message.seq, kind: message.kind,
    senderHandle: message.senderMemberId ? memberById.get(message.senderMemberId)?.handle ?? null : null,
    recipientHandles: message.recipientMemberIds.flatMap((id) => {
      const member = memberById.get(id);
      return member ? [member.handle] : [];
    }),
    // Assignment bodies are execution instructions; expose the linked task summary below, not its provider prompt.
    // Artifact notes may contain host worktree details; expose artifact status without the raw payload.
    content: message.kind === 'assignment' ? '' : message.kind === 'artifact' ? 'A shared artifact was recorded.' : bounded(message.content, 3_000),
    requestId: message.requestId, createdAt: message.createdAt,
  }));
  const requests: TeamChatGroupView['requests'] = snapshot.requests.slice(-20).map((request) => ({
    id: request.id, messageId: request.messageId, plannerHandle: memberById.get(request.plannerMemberId)?.handle ?? null,
    status: ['active', 'paused', 'completed', 'failed', 'interrupted', 'cancelled', 'expired'].includes(request.status as string)
      ? request.status as TeamChatGroupView['requests'][number]['status'] : 'unknown',
    turnsUsed: request.turnsUsed, createdAt: request.createdAt,
  }));
  const deliveries: TeamChatGroupView['deliveries'] = snapshot.deliveries.slice(-100).map((delivery) => ({
    id: delivery.id, requestId: delivery.requestId, messageId: delivery.messageId,
    handle: memberById.get(delivery.memberId)?.handle ?? 'unknown', kind: delivery.kind ?? 'message', status: delivery.status,
    hop: delivery.hop, error: delivery.status === 'failed' ? 'Delivery failed.' : null,
    createdAt: delivery.createdAt, updatedAt: delivery.updatedAt,
  }));
  const assignments: TeamChatGroupView['assignments'] = snapshot.assignments.slice(-50).flatMap((assignment) => {
    const task = store.getTask(assignment.taskId);
    const from = memberById.get(assignment.fromMemberId);
    const to = memberById.get(assignment.toMemberId);
    if (!from || !to) return [];
    return [{
      id: assignment.id, requestId: assignment.requestId, deliveryId: assignment.deliveryId,
      fromHandle: from.handle, toHandle: to.handle, taskId: assignment.taskId,
      title: task?.projectId === snapshot.group.projectId ? bounded(task.title, 200) || 'Task record unavailable' : 'Task record unavailable',
      taskStatus: task?.projectId === snapshot.group.projectId ? taskStatus(task.status) : 'unknown',
      scope: assignment.scope.slice(0, 10).flatMap((path) => {
        const relative = relativeChangedPath(path);
        return relative ? [relative.length > 240 ? `${relative.slice(0, 239)}…` : relative] : [];
      }), createdAt: assignment.createdAt,
    }];
  });
  const updatedAt = [snapshot.group.updatedAt, ...snapshot.messages.map((message) => message.createdAt), ...snapshot.deliveries.map((delivery) => delivery.updatedAt)]
    .filter((value) => Number.isFinite(Date.parse(value))).sort().at(-1) ?? new Date().toISOString();
  return TeamChatGroupViewSchema.parse({
    version, group: { id: snapshot.group.id, title: bounded(snapshot.group.title, 100), mode: snapshot.group.mode, paused: snapshot.group.paused },
    routing: { mode: snapshot.group.mode, defaultRecipientHandles }, members, messages, requests, deliveries, assignments,
    result: resultFor(snapshot, store), updatedAt,
  });
}

export function encodeGroupView(view: TeamChatGroupView): string {
  const boundedView = structuredClone(TeamChatGroupViewSchema.parse(view));
  const body = () => `team-group-view:v1:${deflateRawSync(Buffer.from(JSON.stringify(boundedView), 'utf8'), { level: 9 }).toString('base64')}`;
  let packed = body();
  while (packed.length > MAX_PACKED_BODY && boundedView.messages.length) { boundedView.messages.shift(); packed = body(); }
  while (packed.length > MAX_PACKED_BODY && boundedView.assignments.length > 10) { boundedView.assignments.shift(); packed = body(); }
  if (packed.length > MAX_PACKED_BODY && boundedView.result) {
    boundedView.result.changedPaths = boundedView.result.changedPaths.slice(-20);
    packed = body();
  }
  if (packed.length > MAX_PACKED_BODY) throw new Error('The bounded shared group view exceeds its transport limit.');
  return packed;
}

export function decodeGroupView(body: string): TeamChatGroupView {
  const prefix = 'team-group-view:v1:';
  if (!body.startsWith(prefix) || body.length > MAX_PACKED_BODY) throw new Error('The shared group view payload is invalid.');
  const compressed = Buffer.from(body.slice(prefix.length), 'base64');
  const unpacked = inflateRawSync(compressed, { maxOutputLength: MAX_UNPACKED_BYTES });
  return TeamChatGroupViewSchema.parse(JSON.parse(unpacked.toString('utf8')));
}
