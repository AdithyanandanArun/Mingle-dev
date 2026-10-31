import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  CreateGroupSchema, AddGroupAgentSchema, UpdateGroupSchema, SendGroupMessageSchema, RepositoryCommitSchema, RepositoryPushSchema, RepositoryBranchSchema, RepositoryPullRequestSchema, BrowserConnectSchema, BrowserSignInSchema, BrowserActionSchema, ApprovalDecisionSchema, ConversationIdSchema, ImportConversationSchema, ProviderSchema, CloneProjectSchema, NewProjectSchema, CreateProjectSchema, CreateSessionSchema, CreateTaskSchema, HandoffSchema, SendMessageSchema, UpdateProjectSchema, UpdateSessionSchema, UpdateSettingsSchema, UpdateTaskSchema, EditSessionPlanSchema, UserInputAnswersSchema, StartSubagentSchema,
  RecoveryActionRequestSchema, InitializeGitSchema,
} from '@mingle/contracts';
import { BrowserImportSchema } from '@mingle/contracts';
import type { Bootstrap, Session, SessionUsage } from '@mingle/contracts';
import { gitStatus } from './git.ts';
import type { Hub } from './hub.ts';
import { listDirectory, readTextFile, searchFiles, writeTextFile } from './paths.ts';
import type { ProviderService } from './provider-service.ts';
import type { SessionRuntime } from './runtime.ts';
import type { Store } from './store.ts';
import type { TaskService } from './tasks.ts';
import type { HandoffService } from './handoffs.ts';
import type { WorkspaceService } from './workspace.ts';
import type { ServerConfig } from './config.ts';
import type { TerminalManager } from './terminal.ts';
import { HttpError, badRequest, conflict, notFound, nowIso } from './util.ts';
import { resolveRunConfig } from './session-config.ts';
import type { ImportService } from './imports.ts';
import { defaultModel } from './provider-config.ts';
import type { DirectoryService } from './directories.ts';
import type { ProjectSources } from './project-sources.ts';
import type { ProjectIntelligenceService } from './project-intelligence/service.ts';
import type { RepositoryService } from './repository/service.ts';
import type { GroupService } from './groups/service.ts';
import type { BrowserService } from './browser/service.ts';
import { antigravityInstallState, startAntigravityInstall } from './antigravity-install.ts';
import { antigravityAuthState, cancelAntigravityAuth, startAntigravityAuth } from './antigravity-auth.ts';
import type { AttachmentService } from './attachments/service.ts';
import type { AccountService } from './account/service.ts';
import type { RecoveryService } from './recovery/service.ts';
import type { DelegatedSubagentService } from './delegated-subagents.ts';
import { AccountConnectionSchema, SaveAccountPreferencesSchema } from '@mingle/contracts';
import { ATTACHMENT_LIMITS, NativeActionCatalogQuerySchema, nativeActionCommands, nativeActionSkills, unsupportedActionNotes } from '@mingle/contracts';
import type { DistributedWorkspaceService } from './distributed/service.ts';
import { registerDistributedRoutes } from './distributed/routes.ts';
import type { ProjectCollaborationService } from './project-collaboration/service.ts';
import { registerProjectCollaborationRoutes } from './project-collaboration/routes.ts';
import type { TeamChatService } from './team-chat/service.ts';
import { registerTeamChatRoutes } from './team-chat/routes.ts';
import type { TeamOrchestrationSubsystem } from './team-orchestration/index.ts';
import { buildProgressBoard } from './progress-board.ts';
import { ProgressBoardResponseSchema } from '@mingle/contracts';

export interface Services {
  distributed: DistributedWorkspaceService;
  projectCollaboration: ProjectCollaborationService;
  teamChat: TeamChatService;
  teamOrchestration: TeamOrchestrationSubsystem;
  account: AccountService;
  setupSignal: AbortSignal;
  config: ServerConfig; store: Store; hub: Hub; workspace: WorkspaceService; runtime: SessionRuntime; tasks: TaskService; handoffs: HandoffService;
  groups: GroupService; attachments: AttachmentService; recovery: RecoveryService; intelligence: ProjectIntelligenceService; repository: RepositoryService; browser: BrowserService; providers: ProviderService; imports: ImportService; directories: DirectoryService; projectSources: ProjectSources; terminals: TerminalManager; startedAt: number; getPort: () => number;
  subagents: DelegatedSubagentService;
}

export class Reply {
  constructor(readonly status: number, readonly body: unknown) {}
}

export interface Ctx { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string>; body<T>(schema: z.ZodType<T>): Promise<T> }
type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
interface Route { method: string; regex: RegExp; keys: string[]; handler: Handler }

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ID = /^[A-Za-z0-9_.-]{1,100}$/;

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = pattern.replace(/:([A-Za-z]+)/g, (_m, key: string) => { keys.push(key); return '([^/]+)'; });
  return { regex: new RegExp(`^${source}$`), keys };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw badRequest(`${where}${issue?.message ?? 'Invalid request'}`);
}

