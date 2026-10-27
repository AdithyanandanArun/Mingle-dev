import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type {
  ProjectCollaborationAgent, ProjectCollaborationInvitation, ProjectCollaborationMember,
  ProjectCollaborationProject, ProjectCollaborationSnapshot, ProjectInvitationCreateResult,
  ProjectInvitationJoinResult, ProjectInvitationPreview, CreateProjectInvitationInput,
  JoinProjectInvitationInput,
} from '../../../../packages/contracts/src/project-collaboration.ts';
import { CreateProjectInvitationSchema, JoinProjectInvitationSchema, PreviewProjectInvitationSchema } from '../../../../packages/contracts/src/project-collaboration.ts';
import { resolveRunConfig } from '../session-config.ts';
import { runGit } from '../distributed/git-common.ts';
import { failureSummary } from '../repository/scrub.ts';
import type { AccountService } from '../account/service.ts';
import type { DistributedWorkspaceService } from '../distributed/service.ts';
import type { Store } from '../store.ts';
import type { WorkspaceService } from '../workspace.ts';
import type { ProviderService } from '../provider-service.ts';
import { HttpError, conflict, notFound } from '../util.ts';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REMOTE_ROSTER_PROVIDERS = new Set(['claude', 'codex', 'opencode']);
const PROVIDER_DISPLAY_NAMES = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' } as const;
type Row = Record<string, unknown>;
type CloudError = { code?: string | null; message?: string | null } | null;
type InvitationAgent = NonNullable<JoinProjectInvitationInput['agent']>;

export interface ProjectInvitationEmailSender {
  status(client: SupabaseClient): Promise<{ configured: boolean; message?: string; joinUrlBase?: string }>;
  send(client: SupabaseClient, input: { invitationId: string; token: string }): Promise<{ status: 'sent' | 'not_configured' | 'failed'; message: string }>;
}

interface SourceBinding {
  projectId: string;
  ownerId: string;
  teamId: string;
  sharedProjectId: string;
  leaderDeviceId: string | null;
  leaderFingerprint: string | null;
}

interface InvitationRow {
  id: string;
  team_id: string;
  shared_project_id: string;
  email: string;
  role: 'admin' | 'member';
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
  created_at: string;
}

function failCloud(error: CloudError, message: string): never {
  if (['42P01', '42883', 'PGRST202', 'PGRST205'].includes(error?.code ?? '')) {
    throw new HttpError(503, 'Project collaboration cloud setup is incomplete. Apply the reviewed collaboration migration and try again.');
  }
  if (error?.code === '42501') throw new HttpError(403, 'Your active team role or invitation does not allow this operation.');
  if (error?.code === '23505') throw conflict('This project collaboration record already exists. Refresh the project and try again.');
  if (error?.code === 'P0001') throw new HttpError(404, 'The invitation is invalid, expired, revoked, or belongs to another account. Ask the project leader to issue a new invitation if it has expired.');
  throw new HttpError(502, message);
}

function requireRow(value: unknown, error: CloudError, message: string): Row {
  if (error) failCloud(error, message);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(502, message);
  return value as Row;
}

function rpcObject(value: unknown, error: CloudError, message: string): Row {
  if (error) failCloud(error, message);
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new HttpError(502, message);
  return row as Row;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !value) throw new HttpError(502, 'The collaboration service returned an unsupported response.');
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value == null) return null;
  if (typeof value !== 'string') throw new HttpError(502, 'The collaboration service returned an unsupported response.');
  return value;
}

function emailStatusFrom(value: unknown): { configured: boolean; message?: string; joinUrlBase?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { configured: false, message: 'Email delivery status is unavailable.' };
  const row = value as Record<string, unknown>;
  const joinUrlBase = safeJoinBase(row.joinUrlBase) ?? undefined;
  if (row.configured !== true) return { configured: false, message: typeof row.message === 'string' ? row.message : 'Configure a verified sender and public HTTPS join page to enable email delivery.', joinUrlBase };
  return { configured: true, joinUrlBase };
}

function safeJoinBase(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    return url.href;
  } catch { return null; }
}

export function normalizeRepositoryUrl(value: string): { url: string; identity: string } {
  if (value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) throw new HttpError(409, 'This project does not have a safe, shareable Git origin URL.');
  const scpGitHub = value.match(/^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/i);
  if (scpGitHub) value = `https://github.com/${scpGitHub[1]}`;
  else if (/^ssh:\/\//i.test(value)) {
    try {
      const ssh = new URL(value);
      const parts = ssh.pathname.split('/').filter(Boolean);
      if (ssh.hostname.toLowerCase() === 'github.com' && ssh.username === 'git' && !ssh.password && !ssh.port
        && !ssh.search && !ssh.hash && parts.length === 2) {
        value = `https://github.com/${parts.join('/')}`;
      }
    } catch { /* The normal parser below returns the actionable error. */ }
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(409, 'This project does not have a safe, shareable Git origin URL.'); }
  if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash
    || /%2f|%5c/i.test(url.pathname)) {
    throw new HttpError(409, 'Use a credential-free HTTPS/SSH Git origin without URL parameters. GitHub SSH remotes in git@github.com:owner/repo.git form are converted safely to HTTPS.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  const segments = path.split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => {
    try { const decoded = decodeURIComponent(segment); return decoded === '.' || decoded === '..' || /[\x00-\x1f\x7f\\]/.test(decoded); }
    catch { return true; }
  })) throw new HttpError(409, 'This project does not have a safe, shareable Git origin URL.');
  url.pathname = path;
  const identityPath = path.replace(/\.git$/i, '');
  return {
    url: url.href.replace(/\/$/, ''),
    identity: `${url.protocol}//${url.host.toLowerCase()}${identityPath}`,
  };
}

function invitationStatus(row: Pick<InvitationRow, 'accepted_at' | 'revoked_at' | 'expires_at'>, now: number): ProjectCollaborationInvitation['status'] {
  if (row.revoked_at) return 'revoked';
  if (row.accepted_at) return 'accepted';
  if (Date.parse(row.expires_at) <= now) return 'expired';
  return 'pending';
}

