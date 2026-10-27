import type { Session, ProviderUsage } from '@mingle/contracts';
import type { AccountService } from '../account/service.ts';
import type { Store } from '../store.ts';
import type { SessionRuntime } from '../runtime.ts';
import type { ProviderService } from '../provider-service.ts';
import type { RecoveryService } from '../recovery/service.ts';
import type { GroupService } from '../groups/service.ts';
import type { RepositoryService } from '../repository/service.ts';
import { HttpError, redactSecrets } from '../util.ts';
import { TeamService } from './teams.ts';
import { TransportService } from './transport.ts';
import { RemoteExecutionService, type RemoteExecutionAccount, type AuthenticatedClient, type RemoteExecutionProgress, type LocalAlternative, type QuotaObservation } from './execution.ts';
import { GitSyncService } from './git-sync.ts';
import { RemoteCommandService } from './commands.ts';
import { runGit, fingerprintRepository } from './git-common.ts';
import { SendDistributedMessageSchema, TeamDeliveryPayloadSchema, TeamStructurePayloadSchema } from '../../../../packages/contracts/src/index.ts';
import type { TeamArtifactAuthorization } from './git-common.ts';

export interface DistributedWorkspaceOptions {
  store: Store;
  account: AccountService;
  runtime: SessionRuntime;
  providers: ProviderService;
  recovery: RecoveryService;
  groups: GroupService;
  repository: RepositoryService;
  dataDir: string;
}

