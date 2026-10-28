import type {
  Approval, GroupDelivery, GroupMember, GroupMessage, GroupRequest, GroupSnapshot, Message, Provider, RunChangedFile, Session, SessionRun, Task, TaskStatus,
} from '@mingle/contracts';

/**
 * Pure projection of the LATEST human request in a group. Everything is scoped to that request's recorded
 * deliveries, assignments, runs and tasks; prose is never parsed to infer outcomes, tests or integration.
 */
export interface GroupResultInput {
  snapshot: GroupSnapshot; sessions: readonly Session[]; messages: readonly Message[]; runs: readonly SessionRun[]; tasks: readonly Task[]; approvals?: readonly Approval[];
}

export type GroupResultStatus =
  | 'pending' | 'in-progress' | 'paused' | 'failed' | 'stopped' | 'blocked' | 'follow-up' | 'finalizing' | 'unknown' | 'review' | 'accepted' | 'responded';
export type DeliveryKind = NonNullable<GroupDelivery['kind']>;

export interface ResultTask {
  id: string; title: string; status: TaskStatus | null; label: string;
  acceptedBy?: 'orchestrator'; verificationSummary?: string;
}
export interface ResultReport {
  key: string; taskTitles: string[];
  /** Native final assistant text; null when none is recorded. */
  text: string | null; note: string | null;
}
export interface ResultChangedPath { path: string; status: RunChangedFile['status']; runs: number }
export interface ResultWorkspace {
  location: string | null; isolated: boolean | null; scope: string[]; paths: ResultChangedPath[]; notes: string[];
}
export interface ResultAgent {
  memberId: string; sessionId: string; handle: string; provider: Provider | null; removed: boolean; isLead: boolean;
  /** Worst-case turn state for this request, or null when no turn is recorded. Finished is a turn outcome only. */
  state: string | null;
  tasks: ResultTask[]; reports: ResultReport[]; problems: string[]; workspace: ResultWorkspace;
}
export type LeadReportState = 'report' | 'pending' | 'missing';
export interface ResultLead {
  memberId: string; sessionId: string; handle: string; provider: Provider | null; removed: boolean;
  state: string | null; report: ResultReport; reportState: LeadReportState;
}
export interface GroupResultModel {
  status: GroupResultStatus; title: string; summary: string;
  /** Pause reason or similar one-line context shown beside the summary. */
  detail: string | null;
  requestExcerpt: string; facts: string[];
  lead: ResultLead | null; agents: ResultAgent[];
  changedPathCount: number; workspaceCount: number; active: boolean; caveat: string;
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog', ready: 'Ready', running: 'Running', blocked: 'Blocked', review: 'Needs review', done: 'Accepted',
};
export const CHANGE_STATUS_LABEL: Record<RunChangedFile['status'], string> = { A: 'Added', M: 'Modified', D: 'Deleted', T: 'Type changed' };
const CAVEAT = 'Task status is recorded by Mingle; checks and integration are described in the agent reports.';
const NO_REPORT = 'No final report recorded.';

