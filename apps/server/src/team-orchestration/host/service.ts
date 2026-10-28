import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AddTeamAgentSchema, EnableTeamOrchestrationSchema, ShareTeamSessionSchema, TeamApprovalDecisionPayloadSchema,
  TeamApprovalRequestPayloadSchema, TeamConsentPayloadSchema, TeamDeliveryPayloadSchema,
  TeamActivityPayloadSchema, TeamDeliveryHeartbeatPayloadSchema, TeamDeliveryStatusPayloadSchema, TeamInterruptPayloadSchema, TeamOrchestrationSettingsSchema,
  TEAM_CONSENT_DISCLAIMER_VERSION, TeamArtifactSchema, TeamPermissionLevelSchema, TeamStructureChangeSchema, TeamStructurePayloadSchema, TeamToolCallPayloadSchema,
  TeamToolResultPayloadSchema, TeamArtifactRefSchema,
  type ProviderFailure, type TeamAgentRole, type TeamAgentState, type TeamConsentState,
  type TeamAvailableAgentsSnapshot, type TeamLeaderChange, type TeamPermissionLevel, type TeamStructureMember, type TeamSessionRef,
  type TeamArtifactRef, type TeamOrchestrationSettings, type TeamStructureSnapshot,
} from '@mingle/contracts';
import { ProviderFailureSchema, ProviderSchema, TeamStructurePayloadSchema as StructureSchema } from '@mingle/contracts';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from '../../store.ts';
import type { RecoveryService } from '../../recovery/service.ts';
import type { GitSyncService } from '../../distributed/git-sync.ts';
import type {
  TeamChatOrchestrationMessage, TeamMcpProxy, TeamOrchestrationAccount, TeamOrchestrationChat,
  TeamOrchestrationCollaboration, TeamOrchestrationDeviceSide, TeamOrchestrationGroups,
  TeamOrchestrationTransport, TeamProxyRuntimeService, TeamProxyStartInput,
} from '../types.ts';
import { HttpError } from '../../util.ts';
import { git } from '../../repository/git-run.ts';
import { captureRunTree, compareRunTrees, type RunTreeSnapshot } from '../../run-changes.ts';
import { redactSecrets } from '../../providers/common.ts';
import type { ProjectCollaborationSnapshot } from '../../../../../packages/contracts/src/project-collaboration.ts';
import { KeyedLock } from '../../repository/lock.ts';
import { normalizeScopes, safeArtifactPath } from '../../groups/routing.ts';
import { isDeniedName } from '../../paths.ts';

type Row = Record<string, unknown>;
type HostRow = {
  team_id: string; shared_project_id: string; local_project_id: string; owner_account_id: string;
  host_device_id: string; group_id: string; settings_json: string; leader_history_json: string;
  needs_leader: number; updated_at: string;
};
type ProxyRow = {
  session_id: string; team_id: string; shared_project_id: string; agent_id: string;
  owner_account_id: string; owner_device_id: string; handle: string;
};
type DeliveryRow = {
  delivery_id: string; team_id: string; shared_project_id: string; group_id: string; request_id: string;
  agent_id: string; session_id: string; owner_account_id: string; owner_device_id: string; run_id: string;
  remote_run_id: string | null; status: string; content: string; source_chat_message_id: string | null;
  artifacts_json: string; failure_json: string | null; issued_at: string; timeout_at: number; updated_at: string;
};
type ArtifactAuthorityRow = {
  delivery_id: string; team_id: string; shared_project_id: string; group_id: string; session_id: string; run_id: string;
  agent_id: string; owner_account_id: string; owner_device_id: string; task_id: string | null; scope_json: string;
  base_revision: string | null; kind: string;
};
const CompletionArtifactSchema = z.object({
  source: TeamArtifactRefSchema,
  state: z.enum(['pending', 'integrated', 'failed']),
  imported: TeamArtifactRefSchema.optional(),
  failure: z.string().max(500).optional(),
}).strict();
const CompletionIntentSchema = z.object({
  kind: z.literal('team-completion'), version: z.literal(1), phase: z.enum(['artifacts', 'finalizing', 'notifying']),
  remoteRunId: z.string().nullable(), at: z.string(), finalText: z.string().max(50_000),
  workspaceBefore: z.unknown().nullable(), artifacts: z.array(CompletionArtifactSchema).max(30),
  artifactFailures: z.array(z.string().max(500)).max(30), importedArtifacts: z.array(TeamArtifactRefSchema).max(30),
  integratedArtifacts: z.array(TeamArtifactRefSchema).max(30), finalContent: z.string().max(50_000).optional(),
  workspaceChanges: z.unknown().optional(),
}).strict();
const DeliverySchema = TeamDeliveryPayloadSchema;
type CompletionIntent = z.infer<typeof CompletionIntentSchema> & { workspaceBefore: RunTreeSnapshot | null };
class CompletionAuthorityError extends Error {}
type ProjectContext = ProjectCollaborationSnapshot & {
  project: NonNullable<ProjectCollaborationSnapshot['project']>;
  localProjectId: string; accountId: string; localDeviceId: string; hostDeviceId: string;
  hostAccountId: string; hostDisplayName: string; isHost: boolean;
};

