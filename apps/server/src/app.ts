import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { ZodError } from 'zod';
import { type ConfigOptions, type ServerConfig, resolveConfig } from './config.ts';
import { openDatabase } from './db.ts';
import { seedExampleWorkspace } from './example.ts';
import { HandoffService } from './handoffs.ts';
import { Hub } from './hub.ts';
import { ProviderService } from './provider-service.ts';
import { buildRouter, type Services } from './routes.ts';
import { SessionRuntime, type RuntimeOptions } from './runtime.ts';
import { Security } from './security.ts';
import { serveStatic } from './static.ts';
import { Store } from './store.ts';
import { TaskService } from './tasks.ts';
import { TerminalManager, type TerminalOptions } from './terminal.ts';
import type { Logger, ProviderRuntime } from './types.ts';
import { HttpError, errorMessage } from './util.ts';
import { WorkspaceService } from './workspace.ts';
import { resolveRunConfig } from './session-config.ts';
import { ImportService } from './imports.ts';
import { DirectoryService } from './directories.ts';
import { ProjectSources } from './project-sources.ts';
import { BrowserService } from './browser/service.ts';
import { BrowserError } from './browser/errors.ts';
import { ProjectIntelligenceService } from './project-intelligence/service.ts';
import { RepositoryService } from './repository/service.ts';
import { BrowserMcpBridge } from './browser-mcp.ts';
import { GroupService } from './groups/service.ts';
import { TeamMcpBridge } from './team-mcp.ts';
import { closeAntigravityInstall } from './antigravity-install.ts';
import { closeAntigravityAuth } from './antigravity-auth.ts';
import { AttachmentService } from './attachments/service.ts';
import { handleAttachmentRequest } from './attachments/router.ts';
import { AccountService } from './account/service.ts';
import { RecoveryService } from './recovery/service.ts';
import { DistributedWorkspaceService } from './distributed/service.ts';
import { ProjectCollaborationService, type ProjectInvitationEmailSender } from './project-collaboration/service.ts';
import { RequestRemoteDelegationSchema } from '../../../packages/contracts/src/remote-execution.ts';
import { TeamChatService } from './team-chat/service.ts';
import { createTeamOrchestration, type TeamOrchestrationDeviceSideFactory } from './team-orchestration/index.ts';
import { createDeviceSide } from './team-orchestration/device/index.ts';

export interface ApplicationOptions extends ConfigOptions {
  /** Provider adapters and detection. Inject a fake in tests; the CLI entry passes ./providers/index.ts. */
  providers: ProviderRuntime;
  env?: NodeJS.ProcessEnv;
  log?: Logger;
  /** Create the labelled example workspace on first start (default true). */
  exampleWorkspace?: boolean;
  /** Probe provider executables in the background after start (default true). */
  detectOnStart?: boolean;
  runtime?: RuntimeOptions;
  terminal?: TerminalOptions;
  /** Injectable sender boundary for invitation tests; credentials remain in the cloud function. */
  projectCollaboration?: { emailSender?: ProjectInvitationEmailSender };
  /** Optional owner-side orchestration executor factory; injected while that implementation is developed independently. */
  teamOrchestrationDeviceSideFactory?: TeamOrchestrationDeviceSideFactory;
}

export interface MingleApplication {
  readonly config: ServerConfig;
  readonly store: Store;
  readonly server: Server;
  readonly runtime: SessionRuntime;
  readonly groups: GroupService;
  readonly terminals: TerminalManager;
  readonly hub: Hub;
  readonly providers: ProviderService;
  readonly browser: BrowserService;
  readonly intelligence: ProjectIntelligenceService;
  readonly repository: RepositoryService;
  readonly attachments: AttachmentService;
  readonly recovery: RecoveryService;
  readonly distributed: DistributedWorkspaceService;
  readonly projectCollaboration: ProjectCollaborationService;
  readonly teamChat: TeamChatService;
  readonly teamOrchestration: ReturnType<typeof createTeamOrchestration>;
  /** Runs recovery-independent async setup (example workspace). Called by listen(); safe to call repeatedly. */
  initialize(): Promise<void>;
  listen(): Promise<{ host: string; port: number; url: string }>;
  address(): { host: string; port: number; url: string };
  /** Aborts runs, kills PTYs, closes sockets, the HTTP server and the database. Idempotent. */
  close(): Promise<void>;
}

