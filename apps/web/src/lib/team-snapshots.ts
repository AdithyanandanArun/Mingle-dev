import type { TeamChatGroupView, TeamChatSnapshot, TeamStructureSnapshot } from '@mingle/contracts';

function sameData(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function reuseObject<T extends object>(previous: T, next: T): T {
  return sameData(previous, next) ? previous : next;
}

function reuseRows<T>(previous: readonly T[], next: readonly T[], keyOf: (item: T) => string): T[] {
  const oldByKey = new Map(previous.map((item) => [keyOf(item), item]));
  let unchanged = previous.length === next.length;
  const rows = next.map((item, index) => {
    const old = oldByKey.get(keyOf(item));
    const row = old && sameData(old, item) ? old : item;
    if (previous[index] !== row) unchanged = false;
    return row;
  });
  return unchanged ? previous as T[] : rows;
}

function reconcileGroupView(previous: TeamChatGroupView | null | undefined, next: TeamChatGroupView | null | undefined): TeamChatGroupView | null | undefined {
  if (!previous || !next) return previous === next ? previous : next;
  if (sameData(previous, next)) return previous;
  return {
    ...next,
    group: reuseObject(previous.group, next.group),
    routing: reuseObject(previous.routing, next.routing),
    members: reuseRows(previous.members, next.members, (member) => member.handle),
    messages: reuseRows(previous.messages, next.messages, (message) => message.id),
    requests: reuseRows(previous.requests, next.requests, (request) => request.id),
    deliveries: reuseRows(previous.deliveries, next.deliveries, (delivery) => delivery.id),
    assignments: reuseRows(previous.assignments, next.assignments, (assignment) => assignment.id),
    result: sameData(previous.result, next.result) ? previous.result : next.result,
  };
}

/** Keep existing team-session rows and references when a poll returns unchanged records. */
export function reconcileTeamChatSnapshot(previous: TeamChatSnapshot | null, latest: TeamChatSnapshot): TeamChatSnapshot {
  if (!previous || previous.project.sharedProjectId !== latest.project.sharedProjectId) return latest;

  const messagesById = new Map(latest.messages.map((message) => [message.id, message]));
  for (const message of previous.messages) if (!messagesById.has(message.id)) messagesById.set(message.id, message);
  const messages = reuseRows(previous.messages,
    [...messagesById.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).slice(-200),
    (message) => message.id);
  const nextBefore = latest.nextBefore ?? previous.nextBefore;
  const hasMore = previous.hasMore || latest.hasMore;
  const project = reuseObject(previous.project, latest.project);
  const members = reuseRows(previous.members, latest.members, (member) => member.accountId);
  const agents = reuseRows(previous.agents, latest.agents, (agent) => agent.id);
  const transport = reuseObject(previous.transport, latest.transport);
  const groupView = reconcileGroupView(previous.groupView, latest.groupView);

  if (messages === previous.messages && hasMore === previous.hasMore && nextBefore === previous.nextBefore
    && project === previous.project && members === previous.members && agents === previous.agents
    && transport === previous.transport && groupView === previous.groupView) return previous;

  return { ...latest, project, messages, hasMore, nextBefore, members, agents, transport, groupView };
}

/** A no-op structure refresh should not invalidate the session view's context consumers. */
export function retainTeamStructureSnapshot(previous: TeamStructureSnapshot | null, latest: TeamStructureSnapshot): TeamStructureSnapshot {
  return previous && sameData(previous, latest) ? previous : latest;
}
