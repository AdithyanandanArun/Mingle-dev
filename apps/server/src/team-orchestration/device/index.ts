import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  AcceptTeamConsentSchema, TEAM_CONSENT_DISCLAIMER_VERSION, TeamActivityPayloadSchema,
  TeamApprovalDecisionPayloadSchema, TeamApprovalRequestPayloadSchema, TeamConsentPayloadSchema,
  TeamDeliveryPayloadSchema, TeamDeliveryStatusPayloadSchema, TeamInterruptPayloadSchema,
  TeamStructurePayloadSchema, TeamAgentActivityEntrySchema, UpdateTeamConsentSchema,
} from '@mingle/contracts';
import type {
  Policy, ProviderFailure, TeamAgentActivity, TeamAgentActivityEntry, TeamConsent, TeamConsentState,
  TeamDeliveryPayload, TeamPermissionLevel, TeamStructurePayload,
} from '@mingle/contracts';
import { ProviderFailureSchema } from '@mingle/contracts';
import type { Ctx } from '../../routes.ts';
import type { Store } from '../../store.ts';
import type { SessionRuntime, StartOptions } from '../../runtime.ts';
import type { AccountService } from '../../account/service.ts';
import type { DistributedWorkspaceService } from '../../distributed/service.ts';
import type { AuthenticatedEnvelope } from '../../distributed/execution.ts';
import type { ProjectCollaborationService } from '../../project-collaboration/service.ts';
import type { TeamChatService } from '../../team-chat/service.ts';
import { HttpError, errorMessage, nowIso, redactSecrets } from '../../util.ts';
import { git, trimmed } from '../../repository/git-run.ts';
import { TeamMcpProxy } from './mcp-proxy.ts';

type AddRoute = (method: string, path: string, handler: (context: Ctx) => unknown | Promise<unknown>) => unknown;
type DeviceTransport = DistributedWorkspaceService['transport'];
type DeviceStore = Pick<Store, 'db' | 'tx' | 'touch' | 'subscribe' | 'recordEvent' | 'getProject' | 'getSession' | 'listSessions' | 'getRun' | 'listMessages' | 'listRunTools' | 'latestProviderFailure'>;
type DeviceRuntime = Pick<SessionRuntime, 'start' | 'isActive' | 'interrupt' | 'decide'>;

export interface DeviceSideDeps {
  store: DeviceStore;
  runtime: DeviceRuntime;
  transport: DeviceTransport;
  account: AccountService;
  distributed: DistributedWorkspaceService;
  collaboration: ProjectCollaborationService;
  teamChat: Pick<TeamChatService, 'postAgentReply'>;
  hub?: { broadcast(event: unknown): void };
  changed?: () => void;
  /** Injectable timing bounds keep transport/runtime tests deterministic. */
  activityThrottleMs?: number;
  toolTimeoutMs?: number;
}

interface Row extends Record<string, unknown> {
  shared_project_id: string; account_id: string; device_id: string; consent_json: string; updated_at: string;
}
interface ActiveDelivery {
  payload: TeamDeliveryPayload;
  teamId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  baseRevision: string | null;
  worktreePath: string;
  branch: string | null;
  entries: TeamAgentActivityEntry[];
  text: string;
  activityState: 'idle' | 'queued' | 'working' | 'awaiting-approval' | 'quota-exhausted' | 'offline' | 'paused' | 'failed';
  activityWaiters: Array<() => void>;
  timer: NodeJS.Timeout | null;
  controller: AbortController;
  replyPosted: boolean;
  artifactFailures: string[];
}
interface SharedBinding {
  projectId: string;
  teamId: string;
  sharedProjectId: string;
  members: Awaited<ReturnType<ProjectCollaborationService['snapshot']>>['members'];
  agents: Awaited<ReturnType<ProjectCollaborationService['snapshot']>>['agents'];
}

const MAX_MIRRORED_ENTRIES = 500;
const ACTIVITY_THROTTLE_MS = 2_000;
const ACTIVITY_BATCH_SIZE = 20;
const MAX_ACTIVITY_TEXT = 8_000;
const DELIVERY_TIMEOUT_MS = 24 * 60 * 60_000;
const ISO = () => new Date().toISOString();
const permissionRank = (value: TeamPermissionLevel) => value === 'supervised' ? 0 : 1;
const policyRank: Record<Policy, number> = { supervised: 0, balanced: 1, auto: 2, 'full-access': 3 };
function mostRestrictivePolicy(...policies: Policy[]): Policy {
  return policies.reduce((strictest, policy) => policyRank[policy] < policyRank[strictest] ? policy : strictest);
}
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const safeText = (value: unknown, max: number) => redactSecrets(typeof value === 'string' ? value : String(value ?? '')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, max);