const liveDelivery = (status: string) => ['queued', 'accepted', 'running', 'awaiting-approval'].includes(status);
const rankPermission = (value: TeamPermissionLevel): number => value === 'full-access' ? 1 : 0;
const publishableLocalProviders = new Set(['claude', 'codex', 'opencode']);
const safeJson = <T>(text: string, fallback: T): T => { try { return JSON.parse(text) as T; } catch { return fallback; } };
const safeArtifactText = (value: string, max: number): string => redactSecrets(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

/** Host-authoritative team settings, proxy run broker and structure snapshot builder. */
export class TeamOrchestrationHost implements TeamProxyRuntimeService {
  private readonly unsubscribe: () => void;
  private readonly unsubscribeStore: () => void;
  private readonly active = new Map<string, { runId: string; controller: AbortController }>();
  /** Completed provider runs that still have cancellable host-side artifact work. */
  private readonly completing = new Map<string, { sessionId: string; runId: string; controller: AbortController }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly heartbeatSequences = new Map<string, number>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly chatByDelivery = new Map<string, string>();
  private readonly chatDeliveryCounts = new Map<string, number>();
  private readonly mutations = new KeyedLock();
  private readonly deliveryMutations = new KeyedLock();
  private closed = false;
  private readonly now: () => number;
  private readonly deliveryTimeoutMs: number;
  private readonly deliveryMaxDurationMs: number;
  private chat?: TeamOrchestrationChat;

  constructor(private readonly options: {
    store: Store;
    git?: Pick<GitSyncService, 'exportTeamArtifact' | 'importTeamArtifact'>
      & Partial<Pick<GitSyncService, 'discardUnpublishedMcpArtifacts'>>;
    integrateTeamArtifact?: (input: { localProjectId: string; teamId: string; sharedProjectId: string; deliveryId: string;
      worktreePath: string; artifact: TeamArtifactRef }) => Promise<{ beforeRevision: string; revision: string; integrated: boolean }>;
    account: TeamOrchestrationAccount;
    transport: TeamOrchestrationTransport;
    authorizeTeam(input: { teamId: string; peerDeviceId?: string }): Promise<unknown>;
    collaboration: TeamOrchestrationCollaboration;
    groups: TeamOrchestrationGroups;
    teamMcp: TeamMcpProxy;
    recovery: Pick<RecoveryService, 'recordFailure' | 'clearFailure'>;
    deviceSide?: TeamOrchestrationDeviceSide;
    changed?: () => void;
    now?: () => number;
    deliveryTimeoutMs?: number;
    deliveryMaxDurationMs?: number;
    /** Publishes this device's sessions to the shared roster; the call replaces the device's published set. */
    publishLocalAgents?(input: { teamId: string; sharedProjectId: string; sessionIds: string[] }): Promise<unknown>;
  }) {
    this.now = options.now ?? Date.now;
    this.deliveryTimeoutMs = Math.min(15 * 60_000, Math.max(1_000, options.deliveryTimeoutMs ?? 90_000));
    this.deliveryMaxDurationMs = Math.min(24 * 60 * 60_000,
      Math.max(this.deliveryTimeoutMs, options.deliveryMaxDurationMs ?? 2 * 60 * 60_000));
    this.hostRows.exec(`CREATE TABLE IF NOT EXISTS mingle_team_host_artifact_authority (
      delivery_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL, group_id TEXT NOT NULL,
      session_id TEXT NOT NULL, run_id TEXT NOT NULL, agent_id TEXT NOT NULL, owner_account_id TEXT NOT NULL,
      owner_device_id TEXT NOT NULL, task_id TEXT, scope_json TEXT NOT NULL, base_revision TEXT, kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS mingle_team_host_artifact_authority_project
      ON mingle_team_host_artifact_authority(team_id,shared_project_id,delivery_id);
      CREATE TABLE IF NOT EXISTS mingle_team_host_pending_consents (
        envelope_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL,
        owner_account_id TEXT NOT NULL, owner_device_id TEXT NOT NULL, payload_json TEXT NOT NULL, received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mingle_team_host_pending_consents_project
        ON mingle_team_host_pending_consents(team_id,shared_project_id,received_at);`);
    this.unsubscribe = options.transport.onMessage((message) => this.onEnvelope(message));
    this.unsubscribeStore = options.store.subscribe((event) => {
      if (!event) return;
      if (event.type === 'group.message.sent' && typeof event.payload.groupId === 'string' && typeof event.payload.messageId === 'string') {
        if (event.payload.source !== 'teamchat') this.track(Promise.resolve().then(() => this.mirrorGroupHumanMessage(event.payload.groupId as string, event.payload.messageId as string)));
      } else if (event.type === 'group.member.removed' && typeof event.payload.groupId === 'string' && typeof event.payload.memberId === 'string') {
        this.track(Promise.resolve().then(() => this.onGroupMemberRemoved(event.payload.groupId as string, event.payload.memberId as string)));
      } else if (event.type === 'group.archived' && typeof event.payload.groupId === 'string') {
        this.track(Promise.resolve().then(() => this.onGroupArchived(event.payload.groupId as string)));
      }
    });
    this.recoverProxyDeliveries();
  }

  private recoverProxyDeliveries(): void {
    const rows = this.hostRows.prepare(`SELECT * FROM mingle_team_host_deliveries
      WHERE status IN ('queued','accepted','running','awaiting-approval','completed')`).all() as Array<DeliveryRow>;
    for (const row of rows) {
      const intent = this.completionIntent(row);
      if (intent) {
        if (liveDelivery(row.status) || (row.status === 'completed' && intent.phase === 'notifying')) this.track(this.processCompletion(row.delivery_id));
        continue;
      }
      if (!liveDelivery(row.status)) continue;
      // The owner device continues independently of the host process. Keep its durable delivery
      // live and resume the persisted idle deadline rather than interrupting valid remote work.
      this.active.set(row.session_id, { runId: row.run_id, controller: new AbortController() });
      this.armDeliveryTimeout(row.delivery_id);
    }
  }

  setTeamChat(chat: TeamOrchestrationChat): void { this.chat = chat; }

  private track(work: Promise<unknown>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => undefined);
  }

  private get hostRows(): DatabaseSync { return this.options.store.db; }

  private readHost(teamId: string, sharedProjectId: string): HostRow | undefined {
    return this.hostRows.prepare('SELECT * FROM mingle_team_host_projects WHERE team_id=? AND shared_project_id=?')
      .get(teamId, sharedProjectId) as HostRow | undefined;
  }

  private settings(row: HostRow): TeamOrchestrationSettings {
    const parsed = TeamOrchestrationSettingsSchema.safeParse(safeJson(row.settings_json, null));
    if (!parsed.success) throw new HttpError(500, 'Saved team orchestration settings are invalid.');
    return parsed.data;
  }

  private groupOrNull(groupId: string | null | undefined): import('@mingle/contracts').GroupSnapshot | null {
    if (!groupId) return null;
    try { return this.options.groups.get(groupId); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  private history(row: HostRow): TeamLeaderChange[] {
    const entries = safeJson<unknown[]>(row.leader_history_json, []);
    return entries.filter((entry): entry is TeamLeaderChange => Boolean(entry && typeof entry === 'object'));
  }

  /** Repairs rows written when this device used local session IDs as published agent IDs. */
  private migrateLegacyAgentIds(context: ProjectContext): void {
    if (!context.isHost) return;
    const row = this.readHost(context.project.teamId, context.project.sharedProjectId);
    if (!row) return;
    const idBySession = new Map(context.agents
      .filter((agent) => agent.deviceId === context.localDeviceId && agent.sessionId && agent.id !== agent.sessionId)
      .map((agent) => [agent.sessionId!, agent.id] as const));
    if (!idBySession.size) return;

    let changed = false;
    const rewrite = (value: unknown): unknown => typeof value === 'string' ? idBySession.get(value) ?? value : value;
    this.options.store.tx(() => {
      for (const [sessionId, agentId] of idBySession) {
        const legacyRoster = this.hostRows.prepare(`SELECT agent_id,handle,role,fallback_rank,removed_at,updated_at
          FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
          .get(context.project.teamId, context.project.sharedProjectId, sessionId) as {
            handle: string; role: string; fallback_rank: number | null; removed_at: string | null; updated_at: string;
          } | undefined;
        if (legacyRoster) {
          const existing = this.hostRows.prepare(`SELECT agent_id FROM mingle_team_host_roster
            WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
            .get(context.project.teamId, context.project.sharedProjectId, agentId);
          if (existing) {
            // Both keys identify the same published agent. Keep the handle already assigned to the
            // legacy row, then merge its role/state onto the canonical row.
            this.hostRows.prepare(`DELETE FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
              .run(context.project.teamId, context.project.sharedProjectId, sessionId);
            this.hostRows.prepare(`UPDATE mingle_team_host_roster SET handle=?,role=?,fallback_rank=?,removed_at=?,updated_at=?
              WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
              .run(legacyRoster.handle, legacyRoster.role, legacyRoster.fallback_rank, legacyRoster.removed_at, legacyRoster.updated_at,
                context.project.teamId, context.project.sharedProjectId, agentId);
          } else {
            this.hostRows.prepare(`UPDATE mingle_team_host_roster SET agent_id=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
              .run(agentId, context.project.teamId, context.project.sharedProjectId, sessionId);
          }
          changed = true;
        }

        const legacyConsent = this.hostRows.prepare(`SELECT * FROM mingle_team_host_consents
          WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
          .get(context.project.teamId, context.project.sharedProjectId, sessionId) as {
            owner_account_id: string; owner_device_id: string; state: string; permission_level: string;
            settings_version: number; disclaimer_version: string; accepted_at: string; updated_at: string;
          } | undefined;
        if (legacyConsent) {
          const currentConsent = this.hostRows.prepare(`SELECT updated_at FROM mingle_team_host_consents
            WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
            .get(context.project.teamId, context.project.sharedProjectId, agentId) as { updated_at?: string } | undefined;
          if (currentConsent) {
            if (String(legacyConsent.updated_at) > String(currentConsent.updated_at)) {
              this.hostRows.prepare(`UPDATE mingle_team_host_consents SET owner_account_id=?,owner_device_id=?,state=?,permission_level=?,
                settings_version=?,disclaimer_version=?,accepted_at=?,updated_at=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
                .run(legacyConsent.owner_account_id, legacyConsent.owner_device_id, legacyConsent.state, legacyConsent.permission_level,
                  legacyConsent.settings_version, legacyConsent.disclaimer_version, legacyConsent.accepted_at, legacyConsent.updated_at,
                  context.project.teamId, context.project.sharedProjectId, agentId);
            }
            this.hostRows.prepare(`DELETE FROM mingle_team_host_consents WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
              .run(context.project.teamId, context.project.sharedProjectId, sessionId);
          } else {
            this.hostRows.prepare(`UPDATE mingle_team_host_consents SET agent_id=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
              .run(agentId, context.project.teamId, context.project.sharedProjectId, sessionId);
          }
          changed = true;
        }

        const oldActivity = this.hostRows.prepare(`SELECT seq,shared_project_id,sender_device_id,entry_id,run_id,at,entry_json
          FROM mingle_team_device_activity WHERE shared_project_id=? AND agent_id=?`)
          .all(context.project.sharedProjectId, sessionId) as Array<{
            seq: number; shared_project_id: string; sender_device_id: string; entry_id: string;
            run_id: string | null; at: string; entry_json: string;
          }>;
        for (const activity of oldActivity) {
          this.hostRows.prepare(`INSERT OR IGNORE INTO mingle_team_device_activity
            (shared_project_id,agent_id,sender_device_id,entry_id,run_id,at,entry_json) VALUES(?,?,?,?,?,?,?)`)
            .run(activity.shared_project_id, agentId, activity.sender_device_id, activity.entry_id, activity.run_id, activity.at, activity.entry_json);
          this.hostRows.prepare('DELETE FROM mingle_team_device_activity WHERE seq=?').run(activity.seq);
          changed = true;
        }

        const oldDeliveries = this.hostRows.prepare(`SELECT delivery_id,request_json FROM mingle_team_device_deliveries
          WHERE shared_project_id=? AND agent_id=?`).all(context.project.sharedProjectId, sessionId) as Array<{ delivery_id: string; request_json: string }>;
        for (const delivery of oldDeliveries) {
          const request = safeJson<Row | null>(delivery.request_json, null);
          const requestJson = request && request.agentId === sessionId ? JSON.stringify({ ...request, agentId }) : delivery.request_json;
          this.hostRows.prepare(`UPDATE mingle_team_device_deliveries SET agent_id=?,request_json=? WHERE delivery_id=?`)
            .run(agentId, requestJson, delivery.delivery_id);
          changed = true;
        }
      }

      const current = this.readHost(context.project.teamId, context.project.sharedProjectId);
      if (current) {
        const settings = safeJson<Row | null>(current.settings_json, null);
        if (settings) {
          const next = { ...settings };
          let settingsChanged = false;
          if (typeof next.orchestratorAgentId === 'string') {
            const mapped = rewrite(next.orchestratorAgentId);
            if (mapped !== next.orchestratorAgentId) { next.orchestratorAgentId = mapped; settingsChanged = true; }
          }
          if (Array.isArray(next.fallbackAgentIds)) {
            const priorFallbacks = next.fallbackAgentIds as unknown[];
            const mapped = priorFallbacks.map(rewrite);
            if (mapped.some((id, index) => id !== priorFallbacks[index])) { next.fallbackAgentIds = mapped; settingsChanged = true; }
          }
          if (settingsChanged) {
            this.hostRows.prepare(`UPDATE mingle_team_host_projects SET settings_json=?,updated_at=? WHERE team_id=? AND shared_project_id=?`)
              .run(JSON.stringify(next), new Date(this.now()).toISOString(), context.project.teamId, context.project.sharedProjectId);
            changed = true;
          }
        }

        const previousHistory = safeJson<unknown[]>(current.leader_history_json, []);
        let historyChanged = false;
        const nextHistory = previousHistory.map((entry) => {
          if (!entry || typeof entry !== 'object') return entry;
          const item = entry as Row;
          const fromAgentId = rewrite(item.fromAgentId);
          const toAgentId = rewrite(item.toAgentId);
          if (fromAgentId === item.fromAgentId && toAgentId === item.toAgentId) return entry;
          historyChanged = true;
          return { ...item, fromAgentId, toAgentId };
        });
        if (historyChanged) {
          this.hostRows.prepare(`UPDATE mingle_team_host_projects SET leader_history_json=?,updated_at=? WHERE team_id=? AND shared_project_id=?`)
            .run(JSON.stringify(nextHistory), new Date(this.now()).toISOString(), context.project.teamId, context.project.sharedProjectId);
          changed = true;
        }
      }

      const consentRows = this.hostRows.prepare(`SELECT account_id,device_id,consent_json FROM mingle_team_device_consents
        WHERE shared_project_id=?`).all(context.project.sharedProjectId) as Array<{ account_id: string; device_id: string; consent_json: string }>;
      for (const consentRow of consentRows) {
        const consent = safeJson<Row | null>(consentRow.consent_json, null);
        if (!consent || !Array.isArray(consent.agentIds)) continue;
        const priorAgentIds = consent.agentIds as unknown[];
        const agentIds = priorAgentIds.map(rewrite);
        if (!agentIds.some((id, index) => id !== priorAgentIds[index])) continue;
        this.hostRows.prepare(`UPDATE mingle_team_device_consents SET consent_json=?
          WHERE shared_project_id=? AND account_id=? AND device_id=?`)
          .run(JSON.stringify({ ...consent, agentIds }), context.project.sharedProjectId, consentRow.account_id, consentRow.device_id);
        changed = true;
      }
    });
    if (!changed) return;
    this.options.store.touch();
    // Members still hold the structure sent under the old ids; send them the migrated one.
    const migrated = this.readHost(context.project.teamId, context.project.sharedProjectId);
    if (migrated) setTimeout(() => { void this.broadcastStructure(context, migrated).catch(() => undefined); }, 0);
  }

  private localAccountId(): string | null {
    const account = this.options.account.snapshot?.();
    return account?.status === 'signed-in' ? account.user?.id ?? null : null;
  }

  private async context(projectId: string): Promise<ProjectContext> {
    const localProject = this.options.store.getProject(projectId);
    if (!localProject) throw new HttpError(404, 'Project not found.');
    // The editor guard uses the persisted team read model and locally verified account state.
    // Outbound device writes still pass through cloud RLS, which rejects stale membership.
    const accountId = this.localAccountId();
    if (!accountId) throw new HttpError(401, 'Sign in to the Mingle account before using team orchestration.');
    const shared = await this.options.collaboration.snapshot(projectId);
    if (!shared.project) throw new HttpError(409, 'Set up teammate sharing for this project first.');
    const deviceSnapshot = this.options.transport.snapshot(shared.project.teamId);
    if (!deviceSnapshot.deviceId) throw new HttpError(409, 'Register this device with the shared project team first.');
    const member = shared.members.find((candidate) => candidate.accountId === accountId);
    if (!member) throw new HttpError(403, 'The signed-in account is not an active member of this project team.');
    const leader = shared.members.find((candidate) => candidate.role === 'leader');
    if (!leader) throw new HttpError(403, 'The active team leader could not be resolved.');
    const source = this.hostRows.prepare(`SELECT owner_id,leader_device_id FROM mingle_project_collaboration_sources
      WHERE local_project_id=?`).get(projectId) as Row | undefined;
    const localBinding = source ?? this.hostRows.prepare(`SELECT account_id,device_id FROM mingle_project_collaboration_joins
      WHERE local_project_id=? AND account_id=? AND device_id=? AND team_id=? AND shared_project_id=?`)
      .get(projectId, accountId, deviceSnapshot.deviceId, shared.project.teamId, shared.project.sharedProjectId) as Row | undefined;
    if (!localBinding) throw new HttpError(403, 'Bind this shared project locally before using team orchestration.');
    const sourceOwner = source ? String(source.owner_id) : leader.accountId;
    const sourceDevice = source && typeof source.leader_device_id === 'string' ? source.leader_device_id : null;
    const isHost = Boolean(source && sourceOwner === accountId && sourceDevice && sourceDevice === deviceSnapshot.deviceId);
    const deviceRows = deviceSnapshot.devices;
    const hostDeviceId = sourceDevice ?? this.options.deviceSide?.latestStructure(shared.project.sharedProjectId)?.host?.deviceId ?? '';
    const hostDevice = deviceRows.find((device) => device.id === hostDeviceId);
    const context: ProjectContext = {
      ...shared, project: shared.project, localProjectId: localProject.id, accountId, localDeviceId: deviceSnapshot.deviceId,
      hostDeviceId, hostAccountId: hostDevice?.ownerId ?? leader.accountId,
      hostDisplayName: shared.members.find((candidate) => candidate.accountId === (hostDevice?.ownerId ?? leader.accountId))?.displayName ?? 'Team lead',
      isHost,
    };
    this.migrateLegacyAgentIds(context);
    return context;
  }

  private mutationKey(context: ProjectContext): string {
    return `${context.project.teamId}\0${context.project.sharedProjectId}`;
  }

  private async requireEditor(projectId: string): Promise<ProjectContext> {
    const context = await this.context(projectId);
    const member = context.members.find((candidate) => candidate.accountId === context.accountId);
    if (!member || !['leader', 'admin'].includes(member.role)) throw new HttpError(403, 'Only a team lead or admin can change team orchestration.');
    if (!context.isHost) throw new HttpError(403, 'Team orchestration settings can be changed only on the host device.');
    return context;
  }

  private consentFor(context: ProjectContext, agentId: string): TeamConsentState {
    const agent = context.agents.find((candidate) => candidate.id === agentId);
    if (!agent) return 'needs-reconsent';
    if (agent.deviceId === context.localDeviceId) return 'granted';
    const row = this.hostRows.prepare(`SELECT state,permission_level,settings_version,disclaimer_version,owner_account_id,owner_device_id
      FROM mingle_team_host_consents WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
      .get(context.project.teamId, context.project.sharedProjectId, agentId) as Row | undefined;
    if (!row) return 'needs-reconsent';
    const settingsRow = this.readHost(context.project.teamId, context.project.sharedProjectId);
    if (!settingsRow) return 'needs-reconsent';
    const settings = this.settings(settingsRow);
    if (row.state !== 'granted') return row.state as TeamConsentState;
    const level = TeamPermissionLevelSchema.safeParse(row.permission_level);
    if (!level.success || rankPermission(level.data) < rankPermission(settings.permissionLevel)
      || row.disclaimer_version !== TEAM_CONSENT_DISCLAIMER_VERSION) return 'needs-reconsent';
    if (String(row.owner_account_id) !== agent.accountId || String(row.owner_device_id) !== agent.deviceId) return 'revoked';
    return 'granted';
  }

  private isOnline(teamId: string, deviceId: string): boolean {
    return this.options.transport.snapshot(teamId).devices.some((device) => device.id === deviceId && device.status === 'online' && !device.revokedAt);
  }

  private agentHandle(teamId: string, sharedProjectId: string, agent: ProjectContext['agents'][number], used: Set<string>,
    members: ProjectCollaborationSnapshot['members'], agents: ProjectCollaborationSnapshot['agents']): string {
    const prior = this.hostRows.prepare(`SELECT handle FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
      .get(teamId, sharedProjectId, agent.id) as { handle?: string } | undefined;
    if (prior?.handle) { used.add(prior.handle); return prior.handle; }
    const provider = (agent.provider ?? 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 8) || 'agent';
    const member = members.find((candidate) => candidate.accountId === agent.accountId);
    const displayName = member?.displayName?.trim() || member?.email?.split('@')[0]?.trim() || 'agent';
    let owner = displayName.split(/\s+/)[0]!.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 22);
    if (!owner) owner = 'agent';
    if (!/^[a-z]/.test(owner)) owner = `agent-${owner}`.slice(0, 22);
    if (owner.length < 2) owner = 'agent';
    const ownedAgentCount = agents.filter((candidate) => candidate.accountId === agent.accountId).length;
    const exists = (handle: string) => used.has(handle) || Boolean(this.hostRows.prepare(`SELECT 1 AS found FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND handle=?`)
      .get(teamId, sharedProjectId, handle));
    if (ownedAgentCount <= 1 && !exists(owner)) {
      used.add(owner);
      return owner;
    }
    const providerHandle = `${owner.slice(0, 23)}-${provider}`.slice(0, 32);
    if (!exists(providerHandle)) { used.add(providerHandle); return providerHandle; }
    for (let number = 2; number <= 999; number++) {
      const handle = `${owner.slice(0, 28)}-${number}`;
      if (!exists(handle)) { used.add(handle); return handle; }
    }
    throw new HttpError(409, `No unique team handle is available for ${agent.name}.`);
  }

  private proxySessionId(teamId: string, sharedProjectId: string, agentId: string): string {
    const digest = createHash('sha256').update(`${teamId}\0${sharedProjectId}\0${agentId}`).digest('hex').slice(0, 32);
    return `proxy_${digest}`;
  }

  private syncSessions(context: ProjectContext, settings: TeamOrchestrationSettings, options: { includeUnlisted?: boolean; agentIds?: Set<string>; restoreRemoved?: boolean } = {}): Array<{ sessionId: string; handle: string; role: 'orchestrator' | 'worker' | 'idle'; held: boolean }> {
    const { teamId, sharedProjectId } = context.project;
    const used = new Set<string>();
    const activeRoster = this.hostRows.prepare(`SELECT agent_id FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND removed_at IS NULL`)
      .all(teamId, sharedProjectId) as Array<{ agent_id: string }>;
    const activeIds = new Set(activeRoster.map((entry) => entry.agent_id));
    const activeAgents = context.agents.filter((agent) => (options.agentIds ? options.agentIds.has(agent.id)
      : options.includeUnlisted || activeIds.has(agent.id)) && agent.sessionId && !agent.deviceId.startsWith('revoked:'));
    if (activeAgents.length > 64) throw new HttpError(409, 'A team project supports at most 64 agents.');
    const at = new Date(this.now()).toISOString();
    const result: Array<{ sessionId: string; handle: string; role: 'orchestrator' | 'worker' | 'idle'; held: boolean }> = [];
    for (const agent of activeAgents) {
      const previous = this.hostRows.prepare(`SELECT role,removed_at FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
        .get(teamId, sharedProjectId, agent.id) as Row | undefined;
      if (previous?.removed_at && !options.restoreRemoved) continue;
      const handle = this.agentHandle(teamId, sharedProjectId, agent, used, context.members, context.agents);
      const role: TeamAgentRole = agent.id === settings.orchestratorAgentId ? 'orchestrator' : previous?.role === 'idle' ? 'idle' : 'worker';
      this.hostRows.prepare(`INSERT INTO mingle_team_host_roster(team_id,shared_project_id,agent_id,handle,role,removed_at,updated_at)
        VALUES(?,?,?,?,?,NULL,?) ON CONFLICT(team_id,shared_project_id,agent_id) DO UPDATE
        SET handle=excluded.handle,role=excluded.role,removed_at=NULL,updated_at=excluded.updated_at`)
        .run(teamId, sharedProjectId, agent.id, handle, role, at);

      let sessionId = agent.sessionId!;
      const local = agent.deviceId === context.localDeviceId;
      if (local) {
        const session = this.options.store.getSession(agent.sessionId!);
        if (!session || session.projectId !== context.localProjectId) continue;
      } else {
        const provider = ProviderSchema.safeParse(agent.provider);
        if (!provider.success || !agent.model) continue;
        const existing = this.hostRows.prepare(`SELECT session_id FROM mingle_team_proxy_sessions WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
          .get(teamId, sharedProjectId, agent.id) as { session_id: string } | undefined;
        sessionId = existing?.session_id ?? this.proxySessionId(teamId, sharedProjectId, agent.id);
        const session = this.options.store.getSession(sessionId, true);
        if (!session) {
          this.options.store.insertSession({ id: sessionId, projectId: context.localProjectId, name: `${agent.name} (team proxy)`.slice(0, 100),
            provider: provider.data, model: agent.model, effort: 'medium', status: 'idle', policy: 'supervised', isolated: false,
            worktreePath: this.options.store.getProject(context.localProjectId)!.path, branch: null });
        } else {
          if (!this.options.store.getSession(sessionId)) this.options.store.restoreSession(sessionId);
          const patch = {
            ...(session.name !== `${agent.name} (team proxy)`.slice(0, 100) ? { name: `${agent.name} (team proxy)`.slice(0, 100) } : {}),
            ...(session.provider !== provider.data ? { provider: provider.data } : {}),
            ...(session.model !== agent.model ? { model: agent.model } : {}),
          };
          if (Object.keys(patch).length) this.options.store.updateSession(sessionId, patch);
        }
        this.hostRows.prepare(`INSERT INTO mingle_team_proxy_sessions(session_id,team_id,shared_project_id,agent_id,owner_account_id,owner_device_id,handle)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET owner_account_id=excluded.owner_account_id,owner_device_id=excluded.owner_device_id,handle=excluded.handle`)
          .run(sessionId, teamId, sharedProjectId, agent.id, agent.accountId, agent.deviceId, handle);
      }
      const consent = this.consentFor(context, agent.id);
      result.push({ sessionId, handle, role, held: role === 'idle' || (!local && consent !== 'granted') });
    }
    return result;
  }

  private async loadContextForHost(projectId: string): Promise<{ context: ProjectContext; row: HostRow }> {
    const context = await this.context(projectId);
    if (!context.isHost) throw new HttpError(403, 'This device is not the project team host.');
    const row = this.readHost(context.project.teamId, context.project.sharedProjectId);
    if (!row) throw new HttpError(404, 'Team orchestration is not enabled for this project.');
    return { context, row };
  }

  async availableAgents(projectId: string): Promise<TeamAvailableAgentsSnapshot> {
    const project = this.options.store.getProject(projectId);
    if (!project) throw new HttpError(404, 'Project not found.');
    const accountId = this.localAccountId();
    if (!accountId) throw new HttpError(401, 'Sign in to the Mingle account before viewing team agents.');
    const shared = await this.options.collaboration.snapshot(projectId);
    const resolvedAccountId = accountId;
    if (!shared.project) return { projectId, teamId: null, sharedProjectId: null, canAdd: false, reason: 'This project is not shared with a team.', permissionLevel: null, teamSession: null, agents: [] };
    const sharedProject = shared.project;
    const { teamId, sharedProjectId } = sharedProject;
    const transport = this.options.transport.snapshot(teamId);
    const localDeviceId = transport.deviceId ?? '';
    const member = shared.members.find((candidate) => candidate.accountId === resolvedAccountId);
    const source = this.hostRows.prepare(`SELECT owner_id,leader_device_id FROM mingle_project_collaboration_sources WHERE local_project_id=?`)
      .get(projectId) as Row | undefined;
    const hostDeviceId = source && typeof source.leader_device_id === 'string'
      ? source.leader_device_id : this.options.deviceSide?.latestStructure(sharedProjectId)?.host?.deviceId ?? '';
    const isHost = Boolean(localDeviceId && hostDeviceId === localDeviceId && source && String(source.owner_id) === resolvedAccountId);
    const canAdd = isHost && Boolean(member && ['leader', 'admin'].includes(member.role));
    const reason = canAdd ? null : !member ? 'Join the shared project team before adding teammates’ agents.'
      : !isHost ? 'Only the lead/admin on the team host device can add teammates’ agents.'
        : 'Only the team lead or an admin can add teammates’ agents.';
    const hostRow = this.readHost(teamId, sharedProjectId);
    const peerStructure = hostRow ? null : this.options.deviceSide?.latestStructure(sharedProjectId) ?? null;
    const settings = hostRow ? this.settings(hostRow) : peerStructure?.settings ?? null;
    const roleByAgent = new Map((this.hostRows.prepare(`SELECT agent_id,handle FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=?`)
      .all(teamId, sharedProjectId) as Array<{ agent_id: string; handle: string }>).map((row) => [row.agent_id, row.handle]));
    for (const entry of peerStructure?.members ?? []) if (!roleByAgent.has(entry.agentId)) roleByAgent.set(entry.agentId, entry.handle);
    const peerMembers = new Map(peerStructure?.members.map((entry) => [entry.agentId, entry]) ?? []);
    const ownDevice = localDeviceId;
    const nonLocal = shared.agents.filter((agent) => agent.deviceId !== ownDevice && !agent.deviceId.startsWith('revoked:'));
    const usedHandles = new Set<string>();
    const agents = nonLocal.map((agent) => {
      const device = transport.devices.find((candidate) => candidate.id === agent.deviceId);
      const online = Boolean(device && device.status === 'online' && !device.revokedAt);
      let handle = roleByAgent.get(agent.id);
      if (!handle) handle = this.agentHandle(teamId, sharedProjectId, agent, usedHandles, shared.members, shared.agents);
      else usedHandles.add(handle);
      let consent: TeamConsentState | 'none' = 'none';
      const consentRow = this.hostRows.prepare(`SELECT state FROM mingle_team_host_consents WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
        .get(teamId, sharedProjectId, agent.id) as { state?: string } | undefined;
      if (hostRow && consentRow) consent = this.consentFor({ ...shared, project: sharedProject, localProjectId: projectId,
        accountId: resolvedAccountId, localDeviceId, hostDeviceId, hostAccountId: String(hostRow.owner_account_id), hostDisplayName: 'Team lead', isHost }, agent.id);
      else if (peerMembers.get(agent.id)?.consent) consent = peerMembers.get(agent.id)!.consent!;
      else if (consentRow?.state && ['granted', 'needs-reconsent', 'paused', 'revoked'].includes(consentRow.state)) consent = consentRow.state as TeamConsentState;
      const proxy = this.hostRows.prepare(`SELECT session_id FROM mingle_team_proxy_sessions WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
        .get(teamId, sharedProjectId, agent.id) as { session_id?: string } | undefined;
      const existingGroup = proxy?.session_id ? this.options.groups.forSession(proxy.session_id) : undefined;
      const groupId = existingGroup?.group.id ?? (peerMembers.has(agent.id) ? peerStructure?.teamSession?.groupId ?? null : null);
      const groupTitle = existingGroup?.group.title;
      let unusableReason: string | null = null;
      if (!canAdd) unusableReason = reason;
      else if (consent !== 'granted') unusableReason = consent === 'none' ? 'The agent owner has not granted team consent.'
        : consent === 'paused' ? 'The agent owner has paused this agent.'
          : consent === 'revoked' ? 'The agent owner revoked consent for this agent.'
            : 'The agent owner needs to renew consent for the current team settings.';
      else if (!online) unusableReason = 'The agent owner’s device is offline.';
      else if (groupId) unusableReason = `Already in “${groupTitle ?? 'another group'}”.`;
      return {
        agentId: agent.id, handle, name: agent.name, provider: ProviderSchema.parse(agent.provider), model: agent.model ?? 'unknown', effort: null,
        ownerAccountId: agent.accountId, ownerDisplayName: shared.members.find((candidate) => candidate.accountId === agent.accountId)?.displayName ?? 'Teammate',
        deviceId: agent.deviceId, deviceName: device?.name ?? 'Unknown device', online, consent,
        usable: unusableReason === null, unusableReason, groupId,
      };
    });
    const group = hostRow ? this.groupOrNull(hostRow.group_id) : null;
    const teamSession = hostRow && group
      ? { groupId: group.group.id, sessionId: group.group.anchorSessionId, title: group.group.title } satisfies TeamSessionRef
      : hostRow ? null : peerStructure?.teamSession ?? null;
    return { projectId, teamId, sharedProjectId, canAdd, reason, permissionLevel: settings?.permissionLevel ?? null, teamSession, agents };
  }

  async addAgentToSession(sessionId: string, rawInput: unknown): Promise<import('@mingle/contracts').GroupSnapshot> {
    const session = this.options.store.getSession(sessionId);
    if (!session) throw new HttpError(404, 'Session not found.');
    if (this.options.groups.forSession(sessionId)) throw new HttpError(409, 'This session already belongs to a group. Add teammates’ agents from that group instead.');
    return this.addAgentToGroupTarget(session.projectId, null, sessionId, rawInput);
  }

  async addAgentToGroup(groupId: string, rawInput: unknown): Promise<import('@mingle/contracts').GroupSnapshot> {
    const group = this.options.groups.get(groupId);
    return this.addAgentToGroupTarget(group.group.projectId, groupId, null, rawInput);
  }

  /** Bind the selected local session (or its existing local group) as this project's shared team session. */
  async shareSession(projectId: string, rawInput: unknown): Promise<TeamStructureSnapshot> {
    const input = ShareTeamSessionSchema.parse(rawInput);
    const initial = await this.context(projectId);
    return this.mutations.run(this.mutationKey(initial), () => this.shareSessionLocked(projectId, input));
  }

  private async shareSessionLocked(projectId: string, input: z.infer<typeof ShareTeamSessionSchema>): Promise<TeamStructureSnapshot> {
    let context = await this.requireEditor(projectId);
    const session = this.options.store.getSession(input.sessionId);
    if (!session || session.projectId !== context.localProjectId || this.isProxySession(session.id)) {
      throw new HttpError(404, 'Choose a local, non-proxy session in this project.');
    }

    let row = this.readHost(context.project.teamId, context.project.sharedProjectId);
    let prior: TeamOrchestrationSettings | null = row ? this.settings(row) : null;
    if (input.expectedVersion !== undefined) {
      if (!prior || input.expectedVersion !== prior.version) throw new HttpError(409, 'Team orchestration settings changed. Refresh and try again.');
    }

    let boundGroup: import('@mingle/contracts').GroupSnapshot | null = null;
    if (row?.group_id) {
      boundGroup = this.groupOrNull(row.group_id);
      if (!boundGroup) throw new HttpError(409, 'The canonical team session is unavailable. Refresh the project before sharing another session.');
      if (boundGroup.group.projectId !== projectId) throw new HttpError(409, 'The canonical team session belongs to a different project.');
      if (boundGroup.group.anchorSessionId !== session.id) {
        throw new HttpError(409, `This team project is already bound to “${boundGroup.group.title}”. Open its canonical session instead of rebinding it.`);
      }
      const settings = prior!;
      if (input.permissionLevel === settings.permissionLevel) return this.structureSnapshot(projectId, { reconcileRoster: false });
      if (input.expectedVersion === undefined) throw new HttpError(409, 'Include the current expectedVersion when changing team orchestration settings.');
      if (boundGroup.deliveries.some((delivery) => delivery.status === 'running')) {
        throw new HttpError(409, 'Wait for active team deliveries before changing orchestration settings.');
      }
      const next = TeamOrchestrationSettingsSchema.parse({ ...settings, permissionLevel: input.permissionLevel,
        version: settings.version + 1, updatedAt: new Date(this.now()).toISOString(), updatedByAccountId: context.accountId });
      this.options.store.tx(() => {
        const latest = this.readHost(context.project.teamId, context.project.sharedProjectId);
        if (!latest || this.settings(latest).version !== settings.version) throw new HttpError(409, 'Team orchestration settings changed. Refresh and try again.');
        this.persistSettings(latest, next);
        this.markLowerConsentsForReconsent(context, settings.permissionLevel, next);
      });
      row = this.readHost(context.project.teamId, context.project.sharedProjectId)!;
      await this.broadcastStructure(context, row, { reconcileRoster: false });
      return this.structureSnapshot(projectId, { reconcileRoster: false });
    }
    if (!row && input.expectedVersion !== undefined) throw new HttpError(409, 'Team orchestration settings changed. Refresh and try again.');
    if (row && input.expectedVersion === undefined) {
      throw new HttpError(409, 'Include the current expectedVersion when attaching a session to an enabled team project.');
    }

    boundGroup = this.options.groups.forSession(session.id) ?? null;
    if (boundGroup && boundGroup.group.projectId !== projectId) throw new HttpError(409, 'The selected session belongs to a group in a different project.');
    let orchestratorSessionId: string | null = session.id;
    if (boundGroup) {
      const activeMembers = boundGroup.members.filter((member) => !member.removedAt);
      if (boundGroup.group.anchorSessionId !== session.id) {
        throw new HttpError(409, `This session belongs to “${boundGroup.group.title}”. Open its anchor session to share the existing group.`);
      }
      const currentLead = (boundGroup.group.orchestratorMemberId
        ? activeMembers.find((member) => member.id === boundGroup!.group.orchestratorMemberId) : undefined)
        ?? (boundGroup.group.mode === 'current-leads'
          ? activeMembers.find((member) => member.sessionId === boundGroup!.group.anchorSessionId) : undefined);
      if (boundGroup.group.mode === 'cowork') orchestratorSessionId = null;
      else if (!currentLead || this.isProxySession(currentLead.sessionId)) {
        throw new HttpError(409, `The existing group “${boundGroup.group.title}” has no available local orchestrator to share.`);
      } else {
        orchestratorSessionId = currentLead.sessionId;
      }
      if (boundGroup.deliveries.some((delivery) => delivery.status === 'running')) {
        throw new HttpError(409, 'Wait for active group deliveries before sharing this session with the team.');
      }
      const otherBinding = this.hostRows.prepare(`SELECT team_id,shared_project_id FROM mingle_team_host_projects WHERE group_id=? AND group_id<>''`)
        .get(boundGroup.group.id) as { team_id?: string; shared_project_id?: string } | undefined;
      if (otherBinding && (otherBinding.team_id !== context.project.teamId || otherBinding.shared_project_id !== context.project.sharedProjectId)) {
        throw new HttpError(409, 'This local group is already the canonical session for another shared project.');
      }
    }

    const requiredSessionIds = [...new Set([session.id, ...(orchestratorSessionId && orchestratorSessionId !== session.id ? [orchestratorSessionId] : [])])];
    const requiredSessions = requiredSessionIds.map((sessionId) => this.options.store.getSession(sessionId));
    const localGroupSessionIds = new Set([...requiredSessionIds, ...(boundGroup?.members ?? [])
      .filter((member) => !member.removedAt && !this.isProxySession(member.sessionId)).map((member) => member.sessionId)]);
    const localGroupSessions = [...localGroupSessionIds].map((sessionId) => this.options.store.getSession(sessionId));
    if (localGroupSessions.some((candidate) => !candidate || candidate.projectId !== context.localProjectId || this.isProxySession(candidate.id))) {
      throw new HttpError(409, 'The existing team group contains an unavailable local session.');
    }
    const unsupported = localGroupSessions.find((candidate) => candidate && !publishableLocalProviders.has(candidate.provider));
    if (unsupported) {
      throw new HttpError(409, `${unsupported.provider} sessions cannot be published for remote team execution. Use Claude, Codex, or OpenCode sessions.`);
    }
    if (requiredSessions.some((candidate) => candidate && ['running', 'waiting'].includes(candidate.status))) {
      throw new HttpError(409, 'Wait for the current session and group lead to finish before sharing this group.');
    }
    const localAgentForSession = (sessionId: string) => context.agents.find((agent) => agent.deviceId === context.localDeviceId
      && agent.accountId === context.accountId && agent.projectId === context.localProjectId && agent.sessionId === sessionId);
    if (requiredSessionIds.some((sessionId) => !localAgentForSession(sessionId))) {
      if (!this.options.publishLocalAgents) throw new HttpError(409, 'This session could not be published for team orchestration.');
      const alreadyPublished = context.agents.filter((agent) => agent.deviceId === context.localDeviceId && agent.sessionId
        && agent.projectId === context.localProjectId && !this.isProxySession(agent.sessionId)).map((agent) => agent.sessionId!);
      try {
        await this.options.publishLocalAgents({ teamId: context.project.teamId, sharedProjectId: context.project.sharedProjectId,
          sessionIds: [...new Set([...alreadyPublished, ...requiredSessionIds])] });
      } catch (error) {
        const detail = error instanceof Error ? redactSecrets(error.message).slice(0, 500) : '';
        throw new HttpError(409, detail ? `This session could not be published: ${detail}` : 'This session could not be published.');
      }
      context = await this.requireEditor(projectId);
      row = this.readHost(context.project.teamId, context.project.sharedProjectId);
      prior = row ? this.settings(row) : null;
      if ((input.expectedVersion !== undefined && (!prior || input.expectedVersion !== prior.version))
        || (row && (row.group_id !== '' || input.expectedVersion === undefined))) {
        throw new HttpError(409, 'Team orchestration settings changed. Refresh and try again.');
      }
      if (boundGroup && this.options.groups.forSession(session.id)?.group.id !== boundGroup.group.id) {
        throw new HttpError(409, 'The selected group changed while its local agents were being published. Refresh and try again.');
      }
      if (requiredSessionIds.some((sessionId) => !localAgentForSession(sessionId))) {
        throw new HttpError(409, 'The selected session and its current group lead were not returned as published local team agents.');
      }
    }
    const selected = orchestratorSessionId ? localAgentForSession(orchestratorSessionId) : undefined;
    const anchorAgent = localAgentForSession(session.id);
    if (!anchorAgent || (orchestratorSessionId && !selected)) throw new HttpError(409, 'The selected session and its current group lead must be published by this host account and device.');

    if (row?.group_id === '') {
      const latest = this.readHost(context.project.teamId, context.project.sharedProjectId);
      if (!latest || (prior && this.settings(latest).version !== prior.version)) throw new HttpError(409, 'Team orchestration settings changed. Refresh and try again.');
    }

    const at = new Date(this.now()).toISOString();
    const orchestratorAgentId = selected?.id ?? null;
    const settingsChanged = !prior || prior.leaderOrchestration !== true || prior.permissionLevel !== input.permissionLevel
      || prior.orchestratorAgentId !== orchestratorAgentId || Boolean(orchestratorAgentId && prior.fallbackAgentIds.includes(orchestratorAgentId));
    const consentVersion = this.hostRows.prepare(`SELECT MAX(settings_version) AS version FROM mingle_team_host_consents
      WHERE team_id=? AND shared_project_id=?`).get(context.project.teamId, context.project.sharedProjectId) as { version?: number | null } | undefined;
    const settings = TeamOrchestrationSettingsSchema.parse({
      ...(prior ?? { fallbackAgentIds: [] }),
      leaderOrchestration: true, permissionLevel: input.permissionLevel, orchestratorAgentId,
      fallbackAgentIds: (prior?.fallbackAgentIds ?? []).filter((agentId) => agentId !== orchestratorAgentId),
      version: prior ? prior.version + (settingsChanged ? 1 : 0) : Math.max(1, Number(consentVersion?.version) || 1),
      updatedAt: settingsChanged ? at : prior?.updatedAt ?? at,
      updatedByAccountId: settingsChanged ? context.accountId : prior?.updatedByAccountId ?? context.accountId,
    });
    const teamSessionAgents = boundGroup ? requiredSessionIds.map((sessionId) => ({
      sessionId, agent: localAgentForSession(sessionId)!, groupMember: boundGroup!.members.find((member) => member.sessionId === sessionId && !member.removedAt),
    })) : [{ sessionId: session.id, agent: anchorAgent, groupMember: undefined }];
    for (const { agent, groupMember } of teamSessionAgents) {
      if (!groupMember) continue;
      const collision = this.hostRows.prepare(`SELECT agent_id FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND handle=? AND agent_id<>? AND removed_at IS NULL`)
        .get(context.project.teamId, context.project.sharedProjectId, groupMember.handle, agent.id);
      if (collision) throw new HttpError(409, `The existing local group handle @${groupMember.handle} conflicts with an active team agent.`);
    }

    const groupId = boundGroup?.group.id ?? `group_${randomUUID().replaceAll('-', '')}`;
    this.options.store.tx(() => {
      this.syncSessions(context, settings, { agentIds: new Set(teamSessionAgents.map(({ agent }) => agent.id)), restoreRemoved: true });
      for (const { agent, groupMember } of teamSessionAgents) {
        if (!groupMember) continue;
        const role: TeamAgentRole = agent.id === orchestratorAgentId ? 'orchestrator' : groupMember.held ? 'idle' : 'worker';
        this.hostRows.prepare(`UPDATE mingle_team_host_roster SET handle=?,role=?,removed_at=NULL,updated_at=?
          WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
          .run(groupMember.handle, role, at, context.project.teamId, context.project.sharedProjectId, agent.id);
      }
      if (!boundGroup) {
        const handle = this.handleFor(context.project.teamId, context.project.sharedProjectId, anchorAgent.id);
        if (!handle) throw new HttpError(409, 'The selected session has no usable team handle.');
        if (!selected) throw new HttpError(409, 'The selected session has no published orchestrator.');
        this.options.groups.createTeamGroup({ id: groupId, projectId, title: session.name, mode: 'orchestrated',
          orchestratorSessionId: session.id, members: [{ sessionId: session.id, handle, role: 'orchestrator', held: false }] });
      }
      if (row) this.saveHostProject(context, groupId, settings, row);
      else this.saveHostProject(context, groupId, settings, null);
      this.markLowerConsentsForReconsent(context, prior?.permissionLevel ?? 'supervised', settings);
    });
    row = this.readHost(context.project.teamId, context.project.sharedProjectId)!;
    if (!row || row.group_id !== groupId) throw new HttpError(500, 'The team session could not be saved.');
    await this.broadcastStructure(context, row, { reconcileRoster: false });
    return this.structureSnapshot(projectId, { reconcileRoster: false });
  }

  private async addAgentToGroupTarget(projectId: string, requestedGroupId: string | null, anchorSessionId: string | null, rawInput: unknown): Promise<import('@mingle/contracts').GroupSnapshot> {
    const input = AddTeamAgentSchema.parse(rawInput);
    const initial = await this.context(projectId);
    return this.mutations.run(this.mutationKey(initial), async () => {
      let context = await this.requireEditor(projectId);
      const { teamId, sharedProjectId } = context.project;
      // The lead's own agents in the session join the shared roster, so teammates see and can mention them.
      const localSessionIds = anchorSessionId ? [anchorSessionId] : (requestedGroupId ? this.groupOrNull(requestedGroupId)?.members ?? [] : [])
        .filter((member) => !member.removedAt && !this.isProxySession(member.sessionId)).map((member) => member.sessionId);
      const ownPublished = context.agents.filter((candidate) => candidate.deviceId === context.localDeviceId && candidate.sessionId).map((candidate) => candidate.sessionId!);
      const unpublished = localSessionIds.filter((sessionId) => !ownPublished.includes(sessionId));
      if (unpublished.length && this.options.publishLocalAgents) {
        try {
          await this.options.publishLocalAgents({ teamId, sharedProjectId, sessionIds: [...new Set([...ownPublished, ...unpublished])] });
          context = await this.requireEditor(projectId);
        } catch { /* Sessions of providers without remote execution stay local-only; the add itself still proceeds. */ }
      }
      const agent = context.agents.find((candidate) => candidate.id === input.agentId && candidate.deviceId !== context.localDeviceId);
      if (!agent || !agent.sessionId || !ProviderSchema.safeParse(agent.provider).success || !agent.model) {
        throw new HttpError(404, `Team agent ${input.agentId} is unknown or unusable.`);
      }
      const transport = this.options.transport.snapshot(teamId);
      const device = transport.devices.find((candidate) => candidate.id === agent.deviceId);
      if (!device || device.status !== 'online' || device.revokedAt) throw new HttpError(409, `${agent.name} cannot be added: the owner device is offline.`);
      const currentRow = this.readHost(teamId, sharedProjectId);
      const permissionLevel = currentRow ? this.settings(currentRow).permissionLevel : 'supervised';
      const consentRow = this.hostRows.prepare(`SELECT state,permission_level,settings_version,disclaimer_version,owner_account_id,owner_device_id
        FROM mingle_team_host_consents WHERE team_id=? AND shared_project_id=? AND agent_id=?`).get(teamId, sharedProjectId, agent.id) as Row | undefined;
      const currentConsent = consentRow && consentRow.state === 'granted'
        && String(consentRow.owner_account_id) === agent.accountId && String(consentRow.owner_device_id) === agent.deviceId
        && consentRow.disclaimer_version === TEAM_CONSENT_DISCLAIMER_VERSION
        && TeamPermissionLevelSchema.safeParse(consentRow.permission_level).success
        && rankPermission(TeamPermissionLevelSchema.parse(consentRow.permission_level)) >= rankPermission(permissionLevel);
      if (!currentConsent) {
        const state = consentRow?.state === 'paused' ? 'paused' : consentRow?.state === 'revoked' ? 'revoked' : 'not granted or needs re-consent';
        throw new HttpError(409, `${agent.name} cannot be added: consent is ${state}.`);
      }

      let groupId = requestedGroupId;
      let anchor = anchorSessionId ? this.options.store.getSession(anchorSessionId) : undefined;
      let groupSnapshot = groupId ? this.options.groups.get(groupId) : undefined;
      if (requestedGroupId && (!groupSnapshot || groupSnapshot.group.projectId !== projectId)) throw new HttpError(404, 'Group not found in this shared project.');
      const currentTeam = currentRow ? this.groupOrNull(currentRow.group_id) : null;
      const currentTeammates = currentTeam ? currentTeam.members.filter((member) => !member.removedAt && this.isProxySession(member.sessionId)) : [];
      if (currentTeam && currentTeammates.length && currentTeam.group.id !== groupId) {
        throw new HttpError(409, `The team session is already “${currentTeam.group.title}”. Remove its teammate agents before adding one to another group.`);
      }

      if (!groupSnapshot) {
        if (!anchor) throw new HttpError(404, 'Session not found.');
        groupId = `group_${randomUUID().replaceAll('-', '')}`;
        const orchestrator = context.agents.find((candidate) => candidate.sessionId === anchor.id && candidate.deviceId === context.localDeviceId);
        const orchestratorAgentId = input.mode === 'cowork' ? null : orchestrator?.id ?? null;
        const minimumVersion = Math.max(1, Number(consentRow.settings_version) || 1);
        const settings = TeamOrchestrationSettingsSchema.parse({ leaderOrchestration: true, permissionLevel,
          orchestratorAgentId, fallbackAgentIds: [], version: currentRow ? Math.max(this.settings(currentRow).version + 1, minimumVersion) : minimumVersion,
          updatedAt: new Date(this.now()).toISOString(), updatedByAccountId: context.accountId });
        const selected = this.syncSessions(context, settings, { agentIds: new Set([agent.id, ...(orchestrator ? [orchestrator.id] : [])]), restoreRemoved: true });
        const remoteMember = selected.find((member) => member.handle === this.handleFor(teamId, sharedProjectId, agent.id));
        if (!remoteMember) throw new HttpError(404, `${agent.name} has no usable proxy session.`);
        const hostMember = orchestrator ? selected.find((member) => member.sessionId === anchor!.id) : undefined;
        const localMemberHandle = hostMember?.handle ?? this.uniqueGroupHandle(anchor.provider, anchor.id, [anchor.provider]);
        const remoteHandle = this.chooseTeamHandle(agent.id, input.handle, remoteMember.handle, teamId, sharedProjectId, groupId, [localMemberHandle]);
        this.hostRows.prepare(`UPDATE mingle_team_host_roster SET handle=?,updated_at=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
          .run(remoteHandle, settings.updatedAt, teamId, sharedProjectId, agent.id);
        this.hostRows.prepare(`UPDATE mingle_team_proxy_sessions SET handle=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
          .run(remoteHandle, teamId, sharedProjectId, agent.id);
        groupSnapshot = this.options.groups.createTeamGroup({ id: groupId, projectId, title: anchor.name, mode: input.mode ?? 'orchestrated',
          orchestratorSessionId: anchor.id, members: [
            { sessionId: anchor.id, handle: localMemberHandle, role: 'orchestrator', held: false },
            { sessionId: remoteMember.sessionId, handle: remoteHandle, role: 'worker', held: false },
          ] });
        this.saveHostProject(context, groupId, settings, currentRow ?? null);
      } else {
        if (!groupId || !groupSnapshot) throw new HttpError(404, 'Group not found.');
        const group = groupSnapshot.group;
        const activeMembers = groupSnapshot.members.filter((member) => !member.removedAt);
        const orchestratorMember = activeMembers.find((member) => member.id === group.orchestratorMemberId)
          ?? activeMembers.find((member) => member.sessionId === group.anchorSessionId);
        if (!orchestratorMember) throw new HttpError(409, 'Choose an active group orchestrator before adding a teammate agent.');
        const orchestratorAgent = context.agents.find((candidate) => candidate.sessionId === orchestratorMember.sessionId && candidate.deviceId === context.localDeviceId);
        const minimumVersion = Math.max(1, Number(consentRow.settings_version) || 1);
        const priorSettings = currentRow?.group_id === groupId ? this.settings(currentRow) : null;
        const nextVersion = currentRow ? Math.max(this.settings(currentRow).version + 1, minimumVersion) : minimumVersion;
        const orchestratorAgentId = group.mode === 'cowork' ? null : orchestratorAgent?.id ?? null;
        const settings = priorSettings && priorSettings.version >= minimumVersion ? priorSettings
          : TeamOrchestrationSettingsSchema.parse({ ...(priorSettings ?? { leaderOrchestration: true, permissionLevel,
            orchestratorAgentId, fallbackAgentIds: [] }),
            version: priorSettings ? minimumVersion : nextVersion, updatedAt: new Date(this.now()).toISOString(), updatedByAccountId: context.accountId });
        const selected = this.syncSessions(context, settings, { agentIds: new Set([agent.id, ...(orchestratorAgent ? [orchestratorAgent.id] : [])]), restoreRemoved: true });
        const remoteMember = selected.find((member) => member.handle === this.handleFor(teamId, sharedProjectId, agent.id));
        if (!remoteMember) throw new HttpError(404, `${agent.name} has no usable proxy session.`);
        const existingHandles = groupSnapshot.members.map((member) => member.handle);
        const remoteHandle = this.chooseTeamHandle(agent.id, input.handle, remoteMember.handle, teamId, sharedProjectId, groupId, existingHandles);
        this.hostRows.prepare(`UPDATE mingle_team_host_roster SET handle=?,updated_at=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
          .run(remoteHandle, settings.updatedAt, teamId, sharedProjectId, agent.id);
        this.hostRows.prepare(`UPDATE mingle_team_proxy_sessions SET handle=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
          .run(remoteHandle, teamId, sharedProjectId, agent.id);
        groupSnapshot = await this.options.groups.addTeamMember(groupId, { sessionId: remoteMember.sessionId, handle: remoteHandle });
        if (currentRow) this.saveHostProject(context, groupId, settings, currentRow);
        else this.saveHostProject(context, groupId, settings, null);
        this.syncTeamRoster(context, groupId, settings);
      }
      const row = this.readHost(teamId, sharedProjectId);
      if (!row || row.group_id !== groupId) throw new HttpError(500, 'The team session could not be saved.');
      await this.broadcastStructure(context, row);
      return this.options.groups.get(groupId);
    });
  }

  private uniqueGroupHandle(provider: string, sessionId: string, reserved: string[]): string {
    const base = provider.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'agent';
    const existing = this.options.groups.forSession(sessionId);
    const used = new Set([...reserved, ...(existing?.members.map((member) => member.handle) ?? [])]);
    for (let index = 1; index < 1000; index++) {
      const handle = `${base}${index}`.slice(0, 32);
      if (!used.has(handle)) return handle;
    }
    throw new HttpError(409, 'No unique group handle is available for the current agent.');
  }

  private chooseTeamHandle(agentId: string, requested: string | undefined, published: string, teamId: string, sharedProjectId: string, groupId: string, groupHandles: string[]): string {
    const handle = requested ?? published;
    if (groupHandles.includes(handle)) {
      if (requested) throw new HttpError(409, `@${handle} is already in use in this group.`);
      const match = handle.match(/^(.*?)(\d+)$/);
      const base = match?.[1] || handle;
      for (let index = 2; index < 1000; index++) {
        const candidate = `${base}${index}`.slice(0, 32);
        const published = this.hostRows.prepare(`SELECT 1 AS found FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND handle=? AND agent_id<>?`)
          .get(teamId, sharedProjectId, candidate, agentId);
        if (!groupHandles.includes(candidate) && !published) return candidate;
      }
      throw new HttpError(409, `No unique group handle is available for ${agentId}.`);
    }
    if (requested) {
      const collision = this.hostRows.prepare(`SELECT agent_id FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND handle=? AND agent_id<>?`)
        .get(teamId, sharedProjectId, handle, agentId);
      if (collision) throw new HttpError(409, `@${handle} is already published by another team agent.`);
    }
    void groupId;
    return handle;
  }

  private saveHostProject(context: ProjectContext, groupId: string, settings: TeamOrchestrationSettings, prior: HostRow | null): void {
    const at = settings.updatedAt;
    if (prior) {
      const result = this.hostRows.prepare(`UPDATE mingle_team_host_projects SET group_id=?,settings_json=?,updated_at=? WHERE team_id=? AND shared_project_id=? AND group_id=?`)
        .run(groupId, JSON.stringify(settings), at, context.project.teamId, context.project.sharedProjectId, prior.group_id);
      if (Number(result.changes) !== 1) throw new HttpError(409, 'The project team session changed while adding an agent. Refresh and try again.');
    } else {
      this.hostRows.prepare(`INSERT INTO mingle_team_host_projects(team_id,shared_project_id,local_project_id,owner_account_id,host_device_id,group_id,settings_json,leader_history_json,needs_leader,updated_at)
        VALUES(?,?,?,?,?,?,?,'[]',0,?)`).run(context.project.teamId, context.project.sharedProjectId, context.localProjectId,
        context.accountId, context.localDeviceId, groupId, JSON.stringify(settings), at);
    }
  }

  private async mirrorGroupHumanMessage(groupId: string, messageId: string): Promise<void> {
    const row = this.hostRows.prepare(`SELECT * FROM mingle_team_host_projects WHERE group_id=?`).get(groupId) as HostRow | undefined;
    if (!row || !this.chat) return;
    const message = this.options.groups.get(groupId).messages.find((candidate) => candidate.id === messageId);
    if (!message || message.kind !== 'user' || !message.content.trim()) return;
    const group = this.options.groups.get(groupId).group;
    await this.chat.mirrorTeamSessionMessage({ projectId: row.local_project_id, sessionId: group.anchorSessionId,
      sourceMessageId: message.id, content: message.content, kind: 'human' });
  }

  private async onGroupMemberRemoved(groupId: string, memberId: string): Promise<void> {
    const group = this.options.groups.get(groupId);
    const member = group.members.find((candidate) => candidate.id === memberId);
    if (!member) return;
    const proxy = this.proxy(member.sessionId);
    if (!proxy) return;
    const row = this.readHost(proxy.team_id, proxy.shared_project_id);
    if (!row || row.group_id !== groupId) return;
    const at = new Date(this.now()).toISOString();
    const prior = this.settings(row);
    const nextOrchestrator = group.members.find((candidate) => !candidate.removedAt && candidate.id === group.group.orchestratorMemberId);
    const context = await this.context(row.local_project_id);
    const nextAgent = nextOrchestrator ? context.agents.find((agent) => agent.sessionId === nextOrchestrator.sessionId && agent.deviceId === context.localDeviceId) : undefined;
    const nextAgentId = nextOrchestrator ? nextAgent?.id ?? null : null;
    const removedWasLeader = prior.orchestratorAgentId === proxy.agent_id;
    const settings = TeamOrchestrationSettingsSchema.parse({ ...prior,
      orchestratorAgentId: removedWasLeader ? nextAgentId : prior.orchestratorAgentId,
      fallbackAgentIds: prior.fallbackAgentIds.filter((id) => id !== proxy.agent_id),
      version: prior.version + 1, updatedAt: at, updatedByAccountId: context.accountId });
    const needsLeader = removedWasLeader && !nextAgentId;
    this.hostRows.prepare(`UPDATE mingle_team_host_roster SET removed_at=?,updated_at=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
      .run(at, at, proxy.team_id, proxy.shared_project_id, proxy.agent_id);
    this.hostRows.prepare(`UPDATE mingle_team_host_projects SET settings_json=?,needs_leader=?,updated_at=? WHERE team_id=? AND shared_project_id=? AND settings_json=?`)
      .run(JSON.stringify(settings), Number(needsLeader), at, proxy.team_id, proxy.shared_project_id, row.settings_json);
    if (needsLeader) this.options.groups.pauseTeamGroup(groupId, 'The team orchestrator was removed. Choose a new leader.');
    const freshRow = this.readHost(proxy.team_id, proxy.shared_project_id);
    if (freshRow) await this.broadcastStructure(context, freshRow);
    this.options.store.recordEvent({ projectId: context.localProjectId, type: 'team.session.updated',
      summary: 'Shared team session updated', payload: { teamSession: { groupId, sessionId: group.group.anchorSessionId, title: group.group.title } } });
  }

  private async onGroupArchived(groupId: string): Promise<void> {
    if (!groupId) return;
    const row = this.hostRows.prepare('SELECT * FROM mingle_team_host_projects WHERE group_id=?').get(groupId) as HostRow | undefined;
    if (!row) return;
    const prior = this.settings(row);
    const at = new Date(this.now()).toISOString();
    const settings = TeamOrchestrationSettingsSchema.parse({ ...prior, orchestratorAgentId: null, fallbackAgentIds: [],
      version: prior.version + 1, updatedAt: at, updatedByAccountId: row.owner_account_id });
    this.options.store.tx(() => {
      this.hostRows.prepare(`UPDATE mingle_team_host_roster SET removed_at=?,updated_at=?
        WHERE team_id=? AND shared_project_id=? AND removed_at IS NULL`).run(at, at, row.team_id, row.shared_project_id);
      this.hostRows.prepare(`UPDATE mingle_team_host_projects SET group_id='',settings_json=?,needs_leader=1,updated_at=?
        WHERE team_id=? AND shared_project_id=? AND group_id=?`)
        .run(JSON.stringify(settings), at, row.team_id, row.shared_project_id, groupId);
    });
    // Team mode and owners' consent outlive the deleted session; the next teammate agent added starts a new team session.
    try {
      const context = await this.context(row.local_project_id);
      const freshRow = this.readHost(row.team_id, row.shared_project_id);
      if (freshRow) await this.broadcastStructure(context, freshRow);
    } finally {
      this.options.store.recordEvent({ projectId: row.local_project_id, type: 'team.session.updated',
        summary: 'Shared team session updated', payload: { teamSession: null } });
    }
  }

  private syncTeamRoster(context: ProjectContext, groupId: string, settings: TeamOrchestrationSettings): Array<{ sessionId: string; handle: string; role: 'orchestrator' | 'worker' | 'idle'; held: boolean }> {
    const members = this.syncSessions(context, settings);
    this.options.groups.syncTeamRosterMembers(groupId, members, this.managedTeamSessionIds(context));
    return members;
  }

  private managedTeamSessionIds(context: ProjectContext): string[] {
    const roster = this.hostRows.prepare(`SELECT agent_id FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=?`)
      .all(context.project.teamId, context.project.sharedProjectId) as Array<{ agent_id: string }>;
    const rosterIds = new Set(roster.map((entry) => entry.agent_id));
    const local = context.agents.filter((agent) => rosterIds.has(agent.id) && agent.deviceId === context.localDeviceId && agent.sessionId)
      .map((agent) => agent.sessionId!);
    const proxies = this.hostRows.prepare(`SELECT session_id FROM mingle_team_proxy_sessions WHERE team_id=? AND shared_project_id=?`)
      .all(context.project.teamId, context.project.sharedProjectId) as Array<{ session_id: string }>;
    return [...new Set([...local, ...proxies.map((row) => row.session_id)])];
  }

  async enable(projectId: string, rawInput: unknown): Promise<TeamStructureSnapshot> {
    const context = await this.context(projectId);
    return this.mutations.run(this.mutationKey(context), () => this.enableLocked(projectId, rawInput));
  }

  private async enableLocked(projectId: string, rawInput: unknown): Promise<TeamStructureSnapshot> {
    const input = EnableTeamOrchestrationSchema.parse(rawInput);
    const context = await this.requireEditor(projectId);
    const { teamId, sharedProjectId } = context.project;
    const current = this.readHost(teamId, sharedProjectId);
    if (current) throw new HttpError(409, 'Team orchestration is already enabled.');
    const selected = context.agents.find((agent) => agent.id === input.orchestratorAgentId);
    if (!selected || !selected.sessionId) throw new HttpError(400, 'Choose a currently published project agent as orchestrator.');
    if (new Set(input.fallbackAgentIds).size !== input.fallbackAgentIds.length || input.fallbackAgentIds.includes(input.orchestratorAgentId)
      || input.fallbackAgentIds.some((id) => !context.agents.some((agent) => agent.id === id))) throw new HttpError(400, 'Choose unique active fallback agents other than the orchestrator.');
    if (selected.deviceId !== context.localDeviceId && input.permissionLevel === 'full-access') {
      throw new HttpError(409, 'A remote orchestrator needs current owner consent at the selected permission level.');
    }
    const consentVersion = this.hostRows.prepare(`SELECT MAX(settings_version) AS version FROM mingle_team_host_consents WHERE team_id=? AND shared_project_id=?`)
      .get(teamId, sharedProjectId) as { version?: number | null } | undefined;
    const settings = TeamOrchestrationSettingsSchema.parse({ ...input, version: Math.max(1, Number(consentVersion?.version) || 1),
      updatedAt: new Date(this.now()).toISOString(), updatedByAccountId: context.accountId });
    const groupId = '';
    const at = new Date(this.now()).toISOString();
    this.options.store.tx(() => {
      // Explicit enable preserves the historic behavior of adopting all currently published agents.
      const members = this.syncSessions({ ...context, isHost: true }, settings, { includeUnlisted: true });
      const orchestrator = context.agents.find((agent) => agent.id === settings.orchestratorAgentId)!;
      const orchestratorMember = members.find((member) => member.handle === this.handleFor(teamId, sharedProjectId, orchestrator.id));
      if (!orchestratorMember) throw new HttpError(409, 'The selected orchestrator has no usable local or proxy session.');
      if (orchestrator.deviceId !== context.localDeviceId && !this.isOnline(teamId, orchestrator.deviceId)) {
        throw new HttpError(409, 'The selected remote orchestrator device is offline.');
      }
      this.hostRows.prepare(`INSERT INTO mingle_team_host_projects(team_id,shared_project_id,local_project_id,owner_account_id,host_device_id,group_id,settings_json,leader_history_json,needs_leader,updated_at)
        VALUES(?,?,?,?,?,?,?,'[]',0,?)`).run(teamId, sharedProjectId, projectId, context.accountId, context.localDeviceId, groupId, JSON.stringify(settings), at);
    });
    this.options.store.touch();
    await this.broadcastStructure(context, this.readHost(teamId, sharedProjectId)!);
    return this.structureSnapshot(projectId);
  }

  async update(projectId: string, rawInput: unknown): Promise<TeamStructureSnapshot> {
    const context = await this.context(projectId);
    return this.mutations.run(this.mutationKey(context), () => this.updateLocked(projectId, rawInput));
  }

  private async updateLocked(projectId: string, rawInput: unknown): Promise<TeamStructureSnapshot> {
    const input = TeamOrchestrationSettingsSchema.pick({ leaderOrchestration: true, permissionLevel: true }).partial()
      .extend({ fallbackAgentIds: TeamOrchestrationSettingsSchema.shape.fallbackAgentIds.optional(), expectedVersion: TeamOrchestrationSettingsSchema.shape.version }).strict().parse(rawInput);
    const { context, row } = await this.loadContextForHost(projectId);
    const group = this.groupOrNull(row.group_id);
    if (group?.deliveries.some((delivery) => delivery.status === 'running')) {
      throw new HttpError(409, 'Wait for active team deliveries before changing orchestration settings.');
    }
    const member = context.members.find((candidate) => candidate.accountId === context.accountId);
    if (!member || !['leader', 'admin'].includes(member.role)) throw new HttpError(403, 'Only a team lead or admin can change team orchestration.');
    const prior = this.settings(row);
    if (input.expectedVersion !== prior.version) throw new HttpError(409, 'Team orchestration settings changed. Refresh and try again.');
    const { expectedVersion: _expectedVersion, ...patch } = input;
    const fallbackIds = input.fallbackAgentIds ?? prior.fallbackAgentIds;
    const activeRoster = this.hostRows.prepare(`SELECT agent_id,role FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND removed_at IS NULL`)
      .all(context.project.teamId, context.project.sharedProjectId) as Array<{ agent_id: string; role: TeamAgentRole }>;
    if (new Set(fallbackIds).size !== fallbackIds.length || fallbackIds.includes(prior.orchestratorAgentId ?? '')
      || fallbackIds.some((id) => !context.agents.some((agent) => agent.id === id)
        || !activeRoster.some((entry) => entry.agent_id === id) || activeRoster.find((entry) => entry.agent_id === id)?.role === 'idle')) {
      throw new HttpError(400, 'Fallbacks must be unique agents from the current shared-project roster.');
    }
    const next = TeamOrchestrationSettingsSchema.parse({ ...prior, ...patch, fallbackAgentIds: fallbackIds, version: prior.version + 1,
      updatedAt: new Date(this.now()).toISOString(), updatedByAccountId: context.accountId });
    this.options.store.tx(() => {
      this.persistSettings(row, next);
      if (rankPermission(next.permissionLevel) > rankPermission(prior.permissionLevel)) {
        // Only consents given below the new level need renewing; an owner who already allowed it keeps sharing.
        const below = TeamPermissionLevelSchema.options.filter((level) => rankPermission(level) < rankPermission(next.permissionLevel));
        if (below.length) {
          this.hostRows.prepare(`UPDATE mingle_team_host_consents SET state='needs-reconsent',updated_at=? WHERE team_id=? AND shared_project_id=? AND state='granted'
            AND permission_level IN (${below.map(() => '?').join(',')})`)
            .run(next.updatedAt, context.project.teamId, context.project.sharedProjectId, ...below);
        }
      }
      if (group) this.syncTeamRoster(context, row.group_id, next);
      else this.syncSessions(context, next);
    });
    await this.broadcastStructure(context, this.readHost(context.project.teamId, context.project.sharedProjectId)!);
    return this.structureSnapshot(projectId);
  }

  async change(projectId: string, rawInput: unknown): Promise<TeamStructureSnapshot> {
    const context = await this.context(projectId);
    return this.mutations.run(this.mutationKey(context), () => this.changeLocked(projectId, rawInput));
  }

  private async changeLocked(projectId: string, rawInput: unknown): Promise<TeamStructureSnapshot> {
    const change = TeamStructureChangeSchema.parse(rawInput);
    const context = await this.requireEditor(projectId);
    const { teamId, sharedProjectId } = context.project;
    const row = this.readHost(teamId, sharedProjectId);
    if (!row) throw new HttpError(404, 'Team orchestration is not enabled for this project.');
    const prior = this.settings(row);
    if (change.expectedVersion !== prior.version) throw new HttpError(409, 'Team structure changed. Refresh and try again.');
    const group = this.groupOrNull(row.group_id);
    if (!group) throw new HttpError(409, 'Add a teammate agent to a session before changing team structure.');
    if (group.deliveries.some((delivery) => delivery.status === 'running')) {
      throw new HttpError(409, 'Wait for active team deliveries before changing agent roles or membership.');
    }
    const agentById = new Map(context.agents.map((agent) => [agent.id, agent]));
    const currentRows = this.hostRows.prepare(`SELECT agent_id,handle,role FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND removed_at IS NULL`)
      .all(teamId, sharedProjectId) as Array<{ agent_id: string; handle: string; role: TeamAgentRole }>;
    const current = new Map(currentRows.map((agent) => [agent.agent_id, agent]));
    const at = new Date(this.now()).toISOString();
    const history = this.history(row);
    let next = prior;
    let needsLeader = row.needs_leader === 1;
    let leaderReason: TeamLeaderChange['reason'] | null = null;
    const rosterChanges: Array<{ agentId: string; role?: TeamAgentRole; removed?: boolean }> = [];
    if (change.action === 'set-orchestrator') {
      const agent = agentById.get(change.agentId);
      if (!agent || !agent.sessionId || !current.has(change.agentId)) throw new HttpError(400, 'Choose an active team roster agent.');
      if (agent.deviceId !== context.localDeviceId && this.consentFor(context, agent.id) !== 'granted') throw new HttpError(409, 'This agent has not granted current team consent.');
      const from = prior.orchestratorAgentId;
      if (from && from !== agent.id) rosterChanges.push({ agentId: from, role: change.previousRole });
      rosterChanges.push({ agentId: agent.id, role: 'orchestrator' });
      next = { ...prior, orchestratorAgentId: agent.id, fallbackAgentIds: prior.fallbackAgentIds.filter((id) => id !== agent.id),
        version: prior.version + 1, updatedAt: at, updatedByAccountId: context.accountId };
      needsLeader = false;
      leaderReason = 'manual';
    } else if (change.action === 'set-role') {
      const entry = current.get(change.agentId);
      if (!entry) throw new HttpError(404, 'Agent is not in the active team structure.');
      if (change.agentId === prior.orchestratorAgentId) throw new HttpError(409, 'Choose a new orchestrator before changing the current leader role.');
      rosterChanges.push({ agentId: change.agentId, role: change.role });
      next = { ...prior, fallbackAgentIds: change.role === 'idle' ? prior.fallbackAgentIds.filter((id) => id !== change.agentId) : prior.fallbackAgentIds,
        version: prior.version + 1, updatedAt: at, updatedByAccountId: context.accountId };
    } else if (change.action === 'set-fallbacks') {
      if (new Set(change.agentIds).size !== change.agentIds.length || change.agentIds.some((id) => !current.has(id) || id === prior.orchestratorAgentId || current.get(id)?.role === 'idle')) {
        throw new HttpError(400, 'Fallbacks must be unique active agents other than the orchestrator.');
      }
      next = { ...prior, fallbackAgentIds: change.agentIds, version: prior.version + 1, updatedAt: at, updatedByAccountId: context.accountId };
    } else {
      const entry = current.get(change.agentId);
      if (!entry) throw new HttpError(404, 'Agent is not in the active team structure.');
      if (change.agentId === prior.orchestratorAgentId) {
        next = { ...prior, orchestratorAgentId: null, version: prior.version + 1, updatedAt: at, updatedByAccountId: context.accountId };
        needsLeader = true;
        leaderReason = 'removed';
      } else next = { ...prior, version: prior.version + 1, updatedAt: at, updatedByAccountId: context.accountId };
      rosterChanges.push({ agentId: change.agentId, removed: true });
      next = { ...next, fallbackAgentIds: next.fallbackAgentIds.filter((id) => id !== change.agentId) };
    }
    if (leaderReason) {
      history.push({ id: `leader_${randomUUID().replaceAll('-', '')}`, at, fromAgentId: prior.orchestratorAgentId, toAgentId: next.orchestratorAgentId,
        reason: leaderReason, byAccountId: context.accountId });
      if (history.length > 50) history.splice(0, history.length - 50);
    }
    const selected = next.orchestratorAgentId ? context.agents.find((agent) => agent.id === next.orchestratorAgentId) : undefined;
    this.options.store.tx(() => {
      const latest = this.readHost(teamId, sharedProjectId);
      if (!latest || this.settings(latest).version !== prior.version) throw new HttpError(409, 'Team structure changed. Refresh and try again.');
      for (const change of rosterChanges) {
        if (change.removed) {
          this.hostRows.prepare(`UPDATE mingle_team_host_roster SET removed_at=?,updated_at=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
            .run(at, at, teamId, sharedProjectId, change.agentId);
        } else if (change.role) {
          this.hostRows.prepare(`UPDATE mingle_team_host_roster SET role=?,removed_at=NULL,updated_at=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
            .run(change.role, at, teamId, sharedProjectId, change.agentId);
        }
      }
      const changed = this.hostRows.prepare(`UPDATE mingle_team_host_projects SET settings_json=?,leader_history_json=?,needs_leader=?,updated_at=?
        WHERE team_id=? AND shared_project_id=? AND settings_json=?`)
        .run(JSON.stringify(next), JSON.stringify(history), Number(needsLeader), at, teamId, sharedProjectId, row.settings_json);
      if (Number(changed.changes) !== 1) throw new HttpError(409, 'Team structure changed. Refresh and try again.');
      const members = this.syncTeamRoster(context, row.group_id, next);
      const selectedSession = selected ? members.find((entry) => entry.handle === this.handleFor(teamId, sharedProjectId, selected.id))?.sessionId ?? null : null;
      if (change.action === 'set-orchestrator') this.options.groups.setTeamLeader(row.group_id, selectedSession, { paused: false, pauseReason: null });
      else if (leaderReason) this.options.groups.setTeamLeader(row.group_id, null, { paused: true, pauseReason: 'The team orchestrator was removed. Choose a new leader.' });
      else if (needsLeader) this.options.groups.pauseTeamGroup(row.group_id, 'No team leader is available. Choose a new orchestrator in Team structure.');
    });
    await this.broadcastStructure(context, this.readHost(teamId, sharedProjectId)!);
    return this.structureSnapshot(projectId);
  }

  private handleFor(teamId: string, sharedProjectId: string, agentId: string): string | undefined {
    const row = this.hostRows.prepare(`SELECT handle FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND agent_id=? AND removed_at IS NULL`)
      .get(teamId, sharedProjectId, agentId) as { handle?: string } | undefined;
    return row?.handle;
  }

  private persistSettings(row: HostRow, settings: TeamOrchestrationSettings, needsLeader = row.needs_leader === 1): void {
    const latest = this.readHost(row.team_id, row.shared_project_id);
    if (!latest || this.settings(latest).version !== this.settings(row).version) throw new HttpError(409, 'Team orchestration settings changed. Refresh and try again.');
    const changed = this.hostRows.prepare(`UPDATE mingle_team_host_projects SET settings_json=?,needs_leader=?,updated_at=?
      WHERE team_id=? AND shared_project_id=? AND settings_json=?`)
      .run(JSON.stringify(settings), Number(needsLeader), settings.updatedAt, row.team_id, row.shared_project_id, row.settings_json);
    if (Number(changed.changes) !== 1) throw new HttpError(409, 'Team orchestration settings changed. Refresh and try again.');
  }

  private markLowerConsentsForReconsent(context: ProjectContext, previous: TeamPermissionLevel, next: TeamOrchestrationSettings): void {
    if (rankPermission(next.permissionLevel) <= rankPermission(previous)) return;
    const lowerLevels = TeamPermissionLevelSchema.options.filter((level) => rankPermission(level) < rankPermission(next.permissionLevel));
    if (!lowerLevels.length) return;
    this.hostRows.prepare(`UPDATE mingle_team_host_consents SET state='needs-reconsent',updated_at=?
      WHERE team_id=? AND shared_project_id=? AND state='granted' AND permission_level IN (${lowerLevels.map(() => '?').join(',')})`)
      .run(next.updatedAt, context.project.teamId, context.project.sharedProjectId, ...lowerLevels);
  }

  async structure(projectId: string): Promise<TeamStructureSnapshot> {
    const context = await this.context(projectId);
    return this.mutations.run(this.mutationKey(context), async () => {
      const currentContext = await this.context(projectId);
      const row = this.readHost(currentContext.project.teamId, currentContext.project.sharedProjectId);
      const flushed = await this.flushPendingConsents(currentContext);
      if (flushed && row) await this.broadcastStructure(currentContext, row);
      return this.structureSnapshot(projectId, {}, currentContext);
    });
  }

  private async structureSnapshot(projectId: string, options: { reconcileRoster?: boolean } = {}, resolvedContext?: ProjectContext): Promise<TeamStructureSnapshot> {
    const context = resolvedContext ?? await this.context(projectId);
    const isHost = context.isHost;
    const ownRow = isHost ? this.readHost(context.project.teamId, context.project.sharedProjectId) : undefined;
    const peerPayload = !ownRow ? this.options.deviceSide?.latestStructure(context.project.sharedProjectId) ?? null : null;
    const payload = peerPayload ? StructureSchema.parse(peerPayload) : null;
    const settings = ownRow ? this.settings(ownRow) : payload?.settings ?? null;
    const row = ownRow;
    const group = row ? this.groupOrNull(row.group_id) : null;
    if (options.reconcileRoster !== false && row && settings && group && !group.deliveries.some((delivery) => delivery.status === 'running')) {
      this.options.store.tx(() => this.syncTeamRoster(context, row.group_id, settings));
    }
    const hostId = ownRow?.host_device_id ?? payload?.host?.deviceId ?? context.hostDeviceId;
    const hostAccountId = ownRow?.owner_account_id ?? payload?.host?.accountId ?? context.hostAccountId;
    const hostDevice = this.options.transport.snapshot(context.project.teamId).devices.find((device) => device.id === hostId);
    const payloadMembers = new Map(payload?.members.map((member) => [member.agentId, member]) ?? []);
    const rows = row ? this.hostRows.prepare(`SELECT agent_id,handle,role,fallback_rank FROM mingle_team_host_roster
      WHERE team_id=? AND shared_project_id=? AND removed_at IS NULL`).all(context.project.teamId, context.project.sharedProjectId) as Array<{ agent_id: string; handle: string; role: TeamAgentRole; fallback_rank: number | null }>
      : [];
    const roleRows = new Map(rows.map((member) => [member.agent_id, member]));
    const members: TeamStructureMember[] = [];
    const localDeviceId = this.options.transport.snapshot(context.project.teamId).deviceId;
    for (const agent of context.agents) {
      if (!agent.sessionId) continue;
      const provider = ProviderSchema.safeParse(agent.provider);
      if (!provider.success) continue;
      // A structure sent before the host migrated to canonical ids names the host's agents by session id.
      const info = roleRows.get(agent.id) ?? payloadMembers.get(agent.id) ?? payloadMembers.get(agent.sessionId);
      if (row && !info) continue;
      const handle = info?.handle ?? `${agent.provider ?? 'agent'}${members.length + 1}`.slice(0, 32);
      const sessionId = agent.deviceId === localDeviceId ? agent.sessionId : row
        ? (this.hostRows.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE team_id=? AND shared_project_id=? AND agent_id=?')
          .get(context.project.teamId, context.project.sharedProjectId, agent.id) as { session_id?: string } | undefined)?.session_id ?? null : null;
      const session = sessionId ? this.options.store.getSession(sessionId, true) : undefined;
      const consent = row ? this.consentFor(context, agent.id) : agent.deviceId === localDeviceId
        ? this.options.deviceSide?.localConsent(context.project.sharedProjectId)?.state ?? 'granted'
        : info && 'consent' in info && info.consent ? info.consent : 'needs-reconsent';
      const groupMember = group?.members.find((member) => member.sessionId === sessionId);
      const delivery = group?.deliveries.filter((item) => item.memberId === groupMember?.id && liveDelivery(item.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const proxyDeliveryState = row && delivery ? (this.hostRows.prepare('SELECT status FROM mingle_team_host_deliveries WHERE delivery_id=?')
        .get(delivery.id) as { status?: string } | undefined)?.status : undefined;
      const currentTask = delivery ? this.taskTitleForDelivery(group!, delivery.id) : null;
      const device = this.options.transport.snapshot(context.project.teamId).devices.find((candidate) => candidate.id === agent.deviceId);
      const owner = context.members.find((candidate) => candidate.accountId === agent.accountId);
      const failure = delivery?.failure ? ProviderFailureSchema.safeParse(delivery.failure).data ?? null
        : sessionId ? this.options.store.latestProviderFailure(sessionId) : null;
      let state: TeamAgentState = payloadMembers.get(agent.id)?.state ?? 'idle';
      if (row) {
        state = consent !== 'granted' ? consent === 'paused' || consent === 'revoked' ? 'paused' : 'paused'
          : failure?.kind === 'quota_exhausted' ? 'quota-exhausted'
          : (agent.deviceId !== localDeviceId && (!device || device.status !== 'online'))
            || (session?.status === 'error' && /timed out/i.test(session.error ?? '')) ? 'offline'
          : proxyDeliveryState === 'awaiting-approval' ? 'awaiting-approval'
          : session?.status === 'waiting' ? 'awaiting-approval'
          : delivery && (delivery.status === 'running' || proxyDeliveryState === 'accepted' || proxyDeliveryState === 'running') ? 'working'
          : delivery?.status === 'queued' ? 'queued'
          : groupMember?.held || session?.status === 'interrupted' ? 'paused'
          : session?.status === 'error' ? 'failed' : 'idle';
      }
      const rosterRole = info?.role ?? (agent.id === settings?.orchestratorAgentId ? 'orchestrator' : 'worker');
      const storedRank = info ? ('fallbackRank' in info ? info.fallbackRank : 'fallback_rank' in info ? info.fallback_rank : null) : null;
      const fallbackRank = storedRank ?? (settings ? (((settings.fallbackAgentIds.indexOf(agent.id) + 1) || null)) : null);
      members.push({
        agentId: agent.id, name: agent.name, handle, ownerAccountId: agent.accountId, ownerDisplayName: owner?.displayName ?? 'Teammate',
        deviceId: agent.deviceId, deviceName: device?.name ?? 'Unknown device', local: agent.deviceId === localDeviceId, sessionId: agent.deviceId === localDeviceId ? agent.sessionId : null,
        provider: provider.data, model: agent.model ?? session?.model ?? 'unknown',
        effort: session?.effort ?? null, role: rosterRole, fallbackRank,
        state, consent: consent as TeamConsentState, currentTask, lastActivityAt: session?.updatedAt ?? null, failure,
      });
    }
    const myConsent = this.options.deviceSide?.localConsent(context.project.sharedProjectId) ?? null;
    const leaderHistory = row ? this.history(row) : payload?.leaderHistory ?? [];
    const teamSession = row && group
      ? { groupId: group.group.id, sessionId: group.group.anchorSessionId, title: group.group.title } satisfies TeamSessionRef
      : row ? null : payload?.teamSession ?? null;
    return {
      projectId: context.localProjectId, teamId: context.project.teamId, sharedProjectId: context.project.sharedProjectId,
      enabled: Boolean(settings), settings, host: { deviceId: hostId, accountId: hostAccountId, displayName: ownRow ? context.hostDisplayName : payload?.host?.displayName ?? context.hostDisplayName,
        online: Boolean(hostDevice && hostDevice.status === 'online'), isThisDevice: hostId === localDeviceId },
      canEdit: Boolean(isHost && context.members.some((member) => member.accountId === context.accountId && ['leader', 'admin'].includes(member.role))),
      myConsent, members, leaderHistory, needsLeader: row ? row.needs_leader === 1 : payload?.needsLeader ?? false,
      teamSession,
      observedAt: new Date(this.now()).toISOString(),
    };
  }

  private taskTitleForDelivery(group: import('@mingle/contracts').GroupSnapshot, deliveryId: string): string | null {
    const assignment = group.assignments.find((candidate) => candidate.deliveryId === deliveryId);
    if (!assignment) return null;
    return this.options.store.getTask(assignment.taskId)?.title ?? null;
  }

  private async broadcastStructure(context: ProjectContext, row: HostRow, options: { reconcileRoster?: boolean } = {}): Promise<void> {
    const structure = await this.structureSnapshot(context.localProjectId, options, context);
    const payload = StructureSchema.parse({
      sharedProjectId: context.project.sharedProjectId, settings: this.settings(row),
      host: { deviceId: row.host_device_id, accountId: row.owner_account_id, displayName: context.hostDisplayName },
      members: structure.members.map((member) => ({ agentId: member.agentId, handle: member.handle, role: member.role, fallbackRank: member.fallbackRank,
        ownerAccountId: member.ownerAccountId, deviceId: member.deviceId, state: member.state, currentTask: member.currentTask, consent: member.consent })),
      leaderHistory: structure.leaderHistory, needsLeader: structure.needsLeader, teamSession: structure.teamSession ?? null,
    });
    const transport = this.options.transport.snapshot(context.project.teamId);
    const structureDigest = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
    const linked = transport.links.filter((link) => link.deviceId === transport.deviceId && link.mutual).map((link) => link.peerDeviceId);
    for (const deviceId of [...new Set(linked)]) {
      if (transport.devices.find((device) => device.id === deviceId)?.status === 'revoked') continue;
      try {
        // transport.send performs the authenticated cloud write; cloud RLS remains authoritative
        // for active membership/device links without a separate auth.getUser() round trip here.
        await this.options.transport.send({ teamId: context.project.teamId, toDeviceId: deviceId, kind: 'teamgroup.structure', payload,
          idempotencyKey: `teamgroup-structure:${context.project.sharedProjectId}:${payload.settings.version}:${structureDigest}:${deviceId}`.slice(0, 200) });
      } catch { /* structure remains saved locally and will be broadcast on the next change */ }
    }
    this.options.store.recordEvent({ projectId: context.localProjectId, type: 'team.structure.updated', summary: 'Shared team structure updated',
      payload: { teamSession: payload.teamSession, settingsVersion: payload.settings.version } });
    void this.options.transport.sync().catch(() => undefined);
  }

  isProxySession(sessionId: string): boolean {
    return Boolean(this.hostRows.prepare('SELECT 1 AS found FROM mingle_team_proxy_sessions WHERE session_id=?').get(sessionId));
  }

  isActive(sessionId: string): boolean { return this.active.has(sessionId); }
  isRunLive(sessionId: string, runId: string): boolean {
    const active = this.active.get(sessionId);
    return Boolean(active && active.runId === runId && !active.controller.signal.aborted);
  }
  activeCount(): number { return this.active.size; }

  private proxy(sessionId: string): ProxyRow | undefined {
    return this.hostRows.prepare('SELECT * FROM mingle_team_proxy_sessions WHERE session_id=?').get(sessionId) as ProxyRow | undefined;
  }

  start(input: TeamProxyStartInput): void {
    if (this.closed) throw new HttpError(503, 'Team orchestration is closing.');
    const proxy = this.proxy(input.session.id);
    if (!proxy) throw new HttpError(409, 'The proxy session is no longer in the shared roster.');
    if (this.active.has(input.session.id)) throw new HttpError(409, 'This remote team agent already has active work.');
    const host = this.readHost(proxy.team_id, proxy.shared_project_id);
    if (!host) throw new HttpError(409, 'Team orchestration is no longer enabled.');
    const settings = this.settings(host);
    const consent = this.hostRows.prepare(`SELECT state,permission_level,disclaimer_version,owner_account_id,owner_device_id
      FROM mingle_team_host_consents WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
      .get(proxy.team_id, proxy.shared_project_id, proxy.agent_id) as Row | undefined;
    const currentConsent = consent && consent.state === 'granted' && TeamPermissionLevelSchema.safeParse(consent.permission_level).success
      && rankPermission(TeamPermissionLevelSchema.parse(consent.permission_level)) >= rankPermission(settings.permissionLevel)
      && consent.disclaimer_version === TEAM_CONSENT_DISCLAIMER_VERSION
      && String(consent.owner_account_id) === proxy.owner_account_id
      && String(consent.owner_device_id) === proxy.owner_device_id;
    if (!currentConsent) throw new HttpError(403, 'The remote agent has not granted current consent.');
    if (!this.isOnline(proxy.team_id, proxy.owner_device_id)) throw new HttpError(503, 'The remote agent device is offline.');
    const context = input.context;
    if (!context) throw new HttpError(409, 'Remote team work must belong to a live group delivery.');
    const group = this.options.groups.get(context.groupId);
    const member = group.members.find((candidate) => candidate.id === context.memberId && candidate.sessionId === input.session.id);
    const delivery = group.deliveries.find((candidate) => candidate.id === context.deliveryId && candidate.status === 'running');
    if (!member || !delivery || delivery.requestId !== context.requestId) throw new HttpError(409, 'The group delivery is no longer active.');
    // Assignment scope is host-owned structured state. The same delivery ID is required to avoid
    // accidentally lending another worker's scope to this run; never derive it from model prose.
    const assignment = group.assignments.find((candidate) => candidate.deliveryId === context.deliveryId);
    const groupWorkspace = this.groupWorkspace(context.groupId);
    const enabledRole = member.role === 'orchestrator' ? 'orchestrator' : 'worker';
    const basePayload = DeliverySchema.parse({
      sharedProjectId: proxy.shared_project_id, deliveryId: context.deliveryId, groupId: context.groupId,
      requestId: context.requestId, agentId: proxy.agent_id, role: enabledRole,
      kind: delivery.kind ?? 'request', content: input.content.slice(0, 100_000), hop: context.hop,
      permissionLevel: settings.permissionLevel, settingsVersion: settings.version,
      ...((assignment?.taskId ?? input.options.taskId) ? { taskId: assignment?.taskId ?? input.options.taskId } : {}),
      ...(assignment?.scope.length ? { scope: assignment.scope } : {}), inputArtifacts: [], integrationDeviceId: host.host_device_id,
      issuedAt: new Date(this.now()).toISOString(),
    });
    const controller = new AbortController();
    const mcp = this.options.teamMcp.create(input.runId, input.session, controller.signal, context);
    this.active.set(input.session.id, { runId: input.runId, controller });
    const issuedAt = this.now();
    const at = new Date(issuedAt).toISOString();
    const sourceChatId = this.chatByDelivery.get(context.deliveryId) ?? null;
    this.hostRows.prepare(`INSERT INTO mingle_team_host_deliveries(delivery_id,team_id,shared_project_id,group_id,request_id,agent_id,session_id,
      owner_account_id,owner_device_id,run_id,remote_run_id,status,content,source_chat_message_id,artifacts_json,failure_json,issued_at,timeout_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,NULL,'accepted',?,?, '[]',NULL,?,?,?)`)
      .run(context.deliveryId, proxy.team_id, proxy.shared_project_id, context.groupId, context.requestId, proxy.agent_id, input.session.id,
        proxy.owner_account_id, proxy.owner_device_id, input.runId, basePayload.content, sourceChatId, at,
        this.deliveryDeadline(issuedAt, issuedAt), at);
    this.armDeliveryTimeout(context.deliveryId);
    this.track((async () => {
      try {
        let baseRevision: string | undefined;
        try {
          const head = (await git(groupWorkspace?.worktreePath ?? input.session.worktreePath, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
          if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head)) baseRevision = head;
        } catch { /* A delivery can proceed without a transfer base when Git state is unavailable. */ }
        const trustedScope = assignment?.scope.length ? normalizeScopes(assignment.scope) : null;
        const trustedTaskId = assignment?.taskId ?? basePayload.taskId ?? null;
        this.hostRows.prepare(`INSERT INTO mingle_team_host_artifact_authority(delivery_id,team_id,shared_project_id,group_id,session_id,
          run_id,agent_id,owner_account_id,owner_device_id,task_id,scope_json,base_revision,kind,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(delivery_id) DO UPDATE SET team_id=excluded.team_id,
            shared_project_id=excluded.shared_project_id,group_id=excluded.group_id,session_id=excluded.session_id,run_id=excluded.run_id,
            agent_id=excluded.agent_id,owner_account_id=excluded.owner_account_id,owner_device_id=excluded.owner_device_id,
            task_id=excluded.task_id,scope_json=excluded.scope_json,base_revision=excluded.base_revision,kind=excluded.kind,created_at=excluded.created_at`)
          .run(context.deliveryId, proxy.team_id, proxy.shared_project_id, context.groupId, input.session.id, input.runId, proxy.agent_id,
            proxy.owner_account_id, proxy.owner_device_id, trustedTaskId, JSON.stringify(trustedScope), baseRevision ?? null, basePayload.kind, at);
        const inputArtifacts = await this.exportHandoffArtifacts(input.consumedHandoffs ?? [], input.session.projectId,
          proxy.team_id, proxy.shared_project_id, context.deliveryId, proxy.owner_device_id, input.options.taskId);
        const artifactContext = inputArtifacts.length
          ? `\n\nCommitted input artifacts transferred to this owner device:\n${inputArtifacts.map((artifact) =>
            `- ${artifact.path ? safeArtifactText(artifact.path, 120) : 'committed artifact'} @ ${artifact.revision}${artifact.taskId ? ` (task ${safeArtifactText(artifact.taskId, 80)})` : ''}\n  Git ref: ${safeArtifactText(artifact.ref ?? '', 255)}`,
          ).join('\n')}`.slice(0, 30_000)
          : '';
        const content = artifactContext
          ? `${basePayload.content.slice(0, Math.max(0, 100_000 - artifactContext.length))}${artifactContext}`
          : basePayload.content;
        const payload = DeliverySchema.parse({ ...basePayload, ...(baseRevision ? { baseRevision } : {}), inputArtifacts, content });
        this.hostRows.prepare('UPDATE mingle_team_host_deliveries SET content=?,updated_at=? WHERE delivery_id=?')
          .run(payload.content, new Date(this.now()).toISOString(), context.deliveryId);
        // The destination validates current host role, consent and settings before execution;
        // transport.send's cloud RLS gates mailbox insertion without a duplicate auth lookup here.
        await this.options.transport.send({ teamId: proxy.team_id, toDeviceId: proxy.owner_device_id, kind: 'teamgroup.delivery', payload,
          idempotencyKey: `teamgroup-delivery:${context.deliveryId}:${input.runId}`.slice(0, 200) });
        void this.options.transport.sync().catch(() => undefined);
      } catch (error) {
        await this.finishDelivery(context.deliveryId, 'failed', undefined, `Could not dispatch remote team work: ${error instanceof Error ? error.message : 'transport error'}`);
      }
    })());
    void mcp;
  }

  private async exportHandoffArtifacts(handoffIds: string[], projectId: string, teamId: string, sharedProjectId: string,
    deliveryId: string, toDeviceId: string, taskId?: string): Promise<import('@mingle/contracts').TeamArtifactRef[]> {
    const ids = [...new Set(handoffIds)];
    if (!ids.length) return [];
    if (ids.length > 30 || ids.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 200)) {
      throw new HttpError(409, 'A team delivery may carry at most 30 verified Git handoff inputs.');
    }
    if (!this.options.git) throw new HttpError(409, 'Committed handoff inputs cannot be sent because team Git artifact transfer is unavailable.');
    const wanted = new Set(ids);
    const metadata = new Map<string, { fromSessionId: string; path: string; revision: string; taskId?: string }>();
    const rows = this.hostRows.prepare(`SELECT payload FROM events WHERE type='handoff.created' ORDER BY id DESC LIMIT 2_000`).all() as Array<{ payload: string }>;
    for (const row of rows) {
      let value: Record<string, unknown>;
      try { value = JSON.parse(row.payload) as Record<string, unknown>; } catch { continue; }
      if (typeof value.messageId !== 'string' || !wanted.has(value.messageId) || typeof value.fromSessionId !== 'string'
        || typeof value.path !== 'string' || typeof value.revision !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value.revision)) continue;
      metadata.set(value.messageId, { fromSessionId: value.fromSessionId, path: value.path, revision: value.revision,
        ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}) });
      wanted.delete(value.messageId);
    }
    if (wanted.size) throw new HttpError(409, 'A committed handoff input is no longer available as a verified Git revision.');
    const artifacts: import('@mingle/contracts').TeamArtifactRef[] = [];
    for (const id of ids) {
      const handoff = metadata.get(id)!;
      const source = this.options.store.getSession(handoff.fromSessionId, true);
      if (!source || source.projectId !== projectId) throw new HttpError(409, 'A handoff source is outside the shared project.');
      const sessionBase = this.hostRows.prepare('SELECT base_revision FROM session_worktree_bases WHERE session_id=?')
        .get(source.id) as { base_revision: string | null } | undefined;
      const artifactTaskId = handoff.taskId ?? taskId;
      const sourceTransferId = this.importedTransferForHandoff(teamId, sharedProjectId, handoff, artifactTaskId);
      artifacts.push(await this.options.git.exportTeamArtifact({
        teamId, sharedProjectId,
        sourceWorktreePath: source.worktreePath, revision: handoff.revision, toDeviceId, deliveryId,
        ...(sessionBase?.base_revision ? { sessionStartRevision: sessionBase.base_revision } : {}),
        ...(artifactTaskId ? { taskId: artifactTaskId } : {}), path: handoff.path, purpose: 'input', ...(sourceTransferId ? { sourceTransferId } : {}),
      }));
    }
    return artifacts;
  }

  private importedTransferForHandoff(teamId: string, sharedProjectId: string,
    handoff: { path: string; revision: string; taskId?: string }, taskId?: string): string | undefined {
    let rows: Array<{ transfer_id: string; offer_json: string }>;
    try {
      rows = this.hostRows.prepare(`SELECT transfer_id,offer_json FROM mingle_git_team_artifacts
        WHERE team_id=? AND shared_project_id=? AND direction='incoming' AND status='imported' ORDER BY created_at DESC LIMIT 500`)
        .all(teamId, sharedProjectId) as Array<{ transfer_id: string; offer_json: string }>;
    } catch { return undefined; }
    for (const row of rows) {
      try {
        const offer = JSON.parse(row.offer_json) as Record<string, unknown>;
        if (offer.transferId === row.transfer_id && offer.revision === handoff.revision && offer.path === handoff.path
          && (offer.taskId ?? undefined) === taskId) return row.transfer_id;
      } catch { /* An invalid import row is not proof for forwarding a handoff. */ }
    }
    return undefined;
  }

  interrupt(sessionId: string): boolean {
    const active = this.active.get(sessionId);
    if (!active) {
      const completion = [...this.completing].find(([, current]) => current.sessionId === sessionId);
      if (!completion) return false;
      const [deliveryId, current] = completion;
      current.controller.abort();
      this.options.teamMcp.revoke(current.runId);
      void this.finishDelivery(deliveryId, 'interrupted', undefined, 'Interrupted by the host.');
      return true;
    }
    const proxy = this.proxy(sessionId);
    const delivery = this.hostRows.prepare('SELECT delivery_id FROM mingle_team_host_deliveries WHERE run_id=?').get(active.runId) as { delivery_id?: string } | undefined;
    if (!proxy || !delivery?.delivery_id) return false;
    active.controller.abort();
    this.options.teamMcp.revoke(active.runId);
    const payload = TeamInterruptPayloadSchema.parse({ sharedProjectId: proxy.shared_project_id, deliveryId: delivery.delivery_id, reason: 'Interrupted by the host.' });
    this.track(this.options.transport.send({ teamId: proxy.team_id, toDeviceId: proxy.owner_device_id, kind: 'teamgroup.interrupt', payload,
      idempotencyKey: `teamgroup-interrupt:${delivery.delivery_id}`.slice(0, 200) }).then(() => this.options.transport.sync()));
    void this.finishDelivery(delivery.delivery_id, 'interrupted', undefined, 'Interrupted by the host.');
    return true;
  }

  async authorizeApprovalDecision(approvalId: string): Promise<void> {
    const approval = this.hostRows.prepare(`SELECT delivery_id FROM mingle_team_host_approvals WHERE approval_id=? AND state='pending'`)
      .get(approvalId) as { delivery_id: string } | undefined;
    if (!approval) return;
    const delivery = this.delivery(approval.delivery_id);
    if (!delivery || !liveDelivery(delivery.status)) throw new HttpError(409, 'Approval is stale because its remote delivery is no longer active.');
    const session = this.options.store.getSession(delivery.session_id, true);
    if (!session) throw new HttpError(409, 'The mirrored approval session is no longer available.');
    const context = await this.context(session.projectId);
    const member = context.members.find((candidate) => candidate.accountId === context.accountId);
    if (!context.isHost || !member || !['leader', 'admin'].includes(member.role)) {
      throw new HttpError(403, 'Only a team lead or admin on the host device can resolve a mirrored team approval.');
    }
    const currentApproval = this.hostRows.prepare(`SELECT delivery_id FROM mingle_team_host_approvals WHERE approval_id=? AND state='pending'`)
      .get(approvalId) as { delivery_id: string } | undefined;
    const currentDelivery = currentApproval ? this.delivery(currentApproval.delivery_id) : undefined;
    if (!currentApproval || currentApproval.delivery_id !== approval.delivery_id || !currentDelivery || !liveDelivery(currentDelivery.status)) {
      throw new HttpError(409, 'Approval is stale because its remote delivery is no longer active.');
    }
  }

  decideApproval(approvalId: string, decision: 'approved' | 'denied'): import('@mingle/contracts').Approval | null {
    const row = this.hostRows.prepare(`SELECT * FROM mingle_team_host_approvals WHERE approval_id=? AND state='pending'`).get(approvalId) as Row | undefined;
    if (!row) return null;
    const delivery = this.hostRows.prepare('SELECT * FROM mingle_team_host_deliveries WHERE delivery_id=?').get(String(row.delivery_id)) as DeliveryRow | undefined;
    if (!delivery || !liveDelivery(delivery.status)) throw new HttpError(409, 'Approval is stale because its remote delivery is no longer active.');
    const approval = this.options.store.resolveApproval(approvalId, decision, 'host');
    this.hostRows.prepare('UPDATE mingle_team_host_approvals SET state=? WHERE approval_id=?').run(decision, approvalId);
    const payload = TeamApprovalDecisionPayloadSchema.parse({ sharedProjectId: delivery.shared_project_id, deliveryId: delivery.delivery_id,
      approvalId: row.remote_approval_id, decision });
    this.track(this.options.transport.send({ teamId: delivery.team_id, toDeviceId: delivery.owner_device_id, kind: 'teamgroup.approval.decision', payload,
      idempotencyKey: `teamgroup-approval-decision:${delivery.delivery_id}:${row.remote_approval_id}`.slice(0, 200) }).then(() => this.options.transport.sync()));
    this.options.store.updateSession(delivery.session_id, { status: 'running' });
    this.options.store.recordEvent({ projectId: this.options.store.getSession(delivery.session_id, true)?.projectId ?? null, sessionId: delivery.session_id,
      type: 'approval.resolved', summary: `Remote approval ${decision}`, payload: { approvalId, decision } });
    return approval;
  }

  private async onEnvelope(envelope: import('@mingle/contracts').AuthenticatedTransportMessage): Promise<void> {
    // Other teamgroup.* kinds belong to the owner-device side sharing this transport.
    const hostKinds = ['execution.agents', 'teamgroup.consent', 'teamgroup.delivery.status', 'teamgroup.delivery.heartbeat',
      'teamgroup.activity', 'teamgroup.tool.call', 'teamgroup.approval.request'];
    if (this.closed || !hostKinds.includes(envelope.kind)) return;
    const localDevice = this.options.transport.snapshot(envelope.teamId).deviceId;
    if (!localDevice || envelope.toDeviceId !== localDevice) throw new HttpError(403, 'Team orchestration envelope is not addressed to this device.');
    if (envelope.kind === 'execution.agents') return this.onPublishedAgents(envelope);
    if (envelope.kind === 'teamgroup.consent') return this.receiveConsent(envelope);
    if (envelope.kind === 'teamgroup.delivery.status') return this.receiveStatus(envelope);
    if (envelope.kind === 'teamgroup.delivery.heartbeat') return this.receiveHeartbeat(envelope);
    if (envelope.kind === 'teamgroup.activity') return this.receiveActivity(envelope.payload, envelope);
    if (envelope.kind === 'teamgroup.tool.call') return this.receiveToolCall(envelope);
    if (envelope.kind === 'teamgroup.approval.request') return this.receiveApproval(envelope);
  }

  private async onPublishedAgents(envelope: import('@mingle/contracts').AuthenticatedTransportMessage): Promise<void> {
    const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload as Record<string, unknown> : null;
    const agents = Array.isArray(payload?.agents) ? payload.agents : [];
    const firstAgent = agents.find((agent) => agent && typeof agent === 'object') as Record<string, unknown> | undefined;
    const sharedProjectId = typeof payload?.sharedProjectId === 'string' ? payload.sharedProjectId
      : typeof firstAgent?.sharedProjectId === 'string' ? firstAgent.sharedProjectId : null;
    if (!sharedProjectId) return;
    const hostRow = this.readHost(envelope.teamId, sharedProjectId);
    const source = hostRow ? undefined : this.hostRows.prepare(`SELECT local_project_id,leader_device_id FROM mingle_project_collaboration_sources
      WHERE team_id=? AND shared_project_id=?`).get(envelope.teamId, sharedProjectId) as { local_project_id: string; leader_device_id: string | null } | undefined;
    const localProjectId = hostRow?.local_project_id ?? source?.local_project_id;
    const hostDeviceId = hostRow?.host_device_id ?? source?.leader_device_id;
    if (!localProjectId || hostDeviceId !== envelope.toDeviceId) return;
    await this.mutations.run(`${envelope.teamId}\0${sharedProjectId}`, async () => {
      const current = this.readHost(envelope.teamId, sharedProjectId);
      const currentSource = current ? undefined : this.hostRows.prepare(`SELECT local_project_id,leader_device_id FROM mingle_project_collaboration_sources
        WHERE team_id=? AND shared_project_id=?`).get(envelope.teamId, sharedProjectId) as { local_project_id: string; leader_device_id: string | null } | undefined;
      const projectId = current?.local_project_id ?? currentSource?.local_project_id;
      const hostId = current?.host_device_id ?? currentSource?.leader_device_id;
      if (!projectId || hostId !== envelope.toDeviceId) return;
      const context = await this.context(projectId);
      if (!context.isHost || context.project.sharedProjectId !== sharedProjectId || context.project.teamId !== envelope.teamId) return;
      const sender = this.options.transport.snapshot(envelope.teamId).devices.find((device) => device.id === envelope.fromDeviceId && !device.revokedAt);
      if (!sender || !context.members.some((member) => member.accountId === sender.ownerId)) return;
      if (agents.some((agent) => !agent || typeof agent !== 'object'
        || (agent as Record<string, unknown>).sharedProjectId !== sharedProjectId
        || (agent as Record<string, unknown>).deviceId !== envelope.fromDeviceId)) return;
      const watermark = this.hostRows.prepare(`SELECT version,generated_at FROM mingle_remote_roster_versions
        WHERE team_id=? AND shared_project_id=? AND owner_id=? AND device_id=? AND direction='incoming'`)
        .get(envelope.teamId, sharedProjectId, sender.ownerId, envelope.fromDeviceId) as { version: number | null; generated_at: string } | undefined;
      const version = payload?.version;
      if (version !== undefined) {
        if (!Number.isSafeInteger(version) || Number(version) < 1 || !watermark || Number(watermark.version) !== Number(version)) return;
      } else {
        const generatedAt = typeof payload?.generatedAt === 'string' ? payload.generatedAt
          : agents.map((agent) => agent && typeof agent === 'object' ? (agent as Record<string, unknown>).publishedAt : null)
            .filter((value): value is string => typeof value === 'string').sort().at(-1);
        if (!watermark || !generatedAt || Date.parse(generatedAt) !== Date.parse(watermark.generated_at)) return;
      }
      const flushed = await this.flushPendingConsents(context);
      if (current) await this.broadcastStructure(context, current);
      else {
        this.options.store.recordEvent({ projectId, type: 'team.structure.updated', summary: 'Shared team roster updated',
          payload: { sharedProjectId, rosterVersion: version ?? null, agentCount: agents.length, consentReconciled: flushed } });
      }
    });
  }

  private async verifyOwnerDevice(teamId: string, deviceId: string, accountId: string): Promise<void> {
    // Consent and activity envelopes claim an owner identity; verify it against current cloud membership/device state.
    await this.options.authorizeTeam({ teamId, peerDeviceId: deviceId });
    await this.options.account.withAuthenticatedClient(async (client, _user) => {
      const device = await client.from('mingle_devices').select('id,owner_id,revoked_at').eq('team_id', teamId).eq('id', deviceId).maybeSingle();
      const owner = await client.from('mingle_members').select('user_id').eq('team_id', teamId).eq('user_id', accountId).is('revoked_at', null).maybeSingle();
      if (device.error || owner.error || !device.data || device.data.revoked_at || String(device.data.owner_id) !== accountId || !owner.data) {
        throw new HttpError(403, 'The team message sender is not the active device for the claimed account.');
      }
    });
  }

  private async receiveConsent(envelope: import('@mingle/contracts').AuthenticatedTransportMessage): Promise<void> {
    const parsed = TeamConsentPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) throw new HttpError(400, 'Team consent payload is invalid.');
    const project = this.hostRows.prepare('SELECT * FROM mingle_team_host_projects WHERE team_id=? AND shared_project_id=?')
      .get(envelope.teamId, parsed.data.sharedProjectId) as HostRow | undefined;
    const source = project ? undefined : this.hostRows.prepare(`SELECT local_project_id,leader_device_id FROM mingle_project_collaboration_sources
      WHERE team_id=? AND shared_project_id=?`).get(envelope.teamId, parsed.data.sharedProjectId) as { local_project_id: string; leader_device_id: string | null } | undefined;
    if (project ? project.host_device_id !== envelope.toDeviceId : !source || source.leader_device_id !== envelope.toDeviceId) {
      throw new HttpError(403, 'Consent is outside this host project.');
    }
    return this.mutations.run(`${envelope.teamId}\0${parsed.data.sharedProjectId}`,
      () => this.receiveConsentLocked(envelope, parsed.data.sharedProjectId));
  }

  private async receiveConsentLocked(envelope: import('@mingle/contracts').AuthenticatedTransportMessage, sharedProjectId: string,
    broadcast = true): Promise<void> {
    const parsed = TeamConsentPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success || parsed.data.sharedProjectId !== sharedProjectId) throw new HttpError(400, 'Team consent payload is invalid.');
    const project = this.readHost(envelope.teamId, sharedProjectId);
    const source = project ? undefined : this.hostRows.prepare(`SELECT local_project_id,leader_device_id FROM mingle_project_collaboration_sources
      WHERE team_id=? AND shared_project_id=?`).get(envelope.teamId, sharedProjectId) as { local_project_id: string; leader_device_id: string | null } | undefined;
    if (project ? project.host_device_id !== envelope.toDeviceId : !source || source.leader_device_id !== envelope.toDeviceId) {
      throw new HttpError(403, 'Consent is outside this host project.');
    }
    const localProjectId = project?.local_project_id ?? source!.local_project_id;
    const collaboration = await this.options.collaboration.snapshot(localProjectId);
    const senderDevice = this.options.transport.snapshot(envelope.teamId).devices.find((device) => device.id === envelope.fromDeviceId);
    const owner = senderDevice?.ownerId;
    if (!owner) throw new HttpError(403, 'The consent sender device is not registered.');
    await this.verifyOwnerDevice(envelope.teamId, envelope.fromDeviceId, owner);
    for (const agentId of parsed.data.agentIds) {
      const agent = collaboration.agents.find((candidate) => candidate.id === agentId);
      if (agent && (agent.accountId !== owner || agent.deviceId !== envelope.fromDeviceId)) {
        throw new HttpError(403, 'Consent includes an agent published by a different owner device.');
      }
      if (!agent) {
        // The same device sends its roster and consent through independent envelopes. The
        // consent can win that race; persist it durably and apply only after the authenticated
        // roster proves that every explicitly selected agent belongs to this sender.
        const receivedAt = new Date(this.now()).toISOString();
        const expireBefore = new Date(this.now() - 7 * 24 * 60 * 60_000).toISOString();
        this.hostRows.prepare(`DELETE FROM mingle_team_host_pending_consents WHERE team_id=? AND shared_project_id=? AND received_at<?`)
          .run(envelope.teamId, sharedProjectId, expireBefore);
        const devicePending = this.hostRows.prepare(`SELECT COUNT(*) AS count FROM mingle_team_host_pending_consents
          WHERE team_id=? AND shared_project_id=? AND owner_device_id=?`).get(envelope.teamId, sharedProjectId, envelope.fromDeviceId) as { count: number };
        const projectPending = this.hostRows.prepare(`SELECT COUNT(*) AS count FROM mingle_team_host_pending_consents
          WHERE team_id=? AND shared_project_id=?`).get(envelope.teamId, sharedProjectId) as { count: number };
        if (Number(devicePending.count) >= 32 || Number(projectPending.count) >= 256) {
          throw new HttpError(503, 'The pending team consent queue is full. The owner roster is still syncing; retry after it arrives.');
        }
        this.hostRows.prepare(`INSERT OR IGNORE INTO mingle_team_host_pending_consents
          (envelope_id,team_id,shared_project_id,owner_account_id,owner_device_id,payload_json,received_at) VALUES(?,?,?,?,?,?,?)`)
          .run(envelope.id, envelope.teamId, sharedProjectId, owner, envelope.fromDeviceId, JSON.stringify(parsed.data), receivedAt);
        this.options.collaboration.invalidateSnapshot?.(localProjectId);
        this.options.store.touch();
        return;
      }
    }
    const settings = project ? this.settings(project) : null;
    const requiredPermission = settings?.permissionLevel ?? 'supervised';
    const at = parsed.data.at;
    const eligible = parsed.data.state === 'granted' && parsed.data.disclaimerVersion === TEAM_CONSENT_DISCLAIMER_VERSION
      && rankPermission(parsed.data.permissionLevel) >= rankPermission(requiredPermission) && parsed.data.agentIds.length > 0;
    let consentChanged = false;
    this.options.store.tx(() => {
      for (const agentId of parsed.data.agentIds) {
        const previousConsent = this.hostRows.prepare(`SELECT owner_account_id,owner_device_id,state,updated_at FROM mingle_team_host_consents
          WHERE team_id=? AND shared_project_id=? AND agent_id=?`).get(envelope.teamId, sharedProjectId, agentId) as {
            owner_account_id: string; owner_device_id: string; state: TeamConsentState; updated_at: string;
          } | undefined;
        const agent = collaboration.agents.find((candidate) => candidate.id === agentId && candidate.accountId === owner && candidate.deviceId === envelope.fromDeviceId);
        if (!agent) throw new HttpError(403, 'Consent includes an agent that is not published by the sender device.');
        const accepted = parsed.data.state === 'granted' && parsed.data.disclaimerVersion === TEAM_CONSENT_DISCLAIMER_VERSION
          && rankPermission(parsed.data.permissionLevel) >= rankPermission(requiredPermission);
        const state: TeamConsentState = parsed.data.state === 'granted' && !accepted ? 'needs-reconsent' : parsed.data.state;
        if (previousConsent && previousConsent.owner_account_id === owner && previousConsent.owner_device_id === envelope.fromDeviceId) {
          const previousAt = Date.parse(previousConsent.updated_at);
          const incomingAt = Date.parse(at);
          const stateRank: Record<TeamConsentState, number> = { granted: 0, 'needs-reconsent': 1, paused: 2, revoked: 3 };
          if (incomingAt < previousAt || (incomingAt === previousAt && stateRank[state] <= stateRank[previousConsent.state])) continue;
        }
        this.hostRows.prepare(`INSERT INTO mingle_team_host_consents(team_id,shared_project_id,agent_id,owner_account_id,owner_device_id,state,
          permission_level,settings_version,disclaimer_version,accepted_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(team_id,shared_project_id,agent_id) DO UPDATE SET owner_account_id=excluded.owner_account_id,owner_device_id=excluded.owner_device_id,
          state=excluded.state,permission_level=excluded.permission_level,settings_version=excluded.settings_version,disclaimer_version=excluded.disclaimer_version,
          accepted_at=excluded.accepted_at,updated_at=excluded.updated_at`)
          .run(envelope.teamId, parsed.data.sharedProjectId, agentId, owner, envelope.fromDeviceId, state, parsed.data.permissionLevel,
             parsed.data.settingsVersion, parsed.data.disclaimerVersion, at, at);
        consentChanged = true;
      }
      if (!consentChanged) return;
      const group = this.groupOrNull(project?.group_id);
      if (project && settings && group && !group.deliveries.some((delivery) => delivery.status === 'running')) {
        const syncContext: ProjectContext = { ...collaboration, project: collaboration.project!, localProjectId: project.local_project_id,
          accountId: project.owner_account_id, localDeviceId: project.host_device_id, hostDeviceId: project.host_device_id, hostAccountId: project.owner_account_id,
          hostDisplayName: 'Team lead', isHost: true };
        const members = this.syncSessions(syncContext, settings);
        this.options.groups.syncTeamRosterMembers(project.group_id, members, this.managedTeamSessionIds(syncContext));
      }
    });
    if (!consentChanged) return;
    if (!eligible) {
      const active = this.hostRows.prepare(`SELECT delivery_id,team_id,shared_project_id FROM mingle_team_host_deliveries
        WHERE team_id=? AND shared_project_id=? AND owner_device_id=? AND status IN ('accepted','running','awaiting-approval')`)
        .all(envelope.teamId, sharedProjectId, envelope.fromDeviceId) as Array<{
          delivery_id: string; team_id: string; shared_project_id: string;
        }>;
      for (const delivery of active) this.discardMcpArtifacts(delivery);
    }
    if (!project) {
      this.options.collaboration.invalidateSnapshot?.(localProjectId);
      this.options.store.touch();
      return;
    }
    this.hostRows.prepare('DELETE FROM mingle_team_host_pending_consents WHERE envelope_id=?').run(envelope.id);
    if (!broadcast) {
      this.options.collaboration.invalidateSnapshot?.(localProjectId);
      this.options.store.touch();
      if (eligible && this.groupOrNull(project.group_id)) this.options.groups.pumpTeamGroup(project.group_id);
      return;
    }
    const context = await this.context(localProjectId);
    await this.broadcastStructure(context, project);
    if (eligible && this.groupOrNull(project.group_id)) this.options.groups.pumpTeamGroup(project.group_id);
  }

  private async flushPendingConsents(context: ProjectContext): Promise<boolean> {
    const expireBefore = new Date(this.now() - 7 * 24 * 60 * 60_000).toISOString();
    this.hostRows.prepare('DELETE FROM mingle_team_host_pending_consents WHERE team_id=? AND shared_project_id=? AND received_at<?')
      .run(context.project.teamId, context.project.sharedProjectId, expireBefore);
    const rows = this.hostRows.prepare(`SELECT envelope_id,team_id,shared_project_id,owner_account_id,owner_device_id,payload_json
      FROM mingle_team_host_pending_consents WHERE team_id=? AND shared_project_id=? AND received_at>=? ORDER BY received_at,envelope_id`)
      .all(context.project.teamId, context.project.sharedProjectId, expireBefore) as Array<{
        envelope_id: string; team_id: string; shared_project_id: string; owner_account_id: string; owner_device_id: string; payload_json: string;
      }>;
    let applied = false;
    for (const row of rows) {
      const parsed = TeamConsentPayloadSchema.safeParse(safeJson(row.payload_json, null));
      if (!parsed.success) {
        this.hostRows.prepare('DELETE FROM mingle_team_host_pending_consents WHERE envelope_id=?').run(row.envelope_id);
        continue;
      }
      let unavailable = false;
      let forged = false;
      for (const agentId of parsed.data.agentIds) {
        const agent = context.agents.find((candidate) => candidate.id === agentId);
        if (!agent) { unavailable = true; continue; }
        if (agent.accountId !== row.owner_account_id || agent.deviceId !== row.owner_device_id) forged = true;
      }
      if (unavailable && !forged) continue;
      if (forged) {
        this.hostRows.prepare('DELETE FROM mingle_team_host_pending_consents WHERE envelope_id=?').run(row.envelope_id);
        continue;
      }
      const envelope = { id: row.envelope_id, teamId: row.team_id, fromDeviceId: row.owner_device_id,
        toDeviceId: context.localDeviceId, kind: 'teamgroup.consent', payload: parsed.data };
      try {
        await this.receiveConsentLocked(envelope, row.shared_project_id, false);
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) {
          this.hostRows.prepare('DELETE FROM mingle_team_host_pending_consents WHERE envelope_id=?').run(row.envelope_id);
          continue;
        }
        throw error;
      }
      this.hostRows.prepare('DELETE FROM mingle_team_host_pending_consents WHERE envelope_id=?').run(row.envelope_id);
      applied = true;
    }
    return applied;
  }

  private delivery(deliveryId: string): DeliveryRow | undefined {
    return this.hostRows.prepare('SELECT * FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId) as DeliveryRow | undefined;
  }

  private async receiveHeartbeat(envelope: import('@mingle/contracts').AuthenticatedTransportMessage): Promise<void> {
    const parsed = TeamDeliveryHeartbeatPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) throw new HttpError(400, 'Team delivery heartbeat payload is invalid.');
    const delivery = this.delivery(parsed.data.deliveryId);
    if (!delivery || delivery.team_id !== envelope.teamId || delivery.shared_project_id !== parsed.data.sharedProjectId) return;
    if (delivery.owner_device_id !== envelope.fromDeviceId || delivery.agent_id !== parsed.data.agentId
      || delivery.remote_run_id && delivery.remote_run_id !== parsed.data.runId) {
      throw new HttpError(403, 'The delivery heartbeat came from a different device, agent, or run.');
    }
    await this.verifyOwnerDevice(delivery.team_id, envelope.fromDeviceId, delivery.owner_account_id);
    await this.deliveryMutations.run(delivery.delivery_id, async () => {
      const current = this.delivery(delivery.delivery_id);
      if (!current || !liveDelivery(current.status) || this.completionIntent(current)) return;
      const prior = this.heartbeatSequences.get(current.delivery_id) ?? 0;
      if (parsed.data.sequence <= prior) return;
      this.heartbeatSequences.set(current.delivery_id, parsed.data.sequence);
      this.extendDeliveryTimeout(current.delivery_id);
    });
  }

  private deliveryDeadline(now: number, issuedAt: number): number {
    return Math.min(now + this.deliveryTimeoutMs, issuedAt + this.deliveryMaxDurationMs);
  }

  private armDeliveryTimeout(deliveryId: string): void {
    const previous = this.timers.get(deliveryId);
    if (previous) clearTimeout(previous);
    this.timers.delete(deliveryId);
    const delivery = this.delivery(deliveryId);
    if (!delivery || !liveDelivery(delivery.status)) return;
    const timer = setTimeout(() => this.timeout(deliveryId), Math.max(0, delivery.timeout_at - this.now()));
    timer.unref();
    this.timers.set(deliveryId, timer);
  }

  /** Persist only the idle deadline: heartbeats are not user-visible store mutations. */
  private extendDeliveryTimeout(deliveryId: string): void {
    const delivery = this.delivery(deliveryId);
    if (!delivery || !liveDelivery(delivery.status)) return;
    const issuedAt = Date.parse(delivery.issued_at);
    const deadline = this.deliveryDeadline(this.now(), Number.isFinite(issuedAt) ? issuedAt : this.now());
    if (deadline > delivery.timeout_at) {
      this.hostRows.prepare(`UPDATE mingle_team_host_deliveries SET timeout_at=?
        WHERE delivery_id=? AND status IN ('queued','accepted','running','awaiting-approval')`)
        .run(deadline, deliveryId);
    }
    this.armDeliveryTimeout(deliveryId);
  }

  private timedOutDelivery(delivery: DeliveryRow): boolean {
    if (delivery.status !== 'failed') return false;
    const message = safeJson<{ message?: unknown } | null>(delivery.failure_json ?? 'null', null)?.message;
    return typeof message === 'string' && message.startsWith('The remote agent stopped responding')
      || typeof message === 'string' && message.startsWith('The remote agent timed out while its device was offline');
  }

  private groupWorkspace(groupId: string): { projectId: string; sessionId: string; worktreePath: string; branch: string | null } | undefined {
    try {
      const snapshot = this.options.groups.get(groupId);
      const anchor = snapshot.members.find((member) => member.sessionId === snapshot.group.anchorSessionId && !member.removedAt);
      const session = anchor ? this.options.store.getSession(anchor.sessionId) : undefined;
      if (!session || session.projectId !== snapshot.group.projectId || this.isProxySession(session.id)) return undefined;
      return { projectId: session.projectId, sessionId: session.id, worktreePath: session.worktreePath, branch: session.branch };
    } catch { return undefined; }
  }

  private async receiveStatus(envelope: import('@mingle/contracts').AuthenticatedTransportMessage): Promise<void> {
    const parsed = TeamDeliveryStatusPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) throw new HttpError(400, 'Team delivery status payload is invalid.');
    const observed = this.delivery(parsed.data.deliveryId);
    if (!observed || observed.team_id !== envelope.teamId || observed.shared_project_id !== parsed.data.sharedProjectId) throw new HttpError(404, 'Team delivery is unknown.');
    if (observed.owner_device_id !== envelope.fromDeviceId || observed.agent_id !== parsed.data.agentId) throw new HttpError(403, 'The delivery status came from a different device or agent.');
    await this.verifyOwnerDevice(observed.team_id, envelope.fromDeviceId, observed.owner_account_id);
    const delivery = this.delivery(parsed.data.deliveryId);
    if (!delivery || delivery.team_id !== envelope.teamId || delivery.shared_project_id !== parsed.data.sharedProjectId
      || delivery.owner_device_id !== envelope.fromDeviceId || delivery.agent_id !== parsed.data.agentId) return;
    const lateCompletion = parsed.data.status === 'completed' && this.timedOutDelivery(delivery);
    const notificationReplay = parsed.data.status === 'completed' && delivery.status === 'completed'
      && this.completionIntent(delivery)?.phase === 'notifying';
    if (!liveDelivery(delivery.status) && !lateCompletion && !notificationReplay) return;
    if (parsed.data.status === 'accepted' || parsed.data.status === 'running' || parsed.data.status === 'awaiting-approval') {
      await this.deliveryMutations.run(delivery.delivery_id, async () => {
        const current = this.delivery(delivery.delivery_id);
        if (!current || !liveDelivery(current.status) || this.completionIntent(current)) return;
        this.extendDeliveryTimeout(current.delivery_id);
        const next = parsed.data.status === 'awaiting-approval' && current.status === 'running'
          || parsed.data.status === 'running' && ['accepted', 'queued', 'awaiting-approval'].includes(current.status)
          ? parsed.data.status : null;
        if (!next) return;
        const changed = this.hostRows.prepare(`UPDATE mingle_team_host_deliveries SET status=?,remote_run_id=COALESCE(?,remote_run_id),updated_at=?
          WHERE delivery_id=? AND status=?`).run(next, parsed.data.runId, parsed.data.at, current.delivery_id, current.status);
        if (Number(changed.changes) !== 1) return;
        this.options.store.updateSession(current.session_id, { status: next === 'awaiting-approval' ? 'waiting' : 'running' });
      });
      return;
    }

    if (parsed.data.status === 'completed') {
      const intent = await this.deliveryMutations.run(delivery.delivery_id, async () => {
        const current = this.delivery(delivery.delivery_id);
        if (!current || current.owner_device_id !== envelope.fromDeviceId || current.agent_id !== parsed.data.agentId) return null;
        const existing = this.completionIntent(current);
        if (existing) {
          if (existing.remoteRunId !== parsed.data.runId
            || existing.finalText !== (parsed.data.finalText ?? '')
            || JSON.stringify(existing.artifacts.map((entry) => entry.source)) !== JSON.stringify(parsed.data.artifacts)) {
            throw new HttpError(409, 'A different completion result is already recorded for this team delivery.');
          }
          return existing;
        }
        const timeoutCompletion = this.timedOutDelivery(current);
        if (!liveDelivery(current.status) && !timeoutCompletion) return null;
        const nextIntent: CompletionIntent = {
          kind: 'team-completion', version: 1, phase: 'artifacts', remoteRunId: parsed.data.runId,
          at: parsed.data.at, finalText: parsed.data.finalText ?? '', workspaceBefore: null,
          artifacts: parsed.data.artifacts.map((artifact) => ({ source: TeamArtifactRefSchema.parse(artifact), state: 'pending' as const })),
          artifactFailures: [], importedArtifacts: [], integratedArtifacts: [],
        };
        const changed = this.hostRows.prepare(`UPDATE mingle_team_host_deliveries SET status='running',failure_json=?,remote_run_id=COALESCE(?,remote_run_id),updated_at=?
          WHERE delivery_id=? AND (status IN ('queued','accepted','running','awaiting-approval') OR (status='failed' AND ?=1))`)
          .run(JSON.stringify(nextIntent), parsed.data.runId, parsed.data.at, current.delivery_id, Number(timeoutCompletion));
        if (Number(changed.changes) !== 1) return null;
        const timer = this.timers.get(current.delivery_id);
        if (timer) clearTimeout(timer);
        this.timers.delete(current.delivery_id);
        return nextIntent;
      });
      if (intent) {
        const work = this.processCompletion(delivery.delivery_id);
        this.track(work);
        await work;
      }
      return;
    }

    this.extendDeliveryTimeout(delivery.delivery_id);
    const failure = parsed.data.failure ? ProviderFailureSchema.parse({ ...parsed.data.failure, sessionId: delivery.session_id, runId: delivery.run_id,
      message: redactSecrets(parsed.data.failure.message).slice(0, 1000),
      ...(parsed.data.failure.providerCode ? { providerCode: redactSecrets(parsed.data.failure.providerCode).slice(0, 100) } : {}),
      ...(parsed.data.failure.quotaPool ? { quotaPool: redactSecrets(parsed.data.failure.quotaPool).slice(0, 100) } : {}),
    }) : undefined;
    const outcome = parsed.data.status === 'interrupted' ? 'interrupted' : 'failed';
    const rejection = parsed.data.status === 'rejected' ? `Remote agent rejected delivery: ${parsed.data.rejection ?? 'invalid'}` : undefined;
    const failureJson = failure ? JSON.stringify(failure) : rejection ? JSON.stringify({ message: redactSecrets(rejection).slice(0, 500) }) : null;
    const claimed = await this.deliveryMutations.run(delivery.delivery_id, async () => {
      const current = this.delivery(delivery.delivery_id);
      if (!current || this.completionIntent(current) || (!liveDelivery(current.status) && !this.timedOutDelivery(current))) return false;
      const changed = this.hostRows.prepare(`UPDATE mingle_team_host_deliveries SET status=?,failure_json=?,remote_run_id=COALESCE(?,remote_run_id),updated_at=?
        WHERE delivery_id=? AND (status IN ('queued','accepted','running','awaiting-approval') OR status='failed')`)
        .run(outcome, failureJson, parsed.data.runId, parsed.data.at, delivery.delivery_id);
      if (Number(changed.changes) !== 1) return false;
      this.finishClaimedDelivery(current, outcome, failure, rejection, parsed.data.at);
      return true;
    });
    if (!claimed) return;
    if (failure) this.options.recovery.recordFailure(delivery.session_id, delivery.run_id, failure);
    if (failure?.kind === 'quota_exhausted') await this.promoteFallback(delivery.team_id, delivery.shared_project_id, 'fallback-quota');
  }

  private completionIntent(delivery: DeliveryRow): CompletionIntent | null {
    if (!delivery.failure_json) return null;
    const parsed = CompletionIntentSchema.safeParse(safeJson<unknown>(delivery.failure_json, null));
    if (!parsed.success) return null;
    return { ...parsed.data, workspaceBefore: parsed.data.workspaceBefore as RunTreeSnapshot | null };
  }

  private persistCompletionIntent(deliveryId: string, intent: CompletionIntent): void {
    this.options.store.tx(() => {
      const changed = this.hostRows.prepare(`UPDATE mingle_team_host_deliveries SET failure_json=?,artifacts_json=?,updated_at=?
        WHERE delivery_id=? AND status IN ('queued','accepted','running','awaiting-approval')`)
        .run(JSON.stringify(intent), JSON.stringify(intent.importedArtifacts), new Date(this.now()).toISOString(), deliveryId);
      if (Number(changed.changes) !== 1) throw new CompletionAuthorityError('The remote delivery stopped before its artifacts could be integrated.');
    });
  }

  private async processCompletion(deliveryId: string): Promise<void> {
    return this.deliveryMutations.run(deliveryId, async () => {
      const observed = this.delivery(deliveryId);
      const initialIntent = observed && this.completionIntent(observed);
      if (!observed || !initialIntent) return;
      if (observed.status === 'completed' && initialIntent.phase === 'notifying') {
        await this.notifyCompletedDelivery(observed, initialIntent);
        return;
      }
      if (!liveDelivery(observed.status)) return;
      await this.mutations.run(`${observed.team_id}\0${observed.shared_project_id}`, async () => {
        const delivery = this.delivery(deliveryId);
        let intent = delivery && this.completionIntent(delivery);
        if (!delivery || !intent || !liveDelivery(delivery.status)) return;
        try {
          await this.assertCompletionAuthority(delivery);
        } catch (error) {
          if (error instanceof CompletionAuthorityError) {
            this.finishCompletionInterrupted(delivery, error.message, intent.at);
            return;
          }
          throw error;
        }
        const workspace = this.groupWorkspace(delivery.group_id);
        if (!intent.workspaceBefore) {
          intent = { ...intent, workspaceBefore: workspace ? await captureRunTree(workspace.worktreePath) : null };
          this.persistCompletionIntent(deliveryId, intent);
        }
        // Release the provider slot before GitSync's repository mutation lease. Keep a separate
        // cancellation handle for host-side artifact processing until terminal notification.
        this.beginCompletion(delivery);

        for (let index = 0; index < intent.artifacts.length; index++) {
          const progress = intent.artifacts[index]!;
          if (progress.state !== 'pending') continue;
          try {
            this.assertCompletionStillLive(deliveryId);
            if (!progress.imported) {
              if (!this.options.git) throw new Error('Git artifact import is unavailable on the host.');
              // Artifact import mutates the host repository, so sender membership/device pins stay fresh.
              await this.options.authorizeTeam({ teamId: delivery.team_id, peerDeviceId: delivery.owner_device_id });
              const imported = await this.options.git.importTeamArtifact({ teamId: delivery.team_id,
                sharedProjectId: delivery.shared_project_id, deliveryId, artifact: progress.source,
                sourceDeviceId: delivery.owner_device_id });
              intent = { ...intent, artifacts: intent.artifacts.map((entry, entryIndex) => entryIndex === index
                ? { ...entry, imported, state: 'pending' as const } : entry),
              importedArtifacts: [...intent.importedArtifacts, imported] };
              this.persistCompletionIntent(deliveryId, intent);
            }
            this.assertCompletionStillLive(deliveryId);
            if (!workspace || !this.options.integrateTeamArtifact) {
              throw new Error(`Commit ${progress.source.revision.slice(0, 12)} was imported as ${progress.imported?.ref ?? 'an isolated ref'} but the host group workspace is unavailable for integration.`);
            }
            const importedArtifact: TeamArtifactRef = intent.artifacts[index]!.imported!;
            await this.validateArtifactHistory(delivery, this.artifactAuthority(delivery), importedArtifact, workspace.worktreePath, false);
            this.assertCompletionStillLive(deliveryId);
            const integrationResult = await this.options.integrateTeamArtifact({ localProjectId: workspace.projectId, teamId: delivery.team_id,
              sharedProjectId: delivery.shared_project_id, deliveryId, worktreePath: workspace.worktreePath, artifact: importedArtifact });
            if (integrationResult.revision.toLowerCase() !== importedArtifact.revision.toLowerCase()) {
              throw new Error(`Artifact ${importedArtifact.revision.slice(0, 12)} did not become the host workspace revision.`);
            }
            this.assertCompletionStillLive(deliveryId);
            intent = { ...intent, artifacts: intent.artifacts.map((entry, entryIndex) => entryIndex === index
              ? { ...entry, state: 'integrated' as const } : entry),
            integratedArtifacts: [...intent.integratedArtifacts, importedArtifact] };
            this.persistCompletionIntent(deliveryId, intent);
          } catch (error) {
            if (error instanceof CompletionAuthorityError) throw error;
            this.assertCompletionStillLive(deliveryId);
            const failure = redactSecrets(error instanceof Error ? error.message : 'Artifact import/integration failed.').slice(0, 500);
            intent = { ...intent, artifacts: intent.artifacts.map((entry, entryIndex) => entryIndex === index
              ? { ...entry, state: 'failed' as const, failure } : entry),
            artifactFailures: [...intent.artifactFailures, failure].slice(0, 30) };
            this.persistCompletionIntent(deliveryId, intent);
          }
        }

        const currentDelivery = this.delivery(deliveryId);
        intent = currentDelivery && this.completionIntent(currentDelivery);
        if (!currentDelivery || !intent || !liveDelivery(currentDelivery.status)) return;
        this.assertCompletionStillLive(deliveryId);
        let workspaceChanges: import('@mingle/contracts').RunChanges | undefined;
        if (workspace && intent.integratedArtifacts.length && intent.workspaceBefore) {
          const workspaceAfter = await captureRunTree(workspace.worktreePath);
          workspaceChanges = await compareRunTrees(workspace.worktreePath, intent.workspaceBefore, workspaceAfter);
          intent = { ...intent, workspaceChanges };
          this.options.store.setRunChanges(delivery.run_id, workspaceChanges);
        }
        const artifactSummary = intent.importedArtifacts.length
          ? `\n\nImported committed artifacts:\n${intent.importedArtifacts.map((artifact) =>
            `- ${safeArtifactText(artifact.path ?? 'committed artifact', 120)} @ ${artifact.revision}${artifact.taskId ? ` (task ${safeArtifactText(artifact.taskId, 80)})` : ''}\n  Git ref: ${safeArtifactText(artifact.ref ?? '', 255)}`,
          ).join('\n')}` : '';
        const workspaceSummary = intent.integratedArtifacts.length
          ? workspaceChanges?.summary.status === 'available'
            ? workspaceChanges.summary.files.length
              ? `\n\nIntegrated into the host group workspace${workspace?.branch ? ` (${safeArtifactText(workspace.branch, 200)})` : ''}; changed files:\n${workspaceChanges.summary.files.map((file) => `- ${safeArtifactText(file.path, 500)} (${file.status})`).join('\n')}${workspaceChanges.summary.truncated ? '\n- Additional changed files were omitted from this summary.' : ''}`
              : '\n\nIntegrated into the host group workspace; no new file changes were recorded.'
            : '\n\nIntegrated into the host group workspace, but its changed-file summary is unavailable.'
          : '';
        const failureSummary = intent.artifactFailures.length
          ? `\n\nArtifact import/integration failures:\n${intent.artifactFailures.map((failure) => `- ${failure}`).join('\n')}`.slice(0, 15_000) : '';
        const finalBudget = Math.max(0, 50_000 - artifactSummary.length - workspaceSummary.length - failureSummary.length);
        const finalContent = `${intent.finalText ? redactSecrets(intent.finalText).slice(0, finalBudget) : ''}${artifactSummary}${workspaceSummary}${failureSummary}`.slice(0, 50_000);
        intent = { ...intent, phase: 'finalizing', finalContent };
        this.persistCompletionIntent(deliveryId, intent);
        await this.finalizeCompletion(currentDelivery, intent);
        this.assertCompletionStillLive(deliveryId);
        // Commit terminal state before waking the group queue. A successor can then claim the proxy
        // immediately without the old completion cleanup overwriting its running session state.
        const notifying: CompletionIntent = { ...intent, phase: 'notifying' };
        const changed = this.hostRows.prepare(`UPDATE mingle_team_host_deliveries SET status='completed',failure_json=?,artifacts_json=?,updated_at=?
          WHERE delivery_id=? AND status IN ('queued','accepted','running','awaiting-approval')`)
          .run(JSON.stringify(notifying), JSON.stringify(intent.importedArtifacts), new Date(this.now()).toISOString(), deliveryId);
        if (Number(changed.changes) === 1) {
          this.finishCompletedDelivery(delivery);
          await this.notifyCompletedDelivery({ ...delivery, status: 'completed', failure_json: JSON.stringify(notifying) }, notifying);
        }
      });
    }).catch((error: unknown) => {
      if (error instanceof CompletionAuthorityError) return;
      throw error;
    });
  }

  /** The durable notifying phase permits restart-safe group completion without redispatching a worker. */
  private async notifyCompletedDelivery(delivery: DeliveryRow, intent: CompletionIntent): Promise<void> {
    if (this.closed) return;
    this.options.groups.onRunFinished(delivery.session_id, delivery.run_id, 'completed');
    const project = this.readHost(delivery.team_id, delivery.shared_project_id);
    if (delivery.source_chat_message_id && this.chat && project) {
      // The owner device publishes its signed, delivery-idempotent agent reply. This host
      // records integration and request completion, but cannot author as a remote agent.
      const otherLive = this.hostRows.prepare(`SELECT 1 AS found FROM mingle_team_host_deliveries
        WHERE source_chat_message_id=? AND delivery_id<>? AND status IN ('queued','accepted','running','awaiting-approval') LIMIT 1`)
        .get(delivery.source_chat_message_id, delivery.delivery_id);
      if (!otherLive) await this.chat.setOrchestratedRunState({ messageId: delivery.source_chat_message_id, state: 'completed' });
    }
    if (delivery.source_chat_message_id) this.finishChatDelivery(delivery.delivery_id, delivery.source_chat_message_id, 'completed');
    this.hostRows.prepare(`UPDATE mingle_team_host_deliveries SET failure_json=NULL,updated_at=?
      WHERE delivery_id=? AND status='completed' AND failure_json IS NOT NULL`)
      .run(new Date(this.now()).toISOString(), delivery.delivery_id);
  }

  private async assertCompletionAuthority(delivery: DeliveryRow): Promise<void> {
    const project = this.readHost(delivery.team_id, delivery.shared_project_id);
    if (!project || project.group_id !== delivery.group_id || this.closed) throw new CompletionAuthorityError('Team delivery authority ended before artifact integration.');
    let context: ProjectContext;
    let group: import('@mingle/contracts').GroupSnapshot;
    try {
      [context, group] = await Promise.all([this.context(project.local_project_id), Promise.resolve(this.options.groups.get(delivery.group_id))]);
    } catch (error) {
      if (error instanceof HttpError && [403, 404, 409].includes(error.status)) {
        throw new CompletionAuthorityError('Team project or group membership ended before artifact integration.');
      }
      throw error;
    }
    const member = group.members.find((candidate) => candidate.sessionId === delivery.session_id && !candidate.removedAt);
    if (!context.isHost || context.project.sharedProjectId !== delivery.shared_project_id || context.project.teamId !== delivery.team_id
      || !member || this.consentFor(context, delivery.agent_id) !== 'granted') {
      throw new CompletionAuthorityError('Team consent or roster authority ended before artifact integration.');
    }
    try { await this.verifyOwnerDevice(delivery.team_id, delivery.owner_device_id, delivery.owner_account_id); }
    catch (error) {
      if (error instanceof HttpError && error.status === 403) throw new CompletionAuthorityError('The team owner device lost authority before artifact integration.');
      throw error;
    }
  }

  private assertCompletionStillLive(deliveryId: string): void {
    const current = this.delivery(deliveryId);
    const active = current ? this.active.get(current.session_id) : undefined;
    const completing = this.completing.get(deliveryId);
    const controller = current && completing?.runId === current.run_id ? completing.controller
      : current && active?.runId === current.run_id ? active.controller : undefined;
    if (this.closed || !current || !liveDelivery(current.status) || !this.completionIntent(current)
      || controller?.signal.aborted) {
      throw new CompletionAuthorityError('The remote delivery was interrupted before artifact integration completed.');
    }
  }

  private beginCompletion(delivery: DeliveryRow): void {
    const active = this.active.get(delivery.session_id);
    const controller = active?.runId === delivery.run_id ? active.controller : new AbortController();
    if (active?.runId === delivery.run_id) this.active.delete(delivery.session_id);
    this.completing.set(delivery.delivery_id, { sessionId: delivery.session_id, runId: delivery.run_id, controller });
    this.options.teamMcp.revoke(delivery.run_id);
    // A late completion must not make a newer proxy run appear idle.
    if (!active || active.runId === delivery.run_id) this.options.store.updateSession(delivery.session_id, { status: 'idle', error: null });
  }

  private finishCompletionInterrupted(delivery: DeliveryRow, message: string, at: string): void {
    const changed = this.hostRows.prepare(`UPDATE mingle_team_host_deliveries SET status='interrupted',failure_json=?,updated_at=?
      WHERE delivery_id=? AND status IN ('queued','accepted','running','awaiting-approval')`)
      .run(JSON.stringify({ message: redactSecrets(message).slice(0, 500) }), at, delivery.delivery_id);
    if (Number(changed.changes) !== 1) return;
    this.finishClaimedDelivery(delivery, 'interrupted', undefined, message, at);
  }

  private async finalizeCompletion(delivery: DeliveryRow, intent: CompletionIntent): Promise<void> {
    const at = intent.at;
    this.options.store.tx(() => {
      if (intent.finalContent && !this.options.store.listMessages(delivery.session_id, { limit: 2_000 })
        .some((message) => message.id === this.finalMessageId(delivery.delivery_id))) {
        this.options.store.insertMessage({ id: this.finalMessageId(delivery.delivery_id), sessionId: delivery.session_id,
          runId: delivery.run_id, role: 'assistant', content: intent.finalContent });
      }
      const run = this.options.store.getRun(delivery.run_id);
      if (run?.status === 'running') {
        this.options.store.finishRun(delivery.run_id, 'completed', Math.max(0, this.now() - Date.parse(run.startedAt)), at);
      } else if (run && run.status !== 'completed') {
        this.hostRows.prepare(`UPDATE session_runs SET status='completed',finished_at=?,duration_ms=? WHERE id=? AND status IN ('failed','interrupted')`)
          .run(at, Math.max(0, this.now() - Date.parse(run.startedAt)), delivery.run_id);
      }
      const active = this.active.get(delivery.session_id);
      if (!active || active.runId === delivery.run_id) this.options.store.updateSession(delivery.session_id, { status: 'idle', error: null });
      this.options.recovery.clearFailure(delivery.session_id);
      const alreadyNotified = this.hostRows.prepare(`SELECT 1 AS found FROM events WHERE type='team.delivery.completed' AND json_extract(payload,'$.deliveryId')=? LIMIT 1`)
        .get(delivery.delivery_id);
      if (!alreadyNotified) this.options.store.recordEvent({ projectId: this.options.store.getSession(delivery.session_id, true)?.projectId ?? null,
        sessionId: delivery.session_id, type: 'team.delivery.completed', summary: 'Remote team delivery completed',
        payload: { deliveryId: delivery.delivery_id, agentId: delivery.agent_id, failure: null } });
      if (intent.workspaceChanges) this.options.store.setRunChanges(delivery.run_id, intent.workspaceChanges as import('@mingle/contracts').RunChanges);
      this.options.store.touch();
    });
  }

  private finalMessageId(deliveryId: string): string {
    return `team_result_${createHash('sha256').update(deliveryId).digest('hex').slice(0, 32)}`;
  }

  private finishCompletedDelivery(delivery: DeliveryRow): void {
    const timer = this.timers.get(delivery.delivery_id);
    if (timer) clearTimeout(timer);
    this.timers.delete(delivery.delivery_id);
    this.heartbeatSequences.delete(delivery.delivery_id);
    this.releaseProxyRun(delivery);
    this.expireApprovals(delivery);
    this.options.store.touch();
  }

  private async finishDelivery(deliveryId: string, outcome: 'completed' | 'failed' | 'interrupted', failure?: ProviderFailure, message?: string, at = new Date(this.now()).toISOString(), remoteRunId?: string | null): Promise<void> {
    await this.deliveryMutations.run(deliveryId, async () => {
      const delivery = this.delivery(deliveryId);
      if (!delivery || !liveDelivery(delivery.status)) return;
      const changed = this.hostRows.prepare(`UPDATE mingle_team_host_deliveries SET status=?,failure_json=?,remote_run_id=COALESCE(?,remote_run_id),updated_at=?
        WHERE delivery_id=? AND status IN ('queued','accepted','running','awaiting-approval')`)
        .run(outcome, failure ? JSON.stringify(failure) : message ? JSON.stringify({ message: redactSecrets(message).slice(0, 500) }) : null,
          remoteRunId ?? null, at, deliveryId);
      if (Number(changed.changes) !== 1) return;
      this.finishClaimedDelivery(delivery, outcome, failure, message, at);
    });
  }

  private finishClaimedDelivery(delivery: DeliveryRow, outcome: 'completed' | 'failed' | 'interrupted', failure?: ProviderFailure, message?: string, at = new Date(this.now()).toISOString()): void {
    const deliveryId = delivery.delivery_id;
    const timer = this.timers.get(deliveryId);
    if (timer) clearTimeout(timer);
    this.timers.delete(deliveryId);
    this.heartbeatSequences.delete(deliveryId);
    this.releaseProxyRun(delivery);
    this.expireApprovals(delivery);
    const run = this.options.store.getRun(delivery.run_id);
    if (run?.status === 'running' && outcome !== 'completed') {
      this.options.store.finishRun(delivery.run_id, outcome, Math.max(0, this.now() - Date.parse(run.startedAt)), at);
    }
    const nextActive = this.active.get(delivery.session_id);
    if (outcome !== 'completed' && (!nextActive || nextActive.runId === delivery.run_id)) {
      this.options.store.updateSession(delivery.session_id, { status: outcome === 'interrupted' ? 'interrupted' : 'error',
        error: redactSecrets(message ?? failure?.message ?? 'Remote team delivery failed').slice(0, 1000) });
    }
    if (message && outcome !== 'completed') this.options.store.insertMessage({ sessionId: delivery.session_id, runId: delivery.run_id, role: 'system', kind: 'error', content: redactSecrets(message).slice(0, 1000) });
    if (delivery.request_id && delivery.group_id) this.options.groups.onRunFinished(delivery.session_id, delivery.run_id, outcome);
    this.options.store.recordEvent({ projectId: this.options.store.getSession(delivery.session_id, true)?.projectId ?? null, sessionId: delivery.session_id,
      type: `team.delivery.${outcome}`, summary: `Remote team delivery ${outcome}`, payload: { deliveryId, agentId: delivery.agent_id, failure: failure ?? null } });
    this.options.store.touch();
    if (outcome !== 'completed') this.discardMcpArtifacts(delivery);
    if (failure?.kind === 'quota_exhausted' && (!nextActive || nextActive.runId === delivery.run_id)) {
      this.options.store.updateSession(delivery.session_id, { error: failure.message });
    }
    if (delivery.source_chat_message_id) this.finishChatDelivery(delivery.delivery_id, delivery.source_chat_message_id, outcome);
  }

  private discardMcpArtifacts(delivery: Pick<DeliveryRow, 'team_id' | 'shared_project_id' | 'delivery_id'>): void {
    const discard = this.options.git?.discardUnpublishedMcpArtifacts;
    if (!discard) return;
    this.track(discard.call(this.options.git, { teamId: delivery.team_id, sharedProjectId: delivery.shared_project_id,
      deliveryId: delivery.delivery_id }).catch(() => undefined));
  }

  private releaseProxyRun(delivery: DeliveryRow): void {
    const current = this.active.get(delivery.session_id);
    if (current?.runId === delivery.run_id) {
      current.controller.abort();
      this.active.delete(delivery.session_id);
    }
    const completing = this.completing.get(delivery.delivery_id);
    if (completing?.runId === delivery.run_id) {
      completing.controller.abort();
      this.completing.delete(delivery.delivery_id);
    }
    this.options.teamMcp.revoke(delivery.run_id);
  }

  private finishChatDelivery(deliveryId: string, sourceMessageId: string, outcome: 'completed' | 'failed' | 'interrupted'): void {
    if (this.chatByDelivery.get(deliveryId) !== sourceMessageId) return;
    this.chatByDelivery.delete(deliveryId);
    const remaining = Math.max(0, (this.chatDeliveryCounts.get(sourceMessageId) ?? 1) - 1);
    if (remaining) { this.chatDeliveryCounts.set(sourceMessageId, remaining); return; }
    this.chatDeliveryCounts.delete(sourceMessageId);
    void this.chat?.setOrchestratedRunState({ messageId: sourceMessageId, state: outcome === 'completed' ? 'completed' : 'failed' }).catch(() => undefined);
  }

  onGroupRunFinished(input: { sessionId: string; runId: string; outcome: 'completed' | 'failed' | 'interrupted'; groupId: string; deliveryId: string }): void {
    const sourceMessageId = this.chatByDelivery.get(input.deliveryId);
    const session = this.options.store.getSession(input.sessionId, true);
    const hostProject = session ? this.hostRows.prepare(`SELECT * FROM mingle_team_host_projects WHERE local_project_id=? AND group_id=?`)
      .get(session.projectId, input.groupId) as HostRow | undefined : undefined;
    if (!sourceMessageId && !hostProject) return;
    const output = input.outcome === 'completed'
      ? this.options.store.listMessages(input.sessionId, { limit: 2_000 }).filter((message) => message.runId === input.runId && message.role === 'assistant' && message.kind !== 'streaming')
        .map((message) => message.content).join('\n\n').trim()
      : '';
    const content = redactSecrets(output).slice(0, 20_000);
    if (session && content && this.chat && !this.isProxySession(input.sessionId)) {
      const mirror = sourceMessageId
        ? this.chat.mirrorTeamSessionMessage({ projectId: session.projectId, sessionId: input.sessionId, sourceMessageId: `group-run:${input.runId}`, content, kind: 'agent', replyTo: sourceMessageId })
        : this.chat.mirrorTeamSessionMessage({ projectId: session.projectId, sessionId: input.sessionId, sourceMessageId: `group-run:${input.runId}`, content, kind: 'agent' });
      this.track(mirror);
    }
    if (sourceMessageId) this.finishChatDelivery(input.deliveryId, sourceMessageId, input.outcome);
  }

  private expireApprovals(delivery: DeliveryRow): void {
    const rows = this.hostRows.prepare(`SELECT approval_id FROM mingle_team_host_approvals WHERE delivery_id=? AND state='pending'`).all(delivery.delivery_id) as Array<{ approval_id: string }>;
    for (const item of rows) {
      try { this.options.store.resolveApproval(item.approval_id, 'denied', 'expired: remote delivery finished'); } catch { /* already resolved */ }
      this.hostRows.prepare("UPDATE mingle_team_host_approvals SET state='expired' WHERE approval_id=?").run(item.approval_id);
    }
  }

  private timeout(deliveryId: string): void {
    this.timers.delete(deliveryId);
    const delivery = this.delivery(deliveryId);
    if (!delivery || !liveDelivery(delivery.status)) return;
    if (delivery.timeout_at > this.now()) { this.armDeliveryTimeout(deliveryId); return; }
    const interrupt = TeamInterruptPayloadSchema.parse({ sharedProjectId: delivery.shared_project_id, deliveryId, reason: 'The host delivery timed out.' });
    this.track(this.options.transport.send({ teamId: delivery.team_id, toDeviceId: delivery.owner_device_id, kind: 'teamgroup.interrupt', payload: interrupt,
      idempotencyKey: `teamgroup-interrupt:${deliveryId}:timeout`.slice(0, 200) }).then(() => this.options.transport.sync()).catch(() => undefined));
    const row = this.readHost(delivery.team_id, delivery.shared_project_id);
    const wasLeader = row ? this.settings(row).orchestratorAgentId === delivery.agent_id : false;
    const deviceOffline = !this.isOnline(delivery.team_id, delivery.owner_device_id);
    const message = deviceOffline ? 'The remote agent timed out while its device was offline.' : 'The remote agent stopped responding.';
    void this.finishDelivery(deliveryId, 'failed', undefined, message)
      .then(() => wasLeader && deviceOffline ? this.promoteFallback(delivery.team_id, delivery.shared_project_id, 'fallback-offline') : undefined);
  }

  private artifactAuthority(delivery: DeliveryRow): ArtifactAuthorityRow {
    const authority = this.hostRows.prepare('SELECT * FROM mingle_team_host_artifact_authority WHERE delivery_id=?')
      .get(delivery.delivery_id) as ArtifactAuthorityRow | undefined;
    if (!authority || authority.team_id !== delivery.team_id || authority.shared_project_id !== delivery.shared_project_id
      || authority.group_id !== delivery.group_id || authority.session_id !== delivery.session_id || authority.run_id !== delivery.run_id
      || authority.agent_id !== delivery.agent_id || authority.owner_account_id !== delivery.owner_account_id
      || authority.owner_device_id !== delivery.owner_device_id) {
      throw new HttpError(403, 'Host-owned task, scope, and base authority are unavailable for this artifact delivery.');
    }
    return authority;
  }

  private async validateArtifactHistory(delivery: DeliveryRow, authority: ArtifactAuthorityRow, artifact: TeamArtifactRef,
    worktreePath: string, requireDeclaredPath: boolean): Promise<void> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(artifact.revision) || !artifact.ref) {
      throw new HttpError(403, 'A transferred artifact must identify a full revision and verified isolated ref.');
    }
    if ((artifact.taskId ?? null) !== authority.task_id) throw new HttpError(403, 'The transferred artifact task differs from the host-owned delivery task.');
    let scope: string[] | null;
    try {
      const raw = JSON.parse(authority.scope_json) as unknown;
      scope = raw === null ? null : normalizeScopes(Array.isArray(raw) && raw.every((entry) => typeof entry === 'string') ? raw : []);
    } catch { throw new HttpError(403, 'The host-owned artifact scope is invalid.'); }
    if (authority.kind === 'assignment' && !scope?.length) throw new HttpError(403, 'The host assignment has no verified edit scope.');
    const base = authority.base_revision;
    if (authority.kind === 'assignment' && !base) throw new HttpError(409, 'The host cannot verify assignment scope without its recorded base revision.');
    if (base && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(base)) throw new HttpError(403, 'The host-owned artifact base revision is invalid.');
    const resolved = await git(worktreePath, ['rev-parse', '--verify', '--end-of-options', `${artifact.ref}^{commit}`]);
    if (resolved.stdout.trim().toLowerCase() !== artifact.revision.toLowerCase()) throw new HttpError(403, 'The transferred ref does not resolve to the exact artifact revision.');
    let range = artifact.revision;
    if (base) {
      const ancestor = await git(worktreePath, ['merge-base', '--is-ancestor', base, artifact.revision], { allowFailure: true });
      if (ancestor.code !== 0) throw new HttpError(403, 'The transferred artifact is not descended from the host-recorded assignment base.');
      range = `${base}..${artifact.revision}`;
    }
    const count = Number((await git(worktreePath, ['rev-list', '--count', range])).stdout.trim());
    if (!Number.isSafeInteger(count) || count > 10_000) throw new HttpError(403, 'Transferred artifact history exceeds the host verification limit.');
    const output = count ? await git(worktreePath,
      ['log', '--format=', '--name-only', '--no-renames', '--root', '-m', '-z', range], { maxBuffer: 8 * 1024 * 1024 }) : { stdout: '' };
    const changedPaths = [...new Set(output.stdout.split('\0').filter(Boolean))];
    const normalizedChanges = changedPaths.map((file) => {
      let normalized: string;
      try { normalized = safeArtifactPath(file); } catch { throw new HttpError(403, 'The transferred history contains an unsafe path.'); }
      if (file.split('/').some(isDeniedName)) throw new HttpError(403, 'The transferred history contains a protected path.');
      if (scope && !isPathWithinArtifactScope(normalized, scope)) throw new HttpError(403, `The transferred history changes out-of-scope path ${normalized}.`);
      return normalized;
    });
    if (requireDeclaredPath) {
      if (!artifact.path) throw new HttpError(403, 'An explicit team artifact must name its committed file.');
      const declared = safeArtifactPath(artifact.path);
      if (!normalizedChanges.includes(declared)) throw new HttpError(403, 'The declared artifact path is not changed in this transferred history.');
      if (scope && !isPathWithinArtifactScope(declared, scope)) throw new HttpError(403, 'The declared artifact path is outside the host-owned assignment scope.');
    }
  }

  private assertToolCallStillActive(deliveryId: string, active: { runId: string; controller: AbortController }): DeliveryRow {
    const delivery = this.delivery(deliveryId);
    if (!delivery || !liveDelivery(delivery.status) || this.completionIntent(delivery) || delivery.run_id !== active.runId
      || this.active.get(delivery.session_id) !== active || active.controller.signal.aborted) {
      throw new HttpError(409, 'The team tool call was cancelled because its delivery is no longer active.');
    }
    return delivery;
  }

  private async receiveToolCall(envelope: import('@mingle/contracts').AuthenticatedTransportMessage): Promise<void> {
    const parsed = TeamToolCallPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) throw new HttpError(400, 'Team tool call payload is invalid.');
    const delivery = this.delivery(parsed.data.deliveryId);
    if (!delivery || delivery.team_id !== envelope.teamId || delivery.shared_project_id !== parsed.data.sharedProjectId || !liveDelivery(delivery.status)) {
      throw new HttpError(404, 'The team tool call delivery is unknown or finished.');
    }
    if (this.completionIntent(delivery)) throw new HttpError(404, 'The team delivery has already completed provider execution.');
    if (delivery.owner_device_id !== envelope.fromDeviceId || delivery.agent_id !== parsed.data.agentId) throw new HttpError(403, 'The team tool call came from a different device or agent.');
    await this.verifyOwnerDevice(delivery.team_id, envelope.fromDeviceId, delivery.owner_account_id);
    this.extendDeliveryTimeout(delivery.delivery_id);
    const active = this.active.get(delivery.session_id);
    if (!active || active.runId !== delivery.run_id) throw new HttpError(409, 'The team tool call run is no longer active.');
    this.assertToolCallStillActive(delivery.delivery_id, active);
    let result: unknown;
    let error: string | undefined;
    try {
      let args = parsed.data.args;
      if (parsed.data.tool === 'team_artifact') {
        const { __mingleArtifactTransfer, ...artifactArgs } = args;
        const artifact = TeamArtifactSchema.parse(artifactArgs);
        const authority = this.artifactAuthority(delivery);
        const assignment = this.options.groups.get(delivery.group_id).assignments.find((candidate) => candidate.deliveryId === delivery.delivery_id);
        const artifactPath = safeArtifactPath(artifact.path);
        if (assignment) {
          if (artifact.taskId !== assignment.taskId) throw new HttpError(403, 'The artifact must name this delivery’s assigned task.');
          const withinScope = assignment.scope.some((scope) => artifactPath === scope || artifactPath.startsWith(`${scope}/`));
          if (!withinScope) throw new HttpError(403, 'The artifact path is outside its assigned scope.');
        }
        if (__mingleArtifactTransfer === undefined) throw new HttpError(403, 'A remote artifact must include its authenticated owner-device transfer.');
        const transfer = TeamArtifactRefSchema.parse(__mingleArtifactTransfer);
        if (transfer.revision.toLowerCase() !== artifact.revision.toLowerCase() || transfer.path !== artifactPath
          || transfer.taskId !== artifact.taskId) {
          throw new HttpError(403, 'The owner-device artifact transfer differs from its active handoff request.');
        }
        if (!this.options.git) throw new HttpError(409, 'The owner-device artifact cannot be imported because team Git transfer is unavailable.');
        this.assertToolCallStillActive(delivery.delivery_id, active);
        // A remote tool's artifact transfer is an authority-sensitive repository mutation.
        await this.options.authorizeTeam({ teamId: delivery.team_id, peerDeviceId: delivery.owner_device_id });
        this.assertToolCallStillActive(delivery.delivery_id, active);
        const imported = await this.options.git.importTeamArtifact({ teamId: delivery.team_id,
          sharedProjectId: delivery.shared_project_id, deliveryId: delivery.delivery_id, artifact: transfer,
          sourceDeviceId: delivery.owner_device_id, signal: active.controller.signal });
        this.assertToolCallStillActive(delivery.delivery_id, active);
        await this.assertCompletionAuthority(delivery);
        this.assertToolCallStillActive(delivery.delivery_id, active);
        if (imported.revision.toLowerCase() !== artifact.revision.toLowerCase() || imported.path !== transfer.path
          || imported.taskId !== transfer.taskId) throw new HttpError(409, 'The imported team artifact differs from its active handoff request.');
        const workspace = this.groupWorkspace(delivery.group_id);
        if (!workspace) throw new HttpError(409, 'The host group workspace is unavailable for artifact verification.');
        await this.validateArtifactHistory(delivery, authority, imported, workspace.worktreePath, true);
        this.assertToolCallStillActive(delivery.delivery_id, active);
        args = artifactArgs;
      }
      result = await this.options.teamMcp.callRemote(delivery.run_id, delivery.session_id, parsed.data.tool, args);
      if (parsed.data.tool === 'team_artifact') this.assertToolCallStillActive(delivery.delivery_id, active);
    }
    catch (cause) {
      error = redactSecrets(cause instanceof Error ? cause.message : 'Team tool call failed').slice(0, 2_000);
      if (parsed.data.tool === 'team_artifact') this.discardMcpArtifacts(delivery);
    }
    const payload = TeamToolResultPayloadSchema.parse({ sharedProjectId: delivery.shared_project_id, deliveryId: delivery.delivery_id,
      callId: parsed.data.callId, ok: error === undefined, ...(error === undefined ? { result } : { error }) });
    await this.options.transport.send({ teamId: delivery.team_id, toDeviceId: delivery.owner_device_id, kind: 'teamgroup.tool.result', payload,
      idempotencyKey: `teamgroup-tool-result:${delivery.delivery_id}:${parsed.data.callId}`.slice(0, 200) });
    await this.options.transport.sync();
  }

  private async receiveApproval(envelope: import('@mingle/contracts').AuthenticatedTransportMessage): Promise<void> {
    const parsed = TeamApprovalRequestPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) throw new HttpError(400, 'Team approval request payload is invalid.');
    const delivery = this.delivery(parsed.data.deliveryId);
    if (!delivery || delivery.team_id !== envelope.teamId || delivery.shared_project_id !== parsed.data.sharedProjectId || !liveDelivery(delivery.status)) throw new HttpError(404, 'Approval request is outside an active delivery.');
    if (delivery.owner_device_id !== envelope.fromDeviceId || delivery.agent_id !== parsed.data.agentId) throw new HttpError(403, 'Approval request came from a different device or agent.');
    await this.verifyOwnerDevice(delivery.team_id, envelope.fromDeviceId, delivery.owner_account_id);
    this.extendDeliveryTimeout(delivery.delivery_id);
    const existing = this.hostRows.prepare('SELECT approval_id FROM mingle_team_host_approvals WHERE delivery_id=? AND remote_approval_id=?')
      .get(delivery.delivery_id, parsed.data.approvalId) as { approval_id: string } | undefined;
    if (existing) return;
    const approval = this.options.store.tx(() => {
      const created = this.options.store.insertApproval({ sessionId: delivery.session_id, tool: parsed.data.kind.slice(0, 200),
        description: redactSecrets(parsed.data.summary).slice(0, 2_000), input: { remoteApprovalId: parsed.data.approvalId, deliveryId: delivery.delivery_id } });
      this.options.store.updateSession(delivery.session_id, { status: 'waiting' });
      this.options.store.recordEvent({ projectId: this.options.store.getSession(delivery.session_id, true)?.projectId ?? null, sessionId: delivery.session_id,
        type: 'approval.requested', summary: `Remote approval requested: ${created.tool}`, payload: { approvalId: created.id, deliveryId: delivery.delivery_id } });
      return created;
    });
    this.hostRows.prepare(`INSERT INTO mingle_team_host_approvals(approval_id,team_id,shared_project_id,delivery_id,remote_approval_id,owner_device_id,state,expires_at)
      VALUES(?,?,?,?,?,?,'pending',?)`).run(approval.id, delivery.team_id, delivery.shared_project_id, delivery.delivery_id, parsed.data.approvalId,
      delivery.owner_device_id, parsed.data.expiresAt);
    this.options.store.touch();
  }

  private async guardDispatch(sessionId: string, groupId: string): Promise<boolean> {
    const proxy = this.proxy(sessionId);
    if (!proxy) return true;
    const project = this.readHost(proxy.team_id, proxy.shared_project_id);
    if (!project || project.group_id !== groupId) return true;
    const settings = this.settings(project);
    const consent = this.consentFor(await this.context(project.local_project_id), proxy.agent_id);
    if (consent !== 'granted') {
      this.options.groups.holdTeamMember(sessionId, `Remote agent consent is ${consent}.`);
      return false;
    }
    if (this.isOnline(proxy.team_id, proxy.owner_device_id)) return true;
    if (proxy.agent_id === settings.orchestratorAgentId) {
      await this.promoteFallback(proxy.team_id, proxy.shared_project_id, 'fallback-offline');
      return false;
    }
    this.options.groups.holdTeamMember(sessionId, 'The owner device is offline.');
    return false;
  }

  private async promoteFallback(teamId: string, sharedProjectId: string, reason: 'fallback-quota' | 'fallback-offline'): Promise<boolean> {
    return this.mutations.run(`${teamId}\0${sharedProjectId}`, () => this.promoteFallbackLocked(teamId, sharedProjectId, reason));
  }

  private async promoteFallbackLocked(teamId: string, sharedProjectId: string, reason: 'fallback-quota' | 'fallback-offline'): Promise<boolean> {
    const row = this.readHost(teamId, sharedProjectId);
    if (!row) return false;
    const context = await this.context(row.local_project_id);
    const settings = this.settings(row);
    for (const id of settings.fallbackAgentIds) {
      const agent = context.agents.find((candidate) => candidate.id === id);
      if (!agent || !agent.sessionId || this.consentFor(context, id) !== 'granted' || agent.deviceId !== context.localDeviceId && !this.isOnline(teamId, agent.deviceId)) continue;
      const failure = this.options.store.latestProviderFailure(agent.sessionId);
      if (failure?.kind === 'quota_exhausted') continue;
      const handle = this.handleFor(teamId, sharedProjectId, id);
      const sessionId = agent.deviceId === context.localDeviceId ? agent.sessionId : (this.hostRows.prepare('SELECT session_id FROM mingle_team_proxy_sessions WHERE team_id=? AND shared_project_id=? AND agent_id=?')
        .get(teamId, sharedProjectId, id) as { session_id?: string } | undefined)?.session_id;
      if (!handle || !sessionId) continue;
      const at = new Date(this.now()).toISOString();
      const history = this.history(row);
      history.push({ id: `leader_${randomUUID().replaceAll('-', '')}`, at, fromAgentId: settings.orchestratorAgentId, toAgentId: id, reason, byAccountId: null });
      if (history.length > 50) history.splice(0, history.length - 50);
      const next = TeamOrchestrationSettingsSchema.parse({ ...settings, orchestratorAgentId: id, version: settings.version + 1,
        updatedAt: at, updatedByAccountId: settings.updatedByAccountId });
      try {
        this.options.store.tx(() => {
          const latest = this.readHost(teamId, sharedProjectId);
          if (!latest || this.settings(latest).version !== settings.version) throw new HttpError(409, 'Team orchestration settings changed during automatic handover.');
          this.hostRows.prepare(`UPDATE mingle_team_host_roster SET role='worker',updated_at=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
            .run(at, teamId, sharedProjectId, settings.orchestratorAgentId);
          this.hostRows.prepare(`UPDATE mingle_team_host_roster SET role='orchestrator',removed_at=NULL,updated_at=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
            .run(at, teamId, sharedProjectId, id);
          const changed = this.hostRows.prepare(`UPDATE mingle_team_host_projects SET settings_json=?,leader_history_json=?,needs_leader=0,updated_at=?
            WHERE team_id=? AND shared_project_id=? AND settings_json=?`)
            .run(JSON.stringify(next), JSON.stringify(history), at, teamId, sharedProjectId, row.settings_json);
          if (Number(changed.changes) !== 1) throw new HttpError(409, 'Team orchestration settings changed during automatic handover.');
          this.syncTeamRoster(context, row.group_id, next);
          this.options.groups.setTeamLeader(row.group_id, sessionId, { paused: false, pauseReason: null });
        });
      } catch { continue; }
      await this.broadcastStructure(context, this.readHost(teamId, sharedProjectId)!);
      return true;
    }
    const at = new Date(this.now()).toISOString();
    this.options.store.tx(() => {
      const latest = this.readHost(teamId, sharedProjectId);
      if (!latest || this.settings(latest).version !== settings.version) return;
      this.hostRows.prepare('UPDATE mingle_team_host_projects SET needs_leader=1,updated_at=? WHERE team_id=? AND shared_project_id=? AND settings_json=?')
        .run(at, teamId, sharedProjectId, row.settings_json);
      this.options.groups.pauseTeamGroup(row.group_id, 'No consented, online fallback leader is available. Choose a new orchestrator in Team structure.');
    });
    await this.chat?.postOrchestrationStatus({ projectId: row.local_project_id, content: 'Team orchestration is paused because the current leader is unavailable and no configured fallback is consented, online, and available.' });
    await this.broadcastStructure(context, this.readHost(teamId, sharedProjectId)!);
    return false;
  }

  async guardGroupDispatch(sessionId: string, groupId: string): Promise<boolean> { return this.guardDispatch(sessionId, groupId); }

  async routeTeamChatMessage(projectId: string, message: TeamChatOrchestrationMessage): Promise<'routed' | 'handled' | false> {
    let context: ProjectContext;
    try { context = await this.context(projectId); } catch { return false; }
    const row = this.readHost(context.project.teamId, context.project.sharedProjectId);
    const peerPayload = this.options.deviceSide?.latestStructure(context.project.sharedProjectId) ?? null;
    const peer = peerPayload ? StructureSchema.parse(peerPayload) : null;
    if (!row && !peer) return false;
    if (message.author.kind !== 'human') return 'handled';
    if (!row || !context.isHost || !this.groupOrNull(row.group_id)) return 'handled';
    const agents = message.mentions.map((id) => context.agents.find((agent) => agent.id === id)
      ?? context.agents.find((agent) => agent.sessionId === id));
    if (agents.some((agent) => !agent || !this.handleFor(context.project.teamId, context.project.sharedProjectId, agent.id))) {
      throw new HttpError(400, 'A mentioned agent is not part of the active team structure.');
    }
    const recipients = message.mentions.length ? agents.map((agent) => this.handleFor(context.project.teamId, context.project.sharedProjectId, agent!.id)!) : undefined;
    const deliveries = this.options.groups.sendTeamMessage(row.group_id, { content: message.body, recipients, clientMessageId: `teamchat-${message.id}`.slice(0, 100) });
    for (const id of deliveries) {
      if (!this.chatByDelivery.has(id)) {
        this.chatByDelivery.set(id, message.id);
        this.chatDeliveryCounts.set(message.id, (this.chatDeliveryCounts.get(message.id) ?? 0) + 1);
      }
    }
    return 'routed';
  }

  async receiveActivity(payload: unknown, envelope: import('@mingle/contracts').AuthenticatedTransportMessage): Promise<void> {
    const parsed = TeamActivityPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new HttpError(400, 'Team activity payload is invalid.');
    // Inbound activity is accepted only from a currently authorized, mutually pinned device.
    await this.options.authorizeTeam({ teamId: envelope.teamId, peerDeviceId: envelope.fromDeviceId });
    if (!parsed.data.runId) return;
    const candidates = this.hostRows.prepare(`SELECT * FROM mingle_team_host_deliveries
      WHERE team_id=? AND shared_project_id=? AND agent_id=? AND owner_device_id=?
        AND status IN ('queued','accepted','running','awaiting-approval') ORDER BY issued_at DESC`)
      .all(envelope.teamId, parsed.data.sharedProjectId, parsed.data.agentId, envelope.fromDeviceId) as DeliveryRow[];
    const delivery = candidates.find((candidate) => !candidate.remote_run_id || candidate.remote_run_id === parsed.data.runId);
    if (!delivery) return;
    await this.verifyOwnerDevice(delivery.team_id, envelope.fromDeviceId, delivery.owner_account_id);
    await this.deliveryMutations.run(delivery.delivery_id, async () => {
      const current = this.delivery(delivery.delivery_id);
      if (current && liveDelivery(current.status) && !this.completionIntent(current)) this.extendDeliveryTimeout(current.delivery_id);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.unsubscribeStore();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const [sessionId, active] of [...this.active]) {
      active.controller.abort();
      const delivery = this.hostRows.prepare('SELECT delivery_id,team_id,shared_project_id,owner_device_id FROM mingle_team_host_deliveries WHERE run_id=?')
        .get(active.runId) as { delivery_id?: string; team_id?: string; shared_project_id?: string; owner_device_id?: string } | undefined;
      if (delivery?.delivery_id && delivery.team_id && delivery.shared_project_id && delivery.owner_device_id) {
        const current = this.delivery(delivery.delivery_id);
        const hasCompletionIntent = Boolean(current && this.completionIntent(current));
        if (!hasCompletionIntent) {
          const payload = TeamInterruptPayloadSchema.parse({ sharedProjectId: delivery.shared_project_id, deliveryId: delivery.delivery_id, reason: 'The host is shutting down.' });
          try {
            await this.options.transport.send({ teamId: delivery.team_id, toDeviceId: delivery.owner_device_id, kind: 'teamgroup.interrupt', payload,
              idempotencyKey: `teamgroup-interrupt:${delivery.delivery_id}:shutdown`.slice(0, 200) });
            await this.options.transport.sync();
          } catch { /* durable host run is still interrupted locally */ }
          await this.finishDelivery(delivery.delivery_id, 'interrupted', undefined, 'The host shut down while this remote delivery was active.');
        }
      } else {
        this.options.teamMcp.revoke(active.runId);
        this.active.delete(sessionId);
      }
    }
    for (const completion of [...this.completing.values()]) {
      completion.controller.abort();
      this.options.teamMcp.revoke(completion.runId);
      // Keep the completion intent/progress for restart recovery. closed + the abort signal stop
      // the current artifact loop; the next host resumes the same owner-completed result.
    }
    await Promise.allSettled([...this.pending]);
  }
}

function isPathWithinArtifactScope(file: string, scopes: string[]): boolean {
  return scopes.some((scope) => file === scope || file.startsWith(`${scope}/`));
}