const defaultLogger: Logger = (level, message, detail) => {
  const line = `[mingle] ${message}${detail ? ` ${errorMessage(detail)}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/** Recovery for state left behind by a process that died or was stopped mid-run. */
export function recoverInterruptedState(store: Store, log: Logger, recovery?: RecoveryService): { sessions: number; approvals: number; tasks: number; messages: number } {
  let interruptedSessions: ReturnType<Store['sessionsInStatus']> = [];
  const result = store.tx(() => {
    const sessionsWithActiveRuns = new Set(store.activeRunSessionIds());
    store.recoverRuns();
    store.cancelPendingUserQuestions('The server restarted while the provider was waiting for input.');
    store.interruptExecutingPlans();
    const approvals = store.pendingApprovals();
    const sessionsWithPendingApprovals = new Set(approvals.map((approval) => approval.sessionId));
    for (const approval of approvals) {
      const session = store.getSession(approval.sessionId, true);
      store.resolveApproval(approval.id, 'denied', 'expired: server restarted');
      store.recordEvent({ projectId: session?.projectId ?? null, sessionId: approval.sessionId, type: 'approval.expired', summary: `Approval expired after restart: ${approval.tool}`, payload: { approvalId: approval.id, reason: 'server restarted' } });
    }
    const sessions = store.sessionsInStatus(['running', 'waiting']);
    interruptedSessions = sessions;
    for (const session of sessions) {
      if (sessionsWithActiveRuns.has(session.id) || sessionsWithPendingApprovals.has(session.id)) {
        store.updateSession(session.id, { status: 'interrupted', error: 'The server restarted while this run was active.' });
        store.insertMessage({ sessionId: session.id, role: 'system', kind: 'info', content: 'The Mingle server restarted while this run was active. The run was interrupted; partial output above (if any) was kept.' });
        store.recordEvent({ projectId: session.projectId, sessionId: session.id, type: 'session.run.interrupted', summary: `Run interrupted by restart: ${session.name}`, payload: { reason: 'server restarted' } });
      } else {
        store.updateSession(session.id, {
          status: 'interrupted',
          error: session.error ?? 'The server restarted during native context compaction; its outcome may be uncertain.',
        });
        store.insertMessage({ sessionId: session.id, role: 'system', kind: 'info', content: 'The Mingle server restarted during native context compaction or another untracked provider operation. Its outcome is uncertain; inspect the native conversation before continuing.' });
        store.recordEvent({ projectId: session.projectId, sessionId: session.id, type: 'session.compaction.interrupted', summary: `Native context compaction interrupted by restart: ${session.name}`, payload: { reason: 'server restarted', outcome: 'unknown' } });
      }
    }
    const messages = store.finalizeStreamingMessages('partial');
    const tasks = store.tasksInStatus('running');
    for (const task of tasks) {
      store.updateTask(task.id, { status: 'ready' });
      store.recordEvent({ projectId: task.projectId, sessionId: task.sessionId, type: 'task.run.stopped', summary: `Task run interrupted by restart: ${task.title}`, payload: { taskId: task.id, outcome: 'interrupted' } });
    }
    if (approvals.length || sessions.length || tasks.length) log('warn', `Recovered from an unclean stop: ${sessions.length} active sessions, ${approvals.length} approvals, ${tasks.length} tasks`);
    return { sessions: sessions.length, approvals: approvals.length, tasks: tasks.length, messages };
  });
  for (const session of interruptedSessions) {
    void recovery?.capture(session.id, 'Server restarted while this session was active').catch((error) => log('warn', `Restart recovery checkpoint failed for ${session.id}`, error));
  }
  return result;
}

/**
 * Builds the whole local runtime (database, services, HTTP + WebSocket server) without listening, so tests can pass a
 * temporary `dataDir`, a fake `providers` implementation and `port: 0`.
 */
export function createApplication(options: ApplicationOptions): MingleApplication {
  const log = options.log ?? defaultLogger;
  const config = resolveConfig(options, options.env);
  const store = new Store(openDatabase(path.join(config.dataDir, 'relay.sqlite')));
  const recovery = new RecoveryService(store);
  const account = new AccountService(config.dataDir, options.env ?? process.env, () => store.touch());
  const setupLifecycle = new AbortController();
  recoverInterruptedState(store, log, recovery);

  let boundPort = config.port;
  const security = new Security({ getPort: () => boundPort, webDevPort: config.webDevPort, extraOrigins: config.allowedOrigins });
  const hub = new Hub(security, log);
  const tasks = new TaskService(store);
  const providers = new ProviderService(options.providers, () => store.getSettings(), log, () => store.touch());
  const browser = new BrowserService({ dataDir: config.dataDir, getSettings: () => store.getSettings(), onChange: () => store.touch(), log, sessionExists: (id) => Boolean(store.getSession(id)) });
  const browserMcp = new BrowserMcpBridge(browser, store, () => boundPort, (sessionId, tabId) => hub.broadcast({ type: 'browser.opened', sessionId, tabId }), () => config.host);
  const intelligence = new ProjectIntelligenceService({ store, tasks, log });
  const runtime = new SessionRuntime(store, hub, options.providers, tasks, log, options.runtime, (session) => {
    repository.assertSessionAvailable(session);
    resolveRunConfig(providers.cached()?.find((row) => row.id === session.provider), session, { effort: true, policy: true, serviceTier: true });
  }, browserMcp, intelligence, recovery);
  const terminals = new TerminalManager(store, hub, log, options.terminal);
  const workspace = new WorkspaceService(store, config.dataDir, runtime, () => providers.cached());
  const repository = new RepositoryService({ store, workspace, runtime, log });
  const handoffs = new HandoffService(store);
  const attachments = new AttachmentService(store, config.dataDir, log);
  runtime.setAttachments(attachments);
  const groups = new GroupService({
    store, workspace, tasks, handoffs, runtime, log, attachments, providers: () => providers.cached() ?? [],
    catalog: (session, refresh) => providers.catalog(session, refresh), recovery,
  });
  const teamMcp = new TeamMcpBridge(groups, store, () => boundPort, () => config.host);
  runtime.setGroupServices(groups, teamMcp);
  groups.recover();
  const distributed = new DistributedWorkspaceService({ store, account, runtime, providers, recovery, groups, repository, dataDir: config.dataDir });
  const projectCollaboration = new ProjectCollaborationService({ store, account, distributed, workspace, providers, ...options.projectCollaboration });
  const teamChat = new TeamChatService({ store, account, distributed, collaboration: projectCollaboration });
  const teamOrchestration = createTeamOrchestration({
    store, runtime, hub, transport: distributed.transport, account, distributed, collaboration: projectCollaboration,
    groups, teamChat, teamMcp, recovery, changed: () => store.touch(),
    // Every device can contribute agents, so the owner-side executor is on by default; tests may substitute it.
    deviceSideFactory: options.teamOrchestrationDeviceSideFactory ?? (() => createDeviceSide({
      store, runtime, transport: distributed.transport, account, distributed, collaboration: projectCollaboration, teamChat, hub, changed: () => store.touch(),
    })),
  });
  runtime.setTeamProxyService(teamOrchestration.host);
  groups.setTeamDispatchGuard((sessionId, groupId) => teamOrchestration.host.guardGroupDispatch(sessionId, groupId));
  groups.setTeamRunFinishedHook((input) => teamOrchestration.host.onGroupRunFinished(input));
  teamChat.setOrchestration(teamOrchestration.host);
  teamMcp.setDistributedTools({
    recoveryShape: RequestRemoteDelegationSchema.shape,
    members: async (context, sessionId) => {
      const session = store.getSession(sessionId);
      if (!session || groups.forSession(sessionId)?.group.id !== context.groupId) throw new HttpError(403, 'Remote agents are scoped to the current group.');
      const snapshot = await distributed.execution.snapshot();
      const bindings = snapshot.bindings.filter((binding) => binding.localProjectId === session.projectId);
      return { localFirst: true, agents: snapshot.agents.filter((agent) => bindings.some((binding) => binding.teamId === agent.teamId && binding.sharedProjectId === agent.sharedProjectId)) };
    },
    recover: async (context, sessionId, input) => {
      const roster = groups.members(context) as { canAssign?: boolean };
      if (roster.canAssign !== true) throw new HttpError(403, 'Only the current group planner may propose remote recovery.');
      const parsed = RequestRemoteDelegationSchema.parse(input);
      if (parsed.mode !== 'provider-failure') throw new HttpError(403, 'Recovery of unpublished work requires an explicit human request.');
      const source = store.getSession(parsed.sourceSessionId);
      const caller = store.getSession(sessionId);
      if (!source || !caller || source.projectId !== caller.projectId || groups.forSession(source.id)?.group.id !== context.groupId) throw new HttpError(403, 'The failed source must belong to this group and project.');
      const snapshot = await distributed.execution.snapshot(parsed.teamId);
      if (!snapshot.bindings.some((binding) => binding.sharedProjectId === parsed.sharedProjectId && binding.localProjectId === source.projectId)) throw new HttpError(403, 'The shared project is not bound to this group project.');
      const suggestion = await distributed.execution.suggestFallback({ teamId: parsed.teamId, sharedProjectId: parsed.sharedProjectId, sourceSessionId: parsed.sourceSessionId, taskId: parsed.taskId });
      if (!suggestion.eligible || !suggestion.candidates.some((agent) => agent.id === parsed.agentId)) throw new HttpError(409, 'Automatic recovery proposals require a currently eligible agent with known available quota.');
      if ((groups.members(context) as { canAssign?: boolean }).canAssign !== true) throw new HttpError(403, 'The group planning authority changed while recovery was being checked.');
      return distributed.execution.requestDelegation({ ...parsed, allowUnverifiedTarget: false });
    },
  });
  const services: Services = {
    config, store, hub, runtime, tasks, terminals, providers, browser, intelligence, repository, groups, handoffs, workspace, attachments, account, recovery, distributed, projectCollaboration, teamChat, teamOrchestration, setupSignal: setupLifecycle.signal,
    imports: new ImportService(store, options.providers, providers, runtime), directories: new DirectoryService(), projectSources: new ProjectSources(workspace), startedAt: Date.now(), getPort: () => boundPort,
  };
  hub.bind({ onMessage: (socket, raw) => terminals.handleMessage(socket, raw), onClose: (socket) => terminals.releaseSocket(socket) });

  // Coalesce delta-free state notifications; events are forwarded immediately and carry their record.
  let pendingNotify: NodeJS.Timeout | null = null;
  store.subscribe((event) => {
    if (event) return hub.notify(event);
    if (pendingNotify) return;
    pendingNotify = setTimeout(() => { pendingNotify = null; hub.notify(); }, 60);
  });

  const dispatch = buildRouter(services);

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(payload));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(res.req?.method === 'HEAD' ? undefined : payload);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (closing) return send(res, 503, { error: 'Mingle is shutting down.' });
      const verdict = security.checkHttp(req);
      if (!verdict.ok) return send(res, 403, { error: verdict.reason ?? 'Forbidden' });
      const url = new URL(req.url ?? '/', 'http://mingle.local');
      if (url.pathname === '/api/team/mcp') return await teamMcp.handle(req, res);
      if (url.pathname === '/api/browser/mcp') return await browserMcp.handle(req, res);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        if (await handleAttachmentRequest(attachments, req, res, url)) return;
        const reply = await dispatch(req, res, url);
        return send(res, reply.status, reply.body);
      }
      if (url.pathname === '/ws' || url.pathname === '/ws/browser') return send(res, 426, { error: 'WebSocket upgrade required' });
      if (config.webDistDir && (await serveStatic(config.webDistDir, req, res, config.csp))) return;
      if (res.headersSent) return;
      send(res, 404, { error: config.webDistDir ? 'Not found' : 'The web app is not built. Run `pnpm build` or use the Vite dev server on port 5173.' });
    } catch (error) {
      if (res.headersSent) return void res.destroy();
      if (error instanceof BrowserError) return send(res, error.status, { error: error.message });
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      if (error instanceof ZodError) return send(res, 400, { error: error.issues[0]?.message ?? 'Invalid request' });
      if (error instanceof URIError) return send(res, 400, { error: 'Malformed URL' });
      log('error', `Unhandled error for ${req.method} ${req.url?.split('?')[0]}`, error);
      send(res, 500, { error: 'Internal server error' });
    }
  };

  const server = createServer((req, res) => { void handle(req, res); });
  server.on('upgrade', (req, socket, head) => {
    let pathname: string;
    try { pathname = new URL(req.url ?? '/', 'http://mingle.local').pathname; } catch { socket.destroy(); return; }
    if (pathname === '/ws/browser') browser.handleUpgrade(req, socket, head, security);
    else hub.handleUpgrade(req, socket, head);
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  hub.start();

  let initialized: Promise<void> | null = null;
  let closing: Promise<void> | null = null;

  const address = () => ({ host: config.host, port: boundPort, url: `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${boundPort}` });

  const app: MingleApplication = {
    config, store, server, runtime, groups, terminals, hub, providers, browser, intelligence, repository, attachments, recovery, distributed, projectCollaboration, teamChat, teamOrchestration,
    initialize() {
      initialized ??= (async () => {
        if (options.exampleWorkspace !== false) await seedExampleWorkspace(store, config.dataDir, log);
        intelligence.start();
        attachments.start();
        distributed.start();
      })();
      return initialized;
    },
    async listen() {
      await app.initialize();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      boundPort = (server.address() as AddressInfo).port;
      store.recordEvent({ type: 'runtime.started', summary: `Mingle server started on ${address().url}`, payload: { version: config.version, port: boundPort } });
      if (options.detectOnStart !== false) providers.warm();
      return address();
    },
    address,
    close() {
      closing ??= (async () => {
        setupLifecycle.abort();
        await teamOrchestration.close();
        await teamChat.close();
        await projectCollaboration.close();
        await distributed.close();
        await account.close();
        if (pendingNotify) clearTimeout(pendingNotify);
        await Promise.all([closeAntigravityInstall(config.dataDir), closeAntigravityAuth(config.dataDir)]);
        groups.close();
        await runtime.shutdown();
        await recovery.drain();
        await attachments.close();
        await options.providers.close?.().catch((error) => log('warn', 'Provider helper cleanup failed', error));
        teamMcp.close();
        await intelligence.close();
        await repository.close();
        browserMcp.close();
        await browser.close();
        terminals.killAll();
        await hub.close();
        await new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
          server.closeIdleConnections();
          setTimeout(() => { server.closeAllConnections(); }, 500).unref();
        });
        try { store.close(); } catch (error) { log('warn', 'Database close failed', error); }
      })();
      return closing;
    },
  };
  return app;
}

/** Alias kept for tests and embedders that think in terms of "build a server". */
export const buildServer = createApplication;
