import { createHash, randomUUID } from 'node:crypto';
import {
  EnableTeamOrchestrationSchema, TeamAgentActivityEntrySchema, TeamApprovalDecisionPayloadSchema,
  TeamApprovalRequestPayloadSchema, TeamConsentPayloadSchema, TeamDeliveryPayloadSchema,
  TeamDeliveryStatusPayloadSchema, TeamInterruptPayloadSchema, TeamOrchestrationSettingsSchema,
  TEAM_CONSENT_DISCLAIMER_VERSION, TeamPermissionLevelSchema, TeamStructureChangeSchema, TeamStructurePayloadSchema, TeamToolCallPayloadSchema,
  TeamToolResultPayloadSchema, TeamArtifactRefSchema,
  type ProviderFailure, type TeamAgentRole, type TeamAgentState, type TeamConsentState,
  type TeamLeaderChange, type TeamPermissionLevel, type TeamStructureMember,
  type TeamOrchestrationSettings, type TeamStructureSnapshot,
} from '@mingle/contracts';
import { ProviderFailureSchema, ProviderSchema, TeamStructurePayloadSchema as StructureSchema, TeamDeliveryPayloadSchema as DeliverySchema } from '@mingle/contracts';
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
import { redactSecrets } from '../../providers/common.ts';
import type { ProjectCollaborationSnapshot } from '../../../../../packages/contracts/src/project-collaboration.ts';
import { KeyedLock } from '../../repository/lock.ts';

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
type ProjectContext = ProjectCollaborationSnapshot & {
  project: NonNullable<ProjectCollaborationSnapshot['project']>;
  localProjectId: string; accountId: string; localDeviceId: string; hostDeviceId: string;
  hostAccountId: string; hostDisplayName: string; isHost: boolean;
};

