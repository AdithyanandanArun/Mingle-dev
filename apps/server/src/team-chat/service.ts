import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  TeamChatAgent, TeamChatAuthor, TeamChatMessage, TeamChatPeer, TeamChatSnapshot, TeamChatSyncRequest,
  TeamChatSyncResponse,
} from '../../../../packages/contracts/src/team-chat.ts';
import {
  SendTeamChatMessageSchema, TeamChatAuthorSchema, TeamChatMessageSchema, TeamChatSnapshotSchema, TeamChatSyncRequestSchema, TeamChatSyncResponseSchema,
} from '../../../../packages/contracts/src/team-chat.ts';
import type { AccountService } from '../account/service.ts';
import type { DistributedWorkspaceService } from '../distributed/service.ts';
import type { Store } from '../store.ts';
import type { ProjectCollaborationService } from '../project-collaboration/service.ts';
import type { TeamChatOrchestrationMessage } from '../team-orchestration/types.ts';
import { HttpError, notFound, nowIso, redactSecrets } from '../util.ts';
import { canonicalJson, fingerprintForPublicKeys, verifyDevicePayload } from '../distributed/crypto.ts';

type DbRow = Record<string, unknown>;
type SharedSnapshot = Awaited<ReturnType<ProjectCollaborationService['snapshot']>>;

const SYNC_BYTE_LIMIT = 180 * 1024;
const SYNC_MESSAGE_LIMIT = 200;
const SYNC_OPEN_COOLDOWN_MS = 30_000;
const SYNC_REQUEST_EXPIRY_MS = 120_000;
const SYNC_RESPONSE_RATE_WINDOW_MS = 120_000;
const SYNC_RESPONSE_BATCH_RATE_LIMIT = 200;
const MAX_PENDING_SYNC_REQUESTS = 500;
const MAX_SYNC_RATE_KEYS = 1_000;
const PROJECT_HISTORY_MESSAGE_LIMIT = 10_000;

interface PendingSyncRequest {
  teamId: string;
  sharedProjectId: string;
  peerDeviceId: string;
  expiresAt: number;
  batchCount: number | null;
  batches: Set<number>;
  messageCount: number;
}

function signingPayload(message: TeamChatMessage, authorDeviceId: string): string {
  const author = message.author.kind === 'human'
    ? { kind: 'human', accountId: message.author.accountId }
    : { kind: 'agent', agentId: message.author.agentId, ownerAccountId: message.author.ownerAccountId };
  return canonicalJson({
    domain: 'mingle-team-chat-message-v1', id: message.id, teamId: message.teamId,
    sharedProjectId: message.sharedProjectId, author, body: message.body,
    mentions: message.mentions, replyTo: message.replyTo ?? null, createdAt: message.createdAt,
    source: message.source ?? null, authorDeviceId,
  });
}

function memberDisplayName(members: Array<{ accountId: string; displayName: string | null }>, accountId: string): string {
  const name = members.find((member) => member.accountId === accountId)?.displayName?.trim();
  return name ? name.slice(0, 120) : `Teammate ${accountId.slice(0, 8)}`;
}

function jsonParse<T>(text: unknown): T {
  if (typeof text !== 'string') throw new HttpError(500, 'Stored team chat data is invalid.');
  try { return JSON.parse(text) as T; } catch { throw new HttpError(500, 'Stored team chat data is invalid.'); }
}

