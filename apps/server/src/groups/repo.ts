import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  AutonomyConfig, ConversationGroup, GroupAssignment, GroupDelivery, GroupMember, GroupMessage, GroupMode, GroupRequest,
  GroupInvocation, GroupMilestone, GroupRecoveryPolicy, GroupRecoveryState, ProviderFailure, RecoveryActionRequest, RecoveryActionResult,
} from '@mingle/contracts';
import { AttachmentRepo } from '../attachments/repo.ts';
import { newId as baseId, nowIso } from '../util.ts';

type Row = Record<string, unknown>;

export type DeliveryKind = 'request' | 'assignment' | 'message' | 'result';
export type DeliveryStatus = GroupDelivery['status'];
export const OPEN_DELIVERY: DeliveryStatus[] = ['queued', 'running'];
/** States that still await a model turn (running, waiting or retryable after a stop/failure). */
export const UNSETTLED_DELIVERY: DeliveryStatus[] = ['queued', 'running', 'failed', 'interrupted'];

export interface MemberRow extends GroupMember { held: boolean; lastReadSeq: number }
export interface DeliveryRow extends GroupDelivery { kind: DeliveryKind; assignmentId: string | null; taskId: string | null; attempts: number; retryable: boolean; startedAt: string | null }
export interface AssignmentRow extends GroupAssignment { fingerprint: string; notified: boolean }
export interface StallEvidenceRow {
  id: string; groupId: string; memberId: string | null; requestId: string | null; deliveryId: string | null; assignmentId: string | null;
  fingerprint: string; signalClass: string; consecutiveCount: number; reason: string; sourceRunId: string | null;
  sourceToolId: string | null; sourceTaskId: string | null; sourceArtifactId: string | null; createdAt: string; updatedAt: string;
}
export interface GroupRecoveryCheckpointRow {
  id: string; groupId: string; requestId: string | null; batchId: string | null; kind: string;
  state: 'pending' | 'acknowledged' | 'dismissed'; reason: string; payload: Record<string, unknown>;
  idempotencyKey: string; createdAt: string; updatedAt: string; acknowledgedAt: string | null;
}
export interface ArtifactRow {
  id: string; groupId: string; requestId: string; fromMemberId: string; toMemberId: string; taskId: string | null; path: string;
  commitId: string; blob: string; reference: string; handoffEventId: number | null; handoffMessageId: string | null; messageId: string; createdAt: string;
}
export interface InputRow { assignmentId: string; taskId: string; path: string; artifactId: string | null }
export interface ProviderCooldownRow { groupId: string; memberId: string; provider: string; reason: string; until: string; createdAt: string }

const newGroupId = (prefix: string) => `${prefix}_${baseId('msg').slice(4)}`;
export const groupId = () => newGroupId('grp');
export const memberId = () => newGroupId('mem');
export const messageId = () => newGroupId('gms');
export const requestId = () => newGroupId('req');
export const deliveryId = () => newGroupId('dlv');
export const recoveryCheckpointId = () => newGroupId('gcp');
export const assignmentId = () => newGroupId('asg');
export const artifactId = () => newGroupId('art');

