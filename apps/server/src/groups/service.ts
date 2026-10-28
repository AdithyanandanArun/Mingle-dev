import { createHash } from 'node:crypto';
import {
  nativeActionCommands, nativeActionSkills,
} from '@mingle/contracts';
import type {
  AddGroupAgent, AgentConfiguration, AutonomyConfig, ConversationGroup, CreateGroup, GroupAssignment, GroupDelivery, GroupMember, GroupMessage, GroupMode, MessageContextRef, SessionPlan,
  GroupMilestone, GroupRecoveryPolicy, GroupRecoveryState, ProviderFailure, RecoveryActionRequest, RecoveryActionResult, RecoveryCheckpoint,
  GroupRunContext, GroupSnapshot, ProviderInfo, ProviderSkill, Session, Task, TeamAcceptTask, TeamArtifactSchema, TeamAssignSchema, TeamMessageSchema, TeamStatusSchema, UpdateGroupSchema,
} from '@mingle/contracts';
import type { z } from 'zod';
import { unfinishedDeps } from '../dag.ts';
import { git } from '../git.ts';
import type { HandoffService } from '../handoffs.ts';
import { resolveRunConfig } from '../session-config.ts';
import type { Store } from '../store.ts';
import type { TaskService } from '../tasks.ts';
import { RecoveryService } from '../recovery/service.ts';
import { HttpError, conflict, errorMessage, newId, notFound, nowIso, redactSecrets, truncate, unprocessable } from '../util.ts';
import type { WorkspaceService } from '../workspace.ts';
import type { AttachmentService } from '../attachments/service.ts';
import { buildMessageContext, validateQuoteCitation } from '../message-context.ts';
import type { GroupInvocation, NativeInvocationInput, ProviderCatalog } from '@mingle/contracts';
import {
  GroupRepo, OPEN_DELIVERY, artifactId, assignmentId, deliveryId, recoveryCheckpointId, groupId as newGroupId, memberId as newMemberId, requestId as newRequestId,
  type ArtifactRow, type AssignmentRow, type DeliveryRow, type GroupRecoveryCheckpointRow, type MemberRow,
} from './repo.ts';
import {
  LIMITS, MODE_LABEL, assignmentText, buildInstructions, clean, deriveAcceptanceCriteria, messageDeliveryText, requestDeliveryText, resultText, type ResultLine, type RosterEntry,
} from './prompt.ts';
import { RESERVED_HANDLES, extractMentions, normalizeScopes, safeArtifactPath, scopesOverlap } from './routing.ts';

function resolveProviderSkill(provider: Session['provider'], skills: ProviderSkill[], id: string, name: string): ProviderSkill | undefined {
  const eligible = nativeActionSkills(provider, skills).some((skill) => skill.id === id && skill.name === name);
  return eligible ? skills.find((skill) => skill.id === id && skill.name === name && skill.enabled) : undefined;
}

