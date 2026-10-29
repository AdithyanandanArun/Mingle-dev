import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { GroupSnapshot, ProgressBoardSnapshot, Task, TaskStatus, TeamChatGroupView } from '../../../../packages/contracts/src/index.ts';
import { ProgressBoardSnapshotSchema } from '../../../../packages/contracts/src/progress-board.ts';
import { TeamChatGroupViewSchema } from '../../../../packages/contracts/src/team-chat.ts';
import { canonicalJson } from '../distributed/crypto.ts';
import type { Store } from '../store.ts';
import { redactSecrets } from '../util.ts';

const MAX_PACKED_BODY = 18_000;
const MAX_UNPACKED_BYTES = 160_000;
const GROUP_VIEW_PREFIX = 'team-group-view:';
const GROUP_VIEW_BODY_PREFIX = 'team-group-view:v1:';
const MAX_SHARED_BOARD_BYTES = 24 * 1024;

export function groupViewSourceId(groupId: string): string {
  return `${GROUP_VIEW_PREFIX}${createHash('sha256').update(groupId).digest('hex').slice(0, 32)}`;
}

function bounded(value: string, limit: number): string {
  const safe = redactSecrets(value).trim();
  return safe.length > limit ? `${safe.slice(0, limit).trimEnd()}…` : safe;
}