/** Connects account authority, device transport and existing local runtimes without exposing the loopback server. */
export class DistributedWorkspaceService {
  readonly teams: TeamService;
  readonly transport: TransportService;
  readonly execution: RemoteExecutionService;
  readonly git: GitSyncService;
  readonly commands: RemoteCommandService;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeMetadata: () => void;
  private metadataTimer: NodeJS.Timeout | null = null;
  private metadataDebounce: NodeJS.Timeout | null = null;
  private metadataAgain = false;
  private metadataWork: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: DistributedWorkspaceOptions) {
    const { store, account, runtime, providers, recovery, dataDir } = options;
    const changed = () => store.touch();
    this.teams = new TeamService({ account, changed });
    this.transport = new TransportService({ account, store, dataDir, changed });
    const transport = {
      snapshot: (teamId?: string) => {
        const snapshot = this.transport.snapshot(teamId);
        return { localDeviceId: snapshot.deviceId, devices: snapshot.devices.map((device) => ({
          id: device.id, teamId: device.teamId, ownerId: device.ownerId, revokedAt: device.revokedAt,
          online: device.status === 'online',
          linked: snapshot.links.some((link) => link.deviceId === snapshot.deviceId && link.peerDeviceId === device.id && link.mutual),
        })) };
      },
      send: (input: { teamId: string; toDeviceId: string; kind: string; payload: unknown; idempotencyKey: string }) => this.transport.send(SendDistributedMessageSchema.parse(input)),
      onMessage: (handler: Parameters<TransportService['onMessage']>[0]) => this.transport.onMessage(handler),
    };
    // Keep PostgREST's recursive schema generics behind the small query-only execution boundary.
    const executionAccount: RemoteExecutionAccount = { withAuthenticatedClient: (work) => account.withAuthenticatedClient((client, user) => work(client as unknown as AuthenticatedClient, user)) };
    this.execution = new RemoteExecutionService({
      store, account: executionAccount, transport, runtime, changed,
      workspace: {
        captureCheckpoint: (id, reason, runId) => recovery.capture(id, reason, runId),
        isUnpublishedWork: async ({ projectId, sourceSessionId, taskId }) => {
          const session = store.getSession(sourceSessionId);
          const task = store.getTask(taskId);
          if (!session || session.projectId !== projectId || !task || task.projectId !== projectId || task.sessionId !== session.id || runtime.isActive(session.id)) return false;
          const result = await runGit(session.worktreePath, ['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes'], { maxOutputBytes: 4096 });
          return /^[0-9a-f]{40,64}$/i.test(result.stdout.toString('utf8').trim());
        },
        validateDestinationCheckpoint: async (session, evidence) => {
          const checkpoint = evidence.worktree;
          if (!checkpoint?.statusKnown || !checkpoint.head || !/^[0-9a-f]{40,64}$/i.test(checkpoint.head) || checkpoint.dirtyPaths.length) throw new HttpError(409, 'Commit and review the unfinished source changes before transferring this checkpoint. No source edits were copied by the recovery request.');
          const destination = await fingerprintRepository(session.worktreePath);
          if (destination.dirty) throw new HttpError(409, 'Commit or save local destination changes before approving remote recovery.');
          const result = await runGit(session.worktreePath, ['merge-base', '--is-ancestor', checkpoint.head, 'HEAD'], { allowFailure: true, maxOutputBytes: 4096 });
          if (result.code !== 0) throw new HttpError(409, 'Transfer the source checkpoint through Git sync and prepare this destination session at that revision before approving recovery.');
          for (const artifact of evidence.committedReferences) {
            if (!/^[0-9a-f]{40,64}$/i.test(artifact.revision)) throw new HttpError(409, 'Recovery artifact revisions must be pinned to committed Git object IDs.');
            const present = await runGit(session.worktreePath, ['cat-file', '-e', `${artifact.revision}^{commit}`], { allowFailure: true, maxOutputBytes: 4096 });
            if (present.code !== 0) throw new HttpError(409, 'Transfer the committed recovery artifacts before approving execution.');
          }
        },
        subscribeSession: (sessionId, listener) => this.subscribeProgress(sessionId, listener),
      },
      providers: {
        localAlternatives: async ({ projectId, sourceSessionId }) => {
          const diagnostics = providers.cached();
          const sessions = store.listSessions(projectId).filter((session) => session.id !== sourceSessionId && ['claude', 'codex', 'opencode'].includes(session.provider));
          const alternatives: LocalAlternative[] = [];
          for (const session of sessions) {
            const diagnostic = diagnostics?.find((row) => row.id === session.provider);
            const quota = await this.quota(session);
            const busy = runtime.isActive(session.id) || session.status === 'running' || session.status === 'waiting';
            alternatives.push({ sessionId: session.id, provider: session.provider, model: session.model, eligible: true,
              state: busy ? 'busy' : diagnostic?.available === false ? 'provider-unavailable' : quota.state === 'exhausted' ? 'quota-exhausted' : quota.state === 'available' ? 'available' : 'unknown',
              reason: diagnostic?.reason ?? quota.reason });
          }
          // Configured local providers without a session still deserve consideration before another computer is used.
          const source = store.getSession(sourceSessionId);
          for (const diagnostic of diagnostics ?? []) {
            if (!['claude', 'codex', 'opencode'].includes(diagnostic.id) || diagnostic.id === source?.provider || sessions.some((session) => session.provider === diagnostic.id)) continue;
            alternatives.push({ sessionId: `provider:${diagnostic.id}`, provider: diagnostic.id, model: '', eligible: true,
              state: diagnostic.available ? 'unknown' : 'provider-unavailable', reason: diagnostic.available ? 'A local provider is configured; create or inspect its local session first.' : diagnostic.reason ?? 'Local provider unavailable.' });
          }
          if (!diagnostics) alternatives.push({ sessionId: 'provider:undiscovered', provider: 'codex', model: '', eligible: true, state: 'unknown', reason: 'Refresh local provider availability before requesting remote fallback.' });
          return alternatives;
        },
        quotaForSession: (session) => this.quota(session),
      },
    });
    const common = {
      store, account, transport: { snapshot: (teamId?: string) => this.transport.snapshot(teamId), send: transport.send }, workspace: { getProject: (id: string) => store.getProject(id) }, changed,
      authorizeTeam: (input: { teamId: string; peerDeviceId?: string }) => this.authorizeTeam(input),
      authorizeTeamArtifact: (input: TeamArtifactAuthorization) => this.authorizeTeamArtifact(input),
    };
    this.git = new GitSyncService(common);
    this.commands = new RemoteCommandService(common);
    this.unsubscribe = this.transport.onMessage(async (envelope) => {
      if (envelope.kind.startsWith('git.')) {
        const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload as Record<string, unknown> : {};
        let sharedProjectId = typeof payload.sharedProjectId === 'string' ? payload.sharedProjectId : null;
        if (!sharedProjectId && typeof payload.requestId === 'string') {
          const request = store.db.prepare('SELECT shared_project_id FROM mingle_git_requests WHERE id = ? AND team_id = ? AND peer_device_id = ?')
            .get(payload.requestId, envelope.teamId, envelope.fromDeviceId) as { shared_project_id: string } | undefined;
          sharedProjectId = request?.shared_project_id ?? null;
        }
        if (!sharedProjectId) return this.git.onEnvelope(envelope);
        const state = await this.git.snapshot(envelope.teamId);
        const binding = state.bindings.find((binding) => binding.teamId === envelope.teamId && binding.sharedProjectId === sharedProjectId);
        if (!binding) throw new HttpError(409, 'Bind this shared project before receiving Git work.');
        const artifactTransfer = envelope.kind.startsWith('git.team-artifact.');
        const mutate = artifactTransfer ? options.repository.withExternalRefMutation.bind(options.repository)
          : options.repository.withExternalMutation.bind(options.repository);
        await mutate(binding.localProjectId, () => this.git.onEnvelope(envelope));
      }
      else if (envelope.kind.startsWith('command.')) await this.commands.onEnvelope(envelope);
    });
    this.unsubscribeMetadata = store.subscribe((event) => {
      // Streaming text and transport touches must not cause cloud reads per token.
      // These durable changes affect already-shared agent/task metadata only.
      if (!event || !/^(session\.(renamed|updated|archived|run\.(started|completed|failed|interrupted))|task\.(updated|running|unblocked|blocked|run\.[\w.-]+)|group\.member\.[\w.-]+|approval\.(requested|resolved|denied))$/.test(event.type)) return;
      this.scheduleMetadataRefresh();
    });
  }

  /** Approval-time authorization is fresh: a cached link cannot survive a cloud revocation. */
  async authorizeTeam(input: { teamId: string; peerDeviceId?: string }): Promise<void> {
    await this.teams.assertMember(input.teamId);
    const ownDeviceId = this.transport.snapshot(input.teamId).deviceId;
    if (!ownDeviceId) throw new HttpError(409, 'Register this device with the selected team first.');
    await this.options.account.withAuthenticatedClient(async (client, user) => {
      const { data: own, error } = await client.from('mingle_devices').select('id,owner_id,fingerprint,revoked_at')
        .eq('team_id', input.teamId).eq('id', ownDeviceId).is('revoked_at', null).maybeSingle();
      if (error || !own || own.owner_id !== user.id) throw new HttpError(403, 'This device is no longer registered to the signed-in team member.');
      if (!input.peerDeviceId) return;
      if (input.peerDeviceId === ownDeviceId) throw new HttpError(400, 'Choose another linked device.');
      const [{ data: peer, error: peerError }, { data: links, error: linkError }] = await Promise.all([
        client.from('mingle_devices').select('id,owner_id,fingerprint').eq('team_id', input.teamId).eq('id', input.peerDeviceId).is('revoked_at', null).maybeSingle(),
        client.from('mingle_device_links').select('device_id,peer_device_id,peer_fingerprint').eq('team_id', input.teamId).in('device_id', [ownDeviceId, input.peerDeviceId]),
      ]);
      if (peerError || linkError || !peer || !links) throw new HttpError(403, 'The remote device is no longer available to this team.');
      const { data: member, error: memberError } = await client.from('mingle_members').select('user_id').eq('team_id', input.teamId).eq('user_id', peer.owner_id).is('revoked_at', null).maybeSingle();
      if (memberError || !member || !links.some((link) => link.device_id === ownDeviceId && link.peer_device_id === peer.id && link.peer_fingerprint === peer.fingerprint)
        || !links.some((link) => link.device_id === peer.id && link.peer_device_id === ownDeviceId && link.peer_fingerprint === own.fingerprint)) {
        throw new HttpError(403, 'Both device owners must retain verified links and active membership.');
      }
    });
  }

  /** Recheck the authenticated peer against the durable team delivery, not just the team-wide link. */
  private async authorizeTeamArtifact(input: TeamArtifactAuthorization): Promise<void> {
    await this.authorizeTeam({ teamId: input.teamId, peerDeviceId: input.peerDeviceId });
    const localDeviceId = this.transport.snapshot(input.teamId).deviceId;
    if (!localDeviceId) throw new HttpError(403, 'Register this device before transferring team artifacts.');

    const hostDelivery = this.options.store.db.prepare(`SELECT d.owner_device_id,d.owner_account_id,d.agent_id,d.shared_project_id,d.team_id,
        d.status,d.run_id,d.failure_json,
        p.host_device_id,r.agent_id AS roster_agent_id,r.removed_at,c.state AS consent_state,
        c.owner_account_id AS consent_owner_account_id,c.owner_device_id AS consent_owner_device_id
      FROM mingle_team_host_deliveries d
      JOIN mingle_team_host_projects p ON p.team_id=d.team_id AND p.shared_project_id=d.shared_project_id
      LEFT JOIN mingle_team_host_roster r ON r.team_id=d.team_id AND r.shared_project_id=d.shared_project_id AND r.agent_id=d.agent_id
      LEFT JOIN mingle_team_host_consents c ON c.team_id=d.team_id AND c.shared_project_id=d.shared_project_id AND c.agent_id=d.agent_id
      WHERE d.delivery_id=? AND d.team_id=? AND d.shared_project_id=? LIMIT 1`)
      .get(input.deliveryId, input.teamId, input.sharedProjectId) as Record<string, unknown> | undefined;
    if (hostDelivery) {
      if (hostDelivery.host_device_id !== localDeviceId || hostDelivery.owner_device_id !== input.peerDeviceId
        || hostDelivery.roster_agent_id !== hostDelivery.agent_id || hostDelivery.removed_at !== null
        || hostDelivery.consent_state !== 'granted' || hostDelivery.consent_owner_account_id !== hostDelivery.owner_account_id
        || hostDelivery.consent_owner_device_id !== input.peerDeviceId) {
        throw new HttpError(403, 'The artifact sender is not the active owner device for this team delivery.');
      }
      const status = String(hostDelivery.status);
      if (input.purpose === 'input-source') {
        if (!['accepted', 'running', 'awaiting-approval', 'completed'].includes(status)) {
          throw new HttpError(403, 'The source delivery for this imported group artifact is no longer valid.');
        }
      } else if (!['accepted', 'running', 'awaiting-approval'].includes(status)) {
        throw new HttpError(403, 'The team artifact delivery ended before the transfer was authorized.');
      }
      if (input.purpose === 'mcp' && (status !== 'running' || Boolean(this.completionIntentValue(hostDelivery.failure_json)))) {
        throw new HttpError(403, 'An explicit team artifact transfer requires the currently running provider delivery.');
      }
      if (input.purpose === 'terminal' && input.stage === 'bundle' && this.completionIntentValue(hostDelivery.failure_json)
        && !this.completionIntentHasArtifact(hostDelivery.failure_json, input)) {
        throw new HttpError(403, 'The terminal bundle is not part of this delivery’s completion result.');
      }
      if (input.purpose === 'terminal' && input.stage === 'consume'
        && !this.completionIntentHasArtifact(hostDelivery.failure_json, input)) {
        throw new HttpError(403, 'The terminal artifact is not part of this delivery’s durable completion result.');
      }
      return;
    }

    const deviceDelivery = this.options.store.db.prepare(`SELECT shared_project_id,agent_id,request_json,status,run_id FROM mingle_team_device_deliveries
      WHERE delivery_id=? AND shared_project_id=? LIMIT 1`).get(input.deliveryId, input.sharedProjectId) as
      { shared_project_id: string; agent_id: string; request_json: string; status: string; run_id: string | null } | undefined;
    if (!deviceDelivery && input.direction === 'import') {
      // Artifact envelopes are queued immediately before their teamgroup.delivery. At this point the
      // durable owner-side delivery row does not exist yet, so accept only from the current host and
      // only for a local, currently consented roster. importTeamArtifact rechecks the exact delivery
      // and integrationDeviceId after the delivery row has been persisted, before exposing the commit.
      if (input.purpose !== 'input') throw new HttpError(403, 'This team artifact purpose requires a persisted active owner-device delivery.');
      const earlyStructure = await this.deviceStructureForArtifact(input.teamId, input.sharedProjectId);
      const localAgents = earlyStructure?.members.filter((member) => member.deviceId === localDeviceId && member.consent === 'granted') ?? [];
      const consent = this.options.store.db.prepare(`SELECT consent_json FROM mingle_team_device_consents WHERE shared_project_id=? AND device_id=? ORDER BY updated_at DESC LIMIT 1`)
        .get(input.sharedProjectId, localDeviceId) as { consent_json: string } | undefined;
      let currentlyConsented = false;
      try {
        const parsed = consent ? JSON.parse(consent.consent_json) as { state?: unknown; agentIds?: unknown } : null;
        const agentIds = parsed && Array.isArray(parsed.agentIds) ? parsed.agentIds : [];
        currentlyConsented = parsed?.state === 'granted' && localAgents.some((agent) => agentIds.includes(agent.agentId));
      } catch { currentlyConsented = false; }
      if (earlyStructure?.host?.deviceId !== input.peerDeviceId || !localAgents.length || !currentlyConsented) {
        throw new HttpError(403, 'The artifact sender is not the active integration device for a consented local team agent.');
      }
      return;
    }
    if (!deviceDelivery) throw new HttpError(403, 'No active team delivery authorizes this artifact transfer.');
    let rawRequest: unknown;
    try { rawRequest = JSON.parse(deviceDelivery.request_json) as unknown; } catch { throw new HttpError(403, 'The saved team delivery authorization is invalid.'); }
    const delivery = TeamDeliveryPayloadSchema.safeParse(rawRequest);
    if (!delivery.success || delivery.data.sharedProjectId !== input.sharedProjectId || delivery.data.deliveryId !== input.deliveryId
      || delivery.data.agentId !== deviceDelivery.agent_id || delivery.data.integrationDeviceId !== input.peerDeviceId) {
      throw new HttpError(403, 'The artifact peer is not the integration device recorded for this delivery.');
    }
    if (input.purpose === 'mcp' && (deviceDelivery.status !== 'running' || !deviceDelivery.run_id)) {
      throw new HttpError(403, 'The owner-side MCP artifact transfer is no longer running.');
    }
    if (input.purpose === 'terminal' && !['running', 'awaiting-approval'].includes(deviceDelivery.status)) {
      throw new HttpError(403, 'The owner-side terminal artifact transfer is no longer active.');
    }
    const structure = await this.deviceStructureForArtifact(input.teamId, input.sharedProjectId);
    if (!structure || structure.host?.deviceId !== input.peerDeviceId
      || !structure.members.some((member) => member.agentId === deviceDelivery.agent_id && member.deviceId === localDeviceId && member.consent === 'granted')) {
      throw new HttpError(403, 'The team delivery owner or integration device is no longer active.');
    }
    const consentRows = this.options.store.db.prepare(`SELECT consent_json FROM mingle_team_device_consents WHERE shared_project_id=? ORDER BY updated_at DESC`)
      .all(input.sharedProjectId) as Array<{ consent_json: string }>;
    const hasConsent = consentRows.some((row) => {
      try {
        const consent = JSON.parse(row.consent_json) as { deviceId?: unknown; state?: unknown; agentIds?: unknown };
        return consent.deviceId === localDeviceId && consent.state === 'granted' && Array.isArray(consent.agentIds) && consent.agentIds.includes(deviceDelivery.agent_id);
      } catch { return false; }
    });
    if (!hasConsent) throw new HttpError(403, 'The owner has not granted current consent for this team artifact delivery.');
  }

  private completionIntentValue(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== 'string') return null;
    try {
      const value = JSON.parse(raw) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value)
        && (value as Record<string, unknown>).kind === 'team-completion' ? value as Record<string, unknown> : null;
    } catch { return null; }
  }

  private completionIntentHasArtifact(raw: unknown, input: TeamArtifactAuthorization): boolean {
    const intent = this.completionIntentValue(raw);
    if (!intent || !Array.isArray(intent.artifacts)) return false;
    return intent.artifacts.some((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const source = (entry as Record<string, unknown>).source;
      if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
      const artifact = source as Record<string, unknown>;
      return artifact.transferId === input.transferId && typeof artifact.revision === 'string'
        && artifact.revision.toLowerCase() === input.revision?.toLowerCase()
        && artifact.path === input.path && (artifact.taskId ?? undefined) === input.taskId;
    });
  }

  private async deviceStructureForArtifact(teamId: string, sharedProjectId: string): Promise<ReturnType<typeof TeamStructurePayloadSchema.parse> | null> {
    const row = this.options.store.db.prepare(`SELECT structure_json FROM mingle_team_device_structures WHERE shared_project_id=? AND team_id=?`)
      .get(sharedProjectId, teamId) as { structure_json: string } | undefined;
    try { return row ? TeamStructurePayloadSchema.parse(JSON.parse(row.structure_json)) : null; } catch { return null; }
  }

  private async quota(session: Session): Promise<QuotaObservation> {
    let usage: ProviderUsage;
    try { usage = await this.options.providers.usage(session); }
    catch { return { state: 'unknown', observedAt: null, reason: 'The provider did not report quota.' }; }
    const fresh = Date.parse(usage.fetchedAt);
    if (!Number.isFinite(fresh) || fresh > Date.now() + 30_000 || Date.now() - fresh > 5 * 60_000) return { state: 'unknown', observedAt: usage.fetchedAt, reason: 'The quota report is stale.' };
    const known = usage.windows.filter((window) => window.remainingPercent !== null || window.usedPercent !== null);
    const exhausted = known.some((window) => (window.remainingPercent ?? 100 - window.usedPercent!) <= 0 && (!window.resetAt || Date.parse(window.resetAt) > Date.now()));
    if (exhausted) return { state: 'exhausted', observedAt: usage.fetchedAt, reason: 'A native quota window is exhausted.' };
    if (usage.status === 'available' && known.length && known.every((window) => (window.remainingPercent ?? 100 - window.usedPercent!) > 0)) return { state: 'available', observedAt: usage.fetchedAt };
    return { state: 'unknown', observedAt: usage.fetchedAt, reason: 'The provider has not reported sufficient quota information.' };
  }

  private subscribeProgress(sessionId: string, listener: (event: RemoteExecutionProgress) => void): () => void {
    // Execution subscribes immediately before synchronously starting its one approved run.
    // Follow that next durable run even if another local run starts before our coalesced read.
    const baseline = this.options.store.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS sequence FROM session_runs WHERE session_id = ?')
      .get(sessionId) as { sequence: number };
    let lastSignature = '';
    let lastMessage = '';
    let timer: NodeJS.Timeout | null = null;
    let stopped = false;
    const emit = () => {
      timer = null;
      if (stopped || this.closed) return;
      const row = this.options.store.db.prepare('SELECT id,status FROM session_runs WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT 1')
        .get(sessionId, baseline.sequence) as { id: string; status: string } | undefined;
      if (!row) return;
      const message = this.options.store.db.prepare("SELECT content FROM messages WHERE session_id = ? AND run_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(sessionId, row.id) as { content: string } | undefined;
      const signature = `${row.id}:${row.status}`;
      if (row.status !== 'running') {
        if (signature !== lastSignature) listener({ runId: row.id, kind: 'result', status: row.status === 'completed' ? 'completed' : 'failed', terminal: true,
          summary: redactSecrets(message?.content ?? `Remote run ${row.status}.`).slice(-1000) });
      } else if (message?.content && message.content !== lastMessage) {
        listener({ runId: row.id, kind: 'progress', status: 'running', summary: redactSecrets(message.content).slice(-1000) });
      } else if (signature !== lastSignature) listener({ runId: row.id, kind: 'status', status: 'running', summary: 'The approved remote run is active.' });
      lastSignature = signature;
      lastMessage = message?.content ?? '';
    };
    const schedule = () => { if (!timer && !stopped) { timer = setTimeout(emit, 500); timer.unref(); } };
    const unsubscribe = this.options.store.subscribe((event) => { if (!event || event.sessionId === sessionId) schedule(); });
    schedule();
    return () => { stopped = true; if (timer) clearTimeout(timer); unsubscribe(); };
  }

  async snapshot(teamId?: string) {
    const teams = await this.teams.snapshot();
    const emptyExecution = { bindings: [], agents: [], requests: [], approvals: [], messages: [], tasks: [], events: [] };
    const emptyOperations = { bindings: [], requests: [], audit: [] };
    if (!teams.userId || teams.error) return { teams, transport: { deviceId: null, devices: [], links: [], outbox: [], status: 'signed-out', error: teams.error ?? null }, execution: emptyExecution, git: emptyOperations, commands: emptyOperations };
    if (teamId) await this.teams.assertMember(teamId);
    const transport = this.transport.snapshot(teamId);
    if (!transport.deviceId) return { teams, transport, execution: emptyExecution, git: emptyOperations, commands: emptyOperations };
    const [execution, git, commands] = await Promise.all([this.execution.snapshot(teamId), this.git.snapshot(teamId), this.commands.snapshot(teamId)]);
    return { teams, transport, execution, git, commands };
  }

  async bindProject(input: { teamId: string; sharedProjectId: string; localProjectId: string }) {
    await this.authorizeTeam(input);
    const execution = await this.execution.bindProject(input);
    await this.git.bindProject(input);
    await this.commands.bindProject(input);
    return execution;
  }

  async decideGit(input: { requestId: string; expectedDigest: string; decision: 'approved' | 'denied' }) {
    const snapshot = await this.git.snapshot();
    const request = snapshot.requests.find((request) => request.id === input.requestId);
    const binding = request && snapshot.bindings.find((binding) => binding.teamId === request.teamId && binding.sharedProjectId === request.sharedProjectId);
    if (!binding || input.decision === 'denied') return this.git.decide(input);
    return this.options.repository.withExternalMutation(binding.localProjectId, () => this.git.decide(input));
  }

  /** Team bundle imports mutate only isolated refs but still share the project's repository-operation lease. */
  async importTeamArtifact(input: Parameters<GitSyncService['importTeamArtifact']>[0]) {
    const snapshot = await this.git.snapshot(input.teamId);
    const binding = snapshot.bindings.find((candidate) => candidate.teamId === input.teamId && candidate.sharedProjectId === input.sharedProjectId);
    if (!binding) throw new HttpError(409, 'Bind this shared project before importing a team artifact.');
    return this.options.repository.withExternalRefMutation(binding.localProjectId, () => this.git.importTeamArtifact(input));
  }

  /** Cancellation cleanup removes only unrecorded MCP transfers; already-published group handoffs remain durable. */
  async discardUnpublishedMcpArtifacts(input: { teamId: string; sharedProjectId: string; deliveryId: string }): Promise<void> {
    const snapshot = await this.git.snapshot(input.teamId);
    const binding = snapshot.bindings.find((candidate) => candidate.teamId === input.teamId && candidate.sharedProjectId === input.sharedProjectId);
    if (!binding) return;
    await this.options.repository.withExternalRefMutation(binding.localProjectId, () => this.git.discardUnpublishedMcpArtifacts(input));
  }

  /** Integrate verified remote commits into a group worktree under the repository's mutation lease. */
  async integrateTeamArtifact(input: Parameters<GitSyncService['integrateTeamArtifact']>[0] & { localProjectId: string }) {
    const snapshot = await this.git.snapshot(input.teamId);
    const binding = snapshot.bindings.find((candidate) => candidate.teamId === input.teamId
      && candidate.sharedProjectId === input.sharedProjectId && candidate.localProjectId === input.localProjectId);
    if (!binding) throw new HttpError(409, 'Bind this shared project to the selected host project before integrating a team artifact.');
    const { localProjectId: _localProjectId, ...artifactInput } = input;
    return this.options.repository.withExternalMutation(binding.localProjectId, () => this.git.integrateTeamArtifact(artifactInput));
  }

  /** A provider tool approval for remote work belongs to the same destination owner as the run. */
  async authorizeNativeApproval(approvalId: string): Promise<void> {
    const approval = this.options.store.getApproval(approvalId);
    if (!approval) return;
    const request = this.options.store.db.prepare(`SELECT r.team_id,r.source_device_id,r.target_device_id,r.target_owner_id
      FROM mingle_remote_requests r JOIN session_runs run ON run.id = r.run_id
      WHERE run.session_id = ? AND run.status = 'running' ORDER BY r.created_at DESC LIMIT 1`)
      .get(approval.sessionId) as { team_id: string; source_device_id: string; target_device_id: string; target_owner_id: string } | undefined;
    if (!request) return;
    await this.options.account.withAuthenticatedClient(async (_client, user) => {
      if (user.id !== request.target_owner_id || this.transport.snapshot(request.team_id).deviceId !== request.target_device_id) throw new HttpError(403, 'Only this remote run’s destination device owner may approve its provider tools.');
      await this.authorizeTeam({ teamId: request.team_id, peerDeviceId: request.source_device_id });
    });
  }

  async inspectRepository(input: { teamId: string; sharedProjectId: string; localProjectId: string }) {
    await this.authorizeTeam(input);
    const snapshot = await this.execution.snapshot(input.teamId);
    if (!snapshot.bindings.some((binding) => binding.sharedProjectId === input.sharedProjectId && binding.localProjectId === input.localProjectId)) throw new HttpError(403, 'Bind this shared project to its local folder first.');
    const project = this.options.store.getProject(input.localProjectId);
    if (!project) throw new HttpError(404, 'Local project not found.');
    return fingerprintRepository(project.path);
  }

  async groupSnapshot(groupId: string) {
    const group = this.options.groups.get(groupId);
    const empty = { agents: [], messages: [], tasks: [], requests: [] };
    if (!this.transport.snapshot().deviceId) return empty;
    const execution = await this.execution.snapshot();
    const bindings = execution.bindings.filter((binding) => binding.localProjectId === group.group.projectId);
    const permitted = (row: { teamId: string; sharedProjectId: string }) => bindings.some((binding) => binding.teamId === row.teamId && binding.sharedProjectId === row.sharedProjectId);
    const requests = execution.requests.filter((request) => request.task?.groupId === groupId && permitted(request));
    const messages = execution.messages.filter((message) => message.groupId === groupId && permitted(message));
    const tasks = execution.tasks.filter((task) => task.groupId === groupId && permitted(task));
    const agentIds = new Set([...requests.map((request) => request.agentId), ...tasks.map((task) => task.agentId)]);
    return { requests, messages, tasks, agents: execution.agents.filter((agent) => agentIds.has(agent.id) && permitted(agent)) };
  }

  private scheduleMetadataRefresh(): void {
    if (this.closed) return;
    if (this.metadataWork) { this.metadataAgain = true; return; }
    // Bound burst delay: later events do not keep pushing the refresh back.
    if (this.metadataDebounce) return;
    this.metadataDebounce = setTimeout(() => {
      this.metadataDebounce = null;
      void this.refreshMetadata();
    }, 40);
    this.metadataDebounce.unref();
  }

  private refreshMetadata(): Promise<void> {
    if (this.closed || !this.transport.snapshot().deviceId) return Promise.resolve();
    if (this.metadataWork) { this.metadataAgain = true; return this.metadataWork; }
    this.metadataWork = (async () => {
      const snapshot = await this.execution.snapshot();
      for (const binding of snapshot.bindings) {
        if (this.closed) return;
        const deviceId = this.transport.snapshot(binding.teamId).deviceId;
        if (snapshot.agents.some((agent) => agent.deviceId === deviceId && agent.sharedProjectId === binding.sharedProjectId && agent.teamId === binding.teamId)) {
          await this.execution.refreshPublishedAgents({ teamId: binding.teamId, sharedProjectId: binding.sharedProjectId });
        }
        // Only tasks already explicitly shared by this owner follow subsequent local edits.
        for (const shared of snapshot.tasks.filter((task) => task.deviceId === deviceId && task.teamId === binding.teamId && task.sharedProjectId === binding.sharedProjectId)) {
          const local = this.options.store.getTask(shared.id);
          if (!local || local.projectId !== binding.localProjectId) continue;
          if (local.status === shared.status && redactSecrets(local.title).slice(0, 200) === shared.title
            && redactSecrets(local.description).slice(0, 2000) === shared.description && redactSecrets(local.acceptanceCriteria).slice(0, 1000) === shared.acceptanceCriteria
            && JSON.stringify(local.dependsOn.slice(0, 50)) === JSON.stringify(shared.dependsOn)) continue;
          await this.execution.publishTask({ teamId: binding.teamId, sharedProjectId: binding.sharedProjectId, taskId: local.id,
            ...(shared.agentId ? { agentId: shared.agentId } : {}), ...(shared.groupId ? { groupId: shared.groupId } : {}) });
        }
      }
    })().catch(() => { /* Offline/expired identity remains visible through transport and account state. */ }).finally(() => {
      this.metadataWork = null;
      if (this.metadataAgain) {
        this.metadataAgain = false;
        this.scheduleMetadataRefresh();
      }
    });
    return this.metadataWork;
  }
  start(): void {
    this.transport.start();
    this.scheduleMetadataRefresh();
    this.metadataTimer ??= setInterval(() => { void this.refreshMetadata(); }, 30_000);
    this.metadataTimer.unref();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.metadataTimer) clearInterval(this.metadataTimer);
    if (this.metadataDebounce) clearTimeout(this.metadataDebounce);
    this.metadataDebounce = null;
    this.unsubscribeMetadata();
    await this.metadataWork;
    this.unsubscribe();
    await this.execution.close();
    await this.transport.close();
  }
}