function defaultEmailSender(): ProjectInvitationEmailSender {
  const invoke = async (client: SupabaseClient, action: 'status' | 'send', body: Record<string, string> = {}) => {
    try {
      const { data, error } = await client.functions.invoke('project-invitation-delivery', { body: { action, ...body } });
      if (error) return { data: null, error };
      return { data, error: null };
    } catch (error) { return { data: null, error }; }
  };
  return {
    async status(client) {
      const result = await invoke(client, 'status');
      if (result.error) return { configured: false, message: 'Email sender readiness could not be confirmed. You can still copy the project invite link.' };
      return emailStatusFrom(result.data);
    },
    async send(client, input) {
      const result = await invoke(client, 'send', input);
      if (result.error) return { status: 'failed', message: 'The configured email sender could not confirm delivery. Copy the project invite link or check sender configuration.' };
      if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
        return { status: 'failed', message: 'The email sender returned an unsupported response. Copy the project invite link.' };
      }
      const row = result.data as Record<string, unknown>;
      if (row.status === 'sent' && typeof row.message === 'string') return { status: 'sent', message: row.message };
      if (row.status === 'not_configured') return { status: 'not_configured', message: typeof row.message === 'string' ? row.message : 'Configure an email sender and public HTTPS join page.' };
      return { status: 'failed', message: typeof row.message === 'string' ? row.message : 'The email sender did not confirm delivery. Copy the project invite link.' };
    },
  };
}

/** Project-first cloud invitations layered over Mingle's existing team, device, transport and execution services. */
export class ProjectCollaborationService {
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly joinFlights = new Map<string, { intent: string; promise: Promise<ProjectInvitationJoinResult> }>();
  private joinQueue: Promise<void> = Promise.resolve();
  private readonly emailSender: ProjectInvitationEmailSender;
  private emailReadinessCache: { configured: boolean; message?: string } | null = null;
  private emailReadinessAt = 0;
  private emailReadinessWork: Promise<void> | null = null;
  private emailReadinessScope: string | null = null;
  private emailReadinessGeneration = 0;
  private readonly joinBase = process.env.MINGLE_INVITE_JOIN_URL ?? '';
  private readonly now: () => Date;

  constructor(private readonly options: {
    store: Store;
    account: AccountService;
    distributed: DistributedWorkspaceService;
    workspace: WorkspaceService;
    providers: ProviderService;
    emailSender?: ProjectInvitationEmailSender;
    now?: () => Date;
    token?: () => string;
  }) {
    this.emailSender = options.emailSender ?? defaultEmailSender();
    this.now = options.now ?? (() => new Date());
    this.tokenFactory = options.token ?? (() => randomBytes(32).toString('base64url'));
    this.ensureLocalTables();
  }

  private readonly tokenFactory: () => string;

  private ensureOpen() {
    if (this.closed) throw new HttpError(503, 'Project collaboration service is closed.');
  }

  private ensureLocalTables() {
    this.options.store.db.exec(`
      CREATE TABLE IF NOT EXISTS mingle_project_collaboration_sources (
        local_project_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, team_id TEXT NOT NULL,
        shared_project_id TEXT NOT NULL, leader_device_id TEXT, leader_fingerprint TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mingle_project_collaboration_joins (
        invitation_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, device_id TEXT NOT NULL,
        local_project_id TEXT NOT NULL, team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL,
        session_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(account_id,device_id,local_project_id,team_id,shared_project_id)
      );
      CREATE TABLE IF NOT EXISTS mingle_project_collaboration_join_agents (
        account_id TEXT NOT NULL, device_id TEXT NOT NULL, local_project_id TEXT NOT NULL,
        team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        session_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(account_id,device_id,local_project_id,team_id,shared_project_id,ordinal),
        UNIQUE(account_id,device_id,local_project_id,team_id,shared_project_id,session_id)
      );
      INSERT OR IGNORE INTO mingle_project_collaboration_join_agents
        (account_id,device_id,local_project_id,team_id,shared_project_id,ordinal,session_id,provider,model,effort,created_at)
        SELECT account_id,device_id,local_project_id,team_id,shared_project_id,0,session_id,provider,model,effort,created_at
        FROM mingle_project_collaboration_joins;
    `);
  }