/** Matches the server's Logger; a plain (message) => void function is also accepted. */
export type GroupLog = (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;
export interface GroupRuntime {
  isActive(sessionId: string): boolean;
  isRunLive?(sessionId: string, runId: string): boolean;
  start(sessionId: string, content: string, options?: { taskId?: string; groupDeliveryId?: string; userMessage?: { content: string; kind?: string }; attachmentOwnerKind?: 'message' | 'group_message'; attachmentOwnerId?: string; invocation?: import('@mingle/contracts').NativeInvocation; context?: string; contextRefs?: MessageContextRef[]; intent?: 'normal' | 'plan'; executionPlanId?: string }): string;
  interrupt(sessionId: string): boolean;
  withSessionsStopped?<T>(sessionIds: string[], action: () => T): Promise<T>;
}
export type GroupCatalog = (session: Session, refresh?: boolean) => Promise<ProviderCatalog>;
export interface GroupRecoveryReader {
  capture(sessionId: string, reason: string, runId?: string): Promise<RecoveryCheckpoint>;
  latest(sessionId: string): RecoveryCheckpoint | null;
  failure(sessionId: string): ProviderFailure | null;
  failureForRun(runId: string): ProviderFailure | null;
  clearFailure(sessionId: string): void;
}
export interface GroupServiceOptions {
  store: Store; workspace: WorkspaceService; tasks: TaskService; handoffs: HandoffService; runtime: GroupRuntime; log: GroupLog;
  providers?: () => ProviderInfo[];
  attachments?: AttachmentService;
  catalog?: GroupCatalog;
  recovery?: GroupRecoveryReader;
}

type Outcome = 'completed' | 'failed' | 'interrupted';
type Assign = z.infer<typeof TeamAssignSchema>;
type TeamMessage = z.infer<typeof TeamMessageSchema>;
type TeamArtifact = z.infer<typeof TeamArtifactSchema>;
type TeamStatus = z.infer<typeof TeamStatusSchema>;
type Update = z.infer<typeof UpdateGroupSchema>;
type QuotaRecoveryPolicy = GroupRecoveryPolicy & { allowUnverifiedQuotaFallback?: boolean };
interface Live { delivery: DeliveryRow; group: ConversationGroup; member: MemberRow; session: Session; request: ReturnType<GroupRepo['getRequest']> & object }

const MAX_MEMBERS = 8;
const MAX_MESSAGES_PER_RUN = 12;
const MAX_ASSIGNMENTS_PER_RUN = 10;
const STALL_RUN_THRESHOLD = 3;
const SNAPSHOT_MESSAGES = 500;
const SNAPSHOT_DELIVERIES = 300;
const isRecoverableRemoteCompletion = (status: DeliveryRow['status'], message: string | null | undefined): boolean =>
  status === 'failed' && (message === 'The remote agent stopped responding.' || message === 'The remote agent timed out while its device was offline.')
  || status === 'interrupted' && message === 'Interrupted because Mingle restarted';
const SNAPSHOT_REQUESTS = 100;
const FULL_SHA = /^[0-9a-f]{40,64}$/i;
const DEFAULT_LIMITS = { maxParallel: 2, maxTurns: 80, maxHops: 6 };
const MAX_SAFE_RETRIES = 1;
const MAX_SAFE_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;
const forbidden = (message: string) => new HttpError(403, message);
const effectiveTurnLimit = (group: ConversationGroup): number | null => {
  const autonomy = group.autonomy;
  return autonomy?.emergencyTurnLimit === undefined ? group.maxTurns : autonomy.emergencyTurnLimit;
};
function teamArtifactRefName(sharedProjectId: string, deliveryIdArg: string, revision: string): string {
  const segment = (value: string) => `${value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 36) || 'team'}-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
  return `refs/mingle/team/${segment(sharedProjectId)}/${segment(deliveryIdArg)}/${revision.toLowerCase()}`;
}

export class GroupService {
  private readonly store: Store;
  private readonly repo: GroupRepo;
  private readonly workspace: WorkspaceService;
  private readonly tasks: TaskService;
  private readonly handoffs: HandoffService;
  private readonly runtime: GroupRuntime;
  private readonly log: GroupLog;
  private readonly providers?: () => ProviderInfo[];
  private readonly attachments?: AttachmentService;
  private readonly catalog?: GroupCatalog;
  private readonly recovery?: GroupRecoveryReader;
  private closed = false;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<string>();
  private readonly automaticFallbackCaptures = new Set<string>();
  private readonly safeRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Only former coordinator runs lose authority on takeover; independent worker runs keep their tools. */
  private readonly fencedCoordinatorDeliveries = new Set<string>();
  private scheduled = false;
  private readonly unsubscribe: () => void;
  /** Deliveries whose runtime.start call is in flight, keyed by session. Closed by the same synchronous turn. */
  private readonly reserved = new Map<string, string>();
  private readonly deletingGroups = new Set<string>();
  private teamDispatchGuard?: (sessionId: string, groupId: string) => Promise<boolean>;
  private teamRunFinishedHook?: (input: { sessionId: string; runId: string; outcome: Outcome; groupId: string; deliveryId: string }) => void;

  constructor(options: GroupServiceOptions) {
    this.store = options.store;
    this.repo = new GroupRepo(options.store.db);
    this.workspace = options.workspace;
    this.tasks = options.tasks;
    this.handoffs = options.handoffs;
    this.runtime = options.runtime;
    this.log = options.log;
    this.providers = options.providers;
    this.attachments = options.attachments;
    this.catalog = options.catalog;
    this.recovery = options.recovery ?? new RecoveryService(options.store);
    this.unsubscribe = this.store.subscribe((event) => {
      if (event?.type.startsWith('task.')) {
        const taskId = typeof event.payload.taskId === 'string' ? event.payload.taskId : null;
        if (taskId && event.type === 'task.done') this.repo.setTaskMilestones(taskId, 'completed', `task-event:${event.id}`);
        if (taskId && event.type === 'task.blocked') this.repo.setTaskMilestones(taskId, 'blocked', `task-event:${event.id}`);
        for (const group of this.repo.listGroups()) if (group.projectId === event.projectId) this.schedule(group.id);
      }
    });
  }

  /** Used only by the shared-project host to create its regular scheduler group without provisioning provider sessions. */
  createTeamGroup(input: {
    id: string; projectId: string; title: string; orchestratorSessionId: string; mode?: GroupMode;
    members: Array<{ sessionId: string; handle: string; role: 'orchestrator' | 'worker' | 'idle'; held: boolean }>;
  }): GroupSnapshot {
    this.assertOpen();
    const existing = this.repo.getGroup(input.id);
    if (existing) return this.get(existing.id);
    if (!input.members.length || input.members.length > 64) throw unprocessable('A team group must contain between one and 64 roster agents.');
    const uniqueSessions = new Set(input.members.map((member) => member.sessionId));
    const uniqueHandles = new Set(input.members.map((member) => member.handle));
    if (uniqueSessions.size !== input.members.length || uniqueHandles.size !== input.members.length) throw conflict('Team group sessions and handles must be unique.');
    const orchestrator = input.members.find((member) => member.sessionId === input.orchestratorSessionId && member.role === 'orchestrator');
    if (!orchestrator) throw conflict('The team orchestrator must be an active group member.');
    const sessions = input.members.map((member) => this.store.getSession(member.sessionId));
    if (sessions.some((session) => !session || session.projectId !== input.projectId)) throw conflict('Every team agent must have a local session in the shared project.');
    for (const session of sessions) if (session && this.sessionBusy(session)) throw conflict(`Wait for ${session.name} to finish before starting a team group.`);
    if (input.members.some((member) => this.repo.activeMemberOfSession(member.sessionId))) throw conflict('A published team agent already belongs to another active conversation group. Remove it there before enabling team orchestration.');
    const defaults = { ...DEFAULT_LIMITS, ...this.store.getSettings().groupDefaults };
    const mode = input.mode ?? 'orchestrated';
    this.store.tx(() => {
      this.repo.insertGroup({ id: input.id, projectId: input.projectId, title: input.title.slice(0, 100), anchorSessionId: input.orchestratorSessionId,
        mode, ...defaults, autonomy: this.store.getSettings().groupDefaults?.autonomy ?? { mode: 'balanced' } });
      const ids = new Map<string, string>();
      for (const member of input.members) {
        const id = newMemberId();
        ids.set(member.sessionId, id);
        const role: GroupMember['role'] = mode === 'cowork' ? 'peer' : member.role === 'orchestrator' ? 'orchestrator' : 'worker';
        this.repo.insertMember({ id, groupId: input.id, sessionId: member.sessionId, handle: member.handle, role });
        if (member.held || member.role === 'idle') this.repo.updateMember(id, { held: true });
      }
      this.repo.updateGroup(input.id, { orchestratorMemberId: mode === 'cowork' ? null : ids.get(input.orchestratorSessionId)!, coordinatorEpoch: 1 });
      this.event(this.repo.getGroup(input.id)!, 'group.team.created', `Team orchestration group created: ${input.title.slice(0, 100)}`, { memberCount: input.members.length });
    });
    return this.get(input.id);
  }

  /** Reconcile host-owned local and proxy sessions with the existing orchestrated scheduler group. */
  syncTeamMembers(groupId: string, wanted: Array<{ sessionId: string; handle: string; role: 'orchestrator' | 'worker' | 'idle'; held: boolean }>): void {
    this.store.tx(() => {
      this.assertOpen();
      const group = this.requireGroup(groupId);
      const active = this.repo.members(groupId, false);
      const history = this.repo.members(groupId, true);
      const bySession = new Map(active.map((member) => [member.sessionId, member]));
      const historyBySession = new Map(history.map((member) => [member.sessionId, member]));
      const wantedSessions = new Set(wanted.map((member) => member.sessionId));
      const orchestrator = wanted.find((member) => member.role === 'orchestrator');
      if (wanted.length > 64 || new Set(wanted.map((member) => member.handle)).size !== wanted.length) throw conflict('The team roster is invalid or exceeds 64 agents.');
      const structural = active.length !== wanted.length || wanted.some((member) => {
        const current = bySession.get(member.sessionId);
        return !current || current.handle !== member.handle || current.role !== (member.role === 'orchestrator' ? 'orchestrator' : 'worker')
          || current.held !== (member.held || member.role === 'idle');
      });
      if (structural && this.repo.deliveries(groupId, ['running']).length) throw conflict('Wait for team deliveries to finish before changing team membership.');
      for (const member of wanted) {
        const session = this.store.getSession(member.sessionId);
        if (!session || session.projectId !== group.projectId) throw conflict('A team agent session is unavailable in this project.');
        const current = bySession.get(member.sessionId);
        if (!current) {
          const otherGroup = this.repo.activeMemberOfSession(member.sessionId);
          if (otherGroup && otherGroup.groupId !== groupId) throw conflict('A published team agent already belongs to another active conversation group.');
        }
        const role = member.role === 'orchestrator' ? 'orchestrator' : 'worker';
        if (current) {
          if (current.handle !== member.handle && this.repo.handleTaken(groupId, member.handle)) throw conflict(`@${member.handle} is already in use.`);
          this.repo.updateMember(current.id, { role, handle: member.handle, held: member.held || member.role === 'idle' });
        } else if (historyBySession.has(member.sessionId)) {
          const previous = historyBySession.get(member.sessionId)!;
          if (previous.handle !== member.handle && this.repo.handleTaken(groupId, member.handle)) throw conflict(`@${member.handle} is already in use.`);
          this.repo.updateMember(previous.id, { role, handle: member.handle, held: member.held || member.role === 'idle', removedAt: null });
        } else {
          const id = newMemberId();
          this.repo.insertMember({ id, groupId, sessionId: member.sessionId, handle: member.handle, role });
          if (member.held || member.role === 'idle') this.repo.updateMember(id, { held: true });
        }
      }
      for (const member of active) if (!wantedSessions.has(member.sessionId)) this.repo.updateMember(member.id, { removedAt: nowIso(), held: true });
      const currentLeader = orchestrator ? this.repo.members(groupId, false).find((member) => member.sessionId === orchestrator.sessionId) : undefined;
      this.repo.updateGroup(groupId, { orchestratorMemberId: currentLeader?.id ?? null });
      if (!orchestrator) this.repo.updateGroup(groupId, { paused: true, pauseReason: 'No team orchestrator is currently available.' });
      this.repo.touchGroup(groupId);
      this.store.touch();
    });
  }

  /** Add one host-created proxy session without provisioning a second local provider session. */
  addTeamMember(groupId: string, input: { sessionId: string; handle: string }): Promise<GroupSnapshot> {
    return this.exclusive(async () => {
      this.assertOpen();
      const group = this.requireGroup(groupId);
      this.assertCanChangeRoster(group);
      if (this.repo.members(groupId, false).length >= MAX_MEMBERS) throw conflict(`A group supports at most ${MAX_MEMBERS} agents`);
      const session = this.store.getSession(input.sessionId);
      if (!session || session.projectId !== group.projectId) throw conflict('The team proxy session is unavailable in the group project.');
      if (this.sessionBusy(session)) throw conflict(`Wait for ${session.name} to finish before adding it to the group.`);
      if (this.repo.activeMemberOfSession(input.sessionId)) throw conflict('This team agent already belongs to an active conversation group.');
      this.assertHandleFree(groupId, this.validateHandle(input.handle));
      this.store.tx(() => {
        this.repo.insertMember({ id: newMemberId(), groupId, sessionId: input.sessionId, handle: input.handle, role: group.mode === 'cowork' ? 'peer' : 'worker' });
        this.repo.touchGroup(groupId);
        this.event(group, 'group.member.added', `Agent added: @${input.handle}`, { handle: input.handle, role: group.mode === 'cowork' ? 'peer' : 'worker' }, input.sessionId);
      });
      return this.get(groupId);
    });
  }

  /** Reconcile team-owned members in a regular group without removing its ordinary local members. */
  syncTeamRosterMembers(groupId: string, wanted: Array<{ sessionId: string; handle: string; role: 'orchestrator' | 'worker' | 'idle'; held: boolean }>, managedSessionIds: string[] = wanted.map((member) => member.sessionId)): void {
    this.store.tx(() => {
      const group = this.requireGroup(groupId);
      if (wanted.length > 64 || new Set(wanted.map((member) => member.handle)).size !== wanted.length) throw conflict('The team roster is invalid or exceeds 64 agents.');
      const current = this.repo.members(groupId, false);
      const bySession = new Map(current.map((member) => [member.sessionId, member]));
      const wantedSessions = new Set(wanted.map((member) => member.sessionId));
      for (const member of wanted) {
        const session = this.store.getSession(member.sessionId);
        if (!session || session.projectId !== group.projectId) throw conflict('A team agent session is unavailable in this project.');
        // Cowork groups have no orchestrator; every member, including the team's chosen leader, is a peer.
        const role: GroupMember['role'] = group.mode === 'cowork' ? 'peer' : member.role === 'orchestrator' ? 'orchestrator' : 'worker';
        const existing = bySession.get(member.sessionId);
        if (existing) {
          if (existing.handle !== member.handle && this.repo.handleTaken(groupId, member.handle)) throw conflict(`@${member.handle} is already in use.`);
          this.repo.updateMember(existing.id, { role, handle: member.handle, held: member.held || member.role === 'idle' });
        } else {
          if (this.repo.activeMemberOfSession(member.sessionId)) throw conflict('A team agent already belongs to another active conversation group.');
          this.assertHandleFree(groupId, member.handle);
          const id = newMemberId();
          this.repo.insertMember({ id, groupId, sessionId: member.sessionId, handle: member.handle, role });
          if (member.held || member.role === 'idle') this.repo.updateMember(id, { held: true });
        }
      }
      for (const member of current) {
        if (managedSessionIds.includes(member.sessionId) && !wantedSessions.has(member.sessionId)) {
          this.repo.updateMember(member.id, { removedAt: nowIso(), held: true });
        }
      }
    });
  }

  /** Wake the durable scheduler after an external team state change makes queued members eligible. */
  pumpTeamGroup(groupId: string): void {
    this.requireGroup(groupId);
    this.schedule(groupId);
  }

  /** Manual and automatic host handover share one scheduler update path. */
  setTeamLeader(groupId: string, sessionId: string | null, options: { paused?: boolean; pauseReason?: string | null } = {}): void {
    const group = this.requireGroup(groupId);
    if (this.repo.deliveries(groupId, ['running']).length) throw conflict('Wait for running team deliveries before changing the orchestrator.');
    const members = this.repo.members(groupId, false);
    const next = sessionId ? members.find((member) => member.sessionId === sessionId) : undefined;
    if (sessionId && !next) throw conflict('The selected team orchestrator is not an active member.');
    const previous = group.orchestratorMemberId ? this.repo.getMember(group.orchestratorMemberId) : undefined;
    this.store.tx(() => {
      for (const member of members) {
        const isLeader = member.id === next?.id;
        this.repo.updateMember(member.id, { role: isLeader ? 'orchestrator' : 'worker', ...(isLeader ? { held: false } : {}) });
      }
      this.repo.updateGroup(groupId, {
        orchestratorMemberId: next?.id ?? null, coordinatorEpoch: (group.coordinatorEpoch ?? 1) + 1,
        paused: options.paused ?? !next, pauseReason: options.pauseReason ?? (next ? null : 'No team orchestrator is currently available.'),
      });
      if (next) {
        if (previous && previous.id !== next.id) {
          this.repo.retargetQueuedRequests(groupId, previous.id, next.id);
          this.requeueFailedPlannerWork(group, previous, next);
        }
        this.repo.updateActiveRequestPlanners(groupId, next.id);
      }
      this.event(group, next ? 'group.team.leader-changed' : 'group.team.leader-required', next ? `Team orchestrator changed to @${next.handle}` : 'Team group needs an orchestrator', {
        fromMemberId: previous?.id ?? null, toMemberId: next?.id ?? null, coordinatorEpoch: (group.coordinatorEpoch ?? 1) + 1,
      }, next?.sessionId);
    });
    if (next) this.schedule(groupId);
    this.store.touch();
  }

  /** A failed/offline planner turn gets one linked continuation on the newly selected lead. */
  private requeueFailedPlannerWork(group: ConversationGroup, previous: MemberRow, next: MemberRow): void {
    const failures = this.repo.deliveries(group.id, ['failed', 'interrupted']).filter((delivery) =>
      delivery.memberId === previous.id && delivery.kind === 'request' && !this.repo.deliverySuccessor(group.id, delivery.id));
    for (const failed of failures) {
      const request = this.repo.getRequest(failed.requestId);
      if (!request || request.status === 'completed' || request.intent === 'plan' || request.executionPlanId || failed.taskId) continue;
      const successorId = deliveryId();
      this.repo.insertDelivery({ id: successorId, groupId: group.id, requestId: request.id, messageId: failed.messageId,
        memberId: next.id, kind: 'request', hop: failed.hop, taskId: failed.taskId });
      if (!this.repo.linkDeliverySuccessor(group.id, request.id, failed.id, successorId)) continue;
      this.refreshRequest(request.id);
      this.event(group, 'group.team.leader-continuation', `Pending planner work requeued for @${next.handle}`, {
        requestId: request.id, failedDeliveryId: failed.id, successorDeliveryId: successorId,
      }, next.sessionId);
    }
  }

  pauseTeamGroup(groupId: string, reason: string): void {
    const group = this.requireGroup(groupId);
    this.repo.updateGroup(groupId, { paused: true, pauseReason: reason.slice(0, 500) });
    for (const request of this.repo.requestsWithStatus(groupId, 'active')) this.repo.updateRequest(request.id, { status: 'paused' });
    this.event(group, 'group.team.paused', reason.slice(0, 300));
  }

  /** Enqueue an externally authenticated team-chat message through the normal group delivery queue. */
  sendTeamMessage(groupId: string, input: { content: string; recipients?: string[]; clientMessageId: string }): string[] {
    const group = this.requireGroup(groupId);
    const prior = this.repo.messageByClientId(groupId, input.clientMessageId);
    if (prior) return this.repo.deliveriesForMessage(groupId, prior.id).map((delivery) => delivery.id);
    const members = this.repo.members(groupId, false);
    const route = this.route(group, members, input.recipients, input.content);
    let ids: string[] = [];
    this.store.tx(() => {
      const message = this.repo.insertMessage({ groupId, senderMemberId: null, recipients: route.recipients.map((member) => member.id), kind: 'user', content: input.content, clientMessageId: input.clientMessageId });
      const requestId = newRequestId();
      this.repo.insertRequest({ id: requestId, groupId, messageId: message.id, plannerMemberId: route.planner.id });
      ids = route.runners.map(() => deliveryId());
      route.runners.forEach((member, index) => this.repo.insertDelivery({ id: ids[index]!, groupId, requestId, messageId: message.id, memberId: member.id, kind: 'request', hop: 0 }));
      this.repo.touchGroup(groupId);
      this.event(group, group.paused ? 'group.message.queued' : 'group.message.sent', group.paused ? 'Team-chat message queued while the group is paused' : 'Team-chat message routed to the group', {
        source: 'teamchat', messageId: message.id, requestId, recipients: route.recipients.map((member) => member.handle), runners: route.runners.map((member) => member.handle),
      });
    });
    this.schedule(groupId);
    return ids;
  }

  setTeamDispatchGuard(guard: (sessionId: string, groupId: string) => Promise<boolean>): void { this.teamDispatchGuard = guard; }
  setTeamRunFinishedHook(hook: (input: { sessionId: string; runId: string; outcome: Outcome; groupId: string; deliveryId: string }) => void): void { this.teamRunFinishedHook = hook; }

  holdTeamMember(sessionId: string, reason: string): void {
    const member = this.repo.activeMemberOfSession(sessionId);
    if (!member || member.held) return;
    this.repo.updateMember(member.id, { held: true });
    const group = this.repo.getGroup(member.groupId);
    if (group) this.event(group, 'group.team.member-held', `Team agent held: @${member.handle}`, { memberId: member.id, reason: reason.slice(0, 300) }, sessionId);
  }

  // ---------------------------------------------------------------- snapshots

  snapshots(): GroupSnapshot[] { return this.repo.listGroups().map((group) => this.snapshot(group)); }

  get(id: string): GroupSnapshot { return this.snapshot(this.requireGroup(id)); }

  forSession(sessionId: string): GroupSnapshot | undefined {
    const member = this.repo.activeMemberOfSession(sessionId);
    const group = member ? this.repo.getGroup(member.groupId) : undefined;
    return group ? this.snapshot(group) : undefined;
  }

  private snapshot(group: ConversationGroup): GroupSnapshot {
    const members: GroupMember[] = this.repo.members(group.id).map((m) => {
      const failure = this.recovery?.failure(m.sessionId) ?? undefined;
      return { id: m.id, groupId: m.groupId, sessionId: m.sessionId, handle: m.handle, role: m.role, held: m.held,
        joinedAt: m.joinedAt, removedAt: m.removedAt, ...(failure ? { failure } : {}) };
    });
    const rows = [...new Map([...this.repo.recentDeliveries(group.id, SNAPSHOT_DELIVERIES), ...this.repo.deliveries(group.id).filter((d) => OPEN_DELIVERY.includes(d.status) || d.retryable)].map((d) => [d.id, d])).values()];
    const deliveries: GroupDelivery[] = rows.map((d) => ({
      id: d.id, groupId: d.groupId, requestId: d.requestId, messageId: d.messageId, memberId: d.memberId, status: d.status, runId: d.runId, hop: d.hop,
      kind: d.kind, coordinatorEpoch: d.coordinatorEpoch,
      ...(d.runId && this.recovery?.failureForRun(d.runId) ? { failure: this.recovery.failureForRun(d.runId)! } : {}),
      ...(this.repo.deliverySuccessor(group.id, d.id) ? { recoveredByDeliveryId: this.repo.deliverySuccessor(group.id, d.id)! } : {}),
      error: d.error, createdAt: d.createdAt, updatedAt: d.updatedAt,
    }));
    const requests = [...new Map([...this.repo.requests(group.id, SNAPSHOT_REQUESTS), ...rows.map((d) => this.repo.getRequest(d.requestId)).filter((r): r is NonNullable<typeof r> => Boolean(r))].map((r) => [r.id, r])).values()];
    const messages = [...new Map([...this.repo.recentMessages(group.id, SNAPSHOT_MESSAGES), ...[...rows.map((d) => d.messageId), ...requests.map((r) => r.messageId)].map((id) => this.repo.getMessage(id)).filter((m): m is GroupMessage => Boolean(m))].map((m) => [m.id, m])).values()].sort((a, b) => a.seq - b.seq);
    const assignments: GroupAssignment[] = this.repo.assignments(group.id).map((a) => ({
      id: a.id, groupId: a.groupId, requestId: a.requestId, fromMemberId: a.fromMemberId, toMemberId: a.toMemberId, taskId: a.taskId, deliveryId: a.deliveryId, scope: a.scope, createdAt: a.createdAt,
      ...(a.acceptedBy ? { acceptedBy: a.acceptedBy } : {}), ...(a.verificationSummary ? { verificationSummary: a.verificationSummary } : {}),
    }));
    return { group, members, messages, requests, deliveries, assignments };
  }

  // ---------------------------------------------------------------- lifecycle

  /** Serialises structural changes (create/add) so two requests can never claim one session or handle. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  async create(input: CreateGroup): Promise<GroupSnapshot> {
    return this.exclusive(async () => {
      this.assertOpen();
      const original = this.requireJoinable(input.sessionId);
      const settings = this.store.getSettings();
        const defaults = { ...DEFAULT_LIMITS, ...settings.groupDefaults };
      if (input.mode !== 'orchestrated' && (input.orchestrator || input.currentConfiguration)) {
        throw unprocessable('A separate orchestrator and a current-agent configuration change apply only to Orchestrated groups');
      }
      const coordinatorConfig = input.mode === 'orchestrated' ? input.orchestrator ?? settings.groupDefaults?.orchestrator : undefined;
      if (input.mode === 'orchestrated' && !coordinatorConfig) throw unprocessable('Choose an orchestrator, or save a default orchestrator in Settings → Agents & orchestration');
      this.checkConfiguration(input.agent.configuration);
      if (coordinatorConfig) this.checkConfiguration(coordinatorConfig);

      // Reviewed configuration for the existing agent is validated now and applied last, never changing its provider.
      let configPatch: Record<string, string> = {};
      if (input.currentConfiguration) {
        const wanted = input.currentConfiguration;
        const info = this.providers?.().find((row) => row.id === original.provider);
        this.checkModel(info, wanted.model, original.provider);
        const resolved = resolveRunConfig(info, { provider: original.provider, ...wanted }, { effort: true, policy: true, serviceTier: true });
        configPatch = Object.fromEntries(Object.entries({ model: wanted.model, effort: resolved.effort, policy: resolved.policy, serviceTier: resolved.serviceTier })
          .filter(([key, value]) => original[key as keyof Session] !== value));
      }

      const newHandle = this.validateHandle(input.agent.handle);
      const originalHandle = `${original.provider}1`;
      if (newHandle === originalHandle) throw conflict(`Handle @${newHandle} is reserved for the current agent in this group. Choose another handle.`);
      const taken = new Set([originalHandle, newHandle]);
      let coordinatorHandle: string | null = null;
      if (coordinatorConfig) {
        for (let n = 1; !coordinatorHandle; n++) if (!taken.has(`${coordinatorConfig.provider}${n}`)) coordinatorHandle = `${coordinatorConfig.provider}${n}`;
      }

      const created: Session[] = [];
      try {
        const worker = await this.provision(original.projectId, newHandle, input.agent.configuration, input.agent.isolated);
        created.push(worker);
        const coordinator = coordinatorConfig && coordinatorHandle ? await this.provision(original.projectId, coordinatorHandle, coordinatorConfig, input.agent.isolated) : undefined;
        if (coordinator) created.push(coordinator);

        // Everything may have changed during worktree creation; check again right before persisting.
        this.assertOpen();
        const fresh = this.requireJoinable(original.id);
        if (fresh.projectId !== worker.projectId) throw unprocessable('Agents must belong to the same project');
        const id = newGroupId();
        const members = { original: newMemberId(), worker: newMemberId(), coordinator: coordinator ? newMemberId() : undefined };
        const peer = input.mode === 'cowork';
        this.store.tx(() => {
          this.repo.insertGroup({ id, projectId: original.projectId, title: original.name, anchorSessionId: original.id, mode: input.mode, ...defaults, autonomy: settings.groupDefaults?.autonomy ?? { mode: 'balanced' } });
          const originalRole = input.mode === 'current-leads' ? 'orchestrator' : peer ? 'peer' : 'worker';
          this.repo.insertMember({ id: members.original, groupId: id, sessionId: original.id, handle: originalHandle, role: originalRole });
          this.repo.insertMember({ id: members.worker, groupId: id, sessionId: worker.id, handle: newHandle, role: peer ? 'peer' : 'worker' });
          if (coordinator && coordinatorHandle && members.coordinator) this.repo.insertMember({ id: members.coordinator, groupId: id, sessionId: coordinator.id, handle: coordinatorHandle, role: 'orchestrator' });
          const orchestrator = input.mode === 'current-leads' ? members.original : members.coordinator;
          if (orchestrator) this.repo.updateGroup(id, { orchestratorMemberId: orchestrator });
          if (Object.keys(configPatch).length) this.workspace.updateSession(original.id, configPatch);
          this.event(this.repo.getGroup(id)!, 'group.created', `Group created: ${original.name} (${MODE_LABEL[input.mode]})`, { mode: input.mode, members: [originalHandle, newHandle, ...(coordinatorHandle ? [coordinatorHandle] : [])] }, original.id);
        });
        return this.get(id);
      } catch (error) {
        await this.rollbackSessions(created);
        throw error;
      }
    });
  }

  async addAgent(groupId: string, input: AddGroupAgent): Promise<GroupSnapshot> {
    return this.exclusive(async () => {
      this.assertOpen();
      const group = this.requireGroup(groupId);
      this.checkConfiguration(input.configuration);
      const handle = this.validateHandle(input.handle);
      this.assertHandleFree(group.id, handle);
      this.assertCanChangeRoster(group);
      if (this.repo.members(group.id, false).length >= MAX_MEMBERS) throw conflict(`A group supports at most ${MAX_MEMBERS} agents`);
      const created: Session[] = [];
      try {
        const session = await this.provision(group.projectId, handle, input.configuration, input.isolated);
        created.push(session);
        this.assertOpen();
        const fresh = this.requireGroup(groupId);
        this.assertHandleFree(fresh.id, handle);
        this.assertCanChangeRoster(fresh);
        if (session.projectId !== fresh.projectId) throw unprocessable('Agents must belong to the group project');
        const role = fresh.mode === 'cowork' ? 'peer' : 'worker';
        this.store.tx(() => {
          this.repo.insertMember({ id: newMemberId(), groupId, sessionId: session.id, handle, role });
          this.repo.touchGroup(groupId);
          this.event(fresh, 'group.member.added', `Agent added: @${handle}`, { handle, role }, session.id);
        });
        return this.get(groupId);
      } catch (error) {
        await this.rollbackSessions(created);
        throw error;
      }
    });
  }

  update(groupId: string, patch: Update): GroupSnapshot {
    this.assertOpen();
    let group = this.requireGroup(groupId);
    let members = this.repo.members(group.id, false);
    const structural = patch.mode !== undefined || patch.orchestratorMemberId !== undefined;
    const limits = (['maxParallel', 'maxTurns', 'maxHops'] as const).filter((key) => patch[key] !== undefined && patch[key] !== group[key]);
    const running = this.repo.deliveries(group.id, ['running']);
    if (running.length) throw conflict('Wait for running agents to finish, or stop the group, before changing it');
    const unsettled = this.repo.deliveries(group.id, ['queued', 'failed', 'interrupted']).filter((d) => d.status === 'queued' || d.retryable);

    let mode: GroupMode = patch.mode ?? group.mode;
    let orchestrator: string | null = group.orchestratorMemberId;
    let changedRoles = false;
    if (structural) {
      for (const member of members) if (this.memberBusy(member)) throw conflict(`@${member.handle} is busy. Wait for it to finish before changing the group.`);
      const requested = patch.orchestratorMemberId ? members.find((m) => m.id === patch.orchestratorMemberId) : undefined;
      if (patch.orchestratorMemberId && !requested) throw unprocessable('The orchestrator must be an active member of this group');
      const anchor = members.find((m) => m.sessionId === group.anchorSessionId);
      if (mode === 'cowork') {
        if (patch.orchestratorMemberId) throw unprocessable('Cowork has no orchestrator');
        orchestrator = null;
      } else if (mode === 'current-leads') {
        if (!anchor) throw conflict('The original agent is no longer in this group');
        if (requested && requested.id !== anchor.id) throw unprocessable('In Current agent leads the original agent is the orchestrator');
        orchestrator = anchor.id;
      } else {
        // Orchestrated never creates a provider session implicitly: an existing selection or the previous coordinator is required.
        orchestrator = requested?.id ?? group.orchestratorMemberId;
        if (orchestrator === anchor?.id) throw unprocessable('Orchestrated uses a separate coordinator. Choose another member, or use Current agent leads.');
        if (!orchestrator || !members.some((m) => m.id === orchestrator)) throw unprocessable('Choose an existing member as the orchestrator');
      }
      changedRoles = mode !== group.mode || orchestrator !== group.orchestratorMemberId;
      if (changedRoles && unsettled.length) throw conflict('Queued or retryable work exists. Stop each affected agent to cancel its pending work before changing how agents coordinate.');
    }
    if (limits.length && !group.paused && unsettled.length) throw conflict('Stop the group before changing limits while work is queued');

    const recoveryPolicy = patch.recoveryPolicy ?? group.recoveryPolicy;
    if (recoveryPolicy) this.validateRecoveryPolicy({ ...group, mode, orchestratorMemberId: orchestrator }, members, recoveryPolicy);

    this.store.tx(() => {
      if (changedRoles) {
        // Held deliveries belong to the old structure; they are cancelled visibly rather than silently retargeted.
        for (const d of unsettled) this.repo.setDelivery(d.id, { status: 'cancelled', error: 'Cancelled by a group mode change', retryable: false });
        for (const id of new Set(unsettled.map((d) => d.requestId))) this.refreshRequest(id);
        for (const member of members) {
          const role: GroupMember['role'] = mode === 'cowork' ? 'peer' : member.id === orchestrator ? 'orchestrator' : 'worker';
          if (role !== member.role) this.repo.updateMember(member.id, { role });
        }
        const epoch = (group.coordinatorEpoch ?? 1) + 1;
        this.repo.updateGroup(group.id, { mode, orchestratorMemberId: orchestrator, coordinatorEpoch: epoch });
        const anchorId = members.find((member) => member.sessionId === group.anchorSessionId)?.id;
        const planner = mode === 'cowork' ? anchorId : orchestrator;
        if (planner) this.repo.updateRequestPlanner(group.id, null, planner);
        this.event(group, 'group.mode.changed', `Group mode: ${MODE_LABEL[group.mode]} → ${MODE_LABEL[mode]}`, { from: group.mode, to: mode, orchestratorMemberId: orchestrator, cancelled: unsettled.length });
      }
      if (limits.length) {
        this.repo.updateGroup(group.id, { maxParallel: patch.maxParallel, maxTurns: patch.maxTurns, maxHops: patch.maxHops });
        this.event(group, 'group.limits.changed', 'Group coordination limits updated', Object.fromEntries(limits.map((key) => [key, patch[key]])));
      }
      if (patch.autonomy && JSON.stringify(patch.autonomy) !== JSON.stringify(group.autonomy ?? { mode: 'balanced' })) {
        this.repo.updateGroup(group.id, { autonomy: patch.autonomy });
        this.event(group, 'group.autonomy.changed', `Group autonomy set to ${patch.autonomy.mode}`, { autonomy: patch.autonomy });
      }
      if (recoveryPolicy && JSON.stringify(recoveryPolicy) !== JSON.stringify(group.recoveryPolicy ?? { automaticFallback: false })) {
        this.repo.updateGroup(group.id, { recoveryPolicy });
        this.event(group, 'group.recovery-policy.changed', 'Group recovery policy updated', { recoveryPolicy });
      }
    });
    mode = this.requireGroup(group.id).mode;
    if (limits.includes('maxParallel')) this.schedule(group.id);
    return this.get(group.id);
  }

  removeMember(groupId: string, memberIdArg: string): GroupSnapshot {
    this.assertOpen();
    let group = this.requireGroup(groupId);
    const member = this.requireMember(group, memberIdArg);
    const active = this.repo.members(group.id, false);
    if (member.sessionId === group.anchorSessionId) throw conflict('The original conversation is the group entry. Remove other agents instead.');
    const isTeamProxy = Boolean(this.store.db.prepare('SELECT 1 AS found FROM mingle_team_proxy_sessions WHERE session_id=?').get(member.sessionId));
    const replacement = isTeamProxy && group.orchestratorMemberId === member.id
      ? active.find((candidate) => candidate.id !== member.id && !this.store.db.prepare('SELECT 1 AS found FROM mingle_team_proxy_sessions WHERE session_id=?').get(candidate.sessionId))
      : undefined;
    if (group.orchestratorMemberId === member.id && !replacement) throw conflict('Choose another orchestrator before removing this agent');
    if (active.length <= 2 && !isTeamProxy) throw conflict('A group needs at least two agents');
    if (this.memberBusy(member) || this.repo.memberDeliveries(member.id, ['running']).length) throw conflict(`@${member.handle} is busy. Wait for it to finish or stop it first.`);
    if ([...this.repo.requestsWithStatus(group.id, 'active'), ...this.repo.requestsWithStatus(group.id, 'paused')].some((r) => r.plannerMemberId === member.id && this.repo.requestDeliveries(r.id, OPEN_DELIVERY).length > 0)) throw conflict('This agent holds a live request planning lease');
    const owed = this.repo.activeAssignments(group.id).filter((a) => a.toMemberId === member.id && !(member.held && ['failed', 'interrupted'].includes(this.repo.getDelivery(a.deliveryId)?.status ?? '')));
    if (owed.length) throw conflict(`@${member.handle} still owns ${owed.length} unfinished assignment(s). Wait for them to settle first.`);
    this.store.tx(() => {
      const open = this.repo.memberDeliveries(member.id, ['queued', 'failed', 'interrupted']);
      for (const d of open) this.repo.setDelivery(d.id, { status: 'cancelled', error: 'Member removed from the group', retryable: false });
      for (const id of new Set(open.map((d) => d.requestId))) this.refreshRequest(id);
      if (replacement) {
        this.repo.updateGroup(group.id, { orchestratorMemberId: replacement.id, coordinatorEpoch: (group.coordinatorEpoch ?? 1) + 1 });
        for (const candidate of active) {
          if (candidate.id === member.id) continue;
          const role: GroupMember['role'] = group.mode === 'cowork' ? 'peer' : candidate.id === replacement.id ? 'orchestrator' : 'worker';
          if (candidate.role !== role) this.repo.updateMember(candidate.id, { role });
        }
      }
      this.repo.updateMember(member.id, { removedAt: nowIso(), held: false });
      this.repo.touchGroup(group.id);
      this.event(group, 'group.member.removed', `Agent removed: @${member.handle}`, { memberId: member.id, handle: member.handle, cancelled: open.length }, member.sessionId);
    });
    this.schedule(group.id);
    return this.get(group.id);
  }

  /** Hides a whole group only after its queue is fenced and every member runtime releases its cleanup lock. */
  async delete(groupId: string): Promise<void> {
    return this.exclusive(async () => {
      this.assertOpen();
      const group = this.requireGroup(groupId);
      if (this.deletingGroups.has(group.id)) throw conflict('This group is already being removed.');
      if (!this.runtime.withSessionsStopped) throw conflict('The runtime cannot safely stop every group session for deletion.');
      this.deletingGroups.add(group.id);
      try {
        const deliveries = this.repo.deliveries(group.id);
        for (const delivery of deliveries) {
          const timer = this.safeRetryTimers.get(delivery.id);
          if (timer) clearTimeout(timer);
          this.safeRetryTimers.delete(delivery.id);
        }
        this.pending.delete(group.id);
        this.store.tx(() => {
          this.repo.updateGroup(group.id, { paused: true, pauseReason: 'Group deletion is stopping agents and cancelling pending work.' });
          for (const delivery of deliveries) {
            if (delivery.status === 'queued' || delivery.status === 'failed' || delivery.status === 'interrupted') {
              this.repo.setDelivery(delivery.id, { status: 'cancelled', error: 'Cancelled because the group was deleted from Mingle', retryable: false });
            }
          }
          for (const request of this.repo.requests(group.id, 1000)) if (request.status !== 'completed') this.refreshRequest(request.id, true);
          this.event(group, 'group.deletion.started', `Stopping group: ${group.title}`, { memberCount: this.repo.members(group.id).length }, group.anchorSessionId);
        });

        const sessionIds = this.repo.members(group.id).map((member) => member.sessionId);
        await this.runtime.withSessionsStopped!(sessionIds, () => this.store.tx(() => {
          for (const delivery of this.repo.deliveries(group.id)) {
            if (delivery.status !== 'queued' && delivery.status !== 'running' && delivery.status !== 'failed' && delivery.status !== 'interrupted') continue;
            if (delivery.status === 'running' && delivery.taskId) this.tasks.finishRun(delivery.taskId, 'interrupted');
            this.repo.setDelivery(delivery.id, { status: 'cancelled', error: 'Cancelled because the group was deleted from Mingle', retryable: false });
          }
          for (const sessionId of new Set(sessionIds)) if (this.store.getSession(sessionId)) this.workspace.archiveSession(sessionId);
          this.repo.archiveGroup(group.id);
          this.event(group, 'group.archived', `Group deleted from Mingle: ${group.title}`, {
            retained: ['conversation history', 'recovery records', 'project files', 'worktrees', 'branches'],
          }, group.anchorSessionId);
          this.store.touch();
        }));
      } finally {
        this.deletingGroups.delete(group.id);
      }
    });
  }

  // ---------------------------------------------------------------- user messages

  async send(groupId: string, input: { content: string; recipients?: string[]; intent?: 'normal' | 'plan'; clientMessageId?: string; attachmentIds?: string[]; contextRefs?: MessageContextRef[]; invocation?: NativeInvocationInput; executionPlanId?: string }): Promise<GroupSnapshot> {
    this.assertOpen();
    let group = this.requireGroup(groupId);
    if (input.clientMessageId && this.repo.messageByClientId(group.id, input.clientMessageId)) return this.snapshot(group);
    let members = this.repo.members(group.id, false);
    const content = clean(input.content, 100_000);
    const intent = input.intent ?? 'normal';
    if (intent === 'plan' && input.invocation) throw unprocessable('Native read-only plan mode accepts a regular planning prompt, not provider commands or skills.');
    if (intent === 'plan' && /^\s*(?:@[A-Za-z0-9_-]+(?:\s*,\s*|\s+))*[/$][A-Za-z0-9]/.test(content)) throw unprocessable('Native read-only plan mode accepts a regular planning prompt, not provider commands or skills.');
    let invocation: GroupInvocation | undefined;
    let requested = input.recipients;
    let sendContent = content;
    if (input.invocation) {
      const member = members.find((m) => m.id === input.invocation!.recipient || m.handle === input.invocation!.recipient.replace(/^@/, '').toLowerCase());
      if (!member) throw unprocessable('Choose one active group agent for this provider action.');
      if (requested?.length && (requested.length !== 1 || requested[0] !== member.id)) throw unprocessable('A provider command or skill must address exactly one agent.');
      const session = this.store.getSession(member.sessionId);
      if (!session) throw conflict(`@${member.handle} is unavailable.`);
      if (!this.catalog) throw conflict('Provider command discovery is unavailable. Refresh and try again.');
      invocation = { kind: input.invocation.kind, id: input.invocation.id, name: input.invocation.name, arguments: input.invocation.arguments, memberId: member.id, sessionId: session.id, provider: session.provider, model: session.model };
      requested = [member.id];
      if (input.attachmentIds?.length && session.provider === 'opencode') throw unprocessable('OpenCode native slash commands cannot carry attachments. Remove the attachments or send a regular message.');
    }
    if (input.attachmentIds?.length && !this.attachments) throw conflict('Attachments are unavailable in this Mingle session.');
    const attachmentRows = this.attachments?.validate({ kind: 'group', id: groupId }, input.attachmentIds ?? []) ?? [];
    for (const ref of input.contextRefs ?? []) {
      if (ref.kind === 'file') {
        if (!this.repo.members(group.id, true).some((candidate) => candidate.sessionId === ref.sourceSessionId)) throw unprocessable('A file reference must come from a session in this group.');
        continue;
      }
      const sourceMember = this.repo.members(group.id, true).find((candidate) => candidate.sessionId === ref.sourceSessionId);
      if (ref.sourceGroupId !== group.id || !sourceMember) throw unprocessable('A quoted source must be an assistant message from this group.');
      validateQuoteCitation(ref, this.store.getMessage(ref.sourceMessageId));
    }
    // File content is loaded by startDelivery after this durable request has been returned to the client.
    group = this.requireGroup(groupId);
    members = this.repo.members(group.id, false);
    if (invocation) {
      const member = members.find((candidate) => candidate.id === invocation!.memberId);
      const session = member ? this.store.getSession(member.sessionId) : undefined;
      if (!member || !session || member.sessionId !== invocation.sessionId || session.provider !== invocation.provider || session.model !== invocation.model) {
        throw conflict('The selected group agent or its settings changed while validating message context. Refresh and send again.');
      }
    }
    let route = invocation
      ? { recipients: [members.find((m) => m.id === invocation!.memberId)!], runners: [members.find((m) => m.id === invocation!.memberId)!], planner: members.find((m) => m.id === invocation!.memberId)! }
      : this.route(group, members, requested, sendContent);
    if (intent === 'plan') {
      if (route.recipients.length !== 1) throw unprocessable('Native plan mode must target exactly one group agent. Choose one recipient or mention one @handle.');
      const target = route.recipients[0]!;
      route = { recipients: [target], runners: [target], planner: target };
    }
    let executionPlan: SessionPlan | undefined;
    if (input.executionPlanId) {
      executionPlan = this.store.getSessionPlan(input.executionPlanId);
      const target = route.recipients.length === 1 ? this.store.getSession(route.recipients[0]!.sessionId) : undefined;
      if (intent !== 'normal' || invocation || input.attachmentIds?.length || !executionPlan || executionPlan.sessionId !== target?.id
        || executionPlan.status !== 'approved' || executionPlan.approvedRevision !== executionPlan.revision) {
        throw conflict('The approved plan or its group agent changed. Review the plan again before execution.');
      }
    }
    if (attachmentRows.some((row) => row.kind === 'image')) {
      for (const member of route.recipients) {
        const recipient = this.store.getSession(member.sessionId);
        if (!recipient) throw conflict(`@${member.handle} is unavailable.`);
        const info = this.providers?.().find((row) => row.id === recipient.provider);
        const model = info?.models.find((candidate) => candidate.id === recipient.model || candidate.aliases?.includes(recipient.model));
        const supports = model?.inputModalities ? model.inputModalities.includes('image') : info?.promptCapabilities?.image === true;
        if (!supports) throw unprocessable(`${recipient.provider} has not reported image input for @${member.handle}, so no message was queued.`);
        if (recipient.provider === 'claude' && attachmentRows.some((row) => row.kind === 'image' && row.size > 5 * 1024 * 1024)) throw unprocessable('Claude image attachments are limited to 5 MiB each. Remove the large image or resize it before sending.');
      }
    }
    for (const member of route.recipients) if (!this.store.getSession(member.sessionId)) throw conflict(`@${member.handle} is archived. Remove it from the group first.`);
    this.store.tx(() => {
      const message = this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: route.recipients.map((m) => m.id), kind: 'user', content: sendContent, clientMessageId: input.clientMessageId ?? null, invocation, contextRefs: input.contextRefs });
      if (input.attachmentIds?.length) this.attachments?.claim({ kind: 'group', id: groupId }, input.attachmentIds, 'group_message', message.id);
      const requestId = newRequestId();
      this.repo.insertRequest({ id: requestId, groupId: group.id, messageId: message.id, plannerMemberId: route.planner.id, intent, executionPlanId: executionPlan?.id });
      if (executionPlan) {
        const current = this.store.getSessionPlan(executionPlan.id);
        if (!current || current.status !== 'approved' || current.approvedRevision !== current.revision || current.sessionId !== executionPlan.sessionId) {
          throw conflict('The approved plan changed before it could be queued. Review it again before execution.');
        }
        const executing = { ...current, status: 'executing' as const, executionRunId: null, updatedAt: nowIso() };
        this.store.updateSessionPlan(executing);
        this.store.recordEvent({ projectId: group.projectId, sessionId: current.sessionId, type: 'session.plan.execution.queued', summary: `Approved plan queued (revision ${current.revision})`, payload: { planId: current.id, revision: current.revision, requestId } });
      }
      this.repo.updateMember(route.planner.id, {});
      for (const member of route.runners) this.repo.insertDelivery({ id: deliveryId(), groupId: group.id, requestId, messageId: message.id, memberId: member.id, kind: 'request', hop: 0 });
      this.repo.touchGroup(group.id);
      this.event(group, 'group.message.sent', group.paused ? 'Group message queued (group is paused)' : 'Group message sent', {
        messageId: message.id, requestId, recipients: route.recipients.map((m) => m.handle), runners: route.runners.map((m) => m.handle), paused: group.paused,
      });
    });
    this.schedule(group.id);
    return this.get(group.id);
  }

  async executePlan(sessionId: string, planId: string, prompt: string): Promise<{ deliveryId: string; runId: string | null }> {
    this.assertOpen();
    const plan = this.store.getSessionPlan(planId);
    const member = this.repo.activeMemberOfSession(sessionId);
    if (!plan || plan.sessionId !== sessionId || !member) throw conflict('This plan is no longer attached to an active group agent.');
    const sourceMessage = this.planInputMessage(plan.id, member.groupId, member.id);
    if (!sourceMessage) throw conflict('The original plan inputs are no longer available. Replan with the current group agent.');
    const snapshot = await this.send(member.groupId, {
      content: prompt, recipients: [member.id], executionPlanId: plan.id,
      ...(sourceMessage.contextRefs?.length ? { contextRefs: sourceMessage.contextRefs } : {}),
      clientMessageId: `plan-execution-${plan.id}-${plan.revision}`,
    });
    const request = snapshot.requests.find((row) => row.executionPlanId === plan.id);
    const delivery = request && snapshot.deliveries.find((row) => row.requestId === request.id && row.kind === 'request' && row.memberId === member.id);
    if (!delivery) throw conflict('The approved plan request was saved but its group delivery is unavailable. Refresh the conversation.');
    return { deliveryId: delivery.id, runId: delivery.runId };
  }

  private planInputMessage(planId: string, groupId: string, memberId: string): GroupMessage | undefined {
    const plan = this.store.getSessionPlan(planId);
    if (!plan) return undefined;
    const sourceDelivery = this.repo.deliveryByRun(plan.runId);
    if (!sourceDelivery || sourceDelivery.groupId !== groupId || sourceDelivery.memberId !== memberId || sourceDelivery.kind !== 'request') return undefined;
    const sourceRequest = this.repo.getRequest(sourceDelivery.requestId);
    if (!sourceRequest || sourceRequest.intent !== 'plan' || sourceRequest.messageId !== sourceDelivery.messageId) return undefined;
    return this.repo.getMessage(sourceDelivery.messageId);
  }

  /** Explicit human task run preserves the existing task and follows the durable group queue. */
  runTask(taskId: string): GroupSnapshot {
    this.assertOpen();
    const task = this.tasks.assertRunnable(taskId);
    const member = this.repo.activeMemberOfSession(task.sessionId!);
    if (!member) throw conflict('This task is not assigned to an agent in a group');
    const group = this.requireGroup(member.groupId);
    if (task.projectId !== group.projectId) throw unprocessable('Task belongs to a different project');
    if (this.repo.deliveries(group.id, OPEN_DELIVERY).some((d) => d.taskId === task.id)) return this.get(group.id);
    const content = clean(this.tasks.buildPrompt(task), 100_000);
    this.store.tx(() => {
      const message = this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: [member.id], kind: 'user', content });
      const requestId = newRequestId();
      this.repo.insertRequest({ id: requestId, groupId: group.id, messageId: message.id, plannerMemberId: member.id });
      this.repo.insertDelivery({ id: deliveryId(), groupId: group.id, requestId, messageId: message.id, memberId: member.id, kind: 'request', hop: 0, taskId: task.id });
      this.repo.touchGroup(group.id);
      this.event(group, 'group.task.queued', `Task queued for @${member.handle}: ${task.title}`, { taskId: task.id, requestId }, member.sessionId);
    });
    this.schedule(group.id);
    return this.get(group.id);
  }

  private route(group: ConversationGroup, members: MemberRow[], explicit: string[] | undefined, content: string): { recipients: MemberRow[]; runners: MemberRow[]; planner: MemberRow } {
    if (!members.length) throw conflict('This group has no active agents');
    const byId = new Map(members.map((m) => [m.id, m]));
    const retired = new Set(this.repo.members(group.id).filter((m) => m.removedAt).flatMap((m) => [m.id, m.handle]));
    const resolveOne = (reference: string, label: string): MemberRow => {
      const direct = byId.get(reference) ?? members.find((m) => m.handle === reference.toLowerCase());
      if (direct) return direct;
      if (retired.has(reference) || retired.has(reference.toLowerCase())) throw unprocessable(`${label} was removed from this group`);
      const providerMatches = members.filter((m) => this.store.getSession(m.sessionId)?.provider === reference.toLowerCase());
      if (['codex', 'claude', 'antigravity', 'opencode'].includes(reference.toLowerCase())) {
        if (providerMatches.length === 1) return providerMatches[0]!;
        throw unprocessable(providerMatches.length ? `${label} matches several agents; use a specific handle such as @${providerMatches[0]!.handle}` : `No active agent matches ${label}`);
      }
      throw unprocessable(`Unknown recipient ${label}. Active agents: ${members.map((m) => `@${m.handle}`).join(', ')}`);
    };
    let recipients: MemberRow[];
    let directed = true;
    if (explicit?.length) recipients = explicit.map((id) => resolveOne(id, id));
    else {
      const mentions = extractMentions(content);
      if (mentions.length) recipients = mentions.map((handle) => resolveOne(handle, `@${handle}`));
      else {
        directed = false;
        if (group.mode === 'cowork') recipients = members;
        else {
          const lead = members.find((m) => m.id === group.orchestratorMemberId);
          if (!lead) throw conflict('This group has no active orchestrator');
          recipients = [lead];
        }
      }
    }
    recipients = [...new Map(recipients.map((m) => [m.id, m])).values()];
    if (directed) return { recipients, runners: recipients, planner: group.mode === 'cowork' ? recipients[0]! : members.find((m) => m.id === group.orchestratorMemberId) ?? recipients[0]! };
    if (group.mode === 'cowork') {
      // Every peer receives the request, but only the original agent plans; the others wait for a scoped assignment.
      const planner = members.find((m) => m.sessionId === group.anchorSessionId) ?? members[0]!;
      return { recipients, runners: [planner], planner };
    }
    return { recipients, runners: recipients, planner: recipients[0]! };
  }

  // ---------------------------------------------------------------- stop / resume / recovery

  /** Pauses automatic scheduling; existing provider runs can finish, but cannot mutate team state while paused. */
  pause(groupId: string): GroupSnapshot {
    this.assertOpen();
    const group = this.requireGroup(groupId);
    this.store.tx(() => {
      this.repo.updateGroup(group.id, { paused: true, pauseReason: 'Paused by the user. Resume to continue queued work.' });
      for (const request of this.repo.requestsWithStatus(group.id, 'active')) this.refreshRequest(request.id, true);
      this.event(group, 'group.paused', 'Group scheduling paused');
    });
    return this.get(group.id);
  }

  /** Persists the queue hold before interrupting every active native member. */
  stop(groupId: string): GroupSnapshot {
    this.pause(groupId);
    const group = this.requireGroup(groupId);
    this.repo.updateGroup(group.id, { paused: true, pauseReason: 'Stopped by the user. Resume to continue queued work.' });
    const running = this.repo.deliveries(group.id, ['running']);
    this.event(group, 'group.stopped', 'Group stopped', { interrupting: running.map((d) => d.memberId) });
    for (const delivery of running) this.interruptMember(delivery.memberId);
    return this.get(group.id);
  }

  /** Human-directed, durable recovery actions. Repeated idempotency keys return the stored result. */
  async recoverAction(groupId: string, action: RecoveryActionRequest): Promise<RecoveryActionResult> {
    return this.exclusive(async () => {
      this.assertOpen();
      const prior = this.repo.getRecoveryAction(groupId, action.idempotencyKey);
      if (prior) return { ...prior, status: 'already-applied' };
      const group = this.requireGroup(groupId);
      let captured: RecoveryCheckpoint | null = null;
      if (action.action === 'pause-for-human') {
        const delivery = action.deliveryId ? this.recoveryDelivery(group, action.deliveryId) : null;
        const memberId = delivery?.memberId ?? group.orchestratorMemberId
          ?? this.repo.members(group.id, false).find((row) => row.sessionId === group.anchorSessionId)?.id;
        const member = memberId ? this.requireMember(group, memberId) : undefined;
        const session = member ? this.store.getSession(member.sessionId) : undefined;
        if (!session) throw conflict('No group session is available to capture a recovery checkpoint');
        const captureTarget = { member: member!, delivery };
        captured = await this.recovery!.capture(session.id, action.reason.slice(0, 200), delivery?.runId ?? undefined);
        this.assertRecoveryCaptureCurrent(group, captureTarget);
      }
      const currentGroup = action.action === 'pause-for-human' ? this.requireGroup(groupId) : group;
      const result: RecoveryActionResult = {
        actionId: newId('msg'), groupId, action: action.action, status: 'applied', coordinatorEpoch: currentGroup.coordinatorEpoch ?? 1,
      };
      const plannerRequestId = 'requestId' in action && typeof action.requestId === 'string' ? action.requestId : undefined;
      this.store.tx(() => {
        let reviewedCheckpointId: string | undefined;
        let reviewedRequestId: string | undefined;
        switch (action.action) {
          case 'retry-delivery': {
            const delivery = this.recoveryDelivery(currentGroup, action.deliveryId);
            this.applyRetryAction(currentGroup, action, result.actionId);
            reviewedCheckpointId = action.checkpointId;
            reviewedRequestId = delivery.requestId;
            break;
          }
          case 'fallback-delivery': {
            const delivery = this.recoveryDelivery(currentGroup, action.deliveryId);
            this.applyFallbackAction(currentGroup, action, result.actionId);
            reviewedCheckpointId = action.checkpointId;
            reviewedRequestId = delivery.requestId;
            break;
          }
          case 'replace-coordinator': {
            this.applyCoordinatorReplacement(currentGroup, action.replacementMemberId, false, action.checkpointId, plannerRequestId);
            reviewedCheckpointId = action.checkpointId;
            reviewedRequestId = plannerRequestId ?? (action.checkpointId ? this.repo.getRecoveryCheckpoint(currentGroup.id, action.checkpointId)?.requestId ?? undefined : undefined);
            break;
          }
          case 'pause-for-human': this.applyPauseForHuman(currentGroup, action.deliveryId ?? null, action.reason, captured!, action.idempotencyKey); break;
          case 'acknowledge-checkpoint': this.acknowledgeCheckpoint(currentGroup, action.checkpointId); break;
          case 'resume': this.applyRecoveryResume(currentGroup); break;
        }
        if (reviewedCheckpointId && reviewedRequestId) this.releaseReviewedRecoveryHold(currentGroup, reviewedCheckpointId, reviewedRequestId);
        result.coordinatorEpoch = this.repo.getGroup(currentGroup.id)?.coordinatorEpoch ?? result.coordinatorEpoch;
        this.repo.insertRecoveryAction({ id: result.actionId, groupId, idempotencyKey: action.idempotencyKey, action: action.action, result });
      });
      this.schedule(groupId);
      return result;
    });
  }

  private recoveryDelivery(group: ConversationGroup, id: string): DeliveryRow {
    const delivery = this.repo.getDelivery(id);
    if (!delivery || delivery.groupId !== group.id) throw notFound('Delivery not found in this group');
    return delivery;
  }

  private assertRecoveryCaptureCurrent(group: ConversationGroup, target: { member: MemberRow; delivery: DeliveryRow | null }): void {
    const fresh = this.requireGroup(group.id);
    const epochChanged = (fresh.coordinatorEpoch ?? 1) !== (group.coordinatorEpoch ?? 1);
    const configChanged = fresh.projectId !== group.projectId || fresh.anchorSessionId !== group.anchorSessionId
      || fresh.mode !== group.mode || fresh.orchestratorMemberId !== group.orchestratorMemberId
      || fresh.maxParallel !== group.maxParallel || fresh.maxTurns !== group.maxTurns || fresh.maxHops !== group.maxHops
      || JSON.stringify(fresh.autonomy ?? null) !== JSON.stringify(group.autonomy ?? null)
      || JSON.stringify(fresh.recoveryPolicy ?? null) !== JSON.stringify(group.recoveryPolicy ?? null);
    if (epochChanged || configChanged) throw conflict('The group configuration changed while its recovery checkpoint was being captured. Review the current group state and try again.');

    const member = this.requireMember(fresh, target.member.id);
    if (member.sessionId !== target.member.sessionId || member.role !== target.member.role || member.held !== target.member.held
      || !this.store.getSession(member.sessionId)) {
      throw conflict('The checkpoint session is no longer an active group member. Review the current group state and try again.');
    }
    if (target.delivery) {
      const current = this.recoveryDelivery(fresh, target.delivery.id);
      if (current.memberId !== target.delivery.memberId || current.memberId !== member.id || current.requestId !== target.delivery.requestId
        || current.status !== target.delivery.status || current.runId !== target.delivery.runId || current.updatedAt !== target.delivery.updatedAt) {
        throw conflict('The delivery changed while its recovery checkpoint was being captured. Review the current delivery and try again.');
      }
    }
  }

  private assertNoRecoverySuccessor(group: ConversationGroup, source: DeliveryRow): void {
    const successor = this.repo.deliverySuccessor(group.id, source.id);
    if (successor) throw conflict(`This delivery already has recovery continuation ${successor}`);
  }

  private existingRecoveryContinuation(group: ConversationGroup, source: DeliveryRow, targetMemberId?: string): DeliveryRow | undefined {
    return this.repo.requestDeliveries(source.requestId, OPEN_DELIVERY).find((row) => row.id !== source.id && (!targetMemberId || row.memberId === targetMemberId)
      && (source.assignmentId ? row.assignmentId === source.assignmentId : row.kind === 'request' || row.kind === 'result'));
  }

  private linkRecoverySuccessor(group: ConversationGroup, source: DeliveryRow, successorId: string): void {
    if (!this.repo.linkDeliverySuccessor(group.id, source.requestId, source.id, successorId)) {
      throw conflict('This recovery continuation is already linked to another delivery');
    }
  }

  private recoveryCheckpoint(
    group: ConversationGroup, checkpointId: string | undefined, failure: ProviderFailure | null, requestIdArg?: string, deliveryIdArg?: string,
  ): GroupRecoveryCheckpointRow | undefined {
    const requiresCheckpoint = Boolean(failure && (failure.outcomeUnknown === true || failure.dispatchState === 'unknown' || failure.continuationSafety !== 'safe'));
    if (!checkpointId) {
      if (requiresCheckpoint) throw conflict('This provider outcome is uncertain. Capture and acknowledge a recovery checkpoint before retrying or reassigning it.');
      return undefined;
    }
    const checkpoint = this.repo.getRecoveryCheckpoint(group.id, checkpointId);
    if (!checkpoint) throw notFound('Recovery checkpoint not found in this group');
    if (checkpoint.state !== 'acknowledged') throw conflict('Acknowledge the recovery checkpoint before continuing this delivery');
    if (requestIdArg && checkpoint.requestId && checkpoint.requestId !== requestIdArg) throw conflict('This checkpoint belongs to a different group request');
    if (deliveryIdArg) {
      const linked = checkpoint.payload.deliveryId === deliveryIdArg
        || (Array.isArray(checkpoint.payload.deliveryIds) && checkpoint.payload.deliveryIds.includes(deliveryIdArg));
      if ((checkpoint.payload.deliveryId !== undefined || checkpoint.payload.deliveryIds !== undefined) && !linked) {
        throw conflict('This checkpoint does not describe the delivery being recovered');
      }
    }
    return checkpoint;
  }

  private validateHandoffCheckpoint(checkpoint: RecoveryCheckpoint, sessionId: string, runId?: string): void {
    if (checkpoint.sessionId !== sessionId || (runId && checkpoint.runId !== runId)) throw conflict('Recovery checkpoint does not describe the source session and run');
    if (!checkpoint.worktree.statusKnown) throw conflict('Recovery checkpoint could not verify source worktree state; ask for human review');
    if (checkpoint.pendingApprovals.length) throw conflict('Recovery checkpoint contains pending approvals; ask for human review');
    if (checkpoint.uncertainTools.some((tool) => tool.status !== 'completed')) throw conflict('Recovery checkpoint contains an uncertain tool outcome; ask for human review');
  }

  private acknowledgedNativeCheckpoint(group: ConversationGroup, checkpoint: GroupRecoveryCheckpointRow | undefined, sessionId: string, runId?: string): RecoveryCheckpoint | undefined {
    if (!checkpoint) return undefined;
    const providerCheckpointId = typeof checkpoint.payload.providerCheckpointId === 'string' ? checkpoint.payload.providerCheckpointId : undefined;
    const native = providerCheckpointId ? this.recovery?.latest(sessionId) : null;
    if (!native || native.id !== providerCheckpointId) throw conflict('The acknowledged group checkpoint does not resolve to its captured native worktree checkpoint');
    this.validateHandoffCheckpoint(native, sessionId, runId);
    return native;
  }

  private applyRetryAction(group: ConversationGroup, action: Extract<RecoveryActionRequest, { action: 'retry-delivery' }>, actionId: string): void {
    const delivery = this.recoveryDelivery(group, action.deliveryId);
    if (delivery.status !== 'failed' && delivery.status !== 'interrupted') throw conflict('Only a failed or interrupted delivery can be retried');
    this.assertNoRecoverySuccessor(group, delivery);
    const member = this.requireMember(group, delivery.memberId);
    const session = this.store.getSession(member.sessionId);
    if (!session || this.sessionBusy(session) || this.repo.memberDeliveries(member.id, ['running']).length) throw conflict(`Wait for @${member.handle} to finish provider cleanup before retrying`);
    const failure = delivery.runId ? this.recovery?.failureForRun(delivery.runId) ?? null : null;
    const checkpoint = this.recoveryCheckpoint(group, action.checkpointId, failure, delivery.requestId, delivery.id);
    const request = this.repo.getRequest(delivery.requestId);
    if (!request) throw conflict('The delivery request no longer exists');
    const limit = effectiveTurnLimit(group);
    if (limit !== null && request.turnsUsed + this.repo.requestDeliveries(request.id, ['queued']).length >= limit) throw conflict(`The request turn budget (${limit}) has been reached`);
    if (delivery.hop > group.maxHops) throw conflict(`The message hop limit (${group.maxHops}) has been reached`);
    const existing = this.existingRecoveryContinuation(group, delivery);
    if (existing) {
      this.linkRecoverySuccessor(group, delivery, existing.id);
      this.repo.setDelivery(delivery.id, { retryable: false });
      this.repo.updateMember(member.id, { held: false });
      this.repo.updateRequest(request.id, { status: 'active' });
      return;
    }
    const priorMessage = this.repo.getMessage(delivery.messageId)?.content ?? '';
    const task = delivery.assignmentId ? this.store.getTask(this.repo.getAssignment(delivery.assignmentId)?.taskId ?? '') : undefined;
    const approach = clean(action.approachNote?.trim() ?? '', 1000);
    const content = task
      ? `Recovery retry for existing task ${task.id}: ${task.title}\nContinue from the current worktree and inspect completed side effects before acting. Do not repeat completed effects.\n${approach ? `New approach: ${approach}\n` : ''}${checkpoint ? `Acknowledged checkpoint: ${checkpoint.id}\n` : ''}\n${clean(task.description, 6000)}`
      : `Recovery continuation for failed delivery ${delivery.id}. Do not replay actions that may already have completed; inspect the current workspace and continue the request from its present state.\n${approach ? `New approach: ${approach}\n` : ''}${checkpoint ? `Acknowledged checkpoint: ${checkpoint.id}\n` : ''}\nOriginal context:\n${clean(priorMessage, 6000)}`;
    const message = this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: [member.id], kind: 'status', requestId: request.id, content: truncate(content, 12_000) });
    if (delivery.assignmentId && task) {
      if (task.status === 'done') throw conflict('The assignment task was already accepted as done');
      const nextId = deliveryId();
      this.repo.insertDelivery({ id: nextId, groupId: group.id, requestId: request.id, messageId: message.id, memberId: member.id, kind: 'assignment', hop: delivery.hop, assignmentId: delivery.assignmentId, taskId: task.id, coordinatorEpoch: group.coordinatorEpoch });
      this.repo.reassignAssignment(delivery.assignmentId, member.id, nextId);
      this.linkRecoverySuccessor(group, delivery, nextId);
    } else {
      const nextId = deliveryId();
      this.repo.insertDelivery({ id: nextId, groupId: group.id, requestId: request.id, messageId: message.id, memberId: member.id, kind: 'result', hop: delivery.hop, coordinatorEpoch: group.coordinatorEpoch });
      this.linkRecoverySuccessor(group, delivery, nextId);
    }
    this.repo.setDelivery(delivery.id, { retryable: false });
    this.repo.updateMember(member.id, { held: false });
    this.repo.updateRequest(request.id, { status: 'active' });
    this.repo.updateGroup(group.id, { recoveryState: { status: 'recovering', activeRequestId: request.id, updatedAt: nowIso() } });
    this.event(group, 'group.recovery.retry', `Recovery continuation queued for @${member.handle}`, { deliveryId: delivery.id, actionId, checkpointId: checkpoint?.id ?? null }, member.sessionId);
  }

  private applyFallbackAction(group: ConversationGroup, action: Extract<RecoveryActionRequest, { action: 'fallback-delivery' }>, actionId: string): void {
    const delivery = this.recoveryDelivery(group, action.deliveryId);
    if (delivery.kind !== 'assignment' || !delivery.assignmentId || (delivery.status !== 'failed' && delivery.status !== 'interrupted')) {
      throw conflict('Only a failed or interrupted assignment delivery can be reassigned');
    }
    this.assertNoRecoverySuccessor(group, delivery);
    const assignment = this.repo.getAssignment(delivery.assignmentId);
    const task = assignment ? this.store.getTask(assignment.taskId) : undefined;
    const source = this.requireMember(group, delivery.memberId);
    const target = this.requireMember(group, action.replacementMemberId);
    const sourceSession = this.store.getSession(source.sessionId);
    const targetSession = this.store.getSession(target.sessionId);
    if (!assignment || !task || task.status === 'done') throw conflict('The assignment task is unavailable or already accepted');
    if (!sourceSession || this.sessionBusy(sourceSession) || this.repo.memberDeliveries(source.id, ['running']).length) throw conflict(`Wait for @${source.handle} to finish cleanup before transferring the assignment`);
    if (target.id === source.id || target.held || !targetSession || this.sessionBusy(targetSession) || this.repo.memberDeliveries(target.id, ['queued', 'running']).length) throw conflict(`@${target.handle} must be active and idle before receiving this assignment`);
    if (task.status === 'running') throw conflict('The task is still marked running; wait for its owner to settle before reassignment');
    const failure = delivery.runId ? this.recovery?.failureForRun(delivery.runId) ?? null : null;
    if (sourceSession.worktreePath !== targetSession.worktreePath && !action.checkpointId) throw conflict('Reassignment to a different worktree requires an acknowledged source recovery checkpoint');
    const checkpoint = this.recoveryCheckpoint(group, action.checkpointId, failure, delivery.requestId, delivery.id);
    if (this.existingRecoveryContinuation(group, delivery)) throw conflict('A queued or running successor already owns this assignment');
    this.assertNoTargetTaskConflict(group, target, targetSession.worktreePath, assignment.scope, assignment.id);
    const request = this.repo.getRequest(delivery.requestId);
    if (!request) throw conflict('The assignment request no longer exists');
    const limit = effectiveTurnLimit(group);
    if (limit !== null && request.turnsUsed + this.repo.requestDeliveries(request.id, ['queued']).length >= limit) throw conflict(`The request turn budget (${limit}) has been reached`);
    const old = this.repo.getMessage(delivery.messageId)?.content ?? task.description;
    const sourceCheckpointId = typeof checkpoint?.payload.providerCheckpointId === 'string' ? checkpoint.payload.providerCheckpointId : undefined;
    const sourceCheckpoint = sourceCheckpointId ? this.recovery?.latest(source.sessionId) : null;
    if (sourceSession.worktreePath !== targetSession.worktreePath && (!sourceCheckpoint || sourceCheckpoint.id !== sourceCheckpointId)) {
      throw conflict('The acknowledged checkpoint does not contain source worktree references for this reassignment');
    }
    const sourceReferences = sourceSession.worktreePath !== targetSession.worktreePath && sourceCheckpoint ?
      `Source worktree ${sourceCheckpoint.worktree.path}; branch ${sourceCheckpoint.worktree.branch ?? 'unknown'}; HEAD ${sourceCheckpoint.worktree.head ?? 'unknown'}; dirty paths ${sourceCheckpoint.worktree.dirtyPaths.join(', ') || 'none reported'}${sourceCheckpoint.worktree.dirtyPathsTruncated ? ' (list truncated)' : ''}. Inspect or integrate those references; this target worktree does not automatically contain the source edits.\nAcceptance: ${task.acceptanceCriteria}\n` : '';
    const message = this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: [target.id], kind: 'assignment', requestId: request.id,
      content: truncate(`Reassigned continuation of task ${task.id}: ${task.title}. Inspect existing changes and do not repeat completed side effects.\nScope: ${assignment.scope.join(', ')}\n${checkpoint ? `Acknowledged checkpoint: ${checkpoint.id}\n` : ''}${sourceReferences}${clean(old, 6000)}`, 12_000) });
    const nextId = deliveryId();
    this.store.updateTask(task.id, { sessionId: target.sessionId });
    this.repo.insertDelivery({ id: nextId, groupId: group.id, requestId: request.id, messageId: message.id, memberId: target.id, kind: 'assignment', hop: delivery.hop, assignmentId: assignment.id, taskId: task.id, coordinatorEpoch: group.coordinatorEpoch });
    this.repo.reassignAssignment(assignment.id, target.id, nextId);
    this.linkRecoverySuccessor(group, delivery, nextId);
    this.repo.setDelivery(delivery.id, { retryable: false });
    this.repo.updateMember(source.id, { held: true });
    this.repo.updateRequest(request.id, { status: 'active' });
    this.repo.updateGroup(group.id, { recoveryState: { status: 'recovering', activeRequestId: request.id, updatedAt: nowIso() } });
    this.event(group, 'group.assignment.reassigned', `Assignment moved from @${source.handle} to @${target.handle}`, { assignmentId: assignment.id, deliveryId: delivery.id, replacementDeliveryId: nextId, actionId, checkpointId: checkpoint?.id ?? null }, target.sessionId);
  }

  private assertNoTargetTaskConflict(group: ConversationGroup, target: MemberRow, worktreePath: string, scope: string[], exceptAssignmentId: string): void {
    for (const assignment of this.repo.activeAssignments(group.id)) {
      if (assignment.id === exceptAssignmentId) continue;
      const delivery = this.repo.getDelivery(assignment.deliveryId);
      const owner = this.repo.getMember(assignment.toMemberId);
      const ownerSession = owner ? this.store.getSession(owner.sessionId) : undefined;
      if (!delivery || !owner || !ownerSession || ownerSession.worktreePath !== worktreePath) continue;
      const task = this.store.getTask(assignment.taskId);
      if (assignment.toMemberId === target.id && (OPEN_DELIVERY.includes(delivery.status) || delivery.retryable || task?.status === 'running')) {
        throw conflict(`@${target.handle} already owns live or retryable task work; settle or cancel it before reassignment`);
      }
      if ((OPEN_DELIVERY.includes(delivery.status) || delivery.retryable) && scopesOverlap(scope, assignment.scope)) {
        throw conflict(`The recovery scope overlaps active assignment ${assignment.id} in the same worktree`);
      }
    }
    if (this.store.listTasks(group.projectId).some((task) => task.sessionId === target.sessionId && (task.status === 'ready' || task.status === 'running'))) {
      throw conflict(`@${target.handle} has another ready or running task even though the provider session is idle`);
    }
  }

  private applyPauseForHuman(group: ConversationGroup, deliveryIdArg: string | null, reason: string, captured: RecoveryCheckpoint, idempotencyKey: string): void {
    const delivery = deliveryIdArg ? this.recoveryDelivery(group, deliveryIdArg) : undefined;
    const requestIdArg = delivery?.requestId ?? null;
    const checkpoint = this.repo.insertRecoveryCheckpoint({
      id: recoveryCheckpointId(), groupId: group.id, requestId: requestIdArg, batchId: delivery?.id ?? null, kind: 'pause-for-human',
      reason: clean(reason, 1000), payload: { deliveryId: delivery?.id ?? null, providerCheckpointId: captured.id }, idempotencyKey,
    });
    this.repo.updateGroup(group.id, { paused: true, pauseReason: clean(reason, 1000), recoveryState: {
      status: 'paused', reason: clean(reason, 1000), pendingCheckpointId: checkpoint.id, ...(requestIdArg ? { activeRequestId: requestIdArg } : {}), updatedAt: nowIso(),
    } });
    for (const request of this.repo.requestsWithStatus(group.id, 'active')) this.refreshRequest(request.id, true);
    this.event(group, 'group.recovery.paused', 'Group paused for human review', { checkpointId: checkpoint.id, providerCheckpointId: captured.id, deliveryId: delivery?.id ?? null });
  }

  private applyCoordinatorReplacement(
    group: ConversationGroup, replacementId: string, automatic: boolean, checkpointId?: string, requestIdArg?: string,
    quotaPoolVerification?: 'verified-distinct' | 'unverified', automaticCheckpoint?: RecoveryCheckpoint,
  ): void {
    const target = this.requireMember(group, replacementId);
    if (group.mode === 'cowork') {
      const request = requestIdArg ? this.repo.getRequest(requestIdArg) : undefined;
      if (!request || request.groupId !== group.id || (request.status !== 'active' && request.status !== 'paused' && !(automaticCheckpoint && request.status === 'completed'))) {
        throw conflict('Cowork coordinator recovery requires the affected active request ID');
      }
      const old = this.requireMember(group, request.plannerMemberId);
      if (old.id === target.id) return;
      const sourceSession = this.store.getSession(old.sessionId);
      const targetSession = this.store.getSession(target.sessionId);
      const sourceBusy = Boolean(sourceSession && this.sessionBusy(sourceSession));
      if (!sourceSession || !targetSession || target.held || this.sessionBusy(targetSession)
        || this.repo.requestDeliveries(request.id, ['queued', 'running']).some((row) => row.memberId === target.id)) {
        throw conflict(`@${target.handle} must be idle before taking this request's planning lease`);
      }
      this.assertNoTargetTaskConflict(group, target, targetSession.worktreePath, [], '');
      const oldRequestDeliveries = this.repo.requestDeliveries(request.id, ['running']).filter((row) => row.memberId === old.id);
      if (sourceBusy && (automatic || sourceSession.worktreePath === targetSession.worktreePath)) throw conflict(`Wait for @${old.handle} to finish cleanup before changing this request's planning lease`);
      const failed = this.repo.requestDeliveries(request.id, ['failed', 'interrupted']).filter((row) => row.memberId === old.id && row.runId).at(-1);
      if (automaticCheckpoint) {
        const failedSessionId = failed ? this.repo.getMember(failed.memberId)?.sessionId : undefined;
        if (!failed || failed.requestId !== request.id || failed.runId !== automaticCheckpoint.runId || failedSessionId !== automaticCheckpoint.sessionId) {
          throw conflict('The automatic coordinator checkpoint does not match the failed planning run');
        }
      }
      const failure = failed?.runId ? this.recovery?.failureForRun(failed.runId) ?? null : null;
      const checkpoint = automaticCheckpoint ? undefined : this.recoveryCheckpoint(group, checkpointId, failure, request.id, failed?.id ?? oldRequestDeliveries.at(-1)?.id);
      if (sourceBusy && sourceSession.worktreePath !== targetSession.worktreePath && !checkpoint) throw conflict('Changing the planning lease across worktrees requires an acknowledged source checkpoint');
      if (automatic && sourceSession.policy !== targetSession.policy) {
        throw conflict('Automatic cowork fallback requires the same permission policy');
      }
      const epoch = (group.coordinatorEpoch ?? 1) + 1;
      this.repo.updateRequestPlannerOne(request.id, target.id);
      const rerouted = this.repo.rerouteQueuedRequestDeliveries(request.id, old.id, target.id, epoch);
      const previous = group.recoveryState;
      this.repo.updateGroup(group.id, { coordinatorEpoch: epoch, recoveryState: {
        status: previous?.pendingCheckpointId ? 'paused' : 'recovering', activeRequestId: request.id,
        ...(previous?.pendingCheckpointId ? { pendingCheckpointId: previous.pendingCheckpointId, reason: previous.reason } : {}),
        ...(checkpoint?.id ? { acknowledgedCheckpointId: checkpoint.id } : previous?.acknowledgedCheckpointId ? { acknowledgedCheckpointId: previous.acknowledgedCheckpointId } : {}),
        ...(previous?.acknowledgedDeliveryIds ? { acknowledgedDeliveryIds: previous.acknowledgedDeliveryIds.slice(-100) } : {}), updatedAt: nowIso(),
      } as GroupRecoveryState });
      this.consumeLeadFallback(group, target.id);
      const currentGroup = this.repo.getGroup(group.id)!;
      if (failed) this.queueCoordinatorContinuation(currentGroup, request, target, failed, checkpoint?.id, automaticCheckpoint);
      this.event(group, automatic ? 'group.planner.fallback' : 'group.planner.replaced', `Cowork planning lease moved: @${old.handle} → @${target.handle}`,
        { requestId: request.id, fromMemberId: old.id, toMemberId: target.id, coordinatorEpoch: epoch, rerouted, automatic,
          checkpointId: checkpoint?.id ?? null, providerCheckpointId: automaticCheckpoint?.id ?? null });
      return;
    }

    const currentLeadId = group.orchestratorMemberId ?? (group.mode === 'current-leads' ? this.repo.members(group.id, false).find((member) => member.sessionId === group.anchorSessionId)?.id : null);
    const old = currentLeadId ? this.requireMember(group, currentLeadId) : undefined;
    if (!old) throw conflict('This group has no active coordinator');
    if (old.id === target.id) return;
    const sourceSession = this.store.getSession(old.sessionId);
    const targetSession = this.store.getSession(target.sessionId);
    const sourceBusy = Boolean(sourceSession && this.sessionBusy(sourceSession));
    if (!targetSession || target.held || this.sessionBusy(targetSession) || this.repo.memberDeliveries(target.id, ['queued', 'running']).length) throw conflict(`@${target.handle} must be active and idle before becoming coordinator`);
    if (!sourceSession || (sourceBusy && (automatic || sourceSession.worktreePath === targetSession.worktreePath))) {
      throw conflict(`Wait for @${old.handle} to finish provider cleanup before replacing the coordinator in this worktree`);
    }
    this.assertNoTargetTaskConflict(group, target, targetSession.worktreePath, [], '');
    const lastFailureDelivery = this.repo.memberDeliveries(old.id, ['failed', 'interrupted']).filter((row) => row.runId).at(-1);
    const activeOld = this.repo.memberDeliveries(old.id, ['running']).at(-1);
    const contextDelivery = lastFailureDelivery ?? activeOld;
    if (automaticCheckpoint && (!contextDelivery || contextDelivery.runId !== automaticCheckpoint.runId || contextDelivery.memberId !== old.id)) {
      throw conflict('The automatic coordinator checkpoint does not match the failed coordinator run');
    }
    const failure = contextDelivery?.runId ? this.recovery?.failureForRun(contextDelivery.runId) ?? null : null;
    const checkpoint = automaticCheckpoint ? undefined : this.recoveryCheckpoint(group, checkpointId, failure, contextDelivery?.requestId, contextDelivery?.id);
    if (!automatic && sourceSession.worktreePath !== targetSession.worktreePath && contextDelivery && !checkpoint) {
      throw conflict('Coordinator replacement across worktrees requires an acknowledged source recovery checkpoint');
    }
    if (checkpoint && sourceSession.worktreePath !== targetSession.worktreePath) {
      const providerCheckpointId = typeof checkpoint.payload.providerCheckpointId === 'string' ? checkpoint.payload.providerCheckpointId : undefined;
      const nativeCheckpoint = providerCheckpointId ? this.recovery?.latest(sourceSession.id) : null;
      if (!nativeCheckpoint || nativeCheckpoint.id !== providerCheckpointId) throw conflict('The acknowledged checkpoint does not contain source worktree references');
    }
    if (automatic && sourceSession.policy !== targetSession.policy) {
      throw conflict(`Automatic coordinator fallback requires the same permission policy as @${old.handle}`);
    }
    const runningOld = this.repo.memberDeliveries(old.id, ['running']).map((row) => row.id);
    const epoch = (group.coordinatorEpoch ?? 1) + 1;
    const convertsCurrentLead = group.mode === 'current-leads';
    const nextMode: GroupMode = convertsCurrentLead ? 'orchestrated' : group.mode;
    for (const member of this.repo.members(group.id, false)) {
      const role: GroupMember['role'] = member.id === target.id ? 'orchestrator' : 'worker';
      if (member.role !== role) this.repo.updateMember(member.id, { role });
    }
    this.repo.updateGroup(group.id, { mode: nextMode, orchestratorMemberId: target.id, coordinatorEpoch: epoch,
      recoveryState: { status: group.recoveryState?.pendingCheckpointId ? 'paused' : 'recovering',
        ...(group.recoveryState?.pendingCheckpointId ? { pendingCheckpointId: group.recoveryState.pendingCheckpointId, reason: group.recoveryState.reason } : {}),
        ...(checkpoint?.id ? { acknowledgedCheckpointId: checkpoint.id } : group.recoveryState?.acknowledgedCheckpointId ? { acknowledgedCheckpointId: group.recoveryState.acknowledgedCheckpointId } : {}),
        ...(group.recoveryState?.acknowledgedDeliveryIds ? { acknowledgedDeliveryIds: group.recoveryState.acknowledgedDeliveryIds.slice(-100) } : {}), updatedAt: nowIso() } as GroupRecoveryState });
    this.consumeLeadFallback(group, target.id);
    this.repo.updateRequestPlanner(group.id, null, target.id);
    const rerouted = this.repo.rerouteQueuedCoordinatorWork(group.id, old.id, target.id, epoch);
    const updatedGroup = this.repo.getGroup(group.id)!;
    for (const request of this.repo.requests(group.id, 1000)) {
      if (request.status === 'completed' && !automaticCheckpoint) continue;
      const failed = this.repo.memberDeliveries(old.id, ['failed', 'interrupted']).find((row) => row.requestId === request.id
        && (!automaticCheckpoint || row.runId === automaticCheckpoint.runId));
      if (!failed) continue;
      this.queueCoordinatorContinuation(updatedGroup, request, target, failed, checkpoint?.id, automaticCheckpoint);
    }
    this.event(group, automatic ? 'group.coordinator.fallback' : 'group.coordinator.replaced',
      automatic ? `Coordinator fallback: @${old.handle} → @${target.handle}` : `Coordinator replaced: @${old.handle} → @${target.handle}`,
      { fromMemberId: old.id, toMemberId: target.id, coordinatorEpoch: epoch, rerouted, automatic, convertedFromCurrentLeads: convertsCurrentLead,
        sourceProvider: sourceSession.provider, targetProvider: targetSession.provider, sourceModel: sourceSession.model, targetModel: targetSession.model,
        sourcePolicy: sourceSession.policy, targetPolicy: targetSession.policy, checkpointId: checkpoint?.id ?? null,
        providerCheckpointId: automaticCheckpoint?.id ?? null,
        quotaPoolVerification: quotaPoolVerification ?? (automatic ? 'verified' : undefined),
        fallbackUncertainty: quotaPoolVerification === 'unverified' ? 'Distinct provider quota pools were not reported; this single explicitly configured fallback does not assert that the replacement has quota available.' : undefined });
    for (const id of runningOld) this.fencedCoordinatorDeliveries.add(id);
  }

  private queueCoordinatorContinuation(
    group: ConversationGroup, request: ReturnType<GroupRepo['getRequest']> & object, member: MemberRow, failed: DeliveryRow,
    checkpointId?: string, automaticCheckpoint?: RecoveryCheckpoint,
  ): boolean {
    if (this.repo.deliverySuccessor(group.id, failed.id)) { this.repo.setDelivery(failed.id, { retryable: false }); return true; }
    this.repo.updateRequestPlannerOne(request.id, member.id);
    const existing = this.repo.requestDeliveries(request.id, ['queued', 'running']).some((row) => row.memberId === member.id && (row.kind === 'request' || row.kind === 'result'));
    if (existing) {
      const candidate = this.repo.requestDeliveries(request.id, ['queued', 'running']).find((row) => row.memberId === member.id && (row.kind === 'request' || row.kind === 'result'));
      if (automaticCheckpoint && candidate) {
        if (candidate.status !== 'queued') throw conflict('The replacement coordinator already started this request before its fresh checkpoint could be added');
        const existingMessage = this.repo.getMessage(candidate.messageId)?.content ?? '';
        const assignments = this.repo.requestAssignments(request.id).slice(0, 20).map((assignment) => {
          const task = this.store.getTask(assignment.taskId);
          if (!task) return `- ${assignment.taskId}: unavailable`;
          const dependencies = task.dependsOn.map((id) => `${id} [${this.store.getTask(id)?.status ?? 'missing'}]`).join(', ') || 'none';
          return `- ${task.id} [${task.status}] ${clean(task.title, 160)}; accepts: ${clean(task.acceptanceCriteria, 500)}; depends on: ${dependencies}`;
        });
        const artifacts = this.repo.artifactsForRequest(request.id).slice(0, 30)
          .map((artifact) => `- ${artifact.path} @ ${artifact.commitId.slice(0, 12)}`);
        const targetSession = this.store.getSession(member.sessionId);
        const recoveryContext = this.checkpointHandoffContext(automaticCheckpoint, targetSession?.worktreePath ?? '');
        const message = this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: [member.id], kind: 'status', requestId: request.id,
          content: truncate(`Continue request ${request.id} after automatic coordinator quota handoff. Inspect the checkpoint, current task and artifact state before acting; do not repeat completed side effects.\n${recoveryContext}\nExisting queued context:\n${clean(existingMessage, 4000)}\n\nAssignments, acceptance, and dependencies:\n${assignments.join('\n') || '- none'}\n\nVerified artifacts:\n${artifacts.join('\n') || '- none'}`, 16_000) });
        this.repo.setDelivery(candidate.id, { messageId: message.id });
      }
      const linked = candidate ? this.repo.linkDeliverySuccessor(group.id, request.id, failed.id, candidate.id) : true;
      if (linked) {
        this.repo.setDelivery(failed.id, { retryable: false });
        if (automaticCheckpoint && candidate && request.status === 'completed') this.repo.updateRequest(request.id, { status: 'active' });
      }
      return linked;
    }
    const hop = failed.hop + 1;
    const limit = effectiveTurnLimit(group);
    if (hop > group.maxHops || (limit !== null && request.turnsUsed + this.repo.requestDeliveries(request.id, ['queued']).length >= limit)) {
      const reason = 'The coordinator was replaced, but its continuation needs another turn or hop beyond the current group limit. The request remains retained for review.';
      this.repo.updateRequest(request.id, { status: 'paused' });
      this.repo.updateGroup(group.id, { recoveryState: { status: 'paused', reason, activeRequestId: request.id, updatedAt: nowIso() } });
      this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: [], kind: 'status', requestId: request.id, content: reason });
      this.event(group, 'group.coordinator.continuation.blocked', reason, { requestId: request.id, failedDeliveryId: failed.id });
      return false;
    }
    const failure = failed.runId ? this.recovery?.failureForRun(failed.runId) : null;
    const original = this.repo.getMessage(request.messageId)?.content ?? '';
    const source = this.repo.getMember(failed.memberId);
    const sourceSession = source ? this.store.getSession(source.sessionId) : undefined;
    const targetSession = this.store.getSession(member.sessionId);
    let sourceReferences = '';
    if (automaticCheckpoint) {
      if (!sourceSession || automaticCheckpoint.sessionId !== sourceSession.id || automaticCheckpoint.runId !== failed.runId) {
        const reason = 'Coordinator continuation is waiting for its fresh source checkpoint to match the failed run.';
        this.repo.updateGroup(group.id, { recoveryState: { status: 'paused', reason, activeRequestId: request.id, updatedAt: nowIso() } });
        this.event(group, 'group.coordinator.continuation.blocked', reason, { requestId: request.id, failedDeliveryId: failed.id, providerCheckpointId: automaticCheckpoint.id });
        return false;
      }
      sourceReferences = this.checkpointHandoffContext(automaticCheckpoint, targetSession?.worktreePath ?? '');
    }
    if (sourceSession && targetSession && sourceSession.worktreePath !== targetSession.worktreePath) {
      const groupCheckpoint = !automaticCheckpoint && checkpointId ? this.repo.getRecoveryCheckpoint(group.id, checkpointId) : undefined;
      const providerCheckpointId = typeof groupCheckpoint?.payload.providerCheckpointId === 'string' ? groupCheckpoint.payload.providerCheckpointId : undefined;
      const nativeCheckpoint = automaticCheckpoint ?? (providerCheckpointId ? this.recovery?.latest(sourceSession.id) : null);
      if (!automaticCheckpoint) {
        if (!nativeCheckpoint || nativeCheckpoint.id !== providerCheckpointId) {
          const reason = 'Coordinator continuation is waiting for an acknowledged source checkpoint because replacement worktrees differ.';
          this.repo.updateGroup(group.id, { recoveryState: { status: 'paused', reason, activeRequestId: request.id, updatedAt: nowIso() } });
          this.event(group, 'group.coordinator.continuation.blocked', reason, { requestId: request.id, failedDeliveryId: failed.id });
          return false;
        }
        sourceReferences = this.checkpointHandoffContext(nativeCheckpoint, targetSession.worktreePath);
      }
    }
    const taskContext = this.repo.requestAssignments(request.id).slice(0, 20).map((assignment) => {
      const task = this.store.getTask(assignment.taskId);
      const owner = this.repo.getMember(assignment.toMemberId);
      if (!task) return `- ${assignment.taskId}: unavailable`;
      const dependencies = task.dependsOn.map((id) => `${id} [${this.store.getTask(id)?.status ?? 'missing'}]`).join(', ') || 'none';
      return `- ${task.id} [${task.status}] ${clean(task.title, 160)}; owner @${owner?.handle ?? 'unknown'}; accepts: ${clean(task.acceptanceCriteria, 500)}; depends on: ${dependencies}`;
    });
    const artifactPaths = this.repo.artifactsForRequest(request.id).slice(0, 30).map((artifact) => `- ${artifact.path} @ ${artifact.commitId.slice(0, 12)} → @${this.repo.getMember(artifact.toMemberId)?.handle ?? 'unknown'}`);
    const queuedResults = this.repo.requestDeliveries(request.id, ['queued']).filter((row) => row.kind === 'result').slice(0, 10)
      .map((row) => `- ${clean(this.repo.getMessage(row.messageId)?.content ?? '', 1000)}`);
    const content = truncate(`Continue request ${request.id} after coordinator recovery. Inspect current task and artifact state before acting; do not repeat assignments or side effects already recorded.\n${failure ? `Prior failure (${failure.kind}): ${clean(failure.message, 500)}\n` : ''}${checkpointId ? `Acknowledged group checkpoint: ${checkpointId}\n` : ''}${sourceReferences}\nOriginal objective:\n${clean(original, 4000)}\n\nAssignments, owners, dependencies, and acceptance:\n${taskContext.join('\n') || '- none'}\n\nVerified artifact paths:\n${artifactPaths.join('\n') || '- none'}\n\nQueued results:\n${queuedResults.join('\n') || '- none'}`, 16_000);
    const message = this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: [member.id], kind: 'status', requestId: request.id, content });
    const nextId = deliveryId();
    this.repo.insertDelivery({ id: nextId, groupId: group.id, requestId: request.id, messageId: message.id, memberId: member.id, kind: 'result', hop, coordinatorEpoch: group.coordinatorEpoch });
    this.linkRecoverySuccessor(group, failed, nextId);
    this.repo.setDelivery(failed.id, { retryable: false });
    this.repo.updateRequest(request.id, { status: 'active' });
    this.event(group, 'group.coordinator.continuation', `Recovery continuation queued for @${member.handle}`, { requestId: request.id, failedDeliveryId: failed.id, checkpointId: checkpointId ?? null });
    return true;
  }

  private checkpointHandoffContext(checkpoint: RecoveryCheckpoint, targetWorktreePath: string): string {
    const worktree = checkpoint.worktree;
    const dirtyPaths = worktree.dirtyPaths.slice(0, 50).join(', ') || 'none reported';
    const artifacts = checkpoint.artifacts.slice(0, 20).map((artifact) => `- ${clean(artifact.path, 500)} @ ${clean(artifact.revision, 100)}`);
    const tasks = checkpoint.tasks.slice(0, 20).map((task) =>
      `- ${clean(task.id, 100)} [${task.status}] ${clean(task.title, 200)}; acceptance: ${clean(task.acceptanceCriteria, 500)}`);
    const separateWorktree = targetWorktreePath !== worktree.path;
    return `Fresh source recovery checkpoint: ${checkpoint.id} (captured ${checkpoint.capturedAt}).\n`
      + `Source worktree ${clean(worktree.path, 1000)}; branch ${clean(worktree.branch ?? 'unknown', 200)}; HEAD ${clean(worktree.head ?? 'unknown', 100)}; dirty paths ${clean(dirtyPaths, 3000)}${worktree.dirtyPathsTruncated ? ' (list truncated)' : ''}.\n`
      + (separateWorktree
        ? 'These source edits are references only and are not copied into the replacement worktree; inspect or explicitly integrate needed changes.\n'
        : 'The source and target share a worktree; inspect its recorded changes and do not repeat completed side effects.\n')
      + `Checkpoint artifacts:\n${artifacts.join('\n') || '- none recorded'}\n`
      + `Checkpoint tasks and acceptance criteria:\n${tasks.join('\n') || '- none recorded'}\n`;
  }

  private setFallbackBlocked(group: ConversationGroup, failure: ProviderFailure, reason: string): void {
    const bounded = clean(reason, 1000);
    if (group.recoveryState?.lastFailureId === failure.id && group.recoveryState.reason === bounded && group.recoveryState.status === 'paused') return;
    this.repo.updateGroup(group.id, { recoveryState: {
      status: 'paused', reason: bounded, lastFailureId: failure.id,
      ...(group.recoveryState?.activeRequestId ? { activeRequestId: group.recoveryState.activeRequestId } : {}),
      ...(group.recoveryState?.pendingCheckpointId ? { pendingCheckpointId: group.recoveryState.pendingCheckpointId } : {}), updatedAt: nowIso(),
    } });
    this.event(group, 'group.recovery.fallback-blocked', bounded, { failureId: failure.id, kind: failure.kind });
  }

  private recordFallbackBlocked(groupId: string, failure: ProviderFailure, reason: string): void {
    if (!failure.runId) return;
    this.store.tx(() => {
      const group = this.repo.getGroup(groupId);
      const currentFailure = this.recovery?.failureForRun(failure.runId!);
      if (!group || currentFailure?.id !== failure.id) return;
      this.setFallbackBlocked(group, failure, reason);
    });
  }

  private quotaFallbackPoolCheck(group: ConversationGroup, source: ProviderFailure, target: Session): { ok: true; verification: 'verified-distinct' | 'unverified' } | { ok: false; reason: string } {
    const targetFailure = this.recovery?.failure(target.id);
    if (targetFailure?.kind === 'quota_exhausted') return { ok: false, reason: `Automatic quota fallback was blocked because @${target.id} has a current quota-exhausted provider failure.` };
    const sourcePool = source.quotaPool?.trim();
    const targetPool = targetFailure?.quotaPool?.trim();
    if (sourcePool && targetPool) {
      return sourcePool === targetPool
        ? { ok: false, reason: 'Automatic quota fallback was blocked because both members report the same exhausted quota pool.' }
        : { ok: true, verification: 'verified-distinct' };
    }
    if (source.provider === target.provider) {
      return { ok: false, reason: 'Automatic quota fallback was blocked because this provider uses the same runtime authentication and did not report distinct quota pools.' };
    }
    const optedIn = (group.recoveryPolicy as QuotaRecoveryPolicy | undefined)?.allowUnverifiedQuotaFallback === true;
    if (!optedIn) return { ok: false, reason: 'Quota-pool identity is unreported. Enable the explicit unverified-pool fallback option to allow one cross-provider attempt.' };
    return { ok: true, verification: 'unverified' };
  }

  private automaticFallbackFingerprint(groupId: string, deliveryIdArg: string, targetId: string): string | null {
    const group = this.repo.getGroup(groupId);
    const delivery = this.repo.getDelivery(deliveryIdArg);
    const source = delivery ? this.repo.getMember(delivery.memberId) : undefined;
    const target = this.repo.getMember(targetId);
    const assignment = delivery?.assignmentId ? this.repo.getAssignment(delivery.assignmentId) : undefined;
    const task = assignment ? this.store.getTask(assignment.taskId) : undefined;
    const request = delivery ? this.repo.getRequest(delivery.requestId) : undefined;
    const sourceSession = source ? this.store.getSession(source.sessionId) : undefined;
    const targetSession = target ? this.store.getSession(target.sessionId) : undefined;
    if (!group || !delivery || !source || !target || !sourceSession || !targetSession || !request) return null;
    const sessionState = (session: Session) => ({ id: session.id, provider: session.provider, model: session.model, effort: session.effort,
      policy: session.policy, serviceTier: session.serviceTier, worktreePath: session.worktreePath, status: session.status });
    return JSON.stringify({
      group: { id: group.id, projectId: group.projectId, mode: group.mode, orchestratorMemberId: group.orchestratorMemberId,
        coordinatorEpoch: group.coordinatorEpoch, paused: group.paused, maxParallel: group.maxParallel, maxTurns: group.maxTurns,
        maxHops: group.maxHops, recoveryPolicy: group.recoveryPolicy, recoveryStatus: group.recoveryState?.status,
        recoveryRequestId: group.recoveryState?.activeRequestId },
      delivery: { id: delivery.id, groupId: delivery.groupId, requestId: delivery.requestId, messageId: delivery.messageId,
        memberId: delivery.memberId, status: delivery.status, runId: delivery.runId, kind: delivery.kind, assignmentId: delivery.assignmentId,
        taskId: delivery.taskId, hop: delivery.hop, retryable: delivery.retryable, updatedAt: delivery.updatedAt },
      source: { id: source.id, groupId: source.groupId, sessionId: source.sessionId, role: source.role, held: source.held, removedAt: source.removedAt,
        session: sessionState(sourceSession) },
      target: { id: target.id, groupId: target.groupId, sessionId: target.sessionId, role: target.role, held: target.held, removedAt: target.removedAt,
        session: sessionState(targetSession) },
      assignment: assignment && { id: assignment.id, deliveryId: assignment.deliveryId, taskId: assignment.taskId, toMemberId: assignment.toMemberId,
        scope: assignment.scope },
      task: task && { id: task.id, sessionId: task.sessionId, status: task.status, title: task.title, acceptanceCriteria: task.acceptanceCriteria, dependsOn: task.dependsOn },
      request: { id: request.id, groupId: request.groupId, plannerMemberId: request.plannerMemberId, status: request.status, turnsUsed: request.turnsUsed },
      failure: delivery.runId ? this.recovery?.failureForRun(delivery.runId) : null,
    });
  }

  private async attemptAutomaticLeadFallback(groupArg: ConversationGroup): Promise<boolean> {
    const group = this.repo.getGroup(groupArg.id);
    if (!group || group.paused || !group.recoveryPolicy?.automaticFallback || !group.recoveryPolicy.leadFallbackMemberId) return false;
    const coworkRequest = group.mode === 'cowork'
      ? this.repo.requests(group.id, 1000).find((request) =>
        this.repo.requestDeliveries(request.id, ['failed', 'interrupted']).some((row) => row.memberId === request.plannerMemberId && row.runId))
      : undefined;
    const leadId = group.mode === 'cowork' ? coworkRequest?.plannerMemberId
      : group.orchestratorMemberId ?? (group.mode === 'current-leads' ? this.repo.members(group.id, false).find((member) => member.sessionId === group.anchorSessionId)?.id : undefined);
    const lead = leadId ? this.repo.getMember(leadId) : undefined;
    if (!lead) return false;
    const failed = group.mode === 'cowork' && coworkRequest
      ? this.repo.requestDeliveries(coworkRequest.id, ['failed', 'interrupted']).filter((row) => row.memberId === lead.id && row.runId).at(-1)
      : this.repo.memberDeliveries(lead.id, ['failed', 'interrupted']).filter((row) => row.runId).at(-1);
    const failure = failed?.runId ? this.recovery?.failureForRun(failed.runId) : null;
    if (!failed || !failure || failure.actor !== 'lead' || failure.kind !== 'quota_exhausted') return false;
    if (failure.outcomeUnknown !== false || failure.dispatchState === 'unknown') {
      this.recordFallbackBlocked(group.id, failure, 'Automatic coordinator fallback is waiting for a human because the provider outcome or dispatch state is unknown.');
      return false;
    }
    const targetId = group.recoveryPolicy.leadFallbackMemberId;
    const target = this.repo.getMember(targetId);
    const sourceSession = this.store.getSession(lead.sessionId);
    const targetSession = target ? this.store.getSession(target.sessionId) : undefined;
    if (!target || target.groupId !== group.id || target.removedAt || target.held || !sourceSession || !targetSession) {
      this.recordFallbackBlocked(group.id, failure, 'Automatic coordinator fallback is unavailable: the configured replacement is not an active, available group member.');
      return false;
    }
    if (this.sessionBusy(sourceSession) || this.repo.memberDeliveries(lead.id, ['running']).length) return false;
    if (this.sessionBusy(targetSession) || this.repo.memberDeliveries(target.id, ['queued', 'running']).length) return false;
    if (sourceSession.policy !== targetSession.policy) {
      this.recordFallbackBlocked(group.id, failure, `Automatic coordinator fallback was blocked: @${target.handle} must share @${lead.handle}'s permission policy.`);
      return false;
    }
    const pool = this.quotaFallbackPoolCheck(group, failure, targetSession);
    if (!pool.ok) { this.recordFallbackBlocked(group.id, failure, pool.reason); return false; }
    const fingerprint = this.automaticFallbackFingerprint(group.id, failed.id, target.id);
    if (!fingerprint) return false;
    const captureKey = `${group.id}:lead:${failed.id}`;
    if (this.automaticFallbackCaptures.has(captureKey)) return false;
    this.automaticFallbackCaptures.add(captureKey);
    try {
      let checkpoint: RecoveryCheckpoint;
      try {
        checkpoint = await this.recovery!.capture(sourceSession.id, `Automatic quota handoff for ${failed.id}`, failed.runId!);
        this.validateHandoffCheckpoint(checkpoint, sourceSession.id, failed.runId!);
      } catch (error) {
        const reason = error instanceof HttpError ? error.message : 'A fresh source recovery checkpoint could not be captured; automatic fallback remains blocked.';
        this.recordFallbackBlocked(group.id, failure, reason);
        return false;
      }
      if (this.closed) return false;
      if (this.automaticFallbackFingerprint(group.id, failed.id, target.id) !== fingerprint) {
        const currentSource = this.repo.getMember(lead.id);
        const currentTarget = this.repo.getMember(target.id);
        const currentSourceSession = currentSource ? this.store.getSession(currentSource.sessionId) : undefined;
        const currentTargetSession = currentTarget ? this.store.getSession(currentTarget.sessionId) : undefined;
        if (currentSourceSession && currentTargetSession && currentSourceSession.policy !== currentTargetSession.policy) {
          this.recordFallbackBlocked(group.id, failure,
            `Automatic coordinator fallback was blocked: @${currentTarget?.handle ?? target.handle} must share @${currentSource?.handle ?? lead.handle}'s permission policy.`);
        }
        return false;
      }
      let moved = false;
      try {
        this.store.tx(() => {
          const fresh = this.repo.getGroup(group.id);
          const currentFailure = this.recovery?.failureForRun(failed.runId!);
          const currentSource = this.repo.getMember(lead.id);
          const currentTarget = this.repo.getMember(target.id);
          const currentSourceSession = currentSource ? this.store.getSession(currentSource.sessionId) : undefined;
          const currentTargetSession = currentTarget ? this.store.getSession(currentTarget.sessionId) : undefined;
          if (this.closed || !fresh || fresh.paused || this.automaticFallbackFingerprint(group.id, failed.id, target.id) !== fingerprint
            || currentFailure?.id !== failure.id || !currentSourceSession || !currentTargetSession
            || this.sessionBusy(currentSourceSession) || this.repo.memberDeliveries(lead.id, ['running']).length
            || this.sessionBusy(currentTargetSession) || this.repo.memberDeliveries(target.id, ['queued', 'running']).length) return;
          this.validateHandoffCheckpoint(checkpoint, currentSourceSession.id, failed.runId!);
          const currentPool = this.quotaFallbackPoolCheck(fresh, currentFailure, currentTargetSession);
          if (!currentPool.ok) { this.setFallbackBlocked(fresh, failure, currentPool.reason); return; }
          this.applyCoordinatorReplacement(fresh, target.id, true, undefined, coworkRequest?.id, currentPool.verification, checkpoint);
          moved = true;
        });
      } catch (error) {
        moved = false;
        if (error instanceof HttpError) this.recordFallbackBlocked(group.id, failure, error.message);
        else this.log('error', `Automatic coordinator handoff failed for ${failed.id}`, error);
      }
      return moved;
    } finally {
      this.automaticFallbackCaptures.delete(captureKey);
    }
  }

  private consumeWorkerFallback(group: ConversationGroup, sourceId: string, targetId: string): void {
    const policy = group.recoveryPolicy;
    if (!policy) return;
    const workerFallbacks = Object.fromEntries(Object.entries(policy.workerFallbacks ?? {}).filter(([id]) => id !== sourceId && id !== targetId));
    const automaticFallback = Boolean(policy.leadFallbackMemberId || Object.keys(workerFallbacks).length) && policy.automaticFallback;
    const nextPolicy: GroupRecoveryPolicy = { ...policy, automaticFallback, workerFallbacks };
    this.repo.updateGroup(group.id, { recoveryPolicy: nextPolicy });
    this.event(group, 'group.recovery-policy.consumed', 'Configured worker fallback was consumed by quota handoff', {
      sourceMemberId: sourceId, replacementMemberId: targetId, recoveryPolicy: nextPolicy,
    });
  }

  private async attemptAutomaticWorkerFallback(groupArg: ConversationGroup, deliveryArg: DeliveryRow): Promise<boolean> {
    const group = this.repo.getGroup(groupArg.id);
    const delivery = this.repo.getDelivery(deliveryArg.id);
    if (!group || group.paused || !delivery || !group.recoveryPolicy?.automaticFallback || delivery.kind !== 'assignment' || !delivery.assignmentId || !delivery.runId) return false;
    const source = this.repo.getMember(delivery.memberId);
    const assignment = this.repo.getAssignment(delivery.assignmentId);
    const workerRole: GroupMember['role'] = group.mode === 'cowork' ? 'peer' : 'worker';
    if (!source || source.role !== workerRole || !assignment || assignment.deliveryId !== delivery.id || this.repo.deliverySuccessor(group.id, delivery.id)) return false;
    const failure = this.recovery?.failureForRun(delivery.runId);
    if (!failure || failure.actor !== 'worker' || failure.kind !== 'quota_exhausted') return false;
    if (failure.outcomeUnknown !== false || failure.dispatchState === 'unknown') {
      this.recordFallbackBlocked(group.id, failure, 'Automatic worker fallback is waiting for a human because the provider outcome or dispatch state is unknown.');
      return false;
    }
    const targetId = group.recoveryPolicy.workerFallbacks?.[source.id];
    if (!targetId) return false;
    const target = this.repo.getMember(targetId);
    const task = this.store.getTask(assignment.taskId);
    const sourceSession = this.store.getSession(source.sessionId);
    const targetSession = target ? this.store.getSession(target.sessionId) : undefined;
    if (!target || target.groupId !== group.id || target.removedAt || target.held || target.role !== workerRole || !task || task.status === 'done' || task.status === 'running') {
      this.recordFallbackBlocked(group.id, failure, 'Automatic worker fallback is unavailable: the configured replacement or task is no longer eligible.');
      return false;
    }
    if (!sourceSession || this.sessionBusy(sourceSession) || this.repo.memberDeliveries(source.id, ['running']).length) return false;
    if (!targetSession || this.sessionBusy(targetSession) || this.repo.memberDeliveries(target.id, ['queued', 'running']).length) return false;
    if (sourceSession.policy !== targetSession.policy) {
      this.recordFallbackBlocked(group.id, failure, `Automatic reassignment for @${source.handle} was blocked: @${target.handle} does not have the same permission policy.`);
      return false;
    }
    const pool = this.quotaFallbackPoolCheck(group, failure, targetSession);
    if (!pool.ok) { this.recordFallbackBlocked(group.id, failure, pool.reason); return false; }
    try { this.assertNoTargetTaskConflict(group, target, targetSession.worktreePath, assignment.scope, assignment.id); }
    catch (error) {
      if (error instanceof HttpError) this.recordFallbackBlocked(group.id, failure, error.message);
      return false;
    }
    const request = this.repo.getRequest(delivery.requestId);
    if (!request) return false;
    const fingerprint = this.automaticFallbackFingerprint(group.id, delivery.id, target.id);
    if (!fingerprint) return false;
    const captureKey = `${group.id}:worker:${delivery.id}`;
    if (this.automaticFallbackCaptures.has(captureKey)) return false;
    this.automaticFallbackCaptures.add(captureKey);
    try {
      let checkpoint: RecoveryCheckpoint;
      try {
        checkpoint = await this.recovery!.capture(sourceSession.id, `Automatic quota handoff for ${delivery.id}`, delivery.runId);
        this.validateHandoffCheckpoint(checkpoint, sourceSession.id, delivery.runId);
      } catch (error) {
        const reason = error instanceof HttpError ? error.message : 'A fresh source recovery checkpoint could not be captured; automatic fallback remains blocked.';
        this.recordFallbackBlocked(group.id, failure, reason);
        return false;
      }
      if (this.closed) return false;
      if (this.automaticFallbackFingerprint(group.id, delivery.id, target.id) !== fingerprint) {
        const currentSource = this.repo.getMember(source.id);
        const currentTarget = this.repo.getMember(target.id);
        const currentSourceSession = currentSource ? this.store.getSession(currentSource.sessionId) : undefined;
        const currentTargetSession = currentTarget ? this.store.getSession(currentTarget.sessionId) : undefined;
        if (currentSourceSession && currentTargetSession && currentSourceSession.policy !== currentTargetSession.policy) {
          this.recordFallbackBlocked(group.id, failure,
            `Automatic reassignment for @${currentSource?.handle ?? source.handle} was blocked: @${currentTarget?.handle ?? target.handle} does not have the same permission policy.`);
        }
        return false;
      }
      let moved = false;
      try {
        this.store.tx(() => {
          const fresh = this.repo.getGroup(group.id);
          const currentFailure = this.recovery?.failureForRun(delivery.runId!);
          const currentSource = this.repo.getMember(source.id);
          const currentTarget = this.repo.getMember(target.id);
          const currentAssignment = this.repo.getAssignment(assignment.id);
          const currentTask = this.store.getTask(task.id);
          const currentSourceSession = currentSource ? this.store.getSession(currentSource.sessionId) : undefined;
          const currentTargetSession = currentTarget ? this.store.getSession(currentTarget.sessionId) : undefined;
          const currentRequest = this.repo.getRequest(request.id);
          const currentDelivery = this.repo.getDelivery(delivery.id);
          if (this.closed || !fresh || fresh.paused || !currentDelivery || currentDelivery.status !== 'failed'
            || this.automaticFallbackFingerprint(group.id, delivery.id, target.id) !== fingerprint || currentFailure?.id !== failure.id
            || !currentSource || !currentTarget || !currentAssignment || !currentTask || !currentRequest || !currentSourceSession || !currentTargetSession
            || this.sessionBusy(currentSourceSession) || this.repo.memberDeliveries(currentSource.id, ['running']).length
            || this.sessionBusy(currentTargetSession) || this.repo.memberDeliveries(currentTarget.id, ['queued', 'running']).length
            || currentSource.role !== workerRole || currentTarget.role !== workerRole || currentTarget.held
            || currentSourceSession.policy !== currentTargetSession.policy || currentTask.status === 'done' || currentTask.status === 'running'
            || this.repo.deliverySuccessor(group.id, currentDelivery.id) || this.existingRecoveryContinuation(group, currentDelivery)) return;
          this.validateHandoffCheckpoint(checkpoint, currentSourceSession.id, delivery.runId!);
          const currentPool = this.quotaFallbackPoolCheck(fresh, currentFailure, currentTargetSession);
          if (!currentPool.ok) { this.setFallbackBlocked(fresh, failure, currentPool.reason); return; }
          this.assertNoTargetTaskConflict(fresh, currentTarget, currentTargetSession.worktreePath, currentAssignment.scope, currentAssignment.id);
          const oldText = this.repo.getMessage(currentDelivery.messageId)?.content ?? currentTask.description;
          const dependencies = currentTask.dependsOn.map((id) => `${id} [${this.store.getTask(id)?.status ?? 'missing'}]`).join(', ') || 'none';
          const sourceContext = this.checkpointHandoffContext(checkpoint, currentTargetSession.worktreePath);
          const message = this.repo.insertMessage({ groupId: fresh.id, senderMemberId: null, recipients: [currentTarget.id], kind: 'assignment', requestId: currentRequest.id,
            content: truncate(`Automatic quota fallback for task ${currentTask.id}: ${currentTask.title}. Inspect the fresh recovery checkpoint and current workspace before acting; do not repeat completed side effects.\nScope: ${currentAssignment.scope.join(', ')}\nAcceptance criteria: ${clean(currentTask.acceptanceCriteria, 1000)}\nDependencies: ${clean(dependencies, 1000)}\n${sourceContext}${clean(oldText, 6000)}`, 12_000) });
          const nextId = deliveryId();
          this.store.updateTask(currentTask.id, { sessionId: currentTarget.sessionId });
          this.repo.insertDelivery({ id: nextId, groupId: fresh.id, requestId: currentRequest.id, messageId: message.id, memberId: currentTarget.id,
            kind: 'assignment', hop: currentDelivery.hop, assignmentId: currentAssignment.id, taskId: currentTask.id, coordinatorEpoch: fresh.coordinatorEpoch });
          this.repo.reassignAssignment(currentAssignment.id, currentTarget.id, nextId);
          this.linkRecoverySuccessor(fresh, currentDelivery, nextId);
          this.repo.setDelivery(currentDelivery.id, { retryable: false });
          this.repo.updateMember(currentSource.id, { held: true });
          this.repo.updateRequest(currentRequest.id, { status: 'active' });
          this.repo.updateGroup(fresh.id, { recoveryState: { status: 'recovering', activeRequestId: currentRequest.id, updatedAt: nowIso() } });
          this.consumeWorkerFallback(fresh, currentSource.id, currentTarget.id);
          this.event(fresh, 'group.assignment.fallback', `Quota fallback: @${currentSource.handle} → @${currentTarget.handle}`, {
            assignmentId: currentAssignment.id, failedDeliveryId: currentDelivery.id, replacementDeliveryId: nextId, failureId: failure.id,
            providerCheckpointId: checkpoint.id, quotaPoolVerification: currentPool.verification,
            fallbackUncertainty: currentPool.verification === 'unverified' ? 'Distinct provider quota pools were not reported; this single explicitly configured fallback does not assert that the replacement has quota available.' : undefined,
          }, currentTarget.sessionId);
          moved = true;
        });
      } catch (error) {
        moved = false;
        if (error instanceof HttpError) this.recordFallbackBlocked(group.id, failure, error.message);
        else this.log('error', `Automatic worker handoff failed for ${delivery.id}`, error);
      }
      return moved;
    } finally {
      this.automaticFallbackCaptures.delete(captureKey);
    }
  }

  private acknowledgeCheckpoint(group: ConversationGroup, checkpointId: string): void {
    const checkpoint = this.repo.getRecoveryCheckpoint(group.id, checkpointId);
    if (!checkpoint) throw notFound('Recovery checkpoint not found in this group');
    if (checkpoint.state !== 'pending' || !this.repo.acknowledgeRecoveryCheckpoint(group.id, checkpoint.id)) return;
    const acknowledged = this.repo.getRecoveryCheckpoint(group.id, checkpoint.id)!;
    const prior = this.repo.getGroup(group.id)?.recoveryState;
    const candidateDeliveryIds = [
      acknowledged.payload.deliveryId,
      ...(Array.isArray(acknowledged.payload.deliveryIds) ? acknowledged.payload.deliveryIds : []),
    ].filter((id): id is string => typeof id === 'string');
    const deliveryIds = [...new Set(candidateDeliveryIds)].filter((id) => {
      const delivery = this.repo.getDelivery(id);
      return Boolean(delivery && delivery.groupId === group.id && acknowledged.requestId && delivery.requestId === acknowledged.requestId);
    });
    const priorDeliveryIds = (prior?.acknowledgedDeliveryIds ?? []).filter((id) => this.repo.getDelivery(id)?.groupId === group.id);
    const merged = [...new Set([...priorDeliveryIds, ...deliveryIds])].slice(-100);
    const pending = this.repo.latestPendingRecoveryCheckpoint(group.id);
    const unresolved = this.repo.deliveries(group.id, ['failed', 'interrupted']).some((row) => !row.retryable && !this.repo.deliverySuccessor(group.id, row.id));
    const status = unresolved ? 'degraded' : pending ? 'paused' : 'healthy';
    this.repo.updateGroup(group.id, { recoveryState: {
      status, ...(unresolved && prior?.reason ? { reason: prior.reason } : pending ? { reason: pending.reason } : {}),
      ...(unresolved && prior?.lastFailureId ? { lastFailureId: prior.lastFailureId } : {}),
      ...(pending?.id ? { pendingCheckpointId: pending.id } : {}), ...(checkpoint.requestId ? { activeRequestId: checkpoint.requestId } : {}),
      acknowledgedDeliveryIds: merged, acknowledgedCheckpointId: checkpoint.id, updatedAt: nowIso(),
    } as GroupRecoveryState });
    this.event(group, 'group.checkpoint.acknowledged', 'Recovery checkpoint acknowledged', { checkpointId, kind: checkpoint.kind, deliveryIds: deliveryIds.slice(0, 20) });
    if (acknowledged.kind === 'supervised-batch'
      && (acknowledged.payload.mode === 'supervised' || acknowledged.payload.mode === 'balanced')) {
      this.queueAcknowledgedBatchContinuation(group, acknowledged);
    }
  }

  private releaseReviewedRecoveryHold(group: ConversationGroup, checkpointId: string, requestIdArg: string): void {
    const checkpoint = this.repo.getRecoveryCheckpoint(group.id, checkpointId);
    const request = this.repo.getRequest(requestIdArg);
    const current = this.repo.getGroup(group.id);
    if (!checkpoint || checkpoint.state !== 'acknowledged' || checkpoint.kind !== 'pause-for-human'
      || checkpoint.requestId !== requestIdArg || !request || request.groupId !== group.id
      || !current?.paused || current.pauseReason !== checkpoint.reason || this.repo.latestPendingRecoveryCheckpoint(group.id)) return;
    this.repo.updateGroup(group.id, { paused: false, pauseReason: null });
  }

  private queueAcknowledgedBatchContinuation(group: ConversationGroup, checkpoint: GroupRecoveryCheckpointRow): boolean {
    const requestIdArg = checkpoint.requestId;
    const request = requestIdArg ? this.repo.getRequest(requestIdArg) : undefined;
    if (!request || request.groupId !== group.id || request.status === 'completed') return false;
    const planner = this.repo.getMember(request.plannerMemberId);
    if (!planner || planner.groupId !== group.id || planner.removedAt) return false;
    const queued = this.repo.requestDeliveries(request.id, ['queued']).find((delivery) => delivery.groupId === group.id && delivery.memberId === planner.id
      && (delivery.kind === 'request' || delivery.kind === 'result'));
    if (queued) {
      this.refreshRequest(request.id);
      return true;
    }

    const sourceDeliveryIds = Array.isArray(checkpoint.payload.deliveryIds)
      ? checkpoint.payload.deliveryIds.filter((id): id is string => typeof id === 'string').slice(0, 100) : [];
    const sourceAssignmentIds = Array.isArray(checkpoint.payload.assignmentIds)
      ? checkpoint.payload.assignmentIds.filter((id): id is string => typeof id === 'string').slice(0, 100) : [];
    const sourceDeliveries = new Map<string, DeliveryRow>();
    for (const id of sourceDeliveryIds) {
      const delivery = this.repo.getDelivery(id);
      if (delivery?.groupId === group.id && delivery.requestId === request.id) sourceDeliveries.set(delivery.id, delivery);
    }
    const assignments = sourceAssignmentIds.map((id) => this.repo.getAssignment(id))
      .filter((assignment): assignment is AssignmentRow => Boolean(assignment && assignment.groupId === group.id && assignment.requestId === request.id));
    for (const assignment of assignments) {
      const delivery = this.repo.getDelivery(assignment.deliveryId);
      if (delivery?.groupId === group.id && delivery.requestId === request.id) sourceDeliveries.set(delivery.id, delivery);
    }
    const nextScope = Array.isArray(checkpoint.payload.nextScope)
      ? checkpoint.payload.nextScope.filter((scope): scope is string => typeof scope === 'string').slice(0, 40).map((scope) => clean(scope, 300)) : [];
    const mode = checkpoint.payload.mode === 'supervised' ? 'supervised' : 'balanced';
    const checkpointLabel = mode === 'supervised' ? 'supervised delegation batch' : 'balanced scope expansion';
    const hop = Math.max(0, ...[...sourceDeliveries.values()].map((delivery) => delivery.hop)) + 1;
    const turnLimit = effectiveTurnLimit(group);
    const committed = request.turnsUsed + this.repo.requestDeliveries(request.id, ['queued']).length;
    if (hop > group.maxHops || (turnLimit !== null && committed >= turnLimit)) {
      const reason = `The acknowledged ${checkpointLabel} needs another planner turn beyond the current request limit. Raise the applicable limit and resume; the objective and source scope are retained.`;
      this.holdBudgetRecord(group, request.id, reason);
      return false;
    }

    const original = this.repo.getMessage(request.messageId)?.content ?? '';
    const batchContext = assignments.slice(0, 20).map((assignment) => {
      const task = this.store.getTask(assignment.taskId);
      return `- ${assignment.taskId} [${task?.status ?? 'missing'}] ${clean(task?.title ?? 'Task unavailable', 160)}; source scope: ${assignment.scope.slice(0, 20).map((scope) => clean(scope, 200)).join(', ') || 'none'}`;
    });
    const content = truncate(`Continue request ${request.id} after the acknowledged ${checkpointLabel}. Rebuild the plan from the original objective and current source scope; inspect recorded task and artifact state before acting, and do not repeat assignments or side effects already recorded.\nAcknowledged checkpoint: ${checkpoint.id}\n\nOriginal objective:\n${clean(original, 4000)}\n\nNext source scope:\n${nextScope.map((scope) => `- ${scope}`).join('\n') || '- Re-evaluate from the original objective and completed batch.'}\n\nSource batch assignments:\n${batchContext.join('\n') || '- No source assignments remain available.'}`, 12_000);
    const message = this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: [planner.id], kind: 'status', requestId: request.id, content });
    const deliveryIdValue = deliveryId();
    this.repo.insertDelivery({ id: deliveryIdValue, groupId: group.id, requestId: request.id, messageId: message.id, memberId: planner.id, kind: 'result', hop, coordinatorEpoch: group.coordinatorEpoch });
    this.refreshRequest(request.id);
    const current = this.repo.getGroup(group.id);
    const recoveryState = current?.recoveryState;
    const unresolved = this.repo.deliveries(group.id, ['failed', 'interrupted'])
      .some((delivery) => !delivery.retryable && !this.repo.deliverySuccessor(group.id, delivery.id));
    this.repo.updateGroup(group.id, { recoveryState: {
      ...(recoveryState ?? {}), status: group.paused || this.repo.latestPendingRecoveryCheckpoint(group.id) ? 'paused' : unresolved ? 'degraded' : 'recovering',
      activeRequestId: request.id, updatedAt: nowIso(),
    } as GroupRecoveryState });
    this.event(group, 'group.checkpoint.continuation', `${checkpointLabel[0]!.toUpperCase()}${checkpointLabel.slice(1)} continuation queued for the planner`, {
      checkpointId: checkpoint.id, requestId: request.id, deliveryId: deliveryIdValue, mode, sourceScope: nextScope.slice(0, 20),
    });
    return true;
  }

  private applyRecoveryResume(group: ConversationGroup): void {
    const pending = this.repo.latestPendingRecoveryCheckpoint(group.id);
    if (pending) this.acknowledgeCheckpoint(group, pending.id);
    this.repo.updateGroup(group.id, { paused: false, pauseReason: null });
    let requeued = 0;
    for (const delivery of this.repo.deliveries(group.id, ['failed', 'interrupted'])) {
      if (!delivery.retryable) continue;
      const member = this.repo.getMember(delivery.memberId);
      if (!member || member.removedAt) { this.repo.setDelivery(delivery.id, { status: 'cancelled', retryable: false, error: 'Member removed from the group' }); continue; }
      const session = this.store.getSession(member.sessionId);
      if (!session || this.sessionBusy(session)) continue;
      if (this.repo.deliverySuccessor(group.id, delivery.id)) { this.repo.setDelivery(delivery.id, { retryable: false }); continue; }
      const existing = this.existingRecoveryContinuation(group, delivery);
      if (existing) {
        this.linkRecoverySuccessor(group, delivery, existing.id);
        this.repo.setDelivery(delivery.id, { retryable: false });
        this.repo.updateMember(member.id, { held: false });
        requeued++;
        continue;
      }
      const successorId = deliveryId();
      this.repo.insertDelivery({ id: successorId, groupId: group.id, requestId: delivery.requestId, messageId: delivery.messageId, memberId: member.id,
        kind: delivery.kind, hop: delivery.hop, assignmentId: delivery.assignmentId, taskId: delivery.taskId, coordinatorEpoch: group.coordinatorEpoch });
      if (delivery.assignmentId) this.repo.reassignAssignment(delivery.assignmentId, member.id, successorId);
      this.repo.setDelivery(delivery.id, { retryable: false });
      this.linkRecoverySuccessor(group, delivery, successorId);
      this.repo.updateMember(member.id, { held: false });
      requeued++;
    }
    for (const request of this.repo.requests(group.id, 1000)) if (request.status !== 'completed') this.refreshRequest(request.id);
    const unresolved = this.repo.deliveries(group.id, ['failed', 'interrupted']).some((row) => !row.retryable && !this.repo.deliverySuccessor(group.id, row.id));
    this.repo.updateGroup(group.id, { recoveryState: unresolved ? { status: 'degraded', reason: group.recoveryState?.reason ?? 'Some deliveries still need recovery.', ...(group.recoveryState?.lastFailureId ? { lastFailureId: group.recoveryState.lastFailureId } : {}), updatedAt: nowIso() } : { status: 'recovering', updatedAt: nowIso() } });
    this.event(group, 'group.recovery.resumed', 'Group resumed after recovery action', { requeued });
  }

  /** Explicit resume acknowledges any pending checkpoint and requeues only work marked retryable. */
  resume(groupId: string): GroupSnapshot {
    this.assertOpen();
    const group = this.requireGroup(groupId);
    this.store.tx(() => this.applyRecoveryResume(group));
    this.schedule(group.id);
    return this.get(group.id);
  }

  stopMember(groupId: string, memberIdArg: string): GroupSnapshot {
    this.assertOpen();
    const group = this.requireGroup(groupId);
    const member = this.requireMember(group, memberIdArg);
    this.store.tx(() => {
      // Stop cancels pending deliveries for this member and retains a durable hold until explicit resume.
      this.repo.updateMember(member.id, { held: true });
      const pending = this.repo.memberDeliveries(member.id, ['queued', 'failed', 'interrupted']);
      for (const d of pending) this.repo.setDelivery(d.id, { status: 'cancelled', retryable: false, error: 'Cancelled when this agent was stopped' });
      for (const requestId of new Set(pending.map((d) => d.requestId))) this.refreshRequest(requestId);
      this.event(group, 'group.member.stopped', `Agent stopped: @${member.handle}`, { memberId: member.id }, member.sessionId);
    });
    this.interruptMember(member.id);
    return this.get(group.id);
  }

  resumeMember(groupId: string, memberIdArg: string): GroupSnapshot {
    this.assertOpen();
    const group = this.requireGroup(groupId);
    const member = this.requireMember(group, memberIdArg);
    if (this.memberBusy(member)) throw conflict('Wait for this agent to finish cleanup before resuming');
    this.store.tx(() => {
      this.repo.updateMember(member.id, { held: false });
      for (const d of this.repo.memberDeliveries(member.id, ['failed', 'interrupted'])) {
        if (!d.retryable) continue;
        if (this.repo.deliverySuccessor(group.id, d.id)) { this.repo.setDelivery(d.id, { retryable: false }); continue; }
        const existing = this.existingRecoveryContinuation(group, d);
        if (existing) {
          this.linkRecoverySuccessor(group, d, existing.id);
          this.repo.setDelivery(d.id, { retryable: false });
          this.refreshRequest(d.requestId);
          continue;
        }
        const nextId = deliveryId();
        this.repo.insertDelivery({ id: nextId, groupId: group.id, requestId: d.requestId, messageId: d.messageId, memberId: member.id,
          kind: d.kind, hop: d.hop, assignmentId: d.assignmentId, taskId: d.taskId, coordinatorEpoch: group.coordinatorEpoch });
        if (d.assignmentId) this.repo.reassignAssignment(d.assignmentId, member.id, nextId);
        this.repo.setDelivery(d.id, { retryable: false });
        this.linkRecoverySuccessor(group, d, nextId);
        this.refreshRequest(d.requestId);
      }
      this.event(group, 'group.member.resumed', `Agent resumed: @${member.handle}`, { memberId: member.id }, member.sessionId);
    });
    this.schedule(group.id);
    return this.get(group.id);
  }

  private interruptMember(memberIdArg: string): void {
    const member = this.repo.getMember(memberIdArg);
    if (!member || !this.repo.memberDeliveries(member.id, ['running']).length) return;
    try { this.runtime.interrupt(member.sessionId); }
    catch (error) { this.log('warn', `Could not interrupt ${member.sessionId}`, error); }
  }

  /** Startup recovery. Marks unfinished work interrupted and pauses; never starts a model run. */
  recover(): void {
    for (const group of this.repo.listGroups()) {
      try {
        this.store.tx(() => {
          let touched = 0;
          for (const d of this.repo.deliveries(group.id, ['running'])) {
            this.repo.transitionDelivery(d.id, 'running', 'interrupted', { error: 'Interrupted because Mingle restarted', retryable: true });
            const assignment = d.assignmentId ? this.repo.getAssignment(d.assignmentId) : undefined;
            if (assignment || d.taskId) this.tasks.finishRun(assignment?.taskId ?? d.taskId!, 'interrupted');
            touched++;
          }
          const waiting = this.repo.deliveries(group.id).filter((d) => d.status === 'queued' || ((d.status === 'failed' || d.status === 'interrupted') && d.retryable));
          if (waiting.length && !group.paused) {
            this.repo.updateGroup(group.id, { paused: true, pauseReason: 'Mingle restarted with unfinished work. Resume to continue; nothing was restarted automatically.' });
          }
          if (waiting.length || touched) {
            for (const request of this.repo.requestsWithStatus(group.id, 'active')) this.refreshRequest(request.id, true);
            this.event(group, 'group.recovered', 'Group work paused after restart', { interrupted: touched, waiting: waiting.length });
          }
        });
      } catch (error) {
        this.log('error', `Group recovery failed for ${group.id}`, error);
      }
    }
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
    this.pending.clear();
    this.reserved.clear();
    for (const timer of this.safeRetryTimers.values()) clearTimeout(timer);
    this.safeRetryTimers.clear();
    this.fencedCoordinatorDeliveries.clear();
  }

  // ---------------------------------------------------------------- runtime hooks

  contextForRun(sessionId: string, runId: string): GroupRunContext | undefined {
    if (this.closed) return undefined;
    const delivery = this.repo.deliveryByRun(runId) ?? this.reservedDelivery(sessionId, runId);
    if (!delivery || delivery.status !== 'running') return undefined;
    const member = this.repo.getMember(delivery.memberId);
    const group = this.repo.getGroup(delivery.groupId);
    const request = this.repo.getRequest(delivery.requestId);
    if (!member || member.removedAt || member.sessionId !== sessionId || !group || !request || group.paused || member.held) return undefined;
    const assignment = delivery.assignmentId ? this.repo.getAssignment(delivery.assignmentId) : undefined;
    const roster = this.roster(group, member);
    const lease = group.mode === 'cowork' ? this.repo.getMember(request.plannerMemberId)?.handle ?? null : null;
    const instructions = buildInstructions({
      title: group.title, mode: group.mode, self: roster.find((r) => r.you)!, roster, canAssign: this.mayAssign(group, member, request.plannerMemberId), leaseHolder: lease,
      requestExcerpt: this.repo.getMessage(request.messageId)?.content ?? '', deliveryKind: delivery.kind, hop: delivery.hop, maxHops: group.maxHops,
      turnsUsed: request.turnsUsed, maxTurns: effectiveTurnLimit(group), unread: this.repo.countAddressedAfter(group.id, member.id, member.lastReadSeq),
      crossDeviceWorker: member.role === 'worker' && Boolean(this.store.db.prepare('SELECT 1 AS found FROM mingle_team_proxy_sessions WHERE session_id=?').get(member.sessionId)),
      assignment: assignment ? { id: assignment.id, taskId: assignment.taskId, scope: assignment.scope } : null,
    });
    return { groupId: group.id, memberId: member.id, requestId: request.id, deliveryId: delivery.id, hop: delivery.hop, instructions };
  }

  /** Throws unless this run is the live delivery of this member's current session. */
  assertRunContext(ctx: GroupRunContext, runId: string, sessionId: string): void {
    const live = this.live(ctx);
    if (live.delivery.runId !== runId || live.member.sessionId !== sessionId) throw conflict('This team connection belongs to a different run');
  }

  onRunFinished(sessionId: string, runId: string, outcome: Outcome): void {
    if (this.closed) return;
    let delivery = this.repo.deliveryByRun(runId);
    if (!delivery) {
      const reservedId = this.reserved.get(sessionId);
      const candidate = reservedId ? this.repo.getDelivery(reservedId) : undefined;
      if (candidate?.status === 'running' && !candidate.runId) {
        this.repo.setDelivery(candidate.id, { runId });
        delivery = this.repo.getDelivery(candidate.id);
      }
    }
    if (delivery && outcome === 'completed' && isRecoverableRemoteCompletion(delivery.status, delivery.error)) {
      this.completeLateRemoteResult(delivery, sessionId, runId);
      return;
    }
    if (!delivery || delivery.status !== 'running') return;
    if (outcome === 'completed') this.recovery?.clearFailure(sessionId);
    this.settle(delivery, outcome);
    this.teamRunFinishedHook?.({ sessionId, runId, outcome, groupId: delivery.groupId, deliveryId: delivery.id });
  }

  private completeLateRemoteResult(delivery: DeliveryRow, sessionId: string, runId: string): void {
    const group = this.repo.getGroup(delivery.groupId);
    const member = this.repo.getMember(delivery.memberId);
    if (!group || !member || member.sessionId !== sessionId) return;
    const completed = this.store.tx(() => {
      if (!this.repo.transitionDelivery(delivery.id, delivery.status, 'completed', { error: null, retryable: false })) return false;
      const assignment = delivery.assignmentId ? this.repo.getAssignment(delivery.assignmentId) : undefined;
      const taskId = assignment?.taskId ?? delivery.taskId;
      const task = taskId ? this.store.getTask(taskId) : undefined;
      if (task?.status === 'ready') {
        this.tasks.markRunning(task);
        this.tasks.finishRun(task.id, 'completed');
      }
      this.event(group, 'group.delivery.completed', `Late remote result completed: @${member.handle}`, {
        deliveryId: delivery.id, runId, kind: delivery.kind, afterIdleTimeout: true,
      }, sessionId);
      this.refreshRequest(delivery.requestId, false);
      return true;
    });
    if (!completed) return;
    this.recovery?.clearFailure(sessionId);
    this.refreshRecoveryState(group.id);
    this.notifyCoordinator(delivery.requestId);
    this.teamRunFinishedHook?.({ sessionId, runId, outcome: 'completed', groupId: delivery.groupId, deliveryId: delivery.id });
    this.schedule(group.id);
  }

  /** Called after provider cleanup: reconcile any missed callback, then let the queue advance. */
  onRuntimeIdle(sessionId: string): void {
    if (this.closed) return;
    const member = this.repo.activeMemberOfSession(sessionId);
    if (!member) return;
    for (const delivery of this.repo.memberDeliveries(member.id, ['running'])) {
      if (this.reserved.get(sessionId) === delivery.id) continue;
      const run = delivery.runId ? this.store.getRun(delivery.runId) : undefined;
      if (!run || run.status !== 'running') this.settle(delivery, run?.status === 'completed' ? 'completed' : run?.status === 'failed' ? 'failed' : 'interrupted');
    }
    this.schedule(member.groupId);
  }

  private reservedDelivery(sessionId: string, runId: string): DeliveryRow | undefined {
    const reservedId = this.reserved.get(sessionId);
    const delivery = reservedId ? this.repo.getDelivery(reservedId) : undefined;
    if (!delivery || delivery.status !== 'running' || delivery.runId) return undefined;
    this.repo.setDelivery(delivery.id, { runId });
    return this.repo.getDelivery(delivery.id);
  }

  private settle(delivery: DeliveryRow, outcome: Outcome): void {
    const group = this.repo.getGroup(delivery.groupId);
    const member = this.repo.getMember(delivery.memberId);
    if (!group || !member) return;
    const fencedCoordinator = this.fencedCoordinatorDeliveries.has(delivery.id);
    const request = this.repo.getRequest(delivery.requestId);
    const session = this.store.getSession(member.sessionId, true);
    const providerFailure = delivery.runId ? this.recovery?.failureForRun(delivery.runId) ?? null : null;
    const failure = outcome === 'failed' ? clean(session?.error ?? 'The run failed', 500) : outcome === 'interrupted' ? 'The run was interrupted' : null;
    const verifiedProgress = this.verifiedProgress(delivery, member);
    const repeatedActionStall = delivery.runId && verifiedProgress.length === 0 ? this.recordRepeatedToolFailures(group, member, delivery) : false;
    const safeRetryAt = outcome === 'failed' && !group.paused && !member.held && !repeatedActionStall ? this.safeRetryAt(providerFailure, delivery) : null;
    try {
      this.store.tx(() => {
        if (!this.repo.transitionDelivery(delivery.id, 'running', outcome, { error: failure, retryable: outcome === 'interrupted' || Boolean(safeRetryAt) })) return;
        const assignment = delivery.assignmentId ? this.repo.getAssignment(delivery.assignmentId) : undefined;
        if (assignment || delivery.taskId) {
          const taskId = assignment?.taskId ?? delivery.taskId!;
          this.tasks.finishRun(taskId, outcome);
          const task = this.store.getTask(taskId);
          // An artifact-unblocked task that was not completed returns to blocked, not ready, while prerequisites are unfinished.
          if (task && task.status === 'ready' && unfinishedDeps(task.dependsOn, (dep) => this.store.getTask(dep)?.status).length) this.store.updateTask(task.id, { status: 'blocked' });
        }
        if (outcome === 'failed') {
          this.repo.updateMember(member.id, { held: true });
          const isPlanner = !fencedCoordinator && Boolean(request && this.hasPlannerAuthority(group, member, request.plannerMemberId));
          const reason = clean(`@${member.handle} failed: ${failure}. Other members may continue; this agent remains on hold until recovery.`, 1000);
          const previous = group.recoveryState;
          if (!fencedCoordinator) this.repo.updateGroup(group.id, { recoveryState: {
            status: 'degraded', reason, ...(providerFailure ? { lastFailureId: providerFailure.id } : {}),
            ...(request ? { activeRequestId: request.id } : {}), ...(previous?.pendingCheckpointId ? { pendingCheckpointId: previous.pendingCheckpointId } : {}),
            ...(previous?.acknowledgedDeliveryIds ? { acknowledgedDeliveryIds: previous.acknowledgedDeliveryIds.slice(-100) } : {}), updatedAt: nowIso(),
          } });
          this.event(group, fencedCoordinator ? 'group.coordinator.stale-run.failed' : isPlanner ? 'group.coordinator.degraded' : 'group.delivery.failed', fencedCoordinator ? `Former coordinator run failed: @${member.handle}` : isPlanner ? `Coordinator unavailable: @${member.handle}` : `Delivery failed: @${member.handle}`, {
            deliveryId: delivery.id, error: failure, failureId: providerFailure?.id ?? null, failureKind: providerFailure?.kind ?? null,
            isolatedByStallGuard: repeatedActionStall, retryAt: safeRetryAt,
          }, member.sessionId);
        } else if (outcome === 'interrupted') {
          // An interruption outside a group stop still holds the member so it is not restarted behind the user's back.
          if (!group.paused && !member.held) {
            this.repo.updateMember(member.id, { held: true });
            this.event(group, 'group.member.held', `Agent interrupted: @${member.handle} is on hold`, { memberId: member.id }, member.sessionId);
          }
        } else {
          this.event(group, 'group.delivery.completed', `Delivery completed: @${member.handle}`, { deliveryId: delivery.id, kind: delivery.kind }, member.sessionId);
        }
        if (verifiedProgress.length) this.event(group, 'group.progress.verified', `Verified progress recorded for @${member.handle}`, {
          requestId: delivery.requestId, memberId: member.id, deliveryId: delivery.id, runId: delivery.runId, evidence: verifiedProgress,
        }, member.sessionId);
        if (verifiedProgress.length) this.repo.clearStallEvidence(group.id, member.id, delivery.requestId);
        this.refreshRequest(delivery.requestId, outcome !== 'completed');
      });
    } catch (error) {
      this.log('error', `Could not record group delivery outcome for ${delivery.id}`, error);
    }
    if (fencedCoordinator) {
      const currentGroup = this.repo.getGroup(group.id);
      const currentRequest = this.repo.getRequest(delivery.requestId);
      const plannerId = currentGroup?.mode === 'cowork' ? currentRequest?.plannerMemberId : currentGroup?.orchestratorMemberId;
      const replacement = plannerId ? this.repo.getMember(plannerId) : undefined;
      if (currentGroup && currentRequest && replacement && replacement.id !== member.id && currentRequest.status !== 'completed') {
        const state = currentGroup.recoveryState;
        this.store.tx(() => this.queueCoordinatorContinuation(currentGroup, currentRequest, replacement, delivery, state?.acknowledgedCheckpointId));
      }
      this.fencedCoordinatorDeliveries.delete(delivery.id);
    }
    if (safeRetryAt) this.scheduleSafeRetry(delivery.id, safeRetryAt);
    if (outcome === 'completed' || outcome === 'failed' || outcome === 'interrupted') this.notifyCoordinator(delivery.requestId);
    if (outcome === 'completed') this.refreshRecoveryState(group.id);
    this.schedule(group.id);
  }

  private refreshRecoveryState(groupId: string): void {
    const group = this.repo.getGroup(groupId);
    const prior = group?.recoveryState;
    if (!group || !prior || prior.status === 'healthy') return;
    const unresolved = this.repo.deliveries(group.id, ['failed', 'interrupted']).some((row) => !row.retryable && !this.repo.deliverySuccessor(group.id, row.id));
    if (unresolved) return;
    const pendingCheckpoint = this.repo.latestPendingRecoveryCheckpoint(group.id);
    const recoveryPending = this.repo.deliveries(group.id, ['queued', 'running']).some((row) => Boolean(this.repo.deliverySource(group.id, row.id)));
    const status: GroupRecoveryState['status'] = pendingCheckpoint || group.paused ? 'paused' : recoveryPending ? 'recovering' : 'healthy';
    this.repo.updateGroup(group.id, { recoveryState: {
      status, ...(pendingCheckpoint?.reason ? { reason: pendingCheckpoint.reason } : group.paused && group.pauseReason ? { reason: group.pauseReason } : {}),
      ...(prior.lastFailureId && unresolved ? { lastFailureId: prior.lastFailureId } : {}),
      ...(pendingCheckpoint?.id ? { pendingCheckpointId: pendingCheckpoint.id } : {}),
      ...(prior.acknowledgedCheckpointId ? { acknowledgedCheckpointId: prior.acknowledgedCheckpointId } : {}),
      ...(prior.acknowledgedDeliveryIds ? { acknowledgedDeliveryIds: prior.acknowledgedDeliveryIds.slice(-100) } : {}),
      ...(prior.activeRequestId ? { activeRequestId: prior.activeRequestId } : {}), updatedAt: nowIso(),
    } });
  }

  /** Only provider-proven non-dispatch may be retried automatically, and only once within the bounded retry window. */
  private safeRetryAt(failure: ProviderFailure | null, delivery: DeliveryRow): string | null {
    if (!failure || !failure.retryable || failure.safeToRetry !== true || failure.dispatchState !== 'not-dispatched'
      || failure.outcomeUnknown !== false || !failure.retryAt || delivery.attempts > MAX_SAFE_RETRIES
      || this.repo.deliverySource(delivery.groupId, delivery.id) !== undefined) return null;
    const retryAt = Date.parse(failure.retryAt);
    const now = Date.now();
    return Number.isFinite(retryAt) && retryAt > now && retryAt <= now + MAX_SAFE_RETRY_DELAY_MS ? new Date(retryAt).toISOString() : null;
  }

  private scheduleSafeRetry(deliveryIdArg: string, retryAt: string): void {
    const prior = this.safeRetryTimers.get(deliveryIdArg);
    if (prior) clearTimeout(prior);
    const delay = Math.max(0, Date.parse(retryAt) - Date.now());
    const timer = setTimeout(() => {
      this.safeRetryTimers.delete(deliveryIdArg);
      if (this.closed) return;
      const delivery = this.repo.getDelivery(deliveryIdArg);
      const group = delivery ? this.repo.getGroup(delivery.groupId) : undefined;
      const member = delivery ? this.repo.getMember(delivery.memberId) : undefined;
      const request = delivery ? this.repo.getRequest(delivery.requestId) : undefined;
      const failure = delivery?.runId ? this.recovery?.failureForRun(delivery.runId) : null;
      // A failed run holds its member automatically; explicit member stop cancels the delivery itself.
      if (!delivery || !group || !member || !request || delivery.status !== 'failed' || !delivery.retryable || group.paused
        || !failure || failure.runId !== delivery.runId || failure.sessionId !== member.sessionId || failure.retryAt !== retryAt
        || this.repo.deliverySuccessor(group.id, delivery.id) || this.repo.deliverySource(group.id, delivery.id)) return;
      this.store.tx(() => {
        const successorId = deliveryId();
        this.repo.insertDelivery({ id: successorId, groupId: group.id, requestId: request.id, messageId: delivery.messageId, memberId: member.id,
          kind: delivery.kind, hop: delivery.hop, assignmentId: delivery.assignmentId, taskId: delivery.taskId, coordinatorEpoch: group.coordinatorEpoch });
        if (delivery.assignmentId) this.repo.reassignAssignment(delivery.assignmentId, member.id, successorId);
        this.repo.setDelivery(delivery.id, { retryable: false });
        this.linkRecoverySuccessor(group, delivery, successorId);
        this.repo.updateRequest(request.id, { status: 'active' });
        this.repo.updateMember(member.id, { held: false });
        this.repo.updateGroup(group.id, { recoveryState: { status: 'recovering', activeRequestId: request.id, updatedAt: nowIso() } });
        this.event(group, 'group.delivery.safe-retry', `Retrying a delivery that the provider confirmed was not dispatched: @${member.handle}`, {
          deliveryId: delivery.id, successorDeliveryId: successorId, failureId: failure.id, retryAt,
        }, member.sessionId);
      });
      this.schedule(group.id);
    }, Math.min(delay, MAX_SAFE_RETRY_DELAY_MS));
    timer.unref?.();
    this.safeRetryTimers.set(deliveryIdArg, timer);
  }

  /** Progress signals are host records, never message count or model-declared success. */
  private verifiedProgress(delivery: DeliveryRow, member: MemberRow): string[] {
    if (!delivery.runId) return [];
    const run = this.store.getRun(delivery.runId);
    const tools = this.store.listRunTools(delivery.runId, 1000);
    const evidence: string[] = [];
    const check = tools.find((tool) => tool.category === 'command' && tool.status === 'completed' && tool.exitCode === 0
      && /\b(test|check|lint|typecheck|build|verify|validate|compile|tsc|pytest|cargo\s+check)\b/i.test(`${tool.name} ${tool.command ?? ''}`));
    if (check) evidence.push(`successful-check:${check.id}`);
    const startedAt = run?.startedAt ?? delivery.startedAt ?? delivery.createdAt;
    const artifact = this.repo.artifactsForRequest(delivery.requestId).find((row) => row.fromMemberId === member.id && row.createdAt >= startedAt);
    if (artifact) evidence.push(`verified-artifact:${artifact.id}`);
    return evidence.slice(0, 5);
  }

  /** Count the same failed native action only across separate runs of the same assignment/member. */
  private recordRepeatedToolFailures(group: ConversationGroup, member: MemberRow, delivery: DeliveryRow): boolean {
    if (!delivery.runId) return false;
    const assignmentId = delivery.assignmentId ?? delivery.taskId ?? delivery.requestId;
    const failed = this.store.listRunTools(delivery.runId, 1000).filter((tool) => tool.status === 'failed' || (tool.status === 'completed' && tool.exitCode !== null && tool.exitCode !== 0));
    let stalled = false;
    for (const tool of failed) {
      const signature = createHash('sha256').update(JSON.stringify([tool.category, tool.name, tool.command ?? '', tool.input ?? '', tool.exitCode])).digest('hex');
      stalled = this.recordStallSignal(group, member, delivery.requestId, 'repeated-tool-failure', `${assignmentId}:${signature}`, delivery.runId,
        [tool.id], `The same native action has failed in ${STALL_RUN_THRESHOLD} separate runs for this assignment.`) || stalled;
    }
    return stalled;
  }

  /** Durable, bounded event-backed evidence works on both newly-created and already-open databases. */
  private recordStallSignal(
    group: ConversationGroup, member: MemberRow, requestIdArg: string, signal: string, fingerprint: string, runId: string | null,
    evidenceIds: string[], reason: string,
  ): boolean {
    const delivery = runId ? this.repo.deliveryByRun(runId) : undefined;
    const evidence = this.repo.recordStallEvidence({
      groupId: group.id, memberId: member.id, requestId: requestIdArg, deliveryId: delivery?.id ?? null,
      assignmentId: delivery?.assignmentId ?? null, fingerprint, signalClass: signal, reason: clean(reason, 500),
      sourceRunId: runId, sourceToolId: signal === 'repeated-tool-failure' ? evidenceIds[0] ?? null : null,
      sourceTaskId: delivery?.taskId ?? (delivery?.assignmentId ? this.repo.getAssignment(delivery.assignmentId)?.taskId : null),
    });
    if (evidence.duplicate) return member.held;
    const count = evidence.consecutiveCount;
    const current = this.repo.getMember(member.id);
    if (count <= STALL_RUN_THRESHOLD) this.event(group, 'group.stall.evidence', `Stall evidence recorded for @${member.handle}`, {
      signal, fingerprint, requestId: requestIdArg, memberId: member.id, runId,
      evidenceIds: evidenceIds.slice(0, 5), count, threshold: STALL_RUN_THRESHOLD, reason: clean(reason, 500),
    }, member.sessionId);
    if (count < STALL_RUN_THRESHOLD) return false;
    if (!current || current.held) return Boolean(current?.held);
    const notice = clean(`Paused @${member.handle}: ${reason} Further work for this member stays queued; review the evidence, change the scope, or explicitly resume the member.`, 1000);
    this.store.tx(() => {
      this.repo.updateMember(member.id, { held: true });
      this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: [member.id], kind: 'status', requestId: requestIdArg, content: notice });
      this.event(group, 'group.stall.detected', `Stall guard held @${member.handle}`, {
        signal, fingerprint, requestId: requestIdArg, memberId: member.id, runId, count, threshold: STALL_RUN_THRESHOLD, reason: clean(reason, 500),
      }, member.sessionId);
    });
    return true;
  }

  // ---------------------------------------------------------------- queue

  private schedule(groupId: string): void {
    if (this.closed) return;
    this.pending.add(groupId);
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      const ids = [...this.pending];
      this.pending.clear();
      if (this.closed) return;
      for (const id of ids) this.pump(id);
    });
  }

  private async pump(groupId: string): Promise<void> {
    try {
      let group = this.repo.getGroup(groupId);
      if (!group || group.paused) return;
      if (group.recoveryPolicy?.automaticFallback) {
        for (const failed of this.repo.deliveries(groupId, ['failed'])) {
          const moved = await this.attemptAutomaticWorkerFallback(group, failed);
          if (moved) group = this.repo.getGroup(groupId) ?? group;
        }
      }
      if (group.recoveryState?.status === 'degraded' && group.recoveryPolicy?.automaticFallback) {
        await this.attemptAutomaticLeadFallback(group);
        group = this.repo.getGroup(groupId);
        if (!group || group.paused) return;
      }
      const queued = this.repo.deliveries(groupId, ['queued']);
      if (!queued.length) return;
      // An interrupted delivery can still own a provider cleanup lock. It continues to consume a parallel slot.
      const activeProviders = this.repo.members(groupId, false).filter((member) => this.runtime.isActive(member.sessionId)).length;
      let capacity = group.maxParallel - Math.max(activeProviders, this.repo.deliveries(groupId, ['running']).length);
      if (capacity <= 0) return;
      const members = new Map(this.repo.members(groupId, false).map((m) => [m.id, m]));
      const lastStart = this.repo.lastStarts(groupId);
      const byMember = new Map<string, DeliveryRow[]>();
      for (const d of queued) byMember.set(d.memberId, [...(byMember.get(d.memberId) ?? []), d]);
      // Members that have waited longest since their last start go first, so no member starves under maxParallel.
      const order = [...byMember.keys()].sort((a, b) => (lastStart.get(a) ?? '').localeCompare(lastStart.get(b) ?? ''));
      for (const id of order) {
        if (capacity <= 0 || this.closed) break;
        const member = members.get(id);
        const list = byMember.get(id)!;
        if (!member) {
          for (const d of list) this.cancel(d, 'Member removed from the group');
          continue;
        }
        if (member.held) continue;
        const session = this.store.getSession(member.sessionId);
        if (!session) {
          for (const d of list) this.cancel(d, 'The member session is no longer available');
          continue;
        }
        if (this.teamDispatchGuard && !(await this.teamDispatchGuard(session.id, group.id))) {
          this.schedule(groupId);
          return;
        }
        group = this.repo.getGroup(groupId) ?? group;
        if (group.paused) return;
        if (this.sessionBusy(session)) continue;
        for (const d of list) {
          const verdict = this.readiness(group, member, d);
          if (verdict === 'defer') continue;
          if (verdict === 'cancel') continue;
          if (await this.startDelivery(group, member, session, d)) capacity--;
          break;
        }
        if (this.repo.getGroup(groupId)?.paused) return;
      }
    } catch (error) {
      this.log('error', `Group queue failed for ${groupId}`, error);
      try {
        const group = this.repo.getGroup(groupId);
        if (group && !group.paused) {
          this.repo.updateGroup(groupId, { paused: true, pauseReason: `The queue stopped on an internal error: ${clean(errorMessage(error), 300)}` });
          this.event(group, 'group.queue.error', 'Group queue stopped on an internal error', { error: clean(errorMessage(error), 300) });
        }
      } catch { /* the error is already logged */ }
    }
  }

  private readiness(group: ConversationGroup, member: MemberRow, d: DeliveryRow): 'ready' | 'defer' | 'cancel' {
    if (d.kind === 'message' && this.isDeferredRemoteCompletionReply(group, member, d)) return 'defer';
    if (d.taskId && d.kind !== 'assignment') {
      const task = this.store.getTask(d.taskId);
      if (!task || task.sessionId !== member.sessionId || task.status === 'done') { this.cancel(d, 'The task was removed, reassigned or already accepted'); return 'cancel'; }
      try { this.tasks.assertRunnable(task.id); } catch { return 'defer'; }
      return 'ready';
    }
    if (d.kind !== 'assignment') return 'ready';
    const assignment = d.assignmentId ? this.repo.getAssignment(d.assignmentId) : undefined;
    const task = assignment ? this.store.getTask(assignment.taskId) : undefined;
    if (!assignment || !task) { this.cancel(d, 'The assignment task no longer exists'); return 'cancel'; }
    if (task.sessionId !== member.sessionId || task.projectId !== group.projectId || assignment.toMemberId !== member.id) { this.cancel(d, 'The assignment task was reassigned or no longer belongs to this agent'); return 'cancel'; }
    if (task.status === 'done') { this.cancel(d, 'The task was already accepted as done'); return 'cancel'; }
    if (task.status === 'running' || task.status === 'backlog') return 'defer';
    return this.dependencyState(assignment, task).waiting.length ? 'defer' : 'ready';
  }

  /**
   * A remote worker can report Review and ask its coordinator to inspect the result before its
   * owner-side run has stopped. Keep that reply queued until the proxy delivery is settled: the
   * host imports and integrates committed artifacts before it calls onRunFinished. Other live
   * questions remain eligible immediately, and this condition is derived from durable group state
   * so it also holds after a host restart.
   */
  private isDeferredRemoteCompletionReply(group: ConversationGroup, recipient: MemberRow, queued: DeliveryRow): boolean {
    const message = this.repo.getMessage(queued.messageId);
    if (!message?.sourceRunId || !message.senderMemberId) return false;
    const source = this.repo.deliveryByRun(message.sourceRunId);
    if (!source || source.status !== 'running' || source.groupId !== group.id || source.requestId !== queued.requestId
      || source.memberId !== message.senderMemberId) return false;
    const sender = this.repo.getMember(source.memberId);
    const isProxy = sender && Boolean(this.store.db.prepare('SELECT 1 AS found FROM mingle_team_proxy_sessions WHERE session_id=?')
      .get(sender.sessionId));
    if (!isProxy) return false;
    const assignment = source.assignmentId ? this.repo.getAssignment(source.assignmentId) : undefined;
    const task = assignment ? this.store.getTask(assignment.taskId) : undefined;
    return Boolean(assignment && task?.status === 'review' && assignment.toMemberId === sender.id
      && assignment.fromMemberId === recipient.id && queued.memberId === recipient.id);
  }

  /**
   * Legacy dependencies need Done. A dependency waiting in Review is satisfied only by an exact explicit input-artifact opt-in
   * (producer task, path) backed by a verified artifact published by that task's owner to this assignee. Never fakes Done.
   */
  private dependencyState(assignment: AssignmentRow, task: Task): { waiting: string[] } {
    const inputs = this.repo.inputs(assignment.id);
    const waiting: string[] = [];
    for (const dependencyId of task.dependsOn) {
      const dependency = this.store.getTask(dependencyId);
      if (!dependency) { waiting.push(dependencyId); continue; }
      if (dependency.status === 'done') continue;
      const wanted = inputs.filter((input) => input.taskId === dependencyId);
      if (!wanted.length || dependency.status !== 'review') { waiting.push(dependencyId); continue; }
      const satisfied = wanted.every((input) => this.verifiedArtifact(assignment, dependency, input.path, input.artifactId));
      if (!satisfied) waiting.push(dependencyId);
    }
    return { waiting };
  }

  private verifiedArtifact(assignment: AssignmentRow, producerTask: Task, path: string, linked: string | null): ArtifactRow | undefined {
    const candidates = [...(linked ? [this.repo.getArtifact(linked)] : []), ...this.repo.matchingArtifacts(assignment.groupId, assignment.toMemberId, producerTask.id, path)];
    return candidates.find((artifact): artifact is ArtifactRow => Boolean(artifact)
      && artifact!.toMemberId === assignment.toMemberId && artifact!.taskId === producerTask.id && artifact!.path === path
      && producerTask.sessionId !== null && this.repo.getMember(artifact!.fromMemberId)?.sessionId === producerTask.sessionId);
  }

  private async startDelivery(group: ConversationGroup, member: MemberRow, session: Session, d: DeliveryRow): Promise<boolean> {
    const request = this.repo.getRequest(d.requestId);
    if (!request) { this.cancel(d, 'The request no longer exists'); return false; }
    if (d.hop > group.maxHops) {
      this.holdBudget(group, request.id, `A queued delivery needs hop ${d.hop}, above the current ${group.maxHops} hop limit. Raise the hop limit and resume, or cancel the affected agent's pending work.`);
      return false;
    }
    const turnLimit = effectiveTurnLimit(group);
    if (turnLimit !== null && request.turnsUsed >= turnLimit) {
      this.exhaustBudget(group, request.id);
      return false;
    }
    const assignment = d.assignmentId ? this.repo.getAssignment(d.assignmentId) : undefined;
    const recoverySource = this.repo.deliverySource(group.id, d.id);
    const planInput = request.executionPlanId ? this.planInputMessage(request.executionPlanId, group.id, member.id) : undefined;
    if (request.executionPlanId && !planInput) {
      this.cancel(d, 'The original plan inputs are no longer available. Replan with the current group agent.');
      return false;
    }
    const sourceMessageId = planInput?.id ?? (recoverySource ? request.messageId : d.messageId);
    let nativeInvocation: import('@mingle/contracts').NativeInvocation | undefined;
    const invocationMessage = this.repo.getMessage(sourceMessageId);
    if (invocationMessage?.invocation) {
      const saved = invocationMessage.invocation as GroupInvocation;
      if (saved.memberId !== member.id || saved.sessionId !== session.id || saved.provider !== session.provider || saved.model !== session.model) {
        this.cancel(d, 'The selected agent or its settings changed while the native action was queued. Select it again.');
        return false;
      }
      if (!this.catalog) { this.cancel(d, 'Provider command discovery is unavailable. Refresh the action catalog and retry.'); return false; }
      const current = await this.catalog(session, true);
      const items = saved.kind === 'command' ? nativeActionCommands(session.provider, current.commands) : current.skills;
      const resolved = saved.kind === 'skill'
        ? resolveProviderSkill(session.provider, current.skills, saved.id, saved.name)
        : items.find((item) => item.id === saved.id && item.name === saved.name);
      if (!resolved) { this.cancel(d, 'The provider action is no longer available. Refresh the catalog and select it again.'); return false; }
      nativeInvocation = { kind: saved.kind, name: saved.name, arguments: saved.arguments, ...(saved.kind === 'skill' ? { skill: resolved as import('@mingle/contracts').ProviderSkill } : {}) };
      const latestGroup = this.repo.getGroup(group.id);
      const latestMember = this.repo.members(group.id, false).find((row) => row.id === member.id);
      const latestSession = latestMember ? this.store.getSession(latestMember.sessionId) : undefined;
      const latestDelivery = this.repo.getDelivery(d.id);
      const latestRequest = this.repo.getRequest(d.requestId);
      if (!latestGroup || !latestMember || !latestSession) {
        if (latestDelivery?.status === 'queued') this.cancel(d, 'The selected group agent is no longer available.');
        return false;
      }
      if (latestMember.sessionId !== session.id || latestSession.provider !== saved.provider || latestSession.model !== saved.model) {
        if (latestDelivery?.status === 'queued') this.cancel(d, 'The selected agent or its settings changed while the native action was queued. Select it again.');
        return false;
      }
      if (latestDelivery?.status !== 'queued' || latestDelivery.memberId !== d.memberId || !latestRequest || latestRequest.status !== 'active') return false;
      if (latestGroup.paused || latestMember.held || this.sessionBusy(latestSession)) return false;
      const latestTurnLimit = effectiveTurnLimit(latestGroup);
      if (latestTurnLimit !== null && latestRequest.turnsUsed >= latestTurnLimit) { this.exhaustBudget(latestGroup, latestRequest.id); return false; }
      if (d.hop > latestGroup.maxHops) {
        this.holdBudget(latestGroup, latestRequest.id, `A queued delivery needs hop ${d.hop}, above the current ${latestGroup.maxHops} hop limit. Raise the hop limit and resume, or cancel the affected agent's pending work.`);
        return false;
      }
    }
    const text = request.intent === 'plan' && d.kind === 'request'
      ? this.repo.getMessage(d.messageId)?.content ?? this.deliveryText(group, member, d, request.plannerMemberId)
      : this.deliveryText(group, member, d, request.plannerMemberId);
    const reserved = this.store.tx(() => {
      if (!this.repo.transitionDelivery(d.id, 'queued', 'running', { runId: null, startedAt: nowIso(), attemptsDelta: 1 })) return false;
      this.repo.updateRequest(request.id, { status: 'active', turnsDelta: 1 });
      return true;
    });
    if (!reserved) return false;
    this.reserved.set(session.id, d.id);
    let runId: string;
    try {
      // Recovery continuations have their own status/assignment prompt, but selected user inputs
      // remain owned by the original request message. Resolve them there for every recovery path.
      const attachmentOwnerId = sourceMessageId;
      const contextSourceMessage = this.repo.getMessage(attachmentOwnerId);
      const context = await buildMessageContext(contextSourceMessage?.contextRefs, (ref) => this.store.getSession(ref.sourceSessionId, true)?.worktreePath, (sourceSessionId, messageId) => {
        if (contextSourceMessage?.contextRefs?.some((ref) => ref.kind === 'quote' && ref.sourceSessionId === sourceSessionId && ref.sourceMessageId === messageId)) {
          const sourceMember = this.repo.members(group.id, true).find((candidate) => candidate.sessionId === sourceSessionId);
          if (!sourceMember) return undefined;
        }
        return this.store.getMessage(messageId);
      });
      runId = this.runtime.start(session.id, text, { groupDeliveryId: d.id, taskId: assignment?.taskId ?? d.taskId ?? undefined,
        userMessage: { content: text, kind: 'group-delivery' }, attachmentOwnerKind: 'group_message', attachmentOwnerId, invocation: nativeInvocation, context, contextRefs: contextSourceMessage?.contextRefs,
        intent: request.intent === 'plan' && d.kind === 'request' ? 'plan' : 'normal', executionPlanId: d.kind === 'request' ? request.executionPlanId : undefined });
    } catch (error) {
      this.reserved.delete(session.id);
      const message = clean(errorMessage(error), 500);
      this.store.tx(() => {
        const freshSession = this.store.getSession(session.id);
        if (error instanceof HttpError && error.status === 409 && (this.runtime.isActive(session.id) || freshSession?.status === 'running' || freshSession?.status === 'waiting')) {
          // The session became busy between the check and the start; wait for it instead of failing the delivery.
          this.repo.transitionDelivery(d.id, 'running', 'queued', { runId: null, attemptsDelta: -1 });
          this.repo.updateRequest(request.id, { turnsDelta: -1 });
          return;
        }
        this.repo.transitionDelivery(d.id, 'running', 'failed', { error: message, retryable: false, attemptsDelta: 0 });
        this.repo.updateRequest(request.id, { status: 'paused', turnsDelta: -1 });
        if (request.executionPlanId) {
          const plan = this.store.getSessionPlan(request.executionPlanId);
          if (plan?.status === 'executing' && !plan.executionRunId) {
            this.store.updateSessionPlan({ ...plan, status: 'failed', updatedAt: nowIso() });
            this.store.recordEvent({ projectId: group.projectId, sessionId: plan.sessionId, type: 'session.plan.execution.failed', summary: `Approved plan execution could not start (revision ${plan.revision})`, payload: { planId: plan.id, revision: plan.revision, error: message } });
          }
        }
        this.repo.updateMember(member.id, { held: true });
        const reason = clean(`Could not start @${member.handle}: ${message}. Other group members may continue; recover this member explicitly.`, 1000);
        this.repo.updateGroup(group.id, { recoveryState: { status: 'degraded', reason, activeRequestId: request.id, updatedAt: nowIso() } });
        this.event(group, 'group.delivery.failed', `Could not start @${member.handle}`, { deliveryId: d.id, error: message, dispatchState: 'not-dispatched' }, session.id);
      });
      this.log('warn', `Group delivery ${d.id} could not start`, error);
      return false;
    }
    this.repo.setDelivery(d.id, { runId });
    this.reserved.delete(session.id);
    this.event(group, 'group.delivery.started', `Delivery started: @${member.handle}`, { deliveryId: d.id, runId, kind: d.kind, hop: d.hop }, session.id);
    return true;
  }

  private exhaustBudget(group: ConversationGroup, requestIdArg: string): void {
    const limit = effectiveTurnLimit(group);
    this.holdBudget(group, requestIdArg, `A request used all ${limit ?? 'configured'} allowed model turns. Pending work is retained. Raise the turn limit and resume, or cancel the affected agent's pending work and send a new request.`);
  }

  private holdBudget(group: ConversationGroup, requestIdArg: string, reason: string): void {
    this.store.tx(() => this.holdBudgetRecord(group, requestIdArg, reason));
  }

  /** Caller already owns Store.tx. */
  private holdBudgetRecord(group: ConversationGroup, requestIdArg: string, reason: string): void {
    this.repo.updateRequest(requestIdArg, { status: 'paused' });
    this.repo.updateGroup(group.id, { paused: true, pauseReason: reason });
    this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: [], kind: 'status', content: reason, requestId: requestIdArg });
    this.event(group, 'group.budget.exhausted', 'Coordination budget reached; queued work is retained', { requestId: requestIdArg, maxTurns: effectiveTurnLimit(group), maxHops: group.maxHops });
  }

  private cancel(d: DeliveryRow, reason: string): void {
    this.store.tx(() => {
      if (!this.repo.transitionDelivery(d.id, d.status, 'cancelled', { error: reason, retryable: false })) return;
      this.refreshRequest(d.requestId);
      const group = this.repo.getGroup(d.groupId);
      if (group) this.event(group, 'group.delivery.cancelled', `Delivery cancelled: ${reason}`, { deliveryId: d.id, memberId: d.memberId });
    });
  }

  /** The text a delivery sends to its member; also stored as the native `group-delivery` user message. */
  private deliveryText(group: ConversationGroup, member: MemberRow, d: DeliveryRow, plannerId: string): string {
    const message = this.repo.getMessage(d.messageId);
    const content = message?.content ?? '';
    if (message?.invocation) {
      const action = message.invocation as GroupInvocation;
      const prefix = action.kind === 'skill' && action.provider === 'codex' ? '$' : '/';
      return `${prefix}${action.name}${action.arguments ? ` ${action.arguments}` : ''}`;
    }
    let text: string;
    if (d.kind === 'request') {
      const requestDeliveries = this.repo.requestDeliveries(d.requestId).filter((row) => row.kind === 'request');
      const broadcast = (message?.recipientMemberIds.length ?? 0) > 1 && requestDeliveries.length === 1;
      text = requestDeliveryText({ content, handle: member.handle, planner: broadcast && plannerId === member.id, mode: group.mode, directed: !broadcast });
      if (member.role === 'orchestrator' && group.mode === 'orchestrated') text += this.bootstrap(group, member, d);
    } else if (d.kind === 'message') {
      text = messageDeliveryText({ from: this.repo.getMember(message?.senderMemberId ?? '')?.handle ?? 'a teammate', content });
    } else text = content;
    if (d.attempts > 0) text = `Retry: your previous attempt at this delivery did not complete. Continue from your current workspace state rather than starting over.\n\n${text}`;
    return truncate(text, d.kind === 'request' ? 106_000 : LIMITS.message + 2000);
  }

  /** Bounded first-turn context for a freshly created orchestrator: references, never replayed transcripts. */
  private bootstrap(group: ConversationGroup, member: MemberRow, d: DeliveryRow): string {
    if (this.repo.memberDeliveries(member.id, ['completed', 'failed', 'interrupted', 'running']).some((row) => row.id !== d.id)) return '';
    const others = this.repo.members(group.id, false).filter((m) => m.id !== member.id);
    const lines = ['', 'Context for your first turn as orchestrator (a bounded reference, not a transcript):'];
    for (const other of others) {
      const session = this.store.getSession(other.sessionId);
      if (session) lines.push(`- @${other.handle} works in "${clean(session.name, 80)}" (${session.provider}/${session.model}); its native conversation remains in session ${session.id}.`);
    }
    const open = this.store.listTasks(group.projectId).filter((task) => task.status !== 'done').slice(-8);
    if (open.length) lines.push('Open project tasks:', ...open.map((task) => `- ${task.id} [${task.status}] ${clean(task.title, 100)}`));
    return lines.join('\n');
  }

  private roster(group: ConversationGroup, self: MemberRow): RosterEntry[] {
    const queued = new Map<string, number>();
    for (const d of this.repo.deliveries(group.id, ['queued'])) queued.set(d.memberId, (queued.get(d.memberId) ?? 0) + 1);
    return this.repo.members(group.id, false).map((m) => {
      const session = this.store.getSession(m.sessionId);
      const running = this.repo.memberDeliveries(m.id, ['running']).length > 0;
      const state = m.held ? 'stopped' : running ? 'running' : queued.get(m.id) ? `idle, ${queued.get(m.id)} queued` : session && this.sessionBusy(session) ? 'busy' : 'idle';
      return { handle: m.handle, role: m.role, provider: session?.provider ?? 'unknown', model: session?.model ?? 'unknown', state, you: m.id === self.id };
    });
  }

  // ---------------------------------------------------------------- coordinator result batches

  /** Once per finished delegation batch, hand the delegating coordinator one compact result delivery. */
  private notifyCoordinator(requestIdArg: string): void {
    const request = this.repo.getRequest(requestIdArg);
    const group = request ? this.repo.getGroup(request.groupId) : undefined;
    if (!request || !group) return;
    const assignments = this.repo.requestAssignments(request.id);
    const fresh = assignments.filter((a) => !a.notified);
    if (!fresh.length) return;
    const deliveries = new Map(assignments.map((a) => [a.id, this.repo.getDelivery(a.deliveryId)]));
    // A batch settles on terminal outcomes; only a retry that is explicitly safe remains outstanding.
    if ([...deliveries.values()].some((d) => !d || OPEN_DELIVERY.includes(d.status) || ((d.status === 'failed' || d.status === 'interrupted') && d.retryable))) return;
    for (const delegator of new Set(fresh.map((a) => a.fromMemberId))) {
      const batch = fresh.filter((a) => a.fromMemberId === delegator);
      const currentPlanner = group.mode === 'cowork' ? request.plannerMemberId : group.orchestratorMemberId;
      const target = this.repo.getMember(currentPlanner ?? delegator) ?? this.repo.getMember(delegator);
      const hop = Math.max(...batch.map((a) => deliveries.get(a.id)!.hop)) + 1;
      this.repo.markNotified(batch.map((a) => a.id));
      if (!target || target.removedAt) continue;
        const committed = request.turnsUsed + this.repo.requestDeliveries(request.id, ['queued']).length;
       const turnLimit = effectiveTurnLimit(group);
       const blockedByBudget = hop > group.maxHops || (turnLimit !== null && committed >= turnLimit);
      const reportable = batch.filter((assignment) => !this.hasQueuedAssignmentReply(request.id, target.id, assignment));
      if (!reportable.length) continue;
      const lines: ResultLine[] = reportable.map((a) => {
        const d = deliveries.get(a.id)!;
        const worker = this.repo.getMember(a.toMemberId);
        const workerSession = worker ? this.store.getSession(worker.sessionId, true) : undefined;
        return {
          handle: worker?.handle ?? 'unknown', title: this.store.getTask(a.taskId)?.title ?? a.taskId, outcome: d.status,
          summary: d.status === 'completed' && workerSession ? this.finalResult(workerSession.id, d.runId) : d.error ?? '',
        };
      });
      const message = this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: [delegator], kind: 'status', content: resultText(lines), requestId: request.id });
      this.repo.insertDelivery({ id: deliveryId(), groupId: group.id, requestId: request.id, messageId: message.id, memberId: delegator, kind: 'result', hop });
      this.repo.updateRequest(request.id, { status: 'active' });
      this.event(group, 'group.result.queued', 'Worker results queued for the coordinator', { requestId: request.id, workers: reportable.length });
      if (blockedByBudget) this.holdBudget(group, request.id, 'Worker results are ready, but reviewing them needs another model turn or message hop. The result delivery is retained; raise the applicable group limit and resume, or address the coordinator in a new request.');
    }
  }

  /** A worker's already-queued reply request carries its completion note; do not add a duplicate result turn. */
  private hasQueuedAssignmentReply(requestId: string, coordinatorMemberId: string, assignment: AssignmentRow): boolean {
    const sourceDelivery = this.repo.getDelivery(assignment.deliveryId);
    if (!sourceDelivery?.runId) return false;
    return this.repo.requestDeliveries(requestId, ['queued']).some((delivery) => {
      if (delivery.kind !== 'message' || delivery.memberId !== coordinatorMemberId) return false;
      const message = this.repo.getMessage(delivery.messageId);
      return message?.senderMemberId === assignment.toMemberId && message.sourceRunId === sourceDelivery.runId;
    });
  }

  /** Bounded excerpt of the member's final native assistant message for this run. */
  private finalResult(sessionId: string, runId: string | null): string {
    if (!runId) return '';
    const messages = this.store.listMessages(sessionId, { limit: 80 });
    for (let i = messages.length - 1; i >= 0; i--) {
      const row = messages[i]!;
      if (row.role === 'assistant' && row.runId === runId && row.content.trim()) return clean(row.content.trim(), LIMITS.summary);
    }
    return '';
  }

  /** Request status follows its deliveries. `hold` marks unfinished work as waiting for an explicit resume. */
  private refreshRequest(id: string, hold = false): void {
    const request = this.repo.getRequest(id);
    if (!request) return;
    const open = this.repo.requestDeliveries(id, OPEN_DELIVERY);
    const retry = this.repo.requestDeliveries(id, ['failed', 'interrupted']).some((d) => d.retryable);
    const group = this.repo.getGroup(request.groupId);
    const unresolvedFailure = this.repo.requestDeliveries(id, ['failed', 'interrupted'])
      .some((delivery) => !this.repo.deliverySuccessor(request.groupId, delivery.id));
    const pendingCheckpoint = this.repo.hasPendingRecoveryCheckpoint(request.groupId, id);
    const status = unresolvedFailure || pendingCheckpoint ? 'paused'
      : open.length || retry ? (hold || group?.paused || retry ? 'paused' : 'active') : 'completed';
    if (status !== request.status) this.repo.updateRequest(id, { status });
    if (status === 'completed' && request.executionPlanId) {
      const plan = this.store.getSessionPlan(request.executionPlanId);
      if (plan?.status === 'executing' && !plan.executionRunId) {
        this.store.updateSessionPlan({ ...plan, status: 'interrupted', updatedAt: nowIso() });
        this.store.recordEvent({ projectId: group?.projectId ?? null, sessionId: plan.sessionId, type: 'session.plan.execution.interrupted', summary: `Approved plan delivery ended before a run started (revision ${plan.revision})`, payload: { planId: plan.id, revision: plan.revision, requestId: request.id } });
      }
    }
  }

  // ---------------------------------------------------------------- team tools

  members(ctx: GroupRunContext): unknown {
    const { group, member, request, delivery } = this.live(ctx);
    return {
      you: member.handle, role: member.role, mode: group.mode, canAssign: this.mayAssign(group, member, request.plannerMemberId),
      autonomy: { mode: group.autonomy?.mode ?? 'balanced', emergencyTurnLimit: effectiveTurnLimit(group) },
      recovery: group.recoveryState ? { status: group.recoveryState.status, ...(group.recoveryState.reason ? { reason: group.recoveryState.reason } : {}) } : { status: 'healthy' },
      request: { id: request.id, turnsUsed: request.turnsUsed, maxTurns: effectiveTurnLimit(group), hop: delivery.hop, maxHops: group.maxHops },
      members: this.roster(group, member),
    };
  }

  inbox(ctx: GroupRunContext): unknown {
    const { group, member, request } = this.live(ctx);
    const names = new Map(this.repo.members(group.id).map((m) => [m.id, m.handle]));
    const unread = this.repo.messagesAddressedAfter(group.id, member.id, member.lastReadSeq, LIMITS.inboxCount + 1);
    const page = unread.length ? unread.slice(0, LIMITS.inboxCount) : this.repo.messagesFor(group.id, member.id, LIMITS.inboxCount);
    const messages = page.map((m) => ({
      id: m.id, seq: m.seq, kind: m.kind, from: m.senderMemberId ? names.get(m.senderMemberId) ?? 'unknown' : m.kind === 'user' ? 'human' : 'mingle',
      requestId: m.requestId, replyToId: m.replyToId, content: clean(m.content, LIMITS.inboxMessage),
    }));
    const readThrough = unread.length ? page.at(-1)!.seq : member.lastReadSeq;
    if (readThrough > member.lastReadSeq) this.repo.updateMember(member.id, { lastReadSeq: readThrough });
    const assignments = this.repo.activeAssignments(group.id).filter((a) => a.toMemberId === member.id).map((a) => ({
      id: a.id, taskId: a.taskId, title: this.store.getTask(a.taskId)?.title ?? '', status: this.store.getTask(a.taskId)?.status ?? 'unknown', scope: a.scope,
    }));
    return { you: member.handle, request: { id: request.id, text: clean(this.repo.getMessage(request.messageId)?.content ?? '', LIMITS.request) }, messages, assignments, hasMore: unread.length > LIMITS.inboxCount, unreadTeamMessagesRemaining: this.repo.countAddressedAfter(group.id, member.id, readThrough), notice: 'Only your current delivery authorizes execution. Messages for other request IDs are context; call team_inbox again when hasMore is true.' };
  }

  assign(ctx: GroupRunContext, input: Assign): unknown {
    const { group, member, request, delivery, session } = this.live(ctx);
    if (!this.mayAssign(group, member, request.plannerMemberId)) {
      throw forbidden(group.mode === 'cowork' ? 'Only the peer holding this request\'s planning lease can assign work' : 'Only the group orchestrator can assign work');
    }
    const recipient = this.activeByHandle(group, input.recipient);
    if (recipient.id === member.id) throw unprocessable('You cannot assign work to yourself');
    const recipientSession = this.store.getSession(recipient.sessionId);
    if (!recipientSession) throw conflict(`@${recipient.handle} is archived`);
    if (this.repo.countRunMessages(group.id, member.id, delivery.runId!, 'assignment') >= MAX_ASSIGNMENTS_PER_RUN) throw conflict('Too many assignments in one turn');
    const hop = delivery.hop + 1;
    if (hop > group.maxHops) throw conflict(`The message hop limit (${group.maxHops}) has been reached for this request`);
    const turnLimit = effectiveTurnLimit(group);
    if (turnLimit !== null && request.turnsUsed + this.repo.requestDeliveries(request.id, ['queued']).length >= turnLimit) throw conflict(`The request turn budget (${turnLimit}) has been reached`);

    const scope = normalizeScopes(input.scope);
    const dependsOn = [...new Set(input.dependsOn ?? [])].sort();
    const wanted = new Map<string, { taskId: string; path: string }>();
    for (const artifact of input.inputArtifacts ?? []) {
      if (!dependsOn.includes(artifact.taskId)) throw unprocessable(`Input artifact task ${artifact.taskId} must also be listed in dependsOn`);
      const path = safeArtifactPath(artifact.path);
      wanted.set(`${artifact.taskId}\0${path}`, { taskId: artifact.taskId, path });
    }
    const inputs = [...wanted.values()].sort((a, b) => `${a.taskId}${a.path}`.localeCompare(`${b.taskId}${b.path}`));
    const title = clean(input.title.trim(), 200);
    const acceptanceProvenance = input.acceptanceCriteria.trim() ? 'explicit' : 'derived';
    const acceptanceCriteria = clean(input.acceptanceCriteria.trim() || deriveAcceptanceCriteria(input.objective, scope), 10_000);
    const milestones = this.assignmentMilestones(acceptanceCriteria, acceptanceProvenance);
    const fingerprint = createHash('sha256').update(JSON.stringify([request.id, recipient.id, title.toLowerCase().replace(/\s+/g, ' '), input.objective.trim(), input.acceptanceCriteria.trim(), scope, dependsOn, inputs])).digest('hex');

    const active = this.repo.activeAssignments(group.id);
    const same = active.find((a) => a.fingerprint === fingerprint);
    if (same) return { assignmentId: same.id, taskId: same.taskId, deliveryId: same.deliveryId, recipient: recipient.handle, status: 'queued-or-active', deduplicated: true };
    const previous = this.repo.requestAssignments(request.id).find((assignment) => assignment.fingerprint === fingerprint);
    if (previous) {
      const priorDelivery = this.repo.getDelivery(previous.deliveryId);
      this.recordStallSignal(group, member, request.id, 'delegation-loop', fingerprint, delivery.runId, [previous.id, previous.deliveryId],
        'The same assignment objective and scope was proposed again after its prior delivery settled.');
      return {
        assignmentId: previous.id, taskId: previous.taskId, deliveryId: previous.deliveryId, recipient: recipient.handle,
        status: priorDelivery?.status ?? 'unavailable', deduplicated: true,
      };
    }
    const checkpoint = this.assignmentCheckpointRequired(group, request.id, delivery, scope);
    if (checkpoint) return { status: 'awaiting-human-ack', checkpointId: checkpoint.id, reason: checkpoint.reason, queued: false };
    for (const other of active) {
      const otherMember = this.repo.getMember(other.toMemberId);
      const otherSession = otherMember ? this.store.getSession(otherMember.sessionId) : undefined;
      if (!otherSession || otherSession.worktreePath !== recipientSession.worktreePath) continue;
      const clash = scopesOverlap(scope, other.scope);
      if (clash) throw conflict(`Scope "${clash}" overlaps active assignment ${other.id} for @${otherMember?.handle ?? 'unknown'} in the same workspace. Narrow the scope or wait for it to finish.`);
    }

    const created = this.store.tx(() => {
      const current = this.live(ctx);
      if (!this.mayAssign(current.group, current.member, current.request.plannerMemberId)) {
        throw forbidden(current.group.mode === 'cowork' ? 'This request planning lease changed before the assignment was recorded' : 'Coordinator authority changed before the assignment was recorded');
      }
      const task = this.tasks.create({
        projectId: group.projectId, title, description: clean(`${input.objective.trim()}\n\nEdit scope:\n${scope.map((s) => `- ${s}`).join('\n')}`, 20_000),
        acceptanceCriteria, sessionId: recipient.sessionId, dependsOn,
      });
      const id = assignmentId();
      const deliveryIdValue = deliveryId();
      const dependencies = dependsOn.map((taskId) => ({ taskId, title: this.store.getTask(taskId)?.title ?? taskId, status: this.store.getTask(taskId)?.status ?? 'unknown' }));
      const message = this.repo.insertMessage({
        groupId: group.id, senderMemberId: member.id, recipients: [recipient.id], kind: 'assignment', requestId: request.id, sourceRunId: delivery.runId,
        content: assignmentText({
          id, taskId: task.id, from: member.handle, to: recipient.handle, title, objective: input.objective, acceptance: acceptanceCriteria, scope,
          request: this.repo.getMessage(request.messageId)?.content ?? '', dependsOn: dependencies, inputs: inputs.map((i) => ({ ...i, reference: null })),
          crossDeviceWorker: Boolean(this.store.db.prepare('SELECT 1 AS found FROM mingle_team_proxy_sessions WHERE session_id=?').get(recipientSession.id)),
        }),
      });
      this.repo.insertDelivery({ id: deliveryIdValue, groupId: group.id, requestId: request.id, messageId: message.id, memberId: recipient.id, kind: 'assignment', hop, assignmentId: id });
       this.repo.insertAssignment({ id, groupId: group.id, requestId: request.id, fromMemberId: member.id, toMemberId: recipient.id, taskId: task.id, deliveryId: deliveryIdValue, scope, fingerprint, acceptanceProvenance, milestones });
      const assignment = this.repo.getAssignment(id)!;
      for (const wantedInput of inputs) {
        const producer = this.store.getTask(wantedInput.taskId);
        const existing = producer ? this.verifiedArtifact(assignment, producer, wantedInput.path, null) : undefined;
        this.repo.insertInput(id, wantedInput.taskId, wantedInput.path, existing?.id ?? null);
      }
      this.repo.updateRequest(request.id, { status: 'active' });
      this.repo.touchGroup(group.id);
      this.event(group, 'group.assignment.created', `Assignment: @${member.handle} → @${recipient.handle}: ${title}`, { assignmentId: id, taskId: task.id, deliveryId: deliveryIdValue, scope }, session.id);
      return { id, taskId: task.id, deliveryId: deliveryIdValue, assignment };
    });
    const waitingOn = this.dependencyState(created.assignment, this.store.getTask(created.taskId)!).waiting;
    this.schedule(group.id);
    return { assignmentId: created.id, taskId: created.taskId, deliveryId: created.deliveryId, recipient: recipient.handle, status: 'queued', waitingOn, deduplicated: false };
  }

  message(ctx: GroupRunContext, input: TeamMessage): unknown {
    const { group, member, request, delivery } = this.live(ctx);
    const recipient = this.activeByHandle(group, input.recipient);
    if (recipient.id === member.id) throw unprocessable('You cannot message yourself');
    if (!this.store.getSession(recipient.sessionId)) throw conflict(`@${recipient.handle} is archived`);
    if (input.replyToId) {
      const original = this.repo.getMessage(input.replyToId);
      if (!original || original.groupId !== group.id) throw unprocessable('replyToId does not identify a message in this group');
    }
    const content = clean(input.content, LIMITS.message);
    const replyToId = input.replyToId ?? null;
    const repeated = this.repo.findAgentMessage(group.id, member.id, recipient.id, replyToId, content, request.id);
    if (repeated) return { messageId: repeated.id, recipient: recipient.handle, deduplicated: true, wakesRecipient: false };
    if (this.repo.countRunMessages(group.id, member.id, delivery.runId!, 'agent') >= MAX_MESSAGES_PER_RUN) throw conflict('Too many messages in one turn');
    const wake = input.expectsReply ?? false;
    const hop = delivery.hop + 1;
    if (wake) {
      if (hop > group.maxHops) throw conflict(`The message hop limit (${group.maxHops}) has been reached; send an informational message instead`);
       const turnLimit = effectiveTurnLimit(group);
       if (turnLimit !== null && request.turnsUsed + this.repo.requestDeliveries(request.id, ['queued']).length >= turnLimit) throw conflict(`The request turn budget (${turnLimit}) has been reached`);
    }
    const result = this.store.tx(() => {
      this.live(ctx);
      const message = this.repo.insertMessage({ groupId: group.id, senderMemberId: member.id, recipients: [recipient.id], kind: 'agent', content, requestId: request.id, replyToId, sourceRunId: delivery.runId });
      // A recipient can answer an inbox question during its existing turn; retire the redundant queued question turn.
      if (input.replyToId) {
        const answered = this.repo.getMessage(input.replyToId);
        if (answered?.senderMemberId === recipient.id && answered.recipientMemberIds.includes(member.id) && !this.repo.hasLaterPeerMessage(group.id, recipient.id, member.id, answered.requestId ?? request.id, answered.seq)) {
          for (const pending of this.repo.memberDeliveries(member.id, ['queued']).filter((d) => d.kind === 'message' && d.messageId === answered.id)) {
            this.repo.setDelivery(pending.id, { status: 'cancelled', retryable: false, error: 'Answered during an existing active turn' });
            this.refreshRequest(pending.requestId);
          }
        }
      }
      let queued: string | null = null;
      if (wake) {
        // One pending reply request per sender and recipient; later notes join the inbox instead of fanning out turns.
        const waiting = this.repo.memberDeliveries(recipient.id, ['queued']).find((d) => d.kind === 'message' && d.requestId === request.id && this.repo.getMessage(d.messageId)?.senderMemberId === member.id);
        if (waiting) queued = waiting.id;
        else {
          queued = deliveryId();
          this.repo.insertDelivery({ id: queued, groupId: group.id, requestId: request.id, messageId: message.id, memberId: recipient.id, kind: 'message', hop });
          this.repo.updateRequest(request.id, { status: 'active' });
        }
      }
      this.repo.touchGroup(group.id);
      this.event(group, 'group.message.agent', `@${member.handle} → @${recipient.handle}${wake ? ' (reply requested)' : ''}`, { messageId: message.id, deliveryId: queued, requestId: request.id });
      return { messageId: message.id, queued };
    });
    if (wake) this.schedule(group.id);
    return { messageId: result.messageId, recipient: recipient.handle, deduplicated: false, wakesRecipient: wake, deliveryId: result.queued };
  }

  status(ctx: GroupRunContext, input: TeamStatus): unknown {
    const { group, member, session, delivery } = this.live(ctx);
    const assignment = this.repo.assignmentByTask(group.id, input.taskId);
    const ownsActiveAssignment = assignment?.toMemberId === member.id && assignment.deliveryId === delivery.id;
    if (!ownsActiveAssignment && delivery.taskId !== input.taskId) throw forbidden('You can only report status for the task assigned to this active delivery');
    const task = this.store.getTask(input.taskId);
    if (!task) throw notFound('Task not found');
    if (task.status === 'done') throw conflict('This task was already accepted as done');
    const note = clean(input.note ?? '', 4000);
    if (input.status === 'running') {
      if (assignment ? this.dependencyState(assignment, task).waiting.length > 0 : unfinishedDeps(task.dependsOn, (dep) => this.store.getTask(dep)?.status).length > 0) throw conflict('This task still waits on prerequisites');
    }
    if (task.status === input.status && !note) return { taskId: task.id, status: task.status, unchanged: true };
    const result = this.store.tx(() => {
      this.live(ctx);
      const next = task.status === input.status ? task : this.store.updateTask(task.id, { status: input.status });
      this.repo.insertMessage({
        groupId: group.id, senderMemberId: member.id, recipients: assignment ? [assignment.fromMemberId] : [], kind: 'status', requestId: delivery.requestId,
        content: clean(`${input.status}: ${this.store.getTask(task.id)?.title ?? task.id}${note ? ` — ${note}` : ''}`, 2000), sourceRunId: this.repo.getDelivery(ctx.deliveryId)?.runId ?? null,
      });
      if (next.status !== task.status) {
        this.store.recordEvent({ projectId: next.projectId, sessionId: next.sessionId, type: `task.${input.status}`, summary: `Task ${input.status} (reported by @${member.handle}): ${next.title}`, payload: { taskId: next.id, from: task.status, to: next.status, groupId: group.id } });
      }
      this.repo.touchGroup(group.id);
      this.event(group, 'group.status', `@${member.handle}: ${input.status}`, { taskId: task.id, status: input.status, changed: next.status !== task.status }, session.id);
      return next;
    });
    // A producer reaching Review can unblock consumers that opted into its published artifacts.
    this.schedule(group.id);
    return { taskId: result.id, status: result.status };
  }

  /** Host-authorized full-access acceptance after the team orchestrator has inspected the result. */
  acceptTask(ctx: GroupRunContext, input: TeamAcceptTask): unknown {
    const { group, member, session, delivery } = this.live(ctx);
    const request = this.repo.getRequest(delivery.requestId);
    if (!request || !this.mayAssign(group, member, request.plannerMemberId)) throw forbidden('Only this request’s current orchestrator may accept a worker task.');
    const assignment = this.repo.assignmentByTask(group.id, input.taskId);
    if (!assignment || assignment.fromMemberId !== member.id || assignment.requestId !== delivery.requestId) {
      throw forbidden('You may accept only a worker assignment from this request that you issued.');
    }
    const task = this.store.getTask(input.taskId);
    const workerDelivery = this.repo.getDelivery(assignment.deliveryId);
    if (!task || task.projectId !== group.projectId || task.sessionId !== this.repo.getMember(assignment.toMemberId)?.sessionId) {
      throw notFound('The assigned task is no longer available to accept.');
    }
    if (task.status !== 'review' || workerDelivery?.status !== 'completed') {
      throw conflict('The worker task must be in Review with a completed delivery before it can be accepted.');
    }
    const verificationSummary = clean(input.verificationSummary, 4_000).trim();
    if (verificationSummary.length < 8) throw unprocessable('Provide a meaningful verification summary before accepting this task.');
    const accepted = this.store.tx(() => {
      this.live(ctx);
      const current = this.store.getTask(task.id);
      if (!current || current.status !== 'review') throw conflict('The task changed before it could be accepted.');
      const next = this.store.updateTask(current.id, { status: 'done' });
      this.repo.acceptAssignment(assignment.id, verificationSummary);
      this.repo.updateMilestonesForAssignment(assignment.id, 'completed', verificationSummary);
      this.repo.insertMessage({ groupId: group.id, senderMemberId: member.id, recipients: [assignment.toMemberId], kind: 'status',
        requestId: delivery.requestId, content: clean(`Accepted by orchestrator: ${verificationSummary}`, 4_000), sourceRunId: delivery.runId });
      this.store.recordEvent({ projectId: next.projectId, sessionId: next.sessionId, type: 'task.done',
        summary: `Task accepted by orchestrator: ${next.title}`, payload: { taskId: next.id, from: 'review', to: 'done',
          acceptedBy: 'orchestrator', verificationSummary, groupId: group.id, assignmentId: assignment.id } });
      this.repo.touchGroup(group.id);
      this.event(group, 'group.status', `@${member.handle} accepted @${this.repo.getMember(assignment.toMemberId)?.handle ?? 'worker'}’s task`,
        { taskId: next.id, status: 'done', acceptedBy: 'orchestrator', verificationSummary }, session.id);
      return next;
    });
    this.schedule(group.id);
    return { taskId: accepted.id, status: accepted.status, acceptedBy: 'orchestrator', verificationSummary };
  }

  async artifact(ctx: GroupRunContext, input: TeamArtifact): Promise<unknown> {
    const first = this.live(ctx);
    const { group, member, session, delivery } = first;
    const recipient = this.activeByHandle(group, input.recipient);
    if (recipient.id === member.id) throw unprocessable('You cannot send an artifact to yourself');
    const recipientSession = this.store.getSession(recipient.sessionId);
    if (!recipientSession) throw conflict(`@${recipient.handle} is archived`);
    const path = safeArtifactPath(input.path);
    const activeAssignment = first.delivery.assignmentId ? this.repo.getAssignment(first.delivery.assignmentId) : undefined;
    if (activeAssignment) {
      if (input.taskId !== activeAssignment.taskId) throw forbidden('An artifact from an assignment must name that delivery\'s assigned task');
      const permitted = activeAssignment.scope.some((entry) => path === entry || path.startsWith(`${entry}/`));
      if (!permitted) throw forbidden('The artifact path is outside the active assignment scope');
    } else if (first.delivery.taskId) {
      if (input.taskId !== first.delivery.taskId) throw forbidden('An artifact from a task delivery must name that delivery\'s task');
    } else if (input.taskId) {
      throw forbidden('A task artifact can only be published from a delivery that owns that task');
    }
    let taskId: string | undefined;
    if (input.taskId) {
      const task = this.store.getTask(input.taskId);
      if (!task || task.projectId !== group.projectId) throw notFound('Task not found in this project');
      const assignment = this.repo.assignmentByTask(group.id, task.id);
      if (task.sessionId !== member.sessionId || (assignment && assignment.toMemberId !== member.id)) throw forbidden('You can only publish artifacts for a task you own');
      taskId = task.id;
    }
    const proxySession = Boolean(this.store.db.prepare('SELECT 1 AS found FROM mingle_team_proxy_sessions WHERE session_id=?').get(session.id));
    const verifyImportedArtifact = proxySession
      ? ({ revision, path: artifactPath, blob }: { revision: string; path: string; blob: string }) =>
        this.verifyImportedTeamArtifact({ groupId: group.id, deliveryId: delivery.id, sessionId: session.id,
          runId: delivery.runId!, taskId: taskId ?? null, path: artifactPath, revision, blob, worktreePath: session.worktreePath })
      : undefined;
    if (FULL_SHA.test(input.revision)) {
      const known = this.repo.findArtifact(group.id, member.id, recipient.id, path, input.revision.toLowerCase(), taskId ?? null);
      if (known) return this.artifactResult(known, true);
    }
    // The handoff re-checks authority inside its own transaction, immediately before it writes to the recipient session.
    const authorize = () => {
      this.live(ctx);
      const transferFailure = proxySession ? this.importedTeamArtifactProof({ groupId: group.id, deliveryId: delivery.id, sessionId: session.id,
        runId: delivery.runId!, taskId: taskId ?? null, path, revision: input.revision }).failure : null;
      if (transferFailure) {
        throw forbidden(`Team artifact transfer authorization failed: ${transferFailure}.`);
      }
      const currentRecipient = this.requireMember(group, recipient.id);
      if (currentRecipient.sessionId !== recipient.sessionId || !this.store.getSession(currentRecipient.sessionId)) throw conflict('The artifact recipient is no longer available');
      if (taskId) {
        const task = this.store.getTask(taskId);
        if (!task || task.projectId !== group.projectId || task.sessionId !== member.sessionId) throw forbidden('This artifact task is no longer owned by the sender');
      }
    };
    authorize();
    const event = await this.handoffs.create({ fromSessionId: member.sessionId, toSessionId: recipient.sessionId, taskId, path, revision: input.revision, note: clean(input.note ?? '', 4000) }, authorize, verifyImportedArtifact);
    const handoffMessageId = typeof event.payload.messageId === 'string' ? event.payload.messageId : null;
    const neutralize = (reason: string) => {
      // The verified handoff already exists in the recipient session; keep it from being injected into a run for a stopped sender.
      if (handoffMessageId) this.store.markConsumed([handoffMessageId]);
      this.log('warn', `Artifact handoff ${event.id} was not recorded in the group: ${reason}`);
    };
    let live: Live;
    try { live = this.live(ctx); }
    catch (error) { neutralize(errorMessage(error)); throw error; }

    const commit = String(event.payload.revision ?? '');
    const blob = String(event.payload.blob ?? '');
    const reference = String(event.payload.reference ?? '');
    const duplicate = this.repo.findArtifact(group.id, member.id, recipient.id, path, commit, taskId ?? null);
    if (duplicate) { neutralize('duplicate artifact'); return this.artifactResult(duplicate, true); }
    const stored = this.store.tx(() => {
      this.live(ctx);
      const message = this.repo.insertMessage({
        groupId: group.id, senderMemberId: member.id, recipients: [recipient.id], kind: 'artifact', requestId: live.request.id, sourceRunId: live.delivery.runId,
        content: clean(`Artifact ${path} @ ${commit.slice(0, 12)} (blob ${blob.slice(0, 12)})${taskId ? ` for task ${taskId}` : ''}\n${reference}${input.note?.trim() ? `\n${input.note.trim()}` : ''}`, 3000),
      });
      const id = artifactId();
      this.repo.insertArtifact({
        id, groupId: group.id, requestId: live.request.id, fromMemberId: member.id, toMemberId: recipient.id, taskId: taskId ?? null, path, commitId: commit, blob, reference,
        handoffEventId: event.id, handoffMessageId, messageId: message.id,
      });
      if (taskId) for (const open of this.repo.openInputs(group.id, recipient.id, taskId, path)) this.repo.setInputArtifact(open.assignmentId, open.taskId, open.path, id);
      this.repo.touchGroup(group.id);
      this.event(group, 'group.artifact.published', `Artifact: @${member.handle} → @${recipient.handle}: ${path}`, { artifactId: id, path, commit, taskId: taskId ?? null }, session.id);
      return this.repo.getArtifact(id)!;
    });
    // Wake only queued assignments that were waiting on this exact artifact; nothing is merged and no model turn is forced.
    this.schedule(group.id);
    return this.artifactResult(stored, false);
  }

  private importedTeamArtifactProof(input: {
    groupId: string; deliveryId: string; runId: string; sessionId: string; taskId: string | null; path: string; revision: string;
  }): { failure: string | null; refName?: string } {
    try {
      const proxy = this.store.db.prepare(`SELECT team_id,shared_project_id,agent_id,owner_account_id,owner_device_id
        FROM mingle_team_proxy_sessions WHERE session_id=?`).get(input.sessionId) as {
          team_id: string; shared_project_id: string; agent_id: string; owner_account_id: string; owner_device_id: string;
        } | undefined;
      if (!proxy) return { failure: 'source session is not a team proxy' };
      const delivery = this.store.db.prepare(`SELECT d.status,d.run_id,d.agent_id,d.owner_account_id,d.owner_device_id,
          p.host_device_id,p.owner_account_id AS host_owner_account_id,r.agent_id AS roster_agent_id,r.removed_at,c.state,c.owner_account_id AS consent_owner_account_id,
          c.owner_device_id AS consent_owner_device_id
        FROM mingle_team_host_deliveries d
        JOIN mingle_team_host_projects p ON p.team_id=d.team_id AND p.shared_project_id=d.shared_project_id
        LEFT JOIN mingle_team_host_roster r ON r.team_id=d.team_id AND r.shared_project_id=d.shared_project_id AND r.agent_id=d.agent_id
        LEFT JOIN mingle_team_host_consents c ON c.team_id=d.team_id AND c.shared_project_id=d.shared_project_id AND c.agent_id=d.agent_id
        WHERE d.delivery_id=? AND d.group_id=? AND d.session_id=? AND d.team_id=? AND d.shared_project_id=? LIMIT 1`)
        .get(input.deliveryId, input.groupId, input.sessionId, proxy.team_id, proxy.shared_project_id) as {
          status: string; run_id: string; agent_id: string; owner_account_id: string; owner_device_id: string;
          host_device_id: string; host_owner_account_id: string; roster_agent_id: string | null; removed_at: string | null; state: string | null;
          consent_owner_account_id: string | null; consent_owner_device_id: string | null;
        } | undefined;
      if (!delivery || !['accepted', 'running', 'awaiting-approval'].includes(delivery.status)
        || delivery.run_id !== input.runId || delivery.agent_id !== proxy.agent_id
        || delivery.owner_account_id !== proxy.owner_account_id || delivery.owner_device_id !== proxy.owner_device_id
        || delivery.roster_agent_id !== proxy.agent_id || delivery.removed_at !== null || delivery.state !== 'granted'
        || delivery.consent_owner_account_id !== proxy.owner_account_id || delivery.consent_owner_device_id !== proxy.owner_device_id) {
        return { failure: 'active host delivery, roster or consent does not match' };
      }
      const transfers = this.store.db.prepare(`SELECT transfer_id,source_device_id,peer_device_id,owner_id,offer_json,ref_name
        FROM mingle_git_team_artifacts WHERE team_id=? AND shared_project_id=? AND delivery_id=? AND direction='incoming' AND status='imported'`)
        .all(proxy.team_id, proxy.shared_project_id, input.deliveryId) as Array<{
          transfer_id: string; source_device_id: string; peer_device_id: string; owner_id: string; offer_json: string; ref_name: string | null;
        }>;
      const authorizedTransfers = transfers.flatMap((transfer) => {
        let offer: Record<string, unknown>;
        try { offer = JSON.parse(transfer.offer_json) as Record<string, unknown>; } catch { return []; }
        return transfer.source_device_id === proxy.owner_device_id && transfer.peer_device_id === delivery.host_device_id
          && transfer.owner_id === delivery.host_owner_account_id && offer.transferId === transfer.transfer_id
          && offer.deliveryId === input.deliveryId && offer.sharedProjectId === proxy.shared_project_id ? [{ offer, refName: transfer.ref_name }] : [];
      });
      if (!authorizedTransfers.length) return { failure: 'no imported transfer is bound to the authenticated owner device and host' };
      const match = authorizedTransfers.find(({ offer }) => typeof offer.revision === 'string'
        && offer.revision.toLowerCase() === input.revision.toLowerCase() && offer.path === input.path && (offer.taskId ?? null) === input.taskId);
      if (!match) return { failure: 'the imported transfer offer does not match the requested revision, path and task' };
      const expectedRef = teamArtifactRefName(proxy.shared_project_id, input.deliveryId, input.revision);
      if (match.refName !== expectedRef) return { failure: 'the imported artifact ref does not match its authenticated delivery and revision' };
      return { failure: null, refName: expectedRef };
    } catch { return { failure: 'authenticated transfer record is unavailable' }; }
  }

  private async verifyImportedTeamArtifact(input: {
    groupId: string; deliveryId: string; runId: string; sessionId: string; taskId: string | null; path: string; revision: string;
    blob: string; worktreePath: string;
  }): Promise<boolean> {
    const proof = this.importedTeamArtifactProof(input);
    if (proof.failure || !proof.refName) return false;
    const [revision, entry] = await Promise.all([
      git(input.worktreePath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${proof.refName}^{commit}`], { allowFailure: true }),
      git(input.worktreePath, ['ls-tree', '-z', proof.refName, '--', input.path], { allowFailure: true }),
    ]);
    if (revision.code !== 0 || revision.stdout.trim().toLowerCase() !== input.revision.toLowerCase()) return false;
    const records = entry.stdout.split('\0').filter(Boolean);
    const match = records.length === 1 ? /^(\d{6}) blob ([0-9a-f]{40,64})\t(.+)$/.exec(records[0]!) : null;
    return Boolean(match && match[1] !== '120000' && match[2] === input.blob && match[3] === input.path);
  }

  private artifactResult(row: ArtifactRow, deduplicated: boolean): unknown {
    return { artifactId: row.id, path: row.path, revision: row.commitId, blob: row.blob.slice(0, 12), reference: row.reference, taskId: row.taskId, deduplicated };
  }

  /** Milestones remain pending until host-backed evidence or human task acceptance arrives. */
  private assignmentMilestones(criteria: string, provenance: 'explicit' | 'derived'): GroupMilestone[] {
    const lines = criteria.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      .filter((line) => !/^derived by mingle/i.test(line) && !/^permitted edit scope:?$/i.test(line) && !line.startsWith('- '))
      .map((line) => line.replace(/^\d+[.)]\s*/, '').slice(0, 300));
    const labels = (lines.length ? lines : [criteria.trim()]).slice(0, 8);
    return labels.map((label) => ({ id: newId('msg'), label: clean(label, 300), status: 'pending', acceptanceProvenance: provenance }));
  }

  private assignmentCheckpointRequired(group: ConversationGroup, requestIdArg: string, delivery: DeliveryRow, nextScope: string[]): GroupRecoveryCheckpointRow | null {
    const mode = group.autonomy?.mode ?? 'balanced';
    if (mode === 'extended') return null;
    const pending = this.repo.latestPendingRecoveryCheckpoint(group.id);
    if (pending) return pending;
    const currentRunAssignments = this.repo.assignmentsCreatedByRun(requestIdArg, delivery.runId ?? '');
    if (currentRunAssignments.length) return null;
    const latest = this.repo.latestAssignmentBatch(requestIdArg);
    if (!latest.length) return null;
    const unsettled = latest.some((assignment) => {
      const row = this.repo.getDelivery(assignment.deliveryId);
      return !row || OPEN_DELIVERY.includes(row.status) || ((row.status === 'failed' || row.status === 'interrupted') && row.retryable);
    });
    if (unsettled) return null;
    if (mode === 'balanced') {
      const withinPriorScope = nextScope.every((wanted) => latest.some((assignment) => assignment.scope.some((prior) => wanted === prior || wanted.startsWith(`${prior}/`))));
      if (withinPriorScope) return null;
    }
    const batchIds = latest.map((assignment) => assignment.deliveryId).sort();
    const fingerprintInput = mode === 'balanced'
      ? [mode, requestIdArg, batchIds, [...nextScope].sort()]
      : [mode, requestIdArg, batchIds];
    const keyHash = createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex').slice(0, 20);
    const idempotencyKey = `autonomy:${mode}:${requestIdArg}:${keyHash}`.slice(0, 100);
    const existing = this.repo.getRecoveryCheckpointByKey(group.id, idempotencyKey);
    if (existing?.state === 'acknowledged') return null;
    if (existing) return existing;
    const reason = mode === 'supervised'
      ? 'Acknowledge the completed delegation batch before the coordinator can start another batch.'
      : 'This assignment expands beyond the accepted edit scope. Acknowledge the completed batch before continuing.';
    let checkpoint!: GroupRecoveryCheckpointRow;
    this.store.tx(() => {
      checkpoint = this.repo.insertRecoveryCheckpoint({
        id: recoveryCheckpointId(), groupId: group.id, requestId: requestIdArg, batchId: batchIds[0] ?? null,
        kind: 'supervised-batch', reason, idempotencyKey,
        payload: { mode, deliveryIds: batchIds.slice(0, 100), assignmentIds: latest.map((row) => row.id).slice(0, 100), nextScope: nextScope.slice(0, 40) },
      });
      const prior = group.recoveryState;
      this.repo.updateGroup(group.id, { recoveryState: {
        status: 'paused', reason, pendingCheckpointId: checkpoint.id, activeRequestId: requestIdArg,
        ...(prior?.lastFailureId ? { lastFailureId: prior.lastFailureId } : {}),
        ...(prior?.acknowledgedDeliveryIds ? { acknowledgedDeliveryIds: prior.acknowledgedDeliveryIds.slice(-100) } : {}), updatedAt: nowIso(),
      } });
      this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: [], kind: 'status', requestId: requestIdArg, content: reason });
      this.event(group, 'group.checkpoint.required', reason, { checkpointId: checkpoint.id, requestId: requestIdArg, mode, deliveryIds: batchIds.slice(0, 20) });
    });
    return checkpoint;
  }

  // ---------------------------------------------------------------- helpers

  /** Verifies, against durable state on every call, that this context is a running delivery of an active member. */
  private live(ctx: GroupRunContext): Live {
    if (this.closed) throw conflict('Mingle is shutting down');
    const delivery = this.repo.getDelivery(ctx.deliveryId);
    if (!delivery || delivery.status !== 'running' || !delivery.runId || delivery.groupId !== ctx.groupId || delivery.memberId !== ctx.memberId
      || delivery.requestId !== ctx.requestId || delivery.hop !== ctx.hop) throw conflict('This team connection is no longer tied to an active delivery');
    if (this.fencedCoordinatorDeliveries.has(delivery.id)) throw conflict('Coordinator authority changed while this run was active; start a new delivery to continue');
    const group = this.repo.getGroup(delivery.groupId);
    const member = this.repo.getMember(delivery.memberId);
    const request = this.repo.getRequest(delivery.requestId);
    if (!group || !member || !request) throw conflict('The group state for this delivery is gone');
    if (group.paused) throw conflict('The group is stopped');
    if (member.removedAt || member.held) throw conflict('This agent is stopped or no longer in the group');
    const session = this.store.getSession(member.sessionId);
    if (!session) throw conflict('This agent session is archived');
    if (!this.runtime.isActive(session.id) || this.runtime.isRunLive && !this.runtime.isRunLive(session.id, delivery.runId)) throw conflict('This agent run has finished');
    return { delivery, group, member, session, request };
  }

  private mayAssign(group: ConversationGroup, member: MemberRow, plannerId: string): boolean {
    return group.mode === 'cowork' ? plannerId === member.id : group.orchestratorMemberId === member.id;
  }

  private hasPlannerAuthority(group: ConversationGroup, member: MemberRow, plannerId: string): boolean {
    return group.mode === 'cowork' ? plannerId === member.id : group.orchestratorMemberId === member.id;
  }

  private activeByHandle(group: ConversationGroup, handle: string): MemberRow {
    const found = this.repo.members(group.id).find((m) => m.handle === handle.toLowerCase());
    if (!found) throw unprocessable(`Unknown recipient @${handle}. Call team_members to see valid handles.`);
    if (found.removedAt) throw unprocessable(`@${handle} was removed from this group`);
    return found;
  }

  private event(group: ConversationGroup, type: string, summary: string, payload: Record<string, unknown> = {}, sessionId?: string) {
    return this.store.recordEvent({ projectId: group.projectId, sessionId: sessionId ?? null, type, summary: clean(summary, 1000), payload: JSON.parse(redactSecrets(JSON.stringify({ groupId: group.id, ...payload }))) as Record<string, unknown> });
  }

  private validateRecoveryPolicy(group: ConversationGroup, members: MemberRow[], policy: GroupRecoveryPolicy): void {
    const byId = new Map(members.map((member) => [member.id, member]));
    const workerFallbacks = policy.workerFallbacks ?? {};
    if (policy.automaticFallback && !policy.leadFallbackMemberId && !Object.keys(workerFallbacks).length) {
      throw unprocessable('Automatic fallback needs an explicitly selected lead or worker replacement');
    }
    if (policy.leadFallbackMemberId) {
      const target = byId.get(policy.leadFallbackMemberId);
      const leadIds = group.mode === 'cowork'
        ? new Set(this.repo.requests(group.id, 1000).filter((request) => request.status !== 'completed').map((request) => request.plannerMemberId))
        : new Set([group.orchestratorMemberId ?? (group.mode === 'current-leads' ? members.find((member) => member.sessionId === group.anchorSessionId)?.id : null)].filter((id): id is string => Boolean(id)));
      if (!target || leadIds.has(target.id)) throw unprocessable('Choose another active group member as the lead or request-planner fallback');
      if (policy.automaticFallback) {
        const targetSession = this.store.getSession(target.sessionId);
        const sources = [...leadIds].map((id) => this.store.getSession(byId.get(id)?.sessionId ?? '')).filter((session): session is Session => Boolean(session));
        if (!targetSession || sources.some((sourceSession) => sourceSession.policy !== targetSession.policy)) {
          throw unprocessable('Automatic lead fallback requires the same permission policy as current coordinators/planners');
        }
      }
    }
    for (const [sourceId, targetId] of Object.entries(workerFallbacks)) {
      const source = byId.get(sourceId);
      const target = byId.get(targetId);
      const workerRole: GroupMember['role'] = group.mode === 'cowork' ? 'peer' : 'worker';
      if (!source || !target || source.id === target.id || source.role !== workerRole || target.role !== workerRole) {
        throw unprocessable('Worker fallback mappings must reference two different active worker members');
      }
      if (!policy.automaticFallback) continue;
      const sourceSession = this.store.getSession(source.sessionId);
      const targetSession = this.store.getSession(target.sessionId);
      if (!sourceSession || !targetSession || sourceSession.policy !== targetSession.policy) {
        throw unprocessable('Automatic worker fallback requires the same permission policy');
      }
    }
  }

  private consumeLeadFallback(group: ConversationGroup, targetId: string): void {
    const policy = group.recoveryPolicy;
    if (!policy || policy.leadFallbackMemberId !== targetId) return;
    const hasWorkerFallbacks = Object.keys(policy.workerFallbacks ?? {}).length > 0;
    const nextPolicy: GroupRecoveryPolicy = {
      automaticFallback: hasWorkerFallbacks && policy.automaticFallback,
      allowUnverifiedQuotaFallback: policy.allowUnverifiedQuotaFallback,
      leadFallbackMemberId: null,
      ...(hasWorkerFallbacks ? { workerFallbacks: policy.workerFallbacks } : {}),
    };
    this.repo.updateGroup(group.id, { recoveryPolicy: nextPolicy });
    this.event(group, 'group.recovery-policy.consumed', 'Configured lead fallback was consumed by coordinator takeover', { replacementMemberId: targetId, recoveryPolicy: nextPolicy });
  }

  private assertOpen(): void { if (this.closed) throw conflict('Mingle is shutting down'); }

  private requireGroup(id: string): ConversationGroup {
    if (this.deletingGroups.has(id)) throw conflict('This group is being removed from Mingle.');
    const group = this.repo.getGroup(id);
    if (!group) throw notFound('Group not found');
    return group;
  }

  private requireMember(group: ConversationGroup, id: string): MemberRow {
    const member = this.repo.getMember(id);
    if (!member || member.groupId !== group.id) throw notFound('Member not found in this group');
    if (member.removedAt) throw conflict('This member was removed from the group');
    return member;
  }

  private sessionBusy(session: Session): boolean {
    return this.runtime.isActive(session.id) || session.status === 'running' || session.status === 'waiting';
  }

  private memberBusy(member: MemberRow): boolean {
    const session = this.store.getSession(member.sessionId);
    return Boolean(session && this.sessionBusy(session));
  }

  /** An existing session may join one group, must be idle with provider cleanup complete, and must not be archived. */
  private requireJoinable(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) throw notFound('Session not found');
    if (this.repo.activeMemberOfSession(sessionId)) throw conflict('This session is already in a group');
    if (this.sessionBusy(session)) throw conflict('Wait for this session to finish, or interrupt it, before starting a group');
    return session;
  }

  private assertCanChangeRoster(group: ConversationGroup): void {
    const lead = group.orchestratorMemberId ? this.repo.getMember(group.orchestratorMemberId) : undefined;
    if (lead && this.memberBusy(lead)) throw conflict(`@${lead.handle} is busy. Wait for the orchestrator to finish before changing the roster.`);
  }

  private validateHandle(handle: string): string {
    const value = handle.trim().toLowerCase();
    if (RESERVED_HANDLES.has(value)) throw unprocessable(`@${value} is reserved. Choose a handle such as ${value}2.`);
    return value;
  }

  private assertHandleFree(groupIdArg: string, handle: string): void {
    if (this.repo.handleTaken(groupIdArg, handle)) throw conflict(`@${handle} is already used in this group, including by an agent that was removed. Choose another handle.`);
  }

  private checkModel(info: ProviderInfo | undefined, model: string, provider: string): void {
    if (info?.models.length && !info.models.some((row) => row.id === model || row.aliases?.includes(model))) {
      throw unprocessable(`${provider} does not currently advertise model "${model}". Refresh providers or choose an available model.`);
    }
  }

  /** The provider must be advertised as available and the model settings must be valid for it. */
  private checkConfiguration(config: AgentConfiguration): void {
    if (!this.providers) return;
    const list = this.providers();
    if (!list.length) throw conflict('Provider availability has not been detected yet. Refresh providers and try again.');
    const info = list.find((row) => row.id === config.provider);
    if (!info || !info.available) throw conflict(`${config.provider} is not available${info?.reason ? `: ${info.reason}` : ''}`);
    this.checkModel(info, config.model, config.provider);
    resolveRunConfig(info, config, { effort: true, policy: true, serviceTier: true });
  }

  private async provision(projectId: string, name: string, config: AgentConfiguration, isolated: boolean): Promise<Session> {
    return this.workspace.createSession({
      projectId, name, provider: config.provider, model: config.model, effort: config.effort, policy: config.policy, serviceTier: config.serviceTier, isolated,
    });
  }

  /** Newly created sessions are archived so a failed conversion leaves no half group; worktrees stay on disk. */
  private async rollbackSessions(sessions: Session[]): Promise<void> {
    for (const session of sessions.reverse()) {
      try { this.workspace.archiveSession(session.id); }
      catch (error) { this.log('warn', `Could not archive ${session.id} after a failed group change`, error); }
    }
  }
}