const bool = (value: unknown) => value === 1;
const mapGroup = (r: Row): ConversationGroup => ({
  id: r.id as string, projectId: r.project_id as string, title: r.title as string, anchorSessionId: r.anchor_session_id as string,
  mode: r.mode as GroupMode, orchestratorMemberId: (r.orchestrator_member_id as string | null) ?? null, paused: bool(r.paused),
  pauseReason: (r.pause_reason as string | null) ?? null, maxParallel: r.max_parallel as number, maxTurns: r.max_turns as number,
  maxHops: r.max_hops as number, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  ...(r.autonomy_policy ? { autonomy: JSON.parse(r.autonomy_policy as string) as AutonomyConfig } : {}),
  ...(r.recovery_policy ? { recoveryPolicy: JSON.parse(r.recovery_policy as string) as GroupRecoveryPolicy } : {}),
  ...(r.recovery_state ? { recoveryState: JSON.parse(r.recovery_state as string) as GroupRecoveryState } : {}),
  coordinatorEpoch: Number(r.coordinator_epoch ?? 1),
  preferredCoordinatorMemberId: (r.preferred_coordinator_member_id as string | null) ?? null,
});
const mapMember = (r: Row): MemberRow => ({
  id: r.id as string, groupId: r.group_id as string, sessionId: r.session_id as string, handle: r.handle as string,
  role: r.role as GroupMember['role'], joinedAt: r.joined_at as string, removedAt: (r.removed_at as string | null) ?? null,
  held: bool(r.held), lastReadSeq: r.last_read_seq as number,
});
const mapMessage = (r: Row): GroupMessage => ({
  id: r.id as string, seq: r.seq as number, groupId: r.group_id as string, senderMemberId: (r.sender_member_id as string | null) ?? null,
  recipientMemberIds: JSON.parse(r.recipient_member_ids as string) as string[], kind: r.kind as GroupMessage['kind'], content: r.content as string,
  requestId: (r.request_id as string | null) ?? null, replyToId: (r.reply_to_id as string | null) ?? null,
  sourceMessageId: (r.source_message_id as string | null) ?? null, sourceRunId: (r.source_run_id as string | null) ?? null, createdAt: r.created_at as string,
  ...(r.invocation ? { invocation: JSON.parse(r.invocation as string) as GroupMessage['invocation'] } : {}),
  ...(r.context_refs_json ? { contextRefs: JSON.parse(r.context_refs_json as string) as GroupMessage['contextRefs'] } : {}),
});
const mapRequest = (r: Row): GroupRequest => ({
  id: r.id as string, groupId: r.group_id as string, messageId: r.message_id as string, plannerMemberId: r.planner_member_id as string,
  status: r.status as GroupRequest['status'], turnsUsed: r.turns_used as number, createdAt: r.created_at as string, intent: (r.intent as GroupRequest['intent'] | undefined) ?? 'normal',
  ...(typeof r.execution_plan_id === 'string' ? { executionPlanId: r.execution_plan_id } : {}),
  ...(typeof r.auto_turn_limit === 'number' ? { autoTurnLimit: r.auto_turn_limit } : {}),
  ...(typeof r.auto_max_hops === 'number' ? { autoMaxHops: r.auto_max_hops } : {}),
});
const mapDelivery = (r: Row): DeliveryRow => ({
  id: r.id as string, groupId: r.group_id as string, requestId: r.request_id as string, messageId: r.message_id as string, memberId: r.member_id as string,
  status: r.status as DeliveryStatus, runId: (r.run_id as string | null) ?? null, hop: r.hop as number, error: (r.error as string | null) ?? null,
  createdAt: r.created_at as string, updatedAt: r.updated_at as string, kind: r.kind as DeliveryKind,
  assignmentId: (r.assignment_id as string | null) ?? null, taskId: (r.task_id as string | null) ?? null, attempts: r.attempts as number, retryable: bool(r.retryable), startedAt: (r.started_at as string | null) ?? null,
  coordinatorEpoch: Number(r.coordinator_epoch ?? 1),
});
const mapAssignment = (r: Row): AssignmentRow => ({
  id: r.id as string, groupId: r.group_id as string, requestId: r.request_id as string, fromMemberId: r.from_member_id as string,
  toMemberId: r.to_member_id as string, taskId: r.task_id as string, deliveryId: r.delivery_id as string, scope: JSON.parse(r.scope as string) as string[],
  createdAt: r.created_at as string, fingerprint: r.fingerprint as string, notified: bool(r.notified),
});
const mapArtifact = (r: Row): ArtifactRow => ({
  id: r.id as string, groupId: r.group_id as string, requestId: r.request_id as string, fromMemberId: r.from_member_id as string,
  toMemberId: r.to_member_id as string, taskId: (r.task_id as string | null) ?? null, path: r.path as string, commitId: r.commit_id as string,
  blob: r.blob as string, reference: r.reference as string, handoffEventId: (r.handoff_event_id as number | null) ?? null,
  handoffMessageId: (r.handoff_message_id as string | null) ?? null, messageId: r.message_id as string, createdAt: r.created_at as string,
});

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Thin SQL layer over the group tables. Callers own transactions through Store.tx. */
export class GroupRepo {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS group_assignment_acceptances (
      assignment_id TEXT PRIMARY KEY, accepted_by TEXT NOT NULL CHECK(accepted_by='orchestrator'),
      verification_summary TEXT NOT NULL, accepted_at TEXT NOT NULL
    )`);
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
  private get(sql: string, ...params: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...params) as Row | undefined; }
  private run(sql: string, ...params: SQLInputValue[]): number { return Number(this.db.prepare(sql).run(...params).changes); }

  // groups
  insertGroup(g: {
    id: string; projectId: string; title: string; anchorSessionId: string; mode: GroupMode; maxParallel: number; maxTurns: number; maxHops: number;
    autonomy?: AutonomyConfig; recoveryPolicy?: GroupRecoveryPolicy;
  }): void {
    const now = nowIso();
    this.run(`INSERT INTO conversation_groups(id, project_id, title, anchor_session_id, mode, max_parallel, max_turns, max_hops, autonomy_policy, recovery_policy, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, g.id, g.projectId, g.title, g.anchorSessionId, g.mode, g.maxParallel, g.maxTurns, g.maxHops,
    JSON.stringify(g.autonomy ?? { mode: 'balanced' }), JSON.stringify(g.recoveryPolicy ?? { automaticFallback: false }), now, now);
  }
  getGroup(id: string): ConversationGroup | undefined {
    const row = this.get('SELECT g.* FROM conversation_groups g JOIN projects p ON p.id = g.project_id WHERE g.id = ? AND p.archived_at IS NULL AND g.archived_at IS NULL', id);
    return row ? mapGroup(row) : undefined;
  }
  listGroups(): ConversationGroup[] { return this.all('SELECT g.* FROM conversation_groups g JOIN projects p ON p.id = g.project_id WHERE p.archived_at IS NULL AND g.archived_at IS NULL ORDER BY g.created_at ASC, g.rowid ASC').map(mapGroup); }
  archiveGroup(id: string): void { this.run('UPDATE conversation_groups SET archived_at = ?, paused = 1, updated_at = ? WHERE id = ? AND archived_at IS NULL', nowIso(), nowIso(), id); }
  updateGroup(id: string, patch: {
    mode?: GroupMode; orchestratorMemberId?: string | null; paused?: boolean; pauseReason?: string | null;
    maxParallel?: number; maxTurns?: number; maxHops?: number; autonomy?: AutonomyConfig; recoveryPolicy?: GroupRecoveryPolicy;
    recoveryState?: GroupRecoveryState; coordinatorEpoch?: number; preferredCoordinatorMemberId?: string | null;
  }): void {
    const sets = ['updated_at = ?'];
    const params: SQLInputValue[] = [nowIso()];
    const add = (column: string, value: SQLInputValue | undefined) => { if (value !== undefined) { sets.push(`${column} = ?`); params.push(value); } };
    add('mode', patch.mode);
    add('orchestrator_member_id', patch.orchestratorMemberId);
    add('paused', patch.paused === undefined ? undefined : patch.paused ? 1 : 0);
    add('pause_reason', patch.pauseReason);
    add('max_parallel', patch.maxParallel);
    add('max_turns', patch.maxTurns);
    add('max_hops', patch.maxHops);
    if (patch.autonomy !== undefined) add('autonomy_policy', JSON.stringify(patch.autonomy));
    if (patch.recoveryPolicy !== undefined) add('recovery_policy', JSON.stringify(patch.recoveryPolicy));
    if (patch.recoveryState !== undefined) add('recovery_state', JSON.stringify(patch.recoveryState));
    add('coordinator_epoch', patch.coordinatorEpoch);
    add('preferred_coordinator_member_id', patch.preferredCoordinatorMemberId);
    this.run(`UPDATE conversation_groups SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }
  touchGroup(id: string): void { this.run('UPDATE conversation_groups SET updated_at = ? WHERE id = ?', nowIso(), id); }

  // members
  insertMember(m: { id: string; groupId: string; sessionId: string; handle: string; role: GroupMember['role'] }): void {
    this.run('INSERT INTO group_members(id, group_id, session_id, handle, role, joined_at) VALUES (?, ?, ?, ?, ?, ?)', m.id, m.groupId, m.sessionId, m.handle, m.role, nowIso());
  }
  getMember(id: string): MemberRow | undefined {
    const row = this.get('SELECT * FROM group_members WHERE id = ?', id);
    return row ? mapMember(row) : undefined;
  }
  members(groupId: string, includeRemoved = true): MemberRow[] {
    return this.all(`SELECT * FROM group_members WHERE group_id = ? ${includeRemoved ? '' : 'AND removed_at IS NULL'} ORDER BY joined_at ASC, rowid ASC`, groupId).map(mapMember);
  }
  activeMemberOfSession(sessionId: string): MemberRow | undefined {
    const row = this.get(`SELECT m.* FROM group_members m JOIN conversation_groups g ON g.id = m.group_id JOIN projects p ON p.id = g.project_id JOIN sessions s ON s.id = m.session_id
      WHERE m.session_id = ? AND m.removed_at IS NULL AND p.archived_at IS NULL AND g.archived_at IS NULL AND s.archived_at IS NULL`, sessionId);
    return row ? mapMember(row) : undefined;
  }
  handleTaken(groupId: string, handle: string): boolean { return Boolean(this.get('SELECT 1 AS x FROM group_members WHERE group_id = ? AND handle = ?', groupId, handle)); }
  updateMember(id: string, patch: { role?: GroupMember['role']; handle?: string; held?: boolean; lastReadSeq?: number; removedAt?: string | null }): void {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    if (patch.role !== undefined) { sets.push('role = ?'); params.push(patch.role); }
    if (patch.handle !== undefined) { sets.push('handle = ?'); params.push(patch.handle); }
    if (patch.held !== undefined) { sets.push('held = ?'); params.push(patch.held ? 1 : 0); }
    if (patch.lastReadSeq !== undefined) { sets.push('last_read_seq = ?'); params.push(patch.lastReadSeq); }
    if (patch.removedAt !== undefined) { sets.push('removed_at = ?'); params.push(patch.removedAt); }
    if (sets.length) this.run(`UPDATE group_members SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }
  clearHolds(groupId: string): void { this.run('UPDATE group_members SET held = 0 WHERE group_id = ? AND held = 1', groupId); }

  // provider cooldowns
  upsertProviderCooldown(input: ProviderCooldownRow): void {
    this.run(`INSERT INTO group_provider_cooldowns(group_id,member_id,provider,reason,until,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(group_id,member_id,provider) DO UPDATE SET reason=excluded.reason,until=excluded.until,created_at=excluded.created_at`,
    input.groupId, input.memberId, input.provider, input.reason, input.until, input.createdAt);
  }
  providerCooldowns(): ProviderCooldownRow[] {
    return this.all('SELECT * FROM group_provider_cooldowns ORDER BY created_at ASC, rowid ASC').map((row) => ({
      groupId: row.group_id as string, memberId: row.member_id as string, provider: row.provider as string,
      reason: row.reason as string, until: row.until as string, createdAt: row.created_at as string,
    }));
  }
  pruneProviderCooldowns(untilOrBefore: string): number {
    return this.run('DELETE FROM group_provider_cooldowns WHERE until <= ?', untilOrBefore);
  }

  // messages
  private withAttachments(messages: GroupMessage[]): GroupMessage[] {
    const refs = new AttachmentRepo(this.db).refsForOwners('group_message', messages.filter((message) => message.kind === 'user').map((message) => message.id));
    return messages.map((message) => refs.has(message.id) ? { ...message, attachments: refs.get(message.id)! } : message);
  }
  insertMessage(m: {
    groupId: string; senderMemberId: string | null; recipients: string[]; kind: GroupMessage['kind']; content: string; requestId?: string | null;
    replyToId?: string | null; sourceMessageId?: string | null; sourceRunId?: string | null; clientMessageId?: string | null; invocation?: GroupInvocation | null; contextRefs?: GroupMessage['contextRefs'];
  }): GroupMessage {
    const id = messageId();
    this.run(`INSERT INTO group_messages(id, group_id, sender_member_id, recipient_member_ids, kind, content, request_id, reply_to_id, source_message_id, source_run_id, client_message_id, created_at, invocation, context_refs_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, m.groupId, m.senderMemberId, JSON.stringify(m.recipients), m.kind, m.content, m.requestId ?? null,
    m.replyToId ?? null, m.sourceMessageId ?? null, m.sourceRunId ?? null, m.clientMessageId ?? null, nowIso(), m.invocation ? JSON.stringify(m.invocation) : null, m.contextRefs?.length ? JSON.stringify(m.contextRefs) : null);
    return this.getMessage(id)!;
  }
  getMessage(id: string): GroupMessage | undefined {
    const row = this.get('SELECT * FROM group_messages WHERE id = ?', id);
    return row ? this.withAttachments([mapMessage(row)])[0] : undefined;
  }
  messageByClientId(groupId: string, clientMessageId: string): GroupMessage | undefined {
    const row = this.get('SELECT * FROM group_messages WHERE group_id = ? AND client_message_id = ?', groupId, clientMessageId);
    return row ? mapMessage(row) : undefined;
  }
  recentMessages(groupId: string, limit: number): GroupMessage[] {
    return this.withAttachments(this.all('SELECT * FROM group_messages WHERE group_id = ? ORDER BY seq DESC LIMIT ?', groupId, limit).reverse().map(mapMessage));
  }
  /** Messages a member sent or was addressed in, newest last. */
  messagesFor(groupId: string, member: string, limit: number): GroupMessage[] {
    return this.withAttachments(this.all(
      `SELECT * FROM group_messages WHERE group_id = ? AND (sender_member_id = ? OR EXISTS (SELECT 1 FROM json_each(recipient_member_ids) WHERE value = ?))
       ORDER BY seq DESC LIMIT ?`, groupId, member, member, limit,
    ).reverse().map(mapMessage));
  }
  /** Oldest unread addressed messages first; never silently acknowledge messages omitted by the bound. */
  messagesAddressedAfter(groupId: string, member: string, afterSeq: number, limit: number): GroupMessage[] {
    return this.withAttachments(this.all(
      `SELECT * FROM group_messages WHERE group_id = ? AND seq > ? AND sender_member_id IS NOT ?
       AND EXISTS (SELECT 1 FROM json_each(recipient_member_ids) WHERE value = ?) ORDER BY seq ASC LIMIT ?`, groupId, afterSeq, member, member, limit,
    ).map(mapMessage));
  }
  countAddressedAfter(groupId: string, member: string, seq: number): number {
    return Number(this.get(
      `SELECT COUNT(*) AS n FROM group_messages WHERE group_id = ? AND seq > ? AND sender_member_id IS NOT ? AND kind IN ('agent', 'artifact', 'status')
       AND EXISTS (SELECT 1 FROM json_each(recipient_member_ids) WHERE value = ?)`, groupId, seq, member, member,
    )?.n ?? 0);
  }
  maxSeq(groupId: string): number { return Number(this.get('SELECT MAX(seq) AS n FROM group_messages WHERE group_id = ?', groupId)?.n ?? 0); }
  countRunMessages(groupId: string, senderMemberId: string, runId: string, kind: GroupMessage['kind']): number {
    return Number(this.get('SELECT COUNT(*) AS n FROM group_messages WHERE group_id = ? AND sender_member_id = ? AND source_run_id = ? AND kind = ?', groupId, senderMemberId, runId, kind)?.n ?? 0);
  }
  findAgentMessage(groupId: string, sender: string, recipient: string, replyToId: string | null, content: string, request: string): GroupMessage | undefined {
    const row = this.get(
      `SELECT * FROM group_messages WHERE group_id = ? AND kind = 'agent' AND sender_member_id = ? AND request_id = ? AND content = ? AND reply_to_id IS ?
       AND recipient_member_ids = ?`, groupId, sender, request, content, replyToId, JSON.stringify([recipient]),
    );
    return row ? mapMessage(row) : undefined;
  }

  hasLaterPeerMessage(groupId: string, from: string, to: string, requestId: string, afterSeq: number): boolean {
    return Boolean(this.get(`SELECT 1 AS x FROM group_messages WHERE group_id = ? AND request_id = ? AND sender_member_id = ?
      AND kind = 'agent' AND seq > ? AND EXISTS (SELECT 1 FROM json_each(recipient_member_ids) WHERE value = ?) LIMIT 1`, groupId, requestId, from, afterSeq, to));
  }

  // requests
  insertRequest(r: { id: string; groupId: string; messageId: string; plannerMemberId: string; intent?: GroupRequest['intent']; executionPlanId?: string }): void {
    const now = nowIso();
    this.run('INSERT INTO group_requests(id, group_id, message_id, planner_member_id, status, created_at, updated_at, intent, execution_plan_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', r.id, r.groupId, r.messageId, r.plannerMemberId, 'active', now, now, r.intent ?? 'normal', r.executionPlanId ?? null);
  }
  getRequest(id: string): GroupRequest | undefined {
    const row = this.get('SELECT * FROM group_requests WHERE id = ?', id);
    return row ? mapRequest(row) : undefined;
  }
  requests(groupId: string, limit: number): GroupRequest[] {
    return this.all('SELECT * FROM group_requests WHERE group_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', groupId, limit).reverse().map(mapRequest);
  }
  updateRequest(id: string, patch: { status?: GroupRequest['status']; turnsDelta?: number; autoTurnLimit?: number; autoMaxHops?: number }): void {
    const sets = ['status = COALESCE(?, status)', 'turns_used = MAX(0, turns_used + ?)', 'updated_at = ?'];
    const values: SQLInputValue[] = [patch.status ?? null, patch.turnsDelta ?? 0, nowIso()];
    if (patch.autoTurnLimit !== undefined) { sets.push('auto_turn_limit = ?'); values.push(patch.autoTurnLimit); }
    if (patch.autoMaxHops !== undefined) { sets.push('auto_max_hops = ?'); values.push(patch.autoMaxHops); }
    this.run(`UPDATE group_requests SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
  }
  updateActiveRequestPlanners(groupId: string, memberId: string): void {
    this.run("UPDATE group_requests SET planner_member_id = ?, updated_at = ? WHERE group_id = ? AND status = 'active'", memberId, nowIso(), groupId);
  }
  retargetQueuedRequests(groupId: string, fromMemberId: string, toMemberId: string): void {
    this.run(`UPDATE group_deliveries SET member_id = ?, updated_at = ? WHERE group_id = ? AND member_id = ? AND status = 'queued'
      AND kind = 'request' AND assignment_id IS NULL AND task_id IS NULL`, toMemberId, nowIso(), groupId, fromMemberId);
  }
  requestsWithStatus(groupId: string, status: GroupRequest['status']): GroupRequest[] {
    return this.all('SELECT * FROM group_requests WHERE group_id = ? AND status = ?', groupId, status).map(mapRequest);
  }

  // deliveries
  insertDelivery(d: { id: string; groupId: string; requestId: string; messageId: string; memberId: string; kind: DeliveryKind; hop: number; assignmentId?: string | null; taskId?: string | null; coordinatorEpoch?: number }): void {
    const now = nowIso();
    this.run(`INSERT INTO group_deliveries(id, group_id, request_id, message_id, member_id, kind, status, hop, assignment_id, task_id, coordinator_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, COALESCE(?, (SELECT coordinator_epoch FROM conversation_groups WHERE id = ?), 1), ?, ?)`,
    d.id, d.groupId, d.requestId, d.messageId, d.memberId, d.kind, d.hop, d.assignmentId ?? null, d.taskId ?? null, d.coordinatorEpoch ?? null, d.groupId, now, now);
  }
  getDelivery(id: string): DeliveryRow | undefined {
    const row = this.get('SELECT * FROM group_deliveries WHERE id = ?', id);
    return row ? mapDelivery(row) : undefined;
  }
  deliveryByRun(runId: string): DeliveryRow | undefined {
    const row = this.get('SELECT * FROM group_deliveries WHERE run_id = ?', runId);
    return row ? mapDelivery(row) : undefined;
  }
  deliveries(groupId: string, statuses?: DeliveryStatus[]): DeliveryRow[] {
    if (!statuses) return this.all('SELECT * FROM group_deliveries WHERE group_id = ? ORDER BY rowid ASC', groupId).map(mapDelivery);
    return this.all(`SELECT * FROM group_deliveries WHERE group_id = ? AND status IN (${placeholders(statuses.length)}) ORDER BY rowid ASC`, groupId, ...statuses).map(mapDelivery);
  }
  deliveriesForMessage(groupId: string, messageId: string): DeliveryRow[] {
    return this.all('SELECT * FROM group_deliveries WHERE group_id = ? AND message_id = ? ORDER BY rowid ASC', groupId, messageId).map(mapDelivery);
  }
  recentDeliveries(groupId: string, limit: number): DeliveryRow[] {
    return this.all(`SELECT * FROM (SELECT rowid AS rid, * FROM group_deliveries WHERE group_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY rid ASC`, groupId, limit).map(mapDelivery);
  }
  requestDeliveries(requestId: string, statuses?: DeliveryStatus[]): DeliveryRow[] {
    if (!statuses) return this.all('SELECT * FROM group_deliveries WHERE request_id = ? ORDER BY rowid ASC', requestId).map(mapDelivery);
    return this.all(`SELECT * FROM group_deliveries WHERE request_id = ? AND status IN (${placeholders(statuses.length)}) ORDER BY rowid ASC`, requestId, ...statuses).map(mapDelivery);
  }
  updateRequestPlanner(groupId: string, fromMemberId: string | null, toMemberId: string): number {
    if (fromMemberId === null) return this.run("UPDATE group_requests SET planner_member_id = ?, updated_at = ? WHERE group_id = ? AND status IN ('active', 'paused')", toMemberId, nowIso(), groupId);
    return this.run("UPDATE group_requests SET planner_member_id = ?, updated_at = ? WHERE group_id = ? AND status IN ('active', 'paused') AND planner_member_id = ?", toMemberId, nowIso(), groupId, fromMemberId);
  }
  updateRequestPlannerOne(requestId: string, toMemberId: string): number {
    return this.run('UPDATE group_requests SET planner_member_id = ?, updated_at = ? WHERE id = ?', toMemberId, nowIso(), requestId);
  }
  rerouteQueuedRequestDeliveries(requestId: string, fromMemberId: string, toMemberId: string, coordinatorEpoch: number): number {
    return this.run(`UPDATE group_deliveries SET member_id = ?, coordinator_epoch = ?, updated_at = ? WHERE request_id = ? AND member_id = ?
      AND status = 'queued' AND kind IN ('request', 'result') AND assignment_id IS NULL AND task_id IS NULL`,
    toMemberId, coordinatorEpoch, nowIso(), requestId, fromMemberId);
  }
  rerouteQueuedResults(groupId: string, fromMemberId: string, toMemberId: string, coordinatorEpoch: number): number {
    return this.run("UPDATE group_deliveries SET member_id = ?, coordinator_epoch = ?, updated_at = ? WHERE group_id = ? AND member_id = ? AND kind = 'result' AND status = 'queued'",
      toMemberId, coordinatorEpoch, nowIso(), groupId, fromMemberId);
  }
  rerouteQueuedCoordinatorWork(groupId: string, fromMemberId: string, toMemberId: string, coordinatorEpoch: number): number {
    return this.run(`UPDATE group_deliveries SET member_id = ?, coordinator_epoch = ?, updated_at = ? WHERE group_id = ? AND member_id = ?
      AND status = 'queued' AND kind IN ('request', 'result') AND assignment_id IS NULL AND task_id IS NULL`,
    toMemberId, coordinatorEpoch, nowIso(), groupId, fromMemberId);
  }
  memberDeliveries(memberId: string, statuses: DeliveryStatus[]): DeliveryRow[] {
    return this.all(`SELECT * FROM group_deliveries WHERE member_id = ? AND status IN (${placeholders(statuses.length)}) ORDER BY rowid ASC`, memberId, ...statuses).map(mapDelivery);
  }
  /** Most recent start per member, used to schedule fairly. */
  lastStarts(groupId: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const row of this.all('SELECT member_id, MAX(started_at) AS at FROM group_deliveries WHERE group_id = ? AND started_at IS NOT NULL GROUP BY member_id', groupId)) map.set(row.member_id as string, row.at as string);
    return map;
  }
  setDelivery(id: string, patch: { status?: DeliveryStatus; runId?: string | null; error?: string | null; retryable?: boolean; startedAt?: string; attemptsDelta?: number; coordinatorEpoch?: number; messageId?: string; memberId?: string }): void {
    const sets = ['updated_at = ?'];
    const params: SQLInputValue[] = [nowIso()];
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
    if (patch.runId !== undefined) { sets.push('run_id = ?'); params.push(patch.runId); }
    if (patch.error !== undefined) { sets.push('error = ?'); params.push(patch.error); }
    if (patch.retryable !== undefined) { sets.push('retryable = ?'); params.push(patch.retryable ? 1 : 0); }
    if (patch.startedAt !== undefined) { sets.push('started_at = ?'); params.push(patch.startedAt); }
    if (patch.attemptsDelta) { sets.push('attempts = attempts + ?'); params.push(patch.attemptsDelta); }
    if (patch.coordinatorEpoch !== undefined) { sets.push('coordinator_epoch = ?'); params.push(patch.coordinatorEpoch); }
    if (patch.messageId !== undefined) { sets.push('message_id = ?'); params.push(patch.messageId); }
    if (patch.memberId !== undefined) { sets.push('member_id = ?'); params.push(patch.memberId); }
    this.run(`UPDATE group_deliveries SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }
  /** Compare-and-set a delivery status; returns whether this caller won the transition. */
  transitionDelivery(id: string, from: DeliveryStatus, to: DeliveryStatus, patch: { runId?: string | null; error?: string | null; retryable?: boolean; startedAt?: string; attemptsDelta?: number; coordinatorEpoch?: number; messageId?: string; memberId?: string } = {}): boolean {
    const sets = ['status = ?', 'updated_at = ?'];
    const params: SQLInputValue[] = [to, nowIso()];
    if (patch.runId !== undefined) { sets.push('run_id = ?'); params.push(patch.runId); }
    if (patch.error !== undefined) { sets.push('error = ?'); params.push(patch.error); }
    if (patch.retryable !== undefined) { sets.push('retryable = ?'); params.push(patch.retryable ? 1 : 0); }
    if (patch.startedAt !== undefined) { sets.push('started_at = ?'); params.push(patch.startedAt); }
    if (patch.attemptsDelta) { sets.push('attempts = attempts + ?'); params.push(patch.attemptsDelta); }
    if (patch.coordinatorEpoch !== undefined) { sets.push('coordinator_epoch = ?'); params.push(patch.coordinatorEpoch); }
    if (patch.messageId !== undefined) { sets.push('message_id = ?'); params.push(patch.messageId); }
    if (patch.memberId !== undefined) { sets.push('member_id = ?'); params.push(patch.memberId); }
    return this.run(`UPDATE group_deliveries SET ${sets.join(', ')} WHERE id = ? AND status = ?`, ...params, id, from) === 1;
  }

  // assignments
  insertAssignment(a: {
    id: string; groupId: string; requestId: string; fromMemberId: string; toMemberId: string; taskId: string; deliveryId: string; scope: string[]; fingerprint: string;
    acceptanceProvenance?: 'explicit' | 'derived'; milestones?: GroupMilestone[];
  }): void {
    this.run(`INSERT INTO group_assignments(id, group_id, request_id, from_member_id, to_member_id, task_id, delivery_id, scope, fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, a.id, a.groupId, a.requestId, a.fromMemberId, a.toMemberId, a.taskId, a.deliveryId, JSON.stringify(a.scope), a.fingerprint, nowIso());
    const provenance = a.acceptanceProvenance ?? a.milestones?.[0]?.acceptanceProvenance ?? 'explicit';
    for (const milestone of a.milestones ?? []) this.run(`INSERT INTO group_assignment_milestones(id, group_id, assignment_id, task_id, label, acceptance_source, state, evidence_ref, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, milestone.id || baseId('msg'), a.groupId, a.id, a.taskId, milestone.label.slice(0, 300), milestone.acceptanceProvenance ?? provenance,
    milestone.status, milestone.evidence?.slice(0, 1000) ?? null, nowIso(), nowIso());
  }
  getAssignment(id: string): AssignmentRow | undefined {
    const row = this.get('SELECT * FROM group_assignments WHERE id = ?', id);
    return row ? this.withMilestones(mapAssignment(row)) : undefined;
  }
  assignmentByTask(groupId: string, taskId: string): AssignmentRow | undefined {
    const row = this.get('SELECT * FROM group_assignments WHERE group_id = ? AND task_id = ? ORDER BY rowid DESC', groupId, taskId);
    return row ? this.withMilestones(mapAssignment(row)) : undefined;
  }
  assignments(groupId: string): AssignmentRow[] {
    return this.all('SELECT * FROM group_assignments WHERE group_id = ? ORDER BY rowid ASC', groupId).map((row) => this.withMilestones(mapAssignment(row)));
  }
  requestAssignments(requestId: string): AssignmentRow[] {
    return this.all('SELECT * FROM group_assignments WHERE request_id = ? ORDER BY rowid ASC', requestId).map((row) => this.withMilestones(mapAssignment(row)));
  }
  assignmentsCreatedByRun(requestId: string, runId: string): AssignmentRow[] {
    return this.all(`SELECT a.* FROM group_assignments a WHERE a.request_id = ? AND EXISTS (
      SELECT 1 FROM group_messages m WHERE m.group_id = a.group_id AND m.request_id = a.request_id AND m.source_run_id = ?
        AND m.kind = 'assignment' AND instr(m.content, 'Assignment ' || a.id || ' ') > 0
    ) ORDER BY a.rowid ASC`, requestId, runId).map((row) => this.withMilestones(mapAssignment(row)));
  }
  latestAssignmentBatch(requestId: string): AssignmentRow[] {
    const runId = this.get("SELECT source_run_id FROM group_messages WHERE request_id = ? AND kind = 'assignment' AND source_run_id IS NOT NULL ORDER BY seq DESC LIMIT 1", requestId)?.source_run_id as string | undefined;
    return runId ? this.assignmentsCreatedByRun(requestId, runId) : [];
  }
  private withMilestones(assignment: AssignmentRow): AssignmentRow {
    const milestones = this.all('SELECT id, label, state, evidence_ref, acceptance_source FROM group_assignment_milestones WHERE assignment_id = ? ORDER BY created_at, rowid', assignment.id)
      .map((row) => ({ id: row.id as string, label: row.label as string, status: row.state as GroupMilestone['status'],
        ...(row.evidence_ref ? { evidence: row.evidence_ref as string } : {}), acceptanceProvenance: row.acceptance_source as GroupMilestone['acceptanceProvenance'] }));
    const acceptanceProvenance = milestones[0]?.acceptanceProvenance;
    const acceptance = this.get('SELECT accepted_by,verification_summary FROM group_assignment_acceptances WHERE assignment_id=?', assignment.id);
    return { ...assignment, ...(acceptanceProvenance ? { acceptanceProvenance } : {}), ...(milestones.length ? { milestones } : {}),
      ...(acceptance ? { acceptedBy: acceptance.accepted_by as 'orchestrator', verificationSummary: acceptance.verification_summary as string } : {}) };
  }
  acceptAssignment(assignmentId: string, verificationSummary: string): void {
    this.run(`INSERT INTO group_assignment_acceptances(assignment_id,accepted_by,verification_summary,accepted_at)
      VALUES(?,'orchestrator',?,?) ON CONFLICT(assignment_id) DO UPDATE SET
      accepted_by='orchestrator',verification_summary=excluded.verification_summary,accepted_at=excluded.accepted_at`,
    assignmentId, verificationSummary.slice(0, 4_000), nowIso());
  }
  setTaskMilestones(taskId: string, status: 'completed' | 'blocked', evidence: string): void {
    this.run(`UPDATE group_assignment_milestones SET state = ?, evidence_ref = ?, updated_at = ? WHERE task_id = ? AND state <> 'completed'`,
      status, evidence.slice(0, 1000), nowIso(), taskId);
  }
  updateMilestonesForAssignment(assignmentId: string, status: 'completed' | 'blocked', evidence: string): void {
    this.run(`UPDATE group_assignment_milestones SET state = ?, evidence_ref = ?, updated_at = ? WHERE assignment_id = ? AND state <> 'completed'`,
      status, evidence.slice(0, 1000), nowIso(), assignmentId);
  }
  hasAssignmentsCreatedByRun(requestId: string, runId: string): boolean {
    return Boolean(this.get("SELECT 1 AS x FROM group_messages WHERE request_id = ? AND source_run_id = ? AND kind = 'assignment' LIMIT 1", requestId, runId));
  }
  /** Assignments whose delivery has not reached a settled outcome. */
  activeAssignments(groupId: string): AssignmentRow[] {
    return this.all(
      `SELECT a.* FROM group_assignments a JOIN group_deliveries d ON d.id = a.delivery_id
       WHERE a.group_id = ? AND d.status IN ('queued', 'running', 'failed', 'interrupted') ORDER BY a.rowid ASC`, groupId,
    ).map((row) => this.withMilestones(mapAssignment(row)));
  }
  markNotified(ids: string[]): void { for (const id of ids) this.run('UPDATE group_assignments SET notified = 1 WHERE id = ?', id); }
  reassignAssignment(id: string, memberId: string, deliveryId: string): void {
    this.run('UPDATE group_assignments SET to_member_id = ?, delivery_id = ? WHERE id = ?', memberId, deliveryId, id);
  }

  // Durable, idempotent recovery actions and supervised batch acknowledgements.
  getRecoveryAction(groupId: string, idempotencyKey: string): RecoveryActionResult | undefined {
    const row = this.get('SELECT result_json FROM group_recovery_actions WHERE group_id = ? AND idempotency_key = ?', groupId, idempotencyKey);
    return row ? JSON.parse(row.result_json as string) as RecoveryActionResult : undefined;
  }
  insertRecoveryAction(input: { id: string; groupId: string; idempotencyKey: string; action: RecoveryActionRequest['action']; result: RecoveryActionResult }): void {
    this.run('INSERT INTO group_recovery_actions(id, group_id, idempotency_key, action, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      input.id, input.groupId, input.idempotencyKey, input.action, JSON.stringify(input.result), nowIso());
  }
  getRecoveryCheckpoint(groupId: string, checkpointId: string): GroupRecoveryCheckpointRow | undefined {
    const row = this.get('SELECT * FROM group_recovery_checkpoints WHERE group_id = ? AND id = ?', groupId, checkpointId);
    return row ? this.mapRecoveryCheckpoint(row) : undefined;
  }
  getRecoveryCheckpointByKey(groupId: string, idempotencyKey: string): GroupRecoveryCheckpointRow | undefined {
    const row = this.get('SELECT * FROM group_recovery_checkpoints WHERE group_id = ? AND idempotency_key = ?', groupId, idempotencyKey);
    return row ? this.mapRecoveryCheckpoint(row) : undefined;
  }
  latestPendingRecoveryCheckpoint(groupId: string): GroupRecoveryCheckpointRow | undefined {
    const row = this.get("SELECT * FROM group_recovery_checkpoints WHERE group_id = ? AND state = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1", groupId);
    return row ? this.mapRecoveryCheckpoint(row) : undefined;
  }
  hasPendingRecoveryCheckpoint(groupId: string, requestId: string): boolean {
    return Boolean(this.get("SELECT 1 FROM group_recovery_checkpoints WHERE group_id = ? AND state = 'pending' AND (request_id = ? OR request_id IS NULL) LIMIT 1", groupId, requestId));
  }
  deliverySuccessor(groupId: string, sourceDeliveryId: string): string | undefined {
    const row = this.get(`SELECT recovery.successor_delivery_id FROM group_recovery_deliveries recovery
      JOIN group_deliveries source ON source.id = recovery.source_delivery_id WHERE source.group_id = ? AND source.id = ?`, groupId, sourceDeliveryId);
    return row?.successor_delivery_id as string | undefined;
  }
  deliverySource(groupId: string, successorDeliveryId: string): string | undefined {
    const row = this.get(`SELECT recovery.source_delivery_id FROM group_recovery_deliveries recovery
      JOIN group_deliveries successor ON successor.id = recovery.successor_delivery_id WHERE successor.group_id = ? AND successor.id = ?`, groupId, successorDeliveryId);
    return row?.source_delivery_id as string | undefined;
  }
  linkDeliverySuccessor(groupId: string, requestId: string, sourceDeliveryId: string, successorDeliveryId: string): boolean {
    const existing = this.deliverySuccessor(groupId, sourceDeliveryId);
    if (existing) return existing === successorDeliveryId;
    if (this.deliverySource(groupId, successorDeliveryId)) return false;
    const source = this.getDelivery(sourceDeliveryId);
    const successor = this.getDelivery(successorDeliveryId);
    if (!source || !successor || source.groupId !== groupId || successor.groupId !== groupId || source.requestId !== requestId || successor.requestId !== requestId) return false;
    this.run('INSERT INTO group_recovery_deliveries(source_delivery_id, successor_delivery_id, created_at) VALUES (?, ?, ?)', sourceDeliveryId, successorDeliveryId, nowIso());
    return true;
  }
  insertRecoveryCheckpoint(input: {
    id: string; groupId: string; requestId: string | null; batchId: string | null; kind: string; reason: string;
    payload: Record<string, unknown>; idempotencyKey: string;
  }): GroupRecoveryCheckpointRow {
    const existing = this.getRecoveryCheckpointByKey(input.groupId, input.idempotencyKey);
    if (existing) return existing;
    const now = nowIso();
    this.run(`INSERT INTO group_recovery_checkpoints(id, group_id, request_id, batch_id, kind, state, reason, payload_json, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`, input.id, input.groupId, input.requestId, input.batchId, input.kind, input.reason,
    JSON.stringify(input.payload), input.idempotencyKey, now, now);
    return this.getRecoveryCheckpoint(input.groupId, input.id)!;
  }
  acknowledgeRecoveryCheckpoint(groupId: string, checkpointId: string): boolean {
    return this.run("UPDATE group_recovery_checkpoints SET state = 'acknowledged', acknowledged_at = ?, updated_at = ? WHERE group_id = ? AND id = ? AND state = 'pending'",
      nowIso(), nowIso(), groupId, checkpointId) === 1;
  }
  private mapRecoveryCheckpoint(row: Row): GroupRecoveryCheckpointRow {
    return {
      id: row.id as string, groupId: row.group_id as string, requestId: (row.request_id as string | null) ?? null,
      batchId: (row.batch_id as string | null) ?? null, kind: row.kind as string, state: row.state as GroupRecoveryCheckpointRow['state'],
      reason: row.reason as string, payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
      idempotencyKey: row.idempotency_key as string, createdAt: row.created_at as string, updatedAt: row.updated_at as string,
      acknowledgedAt: (row.acknowledged_at as string | null) ?? null,
    };
  }

  recordStallEvidence(input: {
    groupId: string; memberId: string; requestId: string; deliveryId?: string | null; assignmentId?: string | null;
    fingerprint: string; signalClass: string; reason: string; sourceRunId: string | null; sourceToolId?: string | null;
    sourceTaskId?: string | null; sourceArtifactId?: string | null;
  }): { id: string; consecutiveCount: number; duplicate: boolean } {
    const prior = this.get(`SELECT * FROM group_stall_evidence WHERE group_id = ? AND member_id = ? AND request_id = ? AND fingerprint = ?`,
      input.groupId, input.memberId, input.requestId, input.fingerprint);
    if (prior && input.sourceRunId && prior.source_run_id === input.sourceRunId) {
      return { id: prior.id as string, consecutiveCount: Number(prior.consecutive_count), duplicate: true };
    }
    const id = prior?.id as string | undefined ?? baseId('msg');
    const count = Number(prior?.consecutive_count ?? 0) + 1;
    const now = nowIso();
    this.run(`INSERT INTO group_stall_evidence(id, group_id, member_id, request_id, delivery_id, assignment_id, fingerprint, signal_class,
      consecutive_count, reason, source_run_id, source_tool_id, source_task_id, source_artifact_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_id, COALESCE(member_id, ''), COALESCE(request_id, ''), fingerprint) DO UPDATE SET delivery_id = excluded.delivery_id, assignment_id = excluded.assignment_id,
      signal_class = excluded.signal_class, consecutive_count = excluded.consecutive_count, reason = excluded.reason, source_run_id = excluded.source_run_id,
      source_tool_id = excluded.source_tool_id, source_task_id = excluded.source_task_id, source_artifact_id = excluded.source_artifact_id, updated_at = excluded.updated_at`,
    id, input.groupId, input.memberId, input.requestId, input.deliveryId ?? null, input.assignmentId ?? null, input.fingerprint, input.signalClass,
    count, input.reason.slice(0, 1000), input.sourceRunId, input.sourceToolId ?? null, input.sourceTaskId ?? null, input.sourceArtifactId ?? null,
     (prior?.created_at as string | undefined) ?? now, now);
    this.run(`DELETE FROM group_stall_evidence WHERE group_id = ? AND id NOT IN (
      SELECT id FROM group_stall_evidence WHERE group_id = ? ORDER BY updated_at DESC LIMIT 1000
    )`, input.groupId, input.groupId);
    return { id, consecutiveCount: count, duplicate: false };
  }
  clearStallEvidence(groupId: string, memberId: string, requestId: string): void {
    this.run('DELETE FROM group_stall_evidence WHERE group_id = ? AND member_id = ? AND request_id = ?', groupId, memberId, requestId);
  }

  // assignment inputs and artifacts
  insertInput(assignmentId: string, taskId: string, path: string, artifact: string | null): void {
    this.run('INSERT INTO group_assignment_inputs(assignment_id, task_id, path, artifact_id) VALUES (?, ?, ?, ?)', assignmentId, taskId, path, artifact);
  }
  inputs(assignmentId: string): InputRow[] {
    return this.all('SELECT * FROM group_assignment_inputs WHERE assignment_id = ? ORDER BY task_id, path', assignmentId)
      .map((r) => ({ assignmentId: r.assignment_id as string, taskId: r.task_id as string, path: r.path as string, artifactId: (r.artifact_id as string | null) ?? null }));
  }
  setInputArtifact(assignmentId: string, taskId: string, path: string, artifact: string): void {
    this.run('UPDATE group_assignment_inputs SET artifact_id = ? WHERE assignment_id = ? AND task_id = ? AND path = ?', artifact, assignmentId, taskId, path);
  }
  /** Open input rows for assignments targeted at a recipient (used to link a newly published artifact). */
  openInputs(groupId: string, toMemberId: string, taskId: string, path: string): InputRow[] {
    return this.all(
      `SELECT i.* FROM group_assignment_inputs i JOIN group_assignments a ON a.id = i.assignment_id
       WHERE a.group_id = ? AND a.to_member_id = ? AND i.task_id = ? AND i.path = ? AND i.artifact_id IS NULL`, groupId, toMemberId, taskId, path,
    ).map((r) => ({ assignmentId: r.assignment_id as string, taskId: r.task_id as string, path: r.path as string, artifactId: null }));
  }
  insertArtifact(a: Omit<ArtifactRow, 'createdAt'>): void {
    this.run(`INSERT INTO group_artifacts(id, group_id, request_id, from_member_id, to_member_id, task_id, path, commit_id, blob, reference, handoff_event_id, handoff_message_id, message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, a.id, a.groupId, a.requestId, a.fromMemberId, a.toMemberId, a.taskId, a.path, a.commitId, a.blob, a.reference,
    a.handoffEventId, a.handoffMessageId, a.messageId, nowIso());
  }
  getArtifact(id: string): ArtifactRow | undefined {
    const row = this.get('SELECT * FROM group_artifacts WHERE id = ?', id);
    return row ? mapArtifact(row) : undefined;
  }
  findArtifact(groupId: string, from: string, to: string, path: string, commitId: string, taskId: string | null = null): ArtifactRow | undefined {
    const row = this.get('SELECT * FROM group_artifacts WHERE group_id = ? AND from_member_id = ? AND to_member_id = ? AND path = ? AND commit_id = ? AND task_id IS ?', groupId, from, to, path, commitId, taskId);
    return row ? mapArtifact(row) : undefined;
  }
  /** Artifacts that satisfy an exact producer-task / recipient / path reference, newest first. */
  matchingArtifacts(groupId: string, toMemberId: string, taskId: string, path: string): ArtifactRow[] {
    return this.all('SELECT * FROM group_artifacts WHERE group_id = ? AND to_member_id = ? AND task_id = ? AND path = ? ORDER BY rowid DESC', groupId, toMemberId, taskId, path).map(mapArtifact);
  }
  artifactsForRequest(requestId: string): ArtifactRow[] {
    return this.all('SELECT * FROM group_artifacts WHERE request_id = ? ORDER BY rowid ASC', requestId).map(mapArtifact);
  }
}