const time = (iso: string | null | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const isActive = (delivery: GroupDelivery): boolean => delivery.status === 'queued' || delivery.status === 'running';
const unique = <T,>(items: readonly T[]): T[] => [...new Set(items)];

/** Short plain-text preview for line-clamped display; formatting characters only, no interpretation. */
export function reportPreview(text: string, max = 420): string {
  const readable = text.replace(/!?\[([^\]]*)\]\((?:\\.|[^()\\]|\([^)]*\))*\)/g, '$1');
  const plain = (line: string) => line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').replace(/[*`]/g, '').trim();
  const lines = readable.split(/\r?\n/).filter((line) => {
    const value = plain(line);
    if (!value || /^(?:(?:work|agent|final|completion)\s+)?(?:summary|report)\s*:?$/i.test(value)) return false;
    if (/^status\s*:\s*(?:review|in review|needs review|awaiting review)[.!]?$/i.test(value)) return false;
    if (/^(?:task|assignment)(?:\s+id)?\s*[:#-]/i.test(value) && /\b(?:tsk|asg)_[\w-]+\b/.test(value)) {
      const remainder = value.replace(/\b(?:task|assignment)(?:\s+id)?\s*[:#-]?/gi, '').replace(/\b(?:tsk|asg)_[\w-]+\b/g, '').replace(/[\s_'"()[\]{}:,.;|/\\—–-]/g, '');
      if (!remainder) return false;
    }
    const scope = /^scope\s*:\s*(.*)$/i.exec(value);
    if (scope) {
      const paths = scope[1]!.replace(/["'[\]]/g, '').split(/\s*[,;|·]\s*/).filter(Boolean);
      if (!paths.length || paths.every((path) => !/\s/.test(path))) return false;
    }
    return true;
  });
  const changes = lines.findIndex((line) => /^(?:changes(?: made)?|what (?:changed|was changed)|implementation(?: summary)?|updates)\s*:?$/i.test(plain(line)));
  // Metadata-only preambles are gone; retain any earlier outcome or blocker, including a heading.
  const focused = changes === 0 ? lines.slice(1) : lines;
  const selected = focused.length ? focused.join('\n') : readable;
  const flat = selected.replace(/```[^\n]*\n?/g, ' ').replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s{0,3}>\s?/gm, '').replace(/[*`]+/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

function latestUserMessage(snapshot: GroupSnapshot): GroupMessage | null {
  let best: GroupMessage | null = null;
  for (const message of snapshot.messages) {
    if (message.kind !== 'user' || message.groupId !== snapshot.group.id) continue;
    if (!best || message.seq > best.seq || (message.seq === best.seq && time(message.createdAt) > time(best.createdAt))) best = message;
  }
  return best;
}

function requestFor(snapshot: GroupSnapshot, message: GroupMessage): GroupRequest | null {
  let best: GroupRequest | null = null;
  for (const request of snapshot.requests) {
    if (request.groupId !== snapshot.group.id || request.messageId !== message.id) continue;
    if (!best || time(request.createdAt) >= time(best.createdAt)) best = request;
  }
  return best;
}

/** Last ordinary assistant message of a completed run owned by the delivery's participant; nothing else qualifies. */
function nativeFinal(delivery: GroupDelivery, sessionId: string, runById: ReadonlyMap<string, SessionRun>, messages: readonly Message[]): string | null {
  if (delivery.status !== 'completed' || !delivery.runId) return null;
  const run = runById.get(delivery.runId);
  if (!run || run.status !== 'completed' || run.sessionId !== sessionId) return null;
  let best: { at: number; index: number; content: string } | null = null;
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || message.kind != null || message.runId !== run.id || message.sessionId !== sessionId) return;
    if (!message.content.trim()) return;
    const at = time(message.createdAt);
    if (!best || at > best.at || (at === best.at && index > best.index)) best = { at, index, content: message.content };
  });
  return (best as { content: string } | null)?.content ?? null;
}

function newestFirst(a: GroupDelivery, b: GroupDelivery): number {
  return time(b.updatedAt) - time(a.updatedAt) || b.hop - a.hop || time(b.createdAt) - time(a.createdAt);
}

function turnState(deliveries: readonly GroupDelivery[]): string | null {
  const has = (status: GroupDelivery['status']) => deliveries.some((delivery) => delivery.status === status);
  if (has('running')) return 'Working';
  if (has('queued')) return 'Queued';
  if (has('failed')) return 'Turn failed';
  if (has('interrupted')) return 'Interrupted';
  if (has('cancelled')) return 'Cancelled';
  if (has('completed')) return 'Turn finished';
  return null;
}

function boundedError(error: string): string {
  const flat = error.replace(/\s+/g, ' ').trim();
  return flat.length > 240 ? `${flat.slice(0, 240).trimEnd()}…` : flat;
}

function recoveredAttemptIds(
  snapshot: GroupSnapshot,
  request: GroupRequest,
  deliveries: readonly GroupDelivery[],
  memberById: ReadonlyMap<string, GroupMember>,
  runById: ReadonlyMap<string, SessionRun>,
): Set<string> {
  const deliveryById = new Map<string, GroupDelivery>();
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const delivery of snapshot.deliveries) {
    if (seenIds.has(delivery.id)) duplicateIds.add(delivery.id);
    else {
      seenIds.add(delivery.id);
      if (delivery.groupId === snapshot.group.id) deliveryById.set(delivery.id, delivery);
    }
  }

  const successorBySource = new Map<string, string>();
  for (const source of deliveries) {
    const successorId = source.recoveredByDeliveryId;
    const successor = successorId ? deliveryById.get(successorId) : undefined;
    if ((source.status !== 'failed' && source.status !== 'interrupted') || !successorId || duplicateIds.has(source.id) || duplicateIds.has(successorId)
      || source.groupId !== snapshot.group.id || source.requestId !== request.id || !successor
      || successor.id === source.id || successor.groupId !== source.groupId || successor.requestId !== source.requestId
      || !memberById.has(source.memberId) || !memberById.has(successor.memberId)) continue;

    // A completed replacement is only a known outcome when its own, correctly-owned run is present.
    if (successor.status === 'completed') {
      const run = successor.runId ? runById.get(successor.runId) : undefined;
      const member = memberById.get(successor.memberId);
      if (!run || run.status !== 'completed' || !member || run.sessionId !== member.sessionId) continue;
    }
    successorBySource.set(source.id, successor.id);
  }

  const recovered = new Set<string>();
  for (const sourceId of successorBySource.keys()) {
    const visited = new Set<string>();
    let current = sourceId;
    let cyclic = false;
    while (successorBySource.has(current)) {
      if (visited.has(current)) { cyclic = true; break; }
      visited.add(current);
      current = successorBySource.get(current)!;
    }
    if (!cyclic) recovered.add(sourceId);
  }
  return recovered;
}

/** Returns null when the group has no human request yet, so nothing earlier can be mistaken for a result. */
export function buildGroupResultModel({ snapshot, sessions, messages, runs, tasks, approvals = [] }: GroupResultInput): GroupResultModel | null {
  const { group } = snapshot;
  const message = latestUserMessage(snapshot);
  if (!message) return null;
  const requestExcerpt = reportPreview(message.content, 180);
  const request = requestFor(snapshot, message);
  if (!request) {
    return {
      status: 'pending', title: 'Waiting to start', summary: 'This request has no recorded turns yet.', detail: null, requestExcerpt,
      facts: [], lead: null, agents: [], changedPathCount: 0, workspaceCount: 0, active: false, caveat: CAVEAT,
    };
  }

  const memberById = new Map(snapshot.members.map((member) => [member.id, member]));
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const runById = new Map(runs.map((run) => [run.id, run]));
  const deliveries = snapshot.deliveries.filter((delivery) => delivery.requestId === request.id && delivery.groupId === group.id);
  const recoveredDeliveries = recoveredAttemptIds(snapshot, request, deliveries, memberById, runById);
  const outcomeDeliveries = deliveries.filter((delivery) => !recoveredDeliveries.has(delivery.id));
  const assignments = snapshot.assignments.filter((assignment) => assignment.requestId === request.id && assignment.groupId === group.id);
  const assignedDeliveryIds = new Set(assignments.map((assignment) => assignment.deliveryId));
  const kindOf = (delivery: GroupDelivery): DeliveryKind =>
    delivery.kind ?? (assignedDeliveryIds.has(delivery.id) ? 'assignment' : delivery.messageId === request.messageId ? 'request' : 'message');

  const taskById = new Map<string, Task>();
  for (const task of tasks) if (task.projectId === group.projectId) taskById.set(task.id, task);
  const taskFor = (taskId: string): ResultTask => {
    const task = taskById.get(taskId);
    const acceptance = assignments.find((assignment) => assignment.taskId === taskId && assignment.acceptedBy === 'orchestrator');
    const status = task?.status ?? null;
    const acceptedBy = acceptance?.acceptedBy;
    return task
      ? { id: task.id, title: task.title, status, label: acceptedBy ? 'Accepted by orchestrator' : task.status === 'review' ? 'Needs your review' : TASK_STATUS_LABEL[task.status],
          ...(acceptedBy ? { acceptedBy } : {}), ...(acceptance?.verificationSummary ? { verificationSummary: acceptance.verificationSummary } : {}) }
      : { id: taskId, title: 'Task record unavailable', status: null, label: 'Unknown',
          ...(acceptedBy ? { acceptedBy } : {}), ...(acceptance?.verificationSummary ? { verificationSummary: acceptance.verificationSummary } : {}) };
  };
  const allTasks = unique(assignments.map((assignment) => assignment.taskId)).map(taskFor);

  const linkedRuns = unique(deliveries.flatMap((delivery) => (delivery.runId ? [delivery.runId] : [])))
    .flatMap((id) => runById.get(id) ?? [])
    .filter((run) => deliveries.some((delivery) => delivery.runId === run.id && memberById.get(delivery.memberId)?.sessionId === run.sessionId));
  const outcomeRuns = unique(outcomeDeliveries.flatMap((delivery) => (delivery.runId ? [delivery.runId] : [])))
    .flatMap((id) => runById.get(id) ?? [])
    .filter((run) => outcomeDeliveries.some((delivery) => delivery.runId === run.id && memberById.get(delivery.memberId)?.sessionId === run.sessionId));
  const activeDeliveries = outcomeDeliveries.filter(isActive);
  const runningRuns = outcomeRuns.filter((run) => run.status === 'running');
  const activeTurns = Math.max(activeDeliveries.length, runningRuns.length);
  const active = activeTurns > 0;
  const queuedTurns = outcomeDeliveries.filter((delivery) => delivery.status === 'queued').length;
  const awaitingApproval = activeDeliveries.some((delivery) => delivery.status === 'running'
    && approvals.some((approval) => approval.status === 'pending' && approval.sessionId === memberById.get(delivery.memberId)?.sessionId));
  const runningDeliveries = activeDeliveries.filter((delivery) => delivery.status === 'running');
  const queuedDeliveries = activeDeliveries.filter((delivery) => delivery.status === 'queued');
  const runningDeliveryIds = new Set(runningDeliveries.map((delivery) => delivery.id));
  const queuedDeliveryIds = new Set(queuedDeliveries.map((delivery) => delivery.id));
  const runningTaskCount = unique(assignments.filter((assignment) => runningDeliveryIds.has(assignment.deliveryId)).map((assignment) => assignment.taskId)).length;
  const queuedTaskCount = unique(assignments.filter((assignment) => queuedDeliveryIds.has(assignment.deliveryId)).map((assignment) => assignment.taskId)).length;
  const handlesFor = (rows: typeof activeDeliveries) => unique(rows.flatMap((delivery) => {
    const member = memberById.get(delivery.memberId);
    return member ? [member.handle] : [];
  }));

  const plannerId = request.plannerMemberId;
  const participantIds = new Set<string>([plannerId]);
  for (const delivery of deliveries) participantIds.add(delivery.memberId);
  for (const assignment of assignments) { participantIds.add(assignment.fromMemberId); participantIds.add(assignment.toMemberId); }

  const workspaceKeys = new Set<string>();
  const workspaces = new Set<string>();
  const anyFailedRun = outcomeRuns.some((run) => run.status === 'failed');
  const anyInterruptedRun = outcomeRuns.some((run) => run.status === 'interrupted');

  const reportFor = (key: string, delivery: GroupDelivery, member: GroupMember, taskTitles: string[]): ResultReport => {
    if (isActive(delivery)) return { key, taskTitles, text: null, note: 'Report not available yet; the turn is still in progress.' };
    const text = nativeFinal(delivery, member.sessionId, runById, messages);
    return { key, taskTitles, text, note: text === null ? NO_REPORT : null };
  };

  const buildAgent = (member: GroupMember): ResultAgent => {
    const session = sessionById.get(member.sessionId);
    const isLead = member.id === plannerId;
    const own = deliveries.filter((delivery) => delivery.memberId === member.id);
    const toMe = assignments.filter((assignment) => assignment.toMemberId === member.id);
    const memberTasks = unique(toMe.map((assignment) => assignment.taskId)).map(taskFor);

    const reports: ResultReport[] = [];
    const assignmentDeliveries = own.filter((delivery) => kindOf(delivery) === 'assignment').sort((a, b) => time(a.createdAt) - time(b.createdAt));
    for (const delivery of assignmentDeliveries) {
      const titles = unique(assignments.filter((assignment) => assignment.deliveryId === delivery.id).map((assignment) => taskFor(assignment.taskId).title));
      reports.push(reportFor(`a:${delivery.id}`, delivery, member, titles));
    }
    if (!isLead && !assignmentDeliveries.length) {
      const latestRequest = own.filter((delivery) => kindOf(delivery) === 'request').sort(newestFirst)[0];
      if (latestRequest) reports.push(reportFor(`r:${latestRequest.id}`, latestRequest, member, []));
      else {
        const latestReply = own.filter((delivery) => kindOf(delivery) === 'message').sort(newestFirst)[0];
        if (latestReply) reports.push(reportFor(`m:${latestReply.id}`, latestReply, member, []));
      }
    }
    // Only completed reports and honest gaps are listed; superseded failures are not repeated here.
    const problems: string[] = [];
    for (const delivery of own) {
      if (delivery.status === 'failed') problems.push(delivery.error ? `Turn failed: ${boundedError(delivery.error)}` : 'Turn failed.');
      else if (delivery.status === 'interrupted') problems.push('Turn interrupted before finishing.');
      else if (delivery.status === 'cancelled') problems.push('Turn cancelled before finishing.');
    }
    const ownRunIds = unique(own.flatMap((delivery) => (delivery.runId ? [delivery.runId] : [])));
    const ownRunIdSet = new Set(ownRunIds);
    const ownRuns = linkedRuns.filter((run) => ownRunIdSet.has(run.id) && run.sessionId === member.sessionId);
    if (!own.some((delivery) => delivery.status === 'failed') && ownRuns.some((run) => run.status === 'failed')) problems.push('A run failed.');
    if (!own.some((delivery) => delivery.status === 'interrupted' || delivery.status === 'cancelled') && ownRuns.some((run) => run.status === 'interrupted')) problems.push('A run was interrupted.');

    const paths = new Map<string, ResultChangedPath>();
    const notes: string[] = [];
    let unavailable = 0;
    let unrecorded = 0;
    let truncated = 0;
    const missingRuns = ownRunIds.length - ownRuns.length;
    for (const run of [...ownRuns].sort((a, b) => time(a.startedAt) - time(b.startedAt))) {
      const changes = run.changes;
      if (run.status === 'running') continue;
      if (!changes) { unrecorded++; continue; }
      if (changes.status !== 'available') { unavailable++; continue; }
      if (changes.truncated) truncated++;
      for (const notice of changes.notices) if (notice && !notes.includes(notice)) notes.push(notice);
      for (const file of changes.files) {
        const prior = paths.get(file.path);
        paths.set(file.path, { path: file.path, status: file.status, runs: (prior?.runs ?? 0) + 1 });
      }
    }
    if (truncated) notes.unshift(`${plural(truncated, 'run')} had a truncated file list; more paths may have changed.`);
    if (unavailable) notes.unshift(`Change summary unavailable for ${plural(unavailable, 'run')}.`);
    if (unrecorded) notes.unshift(`No change summary recorded for ${plural(unrecorded, 'run')}.`);
    if (missingRuns > 0) notes.unshift(`${plural(missingRuns, 'run record')} unavailable.`);
    const changed = [...paths.values()].sort((a, b) => a.path.localeCompare(b.path));
    const location = session?.worktreePath ?? null;
    if (changed.length) {
      workspaces.add(location ?? member.id);
      for (const entry of changed) workspaceKeys.add(`${location ?? member.id}\u0000${entry.path}`);
    }
    return {
      memberId: member.id, sessionId: member.sessionId, handle: member.handle, provider: session?.provider ?? null, removed: Boolean(member.removedAt), isLead,
      state: turnState(own), tasks: memberTasks, reports, problems: unique(problems),
      workspace: { location, isolated: session ? session.isolated : null, scope: unique(toMe.flatMap((assignment) => assignment.scope)), paths: changed, notes },
    };
  };

  const ordered = snapshot.members.filter((member) => participantIds.has(member.id));
  const built = ordered.map(buildAgent);
  // Every participant keeps a workspace row; the lead's native result is highlighted separately.
  const agents = built;

  let lead: ResultLead | null = null;
  const plannerMember = memberById.get(plannerId);
  if (plannerMember) {
    const plannerDeliveries = deliveries.filter((delivery) => delivery.memberId === plannerId);
    const results = plannerDeliveries.filter((delivery) => kindOf(delivery) === 'result').sort(newestFirst);
    const requests = plannerDeliveries.filter((delivery) => kindOf(delivery) === 'request').sort(newestFirst);
    let report: ResultReport = { key: 'lead', taskTitles: [], text: null, note: NO_REPORT };
    let reportState: LeadReportState = 'missing';
    const finish = (delivery: GroupDelivery) => {
      report = reportFor('lead', delivery, plannerMember, []);
      reportState = report.text !== null ? 'report' : isActive(delivery) ? 'pending' : 'missing';
    };
    if (results.length) {
      const pending = results.find(isActive);
      const done = results.find((delivery) => delivery.status === 'completed');
      if (pending) { report = { key: 'lead', taskTitles: [], text: null, note: 'Lead report in progress.' }; reportState = 'pending'; }
      else if (done) finish(done);
    } else if (assignments.length) {
      // The first answer predates the assignments; it is not the final report.
      const waiting = request.status !== 'completed' || active;
      report = { key: 'lead', taskTitles: [], text: null, note: waiting ? 'Lead report not available yet.' : 'No lead result report recorded.' };
      reportState = waiting ? 'pending' : 'missing';
    } else if (requests.length) {
      const target = requests.find(isActive) ?? requests.find((delivery) => delivery.status === 'completed');
      if (target) finish(target);
    } else {
      report = { key: 'lead', taskTitles: [], text: null, note: 'No lead turn recorded for this request.' };
    }
    lead = {
      memberId: plannerMember.id, sessionId: plannerMember.sessionId, handle: plannerMember.handle,
      provider: sessionById.get(plannerMember.sessionId)?.provider ?? null, removed: Boolean(plannerMember.removedAt),
      state: turnState(plannerDeliveries), report, reportState,
    };
  }

  const count = (status: TaskStatus) => allTasks.filter((task) => task.acceptedBy === 'orchestrator'
    ? status === 'done' : task.status === status).length;
  const blocked = count('blocked');
  const unfinished = count('backlog') + count('ready') + count('running');
  const inReview = count('review');
  const missingTasks = allTasks.filter((task) => task.status === null).length;
  const failed = outcomeDeliveries.some((delivery) => delivery.status === 'failed') || anyFailedRun;
  const stopped = outcomeDeliveries.some((delivery) => delivery.status === 'interrupted' || delivery.status === 'cancelled') || anyInterruptedRun;
  const paused = group.paused || request.status === 'paused';
  const pauseReason = group.pauseReason?.trim() || null;

  let status: GroupResultStatus;
  let title: string;
  let summary: string;
  let detail: string | null = null;
  if (paused && (request.status !== 'completed' || active)) {
    status = 'paused'; title = 'Paused';
    detail = pauseReason ? `Reason: ${pauseReason}` : 'No pause reason recorded.';
    const parts = [
      runningRuns.length || outcomeDeliveries.some((delivery) => delivery.status === 'running') ? `${plural(Math.max(runningRuns.length, outcomeDeliveries.filter((delivery) => delivery.status === 'running').length), 'turn')} still running` : null,
      queuedTurns ? `${plural(queuedTurns, 'queued turn')} held` : null,
    ].filter(Boolean);
    summary = parts.length ? `No new work starts while paused; ${parts.join(', ')}.` : 'No new work starts while paused. Results may be incomplete.';
  } else if (active) {
    status = 'in-progress';
    if (awaitingApproval) {
      title = 'Waiting for approval'; summary = 'Waiting for the team lead\'s approval.';
    } else {
      title = 'In progress';
      const work = runningDeliveries.length ? (() => {
        const handles = handlesFor(runningDeliveries);
        const count = runningTaskCount || runningDeliveries.length;
        const unit = runningTaskCount ? 'task' : 'turn';
        const subject = handles.length ? handles.join(', ') : 'The team';
        return `${subject} ${handles.length > 1 ? 'are' : 'is'} working on ${plural(count, unit)}.`;
      })() : '';
      const queued = queuedDeliveries.length ? (() => {
        const handles = handlesFor(queuedDeliveries);
        const count = queuedTaskCount || queuedDeliveries.length;
        const unit = queuedTaskCount ? 'task' : 'turn';
        const subject = handles.length ? handles.join(', ') : 'The team';
        return `${subject} ${handles.length > 1 ? 'have' : 'has'} ${plural(count, unit)} queued.`;
      })() : '';
      summary = [work, queued].filter(Boolean).join(' ') || `${plural(activeTurns, 'turn')} still running.`;
    }
  } else if (failed) {
    status = 'failed'; title = 'A turn failed';
    summary = 'A request turn failed. See the agent details for the recorded error.';
  } else if (stopped) {
    status = 'stopped'; title = 'Stopped before finishing';
    summary = 'A request turn was interrupted or cancelled. Task statuses and reports are shown below.';
  } else if (request.status === 'active') {
    status = 'finalizing'; title = 'Finalizing request';
    summary = 'Wrapping up — the agents have finished; waiting for the team lead\'s orchestrator to close the request.';
  } else if (blocked) {
    status = 'blocked'; title = 'Blocked';
    summary = `${plural(blocked, 'task')} reported as blocked.`;
  } else if (unfinished) {
    status = 'follow-up'; title = 'Follow-up needed';
    summary = `${plural(unfinished, 'assigned task')} still ${unfinished === 1 ? 'needs' : 'need'} follow-up.`;
  } else if (missingTasks || (!deliveries.length && request.status === 'completed')) {
    status = 'unknown'; title = 'Outcome unavailable';
    summary = missingTasks ? 'Some assigned task records are unavailable, so their state is unknown.' : 'No turns are recorded for this completed request.';
  } else if (!deliveries.length) {
    status = 'pending'; title = 'Waiting to start'; summary = 'This request has no recorded turns yet.';
  } else {
    if (allTasks.length && allTasks.every((task) => task.acceptedBy === 'orchestrator')) {
      status = 'accepted'; title = 'Tasks accepted'; summary = 'The orchestrator accepted all assigned tasks after verification.';
    } else if (allTasks.length && allTasks.every((task) => task.status === 'done')) {
      status = 'accepted'; title = 'Tasks accepted'; summary = 'All assigned tasks are marked done.';
    } else if (allTasks.length) {
      status = 'review'; title = 'Ready for your review';
      const reviewCount = allTasks.filter((task) => task.status === 'review' && task.acceptedBy !== 'orchestrator').length;
      summary = reviewCount ? `${plural(reviewCount, 'task')} ${reviewCount === 1 ? 'needs' : 'need'} your review.` : 'Some assigned tasks are not accepted yet.';
    } else {
      status = 'responded'; title = 'Team finished responding'; summary = 'No tasks were assigned to this request.';
    }
  }
  if (paused && request.status === 'completed' && !detail) detail = pauseReason ? `Group is paused · ${pauseReason}` : 'Group is paused.';

  const openTaskCount = allTasks.filter((task) => task.acceptedBy !== 'orchestrator' && task.status !== null && task.status !== 'done').length;
  const facts = [
    agents.length || lead ? plural(unique([...agents.map((agent) => agent.memberId), ...(lead ? [lead.memberId] : [])]).length, 'agent') : null,
    allTasks.length ? plural(allTasks.length, 'task') : null,
    openTaskCount ? `${plural(openTaskCount, 'task')} still open` : null,
    recoveredDeliveries.size ? `${plural(recoveredDeliveries.size, 'recovery attempt')}` : null,
    inReview ? `${inReview} need review` : null,
    count('done') ? `${count('done')} accepted` : null,
  ].filter((fact): fact is string => Boolean(fact));

  return {
    status, title, summary, detail, requestExcerpt, facts, lead, agents,
    changedPathCount: workspaceKeys.size, workspaceCount: workspaces.size, active, caveat: CAVEAT,
  };
}