  private runTracked<T>(work: () => Promise<T>): Promise<T> {
    this.ensureOpen();
    const task = work();
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => undefined);
    return task;
  }

  private withClient<T>(callback: (client: SupabaseClient, user: User) => Promise<T>): Promise<T> {
    this.ensureOpen();
    // TeamService is the existing cloud authority bridge and delegates each call
    // to the injected AccountService, including a fresh Supabase auth.getUser().
    return this.options.distributed.teams.withClient(async (client, user) => {
      const verified = await this.options.account.withAuthenticatedClient(async (_sameClient, current) => current);
      if (verified.id !== user.id) throw conflict('The signed-in account changed while the collaboration request was running. Retry.');
      return callback(client, user);
    });
  }

  /** Email sender readiness is ancillary UI metadata; never hold a roster or consent snapshot on it. */
  private emailScope(accountId: string): string | null {
    const account = this.options.account.snapshot?.();
    if (!account) return `${accountId}\0unreported-connection`;
    if (account.status !== 'signed-in' || account.user?.id !== accountId || !account.connection) return null;
    const keyDigest = createHash('sha256').update(account.connection.publishableKey).digest('hex');
    return `${accountId}\0${account.connection.url}\0${keyDigest}`;
  }

  private scheduleEmailReadiness(client: SupabaseClient, accountId: string): void {
    const scope = this.emailScope(accountId);
    if (scope !== this.emailReadinessScope) {
      this.emailReadinessScope = scope;
      this.emailReadinessGeneration += 1;
      this.emailReadinessCache = null;
      this.emailReadinessAt = 0;
      this.emailReadinessWork = null;
    }
    if (!scope || this.emailReadinessWork || this.now().getTime() - this.emailReadinessAt < 60_000) return;
    const generation = this.emailReadinessGeneration;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Email readiness probe timed out.')), 5_000);
    });
    let tracked!: Promise<void>;
    tracked = Promise.race([Promise.resolve().then(() => this.emailSender.status(client)), deadline]).then((sender) => {
      if (this.emailReadinessGeneration !== generation || this.emailScope(accountId) !== scope) return;
      const status = emailStatusFrom(sender);
      this.emailReadinessCache = status.configured ? { configured: true }
        : { configured: false, ...(status.message ? { message: status.message } : {}) };
    }).catch(() => {
      if (this.emailReadinessGeneration === generation && this.emailScope(accountId) === scope) {
        this.emailReadinessCache = { configured: false, message: 'Email sender status is temporarily unavailable; invite links remain available.' };
      }
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
      this.pending.delete(tracked);
      if (this.emailReadinessGeneration === generation) {
        this.emailReadinessAt = this.now().getTime();
        if (this.emailReadinessWork === tracked) this.emailReadinessWork = null;
        if (!this.closed) this.options.store.touch();
      }
    });
    this.emailReadinessWork = tracked;
    this.pending.add(tracked);
  }

  private localProject(projectId: string) {
    const project = this.options.store.getProject(projectId);
    if (!project) throw notFound('Project not found.');
    if (project.isExample) throw new HttpError(409, 'Open an existing Git project before inviting teammates.');
    return project;
  }

  private async repository(projectId: string) {
    const project = this.localProject(projectId);
    let root: string;
    try { root = await realpath(project.path); } catch { throw new HttpError(409, 'The local project folder is no longer available.'); }
    const topResult = await runGit(root, ['rev-parse', '--show-toplevel'], { allowFailure: true, maxOutputBytes: 4096 });
    if (topResult.code !== 0) {
      const detail = topResult.stderr.toString('utf8');
      if (/detected dubious ownership/i.test(detail)) {
        throw new HttpError(409, 'Git does not trust this folder’s ownership. Review the repository ownership and Git trust settings before joining.');
      }
      if (/not a git repository/i.test(detail)) throw new HttpError(409, 'This project is not an existing Git repository.');
      if (/must be run in a work tree/i.test(detail)) throw new HttpError(409, 'Select a Git working checkout. A bare repository cannot be used as a project workspace.');
      throw new HttpError(409, `Git could not inspect this project folder. ${failureSummary(detail) || 'Check Git installation, configuration and folder permissions, then retry.'}`);
    }
    const top = topResult.stdout.toString('utf8').replace(/\r?\n$/, '');
    let canonicalTop: string;
    try { canonicalTop = await realpath(top); } catch { throw new HttpError(409, 'The Git repository root is unavailable.'); }
    if (canonicalTop !== root) throw new HttpError(409, 'Open the Git repository root as the Mingle project before inviting teammates.');
    const remote = await runGit(root, ['remote', 'get-url', 'origin'], { allowFailure: true, maxOutputBytes: 4096 });
    if (remote.code !== 0) throw new HttpError(409, 'Configure a safe origin remote before inviting teammates.');
    return { project, repository: normalizeRepositoryUrl(remote.stdout.toString('utf8').trim()) };
  }

  private mapping(projectId: string, ownerId: string): SourceBinding | null {
    const row = this.options.store.db.prepare(`SELECT local_project_id,owner_id,team_id,shared_project_id,leader_device_id,leader_fingerprint
      FROM mingle_project_collaboration_sources WHERE local_project_id = ?`).get(projectId) as Row | undefined;
    if (!row) return null;
    if (row.owner_id !== ownerId) throw conflict('This local project is already linked to another Mingle account. Sign in with that account or explicitly unlink the project first.');
    return {
      projectId: String(row.local_project_id), ownerId: String(row.owner_id), teamId: String(row.team_id),
      sharedProjectId: String(row.shared_project_id), leaderDeviceId: nullableText(row, 'leader_device_id'),
      leaderFingerprint: nullableText(row, 'leader_fingerprint'),
    };
  }

  private async rejectJoinedProjectInviteAuthority(client: SupabaseClient, projectId: string, ownerId: string): Promise<void> {
    const joined = this.options.store.db.prepare(`SELECT team_id,device_id FROM mingle_project_collaboration_joins
      WHERE local_project_id=? AND account_id=? ORDER BY created_at DESC`).all(projectId, ownerId) as Row[];
    for (const row of joined) {
      const teamId = text(row, 'team_id');
      const member = await client.from('mingle_members').select('role').eq('team_id', teamId).eq('user_id', ownerId).is('revoked_at', null).maybeSingle();
      if (member.error) failCloud(member.error, 'The joined project membership could not be checked.');
      if (member.data) throw new HttpError(403, 'You joined this shared project as a teammate. Only its existing project leader can invite more teammates.');
    }
  }

  private async bootstrapBinding(projectId: string): Promise<SourceBinding> {
    const { project, repository } = await this.repository(projectId);
    const initial = await this.withClient(async (client, user) => {
      if (!user.email || !user.email_confirmed_at) throw new HttpError(403, 'A verified account email is required to invite project collaborators.');
      let binding = this.mapping(projectId, user.id);
      if (!binding) {
        await this.rejectJoinedProjectInviteAuthority(client, projectId, user.id);
        const at = this.now().toISOString();
        binding = { projectId, ownerId: user.id, teamId: randomUUID(), sharedProjectId: randomUUID(), leaderDeviceId: null, leaderFingerprint: null };
        this.options.store.tx(() => this.options.store.db.prepare(`INSERT INTO mingle_project_collaboration_sources
          (local_project_id,owner_id,team_id,shared_project_id,leader_device_id,leader_fingerprint,created_at,updated_at)
          VALUES (?,?,?,?,NULL,NULL,?,?)`).run(projectId, user.id, binding!.teamId, binding!.sharedProjectId, at, at));
      }
      const teamQuery = await client.from('mingle_teams').select('id,name,owner_id').eq('id', binding.teamId).maybeSingle();
      if (teamQuery.error) failCloud(teamQuery.error, 'The source project team could not be loaded.');
      let team = teamQuery.data as Row | null;
      if (!team) {
        const created = await client.from('mingle_teams').insert({ id: binding.teamId, name: project.name.slice(0, 100), owner_id: user.id })
          .select('id,name,owner_id').maybeSingle();
        if (created.error?.code === '23505') {
          const raced = await client.from('mingle_teams').select('id,name,owner_id').eq('id', binding.teamId).maybeSingle();
          if (raced.error || !raced.data) failCloud(raced.error, 'The source project team could not be created.');
          team = raced.data as Row;
        } else team = requireRow(created.data, created.error, 'The source project team could not be created.');
      }
      if (team.owner_id !== user.id) throw new HttpError(403, 'Only the owner of the linked cloud team can invite project collaborators.');
      const projectQuery = await client.from('mingle_projects').select('id,team_id,name,repository_url').eq('id', binding.sharedProjectId).maybeSingle();
      if (projectQuery.error) failCloud(projectQuery.error, 'The shared project record could not be loaded.');
      let shared = projectQuery.data as Row | null;
      if (!shared) {
        const created = await client.from('mingle_projects').insert({
          id: binding.sharedProjectId, team_id: binding.teamId, name: project.name.slice(0, 100), repository_url: repository.url,
        }).select('id,team_id,name,repository_url').maybeSingle();
        if (created.error?.code === '23505') {
          const raced = await client.from('mingle_projects').select('id,team_id,name,repository_url').eq('id', binding.sharedProjectId).maybeSingle();
          if (raced.error || !raced.data) failCloud(raced.error, 'The shared project record could not be created.');
          shared = raced.data as Row;
        } else shared = requireRow(created.data, created.error, 'The shared project record could not be created.');
      }
      if (shared.team_id !== binding.teamId || typeof shared.repository_url !== 'string'
        || normalizeRepositoryUrl(shared.repository_url).identity !== repository.identity) {
        throw conflict('The cloud project is linked to a different team or repository. Refresh and review its project settings.');
      }
      const scoped = await client.rpc('scope_mingle_team_to_project', { p_shared_project_id: binding.sharedProjectId });
      if (scoped.error) failCloud(scoped.error, 'The project-first team scope could not be established.');
      if (scoped.data !== true) throw new HttpError(502, 'The cloud team did not confirm its project-first scope.');
      const member = await client.from('mingle_members').select('role').eq('team_id', binding.teamId).eq('user_id', user.id).is('revoked_at', null).maybeSingle();
      if (member.error || !member.data || member.data.role !== 'owner') throw new HttpError(403, 'Only the active team leader can invite project collaborators.');
      const profile = await client.from('mingle_project_member_profiles').upsert({
        team_id: binding.teamId, user_id: user.id, email: user.email.toLowerCase(),
        display_name: typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name.slice(0, 200) : null,
      }, { onConflict: 'team_id,user_id' });
      if (profile.error) failCloud(profile.error, 'The verified team member profile could not be refreshed.');
      return { binding, userId: user.id };
    });

    // Registration is owned by the existing TransportService. It reuses the
    // current per-account device keys and never opens another network listener.
    const device = await this.options.distributed.transport.register({ teamId: initial.binding.teamId, name: 'Mingle desktop' });
    await this.options.distributed.bindProject({ teamId: initial.binding.teamId, sharedProjectId: initial.binding.sharedProjectId, localProjectId: project.id });
    const at = this.now().toISOString();
    this.options.store.tx(() => this.options.store.db.prepare(`UPDATE mingle_project_collaboration_sources
      SET leader_device_id = ?, leader_fingerprint = ?, updated_at = ? WHERE local_project_id = ? AND owner_id = ?`)
      .run(device.id, device.fingerprint, at, project.id, initial.userId));
    return { ...initial.binding, leaderDeviceId: device.id, leaderFingerprint: device.fingerprint };
  }

  private makeJoinUrl(token: string, joinBase?: string): string {
    const base = safeJoinBase(joinBase) ?? safeJoinBase(this.joinBase);
    if (!base) return `mingle://join?token=${encodeURIComponent(token)}`;
    const url = new URL(base);
    url.hash = `token=${encodeURIComponent(token)}`;
    return url.href;
  }

  private tokenHash(token: string): string { return createHash('sha256').update(token, 'utf8').digest('hex'); }

  async emailReadiness(): Promise<{ configured: boolean; message?: string }> {
    return this.runTracked(async () => this.withClient(async (client) => {
      const sender = await this.emailSender.status(client);
      const status = emailStatusFrom(sender);
      return status.configured ? { configured: true } : { configured: false, ...(status.message ? { message: status.message } : {}) };
    }));
  }

  snapshot(projectId: string): Promise<ProjectCollaborationSnapshot> {
    return this.runTracked(async () => {
      const local = this.localProject(projectId);
      const { project, repository } = await this.repository(projectId);
      const collab = await this.withClient(async (client, user) => {
        this.scheduleEmailReadiness(client, user.id);
        let binding = this.mapping(projectId, user.id);
        if (!binding) {
          const joins = this.options.store.db.prepare(`SELECT account_id,device_id,local_project_id,team_id,shared_project_id
            FROM mingle_project_collaboration_joins WHERE local_project_id=? AND account_id=? ORDER BY created_at DESC`)
            .all(projectId, user.id) as Row[];
          for (const row of joins) {
            const teamId = text(row, 'team_id');
            const deviceId = text(row, 'device_id');
            if (this.options.distributed.transport.snapshot(teamId).deviceId !== deviceId) continue;
            const member = await client.from('mingle_members').select('role').eq('team_id', teamId).eq('user_id', user.id).is('revoked_at', null).maybeSingle();
            if (member.error) failCloud(member.error, 'The joined project membership could not be checked.');
            if (!member.data) continue;
            binding = {
              projectId, ownerId: user.id, teamId, sharedProjectId: text(row, 'shared_project_id'),
              leaderDeviceId: null, leaderFingerprint: null,
            };
            break;
          }
        }
        if (!binding) return { binding: null, members: [], invitations: [] as ProjectCollaborationInvitation[], project: null as ProjectCollaborationProject | null };
        const [sharedResult, memberResult, profileResult, inviteResult] = await Promise.all([
          client.from('mingle_projects').select('id,team_id,name,repository_url').eq('id', binding.sharedProjectId).eq('team_id', binding.teamId).maybeSingle(),
          client.from('mingle_members').select('team_id,user_id,role,created_at').eq('team_id', binding.teamId).is('revoked_at', null).order('created_at', { ascending: true }).limit(500),
          client.from('mingle_project_member_profiles').select('team_id,user_id,email,display_name').eq('team_id', binding.teamId).limit(500),
          client.from('mingle_project_invitations').select('id,team_id,shared_project_id,email,role,invited_by,expires_at,accepted_at,accepted_by,revoked_at,created_at')
            .eq('team_id', binding.teamId).eq('shared_project_id', binding.sharedProjectId).order('created_at', { ascending: false }).limit(500),
        ]);
        if (sharedResult.error) failCloud(sharedResult.error, 'The shared project could not be loaded.');
        if (!sharedResult.data) throw notFound('The shared project is no longer available to this team.');
        const members = Array.isArray(memberResult.data) ? memberResult.data as Row[] : [];
        const profiles = Array.isArray(profileResult.data) ? profileResult.data as Row[] : [];
        const invitations = Array.isArray(inviteResult.data) ? inviteResult.data as Row[] : [];
        if (memberResult.error) failCloud(memberResult.error, 'The project teammate roster could not be loaded.');
        if (profileResult.error) failCloud(profileResult.error, 'The project teammate profiles could not be loaded.');
        if (inviteResult.error) failCloud(inviteResult.error, 'Project invitations could not be loaded.');
        const byUser = new Map(profiles.map((row) => [String(row.user_id), row]));
        const memberViews: ProjectCollaborationMember[] = members.map((row) => {
          const profile = byUser.get(String(row.user_id));
          const role = row.role === 'owner' ? 'leader' : row.role === 'admin' ? 'admin' : 'member';
          return {
            accountId: text(row, 'user_id'), email: profile ? nullableText(profile, 'email') : null,
            displayName: profile ? nullableText(profile, 'display_name') : null,
            role, status: 'active',
          };
        });
        const invitationViews: ProjectCollaborationInvitation[] = invitations.map((row) => ({
          id: text(row, 'id'), email: text(row, 'email'), role: row.role === 'admin' ? 'admin' : 'member',
          status: invitationStatus(row as unknown as InvitationRow, this.now().getTime()),
          createdAt: text(row, 'created_at'), expiresAt: text(row, 'expires_at'), invitedByAccountId: text(row, 'invited_by'),
        }));
        const shared = sharedResult.data as Row;
        if (typeof shared.repository_url !== 'string' || normalizeRepositoryUrl(shared.repository_url).identity !== repository.identity) {
          throw conflict('The local checkout no longer matches the shared project repository. Review the project invitation or select the correct checkout.');
        }
        const snapshotProject: ProjectCollaborationProject = {
          teamId: binding.teamId, sharedProjectId: binding.sharedProjectId,
          name: text(shared, 'name'), repositoryUrl: repository.url,
        };
        return { binding, members: memberViews, invitations: invitationViews, project: snapshotProject, userId: user.id };
      });
      const email = this.emailReadinessCache ?? { configured: false, message: 'Email sender status is being checked separately from team roster data.' };
      if (!collab.binding || !collab.project) return { project: null, members: [], agents: [], invitations: [], email };
      const device = this.options.distributed.transport.snapshot(collab.binding.teamId);
      const roster = await this.options.distributed.execution.snapshot(collab.binding.teamId);
      const ownPublished = new Map(roster.agents
        .filter((agent) => agent.sharedProjectId === collab.binding!.sharedProjectId && agent.deviceId === device.deviceId && agent.ownerId === collab.userId)
        .map((agent) => [agent.sessionId, agent.id] as const));
      const localAgents: ProjectCollaborationAgent[] = this.options.store.listSessions(local.id)
        .filter((session) => ownPublished.has(session.id)).map((session) => ({
        id: ownPublished.get(session.id)!, name: session.name, accountId: collab.userId!, deviceId: device.deviceId ?? '', projectId: local.id,
        sessionId: session.id, provider: session.provider, model: session.model,
        state: session.status === 'error' ? 'error' : session.status,
      }));
      const remoteAgents: ProjectCollaborationAgent[] = roster.agents
        .filter((agent) => agent.sharedProjectId === collab.binding!.sharedProjectId)
        .filter((agent) => !(agent.deviceId === device.deviceId && localAgents.some((localAgent) => localAgent.sessionId === agent.sessionId)))
        .map((agent) => ({ id: agent.id, name: agent.name, accountId: agent.ownerId, deviceId: agent.deviceId,
          projectId: local.id, sessionId: agent.sessionId, provider: agent.provider,
          model: agent.model, state: agent.presence }));
      return { project: collab.project, members: collab.members, agents: [...localAgents, ...remoteAgents], invitations: collab.invitations, email };
    });
  }

  createInvitation(projectId: string, input: CreateProjectInvitationInput): Promise<ProjectInvitationCreateResult> {
    return this.runTracked(async () => {
      const parsed = CreateProjectInvitationSchema.parse(input);
      const { project, repository } = await this.repository(projectId);
      const binding = await this.bootstrapBinding(project.id);
      const token = this.tokenFactory();
      const tokenHash = this.tokenHash(token);
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('Token generator returned an invalid token.');
      return this.withClient(async (client, user) => {
        if (!user.email || !user.email_confirmed_at) throw new HttpError(403, 'A verified account email is required to invite project collaborators.');
        const member = await client.from('mingle_members').select('role').eq('team_id', binding.teamId).eq('user_id', user.id).is('revoked_at', null).maybeSingle();
        if (member.error || !member.data || member.data.role !== 'owner') throw new HttpError(403, 'Only the active project leader can invite teammates.');
        const { data, error } = await client.rpc('create_mingle_project_invitation', {
          p_shared_project_id: binding.sharedProjectId, p_email: parsed.email, p_role: parsed.role,
          p_leader_device_id: binding.leaderDeviceId, p_leader_fingerprint: binding.leaderFingerprint, p_token_hash: tokenHash,
        });
        const row = rpcObject(data, error, 'The project invitation could not be created.');
        const attempt = await this.deliver(client, text(row, 'id'), token);
        const delivery = { status: attempt.status, message: attempt.message };
        const invitation: ProjectInvitationCreateResult['invitation'] = {
          id: text(row, 'id'), email: text(row, 'email'), role: row.role === 'admin' ? 'admin' : 'member',
          status: 'pending', expiresAt: text(row, 'expires_at'),
        };
        this.options.store.touch();
        return { invitation, delivery, ...(delivery.status === 'sent' ? {} : { joinUrl: this.makeJoinUrl(token, attempt.joinUrlBase) }) };
      });
    });
  }

  private async deliver(client: SupabaseClient, invitationId: string, token: string) {
    const status = await this.emailSender.status(client);
    const joinUrlBase = safeJoinBase(status.joinUrlBase) ?? safeJoinBase(this.joinBase) ?? undefined;
    if (!status.configured) return { status: 'not_configured' as const, message: status.message ?? 'Configure an email sender and public HTTPS join page. Copy the project invite link to share it manually.', joinUrlBase };
    const delivery = await this.emailSender.send(client, { invitationId, token });
    return { ...delivery, joinUrlBase };
  }

  resendInvitation(projectId: string, invitationId: string): Promise<ProjectInvitationCreateResult> {
    return this.runTracked(async () => {
      const project = this.localProject(projectId);
      const binding = await this.withClient(async (_client, user) => this.mapping(project.id, user.id));
      if (!binding) throw notFound('Project collaboration has not been set up.');
      const token = this.tokenFactory();
      const tokenHash = this.tokenHash(token);
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('Token generator returned an invalid token.');
      return this.withClient(async (client, user) => {
        const before = await client.from('mingle_project_invitations').select('id,email,role,expires_at,created_at,invited_by,accepted_at,revoked_at')
          .eq('id', invitationId).eq('team_id', binding.teamId).eq('shared_project_id', binding.sharedProjectId).maybeSingle();
        const current = requireRow(before.data, before.error, 'The project invitation could not be loaded.');
        if (current.invited_by !== user.id || current.accepted_at || current.revoked_at || Date.parse(text(current, 'expires_at')) <= this.now().getTime()) {
          throw conflict('Only a pending, unexpired invitation for this project can be delivered again.');
        }
        const { data, error } = await client.rpc('rotate_mingle_project_invitation', { p_invitation_id: invitationId, p_token_hash: tokenHash });
        rpcObject(data, error, 'The project invitation could not be prepared for delivery.');
        const attempt = await this.deliver(client, invitationId, token);
        const delivery = { status: attempt.status, message: attempt.message };
        const invitation: ProjectInvitationCreateResult['invitation'] = {
          id: text(current, 'id'), email: text(current, 'email'), role: current.role === 'admin' ? 'admin' : 'member',
          status: 'pending', expiresAt: text(current, 'expires_at'),
        };
        this.options.store.touch();
        return { invitation, delivery, ...(delivery.status === 'sent' ? {} : { joinUrl: this.makeJoinUrl(token, attempt.joinUrlBase) }) };
      });
    });
  }

  revokeInvitation(projectId: string, invitationId: string): Promise<{ ok: true }> {
    return this.runTracked(async () => {
      const project = this.localProject(projectId);
      const binding = await this.withClient(async (_client, user) => this.mapping(project.id, user.id));
      if (!binding) throw notFound('Project collaboration has not been set up.');
      await this.withClient(async (client) => {
        const current = await client.from('mingle_project_invitations').select('id')
          .eq('id', invitationId).eq('team_id', binding.teamId).eq('shared_project_id', binding.sharedProjectId).maybeSingle();
        if (current.error) failCloud(current.error, 'The project invitation could not be checked.');
        if (!current.data) throw notFound('Project invitation not found.');
        const { data, error } = await client.rpc('revoke_mingle_project_invitation', { p_invitation_id: invitationId });
        if (error) failCloud(error, 'The project invitation could not be revoked.');
        if (data !== true) throw new HttpError(502, 'The invitation service did not confirm revocation.');
      });
      this.options.store.touch();
      return { ok: true };
    });
  }

  previewInvitation(input: { token: string }): Promise<ProjectInvitationPreview> {
    return this.runTracked(async () => {
      const parsed = PreviewProjectInvitationSchema.parse(input);
      const hash = this.tokenHash(parsed.token);
      return this.withClient(async (client, user) => {
        if (!user.email || !user.email_confirmed_at) throw new HttpError(403, 'A verified Mingle account email is required to join this project.');
        const { data, error } = await client.rpc('preview_mingle_project_invitation', { p_token_hash: hash });
        const row = rpcObject(data, error, 'The invitation could not be previewed.');
        if (String(row.email).toLowerCase() !== user.email.toLowerCase()) throw new HttpError(404, 'The invitation is invalid or unavailable.');
        return {
          invitationId: text(row, 'invitation_id'), projectName: text(row, 'project_name'),
          repositoryUrl: normalizeRepositoryUrl(text(row, 'repository_url')).url,
          email: text(row, 'email'), expiresAt: text(row, 'expires_at'), role: row.role === 'admin' ? 'admin' : 'member',
        };
      });
    });
  }

  private requestedAgents(input: JoinProjectInvitationInput): InvitationAgent[] {
    return input.agents ?? (input.agent ? [input.agent] : []);
  }

  private async validateAgents(inputs: InvitationAgent[]): Promise<InvitationAgent[]> {
    const providers = await this.options.providers.list();
    return inputs.map((input) => {
      if (!REMOTE_ROSTER_PROVIDERS.has(input.provider)) {
        throw new HttpError(400, 'Choose Claude, Codex, or OpenCode so the project leader can see this agent in the existing team roster.');
      }
      const info = providers.find((candidate) => candidate.id === input.provider);
      if (!info?.available) throw new HttpError(409, `${input.provider} is not currently available on this device. Refresh Providers and choose an available model.`);
      const model = info.models.find((candidate) => candidate.id === input.model || candidate.aliases?.includes(input.model));
      if (!model) throw new HttpError(400, 'Choose a model from the current provider catalog before joining the project.');
      const resolved = resolveRunConfig(info, { provider: input.provider, model: input.model, effort: input.effort, policy: input.policy }, { effort: true, policy: true });
      return { provider: input.provider, model: input.model, effort: resolved.effort, policy: resolved.policy };
    });
  }

  joinInvitation(input: JoinProjectInvitationInput): Promise<ProjectInvitationJoinResult> {
    const parsed = JoinProjectInvitationSchema.parse(input);
    const key = this.tokenHash(parsed.token);
    const intent = JSON.stringify({ localProjectId: parsed.localProjectId, agents: this.requestedAgents(parsed) });
    const existingFlight = this.joinFlights.get(key);
    if (existingFlight) {
      if (existingFlight.intent !== intent) return Promise.reject(conflict('A join for this invitation is already in progress with different project or agent settings.'));
      return existingFlight.promise;
    }
    const scheduled = this.joinQueue.then(() => this.performJoin(parsed));
    this.joinQueue = scheduled.then(() => undefined, () => undefined);
    const promise = this.runTracked(() => scheduled);
    this.joinFlights.set(key, { intent, promise });
    void promise.finally(() => {
      if (this.joinFlights.get(key)?.promise === promise) this.joinFlights.delete(key);
    }).catch(() => undefined);
    return promise;
  }

  private async performJoin(parsed: JoinProjectInvitationInput): Promise<ProjectInvitationJoinResult> {
      const { project: localProject, repository: localRepository } = await this.repository(parsed.localProjectId);
      const [preview, agents] = await Promise.all([this.previewInvitation({ token: parsed.token }), this.validateAgents(this.requestedAgents(parsed))]);
      const invitedRepository = normalizeRepositoryUrl(preview.repositoryUrl);
      if (localRepository.identity !== invitedRepository.identity) {
        throw new HttpError(409, 'Select the invited repository checkout or clone the repository URL shown in the invitation before joining.');
      }
      const tokenHash = this.tokenHash(parsed.token);
      const accepted = await this.withClient(async (client, user) => {
        if (!user.email || !user.email_confirmed_at || user.email.toLowerCase() !== preview.email.toLowerCase()) {
          throw new HttpError(403, 'Sign in with the exact verified email address that received this invitation.');
        }
        const { data, error } = await client.rpc('accept_mingle_project_invitation', { p_token_hash: tokenHash });
        const row = rpcObject(data, error, 'The project invitation could not be accepted.');
        if (String(row.email).toLowerCase() !== user.email.toLowerCase()) throw new HttpError(404, 'The invitation is invalid or unavailable.');
        const metadata = user.user_metadata ?? {};
        const displayName = [metadata.full_name, metadata.name, metadata.given_name]
          .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
          ?.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').split(/\s+/)[0]
          ?? user.email?.split('@')[0]?.trim()
          ?? 'Teammate';
        return { row, userId: user.id, displayName: displayName.slice(0, 60) || 'Teammate' };
      });
      const teamId = text(accepted.row, 'team_id');
      const sharedProjectId = text(accepted.row, 'shared_project_id');
      const invitationId = text(accepted.row, 'invitation_id');
      const device = await this.options.distributed.transport.register({ teamId, name: 'Mingle desktop' });

      const joinIdentity = [accepted.userId, device.id, localProject.id, teamId, sharedProjectId] as const;
      const existingSessions = () => this.options.store.db.prepare(`SELECT ordinal,session_id,provider,model,effort
        FROM mingle_project_collaboration_join_agents WHERE account_id=? AND device_id=? AND local_project_id=? AND team_id=? AND shared_project_id=? ORDER BY ordinal`)
        .all(...joinIdentity) as Row[];
      const checkedExistingSessions = (requireComplete = true) => {
        const saved = existingSessions();
        if ((requireComplete && saved.length !== agents.length) || saved.some((row) => {
          const index = Number(row.ordinal);
          return !Number.isInteger(index) || index < 0 || index >= agents.length
            || row.provider !== agents[index]!.provider || row.model !== agents[index]!.model || row.effort !== agents[index]!.effort;
        })) {
          throw conflict('This project was already joined on this device with different agent settings. Continue with the existing agents or use the same configuration.');
        }
        const sessions: Array<Awaited<ReturnType<WorkspaceService['createSession']>> | undefined> = Array(agents.length).fill(undefined);
        for (const row of saved) {
          const index = Number(row.ordinal);
          const sessionId = text(row, 'session_id');
          const session = this.options.store.getSession(sessionId);
          if (!session || session.provider !== agents[index]!.provider || session.model !== agents[index]!.model
            || session.effort !== agents[index]!.effort || session.policy !== agents[index]!.policy) {
            throw conflict('An initial agent already exists for this invitation with different settings.');
          }
          sessions[index] = session;
        }
        return sessions;
      };
      const existingInvitation = this.options.store.db.prepare('SELECT invitation_id FROM mingle_project_collaboration_joins WHERE invitation_id=?').get(invitationId);
      const priorSessionIds = existingSessions();
      const completedProjectJoin = this.options.store.db.prepare(`SELECT invitation_id FROM mingle_project_collaboration_joins
        WHERE account_id=? AND device_id=? AND local_project_id=? AND team_id=? AND shared_project_id=? LIMIT 1`).get(...joinIdentity);
      if (existingInvitation) {
        const sessionIds = checkedExistingSessions().map((session) => session!.id);
        return { projectId: localProject.id, sessionId: sessionIds[0]!, sessionIds, teamId, sharedProjectId, alreadyJoined: true };
      }
      if (priorSessionIds.length && completedProjectJoin) {
        const sessionIds = checkedExistingSessions().map((session) => session!.id);
        await this.completeAndBindEnrollment({ invitationId, teamId, sharedProjectId, localProjectId: localProject.id, ownerId: accepted.userId, device });
        return { projectId: localProject.id, sessionId: sessionIds[0]!, sessionIds, teamId, sharedProjectId, alreadyJoined: true };
      }
      await this.completeAndBindEnrollment({ invitationId, teamId, sharedProjectId, localProjectId: localProject.id, ownerId: accepted.userId, device });

      const stableAgentKey = createHash('sha256').update([accepted.userId, device.id, localProject.id, teamId, sharedProjectId].join(':')).digest('hex').slice(0, 12);
      const sessions = checkedExistingSessions(false);
      let alreadyJoined = priorSessionIds.length > 0;
      const insertAgent = this.options.store.db.prepare(`INSERT OR IGNORE INTO mingle_project_collaboration_join_agents
        (account_id,device_id,local_project_id,team_id,shared_project_id,ordinal,session_id,provider,model,effort,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const [index, agent] of agents.entries()) {
        if (!sessions[index]) {
          // Older releases created hashed names. Keep this narrowly-scoped migration fallback,
          // but use persisted join-agent session IDs for all current retry handling.
          const legacyName = index === 0 ? `Teammate agent ${stableAgentKey}` : `Teammate agent ${stableAgentKey} ${index + 1}`;
          let session = this.options.store.listSessions(localProject.id).find((candidate) => candidate.name === legacyName);
          if (session) {
            if (session.provider !== agent.provider || session.model !== agent.model || session.effort !== agent.effort || session.policy !== agent.policy) {
              throw conflict('An initial agent already exists for this invitation with different settings.');
            }
            alreadyJoined = true;
          } else {
            const suffix = index === 0 ? '' : ` ${index + 1}`;
            session = await this.options.workspace.createSession({
              projectId: localProject.id, name: `${accepted.displayName}'s ${PROVIDER_DISPLAY_NAMES[agent.provider]}${suffix}`.slice(0, 100),
              provider: agent.provider, model: agent.model, effort: agent.effort, policy: agent.policy,
            });
          }
          sessions[index] = session;
          const at = this.now().toISOString();
          this.options.store.tx(() => insertAgent.run(...joinIdentity, index, session!.id,
            agent.provider, agent.model, agent.effort, at));
        }
      }
      const savedSessions = checkedExistingSessions();
      if (savedSessions.some((session, index) => session!.id !== sessions[index]!.id)) {
        throw conflict('A matching project join was completed concurrently. Refresh and continue with its existing agents.');
      }
      const resolvedSessions = savedSessions as Array<Awaited<ReturnType<WorkspaceService['createSession']>>>;
      const currentRoster = await this.options.distributed.execution.snapshot(teamId);
      const publishedSessionIds = currentRoster.agents
        .filter((candidate) => candidate.sharedProjectId === sharedProjectId && candidate.deviceId === device.id
          && candidate.ownerId === accepted.userId && !resolvedSessions.some((session) => candidate.sessionId === session.id))
        .map((candidate) => candidate.sessionId);
      const sessionIds = [...new Set([...publishedSessionIds, ...resolvedSessions.map((session) => session.id)])];
      await this.options.distributed.execution.publishAgents({ teamId, sharedProjectId, sessionIds });
      const at = this.now().toISOString();
      try {
        this.options.store.tx(() => {
          this.options.store.db.prepare(`INSERT INTO mingle_project_collaboration_joins
          (invitation_id,account_id,device_id,local_project_id,team_id,shared_project_id,session_id,provider,model,effort,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(invitationId, accepted.userId, device.id, localProject.id, teamId,
          sharedProjectId, resolvedSessions[0]!.id, agents[0]!.provider, agents[0]!.model, agents[0]!.effort, at);
        });
      } catch (error) {
        const saved = existingSessions();
        if (!saved.length) throw error;
        const savedSessionIds = checkedExistingSessions().map((session) => session!.id);
        return { projectId: localProject.id, sessionId: savedSessionIds[0]!, sessionIds: savedSessionIds, teamId, sharedProjectId, alreadyJoined: true };
      }
      this.options.store.touch();
      const sessionIdsCreated = resolvedSessions.map((session) => session.id);
      return { projectId: localProject.id, sessionId: sessionIdsCreated[0]!, sessionIds: sessionIdsCreated, teamId, sharedProjectId, alreadyJoined: alreadyJoined || accepted.row.already_accepted === true };
  }

  private async completeAndBindEnrollment(input: {
    invitationId: string;
    teamId: string;
    sharedProjectId: string;
    localProjectId: string;
    ownerId: string;
    device: { id: string; fingerprint: string };
  }): Promise<void> {
    const roster = await this.options.distributed.execution.snapshot(input.teamId);
    const existingBinding = roster.bindings.find((row) => row.sharedProjectId === input.sharedProjectId
      && row.deviceId === input.device.id && row.ownerId === input.ownerId);
    if (existingBinding && existingBinding.localProjectId !== input.localProjectId) {
      throw conflict('This invitation is already bound to a different local checkout on this device. Select that checkout to continue.');
    }
    await this.withClient(async (client) => {
      const { data, error } = await client.rpc('complete_mingle_project_invitation_enrollment', {
        p_invitation_id: input.invitationId,
        p_invitee_device_id: input.device.id,
        p_invitee_fingerprint: input.device.fingerprint,
      });
      if (error) failCloud(error, 'The invitation-bound device enrollment could not be completed.');
      if (data !== true) throw new HttpError(502, 'The invitation service did not confirm device enrollment.');
    });
    await this.options.distributed.transport.sync();
    await this.options.distributed.bindProject({
      teamId: input.teamId, sharedProjectId: input.sharedProjectId, localProjectId: input.localProjectId,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
  }
}