const liveDelivery = (status: string) => ['queued', 'accepted', 'running', 'awaiting-approval'].includes(status);
const rankPermission = (value: TeamPermissionLevel): number => value === 'full-access' ? 1 : 0;
const safeJson = <T>(text: string, fallback: T): T => { try { return JSON.parse(text) as T; } catch { return fallback; } };
const safeArtifactText = (value: string, max: number): string => redactSecrets(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

/** Host-authoritative team settings, proxy run broker and structure snapshot builder. */
export class TeamOrchestrationHost implements TeamProxyRuntimeService {
  private readonly unsubscribe: () => void;
  private readonly active = new Map<string, { runId: string; controller: AbortController }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly chatByDelivery = new Map<string, string>();
  private readonly chatDeliveryCounts = new Map<string, number>();
  private readonly mutations = new KeyedLock();
  private closed = false;
  private readonly now: () => number;
  private readonly deliveryTimeoutMs: number;
  private chat?: TeamOrchestrationChat;

  constructor(private readonly options: {
    store: Store;
    git?: Pick<GitSyncService, 'exportTeamArtifact' | 'importTeamArtifact'>;
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
  }) {
    this.now = options.now ?? Date.now;
    this.deliveryTimeoutMs = Math.min(15 * 60_000, Math.max(1_000, options.deliveryTimeoutMs ?? 90_000));
    this.unsubscribe = options.transport.onMessage((message) => this.onEnvelope(message));
    this.recoverProxyDeliveries();
  }

  private recoverProxyDeliveries(): void {
    const rows = this.hostRows.prepare(`SELECT delivery_id,run_id FROM mingle_team_host_deliveries
      WHERE status IN ('queued','accepted','running','awaiting-approval')`).all() as Array<{ delivery_id: string; run_id: string }>;
    if (!rows.length) return;
    const at = new Date(this.now()).toISOString();
    for (const row of rows) {
      // A host restart never replays an owner-device provider run. It may have completed remotely,
      // but an unacknowledged terminal result is represented as interrupted rather than guessed.
      this.hostRows.prepare(`UPDATE mingle_team_host_deliveries SET status='interrupted',failure_json=?,updated_at=? WHERE delivery_id=?`)
        .run(JSON.stringify({ message: 'The host restarted before receiving a terminal delivery status.' }), at, row.delivery_id);
      this.hostRows.prepare("UPDATE mingle_team_host_approvals SET state='expired' WHERE delivery_id=? AND state='pending'").run(row.delivery_id);
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

  private history(row: HostRow): TeamLeaderChange[] {
    const entries = safeJson<unknown[]>(row.leader_history_json, []);
    return entries.filter((entry): entry is TeamLeaderChange => Boolean(entry && typeof entry === 'object'));
  }

  private async context(projectId: string): Promise<ProjectContext> {
    const localProject = this.options.store.getProject(projectId);
    if (!localProject) throw new HttpError(404, 'Project not found.');
    const [shared, accountId] = await Promise.all([
      this.options.collaboration.snapshot(projectId),
      this.options.account.withAuthenticatedClient(async (_client, user) => user.id),
    ]);
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
    return {
      ...shared, project: shared.project, localProjectId: localProject.id, accountId, localDeviceId: deviceSnapshot.deviceId,
      hostDeviceId, hostAccountId: hostDevice?.ownerId ?? leader.accountId,
      hostDisplayName: shared.members.find((candidate) => candidate.accountId === (hostDevice?.ownerId ?? leader.accountId))?.displayName ?? 'Team lead',
      isHost,
    };
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
    if (!agent || agent.deviceId === context.localDeviceId) return 'granted';
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

  private agentHandle(teamId: string, sharedProjectId: string, agent: ProjectContext['agents'][number], used: Set<string>): string {
    const prior = this.hostRows.prepare(`SELECT handle FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
      .get(teamId, sharedProjectId, agent.id) as { handle?: string } | undefined;
    if (prior?.handle) { used.add(prior.handle); return prior.handle; }
    const provider = (agent.provider ?? 'agent').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'agent';
    for (let number = 1; number <= 999; number++) {
      const handle = `${provider}${number}`.slice(0, 32);
      if (used.has(handle)) continue;
      const collision = this.hostRows.prepare(`SELECT 1 AS found FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND handle=?`)
        .get(teamId, sharedProjectId, handle);
      if (!collision) { used.add(handle); return handle; }
    }
    throw new HttpError(409, `No unique team handle is available for ${agent.name}.`);
  }

  private proxySessionId(teamId: string, sharedProjectId: string, agentId: string): string {
    const digest = createHash('sha256').update(`${teamId}\0${sharedProjectId}\0${agentId}`).digest('hex').slice(0, 32);
    return `proxy_${digest}`;
  }

  private syncSessions(context: ProjectContext, settings: TeamOrchestrationSettings): Array<{ sessionId: string; handle: string; role: 'orchestrator' | 'worker' | 'idle'; held: boolean }> {
    const { teamId, sharedProjectId } = context.project;
    const used = new Set<string>();
    const activeAgents = context.agents.filter((agent) => agent.sessionId && !agent.deviceId.startsWith('revoked:'));
    if (activeAgents.length > 64) throw new HttpError(409, 'A team project supports at most 64 agents.');
    const at = new Date(this.now()).toISOString();
    const result: Array<{ sessionId: string; handle: string; role: 'orchestrator' | 'worker' | 'idle'; held: boolean }> = [];
    for (const agent of activeAgents) {
      const previous = this.hostRows.prepare(`SELECT role,removed_at FROM mingle_team_host_roster WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
        .get(teamId, sharedProjectId, agent.id) as Row | undefined;
      if (previous?.removed_at) continue;
      const handle = this.agentHandle(teamId, sharedProjectId, agent, used);
      const role = (previous?.role === 'idle' || previous?.role === 'worker' || previous?.role === 'orchestrator'
        ? previous.role : agent.id === settings.orchestratorAgentId ? 'orchestrator' : 'worker') as TeamAgentRole;
      if (agent.id === settings.orchestratorAgentId && role !== 'orchestrator') this.hostRows.prepare(`UPDATE mingle_team_host_roster SET role='orchestrator',removed_at=NULL,updated_at=?
        WHERE team_id=? AND shared_project_id=? AND agent_id=?`).run(at, teamId, sharedProjectId, agent.id);
      else this.hostRows.prepare(`INSERT INTO mingle_team_host_roster(team_id,shared_project_id,agent_id,handle,role,removed_at,updated_at)
        VALUES(?,?,?,?,?,NULL,?) ON CONFLICT(team_id,shared_project_id,agent_id) DO UPDATE SET handle=excluded.handle,removed_at=NULL,updated_at=excluded.updated_at`)
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
      if (agent.id !== settings.orchestratorAgentId && role === 'orchestrator') {
        this.hostRows.prepare(`UPDATE mingle_team_host_roster SET role='worker',updated_at=? WHERE team_id=? AND shared_project_id=? AND agent_id=?`).run(at, teamId, sharedProjectId, agent.id);
      }
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
    const settings = TeamOrchestrationSettingsSchema.parse({ ...input, version: 1, updatedAt: new Date(this.now()).toISOString(), updatedByAccountId: context.accountId });
    const groupId = `teamgrp_${randomUUID().replaceAll('-', '')}`;
    const at = new Date(this.now()).toISOString();
    this.options.store.tx(() => {
      const members = this.syncSessions({ ...context, isHost: true }, settings);
      const orchestrator = context.agents.find((agent) => agent.id === settings.orchestratorAgentId)!;
      const orchestratorMember = members.find((member) => member.handle === this.handleFor(teamId, sharedProjectId, orchestrator.id));
      if (!orchestratorMember) throw new HttpError(409, 'The selected orchestrator has no usable local or proxy session.');
      if (orchestrator.deviceId !== context.localDeviceId && !this.isOnline(teamId, orchestrator.deviceId)) {
        throw new HttpError(409, 'The selected remote orchestrator device is offline.');
      }
      this.options.groups.createTeamGroup({ id: groupId, projectId, title: `${context.project.name} team`, orchestratorSessionId: orchestratorMember.sessionId, members });
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
    if (this.options.groups.get(row.group_id).deliveries.some((delivery) => delivery.status === 'running')) {
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
        this.hostRows.prepare(`UPDATE mingle_team_host_consents SET state='needs-reconsent',updated_at=? WHERE team_id=? AND shared_project_id=? AND state='granted'`)
          .run(next.updatedAt, context.project.teamId, context.project.sharedProjectId);
      }
      const synced = this.syncSessions(context, next);
      this.options.groups.syncTeamMembers(row.group_id, synced);
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
    if (this.options.groups.get(row.group_id).deliveries.some((delivery) => delivery.status === 'running')) {
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
      const members = this.syncSessions(context, next);
      this.options.groups.syncTeamMembers(row.group_id, members);
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

  async structure(projectId: string): Promise<TeamStructureSnapshot> {
    const context = await this.context(projectId);
    return this.mutations.run(this.mutationKey(context), () => this.structureSnapshot(projectId));
  }

  private async structureSnapshot(projectId: string): Promise<TeamStructureSnapshot> {
    const context = await this.context(projectId);
    const isHost = context.isHost;
    const ownRow = isHost ? this.readHost(context.project.teamId, context.project.sharedProjectId) : undefined;
    const peerPayload = !ownRow ? this.options.deviceSide?.latestStructure(context.project.sharedProjectId) ?? null : null;
    const payload = peerPayload ? StructureSchema.parse(peerPayload) : null;
    const settings = ownRow ? this.settings(ownRow) : payload?.settings ?? null;
    const row = ownRow;
    if (row && settings && !this.options.groups.get(row.group_id).deliveries.some((delivery) => delivery.status === 'running')) {
      this.options.store.tx(() => this.options.groups.syncTeamMembers(row.group_id, this.syncSessions(context, settings)));
    }
    const hostId = ownRow?.host_device_id ?? payload?.host?.deviceId ?? context.hostDeviceId;
    const hostAccountId = ownRow?.owner_account_id ?? payload?.host?.accountId ?? context.hostAccountId;
    const hostDevice = this.options.transport.snapshot(context.project.teamId).devices.find((device) => device.id === hostId);
    const payloadMembers = new Map(payload?.members.map((member) => [member.agentId, member]) ?? []);
    const rows = row ? this.hostRows.prepare(`SELECT agent_id,handle,role,fallback_rank FROM mingle_team_host_roster
      WHERE team_id=? AND shared_project_id=? AND removed_at IS NULL`).all(context.project.teamId, context.project.sharedProjectId) as Array<{ agent_id: string; handle: string; role: TeamAgentRole; fallback_rank: number | null }>
      : [];
    const roleRows = new Map(rows.map((member) => [member.agent_id, member]));
    const group = row ? this.options.groups.get(row.group_id) : null;
    const members: TeamStructureMember[] = [];
    const localDeviceId = this.options.transport.snapshot(context.project.teamId).deviceId;
    for (const agent of context.agents) {
      if (!agent.sessionId) continue;
      const provider = ProviderSchema.safeParse(agent.provider);
      if (!provider.success) continue;
      const info = roleRows.get(agent.id) ?? payloadMembers.get(agent.id);
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
    return {
      projectId: context.localProjectId, teamId: context.project.teamId, sharedProjectId: context.project.sharedProjectId,
      enabled: Boolean(settings), settings, host: { deviceId: hostId, accountId: hostAccountId, displayName: ownRow ? context.hostDisplayName : payload?.host?.displayName ?? context.hostDisplayName,
        online: Boolean(hostDevice && hostDevice.status === 'online'), isThisDevice: hostId === localDeviceId },
      canEdit: Boolean(isHost && context.members.some((member) => member.accountId === context.accountId && ['leader', 'admin'].includes(member.role))),
      myConsent, members, leaderHistory, needsLeader: row ? row.needs_leader === 1 : payload?.needsLeader ?? false,
      observedAt: new Date(this.now()).toISOString(),
    };
  }

  private taskTitleForDelivery(group: import('@mingle/contracts').GroupSnapshot, deliveryId: string): string | null {
    const assignment = group.assignments.find((candidate) => candidate.deliveryId === deliveryId);
    if (!assignment) return null;
    return this.options.store.getTask(assignment.taskId)?.title ?? null;
  }

  private async broadcastStructure(context: ProjectContext, row: HostRow): Promise<void> {
    const structure = await this.structureSnapshot(context.localProjectId);
    const payload = StructureSchema.parse({
      sharedProjectId: context.project.sharedProjectId, settings: this.settings(row),
      host: { deviceId: row.host_device_id, accountId: row.owner_account_id, displayName: context.hostDisplayName },
      members: structure.members.map((member) => ({ agentId: member.agentId, handle: member.handle, role: member.role, fallbackRank: member.fallbackRank,
        ownerAccountId: member.ownerAccountId, deviceId: member.deviceId, state: member.state, currentTask: member.currentTask, consent: member.consent })),
      leaderHistory: structure.leaderHistory, needsLeader: structure.needsLeader,
    });
    const transport = this.options.transport.snapshot(context.project.teamId);
    const linked = transport.links.filter((link) => link.deviceId === transport.deviceId && link.mutual).map((link) => link.peerDeviceId);
    for (const deviceId of [...new Set(linked)]) {
      if (transport.devices.find((device) => device.id === deviceId)?.status === 'revoked') continue;
      try {
        await this.options.authorizeTeam({ teamId: context.project.teamId, peerDeviceId: deviceId });
        await this.options.transport.send({ teamId: context.project.teamId, toDeviceId: deviceId, kind: 'teamgroup.structure', payload,
          idempotencyKey: `teamgroup-structure:${context.project.sharedProjectId}:${payload.settings.version}:${deviceId}`.slice(0, 200) });
      } catch { /* structure remains saved locally and will be broadcast on the next change */ }
    }
    this.options.store.touch();
    this.options.changed?.();
    void this.options.transport.sync().catch(() => undefined);
  }

  isProxySession(sessionId: string): boolean {
    return Boolean(this.hostRows.prepare('SELECT 1 AS found FROM mingle_team_proxy_sessions WHERE session_id=?').get(sessionId));
  }

  isActive(sessionId: string): boolean { return this.active.has(sessionId); }
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
    const consent = this.hostRows.prepare(`SELECT state,permission_level FROM mingle_team_host_consents WHERE team_id=? AND shared_project_id=? AND agent_id=?`)
      .get(proxy.team_id, proxy.shared_project_id, proxy.agent_id) as Row | undefined;
    const currentConsent = consent && consent.state === 'granted' && TeamPermissionLevelSchema.safeParse(consent.permission_level).success
      && rankPermission(TeamPermissionLevelSchema.parse(consent.permission_level)) >= rankPermission(settings.permissionLevel);
    if (!currentConsent) throw new HttpError(403, 'The remote agent has not granted current consent.');
    if (!this.isOnline(proxy.team_id, proxy.owner_device_id)) throw new HttpError(503, 'The remote agent device is offline.');
    const context = input.context;
    if (!context) throw new HttpError(409, 'Remote team work must belong to a live group delivery.');
    const group = this.options.groups.get(context.groupId);
    const member = group.members.find((candidate) => candidate.id === context.memberId && candidate.sessionId === input.session.id);
    const delivery = group.deliveries.find((candidate) => candidate.id === context.deliveryId && candidate.status === 'running');
    if (!member || !delivery || delivery.requestId !== context.requestId) throw new HttpError(409, 'The group delivery is no longer active.');
    const enabledRole = member.role === 'orchestrator' ? 'orchestrator' : 'worker';
    const basePayload = DeliverySchema.parse({
      sharedProjectId: proxy.shared_project_id, deliveryId: context.deliveryId, groupId: context.groupId,
      requestId: context.requestId, agentId: proxy.agent_id, role: enabledRole,
      kind: delivery.kind ?? 'request', content: input.content.slice(0, 100_000), hop: context.hop,
      permissionLevel: settings.permissionLevel, settingsVersion: settings.version,
      ...(input.options.taskId ? { taskId: input.options.taskId } : {}), inputArtifacts: [], integrationDeviceId: host.host_device_id,
      issuedAt: new Date(this.now()).toISOString(),
    });
    const controller = new AbortController();
    const mcp = this.options.teamMcp.create(input.runId, input.session, controller.signal, context);
    this.active.set(input.session.id, { runId: input.runId, controller });
    const at = new Date(this.now()).toISOString();
    const sourceChatId = this.chatByDelivery.get(context.deliveryId) ?? null;
    this.hostRows.prepare(`INSERT INTO mingle_team_host_deliveries(delivery_id,team_id,shared_project_id,group_id,request_id,agent_id,session_id,
      owner_account_id,owner_device_id,run_id,remote_run_id,status,content,source_chat_message_id,artifacts_json,failure_json,issued_at,timeout_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,NULL,'accepted',?,?, '[]',NULL,?,?,?)`)
      .run(context.deliveryId, proxy.team_id, proxy.shared_project_id, context.groupId, context.requestId, proxy.agent_id, input.session.id,
        proxy.owner_account_id, proxy.owner_device_id, input.runId, basePayload.content, sourceChatId, at, this.now() + this.deliveryTimeoutMs, at);
    const timer = setTimeout(() => this.timeout(context.deliveryId), this.deliveryTimeoutMs);
    timer.unref();
    this.timers.set(context.deliveryId, timer);
    this.track((async () => {
      try {
        await this.options.authorizeTeam({ teamId: proxy.team_id, peerDeviceId: proxy.owner_device_id });
        let baseRevision: string | undefined;
        try {
          const head = (await git(input.session.worktreePath, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
          if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head)) baseRevision = head;
        } catch { /* A delivery can proceed without a transfer base when Git state is unavailable. */ }
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
      artifacts.push(await this.options.git.exportTeamArtifact({
        teamId, sharedProjectId,
        sourceWorktreePath: source.worktreePath, revision: handoff.revision, toDeviceId, deliveryId,
        ...(sessionBase?.base_revision ? { sessionStartRevision: sessionBase.base_revision } : {}),
        taskId: handoff.taskId ?? taskId, path: handoff.path,
      }));
    }
    return artifacts;
  }

  interrupt(sessionId: string): boolean {
    const active = this.active.get(sessionId);
    if (!active) return false;
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
    const hostKinds = ['teamgroup.consent', 'teamgroup.delivery.status', 'teamgroup.tool.call', 'teamgroup.approval.request'];
    if (this.closed || !hostKinds.includes(envelope.kind)) return;
    const localDevice = this.options.transport.snapshot(envelope.teamId).deviceId;
    if (!localDevice || envelope.toDeviceId !== localDevice) throw new HttpError(403, 'Team orchestration envelope is not addressed to this device.');
    if (envelope.kind === 'teamgroup.consent') return this.receiveConsent(envelope);
    if (envelope.kind === 'teamgroup.delivery.status') return this.receiveStatus(envelope);
    if (envelope.kind === 'teamgroup.tool.call') return this.receiveToolCall(envelope);
    if (envelope.kind === 'teamgroup.approval.request') return this.receiveApproval(envelope);
  }

  private async verifyOwnerDevice(teamId: string, deviceId: string, accountId: string): Promise<void> {
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
    if (!project || project.host_device_id !== envelope.toDeviceId) throw new HttpError(403, 'Consent is outside this host project.');
    return this.mutations.run(`${envelope.teamId}\0${parsed.data.sharedProjectId}`,
      () => this.receiveConsentLocked(envelope, parsed.data.sharedProjectId));
  }

  private async receiveConsentLocked(envelope: import('@mingle/contracts').AuthenticatedTransportMessage, sharedProjectId: string): Promise<void> {
    const parsed = TeamConsentPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success || parsed.data.sharedProjectId !== sharedProjectId) throw new HttpError(400, 'Team consent payload is invalid.');
    const project = this.readHost(envelope.teamId, sharedProjectId);
    if (!project || project.host_device_id !== envelope.toDeviceId) throw new HttpError(403, 'Consent is outside this host project.');
    const collaboration = await this.options.collaboration.snapshot(project.local_project_id);
    const senderDevice = this.options.transport.snapshot(envelope.teamId).devices.find((device) => device.id === envelope.fromDeviceId);
    const owner = senderDevice?.ownerId;
    if (!owner) throw new HttpError(403, 'The consent sender device is not registered.');
    await this.verifyOwnerDevice(envelope.teamId, envelope.fromDeviceId, owner);
    const settings = this.settings(project);
    const at = parsed.data.at;
    const eligible = parsed.data.state === 'granted' && parsed.data.disclaimerVersion === TEAM_CONSENT_DISCLAIMER_VERSION
      && rankPermission(parsed.data.permissionLevel) >= rankPermission(settings.permissionLevel) && parsed.data.agentIds.length > 0;
    this.options.store.tx(() => {
      for (const agentId of parsed.data.agentIds) {
        const agent = collaboration.agents.find((candidate) => candidate.id === agentId && candidate.accountId === owner && candidate.deviceId === envelope.fromDeviceId);
        if (!agent) throw new HttpError(403, 'Consent includes an agent that is not published by the sender device.');
        const accepted = parsed.data.state === 'granted' && parsed.data.disclaimerVersion === TEAM_CONSENT_DISCLAIMER_VERSION
          && rankPermission(parsed.data.permissionLevel) >= rankPermission(settings.permissionLevel);
        const state: TeamConsentState = parsed.data.state === 'granted' && !accepted ? 'needs-reconsent' : parsed.data.state;
        this.hostRows.prepare(`INSERT INTO mingle_team_host_consents(team_id,shared_project_id,agent_id,owner_account_id,owner_device_id,state,
          permission_level,settings_version,disclaimer_version,accepted_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(team_id,shared_project_id,agent_id) DO UPDATE SET owner_account_id=excluded.owner_account_id,owner_device_id=excluded.owner_device_id,
          state=excluded.state,permission_level=excluded.permission_level,settings_version=excluded.settings_version,disclaimer_version=excluded.disclaimer_version,
          accepted_at=excluded.accepted_at,updated_at=excluded.updated_at`)
          .run(envelope.teamId, parsed.data.sharedProjectId, agentId, owner, envelope.fromDeviceId, state, parsed.data.permissionLevel,
            parsed.data.settingsVersion, parsed.data.disclaimerVersion, at, at);
      }
      if (!this.options.groups.get(project.group_id).deliveries.some((delivery) => delivery.status === 'running')) {
        const members = this.syncSessions({ ...collaboration, project: collaboration.project!, localProjectId: project.local_project_id,
          accountId: project.owner_account_id, localDeviceId: project.host_device_id, hostDeviceId: project.host_device_id, hostAccountId: project.owner_account_id,
          hostDisplayName: 'Team lead', isHost: true }, settings);
        this.options.groups.syncTeamMembers(project.group_id, members);
      }
    });
    const context = await this.context(project.local_project_id);
    await this.broadcastStructure(context, project);
    if (eligible) this.options.groups.pumpTeamGroup(project.group_id);
  }

  private delivery(deliveryId: string): DeliveryRow | undefined {
    return this.hostRows.prepare('SELECT * FROM mingle_team_host_deliveries WHERE delivery_id=?').get(deliveryId) as DeliveryRow | undefined;
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
      || delivery.owner_device_id !== envelope.fromDeviceId || delivery.agent_id !== parsed.data.agentId || !liveDelivery(delivery.status)) return;
    if (parsed.data.status === 'accepted' || parsed.data.status === 'running' || parsed.data.status === 'awaiting-approval') {
      const priorStatuses = parsed.data.status === 'running' ? ['accepted', 'awaiting-approval']
        : parsed.data.status === 'awaiting-approval' ? ['running'] : [];
      if (!priorStatuses.length) return;
      const placeholders = priorStatuses.map(() => '?').join(',');
      const changed = this.hostRows.prepare(`UPDATE mingle_team_host_deliveries SET status=?,remote_run_id=COALESCE(?,remote_run_id),updated_at=?
        WHERE delivery_id=? AND status IN (${placeholders})`)
        .run(parsed.data.status, parsed.data.runId, parsed.data.at, delivery.delivery_id, ...priorStatuses);
      if (Number(changed.changes) !== 1) return;
      this.options.store.updateSession(delivery.session_id, { status: parsed.data.status === 'awaiting-approval' ? 'waiting' : 'running' });
      this.options.store.touch();
      return;
    }
    const failure = parsed.data.failure ? ProviderFailureSchema.parse({ ...parsed.data.failure, sessionId: delivery.session_id, runId: delivery.run_id,
      message: redactSecrets(parsed.data.failure.message).slice(0, 1000),
      ...(parsed.data.failure.providerCode ? { providerCode: redactSecrets(parsed.data.failure.providerCode).slice(0, 100) } : {}),
      ...(parsed.data.failure.quotaPool ? { quotaPool: redactSecrets(parsed.data.failure.quotaPool).slice(0, 100) } : {}),
    }) : undefined;
    const outcome = parsed.data.status === 'completed' ? 'completed' : parsed.data.status === 'interrupted' ? 'interrupted' : 'failed';
    const rejection = parsed.data.status === 'rejected' ? `Remote agent rejected delivery: ${parsed.data.rejection ?? 'invalid'}` : undefined;
    const failureJson = failure ? JSON.stringify(failure) : rejection ? JSON.stringify({ message: redactSecrets(rejection).slice(0, 500) }) : null;
    const claimed = this.hostRows.prepare(`UPDATE mingle_team_host_deliveries SET status=?,failure_json=?,remote_run_id=COALESCE(?,remote_run_id),updated_at=?
      WHERE delivery_id=? AND status IN ('queued','accepted','running','awaiting-approval')`)
      .run(outcome, failureJson, parsed.data.runId, parsed.data.at, delivery.delivery_id);
    if (Number(claimed.changes) !== 1) return;

    if (parsed.data.status === 'completed') {
      // The remote provider has finished. Close the proxy run before taking the project Git lease
      // for ref-only imports, so other host sessions cannot race the repository mutation.
      const run = this.options.store.getRun(delivery.run_id);
      this.options.store.finishRun(delivery.run_id, 'completed', run ? Math.max(0, this.now() - Date.parse(run.startedAt)) : null, parsed.data.at);
      this.options.store.updateSession(delivery.session_id, { status: 'idle', error: null });
      this.options.recovery.clearFailure(delivery.session_id);
      const importedArtifacts: import('@mingle/contracts').TeamArtifactRef[] = [];
      const artifactFailures: string[] = [];
      for (const untrustedArtifact of parsed.data.artifacts) {
        const artifact = TeamArtifactRefSchema.parse(untrustedArtifact);
        try {
          if (!this.options.git) throw new Error('Git artifact import is unavailable on the host.');
          importedArtifacts.push(await this.options.git.importTeamArtifact({ teamId: delivery.team_id,
            sharedProjectId: delivery.shared_project_id, deliveryId: delivery.delivery_id, artifact,
            sourceDeviceId: envelope.fromDeviceId }));
        } catch (error) {
          artifactFailures.push(redactSecrets(error instanceof Error ? error.message : 'Artifact import failed.').slice(0, 500));
        }
      }
      this.hostRows.prepare('UPDATE mingle_team_host_deliveries SET artifacts_json=? WHERE delivery_id=? AND status=\'completed\'')
        .run(JSON.stringify(importedArtifacts), delivery.delivery_id);
      const artifactSummary = importedArtifacts.length
        ? `\n\nImported committed artifacts (isolated refs; not merged):\n${importedArtifacts.map((artifact) =>
          `- ${safeArtifactText(artifact.path ?? 'committed artifact', 120)} @ ${artifact.revision}${artifact.taskId ? ` (task ${safeArtifactText(artifact.taskId, 80)})` : ''}\n  Git ref: ${safeArtifactText(artifact.ref ?? '', 255)}`,
        ).join('\n')}` : '';
      const failureSummary = artifactFailures.length ? `\n\nArtifact import failures:\n${artifactFailures.map((failure) => `- ${failure}`).join('\n')}`.slice(0, 15_000) : '';
      const finalBudget = Math.max(0, 50_000 - artifactSummary.length - failureSummary.length);
      const finalText = `${parsed.data.finalText ? redactSecrets(parsed.data.finalText).slice(0, finalBudget) : ''}${artifactSummary}${failureSummary}`;
      if (finalText) this.options.store.insertMessage({ sessionId: delivery.session_id, runId: delivery.run_id, role: 'assistant', content: finalText });
      this.finishClaimedDelivery(delivery, 'completed', undefined, undefined, parsed.data.at);
      const project = this.readHost(delivery.team_id, delivery.shared_project_id);
      if (delivery.source_chat_message_id && this.chat && delivery.owner_device_id === this.options.transport.snapshot(delivery.team_id).deviceId && finalText && project) {
        await this.chat.postOrchestratedAgentReply({ projectId: project.local_project_id, sourceMessageId: delivery.source_chat_message_id, agentId: delivery.agent_id, content: finalText });
      }
      return;
    }
    if (failure) this.options.recovery.recordFailure(delivery.session_id, delivery.run_id, failure);
    this.finishClaimedDelivery(delivery, outcome, failure, rejection, parsed.data.at);
    if (failure?.kind === 'quota_exhausted') await this.promoteFallback(delivery.team_id, delivery.shared_project_id, 'fallback-quota');
  }

  private async finishDelivery(deliveryId: string, outcome: 'completed' | 'failed' | 'interrupted', failure?: ProviderFailure, message?: string, at = new Date(this.now()).toISOString(), remoteRunId?: string | null): Promise<void> {
    const delivery = this.delivery(deliveryId);
    if (!delivery || !liveDelivery(delivery.status)) return;
    const changed = this.hostRows.prepare(`UPDATE mingle_team_host_deliveries SET status=?,failure_json=?,remote_run_id=COALESCE(?,remote_run_id),updated_at=?
      WHERE delivery_id=? AND status IN ('queued','accepted','running','awaiting-approval')`)
      .run(outcome, failure ? JSON.stringify(failure) : message ? JSON.stringify({ message: redactSecrets(message).slice(0, 500) }) : null,
        remoteRunId ?? null, at, deliveryId);
    if (Number(changed.changes) !== 1) return;
    this.finishClaimedDelivery(delivery, outcome, failure, message, at);
  }

  private finishClaimedDelivery(delivery: DeliveryRow, outcome: 'completed' | 'failed' | 'interrupted', failure?: ProviderFailure, message?: string, at = new Date(this.now()).toISOString()): void {
    const deliveryId = delivery.delivery_id;
    const timer = this.timers.get(deliveryId);
    if (timer) clearTimeout(timer);
    this.timers.delete(deliveryId);
    const current = this.active.get(delivery.session_id);
    if (current?.runId === delivery.run_id) {
      current.controller.abort();
      this.active.delete(delivery.session_id);
    }
    this.options.teamMcp.revoke(delivery.run_id);
    this.expireApprovals(delivery);
    const run = this.options.store.getRun(delivery.run_id);
    if (run?.status === 'running' && outcome !== 'completed') {
      this.options.store.finishRun(delivery.run_id, outcome, Math.max(0, this.now() - Date.parse(run.startedAt)), at);
    }
    if (outcome !== 'completed') this.options.store.updateSession(delivery.session_id, { status: outcome === 'interrupted' ? 'interrupted' : 'error', error: redactSecrets(message ?? failure?.message ?? 'Remote team delivery failed').slice(0, 1000) });
    if (message && outcome !== 'completed') this.options.store.insertMessage({ sessionId: delivery.session_id, runId: delivery.run_id, role: 'system', kind: 'error', content: redactSecrets(message).slice(0, 1000) });
    if (delivery.request_id && delivery.group_id) this.options.groups.onRunFinished(delivery.session_id, delivery.run_id, outcome);
    this.options.store.recordEvent({ projectId: this.options.store.getSession(delivery.session_id, true)?.projectId ?? null, sessionId: delivery.session_id,
      type: `team.delivery.${outcome}`, summary: `Remote team delivery ${outcome}`, payload: { deliveryId, agentId: delivery.agent_id, failure: failure ?? null } });
    this.options.store.touch();
    if (failure?.kind === 'quota_exhausted') this.options.store.updateSession(delivery.session_id, { error: failure.message });
    if (delivery.source_chat_message_id) this.finishChatDelivery(delivery.delivery_id, delivery.source_chat_message_id, outcome);
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
    if (!sourceMessageId) return;
    const output = input.outcome === 'completed'
      ? this.options.store.listMessages(input.sessionId, { limit: 2_000 }).filter((message) => message.runId === input.runId && message.role === 'assistant' && message.kind !== 'streaming')
        .map((message) => message.content).join('\n\n').trim()
      : '';
    const content = redactSecrets(output).slice(0, 20_000);
    const session = this.options.store.getSession(input.sessionId, true);
    if (session && content && this.chat) this.track(this.options.collaboration.snapshot(session.projectId).then(async (collaboration) => {
      const teamId = collaboration.project?.teamId;
      const localDeviceId = teamId ? this.options.transport.snapshot(teamId).deviceId : null;
      const agent = collaboration.agents.find((candidate) => candidate.sessionId === input.sessionId && candidate.deviceId === localDeviceId);
      if (agent && this.chat) await this.chat.postOrchestratedAgentReply({ projectId: session.projectId, sourceMessageId, agentId: agent.id, content });
    }).catch(() => undefined));
    this.finishChatDelivery(input.deliveryId, sourceMessageId, input.outcome);
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
    if (!delivery || !liveDelivery(delivery.status) || delivery.timeout_at > this.now()) return;
    const interrupt = TeamInterruptPayloadSchema.parse({ sharedProjectId: delivery.shared_project_id, deliveryId, reason: 'The host delivery timed out.' });
    this.track(this.options.transport.send({ teamId: delivery.team_id, toDeviceId: delivery.owner_device_id, kind: 'teamgroup.interrupt', payload: interrupt,
      idempotencyKey: `teamgroup-interrupt:${deliveryId}:timeout`.slice(0, 200) }).then(() => this.options.transport.sync()).catch(() => undefined));
    const row = this.readHost(delivery.team_id, delivery.shared_project_id);
    const wasLeader = row ? this.settings(row).orchestratorAgentId === delivery.agent_id : false;
    void this.finishDelivery(deliveryId, 'failed', undefined, 'The remote agent timed out; it is marked offline.')
      .then(() => wasLeader ? this.promoteFallback(delivery.team_id, delivery.shared_project_id, 'fallback-offline') : undefined);
  }

  private async receiveToolCall(envelope: import('@mingle/contracts').AuthenticatedTransportMessage): Promise<void> {
    const parsed = TeamToolCallPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) throw new HttpError(400, 'Team tool call payload is invalid.');
    const delivery = this.delivery(parsed.data.deliveryId);
    if (!delivery || delivery.team_id !== envelope.teamId || delivery.shared_project_id !== parsed.data.sharedProjectId || !liveDelivery(delivery.status)) {
      throw new HttpError(404, 'The team tool call delivery is unknown or finished.');
    }
    if (delivery.owner_device_id !== envelope.fromDeviceId || delivery.agent_id !== parsed.data.agentId) throw new HttpError(403, 'The team tool call came from a different device or agent.');
    await this.verifyOwnerDevice(delivery.team_id, envelope.fromDeviceId, delivery.owner_account_id);
    const active = this.active.get(delivery.session_id);
    if (!active || active.runId !== delivery.run_id) throw new HttpError(409, 'The team tool call run is no longer active.');
    let result: unknown;
    let error: string | undefined;
    try { result = await this.options.teamMcp.callRemote(delivery.run_id, delivery.session_id, parsed.data.tool, parsed.data.args); }
    catch (cause) { error = redactSecrets(cause instanceof Error ? cause.message : 'Team tool call failed').slice(0, 2_000); }
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
          this.options.groups.syncTeamMembers(row.group_id, this.syncSessions(context, next));
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
    if (!row || !context.isHost) return 'handled';
    const settings = this.settings(row);
    const agents = message.mentions.map((id) => context.agents.find((agent) => agent.id === id));
    if (agents.some((agent) => !agent || !this.handleFor(context.project.teamId, context.project.sharedProjectId, agent.id))) {
      throw new HttpError(400, 'A mentioned agent is not part of the active team structure.');
    }
    if (!message.mentions.length && !settings.leaderOrchestration) return 'handled';
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
    // Activity persistence belongs to the device mirror. This method intentionally only provides a validated boundary hook.
    const parsed = TeamAgentActivityEntrySchema.safeParse(payload);
    if (!parsed.success) throw new HttpError(400, 'Team activity entry is invalid.');
    await this.options.authorizeTeam({ teamId: envelope.teamId, peerDeviceId: envelope.fromDeviceId });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const [sessionId, active] of [...this.active]) {
      active.controller.abort();
      const delivery = this.hostRows.prepare('SELECT delivery_id,team_id,shared_project_id,owner_device_id FROM mingle_team_host_deliveries WHERE run_id=?')
        .get(active.runId) as { delivery_id?: string; team_id?: string; shared_project_id?: string; owner_device_id?: string } | undefined;
      if (delivery?.delivery_id && delivery.team_id && delivery.shared_project_id && delivery.owner_device_id) {
        const payload = TeamInterruptPayloadSchema.parse({ sharedProjectId: delivery.shared_project_id, deliveryId: delivery.delivery_id, reason: 'The host is shutting down.' });
        try {
          await this.options.transport.send({ teamId: delivery.team_id, toDeviceId: delivery.owner_device_id, kind: 'teamgroup.interrupt', payload,
            idempotencyKey: `teamgroup-interrupt:${delivery.delivery_id}:shutdown`.slice(0, 200) });
          await this.options.transport.sync();
        } catch { /* durable host run is still interrupted locally */ }
        await this.finishDelivery(delivery.delivery_id, 'interrupted', undefined, 'The host shut down while this remote delivery was active.');
      } else {
        this.options.teamMcp.revoke(active.runId);
        this.active.delete(sessionId);
      }
    }
    await Promise.allSettled([...this.pending]);
  }
}