function boardText(value: string, limit: number): string {
  return redactSecrets(value)
    .replace(/\b(?:https?|ssh|git|file):\/\/[^\s'"<>]+/gi, '[remote]')
    .replace(/\b[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:[^\s'"<>]+/g, '[remote]')
    .replace(/(^|[\s("'=])~[\\/][^\s'"<>]*/g, '$1[path]')
    .replace(/(^|[\s("'=])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+[\\/])[^\s'"<>]*/g, '$1[path]')
    .replace(/(^|[\s("'=])\/(?:[^\s/'"<>]+\/)*[^\s'"<>]*/g, '$1[path]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
}

function boardBranch(value: string | null): string | null {
  if (!value) return null;
  if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)|\b(?:https?|ssh|git|file):\/\//i.test(value)) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || null;
}

/** Remove host-local metadata and keep the complete public snapshot below its transport budget. */
export function boundSharedProgressBoard(input: ProgressBoardSnapshot): ProgressBoardSnapshot {
  const board = ProgressBoardSnapshotSchema.parse(input);
  const boundedBoard = ProgressBoardSnapshotSchema.parse({
    ...board,
    integration: {
      branch: boardBranch(board.integration.branch),
      head: board.integration.head ? { ...board.integration.head, subject: boardText(board.integration.head.subject, 120) } : null,
      lastPush: board.integration.lastPush ? {
        ...board.integration.lastPush,
        ...(board.integration.lastPush.failure ? { failure: boardText(board.integration.lastPush.failure, 200) } : {}),
      } : null,
    },
    members: board.members.slice(0, 64).map((member) => ({
      ...member,
      device: boardText(member.device, 120) || 'Team device',
      currentTask: member.currentTask ? { ...member.currentTask, title: boardText(member.currentTask.title, 200) } : null,
      step: member.step ? { ...member.step, label: boardText(member.step.label, 200) || 'Current step unavailable' } : null,
      health: member.health ? {
        ...member.health,
        ...(member.health.reason ? { reason: boardText(member.health.reason, 160) } : {}),
      } : null,
      ...(member.assignmentHandoff ? { assignmentHandoff: {
        ...member.assignmentHandoff, handle: boardText(member.assignmentHandoff.handle, 32) || 'teammate',
      } } : {}),
      branch: member.branch && boardBranch(member.branch.name) ? {
        ...member.branch,
        name: boardBranch(member.branch.name)!,
        lastCommit: member.branch.lastCommit ? { ...member.branch.lastCommit, subject: boardText(member.branch.lastCommit.subject, 120) } : null,
      } : null,
      blockers: member.blockers.slice(0, 3).map((blocker) => boardText(blocker, 200)).filter(Boolean),
    })),
  });

  while (Buffer.byteLength(JSON.stringify(boundedBoard), 'utf8') > MAX_SHARED_BOARD_BYTES) {
    const blockerMember = [...boundedBoard.members].reverse().find((member) => member.blockers.length > 0);
    if (blockerMember) { blockerMember.blockers.pop(); continue; }
    if (boundedBoard.members.length > 1) { boundedBoard.members.pop(); continue; }
    // Contract field limits make a single member substantially smaller than the board cap.
    if (boundedBoard.members.length === 1) { boundedBoard.members.pop(); continue; }
    throw new Error('The bounded shared progress board exceeds its transport limit.');
  }
  return boundedBoard;
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
  const activeDeliveries = deliveries.filter((item) => item.status === 'queued' || item.status === 'running');
  const runningDeliveries = activeDeliveries.filter((item) => item.status === 'running');
  const active = activeDeliveries.length > 0;
  const activeMemberIds = new Set(runningDeliveries.map((delivery) => delivery.memberId));
  const awaitingApproval = snapshot.members.some((member) => activeMemberIds.has(member.id) && store.pendingApprovals(member.sessionId).length > 0);
  const runningDeliveryIds = new Set(runningDeliveries.map((delivery) => delivery.id));
  const queuedDeliveries = activeDeliveries.filter((delivery) => delivery.status === 'queued');
  const queuedDeliveryIds = new Set(queuedDeliveries.map((delivery) => delivery.id));
  const runningTaskIds = new Set(assignments.filter((assignment) => runningDeliveryIds.has(assignment.deliveryId)).map((assignment) => assignment.taskId));
  const queuedTaskIds = new Set(assignments.filter((assignment) => queuedDeliveryIds.has(assignment.deliveryId)).map((assignment) => assignment.taskId));
  const handlesFor = (rows: typeof activeDeliveries) => [...new Set(rows.flatMap((delivery) => {
    const member = snapshot.members.find((candidate) => candidate.id === delivery.memberId);
    return member ? [member.handle] : [];
  }))];
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
  } else if (awaitingApproval) {
    status = 'in-progress'; title = 'Waiting for approval'; summary = 'Waiting for the team lead\'s approval.';
  } else if (active) {
    status = 'in-progress'; title = 'In progress';
    const work = runningDeliveries.length ? (() => {
      const handles = handlesFor(runningDeliveries);
      const count = runningTaskIds.size || runningDeliveries.length;
      const unit = runningTaskIds.size ? 'task' : 'turn';
      const subject = handles.length ? handles.join(', ') : 'The team';
      return `${subject} ${handles.length > 1 ? 'are' : 'is'} working on ${count} ${unit}${count === 1 ? '' : 's'}.`;
    })() : '';
    const queued = queuedDeliveries.length ? (() => {
      const handles = handlesFor(queuedDeliveries);
      const count = queuedTaskIds.size || queuedDeliveries.length;
      const unit = queuedTaskIds.size ? 'task' : 'turn';
      const subject = handles.length ? handles.join(', ') : 'The team';
      return `${subject} ${handles.length > 1 ? 'have' : 'has'} ${count} ${unit}${count === 1 ? '' : 's'} queued.`;
    })() : '';
    summary = [work, queued].filter(Boolean).join(' ');
  } else if (requestState === 'active') {
    status = 'in-progress'; title = 'Finalizing request';
    summary = 'Wrapping up — the agents have finished; waiting for the team lead\'s orchestrator to close the request.';
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
  const openTaskCount = new Set(tasks.filter((task) => task.status !== 'done').map((task) => task.id)).size;
  const facts = [
    assignments.length ? `${assignments.length} assigned task${assignments.length === 1 ? '' : 's'}` : null,
    openTaskCount ? `${openTaskCount} task${openTaskCount === 1 ? '' : 's'} still open` : null,
    taskCounts.get('review') ? `${taskCounts.get('review')} need review` : null,
    taskCounts.get('done') ? `${taskCounts.get('done')} accepted` : null,
    changedPaths.length ? `${changedPaths.length} changed path${changedPaths.length === 1 ? '' : 's'} reported` : null,
  ].filter((item): item is string => Boolean(item));
  return { requestId: request.id, status, title, summary, facts, changedPaths };
}

export function projectGroupView(snapshot: GroupSnapshot, store: Store, version: number, board?: ProgressBoardSnapshot): TeamChatGroupView {
  // Member-origin chat requests have a distinct group message ID. Resolve the durable
  // routing identity only inside this project's collaboration binding, never by text.
  const routedHumanRows = store.db.prepare(`SELECT g.id,c.id AS source_id
    FROM group_messages g JOIN team_chat_messages c ON g.client_message_id='teamchat-' || c.id
    JOIN mingle_project_collaboration_sources s ON s.team_id=c.team_id AND s.shared_project_id=c.shared_project_id
    WHERE s.local_project_id=? AND g.group_id=? AND g.kind='user'
      AND json_extract(c.author_json,'$.kind')='human'
      AND g.id IN (SELECT value FROM json_each(?))`).all(snapshot.group.projectId, snapshot.group.id,
    JSON.stringify(snapshot.messages.slice(-50).filter((message) => message.kind === 'user').map((message) => message.id))) as Array<{ id: string; source_id: string }>;
  const routedHumanSources = new Map(routedHumanRows.map((row) => [row.id, row.source_id]));
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
    sourceMessageId: message.kind === 'user' ? routedHumanSources.get(message.id) ?? null : message.sourceMessageId,
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
    ...(board ? { board: boundSharedProgressBoard(board) } : {}),
    result: resultFor(snapshot, store), updatedAt,
  });
}

export function sharedGroupViewFingerprint(view: TeamChatGroupView): string {
  return createHash('sha256').update(canonicalJson({
    ...view,
    version: 0,
    updatedAt: '',
    ...(view.board ? { board: { ...view.board, updatedAt: '' } } : {}),
  })).digest('hex');
}

export function encodeGroupView(view: TeamChatGroupView): string {
  const boundedView = structuredClone(TeamChatGroupViewSchema.parse(view));
  const body = () => {
    const unpacked = Buffer.from(JSON.stringify(boundedView), 'utf8');
    const compressed = deflateRawSync(unpacked, { level: 9 }).toString('base64');
    return { packed: `${GROUP_VIEW_BODY_PREFIX}${compressed}`, unpackedBytes: unpacked.byteLength };
  };
  const trimOldest = (): boolean => {
    if (boundedView.board) {
      const board = boundedView.board;
      const blockerMember = [...board.members].reverse().find((member) => member.blockers.length > 0);
      if (blockerMember) { blockerMember.blockers.pop(); return true; }
      if (board.members.length > 1) { board.members.pop(); return true; }
      if (board.members.length) { board.members.pop(); return true; }
    }
    if (boundedView.messages.length > 1) { boundedView.messages.shift(); return true; }
    if (boundedView.assignments.length > 1) { boundedView.assignments.shift(); return true; }
    if (boundedView.deliveries.length > 1) { boundedView.deliveries.shift(); return true; }
    if (boundedView.requests.length > 1) { boundedView.requests.shift(); return true; }
    if (boundedView.result && boundedView.result.changedPaths.length > 1) { boundedView.result.changedPaths.shift(); return true; }
    if (boundedView.assignments[0]?.scope.length) { boundedView.assignments[0].scope.pop(); return true; }
    if (boundedView.result?.changedPaths.length) { boundedView.result.changedPaths.shift(); return true; }
    const latestMessage = boundedView.messages[0];
    if (latestMessage?.content) {
      const nextLength = Math.floor(latestMessage.content.length / 2);
      latestMessage.content = nextLength ? `${latestMessage.content.slice(0, nextLength).trimEnd()}…` : '';
      return true;
    }
    if (boundedView.assignments.length) { boundedView.assignments.shift(); return true; }
    if (boundedView.deliveries.length) { boundedView.deliveries.shift(); return true; }
    if (boundedView.requests.length) { boundedView.requests.shift(); return true; }
    if (boundedView.messages.length) { boundedView.messages.shift(); return true; }
    return false;
  };
  let encoded = body();
  while (encoded.packed.length > MAX_PACKED_BODY || encoded.unpackedBytes > MAX_UNPACKED_BYTES) {
    if (!trimOldest()) throw new Error('The bounded shared group view exceeds its transport limit.');
    encoded = body();
  }
  return encoded.packed;
}

export function decodeGroupView(body: string): TeamChatGroupView {
  if (!body.startsWith(GROUP_VIEW_BODY_PREFIX) || body.length > MAX_PACKED_BODY) throw new Error('The shared group view payload is invalid.');
  const encoded = body.slice(GROUP_VIEW_BODY_PREFIX.length);
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('The shared group view payload is invalid.');
  }
  const compressed = Buffer.from(encoded, 'base64');
  const unpacked = inflateRawSync(compressed, { maxOutputLength: MAX_UNPACKED_BYTES });
  return TeamChatGroupViewSchema.parse(JSON.parse(unpacked.toString('utf8')));
}