/** Owner-device authority and isolated execution for cross-device team agents. */
export function createDeviceSide(deps: DeviceSideDeps): {
  routes(add: AddRoute): void;
  close(): Promise<void>;
  latestStructure(sharedProjectId: string): TeamStructurePayload | null;
  localConsent(sharedProjectId: string): TeamConsent | null;
} {
  const db: DatabaseSync = deps.store.db;
  const active = new Map<string, ActiveDelivery>();
  const cancelled = new Set<string>();
  const work = new Set<Promise<unknown>>();
  const runWaiters = new Set<() => void>();
  const lastActivitySentAt = new Map<string, number>();
  const hostDecisions = new Set<string>();
  let closed = false;
  const proxy = new TeamMcpProxy(deps.transport, deps.toolTimeoutMs);
  const unsubscribe = deps.transport.onMessage((envelope) => track(handleEnvelope(envelope)));

  function changed(): void {
    deps.store.touch();
    deps.changed?.();
  }

  function recordStructureUpdated(sharedProjectId: string, summary: string, teamSession?: TeamStructurePayload['teamSession'] | null): void {
    const project = db.prepare(`SELECT local_project_id FROM mingle_project_collaboration_sources WHERE shared_project_id=?
      UNION ALL SELECT local_project_id FROM mingle_project_collaboration_joins WHERE shared_project_id=? LIMIT 1`)
      .get(sharedProjectId, sharedProjectId) as { local_project_id: string } | undefined;
    if (!project) { changed(); return; }
    deps.store.recordEvent({ projectId: project.local_project_id, type: 'team.structure.updated', summary,
      payload: { sharedProjectId, ...(teamSession !== undefined ? { teamSession: teamSession ?? null } : {}) } });
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    work.add(promise);
    void promise.finally(() => work.delete(promise)).catch(() => undefined);
    return promise;
  }

  function reconcilePersistedDeliveries(): Promise<void> {
    const rows = db.prepare(`SELECT d.delivery_id,d.shared_project_id,d.agent_id,d.request_json,d.status,s.team_id,s.host_device_id
      FROM mingle_team_device_deliveries d LEFT JOIN mingle_team_device_structures s ON s.shared_project_id=d.shared_project_id
      WHERE d.status IN ('accepted','running','awaiting-approval')`)
      .all() as Array<{ delivery_id: string; shared_project_id: string; agent_id: string; request_json: string;
        status: string; team_id: string | null; host_device_id: string | null }>;
    const pending: Array<{ teamId: string; hostDeviceId: string; sharedProjectId: string; deliveryId: string; agentId: string }> = [];
    for (const row of rows) {
      const changed = db.prepare(`UPDATE mingle_team_device_deliveries SET status='interrupted',error=?,updated_at=?
        WHERE delivery_id=? AND status IN ('accepted','running','awaiting-approval')`)
        .run('Owner device restarted before this team delivery reached a terminal state.', ISO(), row.delivery_id);
      if (Number(changed.changes) !== 1) continue;
      try {
        const payload = TeamDeliveryPayloadSchema.parse(JSON.parse(row.request_json));
        const hostDeviceId = row.host_device_id ?? payload.integrationDeviceId;
        if (row.team_id && hostDeviceId) pending.push({ teamId: row.team_id, hostDeviceId,
          sharedProjectId: row.shared_project_id, deliveryId: row.delivery_id, agentId: row.agent_id });
      } catch { /* Invalid persisted requests are terminalized locally without trusting their transport fields. */ }
    }
    return Promise.allSettled(pending.map((item) => sendStatus(item.teamId, item.hostDeviceId, {
      sharedProjectId: item.sharedProjectId, deliveryId: item.deliveryId, agentId: item.agentId, status: 'interrupted',
    }))).then(() => undefined);
  }

  function latestStructure(sharedProjectId: string): TeamStructurePayload | null {
    const row = db.prepare('SELECT structure_json FROM mingle_team_device_structures WHERE shared_project_id=?').get(sharedProjectId) as { structure_json: string } | undefined;
    if (!row) return null;
    try { return TeamStructurePayloadSchema.parse(JSON.parse(row.structure_json)); } catch { return null; }
  }

  function localConsent(sharedProjectId: string): TeamConsent | null {
    const accountId = deps.account.snapshot().user?.id;
    const row = accountId
      ? db.prepare(`SELECT consent_json FROM mingle_team_device_consents WHERE shared_project_id=? AND account_id=? ORDER BY updated_at DESC LIMIT 1`).get(sharedProjectId, accountId) as { consent_json: string } | undefined
      : undefined;
    if (!row) return null;
    try { return parseConsent(JSON.parse(row.consent_json)); } catch { return null; }
  }

  function parseConsent(input: unknown): TeamConsent {
    if (!input || typeof input !== 'object') throw new Error('Stored consent is invalid.');
    const value = input as Record<string, unknown>;
    if (![value.teamId, value.sharedProjectId, value.accountId, value.deviceId].every(identifier)
      || !Array.isArray(value.agentIds) || value.agentIds.length > 8 || !value.agentIds.every(identifier)
      || (value.permissionLevel !== 'supervised' && value.permissionLevel !== 'full-access')
      || !Number.isInteger(value.settingsVersion) || (value.settingsVersion as number) < 1
      || !identifier(value.disclaimerVersion) || !['granted', 'needs-reconsent', 'paused', 'revoked'].includes(String(value.state))
      || typeof value.acceptedAt !== 'string' || typeof value.updatedAt !== 'string') throw new Error('Stored consent is invalid.');
    return value as unknown as TeamConsent;
  }

  function saveConsent(consent: TeamConsent): void {
    const updatedAt = consent.updatedAt;
    db.prepare(`INSERT INTO mingle_team_device_consents(shared_project_id,account_id,device_id,consent_json,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(shared_project_id,account_id,device_id) DO UPDATE SET consent_json=excluded.consent_json,updated_at=excluded.updated_at`)
      .run(consent.sharedProjectId, consent.accountId, consent.deviceId, JSON.stringify(consent), updatedAt);
  }

  async function binding(projectId: string): Promise<SharedBinding> {
    const project = deps.store.getProject(projectId);
    if (!project) throw new HttpError(404, 'Project not found.');
    const snapshot = await deps.collaboration.snapshot(projectId);
    if (!snapshot.project) throw new HttpError(409, 'Set up teammate sharing for this project before managing team agents.');
    return { projectId, teamId: snapshot.project.teamId, sharedProjectId: snapshot.project.sharedProjectId,
      members: snapshot.members, agents: snapshot.agents };
  }

  async function currentAccountId(): Promise<string> {
    return deps.account.withAuthenticatedClient(async (_client, user) => user.id);
  }

  async function hostDeviceId(shared: SharedBinding): Promise<string | null> {
    const stored = db.prepare('SELECT host_device_id FROM mingle_team_device_structures WHERE shared_project_id=?')
      .get(shared.sharedProjectId) as { host_device_id: string } | undefined;
    if (stored?.host_device_id) return stored.host_device_id;
    const localSource = db.prepare(`SELECT leader_device_id FROM mingle_project_collaboration_sources WHERE team_id=? AND shared_project_id=? AND leader_device_id IS NOT NULL`)
      .get(shared.teamId, shared.sharedProjectId) as { leader_device_id: string } | undefined;
    if (localSource?.leader_device_id) return localSource.leader_device_id;
    const leader = shared.members.find((member) => member.role === 'leader');
    if (!leader) return null;
    const snapshot = deps.transport.snapshot(shared.teamId);
    const candidates = snapshot.devices.filter((device) => device.ownerId === leader.accountId && !device.revokedAt
      && snapshot.links.some((link) => link.deviceId === snapshot.deviceId && link.peerDeviceId === device.id && link.mutual));
    candidates.sort((left, right) => Number(right.status === 'online') - Number(left.status === 'online'));
    return candidates[0]?.id ?? null;
  }

  async function authorizedHost(envelope: AuthenticatedEnvelope, shared: SharedBinding): Promise<{ ownerId: string; role: string } | null> {
    if (envelope.teamId !== shared.teamId || envelope.toDeviceId !== deps.transport.snapshot(shared.teamId).deviceId) return null;
    const expectedHost = await hostDeviceId(shared);
    if (!expectedHost || envelope.fromDeviceId !== expectedHost) return null;
    const snapshot = deps.transport.snapshot(shared.teamId);
    const device = snapshot.devices.find((candidate) => candidate.id === envelope.fromDeviceId && !candidate.revokedAt);
    if (!device) return null;
    const member = shared.members.find((candidate) => candidate.accountId === device.ownerId);
    if (!member || !['leader', 'admin'].includes(member.role)) return null;
    return { ownerId: device.ownerId, role: member.role };
  }

  async function send(teamId: string, deviceId: string, kind: string, payload: unknown, idempotencyKey: string): Promise<void> {
    await deps.transport.send({ teamId, toDeviceId: deviceId, kind, payload, idempotencyKey: idempotencyKey.slice(0, 200) });
    // Incoming mailbox handlers run inside sync(). Waiting for that same sync from here would
    // deadlock the handler; the durable outbox row is authoritative and the immediate wake is best-effort.
    void deps.transport.sync().catch(() => undefined);
  }

  async function sendToHost(shared: SharedBinding, kind: string, payload: unknown, key: string): Promise<boolean> {
    const peer = await hostDeviceId(shared);
    const own = deps.transport.snapshot(shared.teamId).deviceId;
    if (!peer) return false;
    if (peer === own) return true;
    await send(shared.teamId, peer, kind, payload, key);
    return true;
  }

  async function acceptConsent(projectId: string, raw: unknown): Promise<unknown> {
    const input = AcceptTeamConsentSchema.parse(raw);
    if (new Set(input.sessionIds).size !== input.sessionIds.length) throw new HttpError(400, 'Choose each local agent only once.');
    const shared = await binding(projectId);
    const accountId = await currentAccountId();
    const deviceId = deps.transport.snapshot(shared.teamId).deviceId;
    if (!deviceId) throw new HttpError(409, 'Register this device with the shared project before contributing agents.');
    const structure = latestStructure(shared.sharedProjectId);
    if (structure && input.settingsVersion !== structure.settings.version) {
      throw new HttpError(409, 'Team settings changed. Review the current permission level and settings version before accepting consent.');
    }
    const sessions = input.sessionIds.map((sessionId) => {
      const session = deps.store.getSession(sessionId);
      if (!session || session.projectId !== projectId || !deps.store.listSessions(projectId).some((candidate) => candidate.id === sessionId)) {
        throw new HttpError(400, 'Choose only non-archived local sessions in this shared project.');
      }
      return session;
    });
    const roster = await deps.distributed.execution.snapshot(shared.teamId);
    const ownPublished = roster.agents.filter((agent) => agent.sharedProjectId === shared.sharedProjectId && agent.deviceId === deviceId
      && agent.ownerId === accountId).map((agent) => agent.sessionId);
    const toPublish = [...new Set([...ownPublished, ...input.sessionIds])];
    const published = await deps.distributed.execution.publishAgents({ teamId: shared.teamId, sharedProjectId: shared.sharedProjectId, sessionIds: toPublish });
    const bySession = new Map(published.map((agent) => [agent.sessionId, agent.id]));
    const agentIds = input.sessionIds.map((sessionId) => bySession.get(sessionId)).filter((id): id is string => Boolean(id));
    if (agentIds.length !== input.sessionIds.length) throw new HttpError(409, 'The selected agents could not be verified in the shared roster.');
    const at = ISO();
    const consent: TeamConsent = {
      teamId: shared.teamId, sharedProjectId: shared.sharedProjectId, accountId, deviceId, agentIds,
      permissionLevel: input.permissionLevel, settingsVersion: input.settingsVersion,
      disclaimerVersion: input.disclaimerVersion, state: 'granted', acceptedAt: at, updatedAt: at,
    };
    saveConsent(consent);
    recordStructureUpdated(shared.sharedProjectId, 'Team consent updated');
    const payload = TeamConsentPayloadSchema.parse({ sharedProjectId: shared.sharedProjectId, agentIds,
      permissionLevel: input.permissionLevel, settingsVersion: input.settingsVersion,
      disclaimerVersion: input.disclaimerVersion, state: 'granted', at });
    let hostSync: 'sent' | 'failed' = 'sent';
    try { if (!await sendToHost(shared, 'teamgroup.consent', payload, `team-consent:${accountId}:${deviceId}:${at}`)) hostSync = 'failed'; }
    catch { hostSync = 'failed'; }
    return { ...consent, hostSync, publishedSessionIds: sessions.map((session) => session.id) };
  }

  async function updateConsent(projectId: string, raw: unknown): Promise<unknown> {
    const parsed = UpdateTeamConsentSchema.parse(raw);
    if (!deps.store.getProject(projectId)) throw new HttpError(404, 'Project not found.');
    const localBinding = db.prepare(`SELECT shared_project_id,team_id FROM mingle_project_collaboration_sources WHERE local_project_id=?
      UNION ALL SELECT shared_project_id,team_id FROM mingle_project_collaboration_joins WHERE local_project_id=? LIMIT 1`)
      .get(projectId, projectId) as { shared_project_id: string; team_id: string } | undefined;
    if (!localBinding) throw new HttpError(409, 'Set up teammate sharing for this project before managing team consent.');
    const signedInAccountId = deps.account.snapshot().user?.id;
    const localDeviceId = deps.transport.snapshot(localBinding.team_id).deviceId;
    const rows = db.prepare(`SELECT consent_json FROM mingle_team_device_consents WHERE shared_project_id=? ORDER BY updated_at DESC`)
      .all(localBinding.shared_project_id) as Array<{ consent_json: string }>;
    const selected = rows.find((candidate) => {
      try {
        const consent = parseConsent(JSON.parse(candidate.consent_json));
        return (!signedInAccountId || consent.accountId === signedInAccountId) && (!localDeviceId || consent.deviceId === localDeviceId);
      }
      catch { return false; }
    });
    if (!selected) throw new HttpError(404, 'This device has not accepted team consent for the project.');
    const previous = parseConsent(JSON.parse(selected.consent_json));
    const consent: TeamConsent = { ...previous, state: parsed.state as TeamConsentState, updatedAt: ISO() };
    saveConsent(consent);
    recordStructureUpdated(consent.sharedProjectId, 'Team consent updated');
    if (consent.state === 'paused' || consent.state === 'revoked') {
      let rows: Array<{ delivery_id: string; agent_id: string; session_id: string; status: string }> = [];
      if (consent.agentIds.length) {
        const rawRows = db.prepare(`SELECT delivery_id,agent_id,session_id,status FROM mingle_team_device_deliveries
        WHERE shared_project_id=? AND agent_id IN (${consent.agentIds.map(() => '?').join(',')})
        AND status IN ('accepted','running','awaiting-approval')`).all(consent.sharedProjectId, ...consent.agentIds);
        rows = rawRows as Array<{ delivery_id: string; agent_id: string; session_id: string; status: string }>;
      }
      for (const delivery of rows) {
        proxy.closeDelivery(delivery.delivery_id);
        if (delivery.status === 'accepted') {
          cancelled.add(delivery.delivery_id);
          const changed = db.prepare(`UPDATE mingle_team_device_deliveries SET status='interrupted',error=?,updated_at=?
            WHERE delivery_id=? AND status='accepted'`).run('Owner consent was paused or revoked before the run started.', ISO(), delivery.delivery_id);
          if (Number(changed.changes) === 1) {
            const shared = await findBindingBySharedProject(consent.teamId, consent.sharedProjectId);
            const host = shared ? await hostDeviceId(shared) : null;
            if (host) await sendStatus(consent.teamId, host, { sharedProjectId: consent.sharedProjectId,
              deliveryId: delivery.delivery_id, agentId: delivery.agent_id, status: 'interrupted' }).catch(() => undefined);
          }
        } else {
          active.get(delivery.delivery_id)?.controller.abort();
          deps.runtime.interrupt(delivery.session_id);
        }
      }
    }
    const payload = TeamConsentPayloadSchema.parse({ sharedProjectId: consent.sharedProjectId, agentIds: consent.agentIds,
      permissionLevel: consent.permissionLevel, settingsVersion: consent.settingsVersion,
      disclaimerVersion: consent.disclaimerVersion, state: consent.state, at: consent.updatedAt });
    let hostSync: 'sent' | 'failed' = 'sent';
    try {
      const shared = await binding(projectId);
      if (shared.sharedProjectId !== consent.sharedProjectId || shared.teamId !== consent.teamId
        || !await sendToHost(shared, 'teamgroup.consent', payload, `team-consent:${consent.accountId}:${consent.deviceId}:${consent.updatedAt}`)) hostSync = 'failed';
    }
    catch { hostSync = 'failed'; }
    return { ...consent, hostSync };
  }

  async function saveStructure(envelope: AuthenticatedEnvelope): Promise<void> {
    const parsed = TeamStructurePayloadSchema.safeParse(envelope.payload);
    if (!parsed.success || parsed.data.sharedProjectId !== (envelope.payload as Record<string, unknown>)?.sharedProjectId) return;
    const sharedProjectId = parsed.data.sharedProjectId;
    const localBinding = await findBindingBySharedProject(envelope.teamId, sharedProjectId);
    if (!localBinding) return;
    if (!await authorizedHost(envelope, localBinding)) return;
    const prior = latestStructure(sharedProjectId);
    if (prior && parsed.data.settings.version < prior.settings.version) return;
    if (prior && parsed.data.settings.version === prior.settings.version && JSON.stringify(parsed.data) === JSON.stringify(prior)) return;
    deps.store.tx(() => {
      db.prepare(`INSERT INTO mingle_team_device_structures(shared_project_id,team_id,host_device_id,structure_json,version,received_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(shared_project_id) DO UPDATE SET team_id=excluded.team_id,host_device_id=excluded.host_device_id,
        structure_json=excluded.structure_json,version=excluded.version,received_at=excluded.received_at`)
        .run(sharedProjectId, envelope.teamId, envelope.fromDeviceId, JSON.stringify(parsed.data), parsed.data.settings.version, ISO());
      const accountId = deps.account.snapshot().user?.id;
      const localDeviceId = deps.transport.snapshot(envelope.teamId).deviceId;
      const row = accountId && localDeviceId
        ? db.prepare(`SELECT consent_json FROM mingle_team_device_consents WHERE shared_project_id=? AND account_id=? AND device_id=?`)
          .get(sharedProjectId, accountId, localDeviceId) as { consent_json: string } | undefined
        : undefined;
      if (row) {
        const consent = parseConsent(JSON.parse(row.consent_json));
        const disclaimerVersion = parsed.data.disclaimerVersion ?? TEAM_CONSENT_DISCLAIMER_VERSION;
        if (permissionRank(parsed.data.settings.permissionLevel) > permissionRank(consent.permissionLevel)
          || disclaimerVersion !== consent.disclaimerVersion) {
          saveConsent({ ...consent, state: 'needs-reconsent', updatedAt: ISO() });
        }
      }
    });
    const sessionChanged = JSON.stringify(prior?.teamSession ?? null) !== JSON.stringify(parsed.data.teamSession ?? null);
    if (sessionChanged) {
      deps.store.recordEvent({ projectId: localBinding.projectId, type: 'team.session.updated', summary: 'Shared team session updated',
        payload: { teamSession: parsed.data.teamSession ?? null } });
    }
    recordStructureUpdated(sharedProjectId, 'Shared team structure updated', parsed.data.teamSession ?? null);
  }

  async function findBindingBySharedProject(teamId: string, sharedProjectId: string): Promise<SharedBinding | null> {
    const rows = db.prepare(`SELECT local_project_id FROM mingle_project_collaboration_sources WHERE team_id=? AND shared_project_id=?
      UNION ALL SELECT local_project_id FROM mingle_project_collaboration_joins WHERE team_id=? AND shared_project_id=? LIMIT 1`)
      .all(teamId, sharedProjectId, teamId, sharedProjectId) as Array<{ local_project_id: string }>;
    for (const row of rows) {
      const project = await binding(row.local_project_id).catch(() => null);
      if (project?.teamId === teamId && project.sharedProjectId === sharedProjectId) return project;
    }
    return null;
  }

  function saveActivity(sharedProjectId: string, agentId: string, senderDeviceId: string, runId: string | null, entries: TeamAgentActivityEntry[]): void {
    const insert = db.prepare(`INSERT OR IGNORE INTO mingle_team_device_activity
      (shared_project_id,agent_id,sender_device_id,entry_id,run_id,at,entry_json) VALUES(?,?,?,?,?,?,?)`);
    let changedRows = 0;
    for (const entry of entries) changedRows += Number(insert.run(sharedProjectId, agentId, senderDeviceId, entry.id, runId, entry.at, JSON.stringify(entry)).changes);
    const excess = db.prepare(`SELECT seq FROM mingle_team_device_activity WHERE shared_project_id=? AND agent_id=? ORDER BY seq DESC LIMIT -1 OFFSET ?`)
      .all(sharedProjectId, agentId, MAX_MIRRORED_ENTRIES) as Array<{ seq: number }>;
    if (excess.length) changedRows += Number(db.prepare(`DELETE FROM mingle_team_device_activity WHERE seq IN (${excess.map(() => '?').join(',')})`).run(...excess.map((row) => row.seq)).changes);
    if (changedRows > 0) changed();
  }

  async function receiveActivity(envelope: AuthenticatedEnvelope): Promise<void> {
    const parsed = TeamActivityPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const shared = await findBindingBySharedProject(envelope.teamId, parsed.data.sharedProjectId);
    if (!shared || envelope.toDeviceId !== deps.transport.snapshot(envelope.teamId).deviceId) return;
    const rosterAgent = shared.agents.find((agent) => agent.id === parsed.data.agentId && agent.deviceId === envelope.fromDeviceId)
      ?? shared.agents.find((agent) => agent.sessionId === parsed.data.agentId && agent.deviceId === envelope.fromDeviceId);
    if (!rosterAgent || !shared.members.some((member) => member.accountId === rosterAgent.accountId)
      || rosterAgent.accountId === deps.account.snapshot().user?.id && envelope.fromDeviceId === deps.transport.snapshot(envelope.teamId).deviceId) return;
    const safeEntries = parsed.data.entries.flatMap((entry) => {
      const safe = TeamAgentActivityEntrySchema.safeParse({ ...entry, text: safeText(entry.text, 8_000), ...(entry.toolName ? { toolName: safeText(entry.toolName, 120) } : {}) });
      return safe.success ? [safe.data] : [];
    });
    saveActivity(parsed.data.sharedProjectId, rosterAgent.id, envelope.fromDeviceId, parsed.data.runId, safeEntries);
  }

  async function teamActivity(projectId: string, agentId: string, before?: string): Promise<TeamAgentActivity> {
    const shared = await binding(projectId);
    const agent = shared.agents.find((candidate) => candidate.id === agentId)
      ?? shared.agents.find((candidate) => candidate.sessionId === agentId);
    if (!agent) throw new HttpError(404, 'Team agent not found.');
    const canonicalAgentId = agent.id;
    const ownDeviceId = deps.transport.snapshot(shared.teamId).deviceId;
    const local = agent.deviceId === ownDeviceId && agent.sessionId !== null;
    if (!local) {
      const state = mapAgentState(agent.state);
      const cursorSeq = before && /^\d+$/.test(before) ? Number(before) : null;
      const rows = db.prepare(`SELECT seq,entry_json FROM mingle_team_device_activity WHERE shared_project_id=? AND agent_id=?
        ${cursorSeq === null ? '' : 'AND seq < ?'} ORDER BY seq DESC LIMIT 101`)
        .all(...(cursorSeq === null ? [shared.sharedProjectId, canonicalAgentId] : [shared.sharedProjectId, canonicalAgentId, cursorSeq])) as Array<{ seq: number; entry_json: string }>;
      const hasMore = rows.length > 100;
      const page = rows.slice(0, 100).reverse().map((row) => TeamAgentActivityEntrySchema.parse(JSON.parse(row.entry_json)));
      const last = rows.at(99)?.seq;
      const latest = db.prepare('SELECT MAX(at) AS at FROM mingle_team_device_activity WHERE shared_project_id=? AND agent_id=?').get(shared.sharedProjectId, canonicalAgentId) as { at: string | null };
      const latestStatusRow = db.prepare(`SELECT entry_json FROM mingle_team_device_activity WHERE shared_project_id=? AND agent_id=? ORDER BY seq DESC LIMIT 1`)
        .get(shared.sharedProjectId, canonicalAgentId) as { entry_json: string } | undefined;
      const latestStatus = latestStatusRow ? TeamAgentActivityEntrySchema.parse(JSON.parse(latestStatusRow.entry_json)) : null;
      const runIdRow = db.prepare(`SELECT run_id FROM mingle_team_device_activity WHERE shared_project_id=? AND agent_id=? AND run_id IS NOT NULL ORDER BY seq DESC LIMIT 1`)
        .get(shared.sharedProjectId, canonicalAgentId) as { run_id: string } | undefined;
      return { agentId: canonicalAgentId, local: false, state: latestStatus?.kind === 'status' ? mapAgentState(latestStatus.status ?? state) : state,
        runId: runIdRow?.run_id ?? null, entries: page,
        nextCursor: hasMore && last !== undefined ? String(last) : null, mirroredAt: latest.at ?? null };
    }
    if (!agent.sessionId) throw new HttpError(404, 'Local team agent session is no longer available.');
    const session = deps.store.getSession(agent.sessionId);
    if (!session) throw new HttpError(404, 'Local team agent session is no longer available.');
    const entries = localEntries(session.id);
    let start = entries.length;
    if (before) {
      const found = entries.findIndex((entry) => entry.id === before);
      if (found >= 0) start = found;
    }
    const begin = Math.max(0, start - 100);
    const page = entries.slice(begin, start);
    const latestRun = db.prepare('SELECT id FROM session_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(session.id) as { id: string } | undefined;
    return { agentId: canonicalAgentId, local: true, state: mapSessionState(session.status), runId: latestRun?.id ?? null,
      entries: page, nextCursor: begin > 0 ? page[0]?.id ?? null : null, mirroredAt: null };
  }

  function localEntries(sessionId: string): TeamAgentActivityEntry[] {
    const messages = deps.store.listMessages(sessionId, { limit: 2000 });
    const entries: TeamAgentActivityEntry[] = messages.flatMap((message) => {
      if (message.kind === 'streaming' || !['user', 'assistant', 'system'].includes(message.role)) return [];
      const kind = message.role === 'user' ? 'request' : message.role === 'assistant' ? 'assistant' : message.kind === 'error' ? 'error' : 'status';
      return [TeamAgentActivityEntrySchema.parse({ id: `message:${message.id}`, runId: message.runId ?? null, at: message.createdAt,
        kind, text: safeText(message.content, 8_000) })];
    });
    const runs = db.prepare('SELECT id FROM session_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 50').all(sessionId) as Array<{ id: string }>;
    let toolCount = 0;
    for (const run of runs) {
      for (const tool of deps.store.listRunTools(run.id, Math.min(500 - toolCount, 200))) {
        entries.push(TeamAgentActivityEntrySchema.parse({ id: `tool:${tool.id}`, runId: run.id,
          at: tool.finishedAt ?? tool.startedAt, kind: 'tool', text: safeText(`${tool.name} (${tool.status})`, 8_000), toolName: safeText(tool.name, 120), status: tool.status }));
        toolCount += 1;
      }
      if (toolCount >= 500) break;
    }
    const approvals = db.prepare(`SELECT id,tool,description,status,created_at FROM approvals WHERE session_id=? AND input IS NOT NULL
      ORDER BY rowid DESC LIMIT 100`).all(sessionId) as Array<{ id: string; tool: string; description: string; status: string; created_at: string }>;
    for (const approval of approvals) entries.push(TeamAgentActivityEntrySchema.parse({ id: `approval:${approval.id}`, runId: null,
      at: approval.created_at, kind: 'approval', status: approval.status, text: safeText(`${approval.tool}: ${approval.description}`, 8_000) }));
    return entries.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id)).slice(-500);
  }

  async function sendActivity(activeDelivery: ActiveDelivery, state: ActiveDelivery['activityState'], flushText = true): Promise<void> {
    if (closed) {
      activeDelivery.activityWaiters.splice(0).forEach((resolve) => resolve());
      return;
    }
    if (flushText && activeDelivery.text) {
      activeDelivery.entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: activeDelivery.runId,
        at: ISO(), kind: 'assistant', text: safeText(activeDelivery.text, MAX_ACTIVITY_TEXT) }));
      activeDelivery.text = '';
    }
    activeDelivery.activityState = state;
    if (activeDelivery.timer) return new Promise((resolve) => activeDelivery.activityWaiters.push(resolve));
    const intervalMs = Math.max(1, Math.min(ACTIVITY_THROTTLE_MS, deps.activityThrottleMs ?? ACTIVITY_THROTTLE_MS));
    const remaining = intervalMs - (Date.now() - (lastActivitySentAt.get(activeDelivery.payload.agentId) ?? 0));
    if (remaining > 0) return new Promise((resolve) => {
      activeDelivery.activityWaiters.push(resolve);
      scheduleActivity(activeDelivery);
    });
    return flushActivity(activeDelivery);
  }

  async function flushActivity(activeDelivery: ActiveDelivery): Promise<void> {
    const state = activeDelivery.activityState;
    if (activeDelivery.text) {
      activeDelivery.entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: activeDelivery.runId,
        at: ISO(), kind: 'assistant', text: safeText(activeDelivery.text, MAX_ACTIVITY_TEXT) }));
      activeDelivery.text = '';
    }
    const entries = activeDelivery.entries.splice(0, ACTIVITY_BATCH_SIZE - 1);
    entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: activeDelivery.runId,
      at: ISO(), kind: 'status', status: state, text: `Agent state: ${state}` }));
    const payload = TeamActivityPayloadSchema.parse({ sharedProjectId: activeDelivery.payload.sharedProjectId,
      agentId: activeDelivery.payload.agentId, state, runId: activeDelivery.runId, entries });
    saveActivity(payload.sharedProjectId, payload.agentId, deps.transport.snapshot(activeDelivery.teamId).deviceId ?? '', payload.runId, entries);
    const snapshot = deps.transport.snapshot(activeDelivery.teamId);
    const peers = snapshot.devices.filter((device) => device.id !== snapshot.deviceId && !device.revokedAt
      && snapshot.links.some((link) => link.deviceId === snapshot.deviceId && link.peerDeviceId === device.id && link.mutual));
    lastActivitySentAt.set(activeDelivery.payload.agentId, Date.now());
    await Promise.allSettled(peers.map((peer) => send(activeDelivery.teamId, peer.id, 'teamgroup.activity', payload,
      `teamactivity:${activeDelivery.payload.agentId}:${entries[0]?.id ?? `${state}:${activeDelivery.runId}`}:${peer.id}`)));
    if (activeDelivery.entries.length || activeDelivery.text) scheduleActivity(activeDelivery);
    else for (const resolve of activeDelivery.activityWaiters.splice(0)) resolve();
  }

  function scheduleActivity(activeDelivery: ActiveDelivery): void {
    if (activeDelivery.timer || closed) return;
    const intervalMs = Math.max(1, Math.min(ACTIVITY_THROTTLE_MS, deps.activityThrottleMs ?? ACTIVITY_THROTTLE_MS));
    const remaining = Math.max(0, intervalMs - (Date.now() - (lastActivitySentAt.get(activeDelivery.payload.agentId) ?? 0)));
    activeDelivery.timer = setTimeout(() => {
      activeDelivery.timer = null;
      const current = active.get(activeDelivery.payload.deliveryId);
      if (!current) return;
      void track(flushActivity(current));
    }, Math.max(1, remaining));
    activeDelivery.timer.unref();
  }

  function pushActivity(activeDelivery: ActiveDelivery, event: import('@mingle/contracts').AdapterEvent): void {
    if (event.type === 'text') {
      activeDelivery.text = safeText((activeDelivery.text + event.text).slice(-MAX_ACTIVITY_TEXT), MAX_ACTIVITY_TEXT);
      scheduleActivity(activeDelivery);
      return;
    }
    if (event.type === 'tool') {
      activeDelivery.entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: activeDelivery.runId, at: ISO(), kind: 'tool',
        text: safeText(`Tool activity: ${event.name}`, 8_000), toolName: safeText(event.name, 120) }));
    } else if (event.type === 'tool.activity') {
      const activity = event.activity;
      activeDelivery.entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: activeDelivery.runId,
        at: ISO(), kind: 'tool', text: safeText(`${activity.name} (${activity.status})`, 8_000),
        toolName: safeText(activity.name, 120), status: activity.status }));
    } else if (event.type === 'info') {
      activeDelivery.entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: activeDelivery.runId, at: ISO(), kind: 'status', text: safeText(event.content, 8_000) }));
    }
    if (activeDelivery.entries.length >= ACTIVITY_BATCH_SIZE) scheduleActivity(activeDelivery);
  }

  async function validateDelivery(envelope: AuthenticatedEnvelope, payload: TeamDeliveryPayload): Promise<{ shared: SharedBinding; agent: SharedBinding['agents'][number]; sessionId: string } | { rejection: 'no-consent' | 'needs-reconsent' | 'paused' | 'agent-unavailable' | 'busy' | 'invalid' }> {
    const shared = await findBindingBySharedProject(envelope.teamId, payload.sharedProjectId);
    if (!shared || payload.sharedProjectId !== shared.sharedProjectId || !await authorizedHost(envelope, shared)
      || payload.integrationDeviceId !== await hostDeviceId(shared)) return { rejection: 'invalid' };
    const localDeviceId = deps.transport.snapshot(shared.teamId).deviceId;
    const agent = shared.agents.find((candidate) => candidate.id === payload.agentId && candidate.deviceId === localDeviceId)
      ?? shared.agents.find((candidate) => candidate.sessionId === payload.agentId && candidate.deviceId === localDeviceId);
    if (!agent || !agent.sessionId) return { rejection: 'agent-unavailable' };
    const accountId = await currentAccountId();
    if (agent.accountId !== accountId) return { rejection: 'agent-unavailable' };
    const row = db.prepare(`SELECT consent_json FROM mingle_team_device_consents WHERE shared_project_id=? AND account_id=? AND device_id=?`)
      .get(shared.sharedProjectId, accountId, agent.deviceId) as { consent_json: string } | undefined;
    if (!row) return { rejection: 'no-consent' };
    const consent = parseConsent(JSON.parse(row.consent_json));
    if (consent.state === 'needs-reconsent') return { rejection: 'needs-reconsent' };
    if (consent.state === 'paused' || consent.state === 'revoked') return { rejection: 'paused' };
    if (consent.state !== 'granted' || !consent.agentIds.includes(agent.id)) return { rejection: 'no-consent' };
    if (permissionRank(payload.permissionLevel) > permissionRank(consent.permissionLevel)) return { rejection: 'invalid' };
    if (payload.settingsVersion < consent.settingsVersion) return { rejection: 'invalid' };
    const structure = latestStructure(shared.sharedProjectId);
    if (structure && (payload.settingsVersion < structure.settings.version || payload.permissionLevel !== structure.settings.permissionLevel)) return { rejection: 'invalid' };
    const session = deps.store.getSession(agent.sessionId);
    if (!session || session.projectId !== shared.projectId || !deps.store.listSessions(shared.projectId).some((item) => item.id === agent.sessionId)) return { rejection: 'agent-unavailable' };
    if (deps.runtime.isActive(session.id) || ['running', 'waiting'].includes(session.status)) return { rejection: 'busy' };
    return { shared, agent, sessionId: session.id };
  }

  async function sendStatus(teamId: string, toDeviceId: string, input: {
    sharedProjectId: string; deliveryId: string; agentId: string;
    status: 'accepted' | 'running' | 'awaiting-approval' | 'completed' | 'failed' | 'interrupted' | 'rejected';
    runId?: string | null; finalText?: string; artifacts?: Array<{ revision: string; path?: string; taskId?: string; transferId?: string }>;
    failure?: ProviderFailure; rejection?: 'no-consent' | 'needs-reconsent' | 'paused' | 'agent-unavailable' | 'busy' | 'invalid';
  }): Promise<void> {
    const payload = TeamDeliveryStatusPayloadSchema.parse({ ...input, runId: input.runId ?? null,
      artifacts: input.artifacts ?? [], at: ISO() });
    await send(teamId, toDeviceId, 'teamgroup.delivery.status', payload, `teamdelivery:${input.deliveryId}:${input.status}`);
  }

  async function receiveDelivery(envelope: AuthenticatedEnvelope): Promise<void> {
    const parsed = TeamDeliveryPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      const raw = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload as Record<string, unknown> : {};
      if (identifier(raw.sharedProjectId) && identifier(raw.deliveryId) && identifier(raw.agentId)) {
        const shared = await findBindingBySharedProject(envelope.teamId, raw.sharedProjectId);
        if (shared && await authorizedHost(envelope, shared)) await sendStatus(envelope.teamId, envelope.fromDeviceId, {
          sharedProjectId: shared.sharedProjectId, deliveryId: raw.deliveryId, agentId: raw.agentId,
          status: 'rejected', rejection: 'invalid',
        });
      }
      return;
    }
    const resolvedBinding = await findBindingBySharedProject(envelope.teamId, parsed.data.sharedProjectId);
    const ownDeviceId = resolvedBinding ? deps.transport.snapshot(resolvedBinding.teamId).deviceId : null;
    const localAgent = resolvedBinding && ownDeviceId
      ? resolvedBinding.agents.find((agent) => agent.id === parsed.data.agentId && agent.deviceId === ownDeviceId)
        ?? resolvedBinding.agents.find((agent) => agent.sessionId === parsed.data.agentId && agent.deviceId === ownDeviceId)
      : undefined;
    const payload = localAgent ? { ...parsed.data, agentId: localAgent.id } : parsed.data;
    const duplicate = db.prepare('SELECT request_json,status,run_id FROM mingle_team_device_deliveries WHERE delivery_id=?').get(payload.deliveryId) as { request_json: string; status: string; run_id: string | null } | undefined;
    if (duplicate) {
      const shared = await findBindingBySharedProject(envelope.teamId, payload.sharedProjectId);
      if (!shared || !await authorizedHost(envelope, shared)) return;
      let priorPayload: ReturnType<typeof TeamDeliveryPayloadSchema.safeParse> | null = null;
      try { priorPayload = TeamDeliveryPayloadSchema.safeParse(JSON.parse(duplicate.request_json)); } catch { /* malformed saved payload rejects below */ }
      const canonicalPrior = priorPayload?.success && localAgent && priorPayload.data.agentId === localAgent.sessionId
        ? { ...priorPayload.data, agentId: localAgent.id } : priorPayload?.success ? priorPayload.data : null;
      if (!canonicalPrior || JSON.stringify(canonicalPrior) !== JSON.stringify(payload)) {
        await sendStatus(envelope.teamId, envelope.fromDeviceId, { sharedProjectId: payload.sharedProjectId,
          deliveryId: payload.deliveryId, agentId: payload.agentId, status: 'rejected', rejection: 'invalid' });
      } else {
        const status = ['accepted', 'running', 'awaiting-approval', 'completed', 'failed', 'interrupted', 'rejected'].includes(duplicate.status)
          ? duplicate.status as 'accepted' | 'running' | 'awaiting-approval' | 'completed' | 'failed' | 'interrupted' | 'rejected' : 'accepted';
        await sendStatus(envelope.teamId, envelope.fromDeviceId, { sharedProjectId: payload.sharedProjectId,
          deliveryId: payload.deliveryId, agentId: payload.agentId, status, runId: duplicate.run_id });
      }
      return;
    }
    const validation = await validateDelivery(envelope, payload);
    if ('rejection' in validation) {
      await sendStatus(envelope.teamId, envelope.fromDeviceId, { sharedProjectId: payload.sharedProjectId,
        deliveryId: payload.deliveryId, agentId: payload.agentId, status: 'rejected', rejection: validation.rejection });
      return;
    }
    const at = ISO();
    try {
      db.prepare(`INSERT INTO mingle_team_device_deliveries(delivery_id,shared_project_id,agent_id,session_id,request_json,status,
        base_revision,created_at,updated_at) VALUES(?,?,?,?,?,'accepted',?,?,?)`)
        .run(payload.deliveryId, payload.sharedProjectId, payload.agentId, validation.sessionId, JSON.stringify(payload), payload.baseRevision ?? null, at, at);
    } catch {
      await sendStatus(envelope.teamId, envelope.fromDeviceId, { sharedProjectId: payload.sharedProjectId,
        deliveryId: payload.deliveryId, agentId: payload.agentId, status: 'rejected', rejection: 'invalid' });
      return;
    }
    void track(executeDelivery(payload, validation.shared, validation.sessionId));
    await sendStatus(envelope.teamId, envelope.fromDeviceId, { sharedProjectId: payload.sharedProjectId,
      deliveryId: payload.deliveryId, agentId: payload.agentId, status: 'accepted' }).catch(() => undefined);
  }

  async function isolatedWorktree(shared: SharedBinding, payload: TeamDeliveryPayload, sessionId: string): Promise<{ path: string; branch: string | null; baseRevision: string | null }> {
    const session = deps.store.getSession(sessionId);
    const project = deps.store.getProject(shared.projectId);
    if (!session || !project) throw new HttpError(409, 'The local agent session or project is no longer available.');
    const projectRoot = await realpath(project.path);
    let baseRevision = payload.baseRevision ?? null;
    for (const artifact of payload.inputArtifacts) {
      await deps.distributed.importTeamArtifact({ teamId: shared.teamId, sharedProjectId: shared.sharedProjectId,
        deliveryId: payload.deliveryId, artifact, sourceDeviceId: payload.integrationDeviceId });
      const object = await git(session.worktreePath, ['cat-file', '-e', `${artifact.revision}^{commit}`], { allowFailure: true, maxBuffer: 4096 });
      if (object.code !== 0) throw new HttpError(409, 'An input artifact revision has not been imported into this device’s local Git objects.');
    }
    if (baseRevision) {
      const exists = await git(session.worktreePath, ['cat-file', '-e', `${baseRevision}^{commit}`], { allowFailure: true, maxBuffer: 4096 });
      if (exists.code !== 0) throw new HttpError(409, 'The delivery base revision is not present in the owner-selected local project repository.');
    }
    if (session.isolated) {
      const worktreePath = await realpath(session.worktreePath);
      if (worktreePath === projectRoot) throw new HttpError(409, 'The shared agent session points at the project’s main checkout and cannot run remotely.');
      const top = trimmed(await git(worktreePath, ['rev-parse', '--show-toplevel']));
      const canonicalTop = await realpath(top);
      if (canonicalTop === projectRoot) throw new HttpError(409, 'The shared agent session is not an isolated Git worktree.');
      baseRevision = trimmed(await git(worktreePath, ['rev-parse', '--verify', 'HEAD']));
      return { path: worktreePath, branch: session.branch, baseRevision };
    }
    if (!baseRevision) baseRevision = trimmed(await git(projectRoot, ['rev-parse', '--verify', 'HEAD']));
    const directory = path.join(os.tmpdir(), 'mingle-team-agent-worktrees', createHash('sha256').update(shared.sharedProjectId).digest('hex').slice(0, 20));
    await mkdir(directory, { recursive: true });
    const worktreePath = path.join(directory, createHash('sha256').update(payload.deliveryId).digest('hex').slice(0, 24));
    const branch = `mingle/team-agent/${createHash('sha256').update(payload.deliveryId).digest('hex').slice(0, 20)}`;
    await git(projectRoot, ['worktree', 'add', '-b', branch, worktreePath, baseRevision]);
    return { path: worktreePath, branch, baseRevision };
  }

  async function exportCommits(activeDelivery: ActiveDelivery): Promise<Array<{ revision: string; transferId?: string; taskId?: string; ref?: string }>> {
    const head = trimmed(await git(activeDelivery.worktreePath, ['rev-parse', '--verify', 'HEAD']));
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head) || head === activeDelivery.baseRevision) return [];
    const args = activeDelivery.baseRevision
      ? ['rev-list', '--reverse', '--max-count=30', `${activeDelivery.baseRevision}..${head}`]
      : ['rev-list', '--reverse', '--max-count=30', head];
    const revisions = trimmed(await git(activeDelivery.worktreePath, args)).split(/\s+/).filter((id) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(id));
    const artifacts: Array<{ revision: string; transferId?: string; taskId?: string; ref?: string }> = [];
    for (const revision of revisions) {
      try {
        const artifact = await deps.distributed.git.exportTeamArtifact({ teamId: activeDelivery.teamId,
          sharedProjectId: activeDelivery.payload.sharedProjectId, toDeviceId: activeDelivery.payload.integrationDeviceId,
          deliveryId: activeDelivery.payload.deliveryId, revision, baseRevision: activeDelivery.baseRevision ?? undefined,
          sourceWorktreePath: activeDelivery.worktreePath, taskId: activeDelivery.payload.taskId });
        artifacts.push(artifact);
        activeDelivery.entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: activeDelivery.runId,
          at: ISO(), kind: 'artifact', text: `Committed artifact ${revision.slice(0, 12)} was sent to the integration device as ${artifact.ref}.` }));
      } catch (error) {
        activeDelivery.artifactFailures.push(safeText(`Commit ${revision.slice(0, 12)}: ${errorMessage(error)}`, 500));
        activeDelivery.entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: activeDelivery.runId,
          at: ISO(), kind: 'error', text: safeText(`Artifact transfer could not be prepared: ${errorMessage(error)}`, 8_000) }));
      }
    }
    return artifacts;
  }

  async function executeDelivery(payload: TeamDeliveryPayload, shared: SharedBinding, sessionId: string): Promise<void> {
    let runId: string | null = null;
    let live: ActiveDelivery | null = null;
    try {
      const ownDeviceId = deps.transport.snapshot(shared.teamId).deviceId;
      const localAgent = shared.agents.find((candidate) => candidate.id === payload.agentId && candidate.deviceId === ownDeviceId)
        ?? shared.agents.find((candidate) => candidate.sessionId === payload.agentId && candidate.deviceId === ownDeviceId);
      if (!localAgent || !localAgent.sessionId || localAgent.sessionId !== sessionId) {
        throw new HttpError(409, 'The published local agent is no longer available for this delivery.');
      }
      const isolated = await isolatedWorktree(shared, payload, sessionId);
      const proxyConnection = await proxy.create({ teamId: shared.teamId, sharedProjectId: shared.sharedProjectId,
        hostDeviceId: (await hostDeviceId(shared))!, deliveryId: payload.deliveryId, agentId: payload.agentId });
      const beforeStart = deliveryStartRejection(payload);
      if (cancelled.has(payload.deliveryId) || beforeStart || !isAcceptedDelivery(payload.deliveryId)) {
        const row = db.prepare('SELECT status FROM mingle_team_device_deliveries WHERE delivery_id=?').get(payload.deliveryId) as { status: string } | undefined;
        if (row?.status === 'accepted') {
          const reason = beforeStart ?? 'paused';
          const changed = db.prepare(`UPDATE mingle_team_device_deliveries SET status=?,error=?,updated_at=? WHERE delivery_id=? AND status='accepted'`)
            .run('rejected', `Delivery no longer eligible to start: ${reason}.`, ISO(), payload.deliveryId);
          if (Number(changed.changes) === 1) await sendStatus(shared.teamId, (await hostDeviceId(shared))!, {
            sharedProjectId: shared.sharedProjectId, deliveryId: payload.deliveryId, agentId: payload.agentId,
            status: 'rejected', rejection: reason,
          }).catch(() => undefined);
        }
        return;
      }
      const consent = localConsent(payload.sharedProjectId);
      const session = deps.store.getSession(sessionId);
      if (!consent || consent.state !== 'granted' || !session) throw new HttpError(409, 'The local agent consent or session changed before execution.');
      const runPolicy = mostRestrictivePolicy(session.policy, payload.permissionLevel, consent.permissionLevel);
      const controller = new AbortController();
      const requestEntry = TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: null, at: ISO(), kind: 'request',
        text: safeText(payload.content, 8_000) });
      try {
        runId = deps.runtime.start(sessionId, payload.content, {
          teamRun: true, teamMcp: proxyConnection, runPolicy,
          worktree: { path: isolated.path, branch: isolated.branch ?? '' },
          taskId: payload.taskId,
          userMessage: { content: payload.content, kind: 'team-delivery' },
          onActivity: (event) => { if (live) pushActivity(live, event); },
          onApproval: (approval) => { if (live) void track(mirrorApproval(live!, approval)); },
          onApprovalDecision: (approval, decision) => {
            if (hostDecisions.delete(approval.id)) return;
            if (live) void track(reflectApprovalDecision(live, approval, decision, true));
          },
        } satisfies StartOptions);
      } catch (error) {
        proxy.closeDelivery(payload.deliveryId);
        throw error;
      }
      live = { payload, teamId: shared.teamId, projectId: shared.projectId, sessionId, runId,
        baseRevision: isolated.baseRevision, worktreePath: isolated.path, branch: isolated.branch,
        entries: [requestEntry], text: '', activityState: 'working', activityWaiters: [],
        timer: null, controller, replyPosted: false, artifactFailures: [] };
      active.set(payload.deliveryId, live);
      db.prepare(`UPDATE mingle_team_device_deliveries SET status='running',run_id=?,worktree_path=?,branch=?,base_revision=?,updated_at=? WHERE delivery_id=? AND status='accepted'`)
        .run(runId, isolated.path, isolated.branch, isolated.baseRevision, ISO(), payload.deliveryId);
      await sendStatus(shared.teamId, (await hostDeviceId(shared))!, { sharedProjectId: shared.sharedProjectId,
        deliveryId: payload.deliveryId, agentId: payload.agentId, status: 'running', runId });
      void sendActivity(live, 'working').catch(() => undefined);
      const run = await waitForRun(sessionId, runId);
      if (!run) throw new Error('The team delivery did not reach a terminal provider state before its execution deadline.');
      if (run.status === 'completed') {
        const initialFinalText = safeText(deps.store.listMessages(sessionId, { limit: 2000 })
          .filter((message) => message.runId === runId && message.role === 'assistant' && message.kind !== 'streaming')
          .map((message) => message.content).join('\n\n').trim(), 50_000);
        const artifacts = await exportCommits(live);
        const transferFailures = live.artifactFailures.length
          ? `\n\nArtifact transfer failures:\n${live.artifactFailures.map((failure) => `- ${failure}`).join('\n')}` : '';
        const finalText = safeText(`${initialFinalText}${transferFailures}`, 50_000);
        db.prepare(`UPDATE mingle_team_device_deliveries SET status='completed',updated_at=? WHERE delivery_id=?`).run(ISO(), payload.deliveryId);
        await sendStatus(shared.teamId, (await hostDeviceId(shared))!, { sharedProjectId: shared.sharedProjectId,
          deliveryId: payload.deliveryId, agentId: payload.agentId, status: 'completed', runId, finalText, artifacts });
        void sendActivity(live, 'idle').catch(() => undefined);
        try {
          if (finalText && !live.replyPosted) {
            live.replyPosted = true;
            await deps.teamChat.postAgentReply(shared.projectId, localAgent.id, finalText, payload.requestId, payload.deliveryId);
          }
        } catch { /* The result remains available to the host even if chat delivery is offline. */ }
      } else if (run.status === 'interrupted') {
        void sendActivity(live, 'paused').catch(() => undefined);
        db.prepare(`UPDATE mingle_team_device_deliveries SET status='interrupted',updated_at=? WHERE delivery_id=?`).run(ISO(), payload.deliveryId);
        await sendStatus(shared.teamId, (await hostDeviceId(shared))!, { sharedProjectId: shared.sharedProjectId,
          deliveryId: payload.deliveryId, agentId: payload.agentId, status: 'interrupted', runId });
      } else {
        const failure = failureFor(sessionId, runId);
        void sendActivity(live, 'failed').catch(() => undefined);
        db.prepare(`UPDATE mingle_team_device_deliveries SET status='failed',error=?,updated_at=? WHERE delivery_id=?`)
          .run(safeText(failure.message, 1000), ISO(), payload.deliveryId);
        await sendStatus(shared.teamId, (await hostDeviceId(shared))!, { sharedProjectId: shared.sharedProjectId,
          deliveryId: payload.deliveryId, agentId: payload.agentId, status: 'failed', runId, failure });
      }
    } catch (error) {
      const failure = runId ? failureFor(sessionId, runId) : createFailure(sessionId, null, deps.store.getSession(sessionId)?.provider ?? 'claude', errorMessage(error));
      if (live) void sendActivity(live, 'failed').catch(() => undefined);
      const changed = db.prepare(`UPDATE mingle_team_device_deliveries SET status='failed',error=?,updated_at=?
        WHERE delivery_id=? AND status IN ('accepted','running','awaiting-approval')`)
        .run(safeText(failure.message, 1000), ISO(), payload.deliveryId);
      const toDeviceId = await hostDeviceId(shared).catch(() => null);
      if (Number(changed.changes) === 1 && toDeviceId) await sendStatus(shared.teamId, toDeviceId, { sharedProjectId: shared.sharedProjectId,
        deliveryId: payload.deliveryId, agentId: payload.agentId, status: 'failed', runId, failure }).catch(() => undefined);
    } finally {
      proxy.closeDelivery(payload.deliveryId);
      if (live?.timer) clearTimeout(live.timer);
      active.delete(payload.deliveryId);
    }
  }

  function isAcceptedDelivery(deliveryId: string): boolean {
    const row = db.prepare('SELECT status FROM mingle_team_device_deliveries WHERE delivery_id=?').get(deliveryId) as { status: string } | undefined;
    return row?.status === 'accepted';
  }

  function deliveryStartRejection(payload: TeamDeliveryPayload): 'no-consent' | 'needs-reconsent' | 'paused' | 'invalid' | null {
    const consent = localConsent(payload.sharedProjectId);
    if (!consent || !consent.agentIds.includes(payload.agentId)) return 'no-consent';
    if (consent.state !== 'granted') return consent.state === 'paused' || consent.state === 'revoked' ? 'paused' : 'needs-reconsent';
    if (permissionRank(payload.permissionLevel) > permissionRank(consent.permissionLevel) || payload.settingsVersion < consent.settingsVersion) return 'invalid';
    const structure = latestStructure(payload.sharedProjectId);
    if (structure && (payload.settingsVersion < structure.settings.version || payload.permissionLevel !== structure.settings.permissionLevel)) return 'invalid';
    return null;
  }

  function failureFor(sessionId: string, runId: string): ProviderFailure {
    const failure = deps.store.latestProviderFailure(sessionId);
    if (failure?.runId === runId) return ProviderFailureSchema.parse(failure);
    const run = deps.store.getRun(runId);
    const session = deps.store.getSession(sessionId, true);
    return createFailure(sessionId, runId, session?.provider ?? run?.provider ?? 'claude', session?.error ?? 'The provider run failed.');
  }

  function createFailure(sessionId: string, runId: string | null, provider: ProviderFailure['provider'], message: string): ProviderFailure {
    return ProviderFailureSchema.parse({ id: `team-device-${randomUUID()}`, sessionId, ...(runId ? { runId } : {}), actor: 'worker',
      kind: 'unknown', provider, retryable: false, dispatchState: 'unknown', continuationSafety: 'unknown',
      message: safeText(message, 1000), occurredAt: ISO() });
  }

  function waitForRun(sessionId: string, runId: string): Promise<ReturnType<Store['getRun']> | null> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      let unsubscribeStore: () => void;
      const finish = (run: ReturnType<Store['getRun']> | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribeStore();
        runWaiters.delete(cancel);
        resolve(run);
      };
      const check = () => {
        const run = deps.store.getRun(runId);
        if (closed || !run || run.status !== 'running') finish(run ?? null);
      };
      const cancel = () => finish(null);
      timer = setTimeout(() => finish(null), DELIVERY_TIMEOUT_MS);
      timer.unref();
      unsubscribeStore = deps.store.subscribe((event) => {
        if (event?.sessionId === sessionId && event.type.startsWith('session.run.') && event.payload.runId === runId) check();
      });
      runWaiters.add(cancel);
      check();
    });
  }

  async function mirrorApproval(activeDelivery: ActiveDelivery, approval: import('@mingle/contracts').Approval): Promise<void> {
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const payload = TeamApprovalRequestPayloadSchema.parse({ sharedProjectId: activeDelivery.payload.sharedProjectId,
      deliveryId: activeDelivery.payload.deliveryId, approvalId: approval.id, agentId: activeDelivery.payload.agentId,
      summary: safeText(`${approval.tool}: ${approval.description}`, 2_000), kind: safeText(approval.tool, 60), expiresAt });
    activeDelivery.entries.push(TeamAgentActivityEntrySchema.parse({ id: `approval:${approval.id}`, runId: activeDelivery.runId,
      at: ISO(), kind: 'approval', status: 'pending', text: payload.summary }));
    scheduleActivity(activeDelivery);
    const host = await hostDeviceId({ projectId: activeDelivery.projectId, teamId: activeDelivery.teamId,
      sharedProjectId: activeDelivery.payload.sharedProjectId,
      members: (await deps.collaboration.snapshot(activeDelivery.projectId)).members,
      agents: (await deps.collaboration.snapshot(activeDelivery.projectId)).agents });
    if (!host) return;
    await send(activeDelivery.teamId, host, 'teamgroup.approval.request', payload, `teamapproval:${approval.id}:request`);
    await sendStatus(activeDelivery.teamId, host, { sharedProjectId: activeDelivery.payload.sharedProjectId,
      deliveryId: activeDelivery.payload.deliveryId, agentId: activeDelivery.payload.agentId, status: 'awaiting-approval', runId: activeDelivery.runId });
    db.prepare(`UPDATE mingle_team_device_deliveries SET status='awaiting-approval',updated_at=? WHERE delivery_id=?`)
      .run(ISO(), activeDelivery.payload.deliveryId);
  }

  async function receiveApprovalDecision(envelope: AuthenticatedEnvelope): Promise<void> {
    const parsed = TeamApprovalDecisionPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const shared = await findBindingBySharedProject(envelope.teamId, parsed.data.sharedProjectId);
    if (!shared || !await authorizedHost(envelope, shared)) return;
    const row = db.prepare(`SELECT session_id FROM mingle_team_device_deliveries WHERE delivery_id=? AND shared_project_id=?`)
      .get(parsed.data.deliveryId, parsed.data.sharedProjectId) as { session_id: string } | undefined;
    if (!row) return;
    const approval = deps.store.db.prepare('SELECT status FROM approvals WHERE id=? AND session_id=?').get(parsed.data.approvalId, row.session_id) as { status: string } | undefined;
    if (!approval || approval.status !== 'pending') return;
    const first = db.prepare(`INSERT OR IGNORE INTO mingle_team_device_approvals(delivery_id,approval_id,decision,decided_at) VALUES(?,?,?,?)`)
      .run(parsed.data.deliveryId, parsed.data.approvalId, parsed.data.decision, ISO());
    if (Number(first.changes) !== 1) return;
    hostDecisions.add(parsed.data.approvalId);
    try {
      const resolved = deps.runtime.decide(parsed.data.approvalId, parsed.data.decision);
      const activeDelivery = active.get(parsed.data.deliveryId);
      if (activeDelivery) await reflectApprovalDecision(activeDelivery, resolved, parsed.data.decision, false);
    } catch {
      hostDecisions.delete(parsed.data.approvalId);
      /* A concurrent local owner decision already won; it is never overwritten. */
    }
  }

  async function reflectApprovalDecision(activeDelivery: ActiveDelivery, approval: import('@mingle/contracts').Approval,
    decision: 'approved' | 'denied', sendDecision: boolean): Promise<void> {
    activeDelivery.entries.push(TeamAgentActivityEntrySchema.parse({ id: `approval:${approval.id}:${decision}`,
      runId: activeDelivery.runId, at: ISO(), kind: 'approval', status: decision, text: `Owner ${decision} the ${safeText(approval.tool, 60)} approval.` }));
    scheduleActivity(activeDelivery);
    db.prepare(`UPDATE mingle_team_device_deliveries SET status='running',updated_at=? WHERE delivery_id=?`)
      .run(ISO(), activeDelivery.payload.deliveryId);
    const shared = await binding(activeDelivery.projectId);
    const host = await hostDeviceId(shared);
    if (!host) return;
    if (sendDecision) {
      const payload = TeamApprovalDecisionPayloadSchema.parse({ sharedProjectId: activeDelivery.payload.sharedProjectId,
        deliveryId: activeDelivery.payload.deliveryId, approvalId: approval.id, decision });
      try { await send(activeDelivery.teamId, host, 'teamgroup.approval.decision', payload, `teamapproval:${approval.id}:owner:${decision}`); }
      catch { /* The owner decision remains authoritative locally while the host is offline. */ }
    }
    await sendStatus(activeDelivery.teamId, host, { sharedProjectId: activeDelivery.payload.sharedProjectId,
      deliveryId: activeDelivery.payload.deliveryId, agentId: activeDelivery.payload.agentId, status: 'running', runId: activeDelivery.runId });
  }

  async function receiveInterrupt(envelope: AuthenticatedEnvelope): Promise<void> {
    const parsed = TeamInterruptPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const shared = await findBindingBySharedProject(envelope.teamId, parsed.data.sharedProjectId);
    if (!shared || !await authorizedHost(envelope, shared)) return;
    const row = db.prepare(`SELECT session_id,status FROM mingle_team_device_deliveries WHERE delivery_id=? AND shared_project_id=?`)
      .get(parsed.data.deliveryId, parsed.data.sharedProjectId) as { session_id: string; status: string } | undefined;
    if (!row || !['accepted', 'running', 'awaiting-approval'].includes(row.status)) return;
    proxy.closeDelivery(parsed.data.deliveryId);
    active.get(parsed.data.deliveryId)?.controller.abort();
    if (row.status === 'accepted') {
      cancelled.add(parsed.data.deliveryId);
      const changed = db.prepare(`UPDATE mingle_team_device_deliveries SET status='interrupted',error=?,updated_at=?
        WHERE delivery_id=? AND status='accepted'`).run(parsed.data.reason, ISO(), parsed.data.deliveryId);
      if (Number(changed.changes) === 1) await sendStatus(envelope.teamId, envelope.fromDeviceId, {
        sharedProjectId: parsed.data.sharedProjectId, deliveryId: parsed.data.deliveryId,
        agentId: (db.prepare('SELECT agent_id FROM mingle_team_device_deliveries WHERE delivery_id=?').get(parsed.data.deliveryId) as { agent_id: string }).agent_id,
        status: 'interrupted',
      }).catch(() => undefined);
      return;
    }
    deps.runtime.interrupt(row.session_id);
  }

  async function handleEnvelope(envelope: AuthenticatedEnvelope): Promise<void> {
    if (closed) return;
    switch (envelope.kind) {
      case 'teamgroup.structure': return await saveStructure(envelope);
      case 'teamgroup.delivery': return await receiveDelivery(envelope);
      case 'teamgroup.interrupt': return await receiveInterrupt(envelope);
      case 'teamgroup.tool.result': proxy.resolve(envelope); return;
      case 'teamgroup.approval.decision': return await receiveApprovalDecision(envelope);
      case 'teamgroup.activity': return await receiveActivity(envelope);
      default: return;
    }
  }

  function routes(add: AddRoute): void {
    add('POST', '/api/projects/:projectId/team-consent', async (ctx) => acceptConsent(routeProjectId(ctx), await ctx.body(AcceptTeamConsentSchema)));
    add('PATCH', '/api/projects/:projectId/team-consent', async (ctx) => updateConsent(routeProjectId(ctx), await ctx.body(UpdateTeamConsentSchema)));
    add('GET', '/api/projects/:projectId/team-agents/:agentId/activity', async (ctx) => {
      const before = ctx.url.searchParams.get('before') ?? undefined;
      if (before !== undefined && before.length > 200) throw new HttpError(400, 'Activity cursor is invalid.');
      return teamActivity(routeProjectId(ctx), routeAgentId(ctx), before);
    });
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    unsubscribe();
    for (const cancel of [...runWaiters]) cancel();
    for (const delivery of active.values()) {
      delivery.controller.abort();
      proxy.closeDelivery(delivery.payload.deliveryId);
      deps.runtime.interrupt(delivery.sessionId);
      if (delivery.timer) clearTimeout(delivery.timer);
      for (const resolve of delivery.activityWaiters.splice(0)) resolve();
    }
    await Promise.allSettled([...work]);
    await proxy.close();
  }

  track(reconcilePersistedDeliveries());
  return { routes, close, latestStructure, localConsent };
}

function routeProjectId(ctx: Ctx): string {
  const id = ctx.params.projectId;
  if (!id || !/^[A-Za-z0-9_.-]{1,100}$/.test(id)) throw new HttpError(404, 'Project not found.');
  return id;
}

function routeAgentId(ctx: Ctx): string {
  const id = ctx.params.agentId;
  if (!id || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) throw new HttpError(404, 'Team agent not found.');
  return id;
}

function mapSessionState(state: string): TeamAgentActivity['state'] {
  if (state === 'running') return 'working';
  if (state === 'waiting') return 'awaiting-approval';
  if (state === 'idle') return 'idle';
  if (state === 'interrupted') return 'paused';
  if (state === 'error') return 'failed';
  return 'offline';
}

function mapAgentState(state: string): TeamAgentActivity['state'] {
  if (state === 'busy' || state === 'running') return 'working';
  if (state === 'waiting') return 'awaiting-approval';
  if (state === 'error') return 'failed';
  if (state === 'working' || state === 'awaiting-approval' || state === 'queued' || state === 'paused' || state === 'failed' || state === 'offline' || state === 'quota-exhausted') return state;
  return 'idle';
}