const executable = z.string().max(4096).refine((v) => !/[\0\r\n]/.test(v), 'Executable path contains control characters');
const SettingsPatch = UpdateSettingsSchema.extend({ claudeExecutable: executable.optional(), codexExecutable: executable.optional(), antigravityExecutable: executable.optional(), opencodeExecutable: executable.optional(), browserExecutable: executable.optional(), browserCdpEndpoint: z.string().max(2048).refine((value) => {
  if (!value) return true;
  try { const url = new URL(value); return ['http:', 'ws:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && Boolean(url.port) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}, 'Use a loopback HTTP or WebSocket endpoint with an explicit port').optional() });
const MessagesQuery = z.object({ limit: z.coerce.number().int().min(1).max(2000).optional(), before: z.string().max(100).optional() });
const EventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0), projectId: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(5000).optional() });
const WriteFile = z.object({ content: z.string() });
const ImportsQuery = z.object({ provider: ProviderSchema, projectId: z.string().min(1).max(100).optional(), cursor: z.string().min(1).max(4096).optional() }).strict();
const DirectoriesQuery = z.object({ path: z.string().min(1).max(4096).optional(), query: z.string().max(200).optional(), hidden: z.enum(['true', 'false']).optional() }).strict();
const RevealDirectory = z.object({ path: z.string().min(1).max(4096) }).strict();

function validateSessionAttachmentSupport(s: Services, session: Session, attachments: readonly { kind: string; size: number }[], content: string): void {
  if (attachments.some((row) => row.kind === 'image')) {
    const info = s.providers.cached()?.find((row) => row.id === session.provider);
    const model = info?.models.find((candidate) => candidate.id === session.model || candidate.aliases?.includes(session.model));
    const imagesSupported = model?.inputModalities ? model.inputModalities.includes('image') : info?.promptCapabilities?.image === true;
    if (!imagesSupported) throw badRequest(`${session.provider} has not reported image input for this session, so no message was sent.`);
    if (session.provider === 'claude' && attachments.some((row) => row.kind === 'image' && row.size > ATTACHMENT_LIMITS.claudeImageBytes)) {
      throw badRequest('Claude image attachments are limited to 5 MiB each. Remove the large image or resize it before sending.');
    }
  }
  if (session.provider === 'opencode' && attachments.length && /^\s*\/[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\s|$)/.test(content)) {
    throw badRequest('OpenCode native slash commands cannot carry attachments. Remove the attachments or send a regular message.');
  }
}

function resolveSkillsFor(s: Services, session: Session, skillIds: string[]): (() => Promise<import('@mingle/contracts').ProviderSkill[]>) | undefined {
  if (!skillIds.length) return undefined;
  return async () => {
    const catalog = await s.providers.catalog(session, true);
    const skills = skillIds.map((key) => {
      const skill = catalog.skills.find((row) => row.id === key && row.enabled);
      if (!skill) throw badRequest('A selected skill is no longer available. Refresh the skill picker and select it again.');
      return skill;
    });
    const current = s.store.getSession(session.id);
    if (!current) throw notFound('Session not found');
    if (s.groups.forSession(session.id)) throw conflict('This session joined a group while loading skills. Send through its group conversation.');
    if (current.provider !== session.provider || current.model !== session.model || current.worktreePath !== session.worktreePath) {
      throw conflict('Session settings changed while loading skills. Send the message again.');
    }
    return skills;
  };
}

export function buildRouter(s: Services) {
  const routes: Route[] = [];
  const add = (method: string, pattern: string, handler: Handler) => routes.push({ method, ...compile(pattern), handler });
  registerDistributedRoutes(add, s.distributed);
  registerProjectCollaborationRoutes(add, s.projectCollaboration);
  registerTeamChatRoutes(add, s.teamChat);
  s.teamOrchestration.routes(add);
  const touch = () => s.store.touch();
  const param = (ctx: Ctx, key: string) => {
    const value = ctx.params[key]!;
    if (!ID.test(value)) throw notFound('Not found');
    return value;
  };

  const browserSession = (ctx: Ctx) => {
    const id = param(ctx, 'id');
    if (!s.store.getSession(id)) throw notFound('Session not found');
    return id;
  };
  const recoverySession = (ctx: Ctx) => {
    const id = param(ctx, 'id');
    if (!s.store.getSession(id)) throw notFound('Session not found');
    return id;
  };
  const compactBody = z.object({ operationId: z.string().trim().min(1).max(100).optional() }).strict();
  const compactInterruptBody = z.object({ operationId: z.string().trim().min(1).max(100) }).strict();
  const checkpointBody = z.object({ reason: z.string().trim().min(1).max(200), runId: z.string().min(1).max(100).optional() }).strict();
  const emptyBrowserBody = z.object({}).strict();
  add('GET', '/api/account', () => s.account.snapshot());
  add('PUT', '/api/account/connection', async (ctx) => s.account.configure(await ctx.body(AccountConnectionSchema)));
  add('POST', '/api/account/sign-in', async (ctx) => { await ctx.body(emptyBrowserBody); return s.account.startSignIn(); });
  add('DELETE', '/api/account/sign-in', async (ctx) => { await ctx.body(emptyBrowserBody); return s.account.cancelSignIn(); });
  add('POST', '/api/account/sign-out', async (ctx) => { await ctx.body(emptyBrowserBody); return s.account.signOut(); });
  add('POST', '/api/account/storage/retry', async (ctx) => { await ctx.body(emptyBrowserBody); return s.account.retryStorage(); });
  add('GET', '/api/account/preferences', () => s.account.loadPreferences());
  add('PUT', '/api/account/preferences', async (ctx) => {
    const body = await ctx.body(SaveAccountPreferencesSchema);
    return s.account.savePreferences(body.preferences, body.expectedRevision);
  });
  add('GET', '/api/browser/discovery', () => s.browser.discovery());
  add('POST', '/api/browser/install', async (ctx) => { await ctx.body(emptyBrowserBody); return s.browser.install(); });
  add('POST', '/api/browser/sandbox/fix', async (ctx) => { await ctx.body(emptyBrowserBody); return s.browser.fixSandbox(); });
  add('GET', '/api/sessions/:id/browser', (ctx) => s.browser.status(browserSession(ctx)));
  add('POST', '/api/sessions/:id/browser/connect', async (ctx) => s.browser.connect(browserSession(ctx), await ctx.body(BrowserConnectSchema)));
  add('GET', '/api/browser/import-sources', () => s.browser.importSources());
  add('POST', '/api/sessions/:id/browser/import', async (ctx) => s.browser.importCookies(browserSession(ctx), await ctx.body(BrowserImportSchema)));
  add('POST', '/api/sessions/:id/browser/sign-in', async (ctx) => s.browser.signIn(browserSession(ctx), await ctx.body(BrowserSignInSchema)));
  add('POST', '/api/sessions/:id/browser/sign-in/finish', async (ctx) => { const id=browserSession(ctx); await ctx.body(emptyBrowserBody); return s.browser.finishSignIn(id); });
  add('POST', '/api/sessions/:id/browser/disconnect', async (ctx) => { const id = browserSession(ctx); await ctx.body(emptyBrowserBody); return s.browser.disconnect(id); });
  add('POST', '/api/sessions/:id/browser/tabs', async (ctx) => s.browser.open(browserSession(ctx), (await ctx.body(z.object({ url: z.string().min(1).max(4096).optional() }).strict())).url));
  add('GET', '/api/sessions/:id/browser/tabs/:tabId/snapshot', (ctx) => {
    const query = parse(z.object({ image: z.enum(['true', 'false']).optional() }).strict(), Object.fromEntries(ctx.url.searchParams));
    return s.browser.snapshot(browserSession(ctx), param(ctx, 'tabId'), query.image === 'true');
  });
  add('POST', '/api/sessions/:id/browser/tabs/:tabId/action', async (ctx) => {
    const id = browserSession(ctx);
    const body = await ctx.body(z.object({ action: BrowserActionSchema, clientId: z.string().min(1).max(100) }).strict());
    return s.browser.act(id, param(ctx, 'tabId'), body.action, { kind: 'human', id: body.clientId });
  });
  add('POST', '/api/sessions/:id/browser/tabs/:tabId/control', async (ctx) => {
    const id = browserSession(ctx);
    const body = await ctx.body(z.object({ owner: z.enum(['human', 'agent']), clientId: z.string().min(1).max(100) }).strict());
    return s.browser.control(id, param(ctx, 'tabId'), body.owner, body.clientId);
  });

  add('GET', '/api/health', () => {
    const counts = s.store.counts();
    const cached = s.providers.cached();
    return {
      ok: true, version: s.config.version, node: process.version, startedAt: new Date(s.startedAt).toISOString(), uptimeSeconds: Math.round((Date.now() - s.startedAt) / 1000),
      host: s.config.host, port: s.getPort(), dataDir: s.config.dataDir,
      database: { ok: true, schemaVersion: s.store.schemaVersion(), ...counts },
      runtime: { activeRuns: s.runtime.activeCount(), terminals: s.terminals.count, websocketClients: s.hub.clientCount },
      providers: cached ? cached.map((p) => ({ id: p.id, available: p.available, version: p.version })) : null,
      web: { served: Boolean(s.config.webDistDir) },
    };
  });

  add('GET', '/api/bootstrap', async () => {
    const providers = await s.providers.snapshot();
    const runs = s.store.bootstrapRuns();
    const body: Bootstrap = {
      groups: s.groups.snapshots(), runs, toolCalls: s.store.bootstrapToolCalls(runs.map((run) => run.id)),
      delegatedSubagents: s.subagents.list(),
      projects: s.store.listProjects(), sessions: s.store.listSessions().map((session) => ({ ...session, steerable: s.runtime.isSteerable(session.id) })), messages: s.store.bootstrapMessages(300), queuedMessages: s.store.listSessions().flatMap((session) => s.store.listQueuedMessages(session.id)), tasks: s.store.listTasks(),
      events: s.store.recentEvents(500), approvals: s.store.bootstrapApprovals(50), plans: s.store.bootstrapPlans(), questions: s.store.bootstrapQuestions(), providers, settings: s.store.getSettings(), version: s.config.version,
    };
    return body;
  });

  add('GET', '/api/runs/:id/tools', (ctx) => {
    const run = s.store.getRun(param(ctx, 'id'));
    if (!run || !s.store.getSession(run.sessionId)) throw notFound('Run not found');
    return s.store.listRunTools(run.id);
  });
  add('GET', '/api/runs/:id/changes', (ctx) => {
    const run = s.store.getRun(param(ctx, 'id'));
    if (!run || !s.store.getSession(run.sessionId)) throw notFound('Run not found');
    if (run.status === 'running') throw conflict('Changes are saved after the run finishes');
    const changes = s.store.getRunChanges(run.id);
    if (!changes) throw notFound('This run has no saved change snapshot');
    return changes;
  });
  add('GET', '/api/tool-calls/:id', (ctx) => {
    const call = s.store.getToolCall(param(ctx, 'id'));
    if (!call || !s.store.getSession(call.sessionId)) throw notFound('Tool call not found');
    return call;
  });

  add('GET', '/api/projects', () => s.store.listProjects());
  add('GET', '/api/directories', (ctx) => {
    const query = parse(DirectoriesQuery, Object.fromEntries(ctx.url.searchParams));
    return s.directories.list(query.path, query.query, query.hidden === 'true');
  });
  add('POST', '/api/directories/reveal', async (ctx) => s.directories.reveal((await ctx.body(RevealDirectory)).path));
  add('POST', '/api/projects/new', async (ctx) => new Reply(201, await s.projectSources.create(await ctx.body(NewProjectSchema))));
  add('POST', '/api/projects/clone', async (ctx) => new Reply(201, await s.projectSources.clone(await ctx.body(CloneProjectSchema))));
  add('GET', '/api/imports', (ctx) => {
    const query = parse(ImportsQuery, Object.fromEntries(ctx.url.searchParams));
    return s.imports.list(query.provider, query.projectId, query.cursor);
  });
  add('GET', '/api/imports/:provider/:id', (ctx) => s.imports.read(parse(ProviderSchema, ctx.params.provider), parse(ConversationIdSchema, ctx.params.id)));
  add('POST', '/api/imports', async (ctx) => {
    const input = await ctx.body(ImportConversationSchema);
    const result = await s.imports.import(input.provider, input.conversationId);
    return new Reply(result.alreadyImported ? 200 : 201, result);
  });
  add('POST', '/api/projects', async (ctx) => {
    const { project, created } = await s.workspace.createProject(await ctx.body(CreateProjectSchema));
    return new Reply(created ? 201 : 200, project);
  });
  add('GET', '/api/projects/:id/files', async (ctx) => {
    const scope = s.workspace.resolveScope(param(ctx, 'id'), ctx.url.searchParams.get('sessionId') ?? undefined);
    return listDirectory(scope.root, ctx.url.searchParams.get('path'));
  });
  add('GET', '/api/projects/:id/files/search', (ctx) => {
    const scope = s.workspace.resolveScope(param(ctx, 'id'), ctx.url.searchParams.get('sessionId') ?? undefined);
    const query = ctx.url.searchParams.get('query') ?? '';
    if (query.length > 100) throw badRequest('File search query is too long.');
    return searchFiles(scope.root, query);
  });
  add('GET', '/api/projects/:id/file', async (ctx) => {
    const scope = s.workspace.resolveScope(param(ctx, 'id'), ctx.url.searchParams.get('sessionId') ?? undefined);
    const rel = ctx.url.searchParams.get('path');
    if (!rel) throw badRequest('path is required');
    return readTextFile(scope.root, rel);
  });
  add('PUT', '/api/projects/:id/file', async (ctx) => {
    const scope = s.workspace.resolveScope(param(ctx, 'id'), ctx.url.searchParams.get('sessionId') ?? undefined);
    const rel = ctx.url.searchParams.get('path');
    if (!rel) throw badRequest('path is required');
    const { content } = await ctx.body(WriteFile);
    const saved = await writeTextFile(scope.root, rel, content);
    s.store.recordEvent({ projectId: scope.project.id, sessionId: scope.session?.id ?? null, type: 'file.saved', summary: `File saved: ${saved.path}`, payload: { path: saved.path, bytes: Buffer.byteLength(content) } });
    return saved;
  });
  const repositoryQuery = z.object({ sessionId: z.string().min(1).max(100).optional(), refresh: z.enum(['true', 'false']).optional() }).strict();
  add('GET', '/api/projects/:id/repository', (ctx) => {
    const query = parse(repositoryQuery, Object.fromEntries(ctx.url.searchParams));
    return s.repository.state(param(ctx, 'id'), query.sessionId);
  });
  add('GET', '/api/projects/:id/github', (ctx) => {
    const query = parse(repositoryQuery, Object.fromEntries(ctx.url.searchParams));
    return s.repository.github(param(ctx, 'id'), query.sessionId, query.refresh === 'true');
  });
  add('POST', '/api/projects/:id/git/init', async (ctx) => s.repository.initializeGit(param(ctx, 'id'), await ctx.body(InitializeGitSchema)));
  add('POST', '/api/projects/:id/repository/commit', async (ctx) => s.repository.commit(param(ctx, 'id'), await ctx.body(RepositoryCommitSchema)));
  add('POST', '/api/projects/:id/repository/push', async (ctx) => s.repository.push(param(ctx, 'id'), await ctx.body(RepositoryPushSchema)));
  add('POST', '/api/projects/:id/repository/branch', async (ctx) => s.repository.branch(param(ctx, 'id'), await ctx.body(RepositoryBranchSchema)));
  add('POST', '/api/projects/:id/repository/pull-request', async (ctx) => s.repository.pullRequest(param(ctx, 'id'), await ctx.body(RepositoryPullRequestSchema)));
  add('GET', '/api/projects/:id/context', (ctx) => s.intelligence.context(param(ctx, 'id')));
  add('POST', '/api/projects/:id/context/refresh', async (ctx) => {
    await ctx.body(z.object({}).strict());
    return s.intelligence.refresh(param(ctx, 'id'));
  });
  add('GET', '/api/projects/:id/git', async (ctx) => {
    const scope = s.workspace.resolveScope(param(ctx, 'id'), ctx.url.searchParams.get('sessionId') ?? undefined);
    return gitStatus(scope.root);
  });

  const emptyGroupBody = z.object({}).strict();
  add('POST', '/api/groups', async (ctx) => new Reply(201, await s.groups.create(await ctx.body(CreateGroupSchema))));
  add('DELETE', '/api/groups/:id', async (ctx) => {
    await ctx.body(emptyGroupBody);
    const id = param(ctx, 'id');
    const group = s.groups.get(id);
    const sessionIds = [...new Set(group.members.map((member) => member.sessionId))];
    await s.terminals.withSessionsStopped(sessionIds, () => s.groups.delete(id));
    const disconnected = await Promise.allSettled(group.members.map((member) => s.browser.disconnect(member.sessionId)));
    return { ok: true, sessionIds, notices: disconnected.some((result) => result.status === 'rejected') ? ['A browser connection could not be disconnected.'] : [] };
  });
  add('GET', '/api/groups/:id/members/:memberId/catalog', async (ctx) => {
    const query = NativeActionCatalogQuerySchema.parse(Object.fromEntries(ctx.url.searchParams));
    const group = s.groups.get(param(ctx, 'id'));
    const memberId = param(ctx, 'memberId');
    const member = group.members.find((row) => row.id === memberId && !row.removedAt);
    if (!member) throw notFound('Active group agent not found');
    const session = s.store.getSession(member.sessionId);
    if (!session) throw notFound('Agent session not found');
    const catalog = await s.providers.catalog(session, query.refresh === 'true');
    const latestGroup = s.groups.get(group.group.id);
    const latestMember = latestGroup.members.find((row) => row.id === memberId && !row.removedAt);
    const latestSession = latestMember ? s.store.getSession(latestMember.sessionId) : undefined;
    if (!latestMember || !latestSession || latestSession.id !== session.id || latestSession.provider !== session.provider || latestSession.model !== session.model || latestSession.worktreePath !== session.worktreePath) {
      throw conflict('This agent or its settings changed while loading its actions. Refresh the catalog.');
    }
    const info = s.providers.cached()?.find((row) => row.id === session.provider);
    return {
      sessionId: session.id, provider: session.provider, model: session.model,
      commands: nativeActionCommands(session.provider, catalog.commands), skills: nativeActionSkills(session.provider, catalog.skills),
      warnings: catalog.warnings, unsupported: unsupportedActionNotes(session.provider),
      attachments: { images: (() => {
        const model = info?.models.find((candidate) => candidate.id === session.model || candidate.aliases?.includes(session.model));
        return model?.inputModalities ? model.inputModalities.includes('image') : info?.promptCapabilities?.image === true;
      })(), files: true, imageBytes: session.provider === 'claude' ? ATTACHMENT_LIMITS.claudeImageBytes : ATTACHMENT_LIMITS.imageBytes,
        ...(session.provider === 'opencode' ? { note: 'OpenCode native commands cannot carry attachments.' } : {}) },
    };
  });
  add('GET', '/api/groups/:id', (ctx) => s.groups.get(param(ctx, 'id')));
  s.teamChat.setProgressBoardMemberHealthProvider((groupId) => s.groups.getMemberHealth(groupId));
  add('GET', '/api/groups/:id/board', async (ctx) => {
    const groupId = param(ctx, 'id');
    let group;
    try { group = s.groups.get(groupId); }
    catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
    }
    if (group) {
      const board = await buildProgressBoard({ store: s.store, group, memberHealth: s.groups.getMemberHealth(group.group.id) });
      return ProgressBoardResponseSchema.parse({ ...board, source: 'local' });
    }
    const projectId = ctx.url.searchParams.get('projectId');
    if (!projectId || !ID.test(projectId)) throw notFound('Group not found');
    const synced = await s.teamChat.syncedProgressBoard(projectId, groupId);
    return ProgressBoardResponseSchema.parse({ ...synced.board, source: 'host', syncedAt: synced.syncedAt });
  });
  add('PATCH', '/api/groups/:id', async (ctx) => s.groups.update(param(ctx, 'id'), await ctx.body(UpdateGroupSchema)));
  add('POST', '/api/groups/:id/agents', async (ctx) => new Reply(201, await s.groups.addAgent(param(ctx, 'id'), await ctx.body(AddGroupAgentSchema))));
  add('POST', '/api/groups/:id/restore-coordinator', async (ctx) => { await ctx.body(emptyGroupBody); return s.groups.restorePreferredCoordinator(param(ctx, 'id')); });
  add('GET', '/api/groups/:id/coordinator-restore-status', (ctx) => s.groups.coordinatorRestoreStatus(param(ctx, 'id')));
  add('DELETE', '/api/groups/:id/members/:memberId', (ctx) => s.groups.removeMember(param(ctx, 'id'), param(ctx, 'memberId')));
  add('POST', '/api/groups/:id/messages', async (ctx) => new Reply(202, await s.groups.send(param(ctx, 'id'), await ctx.body(SendGroupMessageSchema))));
  add('POST', '/api/groups/:id/pause', async (ctx) => { await ctx.body(emptyGroupBody); return s.groups.pause(param(ctx, 'id')); });
  add('POST', '/api/groups/:id/stop', async (ctx) => { await ctx.body(emptyGroupBody); return s.groups.stop(param(ctx, 'id')); });
  add('POST', '/api/groups/:id/resume', async (ctx) => { await ctx.body(emptyGroupBody); return s.groups.resume(param(ctx, 'id')); });
  add('POST', '/api/groups/:id/members/:memberId/resume', async (ctx) => { await ctx.body(emptyGroupBody); return s.groups.resumeMember(param(ctx, 'id'), param(ctx, 'memberId')); });
  add('POST', '/api/groups/:id/members/:memberId/interrupt', async (ctx) => { await ctx.body(emptyGroupBody); return s.groups.stopMember(param(ctx, 'id'), param(ctx, 'memberId')); });
  add('POST', '/api/groups/:id/recovery', async (ctx) => {
    const groupId = param(ctx, 'id');
    const action = await ctx.body(RecoveryActionRequestSchema);
    return s.groups.recoverAction(groupId, action);
  });

  add('POST', '/api/sessions', async (ctx) => new Reply(201, await s.workspace.createSession(await ctx.body(CreateSessionSchema))));
  add('POST', '/api/sessions/:id/subagents', async (ctx) => new Reply(201, await s.subagents.start(param(ctx,'id'), await ctx.body(StartSubagentSchema), 'user')));
  add('GET', '/api/sessions/:id/subagents', (ctx) => { const id=param(ctx,'id'); if(!s.store.getSession(id))throw notFound('Session not found'); return s.subagents.list(id); });
  add('POST', '/api/subagents/:id/cancel', (ctx) => s.subagents.cancel(param(ctx,'id')));
  add('GET', '/api/sessions/:id/recovery', (ctx) => {
    const id = recoverySession(ctx);
    return { checkpoint: s.recovery.latest(id), failure: s.recovery.failure(id) };
  });
  add('POST', '/api/sessions/:id/checkpoints', async (ctx) => {
    const id = recoverySession(ctx);
    const body = await ctx.body(checkpointBody);
    return new Reply(201, await s.recovery.capture(id, body.reason, body.runId));
  });
  add('POST', '/api/sessions/:id/compact', async (ctx) => {
    const id = recoverySession(ctx);
    const body = await ctx.body(compactBody);
    return s.runtime.compact(id, body.operationId);
  });
  add('POST', '/api/sessions/:id/compact/interrupt', async (ctx) => {
    const id = recoverySession(ctx);
    const body = await ctx.body(compactInterruptBody);
    return { interrupted: s.runtime.interruptCompaction(id, body.operationId) };
  });
  add('PATCH', '/api/projects/:id', async (ctx) => s.workspace.renameProject(param(ctx, 'id'), (await ctx.body(UpdateProjectSchema)).name));
  add('DELETE', '/api/projects/:id', async (ctx) => {
    const id = param(ctx, 'id');
    if (s.terminals.hasProject(id)) throw conflict('Close the project’s terminals before removing it.');
    s.repository.assertProjectAvailable(id);
    const sessions = s.workspace.removeProject(id);
    const closed = await Promise.allSettled(sessions.map((sessionId) => s.browser.disconnect(sessionId)));
    return { ok: true, notices: closed.some((result) => result.status === 'rejected') ? ['The project was removed, but a browser connection could not be closed.'] : [] };
  });
  add('PATCH', '/api/sessions/:id', async (ctx) => {
    const id = param(ctx, 'id');
    let patch = await ctx.body(UpdateSessionSchema);
    const session = s.store.getSession(id);
    if (!session) throw notFound('Session not found');
    if (s.groups.forSession(id) && patch.provider && patch.provider !== session?.provider) throw conflict('Group members retain their provider identity. Add another agent to use a different provider.');
    const providerChanged = patch.provider !== undefined && patch.provider !== session.provider;
    let updated: Session;
    if (providerChanged) {
      if (s.runtime.isActive(id) || session.status === 'running' || session.status === 'waiting') {
        throw conflict('Wait for this run to finish or interrupt it before changing its provider or model.');
      }
      const settings = s.store.getSettings();
      const provider = patch.provider!;
      const model = patch.model ?? defaultModel(provider, settings);
      const resolved = resolveRunConfig(s.providers.cached()?.find((row) => row.id === provider), {
        provider, model, effort: patch.effort ?? session.effort, policy: patch.policy ?? session.policy,
        serviceTier: patch.serviceTier ?? session.serviceTier,
      }, { effort: patch.effort !== undefined, policy: patch.policy !== undefined, serviceTier: patch.serviceTier !== undefined });
      patch = { ...patch, provider, model, effort: resolved.effort, policy: resolved.policy, serviceTier: resolved.serviceTier };
      const hasHistory = s.store.listMessages(id).some((message) => message.role === 'user' || message.role === 'assistant');
      const handoffAt = hasHistory ? nowIso() : null;
      const oldProvider = s.providers.cached()?.find((row) => row.id === session.provider);
      const newProvider = s.providers.cached()?.find((row) => row.id === provider);
      const modelLabel = (providerId: typeof provider, modelId: string) => {
        const info = s.providers.cached()?.find((row) => row.id === providerId);
        return info?.models.find((row) => row.id === modelId || row.aliases?.includes(modelId))?.name ?? modelId;
      };
      updated = s.store.tx(() => {
        const next = s.store.updateSession(id, {
          ...patch, providerSessionId: null,
          handoffFromProvider: hasHistory ? session.provider : null,
          handoffFromModel: hasHistory ? session.model : null,
          handoffPendingAt: handoffAt,
        });
        if (hasHistory) {
          const fromModel = modelLabel(session.provider, session.model);
          const toModel = modelLabel(provider, resolved.model);
          const fromName = oldProvider?.name ?? session.provider;
          const toName = newProvider?.name ?? provider;
          s.store.insertMessage({ sessionId: id, role: 'system', kind: 'info', content: `Switched from ${fromName} (${fromModel}) to ${toName} (${toModel}). Mingle will hand off this conversation's context with your next message. No extra model call; your conversation is passed along with the next message.` });
        }
        s.store.recordEvent({
          projectId: session.projectId, sessionId: id, type: 'session.updated',
          summary: `Session settings updated: ${next.name}`,
          payload: { fields: Object.keys(patch), model: next.model, effort: next.effort, provider: next.provider, ...(hasHistory ? { handoffPending: true, fromProvider: session.provider, toProvider: next.provider } : {}) },
        });
        return next;
      });
    } else {
      updated = s.workspace.updateSession(id, patch);
    }
    if (patch.policy !== undefined && patch.policy !== session?.policy) {
      await s.teamOrchestration.host.sessionPolicyChanged(id);
      return s.store.getSession(id) ?? updated;
    }
    return updated;
  });
  add('DELETE', '/api/sessions/:id', async (ctx) => {
    const id = param(ctx, 'id');
    if (!s.store.getSession(id)) throw notFound('Session not found');
    if (s.groups.forSession(id)) throw conflict('This session belongs to a group. Delete the group from its conversation entry, or remove this agent from the roster to keep the group.');
    await s.terminals.withSessionsStopped([id], () => s.runtime.withSessionsStopped([id], () => s.workspace.archiveSession(id)));
    const disconnected = await Promise.allSettled([s.browser.disconnect(id)]);
    return { ok: true, ...(disconnected.some((result) => result.status === 'rejected') ? { notices: ['The session was deleted, but its browser connection could not be disconnected.'] } : {}) };
  });
  add('GET', '/api/sessions/:id/messages', (ctx) => {
    const id = param(ctx, 'id');
    if (!s.store.getSession(id)) throw notFound('Session not found');
    const query = parse(MessagesQuery, Object.fromEntries(ctx.url.searchParams));
    return s.store.listMessages(id, { limit: query.limit, beforeId: query.before });
  });
  add('GET', '/api/sessions/:id/catalog', (ctx) => {
    const session = s.store.getSession(param(ctx, 'id'));
    if (!session) throw notFound('Session not found');
    return s.providers.catalog(session, ctx.url.searchParams.get('refresh') === 'true');
  });
  add('GET', '/api/sessions/:id/usage', async (ctx) => {
    const session = s.store.getSession(param(ctx, 'id'));
    if (!session) throw notFound('Session not found');
    const usage = await s.providers.usage(session, ctx.url.searchParams.get('refresh') === 'true');
    const latest = s.store.getSession(session.id);
    if (!latest) throw notFound('Session not found');
    if (latest.provider !== session.provider || latest.model !== session.model) throw conflict('The session provider or model changed. Open usage again.');
    const result: SessionUsage = { ...usage, session: { id: latest.id, inputTokens: latest.inputTokens, outputTokens: latest.outputTokens, costUsd: latest.costUsd } };
    return result;
  });
  add('POST', '/api/sessions/:id/messages/:messageId/retry', async (ctx) => {
    await ctx.body(emptyBrowserBody);
    const id = param(ctx, 'id');
    const messageId = param(ctx, 'messageId');
    const session = s.store.getSession(id);
    if (!session) throw notFound('Session not found');
    if (s.groups.forSession(id)) throw conflict('Retry a group delivery through its group recovery controls.');
    const message = s.store.getMessage(messageId);
    if (!message || message.sessionId !== id) throw notFound('Message not found in this session');
    const run = message.runId ? s.store.getRun(message.runId) : undefined;
    if (message.role !== 'user' || !run || run.sessionId !== id || run.userMessageId !== message.id || run.status !== 'failed') {
      throw conflict('Only a failed user message can be retried.');
    }
    if (s.store.latestFailedUserMessage(id)?.id !== message.id) throw conflict('Only the latest failed user message can be retried.');
    if (s.runtime.isActive(id) || session.status === 'running' || session.status === 'waiting') {
      throw conflict('Session already has an active run or provider cleanup is still in progress');
    }

    const sourceAttachments = s.attachments.forOwner('message', message.id);
    validateSessionAttachmentSupport(s, session, sourceAttachments, message.content);
    const attachmentIds = await s.attachments.cloneMessageAttachments(id, message.id);
    const discardClones = async () => { await Promise.all(attachmentIds.map((attachmentId) => s.attachments.discard(attachmentId).catch(() => undefined))); };
    try {
      const latest = s.store.getSession(id);
      if (!latest) throw notFound('Session not found');
      if (latest.provider !== session.provider || latest.model !== session.model || latest.worktreePath !== session.worktreePath) {
        throw conflict('Session settings changed while preparing the retry. Try again with the current session.');
      }
      if (s.groups.forSession(id)) throw conflict('This session joined a group while preparing the retry. Use its group recovery controls.');
      if (s.runtime.isActive(id) || latest.status === 'running' || latest.status === 'waiting') {
        throw conflict('Session already has an active run or provider cleanup is still in progress');
      }
      s.runtime.start(id, message.content, { attachmentIds, contextRefs: message.contextRefs, deferContextResolution: true });
      return new Reply(202, { accepted: true });
    } catch (error) {
      await discardClones();
      throw error;
    }
  });
  add('POST', '/api/sessions/:id/messages', async (ctx) => {
    const id = param(ctx, 'id');
    const { content, intent, skills: selected, attachmentIds, contextRefs } = await ctx.body(SendMessageSchema);
    const session = s.store.getSession(id);
    if (!session) throw notFound('Session not found');
    const group = s.groups.forSession(id);
    if (group) {
      if (intent === 'plan') throw badRequest('Native read-only plan mode is not available for group-delivered turns. Open the member session to plan independently.');
      if (selected?.length) throw badRequest('Select skills in an independent session. Address provider actions directly to one group agent.');
      const member = group.members.find((row) => row.sessionId === id && !row.removedAt);
      if (!member) throw conflict('This agent is no longer in the group. Refresh the conversation.');
      return new Reply(202, await s.groups.send(group.group.id, { content, attachmentIds, contextRefs, ...(id === group.group.anchorSessionId ? {} : { recipients: [member.id] }) }));
    }
    if ((s.runtime.canQueue(id) && session.status === 'running') || session.status === 'waiting') {
      if (session.status === 'waiting') throw conflict('A pending question or approval must be resolved before sending a message.');
      const attachments = s.attachments.validate({ kind: 'session', id }, attachmentIds ?? []);
      validateSessionAttachmentSupport(s, session, attachments, content);
      if (!attachments.length && !selected?.length && intent !== 'plan' && await s.runtime.steer(id, content)) return new Reply(202, { accepted: true, steered: true });
      const queuedId = `queued-${crypto.randomUUID()}`;
      let queued!: import('@mingle/contracts').QueuedMessage;
      s.store.tx(() => {
        if (attachmentIds?.length) s.attachments.claim({ kind: 'session', id }, attachmentIds, 'message', queuedId);
        queued = s.store.enqueueMessage({ id: queuedId, sessionId:id, content, intent, skills:[...new Set(selected ?? [])], attachmentIds:attachmentIds ?? [], contextRefs:contextRefs ?? [] });
      });
      return new Reply(202, { accepted:true, queued });
    }
    const skillIds = [...new Set(selected ?? [])];
    if (intent === 'plan' && skillIds.length) throw badRequest('Native plan generation cannot run provider commands or skills. Send a regular planning prompt instead.');
    if (session.provider === 'claude' && skillIds.length > 1) throw badRequest('Claude supports one explicitly selected skill per message.');
    const resolveSkills = resolveSkillsFor(s, session, skillIds);
    const attachmentRows = s.attachments.validate({ kind: 'session', id }, attachmentIds ?? []);
    validateSessionAttachmentSupport(s, session, attachmentRows, content);
    const latest = s.store.getSession(id);
    if (!latest) throw notFound('Session not found');
    if (s.groups.forSession(id)) throw conflict('This session joined a group while loading skills. Send through its group conversation.');
    if (latest.provider !== session.provider || latest.model !== session.model || latest.worktreePath !== session.worktreePath) throw conflict('Session settings changed while loading skills. Send the message again.');
    for (const ref of contextRefs ?? []) {
      if (ref.kind === 'quote' && (ref.sourceGroupId || ref.sourceSessionId !== id)) throw badRequest('A quoted source must come from this session. Choose text from a message in this conversation.');
      if (ref.kind === 'file' && ref.sourceSessionId !== id) throw badRequest('A file reference must come from this session worktree. Choose the file again.');
    }
    s.runtime.start(id, content, { intent, attachmentIds, contextRefs, deferContextResolution: true, resolveSkills });
    return new Reply(202, { accepted: true });
  });
  add('GET', '/api/sessions/:id/queue', (ctx) => { const id=param(ctx,'id'); if(!s.store.getSession(id)) throw notFound('Session not found'); return s.store.listQueuedMessages(id); });
  add('PATCH', '/api/sessions/:id/queue/:messageId', async (ctx) => { const id=param(ctx,'id'); const {content}=await ctx.body(z.object({content:z.string().trim().min(1).max(100_000)}).strict()); const message=s.store.updateQueuedMessage(id,param(ctx,'messageId'),content); if(!message) throw notFound('Queued message not found'); return message; });
  add('DELETE', '/api/sessions/:id/queue/:messageId', async (ctx) => { const id=param(ctx,'id'); const messageId=param(ctx,'messageId'); s.store.removeQueuedMessage(id,messageId); await s.attachments.discardQueued(messageId); return {ok:true}; });
  add('POST', '/api/sessions/:id/queue/:messageId/send-now', (ctx) => { const id=param(ctx,'id'); if(!s.store.getSession(id)) throw notFound('Session not found'); if(s.store.getSession(id)?.status==='waiting') throw conflict('Resolve the pending question or approval first.'); s.runtime.sendQueuedNow(id,param(ctx,'messageId')); return new Reply(202,{accepted:true}); });
  add('POST', '/api/sessions/:id/interrupt', (ctx) => {
    const id = param(ctx, 'id');
    if (!s.store.getSession(id)) throw notFound('Session not found');
    const group = s.groups.forSession(id);
    const member = group?.members.find((row) => row.sessionId === id && !row.removedAt);
    if (group && member) s.groups.stopMember(group.group.id, member.id);
    else s.runtime.interrupt(id);
    return { ok: true };
  });

  add('PATCH', '/api/plans/:id', async (ctx) => s.runtime.editPlan(param(ctx, 'id'), await ctx.body(EditSessionPlanSchema)));
  add('POST', '/api/plans/:id/approve', async (ctx) => {
    const { revision } = await ctx.body(z.object({ revision: z.number().int().positive() }).strict());
    return s.runtime.approvePlan(param(ctx, 'id'), revision);
  });
  add('POST', '/api/plans/:id/execute', async (ctx) => {
    await ctx.body(z.object({}).strict());
    return new Reply(202, await s.runtime.executePlan(param(ctx, 'id')));
  });
  add('POST', '/api/questions/:id/answer', async (ctx) => s.runtime.answerUserQuestion(param(ctx, 'id'), await ctx.body(UserInputAnswersSchema)));
  add('POST', '/api/questions/:id/cancel', async (ctx) => {
    await ctx.body(z.object({}).strict());
    return s.runtime.cancelUserQuestion(param(ctx, 'id'));
  });

  add('POST', '/api/tasks', async (ctx) => new Reply(201, s.tasks.create(await ctx.body(CreateTaskSchema))));
  add('PATCH', '/api/tasks/:id', async (ctx) => s.tasks.update(param(ctx, 'id'), await ctx.body(UpdateTaskSchema)));
  add('POST', '/api/tasks/:id/run', (ctx) => {
    const task = s.tasks.assertRunnable(param(ctx, 'id'));
    if (s.groups.forSession(task.sessionId!)) return new Reply(202, s.groups.runTask(task.id));
    const prompt = s.tasks.buildPrompt(task);
    s.runtime.start(task.sessionId!, prompt, { taskId: task.id, userMessage: { content: prompt, kind: 'task' } });
    return new Reply(202, { accepted: true });
  });

  add('POST', '/api/handoffs', async (ctx) => new Reply(201, await s.handoffs.create(await ctx.body(HandoffSchema))));
  add('POST', '/api/approvals/:id', async (ctx) => {
    const id = param(ctx, 'id');
    const body = await ctx.body(ApprovalDecisionSchema);
    await s.distributed.authorizeNativeApproval(id);
    await s.runtime.authorizeApprovalDecision(id);
    return s.runtime.decide(id, body.decision);
  });

  add('GET', '/api/settings', () => s.store.getSettings());
  add('PATCH', '/api/settings', async (ctx) => {
    let patch = await ctx.body(SettingsPatch);
    const before = s.store.getSettings();
    const proposed = { ...before, ...patch };
    const selectedModel = defaultModel(proposed.defaultProvider, proposed);
    const selectedModelWasPatched = defaultModel(proposed.defaultProvider, before) !== selectedModel;
    if (patch.defaultProvider !== undefined || selectedModelWasPatched || patch.defaultEffort !== undefined || patch.defaultPolicy !== undefined || patch.defaultServiceTier !== undefined) {
      const resolved = resolveRunConfig(s.providers.cached()?.find((row) => row.id === proposed.defaultProvider), {
        provider: proposed.defaultProvider, model: selectedModel, effort: proposed.defaultEffort,
        policy: proposed.defaultPolicy, serviceTier: proposed.defaultServiceTier,
      }, { effort: patch.defaultEffort !== undefined, policy: patch.defaultPolicy !== undefined, serviceTier: patch.defaultServiceTier !== undefined });
      patch = { ...patch, defaultEffort: resolved.effort, defaultPolicy: resolved.policy, defaultServiceTier: resolved.serviceTier };
    }
    if (patch.groupDefaults) {
      for (const configuration of [patch.groupDefaults.orchestrator, patch.groupDefaults.worker]) {
        if (!configuration) continue;
        const info = s.providers.cached()?.find((row) => row.id === configuration.provider);
        if (info?.models.length && !info.models.some((model) => model.id === configuration.model || model.aliases?.includes(configuration.model))) throw badRequest('Choose a model from the current provider catalog for agent defaults.');
        resolveRunConfig(info, configuration, { effort: true, policy: true, serviceTier: true });
      }
    }
    const next = s.store.tx(() => {
      const updated = s.store.updateSettings(patch);
      s.store.recordEvent({ type: 'settings.updated', summary: 'Settings updated', payload: { fields: Object.keys(patch) } });
      return updated;
    });
    if (before.antigravityExecutable !== next.antigravityExecutable) cancelAntigravityAuth(s.config.dataDir);
    if (before.claudeExecutable !== next.claudeExecutable || before.codexExecutable !== next.codexExecutable || before.antigravityExecutable !== next.antigravityExecutable || before.opencodeExecutable !== next.opencodeExecutable) s.providers.invalidate();
    return next;
  });
  add('GET', '/api/providers', () => s.providers.list());
  add('GET', '/api/providers/antigravity/auth', () => antigravityAuthState(s.config.dataDir, s.store.getSettings()));
  add('POST', '/api/providers/antigravity/auth', async (ctx) => {
    const body = await ctx.body(z.object({ refresh: z.boolean().optional() }).strict());
    if (s.setupSignal.aborted) throw new HttpError(503, 'Mingle is shutting down.');
    return startAntigravityAuth(s.config.dataDir, s.store.getSettings(), () => {
      s.providers.invalidate();
      touch();
    }, { refresh: body.refresh });
  });
  add('DELETE', '/api/providers/antigravity/auth', () => cancelAntigravityAuth(s.config.dataDir));
  add('GET', '/api/providers/antigravity/install', () => antigravityInstallState(s.config.dataDir));
  add('POST', '/api/providers/antigravity/install', async (ctx) => {
    await ctx.body(z.object({}).strict());
    if (s.setupSignal.aborted) throw new HttpError(503, 'Mingle is shutting down.');
    const previousExecutable = s.store.getSettings().antigravityExecutable;
    return startAntigravityInstall(s.config.dataDir, (executable) => {
      s.store.tx(() => {
        // A long download must not overwrite a path the user selected in the meantime.
        if (s.store.getSettings().antigravityExecutable === previousExecutable) {
          if (previousExecutable !== executable) cancelAntigravityAuth(s.config.dataDir);
          s.store.updateSettings({ antigravityExecutable: executable });
        }
        s.store.recordEvent({ type: 'provider.installed', summary: 'Antigravity runtime installed', payload: { provider: 'antigravity', version: '1.4.1' } });
      });
      s.providers.invalidate();
      touch();
    });
  });
  add('POST', '/api/providers/refresh', async () => {
    const result = await s.providers.refresh();
    touch();
    return result;
  });
  add('GET', '/api/events', (ctx) => {
    const query = parse(EventsQuery, Object.fromEntries(ctx.url.searchParams));
    return s.store.listEvents({ after: query.after, projectId: query.projectId, limit: query.limit });
  });

  return async function dispatch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<Reply> {
    const method = (req.method ?? 'GET').toUpperCase();
    let pathMatched = false;
    for (const route of routes) {
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1]!); });
      const ctx: Ctx = { req, res, url, params, body: async (schema) => parse(schema, await readBody(req)) };
      const result = await route.handler(ctx);
      return result instanceof Reply ? result : new Reply(200, result);
    }
    if (pathMatched) throw new HttpError(405, 'Method not allowed');
    throw notFound('Unknown API route');
  };
}