function sortMessages(messages: TeamChatMessage[]): TeamChatMessage[] {
  return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function runRank(state: TeamChatMessage['runState']): number {
  return state === 'completed' || state === 'failed' || state === 'interrupted' ? 3
    : state === 'awaiting-approval' ? 2 : state === 'running' ? 1 : state === 'queued' ? 0 : -1;
}

/** Local persistence and authenticated mailbox synchronization for one bound shared project. */
export class TeamChatService {
  private readonly unsubscribe: () => void;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly agentReplyFlights = new Map<string, { fingerprint: string; promise: Promise<TeamChatMessage> }>();
  private readonly sessionMirrorFlights = new Map<string, { fingerprint: string; promise: Promise<TeamChatMessage | null> }>();
  private readonly syncRequestedAt = new Map<string, number>();
  private readonly pendingSyncRequests = new Map<string, PendingSyncRequest>();
  private readonly syncRequestRates = new Map<string, number>();
  private readonly syncResponseRates = new Map<string, number[]>();
  private orchestration?: { routeTeamChatMessage(projectId: string, message: TeamChatOrchestrationMessage): Promise<'routed' | 'handled' | false> };

  constructor(private readonly options: {
    store: Store; account: AccountService; distributed: DistributedWorkspaceService;
    collaboration: ProjectCollaborationService; now?: () => number;
  }) {
    this.unsubscribe = options.distributed.transport.onMessage((envelope) => this.onEnvelope(envelope));
    this.now = options.now ?? Date.now;
  }

  private readonly now: () => number;

  setOrchestration(service: { routeTeamChatMessage(projectId: string, message: TeamChatOrchestrationMessage): Promise<'routed' | 'handled' | false> }): void {
    this.orchestration = service;
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => undefined);
    return work;
  }

  private notifyTeamChatUpdated(teamId: string, sharedProjectId: string): void {
    const project = this.options.store.db.prepare(`SELECT local_project_id FROM mingle_project_collaboration_sources
      WHERE team_id=? AND shared_project_id=? UNION ALL SELECT local_project_id FROM mingle_project_collaboration_joins
      WHERE team_id=? AND shared_project_id=? LIMIT 1`).get(teamId, sharedProjectId, teamId, sharedProjectId) as DbRow | undefined;
    if (project && typeof project.local_project_id === 'string') {
      this.options.store.recordEvent({ projectId: project.local_project_id, type: 'team.chat.updated', summary: 'Shared team chat updated',
        payload: { sharedProjectId } });
    } else this.options.store.touch();
  }

  private ensureOpen(): void {
    if (this.closed) throw new HttpError(503, 'Team chat is closing.');
  }

  private async binding(projectId: string) {
    this.ensureOpen();
    const project = this.options.store.getProject(projectId);
    if (!project) throw notFound('Project not found.');
    const shared = await this.options.collaboration.snapshot(projectId);
    if (!shared.project) throw new HttpError(409, 'Set up teammate sharing for this project before opening team chat.');
    return { localProject: project, shared };
  }

  /** Resolves only persisted local authority so accepting a message never waits for cloud verification. */
  private localSendContext(projectId: string): {
    teamId: string; sharedProjectId: string; accountId: string; displayName: string; deviceId: string;
  } {
    const user = this.options.account.snapshot().user;
    if (!user?.id || this.options.account.snapshot().status !== 'signed-in') {
      throw new HttpError(401, 'Sign in to the Mingle account before sending team chat.');
    }
    if (!this.options.store.getProject(projectId)) throw notFound('Project not found.');

    const source = this.options.store.db.prepare(`SELECT owner_id,team_id,shared_project_id,leader_device_id
      FROM mingle_project_collaboration_sources WHERE local_project_id=?`).get(projectId) as DbRow | undefined;
    let teamId: string | null = null;
    let sharedProjectId: string | null = null;
    let expectedDeviceId: string | null = null;
    if (source) {
      if (String(source.owner_id) !== user.id) throw new HttpError(403, 'This shared project belongs to another Mingle account.');
      teamId = String(source.team_id);
      sharedProjectId = String(source.shared_project_id);
      expectedDeviceId = typeof source.leader_device_id === 'string' ? source.leader_device_id : null;
    } else {
      const joins = this.options.store.db.prepare(`SELECT team_id,shared_project_id,device_id FROM mingle_project_collaboration_joins
        WHERE local_project_id=? AND account_id=? ORDER BY created_at DESC`).all(projectId, user.id) as DbRow[];
      for (const row of joins) {
        const candidateTeamId = String(row.team_id);
        const deviceId = this.options.distributed.transport.snapshot(candidateTeamId).deviceId;
        if (!deviceId || deviceId !== row.device_id) continue;
        teamId = candidateTeamId;
        sharedProjectId = String(row.shared_project_id);
        expectedDeviceId = deviceId;
        break;
      }
    }
    if (!teamId || !sharedProjectId) throw new HttpError(409, 'Bind this project to a shared team before sending team chat.');
    const deviceId = this.options.distributed.transport.snapshot(teamId).deviceId;
    if (!deviceId || (expectedDeviceId && expectedDeviceId !== deviceId)) {
      throw new HttpError(409, 'Register this device with the shared project team before sending team chat.');
    }
    return { teamId, sharedProjectId, accountId: user.id,
      displayName: user.name?.trim().slice(0, 120) || `Teammate ${user.id.slice(0, 8)}`, deviceId };
  }

  private async validateLocalHumanMessage(projectId: string, message: TeamChatMessage): Promise<void> {
    const { shared } = await this.binding(projectId);
    const project = shared.project!;
    if (project.teamId !== message.teamId || project.sharedProjectId !== message.sharedProjectId) {
      throw new HttpError(409, 'The project team changed before the message could be delivered.');
    }
    const [accountId, transport] = await Promise.all([
      this.options.account.withAuthenticatedClient(async (_client, user) => user.id),
      Promise.resolve(this.options.distributed.transport.snapshot(project.teamId)),
    ]);
    if (message.author.kind !== 'human' || message.author.accountId !== accountId || !transport.deviceId
      || message.authorDeviceId !== transport.deviceId) {
      throw new HttpError(403, 'The signed-in team account or registered device changed before message delivery.');
    }
    const roster = this.teamAgents(shared.agents, accountId, transport.deviceId);
    const known = new Set(roster.map((agent) => agent.id));
    if (message.mentions.some((id) => !known.has(id))) {
      throw new HttpError(400, 'Choose an agent from the current shared-project roster.');
    }
  }

  private setDeliveryState(messageId: string, state: TeamChatMessage['deliveryState']): void {
    const row = this.options.store.db.prepare('SELECT delivery_state,team_id,shared_project_id FROM team_chat_messages WHERE id=?').get(messageId) as DbRow | undefined;
    if (row && row.delivery_state !== state) {
      this.options.store.db.prepare('UPDATE team_chat_messages SET delivery_state=? WHERE id=?').run(state, messageId);
      this.notifyTeamChatUpdated(String(row.team_id), String(row.shared_project_id));
    }
  }

  private rowMessage(row: DbRow): TeamChatMessage {
    return TeamChatMessageSchema.parse({
      id: row.id, teamId: row.team_id, sharedProjectId: row.shared_project_id,
      author: jsonParse(row.author_json), body: row.body, mentions: jsonParse(row.mentions_json),
      ...(row.reply_to ? { replyTo: row.reply_to } : {}), createdAt: row.created_at,
      ...(typeof row.author_device_id === 'string' && typeof row.author_signature === 'string'
        ? { authorDeviceId: row.author_device_id, authorSignature: row.author_signature } : {}),
      deliveryState: row.delivery_state, runState: row.run_state ?? null,
      ...(row.source_session_id && row.source_message_id ? { source: { sessionId: row.source_session_id, messageId: row.source_message_id } } : {}),
    });
  }

  private listMessages(teamId: string, sharedProjectId: string, options: { limit: number; before?: string } ): { messages: TeamChatMessage[]; hasMore: boolean; nextBefore: string | null } {
    const beforeRow = options.before ? this.options.store.db.prepare(`SELECT created_at,id FROM team_chat_messages
      WHERE team_id=? AND shared_project_id=? AND id=?`).get(teamId, sharedProjectId, options.before) as DbRow | undefined : undefined;
    const rows = beforeRow
      ? this.options.store.db.prepare(`SELECT * FROM team_chat_messages WHERE team_id=? AND shared_project_id=?
        AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC,id DESC LIMIT ?`)
        .all(teamId, sharedProjectId, String(beforeRow.created_at), String(beforeRow.created_at), String(beforeRow.id), options.limit + 1) as DbRow[]
      : this.options.store.db.prepare(`SELECT * FROM team_chat_messages WHERE team_id=? AND shared_project_id=?
        ORDER BY created_at DESC,id DESC LIMIT ?`).all(teamId, sharedProjectId, options.limit + 1) as DbRow[];
    const hasMore = rows.length > options.limit;
    const messages = sortMessages(rows.slice(0, options.limit).map((row) => this.rowMessage(row)));
    return { messages, hasMore, nextBefore: hasMore ? messages[0]?.id ?? null : null };
  }

  private latestMessage(teamId: string, sharedProjectId: string): TeamChatMessage | null {
    const row = this.options.store.db.prepare(`SELECT * FROM team_chat_messages WHERE team_id=? AND shared_project_id=?
      ORDER BY created_at DESC,id DESC LIMIT 1`).get(teamId, sharedProjectId) as DbRow | undefined;
    return row ? this.rowMessage(row) : null;
  }

  async snapshot(projectId: string, page: { limit: number; before?: string }): Promise<TeamChatSnapshot> {
    const { localProject, shared } = await this.binding(projectId);
    const project = shared.project!;
    const transport = this.options.distributed.transport.snapshot(project.teamId);
    const peers: TeamChatPeer[] = transport.devices.filter((device) => device.id !== transport.deviceId).map((device) => ({
      deviceId: device.id, ownerAccountId: device.ownerId, name: device.name, status: device.status,
      linked: transport.links.some((link) => link.deviceId === transport.deviceId && link.peerDeviceId === device.id && link.mutual),
    }));
    const currentAccountId = await this.options.account.withAuthenticatedClient(async (_client, user) => user.id);
    const members = shared.members.map((member) => ({
      accountId: member.accountId,
      displayName: (member.displayName?.trim() || `Teammate ${member.accountId.slice(0, 8)}`).slice(0, 120),
      role: member.role,
    }));
    const agents = this.teamAgents(shared.agents, currentAccountId, transport.deviceId);
    const pageResult = this.listMessages(project.teamId, project.sharedProjectId, page);
    this.requestBackfill(project.teamId, project.sharedProjectId, transport.deviceId, pageResult.messages).catch(() => undefined);
    return TeamChatSnapshotSchema.parse({
      project: { teamId: project.teamId, sharedProjectId: project.sharedProjectId, name: project.name },
      ...pageResult, members, agents,
      transport: {
        status: transport.status, error: transport.error?.slice(0, 500) ?? null, localDeviceId: transport.deviceId,
        linkedDeviceCount: peers.filter((peer) => peer.linked && peer.status !== 'revoked').length,
        onlineDeviceCount: peers.filter((peer) => peer.linked && peer.status === 'online').length,
        peers,
      },
    });
  }

  private requestBackfill(teamId: string, sharedProjectId: string, localDeviceId: string | null, messages: TeamChatMessage[]): Promise<void> {
    if (!localDeviceId) return Promise.resolve();
    const key = `${teamId}:${sharedProjectId}`;
    const last = this.syncRequestedAt.get(key) ?? 0;
    if (this.now() - last < SYNC_OPEN_COOLDOWN_MS) return Promise.resolve();
    if (!this.syncRequestedAt.has(key) && this.syncRequestedAt.size >= MAX_SYNC_RATE_KEYS) {
      const oldestKey = [...this.syncRequestedAt].sort((left, right) => left[1] - right[1])[0]?.[0];
      if (oldestKey) this.syncRequestedAt.delete(oldestKey);
    }
    this.syncRequestedAt.set(key, this.now());
    const latestAt = messages.at(-1)?.createdAt ?? this.latestMessage(teamId, sharedProjectId)?.createdAt ?? null;
    // Include the entire millisecond for concurrent writers; message IDs break timestamp ties locally.
    const since = latestAt ? new Date(Math.max(0, Date.parse(latestAt) - 1)).toISOString() : null;
    const payload: TeamChatSyncRequest = TeamChatSyncRequestSchema.parse({ sharedProjectId, requestId: randomUUID(), since });
    const prepared = new Map<string, string>();
    return this.sendToPeers(teamId, payload.sharedProjectId, 'teamchat.sync.request', payload,
      `sync-request:${payload.requestId}`, localDeviceId, (peerDeviceIds) => {
        this.expireSyncRequests();
        const eligible = peerDeviceIds.filter((peerDeviceId) => {
          if ([...this.pendingSyncRequests.values()].some((entry) => entry.teamId === teamId && entry.sharedProjectId === sharedProjectId && entry.peerDeviceId === peerDeviceId)) return false;
          if (this.pendingSyncRequests.size >= MAX_PENDING_SYNC_REQUESTS) return false;
          const requestKey = this.pendingSyncKey(teamId, sharedProjectId, peerDeviceId, payload.requestId);
          this.pendingSyncRequests.set(requestKey, {
            teamId, sharedProjectId, peerDeviceId, expiresAt: this.now() + SYNC_REQUEST_EXPIRY_MS,
            batchCount: null, batches: new Set(), messageCount: 0,
          });
          prepared.set(peerDeviceId, requestKey);
          return true;
        });
        return eligible;
      }, true).then((succeeded) => {
        for (const [peerDeviceId, requestKey] of prepared) if (!succeeded.includes(peerDeviceId)) this.pendingSyncRequests.delete(requestKey);
      }).catch((error: unknown) => {
        for (const requestKey of prepared.values()) this.pendingSyncRequests.delete(requestKey);
        throw error;
      });
  }

  private pendingSyncKey(teamId: string, sharedProjectId: string, peerDeviceId: string, requestId: string): string {
    return `${teamId}:${sharedProjectId}:${peerDeviceId}:${requestId}`;
  }

  private expireSyncRequests(): void {
    const at = this.now();
    for (const [key, pending] of this.pendingSyncRequests) if (pending.expiresAt <= at) this.pendingSyncRequests.delete(key);
  }

  private allowSyncRequest(teamId: string, sharedProjectId: string, peerDeviceId: string): boolean {
    const key = `${teamId}:${sharedProjectId}:${peerDeviceId}`;
    const at = this.now();
    for (const [rateKey, last] of this.syncRequestRates) if (at - last >= SYNC_OPEN_COOLDOWN_MS) this.syncRequestRates.delete(rateKey);
    const last = this.syncRequestRates.get(key);
    if (last !== undefined && at - last < SYNC_OPEN_COOLDOWN_MS) return false;
    if (!this.syncRequestRates.has(key) && this.syncRequestRates.size >= MAX_SYNC_RATE_KEYS) return false;
    this.syncRequestRates.set(key, at);
    return true;
  }

  private allowSyncResponse(teamId: string, peerDeviceId: string): boolean {
    const key = `${teamId}:${peerDeviceId}`;
    const at = this.now();
    for (const [rateKey, entries] of this.syncResponseRates) {
      const fresh = entries.filter((entryAt) => at - entryAt < SYNC_RESPONSE_RATE_WINDOW_MS);
      if (fresh.length) this.syncResponseRates.set(rateKey, fresh);
      else this.syncResponseRates.delete(rateKey);
    }
    const current = this.syncResponseRates.get(key) ?? [];
    const recent = current.filter((entryAt) => at - entryAt < SYNC_RESPONSE_RATE_WINDOW_MS);
    if (recent.length >= SYNC_RESPONSE_BATCH_RATE_LIMIT) return false;
    if (!this.syncResponseRates.has(key) && this.syncResponseRates.size >= MAX_SYNC_RATE_KEYS) return false;
    recent.push(at);
    this.syncResponseRates.set(key, recent);
    return true;
  }

  private async localAuthor(members: Array<{ accountId: string; displayName: string | null }>): Promise<TeamChatAuthor> {
    return this.options.account.withAuthenticatedClient(async (_client, user) => ({
      kind: 'human', accountId: user.id, displayName: memberDisplayName(members, user.id),
    }));
  }

  private async signMessage(message: TeamChatMessage): Promise<TeamChatMessage> {
    const deviceId = this.options.distributed.transport.snapshot(message.teamId).deviceId;
    if (!deviceId) throw new HttpError(409, 'Register this device in the team before signing a chat message.');
    const payload = signingPayload(message, deviceId);
    const signature = await this.options.distributed.transport.signPayload(message.teamId, deviceId, payload);
    return TeamChatMessageSchema.parse({ ...message, authorDeviceId: deviceId, authorSignature: signature });
  }

  private teamAgents(agents: Awaited<ReturnType<ProjectCollaborationService['snapshot']>>['agents'], accountId: string, deviceId: string | null): TeamChatAgent[] {
    return agents.flatMap((agent) => agent.sessionId && agent.provider && agent.model ? [{
      ...agent, sessionId: agent.sessionId, provider: agent.provider as TeamChatAgent['provider'], model: agent.model,
      local: agent.accountId === accountId && agent.deviceId === deviceId,
    }] : []);
  }

  private persist(message: TeamChatMessage, localDelivery: TeamChatMessage['deliveryState'] = message.deliveryState): TeamChatMessage {
    const parsed = TeamChatMessageSchema.parse(message);
    const sourceSessionId = parsed.source?.sessionId ?? null;
    const sourceMessageId = parsed.source?.messageId ?? null;
    const existingRow = this.options.store.db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(parsed.id) as DbRow | undefined;
    if (existingRow) {
      const existing = this.rowMessage(existingRow);
      const sameIdentity = existing.teamId === parsed.teamId && existing.sharedProjectId === parsed.sharedProjectId
        && existing.author.kind === parsed.author.kind && JSON.stringify(existing.author) === JSON.stringify(parsed.author)
        && existing.body === parsed.body && JSON.stringify(existing.mentions) === JSON.stringify(parsed.mentions)
        && existing.replyTo === parsed.replyTo && existing.createdAt === parsed.createdAt
        && JSON.stringify(existing.source ?? null) === JSON.stringify(parsed.source ?? null)
        && existing.authorDeviceId === parsed.authorDeviceId && existing.authorSignature === parsed.authorSignature;
      if (!sameIdentity) throw new HttpError(409, 'A team chat message ID was reused with different content.');
      if (runRank(parsed.runState) > runRank(existing.runState)) {
        this.options.store.db.prepare('UPDATE team_chat_messages SET run_state=? WHERE id=?').run(parsed.runState, parsed.id);
        this.notifyTeamChatUpdated(parsed.teamId, parsed.sharedProjectId);
      }
      const refreshed = this.options.store.db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(parsed.id) as DbRow;
      return { ...this.rowMessage(refreshed), deliveryState: localDelivery };
    }
    this.options.store.db.prepare(`INSERT OR IGNORE INTO team_chat_messages
      (id,team_id,shared_project_id,author_json,body,mentions_json,reply_to,created_at,delivery_state,run_state,source_session_id,source_message_id,author_device_id,author_signature)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(parsed.id, parsed.teamId, parsed.sharedProjectId, JSON.stringify(parsed.author),
      parsed.body, JSON.stringify(parsed.mentions), parsed.replyTo ?? null, parsed.createdAt, localDelivery, parsed.runState,
      sourceSessionId, sourceMessageId, parsed.authorDeviceId ?? null, parsed.authorSignature ?? null);
    this.options.store.db.prepare(`DELETE FROM team_chat_messages WHERE team_id=? AND shared_project_id=? AND id IN (
      SELECT id FROM team_chat_messages WHERE team_id=? AND shared_project_id=?
      ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?
    )`).run(parsed.teamId, parsed.sharedProjectId, parsed.teamId, parsed.sharedProjectId, PROJECT_HISTORY_MESSAGE_LIMIT);
    const savedRow = this.options.store.db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(parsed.id) as DbRow | undefined;
    if (!savedRow) {
      if (sourceSessionId && sourceMessageId) {
        const imported = this.options.store.db.prepare(`SELECT * FROM team_chat_messages WHERE team_id=? AND shared_project_id=?
          AND source_session_id=? AND source_message_id=?`).get(parsed.teamId, parsed.sharedProjectId, sourceSessionId, sourceMessageId) as DbRow | undefined;
        if (imported) return this.rowMessage(imported);
      }
      throw new HttpError(500, 'The team chat message could not be saved.');
    }
    this.notifyTeamChatUpdated(parsed.teamId, parsed.sharedProjectId);
    return this.rowMessage(savedRow);
  }

  private setRunState(messageId: string, state: TeamChatMessage['runState']): TeamChatMessage | null {
    if (!state) return null;
    const row = this.options.store.db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(messageId) as DbRow | undefined;
    if (!row) return null;
    const message = this.rowMessage(row);
    if (runRank(state) <= runRank(message.runState)) return null;
    this.options.store.db.prepare('UPDATE team_chat_messages SET run_state=? WHERE id=?').run(state, messageId);
    const updated = this.options.store.db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(messageId) as DbRow | undefined;
    if (updated) this.notifyTeamChatUpdated(message.teamId, message.sharedProjectId);
    return updated ? this.rowMessage(updated) : null;
  }

  private async sendToPeers(
    teamId: string, sharedProjectId: string, kind: string, payload: unknown, idempotencyKey: string,
    localDeviceId?: string | null, preparePeers?: (peerDeviceIds: string[]) => string[], allowPartial = false,
  ): Promise<string[]> {
    // Refresh reciprocal pins and current device membership before deciding which peers receive a message.
    await this.options.distributed.transport.sync();
    const transport = this.options.distributed.transport.snapshot(teamId);
    const ownDeviceId = transport.deviceId;
    if (!ownDeviceId) throw new HttpError(409, 'Register this device with the shared project team before sending team chat.');
    if (localDeviceId && localDeviceId !== ownDeviceId) throw new HttpError(409, 'The registered team device changed while synchronizing. Refresh the team chat and try again.');
    const linked = transport.devices.filter((device) => device.id !== ownDeviceId && device.revokedAt === null
      && transport.links.some((link) => link.deviceId === ownDeviceId && link.peerDeviceId === device.id && link.mutual));
    if (!linked.length) throw new HttpError(503, 'No mutually linked teammate device is available. The message remains saved on this device.');
    const allowedPeerIds = preparePeers ? new Set(preparePeers(linked.map((peer) => peer.id))) : null;
    const failures: unknown[] = [];
    const succeeded: string[] = [];
    for (const peer of linked) {
      if (allowedPeerIds && !allowedPeerIds.has(peer.id)) continue;
      try {
        await this.options.distributed.authorizeTeam({ teamId, peerDeviceId: peer.id });
        await this.options.distributed.transport.send({ teamId, toDeviceId: peer.id, kind,
          payload, idempotencyKey: `${idempotencyKey}:${peer.id}`.slice(0, 200) });
        succeeded.push(peer.id);
      } catch (error) { failures.push(error); }
    }
    if (failures.length && !allowPartial) throw new HttpError(503, linked.length === failures.length
      ? 'The message was saved, but no linked teammate device accepted it for delivery.'
      : 'The message was saved and some linked teammate devices accepted it, but delivery to another device failed.');
    void sharedProjectId;
    return succeeded;
  }

  async send(projectId: string, rawInput: unknown): Promise<TeamChatMessage> {
    const input = SendTeamChatMessageSchema.parse(rawInput);
    const context = this.localSendContext(projectId);
    if (input.replyTo) {
      const reply = this.options.store.db.prepare('SELECT id FROM team_chat_messages WHERE id=? AND team_id=? AND shared_project_id=?')
        .get(input.replyTo, context.teamId, context.sharedProjectId);
      if (!reply) throw new HttpError(400, 'The message being replied to is not in this team chat.');
    }
    const unsignedMessage = TeamChatMessageSchema.parse({
      id: randomUUID(), teamId: context.teamId, sharedProjectId: context.sharedProjectId,
      author: { kind: 'human', accountId: context.accountId, displayName: context.displayName },
      body: redactSecrets(input.body), mentions: input.mentions, ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      createdAt: nowIso(), deliveryState: 'sending', runState: null,
    });
    const signature = this.options.distributed.transport.signPayloadLocal
      ? this.options.distributed.transport.signPayloadLocal(context.teamId, context.deviceId, signingPayload(unsignedMessage, context.deviceId))
      : await this.signMessage(unsignedMessage);
    const message = TeamChatMessageSchema.parse({ ...unsignedMessage, authorDeviceId: context.deviceId, authorSignature: signature });
    this.persist(message, 'sending');
    const response = { ...message, deliveryState: 'sending' as const };
    void this.track(this.dispatchHumanMessage(projectId, response)).catch(() => undefined);
    return response;
  }

  private async dispatchHumanMessage(projectId: string, message: TeamChatMessage): Promise<void> {
    try { await this.validateLocalHumanMessage(projectId, message); }
    catch {
      this.setDeliveryState(message.id, 'failed');
      return;
    }
    let deliveryState: TeamChatMessage['deliveryState'] = 'sent';
    try {
      await this.sendToPeers(message.teamId, message.sharedProjectId, 'teamchat.message',
        TeamChatMessageSchema.parse({ ...message, deliveryState: 'sent' }), `chat:${message.id}:initial`);
    } catch { deliveryState = 'failed'; }
    this.setDeliveryState(message.id, deliveryState);
    if (message.author.kind !== 'human' || !this.orchestration) return;
    try {
      const routing = await this.orchestration.routeTeamChatMessage(projectId, {
        id: message.id, teamId: message.teamId, sharedProjectId: message.sharedProjectId,
        body: message.body, mentions: message.mentions, author: message.author,
      });
      if (routing === 'routed') {
        const row = this.options.store.db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(message.id) as DbRow | undefined;
        if (row) await this.updateAndFanOut({ ...this.rowMessage(row), runState: 'running' });
      }
    } catch {
      await this.updateAndFanOut({ ...message, runState: 'failed' }).catch(() => undefined);
    }
  }

  private async updateAndFanOut(message: TeamChatMessage): Promise<void> {
    const persisted = this.setRunState(message.id, message.runState);
    if (!persisted) return;
    try {
      await this.sendToPeers(message.teamId, message.sharedProjectId, 'teamchat.message',
        TeamChatMessageSchema.parse({ ...persisted, deliveryState: 'sent' }), `chat:${message.id}:state:${message.runState ?? 'none'}`);
    } catch { /* Durable local state stays visible; a later history sync repairs remote state. */ }
  }

  async setOrchestratedRunState(input: { messageId: string; state: 'running' | 'completed' | 'failed' }): Promise<void> {
    const row = this.options.store.db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(input.messageId) as DbRow | undefined;
    if (!row) return;
    await this.updateAndFanOut({ ...this.rowMessage(row), runState: input.state });
  }

  async postOrchestratedAgentReply(input: { projectId: string; sourceMessageId: string; agentId: string; content: string }): Promise<void> {
    const { shared } = await this.binding(input.projectId);
    const project = shared.project!;
    const [accountId, deviceId] = await Promise.all([
      this.options.account.withAuthenticatedClient(async (_client, user) => user.id),
      Promise.resolve(this.options.distributed.transport.snapshot(project.teamId).deviceId),
    ]);
    const agent = this.teamAgents(shared.agents, accountId, deviceId).find((candidate) => candidate.id === input.agentId && candidate.local);
    if (!agent) throw new HttpError(403, 'The local agent is no longer published by this team device.');
    const unsigned = TeamChatMessageSchema.parse({
      id: randomUUID(), teamId: project.teamId, sharedProjectId: project.sharedProjectId,
      author: { kind: 'agent', agentId: agent.id, agentName: agent.name, ownerAccountId: accountId, provider: agent.provider, model: agent.model },
      body: redactSecrets(input.content).slice(0, 20_000), mentions: [], replyTo: input.sourceMessageId,
      createdAt: nowIso(), deliveryState: 'sending', runState: 'completed',
    });
    const signed = await this.signMessage(unsigned);
    this.persist(signed, 'sending');
    await this.deliverAgentMessage(signed);
  }

  /** Mirrors an ordinary group-composer message/reply into the signed shared transcript. */
  mirrorTeamSessionMessage(input: { projectId: string; sessionId: string; sourceMessageId: string; content: string; kind: 'human' | 'agent'; replyTo?: string }): Promise<TeamChatMessage | null> {
    if (!input.sourceMessageId.trim() || input.sourceMessageId.length > 200) return Promise.reject(new HttpError(400, 'A bounded source message identity is required for a team-session mirror.'));
    const key = `${input.projectId}\0${input.sessionId}\0${input.sourceMessageId}`;
    const fingerprint = createHash('sha256').update(canonicalJson({ content: input.content, kind: input.kind, replyTo: input.replyTo ?? null })).digest('hex');
    const existingFlight = this.sessionMirrorFlights.get(key);
    if (existingFlight) return existingFlight.fingerprint === fingerprint
      ? existingFlight.promise : Promise.reject(new HttpError(409, 'This team-session message identity already names different content.'));
    const promise = this.track(this.createTeamSessionMirror(input));
    this.sessionMirrorFlights.set(key, { fingerprint, promise });
    void promise.finally(() => { if (this.sessionMirrorFlights.get(key)?.promise === promise) this.sessionMirrorFlights.delete(key); }).catch(() => undefined);
    return promise;
  }

  private async createTeamSessionMirror(input: { projectId: string; sessionId: string; sourceMessageId: string; content: string; kind: 'human' | 'agent'; replyTo?: string }): Promise<TeamChatMessage | null> {
    const body = redactSecrets(input.content).trim().slice(0, 20_000);
    if (!body) return null;
    const { shared } = await this.binding(input.projectId);
    const project = shared.project!;
    const transport = this.options.distributed.transport.snapshot(project.teamId);
    const accountId = await this.options.account.withAuthenticatedClient(async (_client, user) => user.id);
    const existing = this.options.store.db.prepare(`SELECT * FROM team_chat_messages WHERE team_id=? AND shared_project_id=?
      AND source_session_id=? AND source_message_id=?`).get(project.teamId, project.sharedProjectId, input.sessionId, input.sourceMessageId) as DbRow | undefined;
    if (existing) {
      const saved = this.rowMessage(existing);
      if (saved.body !== body || (saved.replyTo ?? null) !== (input.replyTo ?? null)) {
        throw new HttpError(409, 'A team-session mirror identity already contains different message content.');
      }
      if (saved.deliveryState === 'failed') void this.track(this.deliverAgentMessage(saved)).catch(() => undefined);
      return saved;
    }
    const agent = input.kind === 'agent' ? this.teamAgents(shared.agents, accountId, transport.deviceId)
      .find((candidate) => candidate.sessionId === input.sessionId && candidate.local) : undefined;
    const author = agent ? {
      kind: 'agent' as const, agentId: agent.id, agentName: agent.name, ownerAccountId: accountId, provider: agent.provider, model: agent.model,
    } : await this.localAuthor(shared.members);
    const unsigned = TeamChatMessageSchema.parse({ id: randomUUID(), teamId: project.teamId, sharedProjectId: project.sharedProjectId,
      author, body, mentions: [], ...(input.replyTo ? { replyTo: input.replyTo } : {}), createdAt: nowIso(), deliveryState: 'sending', runState: input.kind === 'agent' ? 'completed' : null,
      source: { sessionId: input.sessionId, messageId: input.sourceMessageId } });
    const signed = await this.signMessage(unsigned);
    const saved = this.persist(signed, 'sending');
    void this.track(this.deliverAgentMessage(saved)).catch(() => undefined);
    return saved;
  }

  async postOrchestrationStatus(input: { projectId: string; content: string }): Promise<void> {
    const { shared } = await this.binding(input.projectId);
    const project = shared.project!;
    const author = await this.localAuthor(shared.members);
    const unsigned = TeamChatMessageSchema.parse({ id: randomUUID(), teamId: project.teamId, sharedProjectId: project.sharedProjectId,
      author, body: redactSecrets(input.content).slice(0, 20_000), mentions: [], createdAt: nowIso(), deliveryState: 'sending', runState: null });
    const signed = await this.signMessage(unsigned);
    this.persist(signed, 'sending');
    await this.deliverAgentMessage(signed);
  }

  private async deliverAgentMessage(message: TeamChatMessage): Promise<void> {
    let deliveryState: TeamChatMessage['deliveryState'] = 'sent';
    try {
      await this.sendToPeers(message.teamId, message.sharedProjectId, 'teamchat.message',
        TeamChatMessageSchema.parse({ ...message, deliveryState: 'sent' }), `chat:${message.id}:initial`);
    } catch {
      deliveryState = 'failed';
    }
    const prior = this.options.store.db.prepare('SELECT delivery_state,team_id,shared_project_id FROM team_chat_messages WHERE id=?').get(message.id) as DbRow | undefined;
    if (prior && prior.delivery_state !== deliveryState) {
      this.options.store.db.prepare('UPDATE team_chat_messages SET delivery_state=? WHERE id=?').run(deliveryState, message.id);
      this.notifyTeamChatUpdated(String(prior.team_id), String(prior.shared_project_id));
    }
  }

  async importHistory(projectId: string, sessionId: string): Promise<{ imported: number; messages: TeamChatMessage[]; truncated: boolean }> {
    const { localProject, shared } = await this.binding(projectId);
    const session = this.options.store.getSession(sessionId);
    if (!session || session.projectId !== localProject.id) throw notFound('Choose a session in this shared project.');
    const user = await this.options.account.withAuthenticatedClient(async (_client, account) => ({ id: account.id }));
    const transport = this.options.distributed.transport.snapshot(shared.project!.teamId);
    const rosterAgent = this.teamAgents(shared.agents, user.id, transport.deviceId).find((agent) => agent.sessionId === session.id && agent.local);
    const sourceMessages = this.options.store.listMessages(session.id, { limit: 2000 })
      .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.kind !== 'streaming');
    const truncated = sourceMessages.length > SYNC_MESSAGE_LIMIT;
    const slice = sourceMessages.slice(-SYNC_MESSAGE_LIMIT);
    const imported: TeamChatMessage[] = [];
    let importedCount = 0;
    for (const source of slice) {
      const existing = this.options.store.db.prepare(`SELECT * FROM team_chat_messages WHERE team_id=? AND shared_project_id=?
        AND source_session_id=? AND source_message_id=?`).get(shared.project!.teamId, shared.project!.sharedProjectId, session.id, source.id) as DbRow | undefined;
      if (existing) { imported.push(this.rowMessage(existing)); continue; }
      const author: TeamChatAuthor = source.role === 'assistant' && rosterAgent
        ? { kind: 'agent', agentId: rosterAgent.id, agentName: rosterAgent.name,
          ownerAccountId: user.id, provider: rosterAgent.provider, model: rosterAgent.model }
        : { kind: 'human', accountId: user.id, displayName: memberDisplayName(shared.members, user.id) };
      const unsignedMessage = TeamChatMessageSchema.parse({
        id: randomUUID(), teamId: shared.project!.teamId, sharedProjectId: shared.project!.sharedProjectId,
        author, body: redactSecrets(source.content).slice(0, 20_000), mentions: [], createdAt: source.createdAt,
        deliveryState: 'sending', runState: null, source: { sessionId: session.id, messageId: source.id },
      });
      const message = await this.signMessage(unsignedMessage);
      const saved = this.persist(message, 'sending');
      imported.push(saved);
      importedCount += 1;
    }
    try {
      await Promise.all(imported.map((message) => this.sendToPeers(shared.project!.teamId, shared.project!.sharedProjectId,
        'teamchat.message', TeamChatMessageSchema.parse({ ...message, deliveryState: 'sent' }),
        `history-import:${message.id}`)));
      for (const message of imported) this.options.store.db.prepare('UPDATE team_chat_messages SET delivery_state=? WHERE id=?').run('sent', message.id);
    } catch {
      for (const message of imported) this.options.store.db.prepare('UPDATE team_chat_messages SET delivery_state=? WHERE id=?').run('failed', message.id);
    }
    if (imported.length) this.notifyTeamChatUpdated(shared.project!.teamId, shared.project!.sharedProjectId);
    const finalMessages = imported.map((message) => {
      const row = this.options.store.db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(message.id) as DbRow;
      return this.rowMessage(row);
    });
    return { imported: importedCount, messages: finalMessages, truncated };
  }

  /** Publish one completed local team-agent turn as a message signed by this device. */
  postAgentReply(projectId: string, agentId: string, body: string, replyTo: string | null, idempotencyKey: string): Promise<TeamChatMessage> {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200) {
      return Promise.reject(new HttpError(400, 'A bounded team delivery identity is required for an agent reply.'));
    }
    const key = `${projectId}\0${agentId}\0${idempotencyKey}`;
    const fingerprint = createHash('sha256').update(canonicalJson({ body, replyTo })).digest('hex');
    const existingFlight = this.agentReplyFlights.get(key);
    if (existingFlight) return existingFlight.fingerprint === fingerprint
      ? existingFlight.promise : Promise.reject(new HttpError(409, 'This team delivery identity already names a different agent reply.'));
    const flight = this.track(this.createAgentReply(projectId, agentId, body, replyTo, idempotencyKey));
    this.agentReplyFlights.set(key, { fingerprint, promise: flight });
    void flight.finally(() => { if (this.agentReplyFlights.get(key)?.promise === flight) this.agentReplyFlights.delete(key); }).catch(() => undefined);
    return flight;
  }

  private async createAgentReply(projectId: string, agentId: string, body: string, replyTo: string | null, idempotencyKey: string): Promise<TeamChatMessage> {
    const { shared } = await this.binding(projectId);
    const project = shared.project!;
    const [accountId, transport] = await Promise.all([
      this.options.account.withAuthenticatedClient(async (_client, user) => user.id),
      Promise.resolve(this.options.distributed.transport.snapshot(project.teamId)),
    ]);
    const agent = this.teamAgents(shared.agents, accountId, transport.deviceId).find((candidate) => candidate.id === agentId && candidate.local);
    if (!agent) throw new HttpError(403, 'Only a currently published local agent may author a team-chat reply.');
    const sourceMessageId = `team-delivery:${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 40)}`;
    const content = redactSecrets(body).trim().slice(0, 20_000);
    if (!content) throw new HttpError(400, 'An agent reply must contain text.');
    const safeReplyTo = replyTo && this.options.store.db.prepare(`SELECT id FROM team_chat_messages WHERE id=? AND team_id=? AND shared_project_id=?`)
      .get(replyTo, project.teamId, project.sharedProjectId) ? replyTo : undefined;
    const existing = this.options.store.db.prepare(`SELECT * FROM team_chat_messages WHERE team_id=? AND shared_project_id=?
      AND source_session_id=? AND source_message_id=?`).get(project.teamId, project.sharedProjectId, agent.sessionId, sourceMessageId) as DbRow | undefined;
    if (existing) {
      const saved = this.rowMessage(existing);
      if (saved.body !== content || (saved.replyTo ?? null) !== (safeReplyTo ?? null)) throw new HttpError(409, 'This team delivery already produced a different chat reply.');
      await this.deliverAgentMessage(saved);
      const refreshed = this.options.store.db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(saved.id) as DbRow;
      return this.rowMessage(refreshed);
    }
    const unsigned = TeamChatMessageSchema.parse({
      id: randomUUID(), teamId: project.teamId, sharedProjectId: project.sharedProjectId,
      author: { kind: 'agent', agentId: agent.id, agentName: agent.name, ownerAccountId: accountId, provider: agent.provider, model: agent.model },
      body: content, mentions: [], ...(safeReplyTo ? { replyTo: safeReplyTo } : {}), createdAt: nowIso(),
      deliveryState: 'sending', runState: 'completed', source: { sessionId: agent.sessionId, messageId: sourceMessageId },
    });
    const signed = await this.signMessage(unsigned);
    const saved = this.persist(signed, 'sending');
    await this.deliverAgentMessage(saved);
    const refreshed = this.options.store.db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(saved.id) as DbRow;
    return this.rowMessage(refreshed);
  }

  private async validateRemote(envelope: { teamId: string; fromDeviceId: string; toDeviceId: string }, sharedProjectId: string, authors: string[]): Promise<{ localProjectId: string; senderOwnerId: string }> {
    const transport = this.options.distributed.transport.snapshot(envelope.teamId);
    if (!transport.deviceId || envelope.toDeviceId !== transport.deviceId) throw new HttpError(403, 'Team chat envelope is not addressed to this device.');
    await this.options.distributed.authorizeTeam({ teamId: envelope.teamId, peerDeviceId: envelope.fromDeviceId });
    const bindingResult = await this.options.account.withAuthenticatedClient(async (client, user) => {
      const [senderResult, memberResult, projectResult] = await Promise.all([
        client.from('mingle_devices').select('id,owner_id').eq('team_id', envelope.teamId).eq('id', envelope.fromDeviceId).is('revoked_at', null).maybeSingle(),
        client.from('mingle_members').select('user_id').eq('team_id', envelope.teamId).eq('user_id', user.id).is('revoked_at', null).maybeSingle(),
        client.from('mingle_projects').select('id').eq('id', sharedProjectId).eq('team_id', envelope.teamId).maybeSingle(),
      ]);
      if (senderResult.error || memberResult.error || projectResult.error || !senderResult.data || !memberResult.data || !projectResult.data) {
        throw new HttpError(403, 'The sender or shared project no longer belongs to an active team membership.');
      }
      const ownerId = String((senderResult.data as DbRow).owner_id);
      const senderMember = await client.from('mingle_members').select('user_id').eq('team_id', envelope.teamId).eq('user_id', ownerId).is('revoked_at', null).maybeSingle();
      if (senderMember.error || !senderMember.data) throw new HttpError(403, 'The sender account is no longer an active team member.');
      const uniqueAuthors = [...new Set(authors)];
      if (uniqueAuthors.length) {
        const authorsResult = await client.from('mingle_members').select('user_id').eq('team_id', envelope.teamId)
          .in('user_id', uniqueAuthors).is('revoked_at', null).limit(500);
        if (authorsResult.error || new Set((authorsResult.data ?? []).map((row: DbRow) => String(row.user_id))).size !== uniqueAuthors.length) {
          throw new HttpError(403, 'A team chat author is not an active member of this team.');
        }
      }
      const binding = this.options.store.db.prepare(`SELECT local_project_id FROM mingle_project_collaboration_sources
        WHERE team_id=? AND shared_project_id=? AND owner_id=?
        UNION ALL SELECT local_project_id FROM mingle_project_collaboration_joins
        WHERE team_id=? AND shared_project_id=? AND account_id=? AND device_id=? LIMIT 1`)
        .get(envelope.teamId, sharedProjectId, user.id, envelope.teamId, sharedProjectId, user.id, transport.deviceId) as DbRow | undefined;
      const project = binding ? this.options.store.getProject(String(binding.local_project_id)) : undefined;
      if (!project) throw new HttpError(403, 'Bind this shared project locally before receiving team chat.');
      return { projectId: project.id, senderOwnerId: ownerId };
    });
    return { localProjectId: bindingResult.projectId, senderOwnerId: bindingResult.senderOwnerId };
  }

  private async verifyMessageProvenance(
    messages: TeamChatMessage[], shared: SharedSnapshot, envelope: { teamId: string; fromDeviceId: string },
    senderOwnerId: string, direct: boolean,
  ): Promise<TeamChatMessage[]> {
    const normalized: TeamChatMessage[] = [];
    const authorDeviceIds: string[] = [];
    const expectedOwners: string[] = [];
    for (const message of messages) {
      if (!message.authorDeviceId || !message.authorSignature) throw new HttpError(403, 'The message has no author-device provenance signature.');
      const claimedAuthor = message.author;
      let author: TeamChatAuthor;
      let authorAccountId: string;
      if (claimedAuthor.kind === 'human') {
        authorAccountId = claimedAuthor.accountId;
        if (!shared.members.some((member) => member.accountId === authorAccountId)) throw new HttpError(403, 'The message author is not in the current shared-project membership.');
        author = { kind: 'human', accountId: authorAccountId, displayName: memberDisplayName(shared.members, authorAccountId) };
      } else {
        // The publishing device exposes the session ID as its local roster ID; peers expose the
        // opaque execution-agent ID alongside that same published session ID.
        const rosterAgent = shared.agents.find((agent) => agent.id === claimedAuthor.agentId || agent.sessionId === claimedAuthor.agentId);
        if (!rosterAgent || !rosterAgent.sessionId || !rosterAgent.provider || !rosterAgent.model ||
          rosterAgent.accountId !== claimedAuthor.ownerAccountId || rosterAgent.deviceId !== message.authorDeviceId) {
          throw new HttpError(403, 'The agent author is not published by this active authoring device.');
        }
        authorAccountId = rosterAgent.accountId;
        author = TeamChatAuthorSchema.parse({
          kind: 'agent', agentId: claimedAuthor.agentId, agentName: rosterAgent.name, ownerAccountId: rosterAgent.accountId,
          provider: rosterAgent.provider, model: rosterAgent.model,
        });
      }
      if (!shared.members.some((member) => member.accountId === authorAccountId)) throw new HttpError(403, 'The message author account is not an active team member.');
      if (direct && (message.authorDeviceId !== envelope.fromDeviceId || authorAccountId !== senderOwnerId)) {
        throw new HttpError(403, 'A direct team-chat message must be authored by its authenticated sender device and account.');
      }
      authorDeviceIds.push(message.authorDeviceId);
      expectedOwners.push(authorAccountId);
      normalized.push(TeamChatMessageSchema.parse({ ...message, author }));
    }

    const deviceIds = [...new Set(authorDeviceIds)];
    const registrations = deviceIds.length ? await this.options.account.withAuthenticatedClient(async (client) => {
      const result = await client.from('mingle_devices').select('id,owner_id,signing_public_key,encryption_public_key,fingerprint,revoked_at')
        .eq('team_id', envelope.teamId).in('id', deviceIds).is('revoked_at', null).limit(500);
      if (result.error || !Array.isArray(result.data)) throw new HttpError(403, 'The authoring device registrations could not be verified.');
      return result.data as DbRow[];
    }) : [];
    const devices = new Map(registrations.map((row) => [String(row.id), row]));
    for (let index = 0; index < normalized.length; index++) {
      const message = normalized[index]!;
      const authorDeviceId = authorDeviceIds[index]!;
      const device = devices.get(authorDeviceId);
      if (!device || device.revoked_at || String(device.owner_id) !== expectedOwners[index]) {
        throw new HttpError(403, 'The authoring device is unknown, revoked, or belongs to another account.');
      }
      let fingerprint: string;
      try { fingerprint = fingerprintForPublicKeys(String(device.signing_public_key), String(device.encryption_public_key)); }
      catch { throw new HttpError(403, 'The authoring device has invalid registered keys.'); }
      if (fingerprint !== device.fingerprint || !verifyDevicePayload(
        signingPayload(message, authorDeviceId), message.authorSignature!, String(device.signing_public_key),
      )) throw new HttpError(403, 'The message author-device signature is invalid.');
    }
    return normalized;
  }

  private onEnvelope(envelope: { id: string; teamId: string; fromDeviceId: string; toDeviceId: string; kind: string; payload: unknown }): Promise<void> {
    if (!['teamchat.message', 'teamchat.sync.request', 'teamchat.sync.response'].includes(envelope.kind)) return Promise.resolve();
    return this.track(this.receiveEnvelope(envelope));
  }

  private async receiveEnvelope(envelope: { id: string; teamId: string; fromDeviceId: string; toDeviceId: string; kind: string; payload: unknown }): Promise<void> {
    this.ensureOpen();
    if (envelope.kind === 'teamchat.message') {
      const message = TeamChatMessageSchema.parse(envelope.payload);
      if (message.teamId !== envelope.teamId) throw new HttpError(400, 'Team chat message has a mismatched team ID.');
      const claimedOwner = message.author.kind === 'human' ? message.author.accountId : message.author.ownerAccountId;
      const { localProjectId, senderOwnerId } = await this.validateRemote(envelope, message.sharedProjectId, [claimedOwner]);
      const { shared } = await this.binding(localProjectId);
      if (shared.project?.teamId !== envelope.teamId || shared.project.sharedProjectId !== message.sharedProjectId) throw new HttpError(403, 'The message is outside this shared project binding.');
      const [verified] = await this.verifyMessageProvenance([message], shared, envelope, senderOwnerId, true);
      this.persist({ ...verified!, deliveryState: 'sent' }, 'sent');
      if (verified && this.orchestration) {
        const routing = await this.orchestration.routeTeamChatMessage(localProjectId, {
          id: verified.id, teamId: verified.teamId, sharedProjectId: verified.sharedProjectId,
          body: verified.body, mentions: verified.mentions, author: verified.author,
        });
        if (routing === 'routed') await this.setOrchestratedRunState({ messageId: verified.id, state: 'running' });
      }
      return;
    }
    if (envelope.kind === 'teamchat.sync.request') {
      const request = TeamChatSyncRequestSchema.parse(envelope.payload);
      const { localProjectId } = await this.validateRemote(envelope, request.sharedProjectId, []);
      const { shared } = await this.binding(localProjectId);
      if (shared.project?.teamId !== envelope.teamId || shared.project.sharedProjectId !== request.sharedProjectId) throw new HttpError(403, 'The sync request is outside this shared project binding.');
      if (!this.allowSyncRequest(envelope.teamId, request.sharedProjectId, envelope.fromDeviceId)) throw new HttpError(429, 'This peer requested team-chat sync too frequently.');
      const rows = this.options.store.db.prepare(`SELECT * FROM team_chat_messages WHERE team_id=? AND shared_project_id=?
        AND author_device_id IS NOT NULL AND author_signature IS NOT NULL
        AND (? IS NULL OR created_at > ?) ORDER BY created_at,id LIMIT ?`).all(envelope.teamId, request.sharedProjectId,
        request.since, request.since, SYNC_MESSAGE_LIMIT) as DbRow[];
      const messages = rows.map((row) => ({ ...this.rowMessage(row), deliveryState: 'sent' as const }));
      for (const batch of this.batches(request.sharedProjectId, request.requestId, messages)) {
        const batchDigest = createHash('sha256').update(JSON.stringify(batch)).digest('hex').slice(0, 32);
        await this.options.distributed.transport.send({ teamId: envelope.teamId, toDeviceId: envelope.fromDeviceId,
          kind: 'teamchat.sync.response', payload: batch,
          idempotencyKey: `sync-response:${request.requestId}:${batchDigest}`.slice(0, 200) });
      }
      return;
    }
    if (envelope.kind === 'teamchat.sync.response') {
      const response = TeamChatSyncResponseSchema.parse(envelope.payload);
      this.expireSyncRequests();
      const requestKey = this.pendingSyncKey(envelope.teamId, response.sharedProjectId, envelope.fromDeviceId, response.requestId);
      const pending = this.pendingSyncRequests.get(requestKey);
      if (!pending || pending.expiresAt <= this.now()) throw new HttpError(403, 'The sync response was not requested from this peer or has expired.');
      if (pending.batchCount !== null && pending.batchCount !== response.batchCount) throw new HttpError(400, 'The sync response batch count changed during transfer.');
      if (pending.batches.has(response.batchIndex)) return;
      if (pending.messageCount + response.messages.length > SYNC_MESSAGE_LIMIT) throw new HttpError(413, 'The sync response exceeds its requested history limit.');
      const authors = response.messages.map((message) => message.author.kind === 'human' ? message.author.accountId : message.author.ownerAccountId);
      const { localProjectId, senderOwnerId } = await this.validateRemote(envelope, response.sharedProjectId, authors);
      const { shared } = await this.binding(localProjectId);
      if (shared.project?.teamId !== envelope.teamId || shared.project.sharedProjectId !== response.sharedProjectId) throw new HttpError(403, 'The sync response is outside this shared project binding.');
      for (const message of response.messages) {
        if (message.teamId !== envelope.teamId || message.sharedProjectId !== response.sharedProjectId) throw new HttpError(400, 'A backfill message has mismatched project authority.');
      }
      const verified = await this.verifyMessageProvenance(response.messages, shared, envelope, senderOwnerId, false);
      if (!this.allowSyncResponse(envelope.teamId, envelope.fromDeviceId)) throw new HttpError(429, 'This peer sent too many team-chat sync batches.');
      for (const message of verified) this.persist({ ...message, deliveryState: 'sent' }, 'sent');
      pending.batchCount = response.batchCount;
      pending.batches.add(response.batchIndex);
      pending.messageCount += response.messages.length;
      if (pending.batches.size === pending.batchCount) this.pendingSyncRequests.delete(requestKey);
      return;
    }
    throw new HttpError(400, 'Unsupported team chat transport message.');
  }

  private batches(sharedProjectId: string, requestId: string, messages: TeamChatMessage[]): TeamChatSyncResponse[] {
    const chunks: TeamChatMessage[][] = [];
    let current: TeamChatMessage[] = [];
    for (const message of messages) {
      const candidate = [...current, message];
      const bytes = Buffer.byteLength(canonicalJson({ sharedProjectId, requestId, batchIndex: 0, batchCount: 200, messages: candidate }));
      if (current.length && (candidate.length > SYNC_MESSAGE_LIMIT || bytes > SYNC_BYTE_LIMIT)) {
        chunks.push(current);
        current = [message];
        if (Buffer.byteLength(canonicalJson({ sharedProjectId, requestId, batchIndex: 0, batchCount: 200, messages: current })) > SYNC_BYTE_LIMIT) {
          throw new HttpError(413, 'A team-chat history message exceeds the sync response byte limit.');
        }
      } else current = candidate;
    }
    if (current.length || chunks.length === 0) chunks.push(current);
    if (chunks.length > 200) throw new HttpError(413, 'The team-chat sync response requires too many batches.');
    return chunks.map((chunk, batchIndex) => TeamChatSyncResponseSchema.parse({
      sharedProjectId, requestId, batchIndex, batchCount: chunks.length, messages: chunk,
    }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.pendingSyncRequests.clear();
    this.syncRequestRates.clear();
    this.syncResponseRates.clear();
    await Promise.allSettled([...this.pending]);
  }
}
