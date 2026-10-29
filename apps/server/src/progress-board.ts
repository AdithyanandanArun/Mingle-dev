import { ProgressBoardSnapshotSchema, type GroupMemberHealth, type GroupSnapshot, type ProgressBoardAssignmentHandoff, type ProgressBoardMember, type ProgressBoardSnapshot, type Task } from '@mingle/contracts';
import { teamAgentBranch } from './repository/team-branch.ts';
import { git } from './git.ts';
import type { Store } from './store.ts';
import { redactSecrets } from './util.ts';

const GIT_CACHE_MS = 5_000;
const GIT_TIMEOUT_MS = 2_000;
const MAX_CACHE_ITEMS = 512;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const cache = new Map<string, { expiresAt: number; value: unknown }>();

type Commit = NonNullable<ProgressBoardMember['branch']>['lastCommit'];
type ReviewBranch = {
  branch: string | null; commit_sha: string | null; review_ref: string | null;
  fetch_failure: string | null; push_failure: string | null; merged_at: string | null; accepted_at: string | null;
};
type AssignmentHandoff = { fromMemberId: string; toMemberId: string; at: string };

function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
  const prior = cache.get(key);
  if (prior && prior.expiresAt > Date.now()) return Promise.resolve(prior.value as T);
  return read().catch(() => null as T).then((value) => {
    cache.delete(key);
    cache.set(key, { expiresAt: Date.now() + GIT_CACHE_MS, value });
    while (cache.size > MAX_CACHE_ITEMS) cache.delete(cache.keys().next().value!);
    return value;
  });
}

