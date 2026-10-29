import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  AcceptTeamConsentSchema, TEAM_CONSENT_DISCLAIMER_VERSION, TeamActivityPayloadSchema,
  TeamApprovalDecisionPayloadSchema, TeamApprovalRequestPayloadSchema, TeamConsentPayloadSchema,
  TeamDeliveryHeartbeatPayloadSchema, TeamDeliveryPayloadSchema, TeamDeliveryStatusPayloadSchema, TeamInterruptPayloadSchema,
  TeamStructurePayloadSchema, TeamAgentActivityEntrySchema, TeamArtifactRefSchema, TeamArtifactSchema, UpdateTeamConsentSchema,
} from '@mingle/contracts';
import type {
  ProviderFailure, TeamAgentActivity, TeamAgentActivityEntry, TeamArtifactRef, TeamConsent, TeamConsentState,
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
import { createCommit } from '../../repository/commit.ts';
import { identityArgs } from '../../repository/identity.ts';
import { signingConfigured } from '../../repository/inspect.ts';
import { fetchTeamAgentBranch, fetchTeamIntegrationBranch, pushTeamCompletionBranch, teamAgentBranch } from '../../repository/team-branch.ts';
import { isDeniedName, normalizeRelative } from '../../paths.ts';
import { normalizeScopes, safeArtifactPath, scopesOverlap } from '../../groups/routing.ts';

type AddRoute = (method: string, path: string, handler: (context: Ctx) => unknown | Promise<unknown>) => unknown;
type DeviceTransport = DistributedWorkspaceService['transport'];
type DeviceStore = Pick<Store, 'db' | 'tx' | 'touch' | 'subscribe' | 'recordEvent' | 'getProject' | 'getSession' | 'listSessions' | 'getRun' | 'listMessages' | 'listRunTools' | 'latestProviderFailure'>;
type DeviceRuntime = Pick<SessionRuntime, 'start' | 'isActive' | 'interrupt' | 'decide'>;

const MAX_AUTO_COMMIT_PATHS = 1_000;

export interface DeviceSideDeps {
  store: DeviceStore;
  runtime: DeviceRuntime;
  transport: DeviceTransport;
  account: AccountService;
  distributed: DistributedWorkspaceService;
  collaboration: ProjectCollaborationService;
  teamChat: Pick<TeamChatService, 'postAgentReply'>;
  /** Durable runtime-data root for retained remote delivery worktrees. */
  deliveryWorktreeRoot?: string;
  hub?: { broadcast(event: unknown): void };
  changed?: () => void;
  /** Injectable timing bounds keep transport/runtime tests deterministic. */
  activityThrottleMs?: number;
  toolTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  terminalStatusRetryMs?: number;
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
  turnBase: string;
  worktreePath: string;
  branch: string | null;
  scope: string[] | null;
  entries: TeamAgentActivityEntry[];
  text: string;
  activityState: 'idle' | 'queued' | 'working' | 'awaiting-approval' | 'quota-exhausted' | 'offline' | 'paused' | 'failed';
  activityWaiters: Array<() => void>;
  timer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  heartbeatSequence: number;
  controller: AbortController;
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
function nextConsentAt(previous?: Pick<TeamConsent, 'updatedAt'>): string {
  const now = Date.now();
  const previousAt = previous ? Date.parse(previous.updatedAt) : Number.NaN;
  const nextAt = Number.isFinite(previousAt) ? Math.max(now, previousAt + 1) : now;
  const date = new Date(nextAt);
  if (!Number.isFinite(date.getTime())) throw new HttpError(409, 'The saved team consent timestamp cannot be advanced.');
  return date.toISOString();
}
const permissionRank = (value: TeamPermissionLevel) => value === 'supervised' ? 0 : 1;

function pathInAssignmentScope(file: string, scope: string[] | null): boolean {
  if (!scope) return true;
  let normalizedFile: string;
  try { normalizedFile = normalizeRelative(file); }
  catch { return false; }
  return scope.some((entry) => {
    const overlap = scopesOverlap([normalizedFile], [entry]);
    // scopesOverlap uses the common ancestor as its result; a changed path is allowed only
    // when that common scope is the assignment entry, not when the file merely contains it.
    return overlap !== null && overlap.toLocaleLowerCase() === entry.toLocaleLowerCase();
  });
}

function safeIntegrationBranch(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    || value.includes('..') || value.includes('//') || value.includes('@{') || value.endsWith('/')
    || value.split('/').some((part) => !part || part === '.' || part === '..' || part.endsWith('.lock'))) return null;
  return value;
}

async function committedPaths(worktreePath: string, baseRevision: string | null, head: string): Promise<string[]> {
  const range = baseRevision ? `${baseRevision}..${head}` : head;
  const count = Number(trimmed(await git(worktreePath, ['rev-list', '--count', range], { maxBuffer: 4096 })));
  if (!Number.isSafeInteger(count) || count > 10_000) throw new Error('Committed delivery history exceeds the 10,000-commit safety limit.');
  if (count === 0) return [];
  const result = await git(worktreePath,
    ['log', '--format=', '--name-only', '--no-renames', '--root', '-m', '-z', range], { maxBuffer: 8 * 1024 * 1024 });
  return [...new Set(result.stdout.split('\0').filter(Boolean))];
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
  const agentQueues = new Map<string, Promise<void>>();
  const cancelled = new Set<string>();
  const work = new Set<Promise<unknown>>();
  const runWaiters = new Set<() => void>();
  const lastActivitySentAt = new Map<string, number>();
  const lastActivityNotificationAt = new Map<string, number>();
  const activityNotificationTimers = new Map<string, NodeJS.Timeout>();
  const terminalStatusRetries = new Map<string, NodeJS.Timeout>();
  const hostDecisions = new Set<string>();
  let closed = false;
  const proxy = new TeamMcpProxy(deps.transport, deps.toolTimeoutMs);
  const unsubscribe = deps.transport.onMessage((envelope) => track(handleEnvelope(envelope)));

  function changed(): void {
    deps.store.touch();
    deps.changed?.();
  }

  function notifyActivityUpdated(projectId: string, sharedProjectId: string, agentId: string): void {
    if (!deps.hub) return;
    const key = `${sharedProjectId}:${agentId}`;
    const intervalMs = 1_000;
    const publish = () => {
      activityNotificationTimers.delete(key);
      if (closed) return;
      lastActivityNotificationAt.set(key, Date.now());
      deps.hub?.broadcast({ type: 'state.changed', event: {
        id: 0, projectId, sessionId: null, type: 'team.agent.activity.updated',
        summary: 'Team agent activity updated', payload: { projectId, sharedProjectId, agentId }, createdAt: ISO(),
      } });
    };
    const remaining = intervalMs - (Date.now() - (lastActivityNotificationAt.get(key) ?? 0));
    if (remaining <= 0) { publish(); return; }
    if (!activityNotificationTimers.has(key)) {
      const timer = setTimeout(publish, remaining);
      timer.unref();
      activityNotificationTimers.set(key, timer);
    }
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
    try {
      const consent = parseConsent(JSON.parse(row.consent_json));
      const structure = latestStructure(sharedProjectId);
      const disclaimerChanged = consent.disclaimerVersion !== TEAM_CONSENT_DISCLAIMER_VERSION;
      const permissionRaised = Boolean(structure && permissionRank(structure.settings.permissionLevel) > permissionRank(consent.permissionLevel));
      if (consent.state === 'granted' && (disclaimerChanged || permissionRaised)) {
        const downgraded = { ...consent, state: 'needs-reconsent' as const, updatedAt: nextConsentAt(consent) };
        saveConsent(downgraded);
        return downgraded;
      }
      return consent;
    } catch { return null; }
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

  function currentAccountId(): string {
    const account = deps.account.snapshot();
    if (account.status !== 'signed-in' || !account.user?.id) throw new HttpError(401, 'Sign in to the Mingle account before changing team consent.');
    return account.user.id;
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

  async function authorizedHost(envelope: AuthenticatedEnvelope, original: SharedBinding): Promise<{ ownerId: string; role: string } | null> {
    let shared = original;
    if (envelope.teamId !== shared.teamId || envelope.toDeviceId !== deps.transport.snapshot(shared.teamId).deviceId) return null;
    let refreshed = false;
    const refreshShared = async (): Promise<boolean> => {
      if (!deps.collaboration.refreshSnapshot) return false;
      const current = await deps.collaboration.refreshSnapshot(shared.projectId).catch(() => null);
      if (!current?.project || current.project.teamId !== shared.teamId || current.project.sharedProjectId !== shared.sharedProjectId) return false;
      shared = { ...shared, members: current.members, agents: current.agents };
      refreshed = true;
      return true;
    };
    const evaluate = async () => {
      const expectedHost = await hostDeviceId(shared);
      const device = deps.transport.snapshot(shared.teamId).devices.find((candidate) => candidate.id === envelope.fromDeviceId);
      const member = device && !device.revokedAt
        ? shared.members.find((candidate) => candidate.accountId === device.ownerId && candidate.status === 'active') : undefined;
      return { expectedHost, device, member };
    };
    let authority = await evaluate();
    // New hosts, unknown devices, and cached-removed/role-downgraded senders require a fresh
    // membership read before rejection; this admits legitimate new admins and fences removals.
    if (!refreshed && (!authority.expectedHost || envelope.fromDeviceId !== authority.expectedHost
      || !authority.device || Boolean(authority.device.revokedAt) || !authority.member || !['leader', 'admin'].includes(authority.member.role))) {
      if (!await refreshShared()) return null;
      authority = await evaluate();
    }
    const { expectedHost, device, member } = authority;
    if (!expectedHost || envelope.fromDeviceId !== expectedHost) return null;
    if (!device || device.revokedAt) return null;
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
    const execution = deps.distributed.execution as typeof deps.distributed.execution & {
      publishedAgents?: (teamId: string, sharedProjectId: string) => Promise<import('../../../../../packages/contracts/src/remote-execution.ts').RemoteAgent[]> | import('../../../../../packages/contracts/src/remote-execution.ts').RemoteAgent[];
    };
    const publishedAgents = execution.publishedAgents
      ? await execution.publishedAgents.call(execution, shared.teamId, shared.sharedProjectId)
      : (await execution.snapshot(shared.teamId)).agents;
    const ownPublished = publishedAgents.filter((agent) => agent.sharedProjectId === shared.sharedProjectId && agent.deviceId === deviceId
      && agent.ownerId === accountId).map((agent) => agent.sessionId);
    const toPublish = [...new Set([...ownPublished, ...input.sessionIds])];
    const published = await deps.distributed.execution.publishAgents({ teamId: shared.teamId, sharedProjectId: shared.sharedProjectId, sessionIds: toPublish });
    const bySession = new Map(published.map((agent) => [agent.sessionId, agent.id]));
    const agentIds = input.sessionIds.map((sessionId) => bySession.get(sessionId)).filter((id): id is string => Boolean(id));
    if (agentIds.length !== input.sessionIds.length) throw new HttpError(409, 'The selected agents could not be verified in the shared roster.');
    const previousRow = db.prepare(`SELECT consent_json FROM mingle_team_device_consents
      WHERE shared_project_id=? AND account_id=? AND device_id=?`).get(shared.sharedProjectId, accountId, deviceId) as { consent_json: string } | undefined;
    const previous = previousRow ? parseConsent(JSON.parse(previousRow.consent_json)) : undefined;
    const at = nextConsentAt(previous);
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
    const consent: TeamConsent = { ...previous, state: parsed.state as TeamConsentState, updatedAt: nextConsentAt(previous) };
    // Resolve the host binding before recording the structure event: that event invalidates the
    // collaboration read model, and resolving afterwards would wait on an authoritative cloud read.
    const hostBinding = await binding(projectId).catch(() => null);
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
              deliveryId: delivery.delivery_id, agentId: delivery.agent_id, status: 'interrupted' });
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
      if (!hostBinding || hostBinding.sharedProjectId !== consent.sharedProjectId || hostBinding.teamId !== consent.teamId
        || !await sendToHost(hostBinding, 'teamgroup.consent', payload, `team-consent:${consent.accountId}:${consent.deviceId}:${consent.updatedAt}`)) hostSync = 'failed';
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
          saveConsent({ ...consent, state: 'needs-reconsent', updatedAt: nextConsentAt(consent) });
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

  function saveActivity(projectId: string, sharedProjectId: string, agentId: string, senderDeviceId: string, runId: string | null, entries: TeamAgentActivityEntry[]): void {
    const insert = db.prepare(`INSERT OR IGNORE INTO mingle_team_device_activity
      (shared_project_id,agent_id,sender_device_id,entry_id,run_id,at,entry_json) VALUES(?,?,?,?,?,?,?)`);
    let changedRows = 0;
    for (const entry of entries) changedRows += Number(insert.run(sharedProjectId, agentId, senderDeviceId, entry.id, runId, entry.at, JSON.stringify(entry)).changes);
    const excess = db.prepare(`SELECT seq FROM mingle_team_device_activity WHERE shared_project_id=? AND agent_id=? ORDER BY seq DESC LIMIT -1 OFFSET ?`)
      .all(sharedProjectId, agentId, MAX_MIRRORED_ENTRIES) as Array<{ seq: number }>;
    if (excess.length) changedRows += Number(db.prepare(`DELETE FROM mingle_team_device_activity WHERE seq IN (${excess.map(() => '?').join(',')})`).run(...excess.map((row) => row.seq)).changes);
    if (changedRows > 0) notifyActivityUpdated(projectId, sharedProjectId, agentId);
  }

  async function receiveActivity(envelope: AuthenticatedEnvelope): Promise<void> {
    const parsed = TeamActivityPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    let shared = await findBindingBySharedProject(envelope.teamId, parsed.data.sharedProjectId);
    if (!shared || envelope.toDeviceId !== deps.transport.snapshot(envelope.teamId).deviceId) return;
    let rosterAgent = shared.agents.find((agent) => agent.id === parsed.data.agentId && agent.deviceId === envelope.fromDeviceId)
      ?? shared.agents.find((agent) => agent.sessionId === parsed.data.agentId && agent.deviceId === envelope.fromDeviceId);
    const senderIsActive = () => Boolean(rosterAgent && shared?.members.some((member) => member.accountId === rosterAgent!.accountId && member.status === 'active'));
    if ((!rosterAgent || !senderIsActive()) && deps.collaboration.refreshSnapshot) {
      // Cached absence can represent a just-published agent or a revoked owner; resolve it authoritatively before deciding.
      const refreshed = await deps.collaboration.refreshSnapshot(shared.projectId).catch(() => null);
      if (refreshed?.project?.teamId === shared.teamId && refreshed.project.sharedProjectId === shared.sharedProjectId) {
        shared = { ...shared, members: refreshed.members, agents: refreshed.agents };
        rosterAgent = shared.agents.find((agent) => agent.id === parsed.data.agentId && agent.deviceId === envelope.fromDeviceId)
          ?? shared.agents.find((agent) => agent.sessionId === parsed.data.agentId && agent.deviceId === envelope.fromDeviceId);
      }
    }
    if (!rosterAgent || !senderIsActive()
      || rosterAgent.accountId === deps.account.snapshot().user?.id && envelope.fromDeviceId === deps.transport.snapshot(envelope.teamId).deviceId) return;
    const safeEntries = parsed.data.entries.flatMap((entry) => {
      const safe = TeamAgentActivityEntrySchema.safeParse({ ...entry, text: safeText(entry.text, 8_000), ...(entry.toolName ? { toolName: safeText(entry.toolName, 120) } : {}) });
      return safe.success ? [safe.data] : [];
    });
    saveActivity(shared.projectId, parsed.data.sharedProjectId, rosterAgent.id, envelope.fromDeviceId, parsed.data.runId, safeEntries);
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
    saveActivity(activeDelivery.projectId, payload.sharedProjectId, payload.agentId,
      deps.transport.snapshot(activeDelivery.teamId).deviceId ?? '', payload.runId, entries);
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
    if (payload.hop > 12 && payload.permissionLevel !== 'full-access') return { rejection: 'invalid' };
    let shared = await findBindingBySharedProject(envelope.teamId, payload.sharedProjectId);
    if (!shared || payload.sharedProjectId !== shared.sharedProjectId || !await authorizedHost(envelope, shared)
      || payload.integrationDeviceId !== await hostDeviceId(shared)) return { rejection: 'invalid' };
    const localDeviceId = deps.transport.snapshot(shared.teamId).deviceId;
    let agent = shared.agents.find((candidate) => candidate.id === payload.agentId && candidate.deviceId === localDeviceId)
      ?? shared.agents.find((candidate) => candidate.sessionId === payload.agentId && candidate.deviceId === localDeviceId);
    if (!agent && deps.collaboration.refreshSnapshot) {
      const refreshed = await deps.collaboration.refreshSnapshot(shared.projectId).catch(() => null);
      if (refreshed?.project?.teamId === shared.teamId && refreshed.project.sharedProjectId === shared.sharedProjectId) {
        shared = { ...shared, members: refreshed.members, agents: refreshed.agents };
        agent = shared.agents.find((candidate) => candidate.id === payload.agentId && candidate.deviceId === localDeviceId)
          ?? shared.agents.find((candidate) => candidate.sessionId === payload.agentId && candidate.deviceId === localDeviceId);
      }
    }
    if (!agent || !agent.sessionId) return { rejection: 'agent-unavailable' };
    if (payload.scope) {
      try { normalizeScopes(payload.scope); }
      catch { return { rejection: 'invalid' }; }
    }
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
    const terminal = ['completed', 'failed', 'interrupted', 'rejected'].includes(input.status);
    if (terminal) {
      db.prepare('UPDATE mingle_team_device_deliveries SET terminal_status_json=? WHERE delivery_id=?')
        .run(JSON.stringify(payload), input.deliveryId);
    }
    try {
      await send(teamId, toDeviceId, 'teamgroup.delivery.status', payload, statusIdempotencyKey(payload));
    } catch (error) {
      if (!terminal) throw error;
      scheduleTerminalStatusRetry(teamId, toDeviceId, payload);
    }
  }

  async function sendInterruptedDelivery(activeDelivery: ActiveDelivery, reason: string): Promise<void> {
    const changed = db.prepare(`UPDATE mingle_team_device_deliveries SET status='interrupted',error=?,updated_at=?
      WHERE delivery_id=? AND status IN ('accepted','running','awaiting-approval')`)
      .run(safeText(reason, 1000), ISO(), activeDelivery.payload.deliveryId);
    if (Number(changed.changes) !== 1) return;
    const shared = await findBindingBySharedProject(activeDelivery.teamId, activeDelivery.payload.sharedProjectId);
    const host = shared ? await hostDeviceId(shared) : null;
    if (host) await sendStatus(activeDelivery.teamId, host, { sharedProjectId: activeDelivery.payload.sharedProjectId,
      deliveryId: activeDelivery.payload.deliveryId, agentId: activeDelivery.payload.agentId, status: 'interrupted', runId: activeDelivery.runId });
  }

  function scheduleTerminalStatusRetry(teamId: string, toDeviceId: string, payload: ReturnType<typeof TeamDeliveryStatusPayloadSchema.parse>): void {
    if (closed) return;
    const prior = terminalStatusRetries.get(payload.deliveryId);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      terminalStatusRetries.delete(payload.deliveryId);
      void track(sendStatusPayload(teamId, toDeviceId, payload));
    }, Math.max(1, deps.terminalStatusRetryMs ?? 3_000));
    timer.unref();
    terminalStatusRetries.set(payload.deliveryId, timer);
  }

  async function sendStatusPayload(teamId: string, toDeviceId: string, payload: ReturnType<typeof TeamDeliveryStatusPayloadSchema.parse>): Promise<void> {
    let replyPending = false;
    try { await publishSavedCompletedReply(teamId, toDeviceId, payload); }
    catch { replyPending = true; }
    try {
      await send(teamId, toDeviceId, 'teamgroup.delivery.status', payload, statusIdempotencyKey(payload));
      if (replyPending) { scheduleTerminalStatusRetry(teamId, toDeviceId, payload); return; }
      const timer = terminalStatusRetries.get(payload.deliveryId);
      if (timer) clearTimeout(timer);
      terminalStatusRetries.delete(payload.deliveryId);
    } catch {
      scheduleTerminalStatusRetry(teamId, toDeviceId, payload);
    }
  }

  /** Recover the owner-signed reply from durable completion, including a crash before its first post. */
  async function publishSavedCompletedReply(teamId: string, toDeviceId: string,
    payload: ReturnType<typeof TeamDeliveryStatusPayloadSchema.parse>): Promise<void> {
    if (closed || payload.status !== 'completed' || !payload.finalText) return;
    const row = db.prepare(`SELECT request_json,session_id,run_id,status FROM mingle_team_device_deliveries WHERE delivery_id=?`)
      .get(payload.deliveryId) as { request_json: string; session_id: string; run_id: string | null; status: string } | undefined;
    if (!row || row.status !== 'completed' || row.run_id !== payload.runId) return;
    const request = TeamDeliveryPayloadSchema.parse(JSON.parse(row.request_json));
    if (request.deliveryId !== payload.deliveryId || request.sharedProjectId !== payload.sharedProjectId
      || request.agentId !== payload.agentId || request.integrationDeviceId !== toDeviceId) return;
    const shared = await findBindingBySharedProject(teamId, payload.sharedProjectId);
    if (!shared || closed || await hostDeviceId(shared) !== toDeviceId) return;
    const accountId = await currentAccountId();
    const device = deps.transport.snapshot(teamId);
    const agent = shared.agents.find((candidate) => candidate.id === payload.agentId && candidate.sessionId === row.session_id
      && candidate.accountId === accountId && candidate.deviceId === device.deviceId);
    if (closed || !agent || !device.devices.some((candidate) => candidate.id === device.deviceId
      && candidate.ownerId === accountId && !candidate.revokedAt)) return;
    // postAgentReply persists a signed row and deduplicates concurrent/restarted calls by delivery ID.
    await deps.teamChat.postAgentReply(shared.projectId, agent.id, payload.finalText, request.requestId, request.deliveryId);
  }

  function statusIdempotencyKey(payload: ReturnType<typeof TeamDeliveryStatusPayloadSchema.parse>): string {
    return `teamdelivery:${payload.deliveryId}:${payload.status}:${Date.parse(payload.at)}`.slice(0, 200);
  }

  async function resendSavedTerminalStatus(teamId: string, toDeviceId: string, deliveryId: string): Promise<boolean> {
    const row = db.prepare('SELECT terminal_status_json FROM mingle_team_device_deliveries WHERE delivery_id=?')
      .get(deliveryId) as { terminal_status_json: string | null } | undefined;
    if (!row?.terminal_status_json) return false;
    let payload: ReturnType<typeof TeamDeliveryStatusPayloadSchema.parse>;
    try { payload = TeamDeliveryStatusPayloadSchema.parse(JSON.parse(row.terminal_status_json)); }
    catch { return false; }
    if (!['completed', 'failed', 'interrupted', 'rejected'].includes(payload.status)) return false;
    await sendStatusPayload(teamId, toDeviceId, payload);
    return true;
  }

  async function sendHeartbeat(delivery: ActiveDelivery): Promise<void> {
    const host = await hostDeviceId({ projectId: delivery.projectId, teamId: delivery.teamId,
      sharedProjectId: delivery.payload.sharedProjectId,
      members: (await deps.collaboration.snapshot(delivery.projectId)).members,
      agents: (await deps.collaboration.snapshot(delivery.projectId)).agents });
    if (!host || closed || !active.has(delivery.payload.deliveryId)) return;
    const sequence = ++delivery.heartbeatSequence;
    const payload = TeamDeliveryHeartbeatPayloadSchema.parse({ sharedProjectId: delivery.payload.sharedProjectId,
      deliveryId: delivery.payload.deliveryId, agentId: delivery.payload.agentId, runId: delivery.runId, sequence, at: ISO() });
    try {
      await send(delivery.teamId, host, 'teamgroup.delivery.heartbeat', payload,
        `teamdelivery-heartbeat:${delivery.payload.deliveryId}:${sequence}`);
      await deps.transport.sync();
    } catch { /* A failed cloud insert remains queued in the durable transport outbox for retry. */ }
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
    const duplicate = db.prepare('SELECT request_json,status,run_id,session_id,terminal_status_json FROM mingle_team_device_deliveries WHERE delivery_id=?')
      .get(payload.deliveryId) as { request_json: string; status: string; run_id: string | null; session_id: string; terminal_status_json: string | null } | undefined;
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
        if (await resendSavedTerminalStatus(envelope.teamId, envelope.fromDeviceId, payload.deliveryId)) return;
        if (duplicate.status === 'completed' && duplicate.run_id) {
          const finalText = safeText(deps.store.listMessages(duplicate.session_id, { limit: 2_000 })
            .filter((message) => message.runId === duplicate.run_id && message.role === 'assistant' && message.kind !== 'streaming')
            .map((message) => message.content).join('\n\n').trim(), 50_000);
          await sendStatus(envelope.teamId, envelope.fromDeviceId, { sharedProjectId: payload.sharedProjectId,
            deliveryId: payload.deliveryId, agentId: payload.agentId, status: 'completed', runId: duplicate.run_id, finalText, artifacts: [] });
          return;
        }
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
    const queueKey = `${payload.sharedProjectId}:${payload.agentId}`;
    const previous = agentQueues.get(queueKey) ?? Promise.resolve();
    const execution = previous.catch(() => undefined).then(() => executeDelivery(payload, validation.shared, validation.sessionId));
    agentQueues.set(queueKey, execution);
    void execution.finally(() => { if (agentQueues.get(queueKey) === execution) agentQueues.delete(queueKey); }).catch(() => undefined);
    void track(execution);
    await sendStatus(envelope.teamId, envelope.fromDeviceId, { sharedProjectId: payload.sharedProjectId,
      deliveryId: payload.deliveryId, agentId: payload.agentId, status: 'accepted' });
  }

  async function isolatedWorktree(shared: SharedBinding, payload: TeamDeliveryPayload, sessionId: string): Promise<{
    path: string; branch: string; turnBase: string; integrationNote: string | null;
  }> {
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
    if (session.isolated) {
      const worktreePath = await realpath(session.worktreePath);
      if (worktreePath === projectRoot) throw new HttpError(409, 'The shared agent session points at the project’s main checkout and cannot run remotely.');
      const top = trimmed(await git(worktreePath, ['rev-parse', '--show-toplevel']));
      const canonicalTop = await realpath(top);
      if (canonicalTop === projectRoot) throw new HttpError(409, 'The shared agent session is not an isolated Git worktree.');
    }
    if (!baseRevision) baseRevision = trimmed(await git(projectRoot, ['rev-parse', '--verify', 'HEAD']));
    const deliveryWorktreeRoot = deps.deliveryWorktreeRoot ?? path.join(os.homedir(), '.mingle', 'team-worktrees');
    await mkdir(deliveryWorktreeRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(deliveryWorktreeRoot);
    const directory = path.join(root, createHash('sha256').update(shared.sharedProjectId).digest('hex').slice(0, 20));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const canonicalDirectory = await realpath(directory);
    if (!canonicalDirectory.startsWith(`${root}${path.sep}`)) throw new HttpError(409, 'The owner-device team worktree directory escaped its private root.');
    const worktreePath = path.join(canonicalDirectory, createHash('sha256').update(payload.agentId).digest('hex').slice(0, 24));
    const handle = payload.workerHandle ?? `agent-${createHash('sha256').update(payload.agentId).digest('hex').slice(0, 8)}`;
    const branch = teamAgentBranch(handle);
    const integrationBranch = safeIntegrationBranch((payload as TeamDeliveryPayload & { integrationBranch?: string }).integrationBranch);

    const pathState = await lstat(worktreePath).then((entry) => ({ exists: true, directory: entry.isDirectory() && !entry.isSymbolicLink() }))
      .catch(() => ({ exists: false, directory: false }));
    let reused = false;
    if (pathState.exists && pathState.directory) {
      const existingTop = await git(worktreePath, ['rev-parse', '--show-toplevel'], { allowFailure: true });
      const existingBranch = await git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
      const existingCommon = await git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFailure: true });
      const expectedCommon = trimmed(await git(projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      if (existingTop.code === 0 && existingBranch.code === 0 && existingCommon.code === 0
        && path.resolve(existingTop.stdout.trim()) === path.resolve(worktreePath)
        && path.resolve(existingCommon.stdout.trim()) === path.resolve(expectedCommon)
        && existingBranch.stdout.trim() === branch) {
        reused = true;
      } else {
        // Preserve an unrecognized or broken directory for recovery rather than deleting any work.
        const preservedPath = `${worktreePath}.stale-${randomUUID()}`;
        await rename(worktreePath, preservedPath);
        await git(projectRoot, ['worktree', 'prune', '--expire', 'now'], { allowFailure: true });
      }
    } else if (pathState.exists) {
      const preservedPath = `${worktreePath}.stale-${randomUUID()}`;
      await rename(worktreePath, preservedPath);
      await git(projectRoot, ['worktree', 'prune', '--expire', 'now'], { allowFailure: true });
    } else {
      await git(projectRoot, ['worktree', 'prune', '--expire', 'now'], { allowFailure: true });
    }

    if (!reused) {
      const branchExists = (await git(projectRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true })).code === 0;
      let remoteBranch: string | null = null;
      if (!branchExists) remoteBranch = await fetchTeamAgentBranch({ worktreePath: projectRoot, branch });
      if (!baseRevision) baseRevision = trimmed(await git(projectRoot, ['rev-parse', '--verify', 'HEAD']));
      if (!branchExists && !remoteBranch && baseRevision) {
        const baseExists = await git(projectRoot, ['cat-file', '-e', `${baseRevision}^{commit}`], { allowFailure: true, maxBuffer: 4096 });
        if (baseExists.code !== 0 && integrationBranch) {
          await fetchTeamIntegrationBranch({ worktreePath: projectRoot, branch: integrationBranch });
        }
        const verifiedBase = await git(projectRoot, ['cat-file', '-e', `${baseRevision}^{commit}`], { allowFailure: true, maxBuffer: 4096 });
        if (verifiedBase.code !== 0) throw new HttpError(409, 'The delivery base revision is not available in the owner-selected project repository.');
      }
      if (branchExists) {
        await git(projectRoot, ['worktree', 'add', worktreePath, branch]);
      } else if (remoteBranch) {
        await git(projectRoot, ['worktree', 'add', '-b', branch, worktreePath, `refs/remotes/origin/${branch}`]);
      } else {
        if (!baseRevision) throw new HttpError(409, 'The owner-selected project has no commit for the worker branch.');
        await git(projectRoot, ['worktree', 'add', '-b', branch, worktreePath, baseRevision]);
      }
    }

    let integrationNote: string | null = null;
    if (baseRevision && integrationBranch) {
      const head = trimmed(await git(worktreePath, ['rev-parse', '--verify', 'HEAD']));
      const isAncestor = await git(worktreePath, ['merge-base', '--is-ancestor', baseRevision, head], { allowFailure: true });
      if (isAncestor.code !== 0) {
        await fetchTeamIntegrationBranch({ worktreePath, branch: integrationBranch });
        const available = await git(worktreePath, ['cat-file', '-e', `${baseRevision}^{commit}`], { allowFailure: true, maxBuffer: 4096 });
        if (available.code !== 0) {
          integrationNote = `Mingle could not update from origin/${integrationBranch}: host integration commit ${baseRevision} is not available locally. The host may not have pushed it yet; continue on your existing branch.`;
        } else {
          const dirty = await git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'], { maxBuffer: 8 * 1024 * 1024 });
          if (dirty.stdout.trim()) {
            integrationNote = `Mingle could not merge origin/${integrationBranch} because this worker worktree has uncommitted changes. Keep them and merge the integration branch manually when ready.`;
          } else {
            let identity: string[];
            try {
              const user = deps.account.snapshot().user;
              identity = await identityArgs(worktreePath, { name: user?.name, email: user?.email });
            } catch (error) {
              integrationNote = error instanceof Error ? error.message : 'Set your Git name and email (git config --global user.name/user.email), then retry.';
              identity = [];
            }
            const merged = integrationNote ? { code: 1, stderr: integrationNote } : await git(worktreePath, [...identity, '-c', 'commit.gpgSign=false', 'merge', '--no-edit', baseRevision], { allowFailure: true, timeoutMs: 120_000 });
            if (merged.code !== 0) {
              await git(worktreePath, ['merge', '--abort'], { allowFailure: true });
              const detail = safeText(merged.stderr.replace(/\b(?:https?|ssh|git):\/\/[^\s'"<>]+/gi, '[remote]')
                .replace(/\b[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:[^\s'"<>]+/g, '[remote]'), 500);
              integrationNote = `Mingle could not merge the latest integration commit from origin/${integrationBranch} automatically${detail ? `: ${detail}` : ''}. Run git pull --no-rebase origin ${integrationBranch} and resolve the conflicts before continuing.`;
            }
          }
        }
      }
    }
    const turnBase = trimmed(await git(worktreePath, ['rev-parse', '--verify', 'HEAD']));
    db.prepare(`UPDATE mingle_team_device_deliveries SET worktree_path=?,branch=?,base_revision=?,updated_at=? WHERE delivery_id=? AND status='accepted'`)
      .run(worktreePath, branch, turnBase, ISO(), payload.deliveryId);
    return { path: worktreePath, branch, turnBase, integrationNote };
  }

  async function commitEligibleChanges(activeDelivery: ActiveDelivery): Promise<void> {
    try {
      if (activeDelivery.controller.signal.aborted) throw new Error('The team delivery was interrupted before local artifact preparation.');
      const worktreePath = activeDelivery.worktreePath;
      const [tracked, untracked] = await Promise.all([
        git(worktreePath, ['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--'], { maxBuffer: 8 * 1024 * 1024 }),
        git(worktreePath, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', '.'], { maxBuffer: 8 * 1024 * 1024 }),
      ]);
      const candidates = [...new Set([...tracked.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean))].sort();
      if (!candidates.length) return;
      if (candidates.length > MAX_AUTO_COMMIT_PATHS) throw new Error(`There are more than ${MAX_AUTO_COMMIT_PATHS} changed paths to snapshot safely.`);
      const inScope = candidates.filter((file) => pathInAssignmentScope(file, activeDelivery.scope));
      const outOfScope = candidates.length - inScope.length;
      if (outOfScope) {
        const note = `${outOfScope} out-of-scope path(s) were left in the delivery worktree and not snapshotted.`;
        activeDelivery.entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: activeDelivery.runId,
          at: ISO(), kind: 'status', text: note }));
        activeDelivery.artifactFailures.push(note);
      }
      const candidatesWithoutSecrets = inScope.filter((file) => !file.split('/').some(isDeniedName));
      const ignoredResult = candidatesWithoutSecrets.length
        ? await git(worktreePath, ['check-ignore', '--no-index', '-z', '--stdin'], {
          allowFailure: true, stdin: `${candidatesWithoutSecrets.join('\0')}\0`, maxBuffer: 8 * 1024 * 1024,
        })
        : { stdout: '' };
      const ignored = new Set(ignoredResult.stdout.split('\0').filter(Boolean));
      const paths = candidatesWithoutSecrets.filter((file) => !ignored.has(file));
      const excluded = inScope.length - paths.length;
      if (excluded) {
        const note = `${excluded} protected or ignored path(s) were excluded from remote artifact commits.`;
        activeDelivery.entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: activeDelivery.runId,
          at: ISO(), kind: 'status', text: note }));
        activeDelivery.artifactFailures.push(note);
      }
      if (!paths.length) return;
      if (activeDelivery.controller.signal.aborted) throw new Error('The team delivery was interrupted before its file snapshot could be committed.');
      const head = trimmed(await git(worktreePath, ['rev-parse', '--verify', 'HEAD']));
      const branch = activeDelivery.branch;
      if (!branch) throw new Error('The isolated delivery worktree has no branch for a controlled artifact commit.');
      const commit = await createCommit(worktreePath, branch, head, paths, `Mingle team delivery ${activeDelivery.payload.deliveryId}`, {
        sign: await signingConfigured(worktreePath),
        identity: { name: deps.account.snapshot().user?.name, email: deps.account.snapshot().user?.email },
        beforeCommit: async () => {
          if (cancelled.has(activeDelivery.payload.deliveryId) || activeDelivery.controller.signal.aborted) {
            throw new Error('The team delivery was cancelled before its file snapshot could be committed.');
          }
        },
      });
      activeDelivery.entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: activeDelivery.runId,
        at: ISO(), kind: 'artifact', text: `Snapshotted ${commit.paths.length} uncommitted provider change(s) as commit ${commit.commit.slice(0, 12)} for transfer.` }));
    } catch (error) {
      const message = safeText(errorMessage(error), 500);
      activeDelivery.artifactFailures.push(`Local changes could not be snapshotted into a committed artifact: ${message}`);
      activeDelivery.entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: activeDelivery.runId,
        at: ISO(), kind: 'error', text: `Local changes could not be snapshotted into a committed artifact: ${message}` }));
    }
  }

  async function prepareArtifactTransfer(activeDelivery: ActiveDelivery, rawInput: unknown, signal: AbortSignal): Promise<TeamArtifactRef> {
    const input = TeamArtifactSchema.parse(rawInput);
    const live = active.get(activeDelivery.payload.deliveryId);
    if (!live || live.runId !== activeDelivery.runId || live.sessionId !== activeDelivery.sessionId
      || signal.aborted || live.controller.signal.aborted || !deps.runtime.isActive(live.sessionId)) {
      throw new HttpError(409, 'A team artifact must be published by its active owner-device run.');
    }
    const row = db.prepare(`SELECT request_json,status,run_id,session_id FROM mingle_team_device_deliveries WHERE delivery_id=?`)
      .get(activeDelivery.payload.deliveryId) as { request_json: string; status: string; run_id: string | null; session_id: string } | undefined;
    if (!row || row.status !== 'running' || row.run_id !== activeDelivery.runId || row.session_id !== activeDelivery.sessionId) {
      throw new HttpError(409, 'The team artifact request no longer matches its active owner-device delivery.');
    }
    let persisted: TeamDeliveryPayload;
    try { persisted = TeamDeliveryPayloadSchema.parse(JSON.parse(row.request_json)); }
    catch { throw new HttpError(409, 'The saved owner-device delivery request is invalid.'); }
    if (persisted.sharedProjectId !== activeDelivery.payload.sharedProjectId || persisted.deliveryId !== activeDelivery.payload.deliveryId
      || persisted.agentId !== activeDelivery.payload.agentId || persisted.integrationDeviceId !== activeDelivery.payload.integrationDeviceId
      || persisted.taskId !== activeDelivery.payload.taskId || JSON.stringify(persisted.scope ?? null) !== JSON.stringify(activeDelivery.payload.scope ?? null)) {
      throw new HttpError(403, 'The owner-device artifact request differs from its host-authorized delivery.');
    }
    const rejection = deliveryStartRejection(persisted);
    if (rejection) throw new HttpError(403, `Team consent or settings no longer authorize artifact transfer (${rejection}).`);

    const pathValue = safeArtifactPath(input.path);
    const expectedTaskId = persisted.taskId ?? undefined;
    if (input.taskId !== expectedTaskId) {
      throw new HttpError(403, expectedTaskId
        ? 'A task artifact must name the task assigned to this owner-device delivery.'
        : 'This delivery does not authorize publishing an artifact for a task.');
    }
    const scope = persisted.scope ? normalizeScopes(persisted.scope) : null;
    if (persisted.kind === 'assignment' && !scope) throw new HttpError(403, 'The assignment has no verified edit scope for artifact publication.');
    if (scope && !pathInAssignmentScope(pathValue, scope)) throw new HttpError(403, 'The artifact path is outside this delivery’s assigned scope.');
    if (pathValue.split('/').some(isDeniedName)) throw new HttpError(403, 'Protected files cannot be published as team artifacts.');
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(input.revision)) throw new HttpError(400, 'A team artifact must name a full committed revision.');
    const changedPaths = await committedPaths(live.worktreePath, live.turnBase, input.revision);
    if (!changedPaths.includes(pathValue)) throw new HttpError(409, `${pathValue} is not a committed change in this delivery revision.`);
    const outOfScope = changedPaths.filter((file) => pathInAssignmentScope(file, scope) === false || file.split('/').some(isDeniedName));
    if (outOfScope.length) throw new HttpError(403, 'The artifact commit contains protected or out-of-scope changes and cannot be transferred.');
    const treeEntry = await git(live.worktreePath, ['ls-tree', '-z', input.revision, '--', pathValue], { maxBuffer: 4096 });
    const record = treeEntry.stdout.split('\0').filter(Boolean);
    const match = record.length === 1 ? /^(\d{6}) blob ([0-9a-f]{40,64})\t(.+)$/.exec(record[0]!) : null;
    if (!match || match[1] === '120000' || match[3] !== pathValue) {
      throw new HttpError(400, 'A team artifact must be a regular committed file in the active delivery worktree.');
    }

    if (signal.aborted || live.controller.signal.aborted || active.get(activeDelivery.payload.deliveryId) !== live
      || !deps.runtime.isActive(live.sessionId) || deliveryStartRejection(persisted)) {
      throw new HttpError(409, 'The owner-device delivery stopped before its artifact could be transferred.');
    }
    const transferred = await deps.distributed.git.exportTeamArtifact({ teamId: activeDelivery.teamId,
      sharedProjectId: persisted.sharedProjectId, sourceWorktreePath: live.worktreePath, revision: input.revision,
      baseRevision: live.turnBase, toDeviceId: persisted.integrationDeviceId,
      deliveryId: persisted.deliveryId, ...(expectedTaskId ? { taskId: expectedTaskId } : {}), path: pathValue,
      purpose: 'mcp', signal });
    const afterTransfer = db.prepare(`SELECT request_json,status,run_id,session_id FROM mingle_team_device_deliveries WHERE delivery_id=?`)
      .get(activeDelivery.payload.deliveryId) as { request_json: string; status: string; run_id: string | null; session_id: string } | undefined;
    if (!afterTransfer || afterTransfer.status !== 'running' || afterTransfer.run_id !== activeDelivery.runId
      || afterTransfer.session_id !== activeDelivery.sessionId || afterTransfer.request_json !== row.request_json
      || signal.aborted || live.controller.signal.aborted
      || active.get(activeDelivery.payload.deliveryId) !== live || !deps.runtime.isActive(live.sessionId)) {
      throw new HttpError(409, 'The owner-device delivery ended during artifact transfer.');
    }
    const afterRejection = deliveryStartRejection(persisted);
    if (afterRejection) throw new HttpError(403, `Team consent or settings no longer authorize artifact transfer (${afterRejection}).`);
    const parsedTransfer = TeamArtifactRefSchema.parse(transferred);
    if (parsedTransfer.revision.toLowerCase() !== input.revision.toLowerCase() || parsedTransfer.path !== pathValue
      || parsedTransfer.taskId !== expectedTaskId || !parsedTransfer.transferId) {
      throw new HttpError(409, 'The owner-device transfer result did not match the requested artifact.');
    }
    return parsedTransfer;
  }

  async function prepareCompletionBranch(activeDelivery: ActiveDelivery): Promise<{
    pushable: boolean; head: string | null; revisions: string[]; failure: string | null;
  }> {
    if (activeDelivery.controller.signal.aborted) return { pushable: false, head: null, revisions: [], failure: null };
    await commitEligibleChanges(activeDelivery);
    if (activeDelivery.controller.signal.aborted) return { pushable: false, head: null, revisions: [], failure: null };
    const head = trimmed(await git(activeDelivery.worktreePath, ['rev-parse', '--verify', 'HEAD']));
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head)) return { pushable: false, head: null, revisions: [], failure: 'The worker branch HEAD is not a full commit SHA.' };
    const args = ['rev-list', '--reverse', '--max-count=30', `${activeDelivery.turnBase}..${head}`];
    const revisions = trimmed(await git(activeDelivery.worktreePath, args)).split(/\s+/).filter((id) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(id));
    const changes = await committedPaths(activeDelivery.worktreePath, activeDelivery.turnBase, head);
    const protectedPaths = changes.filter((file) => file.split('/').some(isDeniedName));
    const outOfScopePaths = changes.filter((file) => !pathInAssignmentScope(file, activeDelivery.scope));
    if (protectedPaths.length || outOfScopePaths.length) {
      const issues = [
        protectedPaths.length ? `${protectedPaths.length} protected path change(s)` : '',
        outOfScopePaths.length ? `${outOfScopePaths.length} committed path change(s) outside the assigned scope` : '',
      ].filter(Boolean).join(' and ');
      const note = `Committed delivery history was not published because it contains ${issues}; commits and worktree were retained.`;
      activeDelivery.artifactFailures.push(note);
      activeDelivery.entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: activeDelivery.runId,
        at: ISO(), kind: 'error', text: note }));
      return { pushable: false, head, revisions, failure: note };
    }
    return { pushable: true, head, revisions, failure: null };
  }

  async function exportFallbackArtifacts(activeDelivery: ActiveDelivery, revisions: string[]): Promise<Array<{
    revision: string; transferId?: string; taskId?: string; ref?: string;
  }>> {
    const artifacts: Array<{ revision: string; transferId?: string; taskId?: string; ref?: string }> = [];
    for (const revision of revisions) {
      try {
        const artifact = await deps.distributed.git.exportTeamArtifact({ teamId: activeDelivery.teamId,
          sharedProjectId: activeDelivery.payload.sharedProjectId, toDeviceId: activeDelivery.payload.integrationDeviceId,
          deliveryId: activeDelivery.payload.deliveryId, revision, baseRevision: activeDelivery.turnBase,
          sourceWorktreePath: activeDelivery.worktreePath, taskId: activeDelivery.payload.taskId,
          purpose: 'terminal', signal: activeDelivery.controller.signal });
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
      if (!isAcceptedDelivery(payload.deliveryId) || cancelled.has(payload.deliveryId)) return;
      const ownDeviceId = deps.transport.snapshot(shared.teamId).deviceId;
      const localAgent = shared.agents.find((candidate) => candidate.id === payload.agentId && candidate.deviceId === ownDeviceId)
        ?? shared.agents.find((candidate) => candidate.sessionId === payload.agentId && candidate.deviceId === ownDeviceId);
      if (!localAgent || !localAgent.sessionId || localAgent.sessionId !== sessionId) {
        throw new HttpError(409, 'The published local agent is no longer available for this delivery.');
      }
      const isolated = await isolatedWorktree(shared, payload, sessionId);
      const proxyConnection = await proxy.create({ teamId: shared.teamId, sharedProjectId: shared.sharedProjectId,
        hostDeviceId: (await hostDeviceId(shared))!, deliveryId: payload.deliveryId, agentId: payload.agentId,
        prepareArtifact: async (artifact, signal) => {
          const current = active.get(payload.deliveryId);
          if (!current) throw new HttpError(409, 'The owner-device team run is not active for artifact publication.');
          return prepareArtifactTransfer(current, artifact, signal);
        } });
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
          });
        }
        return;
      }
      const consent = localConsent(payload.sharedProjectId);
      const session = deps.store.getSession(sessionId);
      if (!consent || consent.state !== 'granted' || !session) throw new HttpError(409, 'The local agent consent or session changed before execution.');
      // Keep the owner runtime's native gate at its conservative mode for the whole delivery.
      // The host can then raise or lower team authority while the provider is still running:
      // each native approval is mirrored, and the host auto-approves only when current team
      // settings and the owner's consent both permit it.
      const runPolicy = 'supervised' as const;
      const controller = new AbortController();
      const deliveryContent = isolated.integrationNote ? `${payload.content}\n\n${isolated.integrationNote}` : payload.content;
      const requestEntry = TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: null, at: ISO(), kind: 'request',
        text: safeText(deliveryContent, 8_000) });
      try {
        runId = deps.runtime.start(sessionId, deliveryContent, {
          teamRun: true, teamMcp: proxyConnection, runPolicy,
          worktree: { path: isolated.path, branch: isolated.branch ?? '' },
          taskId: payload.taskId,
          userMessage: { content: deliveryContent, kind: 'team-delivery' },
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
        turnBase: isolated.turnBase, worktreePath: isolated.path, branch: isolated.branch,
        scope: payload.scope ? normalizeScopes(payload.scope) : null,
        entries: [requestEntry], text: '', activityState: 'working', activityWaiters: [],
        timer: null, heartbeatTimer: null, heartbeatSequence: 0, controller, artifactFailures: [] };
      active.set(payload.deliveryId, live);
      if (isolated.integrationNote) live.entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId,
        at: ISO(), kind: 'status', text: isolated.integrationNote }));
      live.heartbeatTimer = setInterval(() => { void track(sendHeartbeat(live!)); }, Math.max(1, deps.heartbeatIntervalMs ?? 15_000));
      live.heartbeatTimer.unref();
      db.prepare(`UPDATE mingle_team_device_deliveries SET status='running',run_id=?,worktree_path=?,branch=?,base_revision=?,updated_at=? WHERE delivery_id=? AND status='accepted'`)
        .run(runId, isolated.path, isolated.branch, isolated.turnBase, ISO(), payload.deliveryId);
      await sendStatus(shared.teamId, (await hostDeviceId(shared))!, { sharedProjectId: shared.sharedProjectId,
        deliveryId: payload.deliveryId, agentId: payload.agentId, status: 'running', runId });
      void sendActivity(live, 'working').catch(() => undefined);
      const run = await waitForRun(sessionId, runId);
      if (!run) throw new Error('The team delivery did not reach a terminal provider state before its execution deadline.');
      if (run.status === 'completed') {
        if (live.controller.signal.aborted) {
          await sendInterruptedDelivery(live, 'Team sharing was interrupted before the artifact transfer completed.');
          return;
        }
        const initialFinalText = safeText(deps.store.listMessages(sessionId, { limit: 2000 })
          .filter((message) => message.runId === runId && message.role === 'assistant' && message.kind !== 'streaming')
          .map((message) => message.content).join('\n\n').trim(), 50_000);
        const prepared = await prepareCompletionBranch(live);
        let artifacts: Array<{ revision: string; transferId?: string; taskId?: string; ref?: string }> = [];
        let pushedBranch: { name: string; commitSha: string; baseCommitSha: string } | undefined;
        let branchPushFailure: string | undefined;
        if (prepared.pushable && prepared.head && live.branch) {
          try {
            const pushed = await pushTeamCompletionBranch({ worktreePath: live.worktreePath, branch: live.branch, expectedHead: prepared.head, signal: live.controller.signal });
            pushedBranch = { name: pushed.branch, commitSha: pushed.commitSha, baseCommitSha: live.turnBase };
            live.entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: live.runId, at: ISO(), kind: 'artifact',
              text: `Pushed scoped completion branch ${pushed.branch} to origin at ${pushed.commitSha}.` }));
          } catch (error) {
            branchPushFailure = safeText(`Could not push completion branch ${live.branch}: ${errorMessage(error)}`, 2_000);
            live.entries.push(TeamAgentActivityEntrySchema.parse({ id: randomUUID(), runId: live.runId, at: ISO(), kind: 'error', text: branchPushFailure }));
          }
        } else if (prepared.failure) {
          branchPushFailure = safeText(`Could not push completion branch ${live.branch ?? '(unknown branch)'}: ${prepared.failure}`, 2_000);
        }
        if (!pushedBranch && prepared.pushable && prepared.head && !live.controller.signal.aborted) {
          artifacts = await exportFallbackArtifacts(live, prepared.revisions);
        }
        if (live.controller.signal.aborted) {
          await sendInterruptedDelivery(live, 'Team sharing was interrupted before terminal artifacts were delivered.');
          return;
        }
        const artifactIssues = live.artifactFailures.length
          ? `\n\nArtifact preparation/transfer issues:\n${live.artifactFailures.map((failure) => `- ${failure}`).join('\n')}` : '';
        const finalText = safeText(`${initialFinalText}${artifactIssues}`, 50_000);
        const completedPayload = TeamDeliveryStatusPayloadSchema.parse({ sharedProjectId: shared.sharedProjectId,
          deliveryId: payload.deliveryId, agentId: payload.agentId, status: 'completed', runId, finalText, artifacts,
          ...(pushedBranch ? { pushedBranch } : {}), ...(branchPushFailure ? { branchPushFailure } : {}), at: ISO() });
        const completed = db.prepare(`UPDATE mingle_team_device_deliveries
          SET status='completed',run_id=?,error=NULL,terminal_status_json=?,updated_at=?
          WHERE delivery_id=? AND status IN ('accepted','running','awaiting-approval')`)
          .run(runId, JSON.stringify(completedPayload), completedPayload.at, payload.deliveryId);
        if (Number(completed.changes) === 1) await sendStatusPayload(shared.teamId, payload.integrationDeviceId, completedPayload);
        else if (!await resendSavedTerminalStatus(shared.teamId, payload.integrationDeviceId, payload.deliveryId)) {
          throw new Error('The completed team result could not be durably saved for host delivery.');
        }
        void sendActivity(live, 'idle').catch(() => undefined);
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
        deliveryId: payload.deliveryId, agentId: payload.agentId, status: 'failed', runId, failure });
    } finally {
      proxy.closeDelivery(payload.deliveryId);
      if (live?.timer) clearTimeout(live.timer);
      if (live?.heartbeatTimer) clearInterval(live.heartbeatTimer);
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
      });
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
      if (delivery.heartbeatTimer) clearInterval(delivery.heartbeatTimer);
      for (const resolve of delivery.activityWaiters.splice(0)) resolve();
    }
    for (const timer of terminalStatusRetries.values()) clearTimeout(timer);
    terminalStatusRetries.clear();
    for (const timer of activityNotificationTimers.values()) clearTimeout(timer);
    activityNotificationTimers.clear();
    await Promise.allSettled([...work]);
    await proxy.close();
  }

  track(reconcilePersistedDeliveries().then(async () => {
    const rows = db.prepare(`SELECT d.request_json,s.team_id FROM mingle_team_device_deliveries d
      JOIN mingle_team_device_structures s ON s.shared_project_id=d.shared_project_id
      WHERE d.terminal_status_json IS NOT NULL`).all() as Array<{ request_json: string; team_id: string }>;
    for (const row of rows) {
      try {
        const request = TeamDeliveryPayloadSchema.parse(JSON.parse(row.request_json));
        await resendSavedTerminalStatus(row.team_id, request.integrationDeviceId, request.deliveryId);
      } catch { /* Invalid old rows remain visible locally and cannot redirect a status message. */ }
    }
  }));
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