function safeBranch(value: unknown): value is string {
  if (typeof value !== 'string' || !SAFE_BRANCH.test(value) || value.includes('..') || value.includes('//')
    || value.includes('@{') || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..' && !part.endsWith('.lock'));
}

function publicText(value: string, max = 200): string {
  return redactSecrets(value)
    .replace(/\b(?:https?|ssh|git):\/\/[^\s'"<>]+/gi, '[remote]')
    .replace(/\b[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:[^\s'"<>]+/g, '[remote]')
    .replace(/(?:^|\s)(?:[A-Za-z]:\\|\/)[^\s'"<>]*/g, ' [path]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

async function commitAt(cwd: string, ref: string): Promise<Commit> {
  if (!ref || (ref !== 'HEAD' && !FULL_SHA.test(ref) && !ref.startsWith('refs/'))) return null;
  return cached(`commit\0${cwd}\0${ref}`, async () => {
    const result = await git(cwd, ['log', '-1', '--format=%H%x00%s%x00%cI', ref], { allowFailure: true, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: 4096 });
    const [sha, subject, at] = result.stdout.trim().split('\0');
    if (result.code !== 0 || !sha || !FULL_SHA.test(sha) || !subject || !validDate(at)) return null;
    return { sha, subject: publicText(subject), at };
  });
}

async function branchAt(cwd: string): Promise<string | null> {
  return cached(`branch\0${cwd}`, async () => {
    const result = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: 1024 });
    const branch = result.code === 0 ? result.stdout.trim() : '';
    return safeBranch(branch) ? branch : null;
  });
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return cached(`ref\0${cwd}\0${ref}`, async () => {
    const result = await git(cwd, ['show-ref', '--verify', '--quiet', ref], { allowFailure: true, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: 1024 });
    return result.code === 0;
  });
}

async function isAncestor(cwd: string, ancestor: string, head: string): Promise<boolean | null> {
  if (!ancestor || !head) return null;
  return cached(`ancestor\0${cwd}\0${ancestor}\0${head}`, async () => {
    const result = await git(cwd, ['merge-base', '--is-ancestor', ancestor, head], { allowFailure: true, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: 1024 }).catch(() => null);
    if (!result || result.code < 0 || result.code > 1) return null;
    return result.code === 0;
  });
}

function latestReviewRows(store: Store, group: GroupSnapshot): Map<string, ReviewBranch> {
  const deliveryIds = [...new Set(group.deliveries.slice(-300).map((delivery) => delivery.id))];
  if (!deliveryIds.length) return new Map();
  try {
    const rows = store.db.prepare(`SELECT delivery_id,branch,commit_sha,review_ref,fetch_failure,push_failure,merged_at,accepted_at
      FROM mingle_team_host_review_branches WHERE delivery_id IN (${deliveryIds.map(() => '?').join(',')})`)
      .all(...deliveryIds) as Array<ReviewBranch & { delivery_id: string }>;
    const reviewByDelivery = new Map(rows.map((row) => [row.delivery_id, row]));
    const result = new Map<string, ReviewBranch>();
    for (const member of group.members) {
      const memberDeliveries = group.deliveries.filter((delivery) => delivery.memberId === member.id)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const latest = memberDeliveries.map((delivery) => reviewByDelivery.get(delivery.id)).find(Boolean);
      if (latest) result.set(member.id, latest);
    }
    return result;
  } catch {
    // The host review table is created by team orchestration and is absent on local-only setups.
    return new Map();
  }
}

function cachedOwnerNames(store: Store, group: GroupSnapshot): Map<string, string> {
  try {
    const sessions = group.members.map((member) => member.sessionId);
    if (!sessions.length) return new Map();
    const proxyRows = store.db.prepare(`SELECT session_id,owner_account_id FROM mingle_team_proxy_sessions
      WHERE session_id IN (${sessions.map(() => '?').join(',')})`).all(...sessions) as Array<{ session_id: string; owner_account_id: string }>;
    if (!proxyRows.length) return new Map();
    const profileRow = store.db.prepare('SELECT snapshot_json FROM mingle_project_team_read_model WHERE local_project_id=?')
      .get(group.group.projectId) as { snapshot_json: string } | undefined;
    if (!profileRow) return new Map();
    const snapshot = JSON.parse(profileRow.snapshot_json) as { members?: Array<{ accountId?: unknown; displayName?: unknown }> };
    const names = new Map((snapshot.members ?? []).flatMap((member) => typeof member.accountId === 'string' && typeof member.displayName === 'string'
      ? [[member.accountId, member.displayName] as const] : []));
    return new Map(proxyRows.flatMap((row) => {
      const name = names.get(row.owner_account_id);
      return name ? [[row.session_id, publicText(name, 120)] as const] : [];
    }));
  } catch { return new Map(); }
}

function latestPush(store: Store, group: GroupSnapshot): ProgressBoardSnapshot['integration']['lastPush'] {
  try {
    const row = store.db.prepare(`SELECT type,payload,created_at FROM events
      WHERE project_id=? AND type IN ('group.integration.pushed','group.integration.push-failed')
        AND json_extract(payload,'$.groupId')=? ORDER BY id DESC LIMIT 1`)
      .get(group.group.projectId, group.group.id) as { type: string; payload: string; created_at: string } | undefined;
    if (!row || !validDate(row.created_at)) return null;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const sha = typeof payload.commitSha === 'string' && FULL_SHA.test(payload.commitSha) ? payload.commitSha : null;
    if (!sha) return null;
    const failure = row.type === 'group.integration.push-failed' && typeof payload.error === 'string'
      ? publicText(payload.error) : undefined;
    return { sha, at: row.created_at, ...(failure ? { failure } : {}) };
  } catch { return null; }
}

function latestAssignmentHandoff(store: Store, group: GroupSnapshot): AssignmentHandoff | null {
  const handoffs: AssignmentHandoff[] = [];
  try {
    const row = store.db.prepare(`SELECT payload,created_at FROM events
      WHERE project_id=? AND type='group.delivery.auto-fallback'
        AND json_extract(payload,'$.groupId')=? AND json_extract(payload,'$.assignmentId') IS NOT NULL
      ORDER BY id DESC LIMIT 1`).get(group.group.projectId, group.group.id) as { payload: string; created_at: string } | undefined;
    if (row && validDate(row.created_at)) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (typeof payload.fromMemberId === 'string' && typeof payload.toMemberId === 'string'
        && payload.fromMemberId !== payload.toMemberId) {
        handoffs.push({ fromMemberId: payload.fromMemberId, toMemberId: payload.toMemberId, at: row.created_at });
      }
    }
  } catch { /* The snapshot delivery linkage below remains available without an event row. */ }

  for (const source of group.deliveries) {
    if (!source.recoveredByDeliveryId) continue;
    const successor = group.deliveries.find((delivery) => delivery.id === source.recoveredByDeliveryId);
    const assignment = group.assignments.find((item) => item.deliveryId === source.recoveredByDeliveryId);
    if (!successor || !assignment || assignment.toMemberId !== successor.memberId || source.memberId === successor.memberId) continue;
    const at = validDate(successor.updatedAt) ? successor.updatedAt : source.updatedAt;
    if (validDate(at)) handoffs.push({ fromMemberId: source.memberId, toMemberId: successor.memberId, at });
  }
  return handoffs.sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0] ?? null;
}

function latestProgressStatus(store: Store, sessionId: string, runId: string | null): Record<string, unknown> | null {
  if (!runId) return null;
  try {
    const row = store.db.prepare(`SELECT payload FROM events WHERE session_id=? AND type='session.progress.status'
      AND json_extract(payload,'$.runId')=? ORDER BY id DESC LIMIT 1`).get(sessionId, runId) as { payload: string } | undefined;
    const status = row ? (JSON.parse(row.payload) as Record<string, unknown>).status : null;
    return status && typeof status === 'object' && !Array.isArray(status) ? status as Record<string, unknown> : null;
  } catch { return null; }
}

function activeStep(status: Record<string, unknown> | null, tasks: Task[], runId: string | null): ProgressBoardMember['step'] {
  if (typeof status?.step === 'string' && status.step.trim()) {
    const progress = status.progress && typeof status.progress === 'object' ? status.progress as Record<string, unknown> : null;
    const current = typeof progress?.current === 'number' && Number.isInteger(progress.current) ? progress.current : undefined;
    const total = typeof progress?.total === 'number' && Number.isInteger(progress.total) ? progress.total : undefined;
    return { label: publicText(status.step), ...(current ? { current } : {}), ...(total ? { total } : {}) };
  }
  if (!runId) return null;
  const plan = tasks.filter((task) => task.source?.kind === 'provider' && task.source.runId === runId && !task.source.missing)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const index = plan.findIndex((task) => task.source?.reportedStatus === 'in_progress' || task.status === 'running');
  if (index < 0) return null;
  return { label: publicText(plan[index]!.title), current: index + 1, total: plan.length };
}

function addBlocker(blockers: string[], value: unknown): void {
  if (typeof value !== 'string' || blockers.length >= 3) return;
  const text = publicText(value);
  if (text && !blockers.includes(text)) blockers.push(text);
}

async function branchInfo(input: {
  store: Store; sessionId: string; handle: string; worktreePath: string; savedBranch: string | null; isRemote: boolean;
  review: ReviewBranch | undefined; integrationPath: string; integrationHead: string | null;
}): Promise<ProgressBoardMember['branch']> {
  const { store, sessionId, handle, worktreePath, savedBranch, isRemote, review, integrationPath, integrationHead } = input;
  const branch = isRemote
    ? safeBranch(review?.branch) ? review.branch : teamAgentBranch(handle)
    : await branchAt(worktreePath) ?? (safeBranch(savedBranch) ? savedBranch : null);
  if (!branch) return null;

  const remoteRef = `refs/remotes/origin/${branch}`;
  const localRef = `refs/heads/${branch}`;
  let commit: Commit = null;
  let commitRef: string | null = null;
  if (isRemote) {
    if (await refExists(integrationPath, remoteRef)) { commitRef = remoteRef; commit = await commitAt(integrationPath, remoteRef); }
    if (!commit && review?.review_ref && review.review_ref.startsWith('refs/mingle/team/review/')) {
      commitRef = review.review_ref;
      commit = await commitAt(integrationPath, review.review_ref);
    }
    if (!commit && review?.commit_sha && FULL_SHA.test(review.commit_sha)) { commitRef = review.commit_sha; commit = await commitAt(integrationPath, review.commit_sha); }
  } else {
    if (await refExists(worktreePath, localRef)) { commitRef = localRef; commit = await commitAt(worktreePath, localRef); }
    else { commitRef = 'HEAD'; commit = await commitAt(worktreePath, 'HEAD'); }
  }

  let pushed: boolean | null = null;
  if (isRemote) {
    pushed = review?.push_failure ? false : commit ? true : null;
  } else if (await refExists(worktreePath, remoteRef)) pushed = true;

  let merged: boolean | null = review?.merged_at ? true : null;
  if (!merged && commitRef && integrationHead) {
    const ref = isRemote && commit?.sha ? commit.sha : isRemote ? commitRef : localRef;
    merged = await isAncestor(integrationPath, ref, integrationHead);
  }
  return { name: branch, lastCommit: commit, pushed, merged };
}

function pickTask(store: Store, group: GroupSnapshot, memberId: string, deliveries: GroupSnapshot['deliveries']): Task | undefined {
  const active = deliveries.filter((delivery) => delivery.memberId === memberId && (delivery.status === 'running' || delivery.status === 'queued'))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const activeAssignment = active.map((delivery) => group.assignments.find((assignment) => assignment.deliveryId === delivery.id)).find(Boolean);
  const assignment = activeAssignment ?? group.assignments.filter((item) => item.toMemberId === memberId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return assignment ? store.getTask(assignment.taskId) : undefined;
}

/** Build a bounded, read-only group snapshot for the live progress board. */
export async function buildProgressBoard(input: {
  store: Store; group: GroupSnapshot; memberHealth?: readonly GroupMemberHealth[]; now?: () => number;
}): Promise<ProgressBoardSnapshot> {
  const { store, group } = input;
  const now = input.now ?? Date.now;
  const sessions = new Map(group.members.flatMap((member) => {
    const session = store.getSession(member.sessionId);
    return session ? [[member.id, session] as const] : [];
  }));
  const proxyIds = new Set<string>();
  for (const member of group.members) {
    try {
      if (store.db.prepare('SELECT 1 FROM mingle_team_proxy_sessions WHERE session_id=?').get(member.sessionId)) proxyIds.add(member.id);
    } catch { /* Team proxy mapping is unavailable in local-only installations. */ }
  }
  const reviews = latestReviewRows(store, group);
  const anchor = sessions.get(group.members.find((member) => member.sessionId === group.group.anchorSessionId)?.id ?? '');
  const integrationPath = anchor?.worktreePath ?? store.getProject(group.group.projectId)?.path ?? '';
  const integrationBranch = integrationPath ? await branchAt(integrationPath) : null;
  const integrationHead = integrationPath ? await commitAt(integrationPath, 'HEAD') : null;
  const lastPush = latestPush(store, group);
  const healthByMemberId = new Map((input.memberHealth ?? []).map((health) => [health.memberId, health]));
  const assignmentHandoff = latestAssignmentHandoff(store, group);
  const tasks = store.listTasks(group.group.projectId);
  const runs = new Map(store.activeRuns().map((run) => [run.sessionId, run]));
  const ownerNames = cachedOwnerNames(store, group);

  const members = await Promise.all(group.members.filter((member) => !member.removedAt).map(async (member): Promise<ProgressBoardMember | null> => {
    const session = sessions.get(member.id);
    if (!session) return null;
    const deliveries = group.deliveries.filter((delivery) => delivery.memberId === member.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const liveDelivery = deliveries.find((delivery) => delivery.status === 'running' || delivery.status === 'queued');
    const runId = liveDelivery?.runId ?? runs.get(session.id)?.id ?? null;
    const approvals = store.pendingApprovals(session.id);
    const waitingQuestion = store.listSessionQuestions(session.id, 50).some((question) => question.status === 'pending');
    const failedDelivery = deliveries.find((delivery) => delivery.status === 'failed');
    const rawHealth = healthByMemberId.get(member.id);
    const health = rawHealth ? {
      state: rawHealth.state,
      ...(rawHealth.state === 'cooldown' && validDate(rawHealth.until) ? { until: rawHealth.until } : {}),
      ...(rawHealth.reason ? { reason: publicText(rawHealth.reason, 160) } : {}),
    } : null;
    const task = pickTask(store, group, member.id, group.deliveries);
    const isPaused = Boolean(group.group.paused || member.held || group.requests.some((request) => request.status === 'paused'
      && deliveries.some((delivery) => delivery.requestId === request.id && (delivery.status === 'queued' || delivery.status === 'running'))));
    const failed = Boolean(failedDelivery || session.status === 'error' || member.failure);
    const state: ProgressBoardMember['state'] = health?.state === 'stalled' ? 'stalled'
      : approvals.length ? 'waiting-approval'
      : waitingQuestion ? 'waiting-answer'
        : isPaused ? 'paused'
          : failed ? 'failed'
            : liveDelivery?.status === 'running' || session.status === 'running' || session.status === 'waiting' ? 'working' : 'idle';
    const blockers: string[] = [];
    if (health?.reason) addBlocker(blockers, health.reason);
    if (group.group.paused) addBlocker(blockers, group.group.pauseReason ?? 'The group is paused.');
    if (member.held) addBlocker(blockers, 'This agent is held.');
    if (approvals.length) addBlocker(blockers, `Approval required: ${publicText(approvals[0]!.tool, 80) || 'provider action'}.`);
    if (waitingQuestion) addBlocker(blockers, 'Waiting for an answer.');
    if (failedDelivery?.error) addBlocker(blockers, failedDelivery.error);
    if (!failedDelivery && session.error && session.status === 'error') addBlocker(blockers, session.error);
    if (!failedDelivery && member.failure?.message) addBlocker(blockers, member.failure.message);
    if (task?.status === 'blocked') addBlocker(blockers, 'Assigned task is blocked.');
    const review = reviews.get(member.id);
    if (review?.fetch_failure) addBlocker(blockers, review.fetch_failure);
    if (review?.push_failure) addBlocker(blockers, review.push_failure);

    const isRemote = proxyIds.has(member.id);
    const currentTask = task ? { id: task.id, title: publicText(task.title), status: task.status } : null;
    const progress = activeStep(latestProgressStatus(store, session.id, runId), tasks.filter((item) => item.sessionId === session.id), runId);
    const latestUpdatedAt = [group.group.updatedAt, session.updatedAt, ...deliveries.slice(0, 5).map((delivery) => delivery.updatedAt)]
      .filter(validDate).sort().at(-1) ?? new Date(now()).toISOString();
    const branch = await branchInfo({ store, sessionId: session.id, handle: member.handle, worktreePath: session.worktreePath,
      savedBranch: session.branch, isRemote, review, integrationPath, integrationHead: integrationHead?.sha ?? null });
    let memberHandoff: ProgressBoardAssignmentHandoff | undefined;
    if (assignmentHandoff?.fromMemberId === member.id) {
      const other = group.members.find((candidate) => candidate.id === assignmentHandoff.toMemberId);
      if (other) memberHandoff = { action: 'moved', handle: other.handle };
    } else if (assignmentHandoff?.toMemberId === member.id) {
      const other = group.members.find((candidate) => candidate.id === assignmentHandoff.fromMemberId);
      if (other) memberHandoff = { action: 'took-over', handle: other.handle };
    }
    return {
      memberId: member.id, handle: member.handle, role: member.role, provider: session.provider, model: session.model,
      device: isRemote ? ownerNames.get(session.id) || 'Remote owner' : 'this device',
      state, currentTask, step: progress, branch, blockers: blockers.slice(0, 3), health,
      ...(memberHandoff ? { assignmentHandoff: memberHandoff } : {}), updatedAt: latestUpdatedAt,
    };
  }));

  return ProgressBoardSnapshotSchema.parse({
    groupId: group.group.id,
    integration: { branch: integrationBranch, head: integrationHead, lastPush },
    members: members.filter((member): member is ProgressBoardMember => member !== null).slice(0, 64),
    updatedAt: new Date(now()).toISOString(),
  });
}
